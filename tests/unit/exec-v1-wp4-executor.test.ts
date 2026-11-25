// ESTOMAGO_CHAT_EXEC_V1 · WP4 收尾 + WAKE_KEEPWARM_V1（2026-10-22 改写）：
// 后台模型回路执行器整链（04/05/06 §2/§4；K-01/K-12/K-13、C-01/C-02/C-07、B-01/B-10 面）。
// 2026-10-22 改写：保温零工具封锁（CW-13）与 128 输出封锁退役——心跳=完整回合；
// v1.2 心跳邀请及工具回执走同一会话串行链，维护时钟经活动投影 CAS。
import { test, type TestContext } from 'node:test';
import { makeFixtureToolsResident, assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
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
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { ArchiveService } from '../../apps/host/src/modules/archives/service.ts';
import { HeartbeatRuntime } from '../../apps/host/src/modules/heartbeat/runtime.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';
import { BackgroundTaskService } from '../../apps/host/src/runtime/background-task-service.ts';
import { lastCacheEvidence } from '../../apps/host/src/runtime/cache-observation.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const latestUserContent = (payload: Record<string, unknown>): string => {
  const messages = payload.messages as Array<{ role: string; content: unknown }>;
  const latest = messages.findLast(message => message.role === 'user');
  return JSON.stringify(latest?.content ?? '');
};
const isHeartbeat = (payload: Record<string, unknown>): boolean => latestUserContent(payload).includes('[心跳唤醒]');
const isSelfWake = (payload: Record<string, unknown>): boolean => latestUserContent(payload).includes('[Host self-wake;');

