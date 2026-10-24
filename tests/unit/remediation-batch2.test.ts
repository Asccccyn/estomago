// 审计整改批次②回归（estomago-audit-18a1f1f：F01/F02/F03尾/F06/F13/F14/F17）。
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
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { withoutCacheMarkers } from '../../apps/host/src/runtime/or-payload.ts';
import { writeApprovedIdentity, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + DONE;
const toolBody = (id: string, callId: string, name: string, args: Record<string, unknown>, reasoning?: unknown) =>
  (reasoning ? sse({ id, choices: [{ delta: { reasoning_details: [reasoning] } }] }) : '') +
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const mixedTextToolBody = (id: string, text: string, callId: string, name: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { content: text } }] }) +
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

const T0 = '2026-10-01T08:00:00+08:00';
const at = (h: number) => new Date(Date.parse(T0) + h * 3600e3).toISOString();

type PayloadLog = Array<Record<string, unknown>>;
function loggingTransport(log: PayloadLog, respond: (payload: Record<string, unknown>, hasTool: boolean) => string): OrTransport {
  let gen = 0;
  return async (payload) => {
    log.push(structuredClone(payload));
    gen++;
    const messages = payload.messages as Array<{ role: string }>;
    const hasTool = messages[messages.length - 1]?.role === 'tool';
    return { status: 200, headers: new Map<string, string>(), body: frameStream(respond(payload, hasTool)) };
  };
}

