// 联合审计 2026-10-06 B2 批回归（F-J-09/10/38/39/40/31）：
//  - F-J-09：同窗工具 epoch 冻结——中途词表变化不改变本窗 tools；漂移可被 append-only 断言识别
//  - F-J-10：无轨迹窗手动换窗评审范围=实际装载子集（12k 预算 selected），不含库投影里更旧的消息
//  - F-J-38：retrospective+mood 宿主前置拒（与文案一致）
//  - F-J-40：skipped_empty 凭证携带定位依据（迁移 v14 basis_json）
//  - F-J-31：提醒模板 reason 联合类型含 'manual'
// 假 OR transport + 假 Mariposa（单测层）；零网络零真实模型。
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
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor, validateToolArgs } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { buildPreRotateReviewMessage } from '../../apps/host/src/context/review-prompts.ts';
import { assertAppendOnly } from '../../apps/host/src/runtime/or-payload.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const toolBody = (id: string, callId: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'memory_hold', arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

type PayloadLog = Array<{ tools: unknown; lastUser: string }>;

function compose(root: string, transport: OrTransport, mariposa: MariposaTransport, payloadLog?: PayloadLog) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, windows: { soft_limit_tokens: 21_500 /* 裁定②1024 统一口径实测校准 */ } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  const wrapped: OrTransport = async (payload) => {
    const msgs = payload.messages as Array<{ role: string; content: unknown }>;
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (payloadLog && lastUser && !(typeof lastUser.content === 'object' && Array.isArray((lastUser.content as Array<{ type: string }>) && (lastUser.content as Array<{ type: string }>).some((b) => b.type === 'text' && ((b as { text?: string }).text ?? '').includes('宿主运行事件'))))) {
      payloadLog.push({ tools: payload.tools, lastUser: JSON.stringify(lastUser.content).slice(0, 80) });
    }
    return transport(payload);
  };
  const runner = new DeepSeekRunner({ retryMax: 0 }, wrapped);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, windows, reviews, checkpoint, supervisor };
}

const mariposaOk: MariposaTransport = async (capability, payload) => {
  if (capability === 'memory.hold') {
    return { ok: true, result: { operation_id: payload.operation_id, memory_id: `mem-${Date.now() % 100000}`, version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
  }
  if (capability === 'memory.mood.vocab') {
    return { ok: true, result: { categories: ['开心', '爱', '生气', '吃醋', '悲伤', '渴望', '不安'], version: 'mood-vocab-2' } };
  }
  return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
};

const T0 = '2026-10-04T08:00:00+08:00';

async function say(ctx: ReturnType<typeof compose>, content: string, id: string, at: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: at });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

test('F-J-09：同窗工具 epoch 冻结——turn2 词表刷新（返回含新类）后 turn3 的 tools 仍为 turn1 快照', async () => {
  const payloadLog: PayloadLog = [];
  let vocabCalls = 0;
  const vocabChanging: MariposaTransport = async (capability, payload) => {
    if (capability === 'memory.mood.vocab') {
      vocabCalls++;
      const cats = vocabCalls === 1 ? ['开心', '爱', '生气', '吃醋', '悲伤', '渴望', '不安'] : ['开心', '爱', '生气', '吃醋', '悲伤', '渴望', '不安', '新类'];
      return { ok: true, result: { categories: cats, version: `mood-vocab-${vocabCalls}` } };
    }
    return mariposaOk(capability, payload);
  };
  const root = tempRoot('jab2-tools-');
  let gen = 0;
  const transport: OrTransport = async (payload) => {
    const msgs = payload.messages as Array<{ role: string; content: unknown }>;
    const hasToolResult = msgs.some((m) => m.role === 'tool');
    gen++;
    if (gen === 2) return { status: 200, headers: new Map<string, string>(), body: frameStream(toolBody(`g${gen}`, 'c9', { original_title: '中途记一条', categories: ['daily'], text: 'x', creation_mode: 'contemporaneous', mood_tags: ['开心'] })) };
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`g${gen}`, `回复${gen}`)) };
  };
  const ctx = compose(root, transport, vocabChanging, payloadLog);
  await say(ctx, '第一条', 't1', T0);
  await say(ctx, '第二条要记事', 't2', new Date(Date.parse(T0) + 60_000).toISOString());
  await say(ctx, '第三条', 't3', new Date(Date.parse(T0) + 120_000).toISOString());
  assert.ok(vocabCalls >= 1, '词表确实被拉取过（触发缓存失效）');
  const chatPayloads = payloadLog;
  assert.ok(chatPayloads.length >= 3, `应有≥3 个聊天请求（实际 ${chatPayloads.length}）`);
  const toolsJson1 = JSON.stringify(chatPayloads[0]!.tools);
  const toolsJson3 = JSON.stringify(chatPayloads[chatPayloads.length - 1]!.tools);
  assert.equal(toolsJson3, toolsJson1, '同窗 tools 恒定（epoch 冻结）——修复前 turn3 会用刷新后的枚举（含"新类"）');
  assert.ok(!toolsJson3.includes('新类'), '冻结快照不含中途新增词表项');
  ctx.db.close();
});

