// Codex 审计 3655d60（28 项）修复回归：锁 D01/D02/D03/D12/D13/D15/D16/D17/D18/D19/D20/D22/D23/D25。
// 全部离线（假 transport/假 fetch stub），零网络零凭据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector, } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor, validateToolArgs } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { ArchiveSyncService } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';
import { buildRecordSnapshot } from '../../apps/host/src/server/records.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + DONE;
const toolBody = (id: string, callId: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'memory_hold', arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter(Boolean).map((s) => enc.encode(`${s}\n\n`)));
const HOLD_ARGS = { original_title: '审计回归', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' };

function baseCtx(root: string) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  return { config, paths, db };
}

type HoldCall = { payload: Record<string, unknown>; result: Record<string, unknown> };
function recordingMariposa(calls: HoldCall[], resultOverride?: () => Record<string, unknown>): MariposaTransport {
  return async (capability, payload) => {
    if (capability === 'memory.hold') {
      calls.push({ payload: payload as Record<string, unknown>, result: {} });
      // F-J-54 对齐（联合审计 2026-10-06）：默认回执按真实服务端语义生成——每条 source_selection 恰好一个绑定
      const selCount = Array.isArray(payload.source_selections) ? (payload.source_selections as unknown[]).length : 0;
      const r = resultOverride ? resultOverride() : { operation_id: payload.operation_id, memory_id: 'mem-1', version: 1, binding_ids: Array.from({ length: selCount }, (_, i) => `msb-${i}`), committed_at: new Date().toISOString() };
      if (r.__reject) return { ok: false, code: String(r.code), httpStatus: Number(r.httpStatus) };
      return { ok: true, result: r };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
}

/** 给 (消息,修订) 种正式来源收据（模拟归档已 ACK） */
function seedReceipt(db: ReturnType<typeof openDatabase>, messageId: string, revision: number, content: string): void {
  db.prepare(
    `INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at)
     VALUES (?, 'op-seed', ?, ?, 'src-c', ?, ?, ?, ?)`,
  ).run(`ssr-${messageId}-${revision}`, messageId, revision, `sm-${messageId.slice(-4)}`, sha256Hex(content), new Date().toISOString(), new Date().toISOString());
}

// —— 纯单元：D19 标题按码点计 ——
test('D19：16 个 emoji（16 码点/32 UTF-16 单位）的标题合法通过参数门', () => {
  const okRun = validateToolArgs('memory_hold', { ...HOLD_ARGS, original_title: '😀'.repeat(16) });
  assert.ok(okRun.ok, `16 emoji 标题应通过（得到 ${okRun.ok ? '' : okRun.code}）`);
  const bad = validateToolArgs('memory_hold', { ...HOLD_ARGS, original_title: '😀'.repeat(31) });
  assert.ok(!bad.ok && bad.code === 'TOOL_ARG_LENGTH', '31 码点仍拒');
});

// —— 执行器级：D15/D17/D13/D16 ——
async function execHold(ctx: { db: ReturnType<typeof openDatabase> }, calls: HoldCall[], args: Record<string, unknown>, seen: Array<{ id: string; revision: number }>, resultOverride?: () => Record<string, unknown>) {
  const reviews = new RotationReviewService(ctx.db);
  const tools = new HostToolExecutor({ db: ctx.db, mariposa: new MariposaClient({ transport: recordingMariposa(calls, resultOverride) }), reviews, checkpoint: new HoldCheckpointService(ctx.db) })
  wireOidoCapabilitiesForTest(tools, {});;
  return { out: await tools.execute('memory_hold', { ...args, __tool_call_id: 'call-1' }, { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: seen, requestId: 'req-1' }), effects: reviews };
}

test('D15：只给 mood_tags 时 mood 不带 text 字段（服务端 text 只收 string）', async () => {
  const root = tempRoot('d15-');
  const ctx = baseCtx(root);
  ctx.db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(new Date().toISOString());
  const calls: HoldCall[] = [];
  // 审计 1005B：带心情必须显式 creation_mode（mariposa 宁拒不猜，宿主前置拦截同语义）
  const { out } = await execHold(ctx, calls, { ...HOLD_ARGS, mood_tags: ['开心'], creation_mode: 'contemporaneous' }, []);
  assert.equal(out.ok, true);
  const mood = (calls[0]!.payload.mood as Record<string, unknown>) ?? {};
  assert.deepEqual(mood.tags, ['开心']);
  assert.equal('text' in mood, false, '没有 note 就不发 text（null 会被服务端拒）');
  ctx.db.close();
});

test('审计 1005B-D/F-J-22：hold 缺 creation_mode（无论是否带心情）→ 宿主参数门即拒（宁拒不猜）', async () => {
  const root = tempRoot('d15b-');
  const ctx = baseCtx(root);
  ctx.db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(new Date().toISOString());
  const calls: HoldCall[] = [];
  // F-J-22（2026-10-06 她/林批准）：creation_mode 公开面显式必填——缺省在
  // 参数门即 TOOL_ARG_REQUIRED（旧 HOLD_MOOD_WINDOW_REQUIRED 拦截场景已被
  // 更强的必填门覆盖；retrospective+mood 的窗口拦截回归在 joint-audit-b2）
  const gate = validateToolArgs('memory_hold', { original_title: 't', categories: ['daily'], text: 'x', mood_tags: ['开心'] });
  assert.ok(!gate.ok && gate.code === 'TOOL_ARG_REQUIRED', '缺 creation_mode 拒收（含心情场景同样先撞必填门）');
  const { out } = await execHold(ctx, calls, { ...HOLD_ARGS, mood_tags: ['开心'] }, []);
  assert.equal(out.ok, true, '显式 contemporaneous+心情合法');
  assert.equal(calls.length, 1);
  const eff = ctx.db.prepare("SELECT state FROM tool_side_effects WHERE kind='hold'").get() as { state: string } | undefined;
  assert.equal(eff?.state, 'committed', '显式声明后正常提交');
  ctx.db.close();
});

test('D17：弱回执（负 version/缺 committed_at）→ RECEIPT_SHAPE_INVALID，不签已核实', async () => {
  const root = tempRoot('d17-');
  const ctx = baseCtx(root);
  ctx.db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(new Date().toISOString());
  for (const bad of [
    () => ({ __reject: true, code: 'RECEIPT_SHAPE_INVALID', httpStatus: 200 }), // 形状判定在 client 层，此路径模拟穿透形状
  ]) void bad;
  // 直接构造弱回执（client 校验在 parseHoldReceiptShape——经 MariposaClient 默认 transport 之外不可达，此处经 hold 路径断言最终效应）
  const calls: HoldCall[] = [];
  const checkpoint = new HoldCheckpointService(ctx.db);
  const { out } = await execHold(ctx, calls, HOLD_ARGS, [], () => ({ __reject: true, code: 'RECEIPT_SHAPE_INVALID', httpStatus: 200 }));
  assert.equal(out.ok, false, '弱回执不认成功');
  assert.equal((out.output as { error_code: string }).error_code, 'HOLD_OUTCOME_UNKNOWN', '形状无效=结果不明（F10 语义）：不给弱回执签已核实');
  const eff = ctx.db.prepare("SELECT state, verified FROM tool_side_effects WHERE kind='hold'").get() as { state: string; verified: number };
  assert.equal(eff.state, 'unknown', '账本不落 committed/verified');
  assert.equal(checkpoint.forWindow('w1'), null, '书签零推进——D17 的核心安全属性');
  ctx.db.close();
});

test('D17 形状单测：负 version / 缺 committed_at / 空 memory_id 都判形状无效（经真 client 通道）', async () => {
  const realFetch = globalThis.fetch;
  for (const receipt of [
    { operation_id: 'op', memory_id: 'm', version: -1, binding_ids: [], committed_at: new Date().toISOString() },
    { operation_id: 'op', memory_id: 'm', version: 1, binding_ids: [] },
    { operation_id: 'op', memory_id: '', version: 1, binding_ids: [], committed_at: new Date().toISOString() },
  ]) {
    (globalThis as { fetch: unknown }).fetch = async () => new Response(JSON.stringify({ ok: true, data: receipt }), { status: 200 });
    const client = new MariposaClient({ baseUrl: 'https://unit.test', credentialEnv: 'NONE_SUCH' });
    const r = await client.memoryHold({ operationId: 'op', holdPayload: {} });
    assert.equal(r.ok, false, `弱回执必须被拒：${JSON.stringify(receipt)}`);
    assert.equal((r as { code: string }).code, 'RECEIPT_SHAPE_INVALID');
  }
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

test('D22：带结构化错误码的 HTTP 500 → 传输层按 HTTP_500 分类（上层归 unknown）', async () => {
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR' } }), { status: 500 });
  const client = new MariposaClient({ baseUrl: 'https://unit.test', credentialEnv: 'NONE_SUCH' });
  const r = await client.memoryHold({ operationId: 'op', holdPayload: {} });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'HTTP_500', '5xx 不看响应体结构化码——按传输层状态归"结果不明"');
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

test('D13/D16：按所见修订核对 + 同消息多片段 + 倒序指认合法', async () => {
  const root = tempRoot('d13-');
  const ctx = baseCtx(root);
  const msgs = new MessageService(ctx.db);
  msgs.ensureConversation('c1');
  const m1 = msgs.submitUserMessageWithTurn({ conversationId: 'c1', content: '前半句在这里。后半句也在这里。', clientMessageId: 'a', occurredAt: new Date().toISOString() });
  const m2 = msgs.submitUserMessageWithTurn({ conversationId: 'c1', content: '另一条完全不同的话', clientMessageId: 'b', occurredAt: new Date().toISOString() });
  // m1 编辑出新修订（模型只见 rev1）——编辑后当前修订是 rev2
  msgs.editUserMessage(m1.message.id, '前半句和后半句都被改写了。');
  seedReceipt(ctx.db, m1.message.id, 1, '前半句在这里。后半句也在这里。');
  seedReceipt(ctx.db, m2.message.id, 1, '另一条完全不同的话');
  const calls: HoldCall[] = [];
  // 视野=两条 rev1；倒序勾选 + 同消息两句
  const { out } = await execHold(ctx, calls, { ...HOLD_ARGS, quotes: [{ seq: 2 }, { seq: 1, from: 2, to: 2 }, { seq: 1, from: 1, to: 1 }] }, [
    { id: m1.message.id, revision: 1 },
    { id: m2.message.id, revision: 1 },
  ]);
  assert.equal(out.ok, true, `勾选应全部命中（得到 ${JSON.stringify(out.output)}）`);
  const ourWords = (calls[0]!.payload.our_words as Array<{ speaker: string; text: string }>) ?? [];
  assert.equal(ourWords.length, 3, '同消息两个不重叠句段 + 另一消息一条');
  assert.equal(ourWords.map((w) => w.text).join('|'), '另一条完全不同的话|后半句也在这里。|前半句在这里。', '按勾选序各自定位');
  // D13：抄录内容=所见修订（rev1）——未见过的 rev2 新内容天然不可达
  const calls3: HoldCall[] = [];
  const { out: out3 } = await execHold(ctx, calls3, { ...HOLD_ARGS, quotes: [{ seq: 1 }] }, [{ id: m1.message.id, revision: 1 }]);
  assert.equal(out3.ok, true);
  assert.equal((calls3[0]!.payload.our_words as Array<{ text: string }>)[0]!.text, '前半句在这里。后半句也在这里。', '按所见修订抄录（不是当前 rev2）');
  // 勾选没见过的序号=如实拒绝（零副作用）
  const calls2: HoldCall[] = [];
  const { out: out2 } = await execHold(ctx, calls2, { ...HOLD_ARGS, quotes: [{ seq: 99 }] }, [{ id: m1.message.id, revision: 1 }]);
  assert.equal((out2.output as { error_code: string }).error_code, 'QUOTE_REF_SEQ_NOT_SEEN', '未见过序号拒绝（D13 可见性门）');
  assert.equal(calls2.length, 0, '零副作用');
  void m2;
  ctx.db.close();
});

// —— supervisor 级：D01 thinking 续传 / D02 手动换窗指纹门 / D03 恢复 ——
function composeSup(root: string, transport: OrTransport, configOver: Record<string, unknown> = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, ...configOver });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const mariposa: MariposaTransport = async (cap, payload) => ({ ok: true, result: { operation_id: payload.operation_id, memory_id: 'mem-x', version: 1, binding_ids: [], committed_at: new Date().toISOString() } });
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews, checkpoint })
  wireOidoCapabilitiesForTest(tools, {});;
  const trajectory = new WindowTrajectoryService(db);
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, trajectory };
}

