// WP-07（run-160858）：选集/换窗状态机家族——JFA-009/C-020 + C-013/CX-07 +
// C-015/CX-09 + C-014/CX-08。基线红样：Codex browser 证据
// model-switch-results.json（切模型死锁）与 C-013 追赶注回旧原文。
//  - T1（CX-07）：明确空选换窗后新窗 payload 不含旧原文；同窗失败回合
//    追赶对照仍工作（窗口归属约束只拦跨窗，不误伤同窗）。
//  - T2（CX-09）：rotate ok 即初始轨迹已在切换事务内存在；bootstrap
//    获取失败 → 旧窗 ACTIVE、选集不被消费。
//  - T3（CX-07 咬合）：无轨迹 fallback 携带选集装配，不出现全量
//    dialogue 路径。
//  - T4（CX-10/C-020）：切模型（指纹失活）→ blocked → awaiting 落行 →
//    confirm 空选 → 原输入恢复一次（service 级；浏览器批次后补）。
//  - T5（CX-08）：confirmed 再确认——同键 200 幂等重放；异键结构化
//    CONTEXT_SELECTION_ALREADY_CONFIRMED；任何路径不 500。
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
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const enc = new TextEncoder();
const MODEL = 'deepseek-chat';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

function dsTransport(seen: Array<Record<string, unknown>>, failOnce = false): OrTransport & { fails: { left: number } } {
  const state = { left: failOnce ? 1 : 0 };
  let gen = 0;
  const t: OrTransport & { fails: { left: number } } = async (payload) => {
    if (state.left > 0) {
      state.left -= 1;
      return { status: 500, headers: new Map<string, string>(), body: frameStream('') };
    }
    seen.push(payload as Record<string, unknown>);
    gen++;
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`gen-wp7-${gen}`, '好的')) };
  };
  t.fails = state;
  return t;
}

const T0 = '2026-10-01T08:00:00+08:00';
const T1 = '2026-10-01T09:00:00+08:00';

function compose(root: string, transport: OrTransport, mariposa: MariposaTransport | null = null, configOver: Record<string, unknown> = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' },
    deepseek: { model: MODEL },
    reminders: { enabled: false },
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
  const selections = new ManualSelectionService(db);
  const trajectory = new WindowTrajectoryService(db);
  // WP-07：WindowManager 接线 trajectory（初始轨迹写切换事务）
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config, selections, trajectory);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const mc = mariposa ? new MariposaClient({ transport: mariposa }) : null;
  const mariposa_wire_1 = mc ?? new MariposaClient({ transport: async () => ({ ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 }) });
  const { tools: tools } = assembleTestTools({ db: db, mariposa: mariposa_wire_1, reviews: reviews, checkpoint: checkpoint });;
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({bootstrap: mariposa_wire_1, // S18：显式 BootstrapPort
     db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory, selections });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, selections, trajectory };
}

/** WP-07 T2：trajectory 服务可注入（模拟切换事务内写失败）。 */
function compose2(root: string, transport: OrTransport, TrajClass: new (db: ReturnType<typeof openDatabase>) => WindowTrajectoryService, configOver: Record<string, unknown> = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' },
    deepseek: { model: MODEL },
    reminders: { enabled: false },
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
  const selections = new ManualSelectionService(db);
  const trajectory = new TrajClass(db);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config, selections, trajectory);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const mariposa_wire_2 = new MariposaClient({ transport: async () => ({ ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 }) });
  const { tools: tools } = assembleTestTools({ db: db, mariposa: mariposa_wire_2, reviews: reviews, checkpoint: checkpoint });;
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({bootstrap: mariposa_wire_2, // S18：显式 BootstrapPort
     db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory, selections });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, selections, trajectory };
}

async function say(ctx: ReturnType<typeof compose>, content: string, clientMsgId: string, occurredAt: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: clientMsgId, occurredAt });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