function compose(root: string, transport: OrTransport, nowRef: { nowMs: number }, sleepEnabled = false, retryMax = 0, toolMode: 'legacy' | 'direct' | 'deferred' = 'legacy', keepwarmEnabled?: () => boolean) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter', tool_schema_mode: toolMode }, openrouter: { model: MODEL }, background: { keepwarm: { sleep_window: { enabled: sleepEnabled } } } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const activity = new ConversationActivityService(db);
  const messages = new MessageService(db, null, activity);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, identity, config);
  const alerts = new SystemAlertService(db, events);
  const media = new MediaService(db, paths.mediaDir, config);
  const trajectory = new WindowTrajectoryService(db);
  const selections = new ManualSelectionService(db);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax }, transport);
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), archiveSync: null, media: media, messages: messages });
  const archives = new ArchiveService({ db, contentClient: null, contentOps: null, logger });
  const heartbeat = new HeartbeatRuntime(db, null, media, archives, messages, events);
  heartbeat.sources.choose = async (conversationId) => Array.from({ length: 10 }, (_, index) => ({
    kind: 'moments', namespace: 'content', id: `fixture-${index + 1}`, revision: 1,
    identity: `content:moments:fixture-${index + 1}`, permissionScope: conversationId,
  }));
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db, alerts), routing, windows, logger, alerts, media, trajectory, selections, tools, activity, heartbeat, now: () => nowRef.nowMs, ...(keepwarmEnabled ? { keepwarmEnabled } : {}) });
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
    if (isHeartbeat(payload)) {
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
    if (isHeartbeat(payload)) {
      heartbeatRequests++;
      nowRef.nowMs = Date.parse('2026-10-23T23:00:00+08:00');
      return { status: 200, headers: new Map(), body: Readable.from([enc.encode(toolCallBody([{ id: 'sleep-tool', name: 'chat_send_text', args: JSON.stringify({ text: '不应发布', idempotency_key: 'sleep-tool' }) }]))]) };
    }
    return { status: 200, headers: new Map(), body: Readable.from([enc.encode(chatBody('收到'))]) };
  }, nowRef, true);
  t.after(() => ctx.db.close());
  await seedChatTurn(ctx, 'sleep-tool');
  const count = (ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='assistant'").get() as { n: number }).n;
  const { scheduler, run } = readySleepBoundaryRun(ctx, nowRef);
  t.after(() => scheduler.stop());
  const result = await ctx.supervisor.enqueueBackground('c1', run);
  assert.equal(result.result_code, 'KEEPWARM_SLEEP_WINDOW');
  assert.equal(heartbeatRequests, 1);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='assistant'").get() as { n: number }).n, count, '未开始的发送工具不发布助手消息');
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

test('新直调窗口：自主、心跳和聊天共用工具前缀及当前回合完成能力', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T14:00:00+08:00') });
  const payloads: Array<Record<string, unknown>> = [];
  const now = { nowMs: Date.now() };
  const root = tempRoot('direct-background-');
  const ctx = compose(root, async (payload) => {
    payloads.push(payload);
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    const latestUser = JSON.stringify(messages.findLast(message => message.role === 'user')?.content);
    let body = isHeartbeat(payload)
      ? toolCallBody([{ id: 'native-heartbeat-decline', name: 'background_complete', args: '{"outcome":"noop"}' }])
      : chatBody('合成回复');
    if (latestUser.includes('Host self-wake')) {
      const usage = { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 1500 }, cost: 0.001 };
      body = toolCallBody([{ id: 'native-complete', name: 'background_complete', args: '{"outcome":"done"}' }], usage);
    }
    if (latestUser.includes('Host self-wake') && !(payload.tools as Array<{function:{name:string}}>).some(t => t.function.name === 'background_complete')) {
      body = toolCallBody([{ id:'select-completion', name:'tool_define', args:'{"name":"background_complete"}' }]);
    }
    return { status: 200, headers: new Map(), body: Readable.from([enc.encode(body)]) };
  }, now, false, 0, 'direct');
  const scheduler = wireExecutor(ctx, now);
  t.after(() => { scheduler.stop(); ctx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await seedChatTurn(ctx, 'native-initial');
  const windowId = ctx.windows.activeWindow('c1')!.id;
  const initialEvidence = lastCacheEvidence(ctx.db, windowId);
  assert.ok(initialEvidence);
  const names = (payload: Record<string, unknown>) => (payload.tools as Array<{ function: { name: string } }>).map(spec => spec.function.name);
  const baseline = names(payloads[0]!);
  assert.ok(baseline.includes('memory_hold') && baseline.includes('heartbeat_draw'));
  assert.ok(!baseline.includes('tool_invoke') && !baseline.includes('background_complete') && !baseline.includes('context_review_complete'));

  setPrice(ctx.db);
  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: {
    autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5,
    keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 5,
  } });
  const task = new BackgroundTaskService(ctx.db, ctx.bgSettings, () => now.nowMs).schedule({
    actorId: 'jiaming', conversationId: 'c1', operationId: 'native-task', note: '合成预约',
    delaySeconds: 1, createdBy: 'jiaming',
  });
  assert.ok(task.ok);
  scheduler.start();
  now.nowMs += 1_001;
  await scheduler.tick();
  assert.deepEqual(names(payloads[1]!), baseline);
  assert.deepEqual(names(payloads[2]!), [...baseline,'background_complete']);
  const wake = ctx.db.prepare('SELECT r.state, r.result_code, p.id FROM background_runs r JOIN provider_requests p ON p.background_run_id=r.id WHERE r.task_id=? ORDER BY p.rowid DESC LIMIT 1')
    .get(task.task.task_id) as { state: string; result_code: string; id: string };
  assert.deepEqual({ state: wake.state, result_code: wake.result_code }, { state: 'completed', result_code: 'complete:done' });
  assert.notEqual(wake.id, initialEvidence.requestId);
  assert.equal(lastCacheEvidence(ctx.db, windowId)?.requestId, wake.id);

  const iso = new Date(now.nowMs).toISOString();
  // The scheduler creates the system heartbeat task for primary by default.
  ctx.db.prepare("INSERT INTO background_tasks(id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,timezone,payload_json,created_by_actor_id,origin,created_at,updated_at) VALUES ('native-keepwarm','c1','jiaming','keepwarm',1,1,'cache_idle','Asia/Shanghai','{}','system','system_keepwarm',?,?)").run(iso, iso);
  const activity = ctx.activity.get('c1')!;
  now.nowMs = Math.max(Date.parse(activity.last_real_activity_at!), Date.parse(lastCacheEvidence(ctx.db, windowId)!.startedAt)) + 3_000_001;
  await scheduler.tick();
  assert.deepEqual(payloads[3]!.tools, payloads[2]!.tools);
  const heartbeatTail = (payloads[3]!.messages as Array<{ role: string; content: unknown }>).findLast(message => message.role === 'user');
  assert.match(JSON.stringify(heartbeatTail?.content), /\[心跳唤醒\]/);
  assert.doesNotMatch(JSON.stringify(heartbeatTail?.content), /tools\/task:/);
  await seedChatTurn(ctx, 'native-after-task');
  assert.deepEqual(payloads[4]!.tools, payloads[2]!.tools);
  assert.equal(payloads.length, 5);
  assert.ok((payloads[4]!.messages as Array<{ role: string; content: unknown }>).some(message =>
    message.role === 'tool' && typeof message.content === 'string' && JSON.parse(message.content).completed === true));
});