test('D01更新：带tools的DS保留opaque协议继续态，下一用户回合不改已发送历史', async () => {
  const root = tempRoot('d01-');
  const seenPayloads: Array<Record<string, unknown>> = [];
  let gen = 0;
  const transport: OrTransport = async (payload) => {
    seenPayloads.push(JSON.parse(JSON.stringify(payload)));
    const hasToolResult = (payload.messages as Array<{ role: string }>).some((m) => m.role === 'tool');
    gen++;
    const body = hasToolResult
      ? textBody(`g${gen}`, '记好了')
      : sse({ id: `g${gen}`, choices: [{ delta: { reasoning_content: '思考片段甲' } }] }) + sse({ choices: [{ delta: { reasoning_content: '乙' } }] }) + sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'memory_hold', arguments: JSON.stringify(HOLD_ARGS) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
    return { status: 200, headers: new Map<string, string>(), body: frameStream(body) };
  };
  const ctx = composeSup(root, transport);
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '记一件事', clientMessageId: 'r1', occurredAt: new Date().toISOString() });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed');
  assert.ok(seenPayloads.length >= 2, '工具往返=至少两笔请求');
  const cont = seenPayloads[1]!.messages as Array<Record<string, unknown>>;
  const asst = cont.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.ok(asst, '续请求携带 assistant 工具调用消息');
  assert.equal(asst!.reasoning_content, '思考片段甲乙', '同轮续传原样回传 reasoning_content（官方协议继续态）');
  const win = ctx.windows.activeWindow('c1')!;
  const traj = ctx.trajectory.forWindow(win.id)!;
  const trajJson = JSON.stringify(traj.messages);
  assert.equal(trajJson.includes('reasoning_content'), true, '2026-10-23已核DS带tools合同要求保留opaque继续态');
  const next = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '继续聊天', clientMessageId: 'r2', occurredAt: new Date().toISOString() });
  ctx.supervisor.enqueue(next.turnId); await ctx.supervisor.waitIdle();
  const replay = (seenPayloads.at(-1)!.messages as Array<Record<string, unknown>>).find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.equal(replay?.reasoning_content, '思考片段甲乙');
  assert.deepEqual(ctx.trajectory.forWindow(win.id)!.messages.slice(0,traj.messages.length),traj.messages,'旧协议前缀逐字段不变');
  ctx.db.close();
});

