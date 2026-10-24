// ESTOMAGO_CHAT_EXEC_V1 · WP4 收尾 + WAKE_KEEPWARM_V1（2026-10-22 改写）：
// 后台模型回路执行器整链（04/05/06 §2/§4；K-01/K-12/K-13、C-01/C-02/C-07、B-01/B-10 面）。
// 2026-10-22 改写：保温零工具封锁（CW-13）与 128 输出封锁退役——心跳=完整回合；
// PURE_ACK/SUBSTANTIVE 分流；心跳维护回执经活动投影 CAS；执行走会话串行链。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex, genId } from '../../apps/host/src/util/id.ts';
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
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

function compose(root: string, transport: OrTransport, nowRef: { nowMs: number }, sleepEnabled = false, retryMax = 0) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: MODEL }, background: { keepwarm: { sleep_window: { enabled: sleepEnabled } } } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const activity = new ConversationActivityService(db);
  const messages = new MessageService(db, null, activity);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const alerts = new SystemAlertService(db, events);
  const media = new MediaService(db, paths.mediaDir, config);
  const trajectory = new WindowTrajectoryService(db);
  const selections = new ManualSelectionService(db);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax }, transport);
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), archiveSync: null, media, messages });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db, alerts), routing, windows, logger, alerts, media, trajectory, selections, tools, activity, now: () => nowRef.nowMs });
  messages.ensureConversation('c1');
  const bgSettings = new BackgroundSettingsService(db, config);
  return { root, db, config, messages, supervisor, alerts, media, tools, bgSettings, trajectory, windows, activity };
}

const chatBody = (text: string) => sse({ id: `gen-${text.length}`, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.002 } }) + DONE;

const toolCallBody = (calls: Array<{ id: string; name: string; args: string }>, usage = { prompt_tokens: 500, completion_tokens: 10, cost: 0.001 }) =>
  sse({ id: `gen-tc-${calls[0]!.id}`, choices: [{ delta: { tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } }] })
  + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + DONE;

/** 将真实本地测试轨迹的活动/缓存证据对齐到虚拟睡前时间；无网络。 */
function readySleepBoundaryRun(ctx: ReturnType<typeof compose>, nowRef: { nowMs: number }) {
  setPrice(ctx.db);
  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  const iso = new Date(nowRef.nowMs).toISOString();
  const before = new Date(nowRef.nowMs - 3_000_001).toISOString();
  ctx.db.prepare("UPDATE conversation_activity SET last_real_activity_at = ?, maintenance_request_id = NULL WHERE conversation_id = 'c1'").run(before);
  // 当前唯一请求是 seed chat。
  ctx.db.prepare('UPDATE provider_requests SET dispatch_started_at = ?').run(before);
  ctx.db.prepare("INSERT INTO background_tasks(id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,next_due_at,timezone,payload_json,created_by_actor_id,origin,created_at,updated_at) VALUES ('sleep-task','c1','jiaming','keepwarm',1,1,'cache_idle',?,'Asia/Shanghai','{}','system','system_keepwarm',?,?)").run(iso, iso, iso);
  ctx.db.prepare("INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at) VALUES ('sleep-run','sleep-task','c1','jiaming','keepwarm',1,'sleep-boundary','running',?,?)").run(iso, iso);
  const scheduler = wireExecutor(ctx, nowRef);
  const run = () => ctx.supervisor.runBackgroundTurn({ kind: 'keepwarm', runId: 'sleep-run', conversationId: 'c1', payload: {}, isCancelRequested: () => false, registerAbort: () => {}, maxModelRequests: 4, recordDispatch: (info) => scheduler.recordDispatchStart({ runId: 'sleep-run', ...info, capabilityName: null }) });
  return { scheduler, run };
}

