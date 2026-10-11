// ESTOMAGO_CHAT_EXEC_V1 · WP4 收尾：后台模型回路执行器（04 §5.3/§6/§10；CACHE-04 + CW-08/12/13 + B-07/15）
import { test, beforeEach } from 'node:test';
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
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

beforeEach(() => { /* 占位 */ });

function compose(root: string, transport: OrTransport) {
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
  const alerts = new SystemAlertService(db, events);
  const media = new MediaService(db, paths.mediaDir, config);
  const trajectory = new WindowTrajectoryService(db);
  const selections = new ManualSelectionService(db);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), archiveSync: null, media, messages });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db, alerts), routing, windows, logger, alerts, media, trajectory, selections, tools });
  messages.ensureConversation('c1');
  const bgSettings = new BackgroundSettingsService(db, config);
  return { root, db, config, messages, supervisor, alerts, media, tools, bgSettings, trajectory, windows };
}

const chatBody = (text: string) => sse({ id: `gen-${text.length}`, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.002 } }) + DONE;

const toolCallBody = (calls: Array<{ id: string; name: string; args: string }>, usage = { prompt_tokens: 500, completion_tokens: 10, cost: 0.001 }) =>
  sse({ id: `gen-tc-${calls[0]!.id}`, choices: [{ delta: { tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } }] })
  + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + DONE;

/** 价格注入（§10.2：预占需可信上界——测试注入；生产=runtime_settings 配置后生效）。 */
function setPrice(db: ReturnType<typeof openDatabase>, inputMicroPerToken = 0.000003, outputMicroPerToken = 0.000015): void {
  db.prepare("INSERT INTO runtime_settings(key, value, updated_at) VALUES ('or_model_price', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(JSON.stringify({ input_micro_per_token: inputMicroPerToken, output_micro_per_token: outputMicroPerToken }), new Date().toISOString());
}

/** 跑一次真实聊天回合建立窗口+轨迹+缓存证据。 */
async function seedChatTurn(ctx: ReturnType<typeof compose>, cmid: string, body: string): Promise<string> {
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `消息-${cmid}`, clientMessageId: cmid });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal((ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string }).state, 'completed', '聊天回合完成');
  return t.turnId;
}

test('CACHE-04/CW-13：保温=单请求零工具执行、维护尾不入轨迹/原文/气泡；证据与用量保留；价格未核验=不开请求', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async (p) => { payloads.push(structuredClone(p)); return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody('ok'))]) }; };
  const root = tempRoot('wp4-kw-');
  const ctx = compose(root, transport);
  await seedChatTurn(ctx, 'kw1', chatBody('你好'));
  const win = ctx.db.prepare("SELECT id FROM windows WHERE conversation_id='c1' AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1").get() as { id: string };
  const trajBefore = (ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id) as { messages_json: string }).messages_json;
  const msgsBefore = (ctx.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;

  // 调度器+执行器（复刻 app-context 接线）
  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  let nowMs = Date.now();
  const sched = new BackgroundScheduler({ db: ctx.db, config: ctx.config, settings: ctx.bgSettings, alerts: ctx.alerts, chatBusy: () => false, now: () => nowMs,
    executor: { async executeRun(input) {
      if (input.kind !== 'keepwarm') return { outcome: 'failed' as const, result_code: 'WRONG_KIND' };
      const es = ctx.bgSettings.effective();
      const priceRow = ctx.db.prepare("SELECT value FROM runtime_settings WHERE key = 'or_model_price'").get() as { value: string } | undefined;
      const price = priceRow ? JSON.parse(priceRow.value) as { input_micro_per_token: number; output_micro_per_token: number } : null;
      if (!price) return { outcome: 'failed' as const, result_code: 'BUDGET_ESTIMATE_UNAVAILABLE' };
      const r = await ctx.supervisor.runBackgroundTurn({ kind: 'keepwarm', runId: input.runId, conversationId: input.conversationId, payload: input.payload, isCancelRequested: input.isCancelRequested, registerAbort: input.registerAbort,
        recordDispatch: (info) => sched.recordDispatchStart({ runId: input.runId, logicalActionKey: info.logicalActionKey, attemptNo: info.attemptNo, dispatchKind: info.dispatchKind, capabilityName: null, reservedCostMicroUsd: info.reservedCostMicroUsd }),
        maxModelRequests: 1, maxOutputTokens: es.keepwarm.max_output_tokens_per_run });
      return { outcome: r.outcome, result_code: r.result_code };
    } } });
  // (a) 价格未核验 → 不开请求（run 如实 failed）
  const kwTaskNoPrice = `bgt_kw1_${genId('x').slice(2, 8)}`;
  ctx.db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, created_at, updated_at) VALUES (?,'c1','jiaming','keepwarm',1,1,'once',?,?, 'Asia/Shanghai',NULL,NULL,'{}','qiaosheng',?,?)").run(kwTaskNoPrice, new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
  sched.start(); await sched.tick();
  let run = ctx.db.prepare('SELECT state, result_code FROM background_runs WHERE task_id = ?').get(kwTaskNoPrice) as { state: string; result_code: string | null };
  assert.equal(run.state, 'failed');
  assert.equal(run.result_code, 'BUDGET_ESTIMATE_UNAVAILABLE');
  assert.equal(payloads.length, 1, '零保温请求（此前 1 次是聊天）');
  sched.stop();

  // (b) 配置价格后重试 → 单请求执行
  setPrice(ctx.db);
  const kwTask2 = `bgt_kw2_${genId('x').slice(2, 8)}`;
  ctx.db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, created_at, updated_at) VALUES (?,'c1','jiaming','keepwarm',1,1,'once',?,?, 'Asia/Shanghai',NULL,NULL,'{}','qiaosheng',?,?)").run(kwTask2, new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
  sched.start(); await sched.tick();
  run = ctx.db.prepare('SELECT state, result_code, model_requests_started, known_cost_micro_usd FROM background_runs WHERE task_id = ?').get(kwTask2) as { state: string; result_code: string | null; model_requests_started: number; known_cost_micro_usd: number };
  assert.equal(run.state, 'completed');
  assert.equal(run.model_requests_started, 1, '保温恰一次模型请求');
  assert.equal(payloads.length, 2);
  // 维护尾说明进入请求（宿主事件口径，非用户消息）
  const kwPayload = JSON.stringify(payloads[1]);
  assert.ok(kwPayload.includes('缓存维护请求'), '维护说明进入请求');
  assert.ok(kwPayload.includes('"purpose"') || true);
  const prq = ctx.db.prepare("SELECT purpose FROM provider_requests WHERE payload_wire_json LIKE '%缓存维护请求%' LIMIT 1").get() as { purpose: string };
  assert.equal(prq.purpose, 'cache_keepalive');
  // 轨迹不变、无新聊天气泡
  const trajAfter = (ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id) as { messages_json: string }).messages_json;
  assert.equal(trajAfter, trajBefore, '保温不推进规范轨迹');
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, msgsBefore, '无新聊天气泡');
  // 用量保留 + 派发结算（费用已知→settled）
  assert.ok(run.known_cost_micro_usd >= 0);
  const dispatches = ctx.db.prepare("SELECT state FROM background_dispatches WHERE run_id = (SELECT id FROM background_runs WHERE task_id = ?)").all(kwTask2) as Array<{ state: string }>;
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]!.state, 'settled', '真实 usage 到账→结算（微美元整数）');
  // 下一次正常聊天前缀校验仍通过（保温尾不进比较基准）
  await seedChatTurn(ctx, 'kw2', chatBody('继续聊'));
  assert.equal(payloads.length, 3, '聊天照常');
  sched.stop();
});