test('D02：身份变化后手动换窗——旧窗 CONTEXT_STALE、失效轨迹不外发评审、按新材料建新窗', async () => {
  const sent: string[] = [];
  let gen = 0;
  const transport: OrTransport = async (payload) => {
    const msgs = payload.messages as Array<{ role: string; content: unknown }>;
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    sent.push(text.slice(0, 24));
    gen++;
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`g${gen}`, '好')) };
  };
  const root = tempRoot('d02-');
  const ctx = composeSup(root, transport);
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '旧身份下聊过一句', clientMessageId: 'p1', occurredAt: new Date().toISOString() });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  const win1 = ctx.windows.activeWindow('c1')!;
  // 模拟批准运行规则材料升级：改规则内容 + manifest hash（指纹参与项变化；不动 expected_* 钉住的版本号）。
  // 2026-10-17 她落位裁定后：正文槽=长期记忆里程碑（char自维护），已不参与指纹
  //（里程碑演进不触发换窗）；身份失效路径改由规则槽触发——规则/模型/驱动仍强制受控换窗。
  const fs = await import('node:fs');
  const paths2 = buildPaths(root);
  const idFile = path.join(paths2.identityDir, 'runtime-rules.md');
  fs.writeFileSync(idFile, '（测试）升级后的运行规则——内容变了');
  const mf = path.join(paths2.configDir, 'identity-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  manifest.rules_hash = sha256Hex(fs.readFileSync(idFile, 'utf8'));
  fs.writeFileSync(mf, JSON.stringify(manifest));
  const sentBefore = sent.length;
  const r = await ctx.supervisor.manualRotate('c1');
  assert.ok(r.ok, `换窗应成功（${r.ok ? '' : r.reason}）`);
  const winAfter = ctx.windows.get(win1.id)!;
  assert.equal(winAfter.status, 'CLOSED', '旧窗经 CAS 轮转关闭');
  assert.equal(winAfter.blocked_reason, 'ROTATED_CONTEXT_STALE', '关闭原因如实标注（身份已失效）');
  const win2 = ctx.windows.activeWindow('c1')!;
  assert.notEqual(win2.id, win1.id, '新窗已按新材料建立');
  assert.equal(sent.length, sentBefore, '失效身份/旧轨迹零外发（未做任何评审请求——§4.4 安全优先于提醒）');
  ctx.db.close();
});