test('K-01/C-01/C-12：心跳按原有时序派发，无文字拒抽保留协议并推进维护回执', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T14:00:00+08:00') });
  const payloads: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async (p) => {
    payloads.push(structuredClone(p));
    const body = isHeartbeat(p)
      ? toolCallBody([{ id: 'heartbeat-decline', name: 'background_complete', args: '{"outcome":"noop"}' }],
        { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.001 })
      : chatBody('你好');
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(body)]) };
  };
  const root = tempRoot('wp4-kw-');
  const nowRef = { nowMs: Date.now() };
  const ctx = compose(root, transport, nowRef);
  const sched = wireExecutor(ctx, nowRef);
  t.after(() => { sched.stop(); ctx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await seedChatTurn(ctx, 'kw1');
  const windowId = ctx.windows.activeWindow('c1')!.id;

  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  // 系统保温任务（cache_idle）建在 primary；测试会话 c1 手工建同型任务
  const kwTask = `bgt_kw1_${genId('x').slice(2, 8)}`;
  const nowIso = new Date(nowRef.nowMs).toISOString();
  ctx.db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at) VALUES (?,'c1','jiaming','keepwarm',1,1,'cache_idle',NULL,NULL,'Asia/Shanghai',NULL,NULL,'{}','system','system_keepwarm',?,?)").run(kwTask, nowIso, nowIso);
  sched.start();
  await sched.tick();
  assert.equal(payloads.length, 1, '未到期零保温请求（此前 1 次是聊天）');

  setPrice(ctx.db);
  await seedChatTurn(ctx, 'kw2');
  const before = ctx.trajectory.forWindow(windowId)!.messages;
  const L = ctx.activity.get('c1')!.last_real_activity_at!;
  nowRef.nowMs = Date.parse(L) + 3_000_001;
  await sched.tick();
  const run = ctx.db.prepare('SELECT id, turn_id, state, result_code, model_requests_started, retention FROM background_runs WHERE task_id=?')
    .get(kwTask) as { id: string; turn_id: string; state: string; result_code: string; model_requests_started: number; retention: string };
  assert.equal(run.state, 'noop');
  assert.equal(run.result_code, 'complete:noop');
  assert.equal(run.retention, 'retained');
  assert.equal(run.model_requests_started, 1, '恰一次维护请求');
  assert.equal(payloads.length, 3, '聊天(2)+心跳(1)');
  const kwPayload = JSON.stringify(payloads[2]);
  assert.match(kwPayload, /\[心跳唤醒\]/);
  assert.doesNotMatch(kwPayload, /请回复 1/);
  const after = ctx.trajectory.forWindow(windowId)!.messages;
  assert.deepEqual(after.slice(0, before.length), before, '既有缓存前缀原样保留');
  const receipts = after.slice(before.length).filter(message => message.role === 'tool' && message.tool_call_id === 'heartbeat-decline');
  assert.equal(receipts.length, 1);
  assert.deepEqual(JSON.parse(receipts[0]!.content as string), { completed: true, outcome: 'noop' });
  const speakers = ctx.db.prepare('SELECT speaker FROM messages WHERE turn_id=? ORDER BY sequence').all(run.turn_id)
    .map(message => message.speaker);
  assert.deepEqual(speakers, ['system', 'system'], '邀请和拒抽状态由宿主发布');
  const act = ctx.activity.get('c1')!;
  assert.equal(act.last_real_activity_at, L);
  assert.ok(act.maintenance_request_id, '维护回执落投影');
  assert.deepEqual(ctx.activity.nextKeepwarmTarget({ conversationId: 'c1', windowId }), {
    scheduled: true, dueAtMs: Date.parse(act.maintenance_dispatch_started_at!) + 3_000_000,
    basis: 'maintenance', activityRevision: act.activity_revision,
  });
  const dispatch = ctx.db.prepare("SELECT state,reserved_cost_micro_usd FROM background_dispatches WHERE run_id=? AND dispatch_kind='model'")
    .get(run.id) as { state: string; reserved_cost_micro_usd: number };
  assert.equal(dispatch.state, 'settled');
  assert.ok(dispatch.reserved_cost_micro_usd > 0, 'B-01：真实派发预占非 0');

  await seedChatTurn(ctx, 'kw3');
  assert.equal(payloads.length, 4, '聊天照常');
  const next = payloads[3]!.messages as Array<{ role: string; tool_call_id?: string }>;
  assert.equal(next.filter(message => message.role === 'tool' && message.tool_call_id === 'heartbeat-decline').length, 1);
});

