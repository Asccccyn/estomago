// 审计整改批次③回归（estomago-audit-18a1f1f：F12/F18/F19/F20）。
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
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + DONE;
const toolBody = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));
const usageFrame = (input: number, output: number, cost: number, cached: number) =>
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: input, completion_tokens: output, cost, prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 } } });

const T0 = '2026-10-01T08:00:00+08:00';
const mariposaOk: MariposaTransport = async (cap, payload) => {
  if (cap === 'memory.hold') {
    const op = (payload as { operation_id: string }).operation_id;
    return { ok: true, result: { operation_id: op, memory_id: 'mem-x', version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
  }
  return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
};

function compose(root: string, orTransport: OrTransport) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: MODEL } });
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
  const mariposa_wire_1 = new MariposaClient({ transport: mariposaOk });
  const { tools: tools } = assembleTestTools({ db: db, mariposa: mariposa_wire_1, reviews: reviews, checkpoint: checkpoint });;
  const trajectory = new WindowTrajectoryService(db);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, orTransport);
  const supervisor = new TurnSupervisor({bootstrap: new MariposaClient({ transport: mariposaOk }), // S18：显式 BootstrapPort（原经 tools.mariposaClient 隐式取得）
     db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, identity, windows, reviews, checkpoint, trajectory, supervisor };
}

async function say(ctx: ReturnType<typeof compose>, content: string, id: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: T0 });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