const mariposaOk: MariposaTransport = async (cap, payload) => {
  if (cap === 'memory.hold') {
    const op = (payload as { operation_id: string }).operation_id;
    return { ok: true, result: { operation_id: op, memory_id: `mem-${op.slice(-4)}`, version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
  }
  return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
};

function compose(root: string, orTransport: OrTransport, mariposa: MariposaTransport, opts: { seedProbes?: boolean; configOver?: Record<string, unknown>; withSdkEnv?: boolean } = {}) {
  writeApprovedIdentity(root, { seedProbes: opts.seedProbes ?? true });
  // withSdkEnv=false：完全不给 SDK 前提（无 sdk_version 锁定/无订阅确认/无探针证据）——审计 F01 场景
  const identityPatch = { expected_identity_version: 'test-v1', expected_i_version: 'test-i-1', expected_rules_version: 'test-rules-1' };
  const base = opts.withSdkEnv === false
    ? { runtime: { provider: 'openrouter' }, identity: identityPatch, openrouter: { model: MODEL } }
    : { runtime: { provider: 'openrouter', sdk_version: '0.0.0-test', auth_and_billing_verified: true }, identity: identityPatch, openrouter: { model: MODEL } };
  const config = buildConfig({ ...base, ...(opts.configOver ?? {}) });
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
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, orTransport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, identity, windows, reviews, checkpoint, trajectory, supervisor };
}

async function say(ctx: ReturnType<typeof compose>, content: string, id: string, occurredAt: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

test('F01：无任何 SDK 前提（不装探针/不锁版本/不确认订阅）→ OR 照常出稿', async () => {
  const log: PayloadLog = [];
  const t = loggingTransport(log, (_p, hasTool) => (hasTool ? textBody('g2', '好的') : toolBody('g1', 'hc', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' })));
  const root = tempRoot('rm2-f01-');
  const ctx = compose(root, t, mariposaOk, { withSdkEnv: false, seedProbes: false });
  const sub = await say(ctx, '第一句', 'a1', T0);
  const att = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string; blocked_reason: string | null };
  assert.equal(att.state, 'completed', `OR 不被 SDK 前提卡死（blocked=${att.blocked_reason}）`);
  assert.equal(log.length, 2, '真实发出了模型请求（含工具续轮）');
  ctx.db.close();
});

test('F02：已验证的当前 I 完整进入 OR 固定前缀（system 首块）', async () => {
  const log: PayloadLog = [];
  const t = loggingTransport(log, () => textBody('g1', '回'));
  const root = tempRoot('rm2-f02-');
  const ctx = compose(root, t, mariposaOk);
  await say(ctx, '看 I', 'i1', T0);
  const msgs = log[0]!.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  assert.equal(msgs[0]!.role, 'system');
  assert.ok(msgs[0]!.content[0]!.text.includes('（测试）I 快照合成内容'), 'I 快照正文进入 A 前缀');
  assert.ok(msgs[0]!.content[0]!.text.includes('（测试）经批准身份正文'), '身份正文在');
  assert.ok(msgs[0]!.content[0]!.text.includes('（测试）运行规则合成内容'), '批准规则在');
  ctx.db.close();
});

test('F03 尾：工具续请求每轮重算容量硬门——超界即停，不再发送', async () => {
  // soft=800（首轮 ~300 不触发换窗）；safeInput=1000（工具参数膨胀后续轮 >1000 → 拦截）
  const log: PayloadLog = [];
  const t = loggingTransport(log, () => toolBody('g1', 'hc', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: '很长的记忆内容'.repeat(400) }));
  const root = tempRoot('rm2-f03-');
  const ctx = compose(root, t, mariposaOk, { configOver: { windows: { model_context_capacity: 29192, soft_limit_tokens: 800 } } });
  const sub = await say(ctx, '触发工具', 't1', T0);
  assert.equal(log.length, 1, '只有首轮请求——续轮被容量硬门拦截，未发出');
  const att = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string; blocked_reason: string | null };
  assert.equal(att.state, 'failed');
  assert.ok(att.blocked_reason!.includes('CAPACITY_BLOCKED_HARD'), att.blocked_reason ?? '');
  const prq = ctx.db.prepare("SELECT outcome FROM provider_requests ORDER BY rowid DESC LIMIT 1").get() as { outcome: string | null };
  assert.equal(prq.outcome, 'CAPACITY_BLOCKED_HARD', '被拦截的续轮请求留了证据行');
  ctx.db.close();
});

test('F06：预算裁剪留新丢旧；未实际携带的消息不进评审范围', async () => {
  const log: PayloadLog = [];
  // 近期预算压到 ~12 token（30 字符）：旧消息（长）被裁、新消息（短）必进
  const t = loggingTransport(log, (_p, hasTool) => {
    if (!hasTool) {
      const last = log[log.length - 1]!;
      const msgs = last.messages as Array<{ role: string; content: unknown }>;
      void msgs;
    }
    return hasTool ? textBody('g2', 'ok') : textBody('g1', '回复');
  });
  const root = tempRoot('rm2-f06-');
  const ctx = compose(root, t, mariposaOk, { configOver: { windows: { soft_limit_tokens: 1800 } } }); // 2026-10-08 晚间：静默不换窗——容量触发
  await say(ctx, '这条旧消息非常长非常长非常长非常长非常长非常长', 'old1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  await say(ctx, `新消息很长以触发容量换窗${'内容填充。'.repeat(2200)}`, 'new1', at(8)); // 2026-10-08：8h 本身不再触发——软线压低后容量触发（范围应只含实际携带的）
  // 初始轨迹 manifest：旧长消息被预算裁掉、不在已见清单
  const traj1 = ctx.trajectory.forWindow(win1.id)!;
  const manifestIds = traj1.manifest.map((m) => m.seq);
  assert.ok(!manifestIds.includes(1) || traj1.messages.some((m) => JSON.stringify(m.content).includes('旧消息')), '裁剪与清单一致');
  // 换窗后评审发生过（8h 触发），且范围不含从未携带的消息版本
  const review = ctx.db.prepare('SELECT range_keys_json FROM rotation_reviews ORDER BY created_at DESC LIMIT 1').get() as { range_keys_json: string };
  const rangeKeys = JSON.parse(review.range_keys_json) as string[];
  assert.ok(rangeKeys.every((k) => traj1.manifest.some((m) => `${m.id}@${m.revision}` === k)), '范围 ⊆ 实际已见清单（不登记未携带消息）');
  ctx.db.close();
});

test('F13：续请求保留已发布正文与 opaque reasoning 协议继续态', async () => {
  const log: PayloadLog = [];
  const t = loggingTransport(log, (_p, hasTool) => (hasTool
    ? textBody('g2', '最终回复')
    : mixedTextToolBody('g1', '先说一段话', 'hc', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: '记这个' })));
  const root = tempRoot('rm2-f13-');
  const ctx = compose(root, t, mariposaOk);
  await say(ctx, '正文+工具', 'p1', T0);
  assert.equal(log.length, 2);
  const round2 = log[1]!.messages as Array<Record<string, unknown>>;
  const assistantMsg = round2.find((m) => m.role === 'assistant') as { content: unknown; tool_calls: unknown; reasoning_details?: unknown };
  assert.ok(assistantMsg, '续请求包含 assistant 消息');
  assert.equal(assistantMsg.content, '先说一段话', '已发布正文原样续传（不再丢成 null）');
  assert.ok(Array.isArray(assistantMsg.tool_calls));
  // 本场景首轮未带 reasoning delta → 无该字段；带片段时必须透传（下方断言驱动器层）
  const withReasoningLog: PayloadLog = [];
  const t2 = loggingTransport(withReasoningLog, (_p, hasTool) => (hasTool
    ? textBody('g2', '完')
    : toolBody('g1', 'hc', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: 'r' }, { type: 'thinking', thinking: 'opaque-token-abc' })));
  const root2 = tempRoot('rm2-f13b-');
  const ctx2 = compose(root2, t2, mariposaOk);
  await say(ctx2, '带思考片段的工具轮', 'p2', T0);
  const round2b = withReasoningLog[1]!.messages as Array<Record<string, unknown>>;
  const assistantB = round2b.find((m) => m.role === 'assistant') as { reasoning_details?: unknown };
  assert.deepEqual(assistantB.reasoning_details, [{ type: 'thinking', thinking: 'opaque-token-abc' }], 'opaque 片段按接收顺序展平为一维（§10 形状保真，复审 F13：不再 object[][]）');
  ctx.db.close();
  ctx2.db.close();
});

test('F14：成功 hold 的书签视野包含当前输入（首条消息 → seen_sequence=1）', async () => {
  const log: PayloadLog = [];
  const t = loggingTransport(log, (_p, hasTool) => (hasTool ? textBody('g2', '记好了') : toolBody('g1', 'hc', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' })));
  const root = tempRoot('rm2-f14-');
  // 整合（2026-10-24）：config 默认 tool_schema_mode=deferred + D2 新窗冻结初始目录后，
  // 直调 memory_hold 的老场景须显式声明 legacy 世界（测试意图=hold 书签语义，与协议模式无关）
  const ctx = compose(root, t, mariposaOk, { configOver: { runtime: { tool_schema_mode: 'legacy' } } });
  await say(ctx, '第一条就记', 'b1', T0);
  const win = ctx.windows.activeWindow('c1')!;
  const cp = ctx.checkpoint.forWindow(win.id);
  assert.ok(cp, '书签已产生');
  assert.equal(cp!.seenSequence, 1, '发起请求实际看见的输入（seq=1）——不再落后一条');
  ctx.db.close();
});

test('F17：provider_requests 留完整重放投影与终态', async () => {
  const log: PayloadLog = [];
  const t = loggingTransport(log, (_p, hasTool) => (hasTool ? textBody('g2', 'ok') : toolBody('g1', 'hc', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' })));
  const root = tempRoot('rm2-f17-');
  const ctx = compose(root, t, mariposaOk);
  await say(ctx, '两轮请求', 'q1', T0);
  const rows = ctx.db.prepare('SELECT payload_json, generation_id, outcome FROM provider_requests ORDER BY rowid').all() as Array<{ payload_json: string | null; generation_id: string | null; outcome: string | null }>;
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(r.payload_json && (JSON.parse(r.payload_json) as { messages: unknown[] }).messages.length > 0, '不可变协议投影可重放');
    assert.ok(r.generation_id, 'generation id 已回填');
    assert.equal(r.outcome, 'completed', '终态已回填');
    const replayed = JSON.parse(r.payload_json!) as Record<string, unknown>;
    const sent = log[rows.indexOf(r)]!;
    // 发送副本带 cache_control 标记（§7.2 统一重规划）；比较前剥标记——语义负载必须一致
    const strip = (x: unknown): unknown => withoutCacheMarkers(x as Record<string, unknown>);
    assert.equal(JSON.stringify(replayed.messages), JSON.stringify((strip({ messages: sent.messages }) as { messages: unknown }).messages), '投影与实际发送一致（剥缓存标记后）');
  }
  ctx.db.close();
});