function scheduleDueSelfWake(ctx: ReturnType<typeof compose>, clock: { nowMs: number }, operationId: string, note: string): string {
  const result = new BackgroundTaskService(ctx.db, ctx.bgSettings, () => clock.nowMs).schedule({
    actorId: 'jiaming', createdBy: 'jiaming', conversationId: 'c1', operationId, note, delaySeconds: 1,
  });
  assert.ok(result.ok);
  clock.nowMs += 1_000;
  return result.task.task_id;
}

test('CW-08/B-07/C-07：自主唤醒——英文 host 自醒事件+note 全文；工具循环同 run；chat_send_text 单次发布；内部终答不发布', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  let bgRound = 0;
  const transport: OrTransport = async (p) => {
    payloads.push(structuredClone(p));
    if (isSelfWake(p)) {
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
  const autoTask = scheduleDueSelfWake(ctx, nowRef, 'auto1-wake', '提醒宿主用户读书。');
  const sched = wireExecutor(ctx, nowRef);
  sched.start();
  await sched.tick();
  const run = ctx.db.prepare('SELECT state, result_code, model_requests_started, tool_calls_started, retention FROM background_runs WHERE task_id = ?').get(autoTask) as { state: string; result_code: string | null; model_requests_started: number; tool_calls_started: number; retention: string };
  assert.equal(run.state, 'noop', 'noop 是成功结束（不强制产出）');
  assert.equal(run.result_code, 'complete:noop');
  assert.ok(run.model_requests_started >= 1, '工具链共用同一 run 计数');
  assert.equal(run.retention, 'retained', '有工具/发布=SUBSTANTIVE 保留');
  // W-07 面：note 原文进入请求（不截断 200）
  const bgPayload = JSON.stringify(payloads.filter(isSelfWake));
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

test('C-02/K-12：心跳正式发言后完成，保留工具协议且不派发续轮', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T14:00:00+08:00') });
  const payloads: Array<Record<string, unknown>> = [];
  let bgRound = 0;
  const transport: OrTransport = async (p) => {
    payloads.push(structuredClone(p));
    const isBg = isHeartbeat(p);
    if (isBg) {
      bgRound++;
      if (bgRound === 1) return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(toolCallBody([{ id: 'tc-kw', name: 'chat_send_text', args: JSON.stringify({ text: '心跳里想跟你说句话', idempotency_key: 'kw-1' }) }, { id: 'tc-kw2', name: 'background_complete', args: JSON.stringify({ outcome: 'done' }) }]))]) };
      assert.fail('共享完成后不能再发模型请求');
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
  // P5（四仓审计 20261106，T17/C09）：background_complete=业务结束决定——同批工具结果
  // 按已发协议收尾后不再开启新模型请求（旧断言"complete 后仍续轮回 1"按新裁定退役；
  // 多步能力=complete 之前的任意工具轮）。旧零工具封锁退役断言保留。
  assert.ok(run.tool_calls_started >= 1, '工具真实执行（不再零工具封锁）');
  assert.equal(run.published_message_count, 1, 'C-02：心跳正式发言发布一次');
  assert.equal(run.retention, 'retained', 'K-12：有工具的回合 retained（不走纯回执丢弃）');
  assert.equal(run.model_requests_started, 1);
  assert.equal(bgRound, 1);
  assert.equal(run.state, 'completed');
  assert.equal(run.result_code, 'complete:done', 'complete 决定生效');
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
    if (isSelfWake(p)) {
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
  scheduleDueSelfWake(ctx, nowRef, 'c7-wake', '主动聊一句。');
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
  assert.equal(occurrences, 1, `下一请求恰好包含一次主动消息（实际 ${occurrences} 次）`);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision WHERE m.speaker = 'assistant' AND r.content LIKE '%主动想说的话C7%'").get() as { n: number }).n, 1, '原文一致不重复');
  sched.stop();
});

for (const mode of ['legacy', 'direct', 'deferred'] as const) {
  test(`当前回合主动结束（${mode}）：无补话，旧批回执只在下一次自然请求进入模型`, async t => {
    const payloads: Array<Record<string, unknown>> = [];
    const root = tempRoot('turn-completion-');
    const ctx = compose(root, async payload => {
      payloads.push(structuredClone(payload));
      const invoke = (name: string, args: Record<string, unknown>) => mode === 'deferred'
        ? { name: 'tool_invoke', args: JSON.stringify({ name, arguments: args }) }
        : { name, args: JSON.stringify(args) };
      const body = payloads.length === 1
        ? toolCallBody([
          { id: 'terminal', ...invoke('background_complete', { outcome: 'noop' }) },
          { id: 'not-started', ...invoke('chat_send_text', { text: '本轮结束后不应发出', idempotency_key: 'after-finish' }) },
        ])
        : chatBody('下一轮正常回复');
      return { status: 200, headers: new Map(), body: Readable.from([enc.encode(body)]) };
    }, { nowMs: Date.now() }, false, 0, mode);
    if (mode === 'direct') makeFixtureToolsResident(ctx.db, ['background_complete','chat_send_text']);
    t.after(() => { ctx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const turnId = await seedChatTurn(ctx, 'turn-first');
    assert.equal(payloads.length, 1);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE turn_id=? AND speaker='assistant'").get(turnId)?.n, 0);
    assert.equal(ctx.db.prepare('SELECT completion_outcome FROM attempts WHERE turn_id=?').get(turnId)?.completion_outcome, 'noop');
    const windowId = ctx.windows.activeWindow('c1')!.id;
    const history = ctx.trajectory.forWindow(windowId)!;
    assert.deepEqual(history.messages.filter(m => m.role === 'tool').map(m => [m.tool_call_id, JSON.parse(m.content as string)]), [
      ['terminal', { completed: true, outcome: 'noop' }],
      ['not-started', { error_code: 'TURN_COMPLETED', executed: false }],
    ]);
    assert.equal((payloads[0]!.messages as Array<{ role: string }>).some(m => m.role === 'tool'), false);
    await seedChatTurn(ctx, 'turn-next');
    assert.equal(payloads.length, 2);
    assert.equal((payloads[1]!.messages as Array<{ role: string; tool_call_id?: string }>).filter(m => m.role === 'tool' && m.tool_call_id === 'terminal').length, 1);
    assert.deepEqual(payloads[1]!.tools, payloads[0]!.tools);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_message_id='after-finish'").get()?.n, 0);
  });
}

/** 22:59 已发出请求，23:00 之后才回来的正文；以及 21:00 生成途中休息成立或开关关闭。
 *  派发、费用和已真实发出的消息照常保留，正文不进聊天。 */
async function replyAfterBoundary(t: Pick<TestContext, 'after'>, options: {
  hold: 'sleep' | 'rest' | 'disabled'; reply: 'final' | 'before-tool' | 'after-a-real-tool-send';
}): Promise<void> {
  const boundary = options.hold === 'sleep' ? Date.parse('2026-10-23T23:00:00+08:00') : Date.parse('2026-10-23T21:00:00+08:00');
  const nowRef = { nowMs: options.hold === 'sleep' ? boundary - 1_000 : boundary };
  const switchState = { on: true };
  let heartbeatRequests = 0;
  let crossesBoundary = (): void => {};
  const speechBeforeTool = '这句正文不该发出';
  const toolSpeech = '工具也不该发出';
  const finalSpeech = '23 点之后才生成的回复';
  const transport: OrTransport = async (payload) => {
    if (!isHeartbeat(payload)) return { status: 200, headers: new Map(), body: Readable.from([enc.encode(chatBody('收到'))]) };
    const late = options.reply !== 'after-a-real-tool-send' || heartbeatRequests++ > 0;
    if (late) crossesBoundary();
    if (options.reply === 'after-a-real-tool-send' && !late) {
      return { status: 200, headers: new Map(), body: Readable.from([enc.encode(toolCallBody([{ id: 'real-send', name: 'chat_send_text', args: JSON.stringify({ text: '睡前经工具发出的一句', idempotency_key: 'real-send' }) }]))]) };
    }
    if (options.reply === 'before-tool') {
      return { status: 200, headers: new Map(), body: Readable.from([enc.encode(
        sse({ id: 'gen-late-speech', choices: [{ delta: { content: speechBeforeTool, tool_calls: [{ index: 0, id: 'late-send', type: 'function', function: { name: 'chat_send_text', arguments: JSON.stringify({ text: toolSpeech, idempotency_key: 'late-send' }) } }] } }] })
        + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 500, completion_tokens: 10, cost: 0.001 } }) + DONE)]) };
    }
    return { status: 200, headers: new Map(), body: Readable.from([enc.encode(chatBody(finalSpeech))]) };
  };
  const ctx = compose(tempRoot('wp4-late-speech-'), transport, nowRef, true, 0, 'legacy', () => switchState.on);
  crossesBoundary = () => {
    nowRef.nowMs = boundary;
    if (options.hold === 'rest') ctx.activity.noteRestDecision('c1', { kind: 'rest', source: 'owner_message', messageId: 'owner-goodnight', atIso: new Date().toISOString() });
    if (options.hold === 'disabled') switchState.on = false;
  };
  await seedChatTurn(ctx, 'late-speech');
  const { scheduler, run } = readySleepBoundaryRun(ctx, nowRef);
  t.after(() => { scheduler.stop(); ctx.db.close(); fs.rmSync(ctx.root, { recursive: true, force: true }); });
  const assistantCount = () => (ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='assistant'").get() as { n: number }).n;
  const published = (text: string) => (ctx.db.prepare("SELECT COUNT(*) n FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE r.content=?").get(text) as { n: number }).n;
  const dispatches = (kind: string) => (ctx.db.prepare("SELECT COUNT(*) n FROM background_dispatches WHERE dispatch_kind=?").get(kind) as { n: number }).n;
  const before = assistantCount();
  const result = await ctx.supervisor.enqueueBackground('c1', run);
  const code = options.hold === 'sleep' ? 'KEEPWARM_SLEEP_WINDOW' : options.hold === 'rest' ? 'KEEPWARM_RESTING' : 'KEEPWARM_DISABLED';
  // The request really left before the boundary: its dispatch, cost and invitation stay on record.
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE client_message_id='heartbeat:sleep-run:invite'").get() as { n: number }).n, 1);
  assert.equal(dispatches('model'), options.reply === 'after-a-real-tool-send' ? 2 : 1);
  assert.equal(published(finalSpeech) + published(speechBeforeTool) + published(toolSpeech), 0, '被拦的正文和工具发送都没有进入聊天');
  const projection = JSON.parse(String(ctx.db.prepare("SELECT payload_ref FROM outbox WHERE operation_key='heartbeat-moment:sleep-run'").get()?.payload_ref)) as { state: string; terminal: unknown };
  assert.deepEqual(projection.terminal, { status: 'cancelled', reason: options.hold === 'disabled' ? 'other' : options.hold });
  if (options.reply === 'after-a-real-tool-send') {
    assert.deepEqual(result, { outcome: 'noop', result_code: code });
    assert.equal(assistantCount(), before + 1, '只有睡前经工具真实发出的那一句');
    assert.equal(published('睡前经工具发出的一句'), 1);
    assert.equal(projection.state, 'talked');
    assert.equal(dispatches('tool'), 1);
  } else if (options.reply === 'before-tool') {
    assert.deepEqual(result, { outcome: 'completed', result_code: code });
    assert.equal(assistantCount(), before);
    assert.equal(projection.state, 'interrupted');
    assert.equal(dispatches('tool'), 0, '23 点后的工具发送不派发');
  } else {
    assert.deepEqual(result, { outcome: 'noop', result_code: code });
    assert.equal(assistantCount(), before);
    assert.equal(projection.state, 'interrupted');
  }
  // Nothing is resent: the next ordinary turn publishes none of it and starts no extra heartbeat.
  const heartbeatTurns = (ctx.db.prepare("SELECT COUNT(*) n FROM turns WHERE trigger='cache_keepalive'").get() as { n: number }).n;
  await seedChatTurn(ctx, 'after-boundary');
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM turns WHERE trigger='cache_keepalive'").get() as { n: number }).n, heartbeatTurns);
  assert.equal(published(finalSpeech) + published(speechBeforeTool) + published(toolSpeech), 0);
  if (options.reply !== 'before-tool') {
    // The model continues from what she could actually read, not from a reply that was held back.
    const next = ctx.db.prepare("SELECT payload_json FROM provider_requests WHERE purpose='chat' ORDER BY rowid DESC LIMIT 1").get() as { payload_json: string };
    assert.equal(String(next.payload_json).includes(finalSpeech), false, '被拦的最终正文不进入下一轮的模型协议');
    assert.ok(String(next.payload_json).includes('[心跳唤醒]'), '已真实发出的邀请照常留在协议里');
  }
}

for (const hold of ['sleep', 'rest', 'disabled'] as const) {
  test(`T-A03：22:59 派发、23:00 后返回的最终正文受发布门约束（${hold}）`, async (t) => {
    await replyAfterBoundary(t, { hold, reply: 'final' });
  });
}
for (const hold of ['sleep', 'rest'] as const) {
  test(`T-A03：23:00 后返回的“正文+工具调用”里正文不发、工具不派发（${hold}）`, async (t) => {
    await replyAfterBoundary(t, { hold, reply: 'before-tool' });
  });
}
test('T-A03：睡前经工具真实发出的一句保留，23:00 后返回的后续正文不发，不重跑也不重发', async (t) => {
  await replyAfterBoundary(t, { hold: 'sleep', reply: 'after-a-real-tool-send' });
});

test('T-A04/T-A07：21:00 的晚安只拦心跳——排队的心跳在任何牌组模式下零派发，自主预约照常执行并经工具发言', async (t) => {
  // Outside the fixed night window, so rest is the only thing that can stop the heartbeat.
  const nowRef = { nowMs: Date.parse('2026-10-23T21:00:00+08:00') };
  const requests: string[] = [];
  const ctx = compose(tempRoot('wp4-rest-scope-'), async (payload) => {
    const latest = latestUserContent(payload);
    if (isSelfWake(payload)) {
      requests.push('wake');
      return { status: 200, headers: new Map(), body: Readable.from([enc.encode(requests.length === 1
        ? toolCallBody([{ id: 'wake-send', name: 'chat_send_text', args: JSON.stringify({ text: '到点了，这是预约要说的话', idempotency_key: 'wake-send' }) }])
        : toolCallBody([{ id: 'wake-done', name: 'background_complete', args: '{"outcome":"done"}'}], { prompt_tokens: 500, completion_tokens: 5, cost: 0.001 }))] ) };
    }
    return { status: 200, headers: new Map(), body: Readable.from([enc.encode(chatBody('收到'))]) };
  }, nowRef);
  setPrice(ctx.db);
  await seedChatTurn(ctx, 'rest-scope');
  const { scheduler, run } = readySleepBoundaryRun(ctx, nowRef);
  ctx.bgSettings.applyUpdate({ expectedRevision: 1, patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 1 } });
  t.after(() => { scheduler.stop(); ctx.db.close(); fs.rmSync(ctx.root, { recursive: true, force: true }); });
  const iso = new Date(nowRef.nowMs).toISOString();
  ctx.db.prepare("INSERT INTO background_tasks(id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,scheduled_at,next_due_at,timezone,payload_json,created_by_actor_id,origin,created_at,updated_at) VALUES ('wake-task','c1','jiaming','autonomous',1,1,'once',?,?,'Asia/Shanghai',?,'jiaming','self_schedule',?,?)")
    .run(iso, iso, JSON.stringify({ note: '合成预约' }), iso, iso);
  ctx.db.prepare("INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at) VALUES ('wake-run','wake-task','c1','jiaming','autonomous',1,'wake:rest-scope','claimed',?,?)").run(iso, iso);
  const wake = () => ctx.supervisor.enqueueBackground('c1', () => ctx.supervisor.runBackgroundTurn({
    kind: 'autonomous', runId: 'wake-run', conversationId: 'c1', payload: {}, isCancelRequested: () => false, registerAbort: () => {},
    recordDispatch: (info) => scheduler.recordDispatchStart({ runId: 'wake-run', ...info, capabilityName: null }), maxModelRequests: 4,
  }));

  // 休息在心跳开始前已成立：未读牌组就结束，抽卡轮和十张耗尽后的“回 1”走的是同一个门。
  assert.equal(ctx.activity.noteRestDecision('c1', { kind: 'rest', source: 'owner_message', messageId: 'owner-goodnight', atIso: iso }), true);
  assert.equal(ctx.activity.noteRestDecision('c1', { kind: 'rest', source: 'owner_message', messageId: 'owner-goodnight', atIso: iso }), false, '同消息幂等重放不改动已成立的休息');
  assert.equal(ctx.activity.noteRestDecision('c1', { kind: 'rest', source: 'owner_message', messageId: 'owner-goodnight-again', atIso: iso }), true, 'R1：新消息的休息决定可覆盖原决定');
  const begin = t.mock.method(ctx.supervisor['d'].heartbeat!, 'begin');
  assert.deepEqual(await ctx.supervisor.enqueueBackground('c1', run), { outcome: 'noop', result_code: 'KEEPWARM_RESTING', detail: '乔乔已休息：等她回来或次晨兜底' });
  assert.equal(begin.mock.callCount(), 0, '没有读取牌组，也就没有抽卡轮或回 1 的分别');
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM turns WHERE trigger='cache_keepalive'").get() as { n: number }).n, 0);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM background_dispatches WHERE run_id='sleep-run'").get() as { n: number }).n, 0);

  // 同一时段的明确自主预约不受影响：照常执行，并经工具正式发言。
  assert.deepEqual(await wake(), { outcome: 'completed', result_code: 'complete:done' });
  assert.equal(requests.length, 2);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM messages m JOIN message_revisions r ON r.message_id=m.id WHERE r.content='到点了，这是预约要说的话'").get() as { n: number }).n, 1);

  // 她明确回来后，仍按原真实活动和缓存资格计算：预约那次真实请求已把目标推后 50 分钟。
  assert.equal(ctx.activity.noteRestDecision('c1', { kind: 'resume', source: 'owner_message', messageId: 'owner-morning', atIso: iso }), true);
  assert.equal(ctx.activity.resting('c1'), false);
  assert.deepEqual(await ctx.supervisor.enqueueBackground('c1', run), { outcome: 'noop', result_code: 'KEEPWARM_SUPERSEDED', detail: '目标已被新证据推后' }, '恢复不重排锚点，也不补偿休息期间的机会');
  // 五十分钟过去，期间没有新的真实消息。
  nowRef.nowMs += 3_000_001;
  const anchor = new Date(nowRef.nowMs - 3_000_001).toISOString();
  ctx.db.prepare("UPDATE conversation_activity SET last_real_activity_at=?, maintenance_request_id=NULL WHERE conversation_id='c1'").run(anchor);
  ctx.db.prepare('UPDATE provider_requests SET dispatch_started_at=?').run(anchor);
  assert.deepEqual(await ctx.supervisor.enqueueBackground('c1', run), { outcome: 'completed', result_code: 'complete:done' });
  assert.equal(begin.mock.callCount(), 1);
});