test('睡眠执行位复核：22:59 排队、23:00 获锁，零 provider/dispatch/turn 新增', async (t) => {
  const nowRef = { nowMs: Date.parse('2026-10-23T22:59:59+08:00') };
  let requests = 0;
  const ctx = compose(tempRoot('wp4-sleep-queue-'), async () => { requests++; return { status: 200, headers: new Map(), body: Readable.from([enc.encode(chatBody('收到'))]) }; }, nowRef, true);
  t.after(() => ctx.db.close());
  await seedChatTurn(ctx, 'sleep-queue');
  const { scheduler, run } = readySleepBoundaryRun(ctx, nowRef);
  t.after(() => scheduler.stop());
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const blocking = ctx.supervisor.enqueueBackground('c1', async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await enteredPromise;
  const queued = ctx.supervisor.enqueueBackground('c1', run);
  nowRef.nowMs = Date.parse('2026-10-23T23:00:00+08:00');
  release();
  await blocking;
  assert.deepEqual(await queued, { outcome: 'noop', result_code: 'KEEPWARM_SLEEP_WINDOW', detail: '睡眠时段暂停心跳——排队任务零派发' });
  assert.equal(requests, 1, '只有测试 seed 聊天请求');
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM background_dispatches').get() as { n: number }).n, 0);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM turns').get() as { n: number }).n, 1);
});

test('睡眠重试边界：首发429后跨23:00，重试不传输且元数据保留睡眠原因', async (t) => {
  const nowRef = { nowMs: Date.parse('2026-10-23T22:59:59+08:00') };
  let heartbeatRequests = 0;
  const ctx = compose(tempRoot('wp4-sleep-retry-'), async (payload) => {
    if (JSON.stringify(payload).includes('Cache keepalive')) {
      heartbeatRequests++;
      nowRef.nowMs = Date.parse('2026-10-23T23:00:00+08:00');
      return { status: 429, headers: new Map([['retry-after', '0']]), body: Readable.from([]) };
    }
    return { status: 200, headers: new Map(), body: Readable.from([enc.encode(chatBody('收到'))]) };
  }, nowRef, true, 1);
  t.after(() => ctx.db.close());
  await seedChatTurn(ctx, 'sleep-retry');
  const { scheduler, run } = readySleepBoundaryRun(ctx, nowRef);
  t.after(() => scheduler.stop());
  const result = await ctx.supervisor.enqueueBackground('c1', run);
  assert.equal(result.result_code, 'KEEPWARM_SLEEP_WINDOW');
  assert.equal(heartbeatRequests, 1, '睡眠后零重试');
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM background_dispatches').get() as { n: number }).n, 1, '保留睡前尝试，睡后无新增预占');
});

test('睡眠工具边界：模型睡前已发，回包时23:00，零工具执行与后续模型请求', async (t) => {
  const nowRef = { nowMs: Date.parse('2026-10-23T22:59:59+08:00') };
  let heartbeatRequests = 0;
  const ctx = compose(tempRoot('wp4-sleep-tool-'), async (payload) => {
    if (JSON.stringify(payload).includes('Cache keepalive')) {
      heartbeatRequests++;
      nowRef.nowMs = Date.parse('2026-10-23T23:00:00+08:00');
      return { status: 200, headers: new Map(), body: Readable.from([enc.encode(toolCallBody([{ id: 'sleep-tool', name: 'chat_send_text', args: JSON.stringify({ text: '不应发布', idempotency_key: 'sleep-tool' }) }]))]) };
    }
    return { status: 200, headers: new Map(), body: Readable.from([enc.encode(chatBody('收到'))]) };
  }, nowRef, true);
  t.after(() => ctx.db.close());
  await seedChatTurn(ctx, 'sleep-tool');
  const count = (ctx.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
  const { scheduler, run } = readySleepBoundaryRun(ctx, nowRef);
  t.after(() => scheduler.stop());
  const result = await ctx.supervisor.enqueueBackground('c1', run);
  assert.equal(result.result_code, 'KEEPWARM_SLEEP_WINDOW');
  assert.equal(heartbeatRequests, 1);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, count, '未开始的发送工具零副作用');
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM background_dispatches WHERE dispatch_kind = 'tool'").get() as { n: number }).n, 0);
});

/** 价格注入（§10.2：预占需可信上界——测试注入；生产=runtime_settings 配置后生效）。 */
function setPrice(db: ReturnType<typeof openDatabase>, inputMicroPerToken = 0.000003, outputMicroPerToken = 0.000015): void {
  db.prepare("INSERT INTO runtime_settings(key, value, updated_at) VALUES ('or_model_price', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(JSON.stringify({ input_micro_per_token: inputMicroPerToken, output_micro_per_token: outputMicroPerToken }), new Date().toISOString());
}

/** 跑一次真实聊天回合建立窗口+轨迹+缓存证据（L=真实发布时刻）。 */
async function seedChatTurn(ctx: ReturnType<typeof compose>, cmid: string): Promise<string> {
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `消息-${cmid}`, clientMessageId: cmid });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal((ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string }).state, 'completed', '聊天回合完成');
  return t.turnId;
}