test('D03：重启恢复收口 active 评审与 running 写操作，房间不再永久阻断', async () => {
  const root = tempRoot('d03-');
  const ctx = baseCtx(root);
  // 直接持久化等价崩溃夹具：active 评审 + running hold effect + running turn
  const now = new Date().toISOString();
  ctx.db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(now);
  ctx.db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES ('w1','c1','ACTIVE',?,?)").run(now, now);
  ctx.db.prepare("INSERT INTO rotation_reviews(id, window_id, room_id, epoch_revision, range_keys_json, status, created_at, updated_at) VALUES ('rev1','w1','c1',1,'[]','active',?,?)").run(now, now);
  ctx.db.prepare("INSERT INTO tool_side_effects(id, review_id, turn_id, window_id, kind, state, verified, operation_id, tool_call_id, created_at, updated_at) VALUES ('e1','rev1','t1','w1','hold','running',0,'es-hold-x','tc1',?,?)").run(now, now);
  ctx.db.prepare("INSERT INTO tool_side_effects(id, review_id, turn_id, window_id, kind, state, verified, operation_id, tool_call_id, created_at, updated_at) VALUES ('e2','rev1','t1','w1','review_complete','running',0,NULL,'tc2',?,?)").run(now, now);
  const logger = { warn: () => {} };
  const res = TurnSupervisor.recoveryPass(ctx.db, logger as never);
  assert.equal(res.staleReviews, 1, 'active 评审 → failed（无执行者，不伪造完成）');
  const rev = ctx.db.prepare('SELECT status FROM rotation_reviews WHERE id = ?').get('rev1') as { status: string };
  assert.equal(rev.status, 'failed');
  const hold = ctx.db.prepare('SELECT state FROM tool_side_effects WHERE id = ?').get('e1') as { state: string };
  assert.equal(hold.state, 'unknown', '崩溃中 hold=结果不明（可按 op 恢复探测）');
  const local = ctx.db.prepare('SELECT state FROM tool_side_effects WHERE id = ?').get('e2') as { state: string };
  assert.equal(local.state, 'failed_resolved', '本地类副作用可判未提交');
  ctx.db.close();
});