function payloadTexts(payload: Record<string, unknown>): string {
  return JSON.stringify((payload as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? []);
}

test('T1：明确空选换窗后新窗 payload 不含旧原文；同窗失败回合追赶对照仍工作', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const root = tempRoot('wp7-t1-');
  const transport = dsTransport(seen);
  const ctx = compose(root, transport, null, { windows: { soft_limit_tokens: 21_500 /* 裁定②1024 统一口径实测校准 */ /* 2026-10-17 输出协议行；1024 裁定②+目录底座，相对位不变 */ } });
  // 先建窗（空房首条自动建窗）
  const s1 = await say(ctx, '旧窗的第一句话', 'm1', T0);
  assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(s1.attemptId) as { state: string }).state, 'completed');
  // 同窗失败回合对照：下一次发送 500（已真实发出），再成功——失败回合
  // 输入经追赶进入同窗后续请求（窗口归属约束不误伤同窗追赶）
  transport.fails.left = 1;
  const s0 = await say(ctx, '失败回合的追赶canary输入', 'm0', T0);
  const att0 = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(s0.attemptId) as { state: string };
  assert.equal(att0.state, 'failed', '对照前置：该轮 500 失败');
  const sR = await say(ctx, '重试成功轮', 'mR', T0);
  assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sR.attemptId) as { state: string }).state, 'completed');
  const catchupSeen = seen.some((p) => payloadTexts(p).includes('追赶canary'));
  assert.ok(catchupSeen, '同窗失败回合的已发输入经追赶进入后续请求（对照不回归）');
  const win1 = ctx.windows.activeWindow('c1')!;
  // 容量触发换窗：长输入越软线 → awaiting → 明确空选确认 → 新窗恢复
  const longInput = `很长的新输入，用于越过软线触发换窗。${'内容填充。'.repeat(520) /* 2026-10-21 time_context 人话化再瘦——重标定 */}`;
  const s2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: longInput, clientMessageId: 'm2', occurredAt: T1 });
  ctx.supervisor.enqueue(s2.turnId);
  await ctx.supervisor.waitIdle();
  const att2 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(s2.attemptId) as { state: string; blocked_reason: string };
  assert.ok(att2.blocked_reason?.startsWith('CONTEXT_SELECTION_REQUIRED'), `换窗需选集确认（实际=${att2.blocked_reason ?? att2.state}）`);
  const awaiting = ctx.selections.awaitingFor('c1')!;
  const confirm = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: awaiting.source_window_id, items: [], explicitEmpty: true, idempotencyKey: 'wp7-t1' });
  assert.equal(confirm.ok, true, JSON.stringify(confirm));
  await ctx.supervisor.waitIdle();
  const win2 = ctx.windows.activeWindow('c1')!;
  assert.notEqual(win2.id, win1.id, '已换窗');
  // 核心断言：新窗恢复轮的 payload 不含未选旧原文（恢复轮=确认后的最后一次请求）
  const rotateIdx = seen.findIndex((p) => payloadTexts(p).includes('用于越过软线'));
  assert.ok(rotateIdx >= 0, '新窗恢复轮已发出');
  for (let i = rotateIdx; i < seen.length; i++) {
    const t = payloadTexts(seen[i]!);
    assert.ok(!t.includes('追赶canary'), '新窗请求不得含未选旧原文（空选）');
    assert.ok(!t.includes('重试成功轮'), '新窗请求不得含未选旧原文（对照消息）');
  }
  // 轨迹同样干净：新窗初始轨迹按空选装配
  const traj = ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win2.id) as { messages_json: string };
  assert.ok(traj, 'T2 前置：新窗初始轨迹已在切换事务内存在');
  assert.ok(!traj.messages_json.includes('追赶canary'), '新窗轨迹不含未选旧原文');
  ctx.db.close();
});