/** 复刻 app-context 的执行器接线（串行链+价格门+开关重查）。 */
function wireExecutor(ctx: ReturnType<typeof compose>, nowRef: { nowMs: number }): BackgroundScheduler {
  const sched: BackgroundScheduler = new BackgroundScheduler({ db: ctx.db, config: ctx.config, settings: ctx.bgSettings, alerts: ctx.alerts, now: () => nowRef.nowMs,
    executor: {
      async executeRun(input) {
        if (input.kind === 'reminder') return { outcome: 'completed' as const, result_code: 'delivered' };
        const priceRow = ctx.db.prepare("SELECT value FROM runtime_settings WHERE key = 'or_model_price'").get() as { value: string } | undefined;
        const price = priceRow ? JSON.parse(priceRow.value) as { input_micro_per_token?: number; output_micro_per_token?: number } : null;
        if (!price || typeof price.input_micro_per_token !== 'number' || typeof price.output_micro_per_token !== 'number') {
          return { outcome: 'failed' as const, result_code: 'BUDGET_ESTIMATE_UNAVAILABLE' };
        }
        const es = ctx.bgSettings.effective();
        if (es[input.kind].enabled !== true) return { outcome: 'noop' as const, result_code: input.kind === 'keepwarm' ? 'KEEPWARM_DISABLED' : 'AUTONOMOUS_DISABLED' };
        if (es[input.kind].daily_cost_cap_usd === null) return { outcome: 'failed' as const, result_code: 'BACKGROUND_BUDGET_NOT_CONFIGURED' };
        return ctx.supervisor.enqueueBackground(input.conversationId, () => ctx.supervisor.runBackgroundTurn({
          kind: input.kind as 'autonomous' | 'keepwarm',
          runId: input.runId, conversationId: input.conversationId, payload: input.payload,
          isCancelRequested: input.isCancelRequested, registerAbort: input.registerAbort,
          recordDispatch: (info) => sched.recordDispatchStart({ runId: input.runId, logicalActionKey: info.logicalActionKey, attemptNo: info.attemptNo, dispatchKind: info.dispatchKind, capabilityName: null, reservedCostMicroUsd: info.reservedCostMicroUsd }),
          maxModelRequests: es.autonomous.max_model_requests_per_run,
        }));
      },
    } });
  return sched;
}