// —— 归档级：D12/D20/D18 ——
function composeArchive(root: string, transport: MariposaTransport, configOver: Record<string, unknown> = {}) {
  const ctx = baseCtx(root);
  const config = buildConfig({ ...ctx.config, archive: { enabled: true }, integrations: { mariposa: { base_url: 'https://unit.test', credential_ref: null, archive_credential_ref: null, contract_version: null } }, ...configOver } as never);
  const events = new EventService(ctx.db);
  const logger = new Logger(path.join(root, 'logs'));
  const messages = new MessageService(ctx.db);
  const client = new MariposaClient({ transport });
  const sync = new ArchiveSyncService({ db: ctx.db, events, logger, client, config });
  return { ...ctx, messages, sync };
}

test('D12：普通文本归档 published_kind 映射 chat_message（现行 mariposa 契约）', async () => {
  const root = tempRoot('d12-');
  const seen: Array<Record<string, unknown>> = [];
  const ctx = composeArchive(root, async (cap, payload) => {
    if (cap === 'source.ingest') {
      seen.push(payload as Record<string, unknown>);
      const ms = (payload.messages as Array<Record<string, unknown>>).map((m) => ({ origin_message_id: m.origin_message_id, revision: m.revision, source_conversation_id: 'sc', source_message_id: `sm-${m.origin_message_id}`, content_hash: m.content_hash }));
      return { ok: true, result: { operation_id: payload.operation_id, committed_at: new Date().toISOString(), messages: ms, batch_ref: 'b', integrity: 'verified' } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  });
  ctx.messages.ensureConversation('c1');
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '普通文本消息', clientMessageId: 'k1', occurredAt: new Date().toISOString() });
  await ctx.sync.drainOnce();
  assert.equal(seen.length, 1, '批次发出');
  const kinds = (seen[0]!.messages as Array<Record<string, unknown>>).map((m) => m.published_kind);
  assert.ok(kinds.every((k) => k === 'chat_message'), `published_kind 全部映射 chat_message（得到 ${kinds.join(',')}）`);
  ctx.db.close();
});

