// WP4 回归：缓存断点规划（A/G，B 待 bootstrap）+ 跨轮 append-only 轨迹持久化。假 transport，零网络。
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
import { planBoundaries, tailBoundaryOf } from '../../apps/host/src/runtime/cache-plan.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

function recordingTransport(log: Array<Record<string, unknown>>, failChatWith?: string) {
  let gen = 0;
  const transport: OrTransport = async () => {
    gen++;
    if (failChatWith && gen === 2) {
      // 第二次聊天请求：500（不重试的错误）——失败回合不落轨迹
      return { status: 500, headers: new Map<string, string>(), body: frameStream('') };
    }
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`g${gen}`, `回复${gen}`)) };
  };
  void log;
  return transport;
}

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
  const tools = new HostToolExecutor({ mariposa: new MariposaClient({ transport: async () => ({ ok: true, result: {} }) }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, orTransport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, windows, trajectory, supervisor };
}

async function say(ctx: ReturnType<typeof compose>, content: string, id: string, at: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: at });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

const T = (h: number) => new Date(Date.parse('2026-10-01T08:00:00+08:00') + h * 3600e3).toISOString();

test('planBoundaries：A 恒在 system 末块；G 仅在仍有效时；B 预留；≤3', () => {
  const sys: OrMessage = { role: 'system', content: [{ type: 'text', text: '固定前缀' }] };
  const u1: OrMessage = { role: 'user', content: [{ type: 'text', text: '问' }] };
  const a1: OrMessage = { role: 'assistant', content: [{ type: 'text', text: '答' }] };
  const p1 = planBoundaries({ messages: [sys, u1], systemMessageCount: 1, prevBoundary: null });
  assert.deepEqual(p1.boundaries, [{ messageIndex: 0, contentIndex: 0 }], '首轮只有 A');
  const p2 = planBoundaries({ messages: [sys, u1, a1, { role: 'user', content: [{ type: 'text', text: '新问' }] }], systemMessageCount: 1, prevBoundary: tailBoundaryOf([sys, u1, a1]) });
  assert.deepEqual(p2.boundaries, [{ messageIndex: 0, contentIndex: 0 }, { messageIndex: 2, contentIndex: 0 }], 'A + G（上轮末 assistant 块）');
  // G 指向的块已变化（前插消息导致位移）→ 丢弃并如实标记
  const p3 = planBoundaries({ messages: [sys, { role: 'user', content: [{ type: 'text', text: 'x' }] }, a1], systemMessageCount: 1, prevBoundary: { messageIndex: 2, contentIndex: 0 } });
  assert.ok(p3.boundaries.some((b) => b.messageIndex === 2 && b.contentIndex === 0), '位移后仍指向真实 text 块则保留（内容指纹由 payload 层把守）');
  const p4 = planBoundaries({ messages: [sys], systemMessageCount: 1, prevBoundary: { messageIndex: 5, contentIndex: 0 } });
  assert.equal(p4.gDropped, true, '越界 G 如实丢弃（保护未覆盖，不猜近似位置）');
});

test('跨轮轨迹：append-only + G 断点入 payload + 失败回合不落轨迹', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async (payload) => {
    payloads.push(structuredClone(payload));
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`g${payloads.length}`, `回复${payloads.length}`)) };
  };
  const root = tempRoot('orcache1-');
  const ctx = compose(root, transport);
  await say(ctx, '第一句', 't1', T(0));
  const win = ctx.windows.activeWindow('c1')!;
  const traj1 = ctx.trajectory.forWindow(win.id)!;
  assert.equal(traj1.messages.length, 3, '轨迹=system+user1+assistant1');
  assert.equal(traj1.messages[2]!.role, 'assistant');
  // F18（审计整改）：G 候选=本轮实际发送的最后一个 text 块=用户输入（index 1）；
  // 最终 assistant 回复尚未随任何请求发送，不得作为已发送边界
  assert.deepEqual(traj1.lastBoundary, { messageIndex: 1, contentIndex: 0 }, '新已发送边界=实际发送末块（用户输入）');
  // 首轮 payload：A 断点（system 块带 1h cache_control），无 G
  const p1msgs = payloads[0]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(p1msgs[0]!.content[0]!.cache_control, { type: 'ephemeral', ttl: '1h' }, 'A：system 末块 1h');
  assert.equal(p1msgs[2] === undefined || (p1msgs[2]!.content[0]!.cache_control === undefined), true, '首轮无 G');

  await say(ctx, '第二句', 't2', T(1));
  const traj2 = ctx.trajectory.forWindow(win.id)!;
  assert.equal(traj2.messages.length, 5, '第二轮后：+user2+assistant2（append-only）');
  assert.deepEqual(traj2.messages.slice(0, 3).map((m) => m.role), traj1.messages.map((m) => m.role), '旧轨迹前缀不变');
  const p2msgs = payloads[1]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(p2msgs[0]!.content[0]!.cache_control, { type: 'ephemeral', ttl: '1h' }, 'A 保持');
  assert.deepEqual(p2msgs[1]!.content[0]!.cache_control, { type: 'ephemeral', ttl: '1h' }, 'G：上轮实际发送末块（用户输入）1h（保护已发送边界）');
  const explicit = JSON.stringify(p2msgs).match(/"cache_control"/g)?.length ?? 0;
  assert.equal(explicit, 2, '显式断点恰 2 个（A+G）；顶层自动点另算（§7.2 合计 ≤4）');
  assert.equal((payloads[1] as { session_id: string }).session_id, (payloads[0] as { session_id: string }).session_id);
  ctx.db.close();
});

test('失败回合：轨迹保持不变（成功才推进，§2.2）', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  let call = 0;
  const transport: OrTransport = async (payload) => {
    call++;
    payloads.push(structuredClone(payload));
    if (call === 2) return { status: 500, headers: new Map<string, string>(), body: frameStream('') };
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`g${call}`, '好的')) };
  };
  const root = tempRoot('orcache2-');
  const ctx = compose(root, transport);
  await say(ctx, '正常轮', 'f1', T(0));
  const win = ctx.windows.activeWindow('c1')!;
  const before = ctx.trajectory.forWindow(win.id)!.messages;
  const sub2 = await say(ctx, '会失败的轮', 'f2', T(1));
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub2.attemptId) as { state: string };
  assert.equal(att.state, 'failed');
  assert.deepEqual(ctx.trajectory.forWindow(win.id)!.messages, before, '失败不落轨迹（provider_requests 仍留实际发送审计）');
  ctx.db.close();
});