test('T2：切换事务内初始轨迹写入失败→整体回滚（旧窗 ACTIVE+选集不消费）', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const root = tempRoot('wp7-t2-');
  // 注入：初始轨迹写入抛（模拟切换事务内三写一败——选集消费+指针+轨迹
  // 必须整体回滚）。注：bootstrap 传输失败按 D2 裁定=无 B 降级不阻塞，
  // 不属于本测的失败语义（那是降级不是失败）
  class BoomTrajectory extends WindowTrajectoryService {
    initInTx(): never {
      throw new Error('wp7-trajectory-write-boom');
    }
  }
  const ctx = compose2(root, dsTransport(seen), BoomTrajectory, { windows: { soft_limit_tokens: 21_500 /* 裁定②1024 统一口径实测校准 */ /* 2026-10-17 输出协议行；1024 裁定②+目录底座，相对位不变 */ } });
  await say(ctx, '第一条消息', 'm1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  const longInput = `触发换窗的长输入。${'内容填充。'.repeat(520) /* 2026-10-21 time_context 人话化再瘦——重标定 */}`;
  const s2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: longInput, clientMessageId: 'm2', occurredAt: T1 });
  ctx.supervisor.enqueue(s2.turnId);
  await ctx.supervisor.waitIdle();
  const att2 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(s2.attemptId) as { state: string; blocked_reason: string };
  assert.ok(att2.blocked_reason?.startsWith('CONTEXT_SELECTION_REQUIRED'), `前置阻断（实际=${att2.blocked_reason ?? att2.state}）`);
  const awaiting = ctx.selections.awaitingFor('c1')!;
  // 确认走 supervisor 真实入口：confirm 落库 + 恢复（建窗/换窗）——
  // bootstrap 获取异常 → 恢复失败如实返回，但不消费选集、旧窗 ACTIVE
  const confirm = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: awaiting.source_window_id, items: [], explicitEmpty: true, idempotencyKey: 'wp7-t2' });
  assert.equal(confirm.ok, false, 'bootstrap 获取失败 → 恢复失败如实返回（RESUME_FAILED）');
  assert.equal((confirm as { error?: { code?: string } }).error?.code, 'CONTEXT_SELECTION_RESUME_FAILED');
  // 旧窗仍 ACTIVE、选集未被消费（仍是 confirmed，可重试恢复）
  assert.equal(ctx.windows.activeWindow('c1')!.id, win1.id, '旧窗保持 ACTIVE');
  const selRow = ctx.selections.awaitingFor('c1');
  assert.equal(selRow, null, 'awaiting 已转 confirmed（不再处于待选态）');
  const confirmedRow = ctx.db.prepare("SELECT status FROM context_selections WHERE idempotency_key = 'wp7-t2'").get() as { status: string };
  assert.equal(confirmedRow.status, 'confirmed', '选集已确认但未被消费（bootstrap 失败不回滚确认，可重试恢复）');
  ctx.db.close();
});

test('T2b：正常换窗成功返回时初始轨迹已存在（无需下一轮懒初始化）', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const root = tempRoot('wp7-t2b-');
  const ctx = compose(root, dsTransport(seen), null, { windows: { soft_limit_tokens: 21_500 /* 裁定②1024 统一口径实测校准 */ /* 2026-10-17 输出协议行；1024 裁定②+目录底座，相对位不变 */ } });
  await say(ctx, '旧窗原话', 'm1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  const longInput = `触发换窗的长输入。${'内容填充。'.repeat(520) /* 2026-10-21 time_context 人话化再瘦——重标定 */}`;
  const s2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: longInput, clientMessageId: 'm2', occurredAt: T1 });
  ctx.supervisor.enqueue(s2.turnId);
  await ctx.supervisor.waitIdle();
  const awaiting = ctx.selections.awaitingFor('c1')!;
  const confirm = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: awaiting.source_window_id, items: [], explicitEmpty: true, idempotencyKey: 'wp7-t2b' });
  assert.equal(confirm.ok, true, JSON.stringify(confirm));
  await ctx.supervisor.waitIdle();
  const win2 = ctx.windows.activeWindow('c1')!;
  assert.notEqual(win2.id, win1.id);
  const traj = ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win2.id) as { messages_json: string } | undefined;
  assert.ok(traj, 'rotate ok 后初始轨迹已在切换事务内存在（CX-09 核心断言）');
  assert.ok(!traj!.messages_json.includes('旧窗原话'), '空选新窗轨迹不带历史');
  ctx.db.close();
});