test('D20：前驱当前修订未同步时回退到已同步修订（不闭锁）', async () => {
  const root = tempRoot('d20-');
  const seen: Array<Record<string, unknown>> = [];
  const ctx = composeArchive(root, async (cap, payload) => {
    if (cap === 'source.ingest') {
      seen.push(payload as Record<string, unknown>);
      const ms = (payload.messages as Array<Record<string, unknown>>).map((m) => ({ origin_message_id: m.origin_message_id, revision: m.revision, source_conversation_id: 'sc', source_message_id: `sm-${m.origin_message_id}`, content_hash: m.content_hash }));
      return { ok: true, result: { operation_id: payload.operation_id, committed_at: new Date().toISOString(), messages: ms, batch_ref: 'b', integrity: 'verified' } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  });
  ctx.messages.ensureConversation('c1');
  const m1 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一句', clientMessageId: 'q1', occurredAt: new Date().toISOString() });
  await ctx.sync.drainOnce(); // rev1 已同步（有收据）
  ctx.messages.editUserMessage(m1.message.id, '第一句（编辑后）'); // rev2 未同步
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第二句', clientMessageId: 'q2', occurredAt: new Date().toISOString() });
  // 构造 D20 触发形态：m1 的 rev2 滞留在后续批次（>50 积压时的等价夹具）——本批只有 m2
  ctx.db.prepare("DELETE FROM outbox WHERE operation_key = ?").run(`archive:${m1.message.id}:2`);
  await ctx.sync.drainOnce();
  const batch = seen[1]!;
  const msg2 = (batch.messages as Array<Record<string, unknown>>).find((m) => m.text === '第二句')!;
  const pred = msg2.predecessor as { revision: number };
  assert.equal(pred.revision, 1, '前驱引用已同步的 rev1（rev2 未入库前不闭锁——D20）');
  ctx.db.close();
});

test('D18：持续坏 ACK（op 匹配但空 messages）消耗同一预算，超限 dead 不再无限 in_flight', async () => {
  const root = tempRoot('d18-');
  const ctx = composeArchive(root, async (cap, payload) => {
    if (cap === 'source.ingest') return { ok: true, result: { operation_id: payload.operation_id, committed_at: null, messages: [] } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  });
  ctx.messages.ensureConversation('c1');
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '会卡住的消息', clientMessageId: 'q1', occurredAt: new Date().toISOString() });
  for (let i = 0; i < 12; i++) await ctx.sync.drainOnce();
  const row = ctx.db.prepare('SELECT state, last_error FROM outbox WHERE target = ?').get('mariposa.archive') as { state: string; last_error: string | null };
  assert.equal(row.state, 'failed', `12 次坏 ACK 后必须落终态（得到 ${row.state}）`);
  assert.ok((row.last_error ?? '').includes('TRANSIENT_EXHAUSTED'), `超限原因留痕（得到 ${row.last_error}）`);
  const batch = ctx.db.prepare('SELECT state FROM ingest_batches').get() as { state: string };
  assert.equal(batch.state, 'dead', '批次同步标 dead（可人工恢复，不无限重发）');
  ctx.db.close();
});

// —— 表面/计量：D23/D25 ——
test('D23：记录快照无 effectiveWarning（WP-03 退役），软线按实际容量收缩', () => {
  const root = tempRoot('d23-');
  const ctx = baseCtx(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, windows: { model_context_capacity: 40000 } });
  const events = new EventService(ctx.db);
  const messages = new MessageService(ctx.db);
  const identity = new IdentityService(config, buildPaths(root));
  const windows = new WindowManager(ctx.db, events, identity, buildPaths(root).handoffsDir, config);
  const runner = { status: 'ok' as const, runner: new DeepSeekRunner({ retryMax: 0 }, async () => ({ status: 200, headers: new Map(), body: frameStream(textBody('g', 'x')) })) };
  const snap = buildRecordSnapshot({ db: ctx.db, config, windows, runnerSelection: runner }, 'c1', null);
  // 容量 40000 → safeInput=11808 → effectiveSoft=11808（软线收缩正断言保留）
  assert.equal(snap.context.effectiveSoft, 11808, '软线按实际容量收缩');
  // WP-03（2026-10-09，JFA-001/E-3）：warning_tokens 与 effectiveWarning 已退役
  // ——快照不再携带该键（API 契约同步收窄，网页已不读）
  assert.equal('effectiveWarning' in snap.context, false, 'effectiveWarning 已切除（df66e7c 残尾清偿）');
  ctx.db.close();
});

test('D25：某 attempt 完全缺 usage → 费用总额同样 unknown（不拿已知小计冒充完整总额）', () => {
  const root = tempRoot('d25-');
  const ctx = baseCtx(ctx_root_join(root));
  const usage = new UsageCollector(ctx.db);
  const now = new Date().toISOString();
  ctx.db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(now);
  ctx.db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES ('t1','c1','user_message','completed',?)").run(now);
  ctx.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, state, completed_at) VALUES ('a1','t1',1,'completed',?)").run(now);
  ctx.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, state, completed_at) VALUES ('a2','t1',2,'failed',?)").run(now);
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'request', usage: { input_tokens: 10, output_tokens: 1, cost_usd: 0.02 }, model: 'm', requestId: 'r1', source: 'ds_stream', completeness: 'complete' });
  const s = usage.summaryForTurn('t1');
  assert.equal(s.totals.cost_usd, null, '任一 attempt 费用未知 → 总额 null（D25 修复前是 0.02）');
  assert.equal(s.totals.unknown_present, true);
  ctx.db.close();
});

function ctx_root_join(root: string): string { return root; }