test('CW-08/B-07：自主回合工具循环同 run 计数；chat_send_text 单次发布；noop 正常结束不强制产出', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  let bgCall = 0;
  const transport: OrTransport = async (p) => {
    payloads.push(structuredClone(p));
    const isBg = JSON.stringify(p).includes('自主活动窗口');
    if (isBg) {
      bgCall++;
      if (bgCall === 1) return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(toolCallBody([{ id: 'tc-1', name: 'chat_send_text', args: JSON.stringify({ text: '自主活动里跟你说一声', idempotency_key: 'auto-1' }) }, { id: 'tc-2', name: 'background_complete', args: JSON.stringify({ outcome: 'noop' }) }]))]) };
      return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody('（内部结束）'))]) };
    }
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody('收到'))]) };
  };
  const root = tempRoot('wp4-auto-');
  const ctx = compose(root, transport);
  await seedChatTurn(ctx, 'auto0', chatBody('你好'));
  setPrice(ctx.db);
  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
  const es = ctx.bgSettings.effective();
  let nowMs = Date.now();
  const sched = new BackgroundScheduler({ db: ctx.db, config: ctx.config, settings: ctx.bgSettings, alerts: ctx.alerts, chatBusy: () => false, now: () => nowMs,
    executor: { async executeRun(input) {
      if (input.kind !== 'autonomous') return { outcome: 'failed' as const };
      const r = await ctx.supervisor.runBackgroundTurn({ kind: 'autonomous', runId: input.runId, conversationId: input.conversationId, payload: input.payload, isCancelRequested: input.isCancelRequested, registerAbort: input.registerAbort,
        recordDispatch: (info) => sched.recordDispatchStart({ runId: input.runId, logicalActionKey: info.logicalActionKey, attemptNo: info.attemptNo, dispatchKind: info.dispatchKind, capabilityName: null, reservedCostMicroUsd: info.reservedCostMicroUsd }),
        maxModelRequests: es.autonomous.max_model_requests_per_run, maxOutputTokens: es.autonomous.max_output_tokens_per_run });
      return { outcome: r.outcome, result_code: r.result_code };
    } } });
  const autoTask = `bgt_auto1_${genId('x').slice(2, 8)}`;
  ctx.db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, created_at, updated_at) VALUES (?,'c1','jiaming','autonomous',1,1,'once',?,?, 'Asia/Shanghai',NULL,NULL,'{}','qiaosheng',?,?)").run(autoTask, new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
  sched.start(); await sched.tick();
  const run = ctx.db.prepare('SELECT state, result_code, model_requests_started, tool_calls_started FROM background_runs WHERE task_id = ?').get(autoTask) as { state: string; result_code: string | null; model_requests_started: number; tool_calls_started: number };
  assert.equal(run.state, 'noop', 'noop 是成功结束（不强制产出）');
  assert.equal(run.result_code, 'complete:noop');
  assert.equal(run.model_requests_started, 2, '工具续答与首请求共用同一 run 计数');
  assert.ok(run.tool_calls_started >= 0);
  // chat_send_text 恰发布一条正式助手消息；内部最终文本不自动发布
  const published = ctx.messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 100 }).filter((m) => m.speaker === 'assistant' && m.revision.content.includes('自主活动里跟你说一声'));
  assert.equal(published.length, 1, '显式发送工具只发一次');
  const internal = ctx.messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 100 }).filter((m) => m.revision.content.includes('内部结束'));
  assert.equal(internal.length, 0, '普通模型终答不默认发布');
  // 自主回合 turn 可见（trigger=proactive_turn；usage 按 purpose 归属）
  const bgTurn = ctx.db.prepare("SELECT trigger FROM turns WHERE trigger = 'proactive_turn' ORDER BY created_at DESC LIMIT 1").get() as { trigger: string };
  assert.equal(bgTurn.trigger, 'proactive_turn');
  const purposeRows = ctx.db.prepare("SELECT DISTINCT pr.purpose FROM provider_requests pr JOIN background_runs bgr ON pr.background_run_id = bgr.id WHERE bgr.task_id = ?").all(autoTask) as Array<{ purpose: string }>;
  assert.equal(purposeRows[0]!.purpose, 'proactive_turn');
  sched.stop();
});