test('T3：无轨迹 fallback 携带选集装配（无全量 dialogue 路径）', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const root = tempRoot('wp7-t3-');
  const ctx = compose(root, dsTransport(seen));
  // 存量历史 + 首窗（首条消息建窗）——首轮后人为删除轨迹模拟「无轨迹
  // fallback」，再发一条：首信封=空选（无选集）+当前输入，不得出现
  // dialogueUpTo 全量装配（存量历史绝不回流）
  const s1 = await say(ctx, '首窗消息', 'm1', T0);
  void s1;
  const win = ctx.windows.activeWindow('c1')!;
  // 存量历史在窗建立后种行（模拟更早已归档的原文；不触发建窗门）
  const histSeq = (ctx.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM messages WHERE conversation_id = ?').get('c1') as { n: number }).n;
  ctx.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('hist-t3','c1',?,'owner','text',1,?,?)").run(histSeq, T0, T0);
  ctx.db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('hist-t3',1,'text','存量历史正文canary',? ,?,?,'seed')").run(sha256Hex('存量历史正文canary'), T0, T0);
  ctx.db.prepare('DELETE FROM window_trajectories WHERE window_id = ?').run(win.id);
  const s2 = await say(ctx, 'fallback 轮的输入', 'm2', T1);
  void s2;
  const last = seen[seen.length - 1]!;
  const t = payloadTexts(last);
  assert.ok(t.includes('fallback 轮的输入'), '当前输入在首信封');
  assert.ok(!t.includes('存量历史正文canary'), '无选集时不得全量装配存量历史（dialogue 路径已杜绝）');
  ctx.db.close();
});

test('T4：切模型→blocked→awaiting 落行→confirm 空选→原输入恢复一次', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const root = tempRoot('wp7-t4-');
  const ctx = compose(root, dsTransport(seen));
  await say(ctx, '换模型前的原话', 'm1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  // 模拟切模型后指纹失活（等效 runtime_settings 改 or_model →
  // fingerprintConfigView 与旧窗指纹不一致）
  ctx.db.prepare("UPDATE windows SET context_fingerprint = 'stale-by-model-change' WHERE id = ?").run(win1.id);
  const s2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '切模型后的新输入', clientMessageId: 'm2', occurredAt: T1 });
  ctx.supervisor.enqueue(s2.turnId);
  await ctx.supervisor.waitIdle();
  const att2 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(s2.attemptId) as { state: string; blocked_reason: string };
  assert.equal(att2.state, 'blocked');
  assert.ok(att2.blocked_reason.startsWith('CONTEXT_ROTATION_REQUIRED'), `blocked_reason=${att2.blocked_reason.slice(0, 60)}`);
  // awaiting 落行（哨兵源）——不再是无出口的裸 blocked
  const awaiting = ctx.selections.awaitingFor('c1')!;
  assert.ok(awaiting, '切模型阻断落 awaiting 选集行');
  assert.equal(awaiting.source_window_id, 'csel-src-model-change');
  // UI 确认入口（preview/confirm 以 awaiting.source_window_id 为目标）
  const pre = ctx.supervisor.selectionPreview('c1', awaiting.source_window_id, []);
  assert.equal(pre.ok, true, JSON.stringify(pre));
  const confirm = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: awaiting.source_window_id, items: [], explicitEmpty: true, idempotencyKey: 'wp7-t4' });
  assert.equal(confirm.ok, true, JSON.stringify(confirm));
  const conf = confirm as unknown as { rotated: boolean; resumed: number };
  assert.equal(conf.resumed, 1, '原输入恢复一次');
  await ctx.supervisor.waitIdle();
  const turn2 = ctx.db.prepare('SELECT state, input_message_id FROM turns WHERE id = ?').get(s2.turnId) as { state: string; input_message_id: string };
  assert.equal(turn2.state, 'completed', '原输入在新窗完成');
  assert.equal(turn2.input_message_id, s2.message.id, '原输入身份不变');
  // 只发一次：payload 中该输入文本恰出现一次（新窗请求）
  const hits = seen.filter((p) => payloadTexts(p).includes('切模型后的新输入'));
  assert.equal(hits.length, 1, '原输入只发一次（不重复 submit）');
  ctx.db.close();
});

