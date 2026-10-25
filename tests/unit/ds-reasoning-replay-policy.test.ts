// DS 跨轮 reasoning 继续态：实际 wire 行为回归（R01 减法后本文件不再测政策解析——
// 每窗双政策层已按她 1024 裁定退役，协议历史正本全保留、统一完整回传，守卫无条件）。
// 守卫：DS 跨轮以**上一笔已完成回合实发 wire** 为独立证据核对轨迹前缀（role/长度/继续态），
// wire 有而轨迹无（或反之）= 拒发。migration36 的 reasoning_replay_policy 列按裁定保留空闲。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
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
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1', 'Use the isolated npm test runner');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));
const HOLD_ARGS = { original_title: '政策回归', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' };
const toolRound = (gen: string) =>
  sse({ id: gen, choices: [{ delta: { reasoning_content: '思考片段甲' } }] })
  + sse({ choices: [{ delta: { reasoning_content: '乙' } }] })
  + sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'memory_hold', arguments: JSON.stringify(HOLD_ARGS) } }] } }] })
  + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const finalWithReasoning = (gen: string, text: string) =>
  sse({ id: gen, choices: [{ delta: { reasoning_content: '最终思考' } }] })
  + sse({ choices: [{ delta: { content: text } }] })
  + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;

function composeSup(root: string, transport: OrTransport, model: string, baseUrl?: string) {
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' },
    deepseek: { model, ...(baseUrl ? { base_url: baseUrl } : {}) },
  });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const mariposa: MariposaTransport = async (cap, payload) => ({ ok: true, result: { operation_id: payload.operation_id, memory_id: 'mem-x', version: 1, binding_ids: [], committed_at: new Date().toISOString() } });
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, trajectory };
}

const say = (ctx: ReturnType<typeof composeSup>, text: string, id: string) => {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: text, clientMessageId: id, occurredAt: new Date().toISOString() });
  ctx.supervisor.enqueue(sub.turnId);
  return sub;
};

test('DS 工具轮+最终回复的继续态全保留；下一用户轮实发回传（E08 修复）', async () => {
  const root = tempRoot('r2-new-');
  const payloads: Array<Record<string, unknown>> = [];
  let gen = 0;
  const transport: OrTransport = async (payload) => {
    payloads.push(structuredClone(payload));
    gen += 1;
    const hasToolResult = (payload.messages as Array<{ role: string }>).some((m) => m.role === 'tool');
    const isFirstTurn = payloads.length <= 2;
    if (!hasToolResult && isFirstTurn) return { status: 200, headers: new Map<string, string>(), body: frameStream(toolRound(`g${gen}`)) };
    if (hasToolResult) return { status: 200, headers: new Map<string, string>(), body: frameStream(finalWithReasoning(`g${gen}`, '记好了')) };
    return { status: 200, headers: new Map<string, string>(), body: frameStream(sse({ id: `g${gen}`, choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE) };
  };
  const ctx = composeSup(root, transport, 'deepseek-flash');
  const win0 = ctx.windows.activeWindow('c1') ?? null;
  assert.equal(win0, null, '尚无活动窗口（首窗随首回合建）');
  const t1 = say(ctx, '记一件事', 'r1');
  await ctx.supervisor.waitIdle();
  assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(t1.attemptId) as { state: string }).state, 'completed');
  const win = ctx.windows.activeWindow('c1')!;
  const traj = ctx.trajectory.forWindow(win.id)!;
  const trajJson = JSON.stringify(traj.messages);
  assert.ok(trajJson.includes('思考片段甲乙') || trajJson.includes('"思考片段甲"'), '工具 assistant 继续态保留在轨迹');
  const finalAsst = traj.messages.at(-1)!;
  assert.equal((finalAsst as Record<string, unknown>).reasoning_content, '最终思考', '根因一修复：最终 assistant 继续态入轨迹');
  // 第二用户轮：E08 场景——回文字时旧 assistant（含最终回复）的 reasoning_content 必须仍在实发前缀
  const before = payloads.length;
  say(ctx, '再聊一句', 'r2');
  await ctx.supervisor.waitIdle();
  assert.ok(payloads.length > before, '第二回合真实派发');
  const later = payloads.slice(before);
  const flat = JSON.stringify(later.map((p) => (p as { messages: unknown[] }).messages));
  assert.ok(flat.includes('思考片段甲'), '跨用户轮回传工具 assistant 继续态（根因二修复：不再剥除）');
  assert.ok(flat.includes('最终思考'), '跨用户轮回传最终 assistant 继续态');
  ctx.db.close();
});