test('K-01/B-10/C-01/C-12：心跳纯1=PURE_ACK——不进轨迹/原文/气泡；维护回执落投影；价格未核验不开请求；前缀稳定', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async (p) => {
    payloads.push(structuredClone(p));
    const isKeepalive = JSON.stringify(p).includes('Cache keepalive');
    const body = isKeepalive ? '1' : '你好'; // 纯1=维护回执（05）
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody(body))]) };
  };
  const root = tempRoot('wp4-kw-');
  const nowRef = { nowMs: Date.now() };
  const ctx = compose(root, transport, nowRef);
  await seedChatTurn(ctx, 'kw1');
  const win = ctx.db.prepare("SELECT id FROM windows WHERE conversation_id='c1' AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1").get() as { id: string };
  const trajBefore = (ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id) as { messages_json: string }).messages_json;
  const msgsBefore = (ctx.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;

  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  // 系统保温任务（cache_idle）建在 primary；测试会话 c1 手工建同型任务
  const kwTask = `bgt_kw1_${genId('x').slice(2, 8)}`;
  const nowIso = new Date(nowRef.nowMs).toISOString();
  ctx.db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at) VALUES (?,'c1','jiaming','keepwarm',1,1,'cache_idle',NULL,NULL,'Asia/Shanghai',NULL,NULL,'{}','system','system_keepwarm',?,?)").run(kwTask, nowIso, nowIso);
  const sched = wireExecutor(ctx, nowRef);
  sched.start();
  // (a) 目标=L+50min 未到：tick 领取不发生（K-01 前半）
  await sched.tick();
  assert.equal(payloads.length, 1, '未到期零保温请求（此前 1 次是聊天）');
  // (b) 价格未核验 → 到期后不开请求（B-10：明确 blocked）
  const L1 = Date.parse((ctx.db.prepare('SELECT last_real_activity_at FROM conversation_activity WHERE conversation_id = ?').get('c1') as { last_real_activity_at: string }).last_real_activity_at);
  nowRef.nowMs = L1 + 3_000_001;
  await sched.tick();
  let run = ctx.db.prepare('SELECT state, result_code FROM background_runs WHERE task_id = ?').get(kwTask) as { state: string; result_code: string | null };
  assert.equal(run.state, 'failed');
  assert.equal(run.result_code, 'BUDGET_ESTIMATE_UNAVAILABLE');
  assert.equal(payloads.length, 1, '零保温请求');
  // 价格未核验失败的同活动版本不重试（occurrence 唯一）
  await sched.tick();
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM background_runs WHERE task_id = ?').get(kwTask) as { n: number }).n, 1, '同维护机会不换 ID 重试');
  sched.stop();

  // (c) 新真实消息建立新活动版本 + 配置价格 → 心跳纯1（PURE_ACK）
  setPrice(ctx.db);
  await seedChatTurn(ctx, 'kw2');
  // 轨迹/消息基准在心跳前重取（第二次聊天本身合法推进轨迹）
  const trajBeforeHb = (ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id) as { messages_json: string }).messages_json;
  const msgsBeforeHb = (ctx.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
  const sched2 = wireExecutor(ctx, nowRef);
  sched2.start();
  const L2 = Date.parse((ctx.db.prepare('SELECT last_real_activity_at FROM conversation_activity WHERE conversation_id = ?').get('c1') as { last_real_activity_at: string }).last_real_activity_at);
  nowRef.nowMs = L2 + 3_000_001;
  await sched2.tick();
  run = ctx.db.prepare('SELECT state, result_code, model_requests_started, retention FROM background_runs WHERE task_id = ? AND state != \'failed\'').get(kwTask) as { state: string; result_code: string | null; model_requests_started: number; retention: string };
  assert.equal(run.state, 'completed');
  assert.equal(run.result_code, 'ack_only', '纯1=维护回执（不是聊天成功）');
  assert.equal(run.retention, 'ephemeral_ack');
  assert.equal(run.model_requests_started, 1, '恰一次维护请求');
  assert.equal(payloads.length, 3, '聊天(2)+心跳(1)');
  // 英文 host 提示进入请求（05 固定文本；不伪造用户消息）
  const kwPayload = JSON.stringify(payloads[2]);
  assert.ok(kwPayload.includes('Cache keepalive (host event, not Qiaosheng)'), '固定英文维护提示');
  // 轨迹不变、无新聊天气泡、无 owner 消息（C-12：纯1不污染）
  const trajAfter = (ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id) as { messages_json: string }).messages_json;
  assert.equal(trajAfter, trajBeforeHb, '纯1不推进规范轨迹（下一聊天从原 canonical 继续）');
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, msgsBeforeHb, '无心跳气泡');
  // 维护回执已写投影（K-09 基础）
  const act = ctx.db.prepare('SELECT maintenance_request_id, maintenance_for_activity_revision FROM conversation_activity WHERE conversation_id = ?').get('c1') as { maintenance_request_id: string; maintenance_for_activity_revision: number };
  assert.ok(act.maintenance_request_id !== null, '维护回执落投影');
  // 派发结算（费用已知→settled；B-01：预占非 0）
  const dispatch = ctx.db.prepare('SELECT state, reserved_cost_micro_usd FROM background_dispatches WHERE run_id = (SELECT id FROM background_runs WHERE task_id = ? AND state = \'completed\')').get(kwTask) as { state: string; reserved_cost_micro_usd: number };
  assert.equal(dispatch.state, 'settled');
  assert.ok(dispatch.reserved_cost_micro_usd > 0, 'B-01：真实派发预占非 0');
  // 下一次正常聊天照常（前缀比较基准不含心跳尾——C-01 面）
  await seedChatTurn(ctx, 'kw3');
  assert.equal(payloads.length, 4, '聊天照常');
  sched2.stop();
});