test('T5：confirmed 再确认——同键幂等重放；异键结构化冲突；无 500', async () => {
  const root = tempRoot('wp7-t5-');
  const ctx = compose(root, dsTransport([]));
  void ctx;
  const root2 = tempRoot('wp7-t5b-');
  writeApprovedIdentity(root2);
  const db = openDatabase(path.join(root2, 'data'));
  migrate(db, sha256Hex);
  const svc = new ManualSelectionService(db);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private','2026-01-01T00:00:00Z')").run();
  const est = { charsPerToken: 1.5, systemChars: 0, tailInputChars: 0 };
  const args = { conversationId: 'c1', sourceWindowId: 'csel-src-t5', expectedWindowRevision: 0, items: [] as Array<{ message_id: string }>, explicitEmpty: true, cutoffSequence: 5, estimate: est, capacityBoundTokens: 1000 };
  const a = svc.confirm({ ...args, idempotencyKey: 'wp7-t5-key' });
  assert.equal(a.ok, true, JSON.stringify(a));
  // 同键重放 → 200 幂等（同一 selection_id，不二次应用）
  const b = svc.confirm({ ...args, idempotencyKey: 'wp7-t5-key' });
  assert.equal(b.ok, true);
  assert.equal((b as { selection: { selection_id: string } }).selection.selection_id,
    (a as { selection: { selection_id: string } }).selection.selection_id, '幂等重放返回同一结果');
  // 异键再确认 → 结构化冲突（不 null、不重建、不改旧行）
  const c = svc.confirm({ ...args, idempotencyKey: 'wp7-t5-other' });
  assert.equal(c.ok, false);
  const err = (c as { error: { code: string; selection_id: string; status: string } }).error;
  assert.equal(err.code, 'CONTEXT_SELECTION_ALREADY_CONFIRMED');
  assert.equal(err.status, 'confirmed');
  assert.equal(err.selection_id, (a as { selection: { selection_id: string } }).selection.selection_id);
  // 幂等键未被第二次提交覆盖（旧行的 idempotency_key 仍是首键）
  const row = db.prepare('SELECT idempotency_key FROM context_selections WHERE selection_id = ?').get(err.selection_id) as { idempotency_key: string };
  assert.equal(row.idempotency_key, 'wp7-t5-key', '冲突路径不改动既有方案');
  db.close();
});


test('RRA-016/WP07-T2 拆分：bootstrap 503=明确未取得资料且不阻塞换窗（D2 语义，区别于轨迹写失败回滚）', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const root = tempRoot('wp7-t2c-');
  // bootstrap 持续 503（传输故障→windowBootstrap 返回资料未取得标记）
  const slow503: MariposaTransport = async (cap) => {
    if (cap === 'bootstrap.get') return { ok: false, code: 'HTTP_503', httpStatus: 503 };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const ctx = compose(root, dsTransport(seen), slow503, { windows: { soft_limit_tokens: 21_500 /* 裁定②1024 统一口径实测校准 */ /* 2026-10-17 输出协议行；1024 裁定②+目录底座，相对位不变 */ } });
  await say(ctx, '第一条消息', 'm1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  const longInput = `触发换窗的长输入。${'内容填充。'.repeat(520) /* 2026-10-21 time_context 人话化再瘦——重标定 */}`;
  const s2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: longInput, clientMessageId: 'm2', occurredAt: T1 });
  ctx.supervisor.enqueue(s2.turnId);
  await ctx.supervisor.waitIdle();
  const awaiting = ctx.selections.awaitingFor('c1')!;
  const confirm = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: awaiting.source_window_id, items: [], explicitEmpty: true, idempotencyKey: 'wp7-t2c' });
  // D2 裁定（2026-10-06）：bootstrap 传输失败=无 B 降级，不阻塞消息/
  // 换窗——与轨迹写失败（initInTx 抛→整体回滚保旧窗）是两种不同失败
  assert.equal(confirm.ok, true, JSON.stringify(confirm).slice(0, 200));
  await ctx.supervisor.waitIdle();
  const win2 = ctx.windows.activeWindow('c1')!;
  assert.notEqual(win2.id, win1.id, '无 B 降级下换窗照常完成');
  const turn2 = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(s2.turnId) as { state: string };
  assert.equal(turn2.state, 'completed', '恢复轮在新窗完成（B 缺席如实，不伪造已载）');
  ctx.db.close();
});