test('F12：同 turn 两次请求的用量分行保留（合计 220 而非互覆 120）', async () => {
  let gen = 0;
  const t: OrTransport = async () => {
    gen++;
    if (gen === 1) return { status: 200, headers: new Map<string, string>(), body: frameStream(sse({ id: 'gen-1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'memory_hold', arguments: '{"category":"daily","text":"x"}' } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 5, cost: 0.01, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }) + DONE) };
    return { status: 200, headers: new Map<string, string>(), body: frameStream(sse({ id: 'gen-2', choices: [{ delta: { content: '完成' } }] }) + usageFrame(120, 4, 0.02, 60) + DONE) };
  };
  const root = tempRoot('rm3-f12-');
  const ctx = compose(root, t);
  const sub = await say(ctx, '两轮', 'u1');
  assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id=?').get(sub.attemptId) as { state: string }).state, 'completed');
  const rows = ctx.db.prepare('SELECT request_id, input_tokens FROM usage_observations WHERE attempt_id = ? ORDER BY rowid').all(sub.attemptId) as Array<{ request_id: string | null; input_tokens: number | null }>;
  assert.equal(rows.length, 2, '两次请求两行（不互覆）');
  assert.ok(rows[0]!.request_id && rows[1]!.request_id && rows[0]!.request_id !== rows[1]!.request_id, '各自携带请求身份');
  const sum = rows.reduce((s, r) => s + (r.input_tokens ?? 0), 0);
  assert.equal(sum, 220, '合计 220（审计复现中只剩 120）');
  ctx.db.close();
});

test('F19：已返回的 cost/raw/anomalies 落库可查', async () => {
  let gen = 0;
  const t: OrTransport = async () => {
    gen++;
    const usage = gen === 1
      ? { prompt_tokens: 10, completion_tokens: 5, cost: 0.013, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 } }
      : { prompt_tokens: 20, completion_tokens: 8, cost: 0.02, completion_tokens_details: { reasoning_tokens: 30 } }; // reasoning>output → anomaly
    return { status: 200, headers: new Map<string, string>(), body: frameStream(sse({ id: `g${gen}`, choices: [{ delta: { content: `回${gen}` } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + DONE) };
  };
  const root = tempRoot('rm3-f19-');
  const ctx = compose(root, t);
  await say(ctx, '第一句', 'c1');
  await say(ctx, '第二句', 'c2');
  const rows = ctx.db.prepare('SELECT cost_usd, reasoning_tokens, anomalies_json, raw_usage_json FROM usage_observations ORDER BY rowid').all() as Array<{ cost_usd: number | null; reasoning_tokens: number | null; anomalies_json: string | null; raw_usage_json: string | null }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.cost_usd, 0.013, '费用不再在桥接中丢失');
  assert.equal(rows[1]!.reasoning_tokens, 30);
  assert.ok(JSON.parse(rows[1]!.anomalies_json ?? '[]').includes('REASONING_EXCEEDS_OUTPUT'), '异常标记保留');
  assert.ok(rows[0]!.raw_usage_json && JSON.parse(rows[0]!.raw_usage_json).prompt_tokens === 10, '原始帧可对账');
  ctx.db.close();
});

test('F18：G 候选指向实际已发送的末块（非未发送的最终 assistant）', async () => {
  let gen = 0;
  const t: OrTransport = async () => {
    gen++;
    if (gen === 1) return { status: 200, headers: new Map<string, string>(), body: frameStream(toolBody('g1', 'hc', 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' })) };
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody('g2', '最终回复正文')) };
  };
  const root = tempRoot('rm3-f18-');
  const ctx = compose(root, t);
  await say(ctx, '触发', 'g1');
  const win = ctx.windows.activeWindow('c1')!;
  const traj = ctx.trajectory.forWindow(win.id)!;
  // 最后一轮实际发送的是 [.., assistant(tool_calls), tool(result)] —— G 应指 tool 结果前的 assistant 块？
  // tailBoundaryOf 只认 text 块：最后发送消息里最后的 text 块 = 用户输入（assistant tool_calls 无 text 块、tool 结果非 text）
  const boundaryMsg = traj.messages[traj.lastBoundary!.messageIndex]!;
  const block = (boundaryMsg.content as Array<Record<string, unknown>>)[traj.lastBoundary!.contentIndex]!;
  assert.equal(block.type, 'text');
  // 该块必须属于"已发送"集合：边界索引 < 轨迹长度（最终 assistant 在其后，从未发送）
  assert.ok(traj.lastBoundary!.messageIndex < traj.messages.length - 1 || (traj.lastBoundary!.messageIndex === traj.messages.length - 1 && traj.messages[traj.messages.length - 1]!.role !== 'assistant'),
    'G 不指向本轮新生成、尚未随任何请求发送的 assistant 输出');
  ctx.db.close();
});

test('F20：停止后已抵达的 usage 帧仍被记账（不丢已收到的事实）', async () => {
  // 正文帧后挂起：宿主停止 → 流继续送 usage+DONE → 驱动须记账 usage 且终态 interrupted
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const t: OrTransport = async () => {
    async function* body() {
      yield enc.encode(sse({ id: 'g1', choices: [{ delta: { content: '第一段' } }] }));
      yield enc.encode(sse({ choices: [{ delta: { content: '第二段' } }] }));
      await gate;
      yield enc.encode(usageFrame(50, 6, 0.007, 20) + DONE);
    }
    return { status: 200, headers: new Map<string, string>(), body: body() };
  };
  const root = tempRoot('rm3-f20-');
  const ctx = compose(root, t);
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '会停的轮', clientMessageId: 's1', occurredAt: T0 });
  ctx.supervisor.enqueue(sub.turnId);
  await new Promise((r) => setTimeout(r, 40));
  ctx.supervisor.stop(sub.turnId);
  release();
  await ctx.supervisor.waitIdle();
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'interrupted', '终态=停止');
  const usage = ctx.db.prepare('SELECT input_tokens, cost_usd FROM usage_observations WHERE attempt_id = ?').get(sub.attemptId) as { input_tokens: number | null; cost_usd: number | null };
  assert.equal(usage.input_tokens, 50, '停止后到达的 usage 帧被记账（原来会整帧丢弃）');
  assert.equal(usage.cost_usd, 0.007);
  ctx.db.close();
});