test('CW-08/B-07/C-07：自主唤醒——英文 host 自醒事件+note 全文；工具循环同 run；chat_send_text 单次发布；内部终答不发布', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  let bgRound = 0;
  const transport: OrTransport = async (p) => {
    payloads.push(structuredClone(p));
    const isBg = JSON.stringify(p).includes('Host self-wake');
    if (isBg) {
      bgRound++;
      if (bgRound === 1) return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(toolCallBody([{ id: 'tc-1', name: 'chat_send_text', args: JSON.stringify({ text: '自主活动里跟你说一声', idempotency_key: 'auto-1' }) }, { id: 'tc-2', name: 'background_complete', args: JSON.stringify({ outcome: 'noop' }) }]))]) };
      return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody('（内部结束）'))]) };
    }
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody('收到'))]) };
  };
  const root = tempRoot('wp4-auto-');
  const nowRef = { nowMs: Date.now() };
  const ctx = compose(root, transport, nowRef);
  await seedChatTurn(ctx, 'auto0');
  setPrice(ctx.db);
  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
  const autoTask = `bgt_auto1_${genId('x').slice(2, 8)}`;
  const nowIso = new Date(nowRef.nowMs).toISOString();
  ctx.db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at) VALUES (?,'c1','jiaming','autonomous',1,1,'once',?,?,'Asia/Shanghai',NULL,NULL,?,'qiaosheng','self_schedule',?,?)").run(autoTask, nowIso, nowIso, JSON.stringify({ note: '提醒宿主用户读书。', source: 'self_schedule', scheduled_for: nowIso }), nowIso, nowIso);
  const sched = wireExecutor(ctx, nowRef);
  sched.start();
  await sched.tick();
  const run = ctx.db.prepare('SELECT state, result_code, model_requests_started, tool_calls_started, retention FROM background_runs WHERE task_id = ?').get(autoTask) as { state: string; result_code: string | null; model_requests_started: number; tool_calls_started: number; retention: string };
  assert.equal(run.state, 'noop', 'noop 是成功结束（不强制产出）');
  assert.equal(run.result_code, 'complete:noop');
  assert.ok(run.model_requests_started >= 1, '工具链共用同一 run 计数');
  assert.equal(run.retention, 'retained', '有工具/发布=SUBSTANTIVE 保留');
  // W-07 面：note 原文进入请求（不截断 200）
  const bgPayload = JSON.stringify(payloads.filter((p) => JSON.stringify(p).includes('Host self-wake')));
  assert.ok(bgPayload.includes('Your note: 提醒宿主用户读书。'), 'note 全文投递');
  assert.ok(bgPayload.includes('not a message from Qiaosheng'), '来源可辨（host 事件口径）');
  // chat_send_text 恰发布一条正式助手消息；工具后的内部续答不发布
  const published = ctx.messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 100 }).filter((m) => m.speaker === 'assistant' && m.revision.content.includes('自主活动里跟你说一声'));
  assert.equal(published.length, 1, '显式发送工具只发一次');
  // C-07：正式主动消息进入轨迹（下一请求可见——catchup/manifest）
  const win = ctx.db.prepare("SELECT id FROM windows WHERE conversation_id='c1' AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1").get() as { id: string };
  const traj = ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id) as { messages_json: string };
  assert.ok(traj.messages_json.includes('自主活动里跟你说一声'), '轨迹含 host 事件链与发布');
  // once 任务完成后终结
  const taskRow = ctx.db.prepare('SELECT enabled, control_reason FROM background_tasks WHERE id = ?').get(autoTask) as { enabled: number; control_reason: string };
  assert.equal(taskRow.enabled, 0);
  assert.equal(taskRow.control_reason, 'delivered');
  sched.stop();
});