test('RRA-006（回访 run-035424）：分节正文续取被消费或如实披露（不再静默把首节当全文）', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const full = 'EVENT_CANARY-' + '甲'.repeat(4000);
  // M 服务端分节形状（4013 字事件 → 首节 2000 + event_text_next）
  const packet = {
    snapshot_id: 'snap_rra006_e',
    memory_days: { items: [{
      memory_id: 'mem_rra006', memory_date: '2026-10-09',
      original_title: 'synthetic', event_text: full.slice(0, 2000),
      event_text_truncated: true, event_text_total_chars: full.length,
      event_text_next: { memory_id: 'mem_rra006', field: 'event_text', offset: 2000 },
    }] },
    plans: { items: [] },
  };
  // 场景一：续取失败（如 schema 拒绝/传输错）→ E 必须调过 bootstrap.next
  // 且向模型披露 event_text_next（不静默截断）
  let nextCalls = 0;
  const failing: MariposaTransport = async (cap, args) => {
    if (cap === 'bootstrap.get' && args.loaded_snapshot_id) return { ok: true, result: { unchanged: true, snapshot_id: args.loaded_snapshot_id, profile: 'estomago' } };
    if (cap === 'bootstrap.get') return { ok: true, result: packet };
    if (cap === 'bootstrap.next') { nextCalls++; return { ok: false, code: 'SCHEMA_VIOLATION', httpStatus: 422 }; }
    return { ok: false, code: 'X', httpStatus: 404 };
  };
  const c1 = compose(tempRoot('wp7-rra006a-'), dsTransport(seen), failing);
  try {
    const r1 = await say(c1, 'read current input', 'a', T0);
    assert.equal(c1.db.prepare('SELECT state FROM turns WHERE id=?').get(r1.turnId).state, 'completed');
    const text1 = payloadTexts(seen.at(-1)!);
    assert.ok(nextCalls > 0, '失败景也必须真实发起过续取调用（bootstrap.next）');
    assert.ok(text1.includes('event_text_next'),
      '续取失败时必须向模型披露 event_text_next（不只调过）');
    // 场景二：续取可用 → 全文进模型 payload（无截断标记）
    let offset = 2000;
    const okNext: MariposaTransport = async (cap) => {
      if (cap === 'bootstrap.get') return { ok: true, result: packet };
      if (cap === 'bootstrap.next') {
        nextCalls++;
        const chunk = full.slice(offset, Math.min(full.length, offset + 2000));
        offset += 2000;
        return { ok: true, result: { snapshot_id: packet.snapshot_id, content_role: 'bootstrap_memory_package', instruction_authority: 'none', section: 'memory_item', memory_id: 'mem_rra006', field: 'event_text', content: chunk, offset: offset - 2000, total_chars: full.length, next_cursor: offset < full.length ? { memory_id: 'mem_rra006', field: 'event_text', offset } : null } };
      }
      return { ok: false, code: 'X', httpStatus: 404 };
    };
    const c2 = compose(tempRoot('wp7-rra006b-'), dsTransport(seen), okNext);
    const r2 = await say(c2, 'read full input', 'b', T0);
    assert.equal(c2.db.prepare('SELECT state FROM turns WHERE id=?').get(r2.turnId).state, 'completed');
    const text2 = payloadTexts(seen.at(-1)!);
    assert.ok(text2.includes(full), '续取可用时全文进入模型 payload（4013 字非前 2000）');
  } finally {
    c1.db.close();
  }
});