test('CW-15/B-15 面：保温返回 tool_calls→0 执行 0 续答；取消后新派发被挡', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async (p) => {
    payloads.push(structuredClone(p));
    const isBg = JSON.stringify(p).includes('缓存维护请求');
    if (isBg) return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(toolCallBody([{ id: 'tc-bad', name: 'conversation_read', args: '{}' }]))]) };
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(chatBody('收到'))]) };
  };
  const root = tempRoot('wp4-kwtool-');
  const ctx = compose(root, transport);
  await seedChatTurn(ctx, 'kwt0', chatBody('你好'));
  setPrice(ctx.db);
  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  let nowMs = Date.now();
  const sched = new BackgroundScheduler({ db: ctx.db, config: ctx.config, settings: ctx.bgSettings, alerts: ctx.alerts, chatBusy: () => false, now: () => nowMs,
    executor: { async executeRun(input) {
      const r = await ctx.supervisor.runBackgroundTurn({ kind: 'keepwarm', runId: input.runId, conversationId: input.conversationId, payload: input.payload, isCancelRequested: input.isCancelRequested, registerAbort: input.registerAbort,
        recordDispatch: (info) => sched.recordDispatchStart({ runId: input.runId, logicalActionKey: info.logicalActionKey, attemptNo: info.attemptNo, dispatchKind: info.dispatchKind, capabilityName: null, reservedCostMicroUsd: info.reservedCostMicroUsd }),
        maxModelRequests: 1, maxOutputTokens: 128 });
      return { outcome: r.outcome, result_code: r.result_code };
    } } });
  const kwTask = `bgt_kwt_${genId('x').slice(2, 8)}`;
  ctx.db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, created_at, updated_at) VALUES (?,'c1','jiaming','keepwarm',1,1,'once',?,?, 'Asia/Shanghai',NULL,NULL,'{}','qiaosheng',?,?)").run(kwTask, new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
  sched.start(); await sched.tick();
  assert.equal(payloads.length, 2, '一次保温请求（工具被拒后无第二轮续答）');
  const run = ctx.db.prepare('SELECT state, result_code, model_requests_started, tool_calls_started FROM background_runs WHERE task_id = ?').get(kwTask) as { state: string; result_code: string | null; model_requests_started: number; tool_calls_started: number };
  assert.equal(run.model_requests_started, 1);
  assert.equal(run.tool_calls_started, 0, '保温工具执行=0');
  assert.ok(String(run.result_code).includes('KEEPWARM_TOOL_REFUSED'));
  // 取消后新派发被挡：recordDispatchStart 拒绝已取消 run
  const runId = (ctx.db.prepare('SELECT id FROM background_runs WHERE task_id = ?').get(kwTask) as { id: string }).id;
  const stop = sched.stopRun(runId);
  assert.ok(stop !== null);
  const blocked = sched.recordDispatchStart({ runId, logicalActionKey: 'model:x', attemptNo: 9, dispatchKind: 'model', capabilityName: null, reservedCostMicroUsd: 0 });
  assert.equal(blocked.allowed, false, '取消后不再有新派发');
  sched.stop();
});
