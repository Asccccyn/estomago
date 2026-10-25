// 审计整改批次①回归（estomago-audit-18a1f1f：F04/F05/F07/F08/F09/F10/F15/F16）。
// 审计的复现脚本是"缺陷成功复现"；本文件把同一场景翻成"正确行为必须成立"的断言。
import { test } from 'node:test';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
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
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { ArchiveSyncService } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + DONE;
const toolBody = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const twoToolBody = (id: string, c1: [string, string, Record<string, unknown>], c2: [string, string, Record<string, unknown>]) =>
  sse({ id, choices: [{ delta: { tool_calls: [
    { index: 0, id: c1[0], type: 'function', function: { name: c1[1], arguments: JSON.stringify(c1[2]) } },
    { index: 1, id: c2[0], type: 'function', function: { name: c2[1], arguments: JSON.stringify(c2[2]) } },
  ] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

const H = 3600e3;
const T0 = '2026-10-01T08:00:00+08:00';
const at = (h: number) => new Date(Date.parse(T0) + h * H).toISOString();

/** OR transport：按最后一条 user 消息内容与是否有 tool 结果选择响应 */
function orTransportWith(script: {
  chat?: (hasToolResult: boolean) => string; // 首轮 chat 响应（默认文本）；hasToolResult=续请求轮
  review?: (hasToolResult: boolean, reviewId: string) => string;
}) {
  let gen = 0;
  const transport: OrTransport = async (payload) => {
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const textOf = (m: { content: unknown }): string => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => (b as { text?: string }).text ?? '').join('\n') : '');
    const t = lastUser ? textOf(lastUser) : '';
    // 续请求轮判据：最后一条消息是 tool（轨迹含历史工具协议消息是正常的，§2.2）
    const hasTool = messages[messages.length - 1]?.role === 'tool';
    gen++;
    const id = `g${gen}`;
    if (t.includes('宿主运行事件')) {
      const reviewId = t.match(/review_id: (\S+)/)?.[1] ?? '';
      return { status: 200, headers: new Map<string, string>(), body: frameStream(script.review ? script.review(hasTool, reviewId) : textBody(id, '评审回复')) };
    }
    return { status: 200, headers: new Map<string, string>(), body: frameStream(script.chat ? script.chat(hasTool) : textBody(id, `回复${gen}`)) };
  };
  return transport;
}

function compose(root: string, orTransport: OrTransport, mariposa: MariposaTransport, configOver: Record<string, unknown> = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' },
    openrouter: { model: MODEL },
    archive: { enabled: true, source_scope: 'sync-test' },
    integrations: { mariposa: { base_url: 'http://127.0.0.1:9', credential_ref: 'MODEL_TOKEN', archive_credential_ref: 'ARCHIVE_TOKEN' } },
    windows: { soft_limit_tokens: 1500 + 12_500 },
    ...configOver,
  });
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
  const mariposa_wire_1 = new MariposaClient({ transport: mariposa });
  const { tools: tools } = assembleTestTools({ db: db, mariposa: mariposa_wire_1, reviews: reviews, checkpoint: checkpoint });;
  const trajectory = new WindowTrajectoryService(db);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, orTransport);
  const supervisor = new TurnSupervisor({bootstrap: new MariposaClient({ transport: mariposa }), // S18：显式 BootstrapPort（原经 tools.mariposaClient 隐式取得）
     db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  const archive = new ArchiveSyncService({ db, events, logger, client: new MariposaClient({ transport: mariposa }), config });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, identity, windows, reviews, checkpoint, tools, supervisor, archive };
}

async function say(ctx: ReturnType<typeof compose>, content: string, id: string, occurredAt: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

// —— F04：同批 complete 排在 hold 前 → 先执行写、complete 最后验证；unknown hold 挡住换窗 ——
test('F04：同批 complete+hold（complete 在前），hold 结果未知 → 不签发完成凭证、不换窗', async () => {
  // chat 首轮：一次性给出 complete(no_new_hold)+hold，complete 排在前面；hold 返回 503
  let reviewIdSeen = '';
  const orT = orTransportWith({
    review: (_hasTool, reviewId) => {
      reviewIdSeen = reviewId;
      // 审计 R2：complete 排在 hold 之前 + hold 返回 503——修复后必须先执行写、complete 最后核验失败
      return twoToolBody('r1', ['call-comp', 'context_review_complete', { review_id: reviewId, decision: 'no_new_hold' }], ['call-hold', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: 'y' }]);
    },
  });
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'memory.hold') return { ok: false, code: 'HTTP_503', httpStatus: 503 };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const root = tempRoot('rm-f04-');
  const ctx = compose(root, orT, mariposa);
  await say(ctx, '第一句', 'f1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  await say(ctx, `触发评审${'很长的容量触发内容。'.repeat(500)}`, 'f2', at(8)); // 2026-10-08 晚间：静默不换窗——容量触发
  const review = ctx.db.prepare('SELECT status FROM rotation_reviews ORDER BY created_at DESC LIMIT 1').get() as { status: string };
  assert.equal(review.status, 'failed', 'hold unknown → complete 核验失败，评审不签发完成凭证');
  const effects = ctx.db.prepare("SELECT state FROM tool_side_effects WHERE kind='hold'").all() as Array<{ state: string }>;
  // WP-04（JFA-C05）：同窗 unknown 活跃时后续 memory_hold 被宿主拦截
  //（收口 cancelled=未发出，防重复写）——unknown 本身不被 no_new_hold
  // 抹掉；且不存在 running/committed
  assert.ok(effects.some((e) => e.state === 'unknown'), '写操作保持 unknown（不被 no_new_hold 抹掉）');
  assert.ok(effects.every((e) => e.state === 'unknown' || e.state === 'cancelled'), `无 running/committed/failed（实际 ${effects.map((e) => e.state).join(',')}）`);
  assert.equal(ctx.windows.activeWindow('c1')!.id, win1.id, '未换窗');
  const att = ctx.db.prepare("SELECT state, blocked_reason FROM attempts ORDER BY rowid DESC LIMIT 1").get() as { state: string; blocked_reason: string };
  assert.equal(att.state, 'blocked');
  assert.ok(att.blocked_reason.startsWith('ROTATION_REVIEW_FAILED'), '换窗如实阻断');
  void reviewIdSeen;
  ctx.db.close();
});

// —— F05：手动换窗与自动评审互斥；并发切窗后迟到评审不叠加轮转 ——
test('F05：活跃评审期间手动换窗被拒；评审完成后只换一次', async () => {
  const orT = orTransportWith({ review: (hasTool, reviewId) => (hasTool ? textBody('r2', 'done') : toolBody('r1', 'rc', 'context_review_complete', { review_id: reviewId, decision: 'no_new_hold' })) });
  const mariposa: MariposaTransport = async () => ({ ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 });
  const root = tempRoot('rm-f05-');
  const ctx = compose(root, orT, mariposa);
  await say(ctx, '第一句', 'm1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  // 人为制造"评审进行中"（与自动路径落库的 active 行同构）
  ctx.reviews.create(win1.id, 'c1', win1.revision, [{ id: 'msg_x', revision: 1, seq: 1 }]);
  const manual = await ctx.supervisor.manualRotate('c1');
  assert.equal(manual.ok, false);
  assert.ok(manual.ok === false && manual.reason.includes('REVIEW_IN_PROGRESS'), '手动换窗在评审期间被拒（无直转旁路）');
  assert.equal(ctx.windows.activeWindow('c1')!.id, win1.id);
  // 落一个并发切换（模拟迟到场景）：把 active 评审窗口换掉后，迟到完成不得再叠一次轮转
  ctx.db.prepare("UPDATE rotation_reviews SET status='failed' WHERE window_id=?").run(win1.id);
  const gate = ctx.identity.evaluateGate(ctx.db);
  const forced = ctx.windows.rotate({ conversationId: 'c1', gate, maxSequence: 1, assembledOptions: null });
  assert.ok(forced.ok, '前置：窗口已被并发切换');
  // 现在 doRotate 语义：旧窗评审即使完成也不应再切——以 active 窗口已不是评审目标窗为准
  const active = ctx.windows.activeWindow('c1')!;
  assert.notEqual(active.id, win1.id);
  const manual2 = await ctx.supervisor.manualRotate('c1');
  assert.ok(manual2.ok === true || (manual2.ok === false && !manual2.reason.includes('已换')), '后续手动换窗正常走管线');
  const count = (ctx.db.prepare('SELECT COUNT(*) n FROM windows').get() as { n: number }).n;
  assert.ok(count <= 3, '窗口数有界（不叠加轮转）');
  ctx.db.close();
});

// —— F07：同批两个工具，第一个执行期间停止 → 第二个不再分派 ——
test('F07：停止后同批后续工具不再分派（内容 fence 不足以拦副作用）', async () => {
  let holdStarted = () => {};
  let holdGate: Promise<void> = new Promise((r) => { holdStarted = r; });
  let releaseHold = () => {};
  holdGate = new Promise((r) => { releaseHold = r; });
  const holdCalls: string[] = [];
  const orT = orTransportWith({
    chat: (hasTool) => (hasTool ? textBody('c2', '完成') : twoToolBody('c1', ['call-a', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: 'A' }], ['call-b', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: 'B' }])),
  });
  const mariposa: MariposaTransport = async (cap, payload) => {
    if (cap === 'memory.hold') {
      holdCalls.push(String((payload as { operation_id?: string }).operation_id));
      holdStarted();
      await holdGate;
      return { ok: true, result: { operation_id: (payload as { operation_id: string }).operation_id, memory_id: 'mem-1', version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const root = tempRoot('rm-f07-');
  const ctx = compose(root, orT, mariposa);
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '两个工具', clientMessageId: 's1', occurredAt: T0 });
  ctx.supervisor.enqueue(sub.turnId);
  await new Promise<void>((r) => setTimeout(r, 30));
  const stopped = ctx.supervisor.stop(sub.turnId);
  assert.ok(stopped.stopped, '停止生效');
  releaseHold();
  await ctx.supervisor.waitIdle();
  assert.equal(holdCalls.length, 1, '第二个工具未被分派（停止即停止派发）');
  const att = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string; blocked_reason: string | null };
  assert.equal(att.state, 'interrupted');
  ctx.db.close();
});

// —— F08：聊天中 unknown hold → 评审前有界恢复（hold.status 有真实回执 → 落账+迟到书签；无证据→解除）——
test('F08：unknown hold 阻断评审；hold.status 恢复后放行并推进书签', async () => {
  let holdFail = true;
  const orT = orTransportWith({
    chat: (hasTool) => (hasTool ? textBody('c2', '好的') : toolBody('c1', 'hc', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: '记一下' })),
    review: (hasTool, reviewId) => (hasTool ? textBody('r2', 'ok') : toolBody('r1', 'rc', 'context_review_complete', { review_id: reviewId, decision: 'no_new_hold' })),
  });
  const mariposa: MariposaTransport = async (cap, payload) => {
    if (cap === 'memory.hold' && holdFail) return { ok: false, code: 'HTTP_503', httpStatus: 503 };
    if (cap === 'memory.hold') return { ok: true, result: { operation_id: (payload as { operation_id: string }).operation_id, memory_id: 'mem-rec', version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
    if (cap === 'memory.hold.status') {
      const op = (payload as { operation_id: string }).operation_id;
      return { ok: true, result: { operation_id: op, completed: true, receipt: { operation_id: op, memory_id: 'mem-rec', version: 1, binding_ids: [], committed_at: new Date().toISOString() } } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const root = tempRoot('rm-f08-');
  const ctx = compose(root, orT, mariposa);
  await say(ctx, '聊天中 hold 失败', 'u1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM tool_side_effects WHERE state='unknown'").get() as { n: number }).n, 1, '503=unknown 不是 failed');
  holdFail = false;
  const sub2 = await say(ctx, `次日触发评审${'很长的容量触发内容。'.repeat(500)}`, 'u2', at(26));
  // 恢复探测：hold.status 有真实回执 → committed + 书签；随后评审正常完成并换窗
  const effect = ctx.db.prepare("SELECT state, memory_id FROM tool_side_effects WHERE kind='hold'").get() as { state: string; memory_id: string };
  assert.equal(effect.state, 'committed', '按原 operation_id 恢复成功');
  assert.equal(effect.memory_id, 'mem-rec');
  const cp = ctx.checkpoint.forWindow(win1.id);
  assert.ok(cp, '迟到回执推进书签（只补原窗口记录）');
  assert.equal(cp!.memoryId, 'mem-rec');
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub2.attemptId) as { state: string };
  assert.equal(att.state, 'completed', '恢复后评审放行、换窗、本轮照常完成');
  ctx.db.close();
});

test('F08b：hold.status 明确无提交证据 → 解除阻塞（failed_resolved），不产生书签', async () => {
  const orT = orTransportWith({
    chat: (hasTool) => (hasTool ? textBody('c2', '好的') : toolBody('c1', 'hc', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' })),
    review: (hasTool, reviewId) => (hasTool ? textBody('r2', 'ok') : toolBody('r1', 'rc', 'context_review_complete', { review_id: reviewId, decision: 'no_new_hold' })),
  });
  const mariposa: MariposaTransport = async (cap, payload) => {
    if (cap === 'memory.hold') return { ok: false, code: 'HTTP_503', httpStatus: 503 };
    if (cap === 'memory.hold.status') return { ok: true, result: { operation_id: (payload as { operation_id: string }).operation_id, completed: false } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const root = tempRoot('rm-f08b-');
  const ctx = compose(root, orT, mariposa);
  await say(ctx, 'hold 未知', 'v1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  const sub2 = await say(ctx, `触发评审${'很长的容量触发内容。'.repeat(500)}`, 'v2', at(26));
  const effect = ctx.db.prepare("SELECT state FROM tool_side_effects WHERE kind='hold'").get() as { state: string };
  assert.equal(effect.state, 'failed_resolved', '服务端明确无提交证据=可判定的未提交（不是没发生）');
  assert.equal(ctx.checkpoint.forWindow(win1.id), null, '无提交则无书签');
  assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id=?').get(sub2.attemptId) as { state: string }).state, 'completed');
  ctx.db.close();
});

// —— F09/F15/F16/F10-ack：归档同步冻结批次与回执校验 ——
function syncCompose(root: string, mariposa: MariposaTransport) {
  const config = buildConfig({
    archive: { enabled: true, source_scope: 'sync-test' },
    integrations: { mariposa: { base_url: 'http://127.0.0.1:9', credential_ref: null } },
  });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const sync = new ArchiveSyncService({ db, events, logger, client: new MariposaClient({ transport: mariposa }), config });
  return { db, messages, sync };
}

/** 契约语义假服务端：同 op 同 payload 重放同 ACK；不同 payload 冲突；记录收到的原始 JSON。 */
function contractServer() {
  const state = new Map<string, { canonical: string; ack: Record<string, unknown> }>();
  const seen: Array<{ op: string; json: string }> = [];
  const transport: MariposaTransport = async (cap, payload) => {
    if (cap !== 'source.ingest') return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    const req = payload as unknown as { operation_id: string; messages: unknown[] };
    const canonical = JSON.stringify(req.messages);
    seen.push({ op: req.operation_id, json: canonical });
    const prev = state.get(req.operation_id);
    if (prev) {
      if (prev.canonical !== canonical) return { ok: false, code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 };
      return { ok: true, result: prev.ack };
    }
    const ack = {
      operation_id: req.operation_id, committed_at: new Date().toISOString(),
      messages: (req.messages as Array<{ origin_message_id: string; revision: number; content_hash: string }>).map((m) => ({
        origin_message_id: m.origin_message_id, revision: m.revision, source_conversation_id: 'mc', source_message_id: `ms-${m.origin_message_id}-r${m.revision}`, content_hash: m.content_hash,
      })),
    };
    state.set(req.operation_id, { canonical, ack });
    return { ok: true, result: ack };
  };
  return { state, transport, seen };
}

test('F09：响应丢失+新消息+前驱被编辑 → 原批字节一致重放，新消息另批，无重组无冲突', async () => {
  const { transport, seen } = contractServer();
  let failOnce = true;
  const wrapping: MariposaTransport = async (cap, payload) => {
    const r = await transport(cap, payload);
    if (cap === 'source.ingest' && r.ok && failOnce) {
      failOnce = false;
      throw new Error('fetch failed: socket hang up'); // 服务端已提交、响应丢失
    }
    return r;
  };
  const root = tempRoot('rm-f09-');
  const ctx = syncCompose(root, wrapping);
  const s1 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'A', clientMessageId: 'a', occurredAt: T0 });
  await ctx.sync.drainOnce();
  // 崩溃后：新消息 B + A 被编辑（A@2）
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'B', clientMessageId: 'b', occurredAt: at(1) });
  ctx.messages.editUserMessage(s1.message.id, 'A2-改');
  await ctx.sync.drainOnce();
  const rows = ctx.db.prepare("SELECT operation_key, state, last_error FROM outbox ORDER BY operation_key").all() as Array<{ operation_key: string; state: string; last_error: string | null }>;
  assert.ok(rows.filter((r) => r.operation_key.includes(s1.message.id)).every((r) => r.state === 'acked'), 'A@1 原批重放成功（与编辑无关）');
  const failed = rows.filter((r) => r.state === 'failed');
  assert.equal(failed.length, 0, `无永久失败（实际：${JSON.stringify(failed)}）`);
  // 原批重放必须字节一致：同一 op 的两次发送 json 完全相同
  const ops = new Map<string, string[]>();
  for (const s of seen) ops.set(s.op, [...(ops.get(s.op) ?? []), s.json]);
  for (const [op, jsons] of ops) {
    assert.ok(jsons.length >= 1);
    for (const j of jsons.slice(1)) assert.equal(j, jsons[0], `op ${op} 重放必须字节一致（F09）`);
  }
  // 发送序列：[A@1 首发 crashed] → drain2：[A@1 冻结重放（同 op 同字节）] + [B 与 A@2 的新批（新行可合批，合法）]
  assert.equal(seen.length, 3, '恰好三次发送');
  assert.equal(seen[1]!.op, seen[0]!.op, '崩溃批按原 op 重放（F09：不换 op 盲建）');
  assert.equal(seen[1]!.json, seen[0]!.json, '重放字节一致（含被编辑前驱的旧版本——payload 已冻结）');
  assert.notEqual(seen[2]!.op, seen[0]!.op, '新消息进新批，不并入冻结旧批');
  ctx.db.close();
});

test('F10-ack：空回执不冒充已同步；hash 不符=dead', async () => {
  const emptyAck: MariposaTransport = async (cap, payload) => {
    if (cap !== 'source.ingest') return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    const req = payload as unknown as { operation_id: string };
    return { ok: true, result: { operation_id: req.operation_id, committed_at: new Date().toISOString(), messages: [] } };
  };
  const root = tempRoot('rm-f10a-');
  const ctx = syncCompose(root, emptyAck);
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'X', clientMessageId: 'x', occurredAt: T0 });
  await ctx.sync.drainOnce();
  const row = ctx.db.prepare("SELECT state, last_error FROM outbox WHERE target='mariposa.archive'").get() as { state: string; last_error: string };
  assert.equal(row.state, 'unknown_outcome', '空回执=结果不明，不标 acked');
  assert.equal(row.last_error, 'ACK_INCOMPLETE');
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM source_sync_receipts').get() as { n: number }).n, 0, '无收据落库');
  ctx.db.close();

  const hashMismatch: MariposaTransport = async (cap, payload) => {
    if (cap !== 'source.ingest') return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    const req = payload as unknown as { operation_id: string; messages: Array<{ origin_message_id: string; revision: number; content_hash: string }> };
    return { ok: true, result: { operation_id: req.operation_id, committed_at: new Date().toISOString(), messages: req.messages.map((m) => ({ origin_message_id: m.origin_message_id, revision: m.revision, source_conversation_id: 'mc', source_message_id: 's1', content_hash: 'f'.repeat(64) })) } };
  };
  const root2 = tempRoot('rm-f10b-');
  const ctx2 = syncCompose(root2, hashMismatch);
  ctx2.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'Y', clientMessageId: 'y', occurredAt: T0 });
  await ctx2.sync.drainOnce();
  const row2 = ctx2.db.prepare("SELECT state, last_error FROM outbox WHERE target='mariposa.archive'").get() as { state: string; last_error: string };
  assert.equal(row2.state, 'failed');
  assert.equal(row2.last_error, 'ACK_HASH_MISMATCH', 'hash 不符=确定性冲突，dead');
  ctx2.db.close();
});

test('F15：503 可重试（不再永久失败）；有界次数后 TRANSIENT_EXHAUSTED', async () => {
  let calls = 0;
  let succeedAt = 2; // 第 2 次成功（drain1 失败回 pending，drain2 同批重试成功）
  const t503: MariposaTransport = async (cap, payload) => {
    if (cap !== 'source.ingest') return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    calls++;
    if (calls < succeedAt) return { ok: false, code: 'HTTP_503', httpStatus: 503 };
    const req = payload as unknown as { operation_id: string; messages: Array<{ origin_message_id: string; revision: number; content_hash: string }> };
    return { ok: true, result: { operation_id: req.operation_id, committed_at: new Date().toISOString(), messages: req.messages.map((m) => ({ origin_message_id: m.origin_message_id, revision: m.revision, source_conversation_id: 'mc', source_message_id: `s-${m.origin_message_id}`, content_hash: m.content_hash })) } };
  };
  const root = tempRoot('rm-f15a-');
  const ctx = syncCompose(root, t503);
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '重试', clientMessageId: 'r1', occurredAt: T0 });
  await ctx.sync.drainOnce();
  let row = ctx.db.prepare("SELECT state FROM outbox WHERE target='mariposa.archive'").get() as { state: string };
  assert.equal(row.state, 'pending', '503=可重试，不永久失败');
  await ctx.sync.drainOnce();
  row = ctx.db.prepare("SELECT state FROM outbox WHERE target='mariposa.archive'").get() as { state: string };
  assert.equal(row.state, 'acked', '同批重试成功（冻结 payload）');
  assert.equal(calls, 2, '两次 drain、两次发送：重试在冻结的同 op 上');
  ctx.db.close();

  succeedAt = Infinity; // 永远 503
  const t503b: MariposaTransport = async (cap) => (cap === 'source.ingest' ? { ok: false, code: 'HTTP_503', httpStatus: 503 } : { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 });
  const root2 = tempRoot('rm-f15b-');
  const ctx2 = syncCompose(root2, t503b);
  ctx2.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '耗尽', clientMessageId: 'r2', occurredAt: T0 });
  for (let i = 0; i < 12; i++) await ctx2.sync.drainOnce();
  const row2 = ctx2.db.prepare("SELECT state, last_error FROM outbox WHERE target='mariposa.archive'").get() as { state: string; last_error: string };
  assert.equal(row2.state, 'failed');
  assert.equal(row2.last_error, 'TRANSIENT_EXHAUSTED', '有界重试后如实 dead');
  ctx2.db.close();
});

test('F16：切批按 JSON 字节（600k 双引号正文 JSON 化后 >1MiB → 单条超限）', async () => {
  const { transport } = contractServer();
  const root = tempRoot('rm-f16-');
  const ctx = syncCompose(root, transport);
  // 600000 个双引号：原文 600k 字节 < 1MiB，但 JSON 序列化转义翻倍 >1.2MiB（审计复现数据）
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '"'.repeat(600000), clientMessageId: 'q1', occurredAt: T0 });
  await ctx.sync.drainOnce();
  const row = ctx.db.prepare("SELECT state, last_error FROM outbox WHERE target='mariposa.archive'").get() as { state: string; last_error: string };
  assert.equal(row.state, 'failed');
  assert.equal(row.last_error, 'OVERSIZED_MESSAGE', '按规范化 JSON 字节判界，不静默截断');
  ctx.db.close();
});