// 她 1024 裁定（接缝①落地）：协议历史正本全保留、统一完整回传；"旧窗剥除"规则废止。
// 另：本场景 deepseek-chat（非 thinking 型号）的 fake transport 此前伪造了 reasoning_content——
// 真实端点不产生继续态，测试数据须与真实数据隔离对齐，旧"冲突"是假象（10×复跑行为确定）。
test('全保留基线：deepseek-chat（无继续态型号）正常四场景——工具续轮/普通续聊/重复运行/轨迹续读', async () => {
  const root = tempRoot('r2-keepall-');
  const payloads: Array<Record<string, unknown>> = [];
  let gen = 0;
  // 对齐真实 deepseek-chat 能力：不产 reasoning_content；工具轮（memory_hold）+最终回复+普通续聊
  const transport: OrTransport = async (payload) => {
    payloads.push(structuredClone(payload));
    gen += 1;
    const hasToolResult = (payload.messages as Array<{ role: string }>).some((m) => m.role === 'tool');
    if (!hasToolResult && payloads.length <= 2) return { status: 200, headers: new Map<string, string>(), body: frameStream(toolRound(`g${gen}`).split('\n\n').filter((x) => !x.includes('reasoning_content')).join('\n\n') + '\n\n') };
    if (hasToolResult) return { status: 200, headers: new Map<string, string>(), body: frameStream(sse({ id: `g${gen}`, choices: [{ delta: { content: '记好了' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE) };
    return { status: 200, headers: new Map<string, string>(), body: frameStream(sse({ id: `g${gen}`, choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE) };
  };
  const ctx = composeSup(root, transport, 'deepseek-chat');
  try {
    // 场景 A：工具续轮（首轮 hold→最终回复），无继续态型号轨迹自然无继续态
    const t1 = say(ctx, '记一件事', 'r1');
    await ctx.supervisor.waitIdle();
    assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(t1.attemptId) as { state: string }).state, 'completed');
    const win = ctx.windows.activeWindow('c1')!;
    assert.equal(JSON.stringify(ctx.trajectory.forWindow(win.id)!.messages).includes('reasoning_content'), false, '无继续态型号：轨迹无继续态（对齐真实能力）');
    // 场景 B：普通续聊——上一轮全量前缀原样在下一请求（含工具轮 assistant+工具结果）
    const before = payloads.length;
    say(ctx, '再聊一句', 'r2');
    await ctx.supervisor.waitIdle();
    const later = payloads.slice(before);
    assert.ok(later.length >= 1, '续聊发出');
    const laterStr = JSON.stringify(later);
    assert.ok(laterStr.includes('memory_hold') && laterStr.includes('记好了') && laterStr.includes('记一件事'), '历史正本（工具轮/工具结果/旧输入）全量随请求');
    // 场景 C：重复运行幂等——同窗再续一轮，轨迹只追加不改写（append-only 由守卫+断言双证）
    const trajBefore = JSON.stringify(ctx.trajectory.forWindow(win.id)!.messages);
    say(ctx, '第三句', 'r3');
    await ctx.supervisor.waitIdle();
    const trajAfter = JSON.stringify(ctx.trajectory.forWindow(win.id)!.messages);
    assert.ok(trajAfter.startsWith(trajBefore.slice(0, -1)) || trajAfter.includes(trajBefore.slice(1, -1)), '轨迹追加不改写');
    // 场景 D：轨迹续读（恢复视角）——重读 forWindow 后内容与库内一致（进程恢复消费同一正本）
    const reread = JSON.stringify(ctx.trajectory.forWindow(win.id)!.messages);
    assert.equal(reread, trajAfter, '重读一致');
  } finally {
    await ctx.supervisor.stopAll();
    ctx.db.close();
  }
});


test('wire 守卫：新政策下轨迹被篡改丢失继续态 → 下一轮拒发（WIRE_TRAJECTORY_DIVERGED）', async () => {
  const root = tempRoot('r2-guard-');
  let gen = 0;
  let dispatchCount = 0;
  const transport: OrTransport = async (payload) => {
    gen += 1; dispatchCount += 1;
    const hasToolResult = (payload.messages as Array<{ role: string }>).some((m) => m.role === 'tool');
    if (!hasToolResult && gen <= 2) return { status: 200, headers: new Map<string, string>(), body: frameStream(toolRound(`g${gen}`)) };
    if (hasToolResult) return { status: 200, headers: new Map<string, string>(), body: frameStream(finalWithReasoning(`g${gen}`, '记好了')) };
    return { status: 200, headers: new Map<string, string>(), body: frameStream(sse({ id: `g${gen}`, choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE) };
  };
  const ctx = composeSup(root, transport, 'deepseek-flash');
  const t1 = say(ctx, '记一件事', 'r1');
  await ctx.supervisor.waitIdle();
  assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(t1.attemptId) as { state: string }).state, 'completed');
  const win = ctx.windows.activeWindow('c1')!;
  // 篡改：从已落轨迹剥离全部 reasoning_content（模拟 E08 丢失形态）
  const row = ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id) as { messages_json: string };
  const tampered = (JSON.parse(row.messages_json) as Array<Record<string, unknown>>).map((m) => {
    if (m.role === 'assistant' && typeof m.reasoning_content === 'string') { const { reasoning_content: _r, ...rest } = m; return rest; }
    return m;
  });
  ctx.db.prepare('UPDATE window_trajectories SET messages_json = ? WHERE window_id = ?').run(JSON.stringify(tampered), win.id);
  const beforeTamper = dispatchCount;
  const t2 = say(ctx, '再聊一句', 'r2');
  await ctx.supervisor.waitIdle();
  assert.equal(dispatchCount, beforeTamper, '第二回合零派发——wire 守卫在组装期拒发（对比未篡改路径正常完成）');
  const att2 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(t2.attemptId) as { state: string; blocked_reason: string | null };
  const turnsRow = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t2.turnId) as { state: string };
  assert.notEqual(att2.state, 'completed', '轨迹与实发 wire 分歧=本轮不得完成');
  assert.notEqual(turnsRow.state, 'completed', '回合不得标成功');
  // 守卫在信封组装即抛（派发前）——被篡改的第二回合零模型请求；对照未篡改路径（上一测试）
  // 同流程两回合正常完成，行为对照即守卫生效的直接证据
  const dispatchesAfterTamper = dispatchCount;
  assert.ok(dispatchesAfterTamper >= 2, '前提自证：篡改前第一回合已真实派发');
  ctx.db.close();
});