test('C-02/K-12：心跳调用工具→实质执行+续轮（旧零工具封锁退役）；工具后回1仍 retained', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  let bgRound = 0;
  const transport: OrTransport = async (p) => {
    payloads.push(structuredClone(p));
    const isBg = JSON.stringify(p).includes('Cache keepalive');
    if (isBg) {
      bgRound++;
      if (bgRound === 1) return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(toolCallBody([{ id: 'tc-kw', name: 'chat_send_text', args: JSON.stringify({ text: '心跳里想跟你说句话', idempotency_key: 'kw-1' }) }, { id: 'tc-kw2', name: 'background_complete', args: JSON.stringify({ outcome: 'done' }) }]))]) };
      return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody('1'))]) };
    }
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody('收到'))]) };
  };
  const root = tempRoot('wp4-kwtool-');
  const nowRef = { nowMs: Date.now() };
  const ctx = compose(root, transport, nowRef);
  await seedChatTurn(ctx, 'kwt0');
  setPrice(ctx.db);
  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  const kwTask = `bgt_kwt_${genId('x').slice(2, 8)}`;
  const nowIso = new Date(nowRef.nowMs).toISOString();
  ctx.db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at) VALUES (?,'c1','jiaming','keepwarm',1,1,'cache_idle',NULL,NULL,'Asia/Shanghai',NULL,NULL,'{}','system','system_keepwarm',?,?)").run(kwTask, nowIso, nowIso);
  const sched = wireExecutor(ctx, nowRef);
  sched.start();
  const L = Date.parse((ctx.db.prepare('SELECT last_real_activity_at FROM conversation_activity WHERE conversation_id = ?').get('c1') as { last_real_activity_at: string }).last_real_activity_at);
  nowRef.nowMs = L + 3_000_001;
  await sched.tick();
  const run = ctx.db.prepare('SELECT state, result_code, model_requests_started, tool_calls_started, published_message_count, retention FROM background_runs WHERE task_id = ?').get(kwTask) as { state: string; result_code: string | null; model_requests_started: number; tool_calls_started: number; published_message_count: number; retention: string };
  assert.ok(run.model_requests_started >= 2, '工具续轮发生（不再单请求截断）');
  assert.ok(run.tool_calls_started >= 1, '工具真实执行（不再零工具封锁）');
  assert.equal(run.published_message_count, 1, 'C-02：心跳正式发言发布一次');
  assert.equal(run.retention, 'retained', 'K-12：工具后即使最终回1也 retained（不走纯回执丢弃）');
  assert.equal(run.state, 'completed');
  // 取消后新派发被挡（旧 CW-15 后半保留）
  const runId = (ctx.db.prepare('SELECT id FROM background_runs WHERE task_id = ?').get(kwTask) as { id: string }).id;
  const stop = sched.stopRun(runId);
  assert.ok(stop !== null);
  const blocked = sched.recordDispatchStart({ runId, logicalActionKey: 'model:x', attemptNo: 9, dispatchKind: 'model', capabilityName: null, reservedCostMicroUsd: 0 });
  assert.equal(blocked.allowed, false, '终态/取消后不再有新派发');
  sched.stop();
});

test('C-07（收尾）：自醒 chat_send_text 已发 → 下一用户请求恰好看到一次主动消息；UI 恰一条', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  let bgRound = 0;
  const transport: OrTransport = async (p) => {
    payloads.push(structuredClone(p));
    const isBg = JSON.stringify(p).includes('Host self-wake');
    if (isBg) {
      bgRound++;
      if (bgRound === 1) return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(toolCallBody([{ id: 'tc-c7', name: 'chat_send_text', args: JSON.stringify({ text: '主动想说的话C7', idempotency_key: 'c7-1' }) }, { id: 'tc-c7b', name: 'background_complete', args: JSON.stringify({ outcome: 'done' }) }]))]) };
      return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody('（收尾）'))]) };
    }
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody('收到'))]) };
  };
  const root = tempRoot('wp4-c7-');
  const nowRef = { nowMs: Date.now() };
  const ctx = compose(root, transport, nowRef);
  await seedChatTurn(ctx, 'c7-0');
  setPrice(ctx.db);
  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
  const autoTask = `bgt_c7_${genId('x').slice(2, 8)}`;
  const nowIso = new Date(nowRef.nowMs).toISOString();
  ctx.db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at) VALUES (?,'c1','jiaming','autonomous',1,1,'once',?,?,'Asia/Shanghai',NULL,NULL,'{}','qiaosheng','self_schedule',?,?)").run(autoTask, nowIso, nowIso, nowIso, nowIso);
  const sched = wireExecutor(ctx, nowRef);
  sched.start();
  await sched.tick(); // 自醒执行：chat_send_text 发布一条正式消息
  const published = ctx.messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 100 }).filter((m) => m.speaker === 'assistant' && m.revision.content.includes('主动想说的话C7'));
  assert.equal(published.length, 1, 'UI/消息库恰一条主动消息');
  // 下一用户请求：模型恰好看到一次
  await seedChatTurn(ctx, 'c7-1');
  const lastChat = payloads[payloads.length - 1]!;
  const wire = JSON.stringify(lastChat);
  const occurrences = wire.split('主动想说的话C7').length - 1;
  const msgs = (lastChat as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
  console.log('DEBUG roles=', JSON.stringify(msgs.map(m => m.role)));
  assert.equal(occurrences, 1, `下一请求恰好包含一次主动消息（实际 ${occurrences} 次）`);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision WHERE m.speaker = 'assistant' AND r.content LIKE '%主动想说的话C7%'").get() as { n: number }).n, 1, '原文一致不重复');
  sched.stop();
});