test('F-J-09 断言有效性：tools 变化会被 assertAppendOnly 识别（对照）', () => {
  const base = (tools: unknown) => ({ model: 'm/x', messages: [{ role: 'user', content: 'a' }], tools });
  const prev = base([{ type: 'function', function: { name: 'f', parameters: {} } }]);
  const same = base([{ type: 'function', function: { name: 'f', parameters: {} } }]);
  const changed = base([{ type: 'function', function: { name: 'f', parameters: { extra: 1 } } }]);
  assert.ok(assertAppendOnly(prev, same), '同 tools 通过');
  assert.throws(() => assertAppendOnly(prev, changed), /PREFIX_PROFILE_CHANGED:tools/, 'tools 漂移被抓（previousPayload 用冻结快照后该断言在跨轮间有意义）');
});

test('F-J-10（2026-10-08 改写）：无轨迹窗手动换窗——零评审，不猜测或签发范围凭证', async () => {
  const root = tempRoot('jab2-fj10-');
  let gen = 0;
  const transport: OrTransport = async () => { gen++; return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`g${gen}`, `回复${gen}`)) }; };
  const ctx = compose(root, transport, mariposaOk);
  await say(ctx, '第一条', 'f1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  // 模拟"无轨迹窗口"（v11 前旧行/轨迹缺失场景）
  ctx.db.prepare('DELETE FROM window_trajectories').run();
  void win1;
  const r = await ctx.supervisor.manualRotate('c1');
  assert.equal(r.ok, true);
  assert.equal(gen, 1, '手动换窗未发模型请求');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM rotation_reviews').get().n, 0);
  ctx.db.close();
});

test('F-J-40：skipped_empty 凭证携带定位依据（basis_json）', async () => {
  const root = tempRoot('jab2-basis-');
  let gen = 0;
  const transport: OrTransport = async () => {
    gen++;
    if (gen === 2) return { status: 200, headers: new Map<string, string>(), body: frameStream(toolBody(`g${gen}`, 'c5', { original_title: '失败回合的记事', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' })) };
    if (gen === 3) return { status: 500, headers: new Map<string, string>(), body: frameStream(sse({ error: { message: '模拟失败' } })) };
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`g${gen}`, `回复${gen}`)) };
  };
  const ctx = compose(root, transport, mariposaOk);
  const H = 60 * 60 * 1000;
  await say(ctx, '第一条', 'b1', T0);
  await say(ctx, '第二条要记事', 'b2', new Date(Date.parse(T0) + H).toISOString());
  await say(ctx, `第三条长消息容量触发${'内容填充。'.repeat(520)}`, 'b3', new Date(Date.parse(T0) + 8 * H).toISOString()); // 2026-10-08：静默不换窗——软线压低后容量触发
  const row = ctx.db.prepare("SELECT basis_json, status FROM rotation_reviews WHERE status='skipped_empty' LIMIT 1").get() as { basis_json: string | null; status: string } | undefined;
  assert.ok(row, '存在 skipped_empty 凭证');
  const basis = row!.basis_json ? JSON.parse(row!.basis_json) as Record<string, unknown> : null;
  assert.ok(basis, 'basis_json 已落（迁移 v14）');
  assert.equal(basis!.reason, 'capacity', '2026-10-08：静默触发已删——容量触发');
  assert.equal(basis!.bookmark_seen_sequence, 3, '依据含书签高水位');
  // R12（复审 2026-10-07）单一正本：失败回合的**已发输入**有真实派发证据，
  // 计入实际评审输入清单（追赶投影）——高水位含它，引用核对不再 QUOTE_MATCH_FAILED
  assert.equal(basis!.manifest_high_water, 3, '依据含清单高水位（失败回合已发输入入清单）');
  assert.equal(basis!.manifest_entries, 3);
  ctx.db.close();
});

test('F-J-38：retrospective + mood_tags 在宿主预拒（不落服务端）', async () => {
  const calls: unknown[] = [];
  const mariposa: MariposaTransport = async (capability, payload) => {
    if (capability === 'memory.hold') { calls.push(payload); return { ok: true, result: { operation_id: payload.operation_id, memory_id: 'mem-x', version: 1, binding_ids: [], committed_at: new Date().toISOString() } }; }
    if (capability === 'memory.mood.vocab') return { ok: true, result: { categories: ['开心', '爱', '生气', '吃醋', '悲伤', '渴望', '不安'], version: 'mood-vocab-2' } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const root = tempRoot('jab2-retro-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const reviews = new RotationReviewService(db);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews, checkpoint: new HoldCheckpointService(db) });
  const out = await tools.execute('memory_hold', { __tool_call_id: 'c38', original_title: '补记心情', categories: ['daily'], text: 'x', creation_mode: 'retrospective', memory_date: '2026-09-01', mood_tags: ['开心'] }, { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r38' });
  assert.equal(out.ok, false, '补记+当时心情=整单拒');
  assert.equal(out.output.error_code, 'HOLD_MOOD_WINDOW_REQUIRED');
  assert.equal(calls.length, 0, '未发远端（宿主前置拦截省一次调用）');
  db.close();
});

test('F-J-31：提醒模板仅接受 capacity（手动换窗无评审模板）', () => {
  const text = buildPreRotateReviewMessage({ reviewId: 'rev-x', reason: 'capacity', messageRefs: '' });
  assert.ok(text.includes('reason: capacity'));
  assert.ok(!text.includes('reason: manual'));
});
