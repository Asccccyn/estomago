// Actual Supervisor → HostToolExecutor → scheduler ledger. Both provider and
// remote service transports are fake; no credentials or external requests.
import { assembleTestTools, makeDb, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundTaskService } from '../../apps/host/src/runtime/background-task-service.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { quoteBackgroundTool, BACKGROUND_TOOL_PRICES_KEY } from '../../apps/host/src/runtime/background-tool-cost.ts';

const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const textReply = sse({ choices: [{ delta: { content: '合成完成' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cost: 0.000001 } }) + 'data: [DONE]\n\n';

async function fixture(t: TestContext) {
  const root = tempRoot('audit-tool-budget-'); writeApprovedIdentity(root); const { db } = makeDb(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter', tool_schema_mode: 'legacy' }, openrouter: { model: 'anthropic/claude-test-1' } });
  const paths = buildPaths(root), events = new EventService(db), messages = new MessageService(db), identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages), windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const settings = new BackgroundSettingsService(db, config); settings.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 0.1 } });
  const alerts = new SystemAlertService(db, events);
  let now = Date.now(), externalCalls = 0, round = 0, runNo = 0;
  let mode: 'seed' | 'external' | 'free' = 'seed';
  const taskService = new BackgroundTaskService(db, settings, () => now);
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages: messages, events: events, wishstar: { async forward() { externalCalls++; return { status: 200, body: { dates: [] } }; } }, taskService: taskService });
  const payloads: Record<string, unknown>[] = [];
  const transport: OrTransport = async payload => {
    payloads.push(structuredClone(payload)); round++;
    const name = mode === 'free' ? 'chat_send_text' : 'wishstar_special_dates';
    const args = mode === 'free' ? { text: '合成正式后台发言', idempotency_key: `free-${runNo}` } : {};
    const call = sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${runNo}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cost: 0.000001 } }) + 'data: [DONE]\n\n';
    return { status: 200, headers: new Map(), body: Readable.from([Buffer.from(mode !== 'seed' && round === 1 ? call : textReply)]) };
  };
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db, alerts), routing, windows, logger: new Logger(null), tools, trajectory: new WindowTrajectoryService(db), now: () => now });
  const scheduler = new BackgroundScheduler({ db, config, settings, alerts, now: () => now, tickMs: 60_000,
    executor: { async executeRun(input) {
      if (input.kind === 'reminder') return { outcome: 'noop' };
      return supervisor.enqueueBackground(input.conversationId, () => supervisor.runBackgroundTurn({ kind: input.kind as 'autonomous' | 'keepwarm', runId: input.runId, conversationId: input.conversationId, payload: input.payload, isCancelRequested: input.isCancelRequested, registerAbort: input.registerAbort, maxModelRequests: settings.effective().autonomous.max_model_requests_per_run,
        recordDispatch: info => scheduler.recordDispatchStart({ runId: input.runId, ...info, capabilityName: info.capabilityName ?? null }) }));
    } } });
  t.after(() => { scheduler.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  messages.ensureConversation('primary'); const seed = messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '合成种子聊天', clientMessageId: 'seed' });
  supervisor.enqueue(seed.turnId); await supervisor.waitIdle();
  assert.equal((db.prepare('SELECT state FROM turns WHERE id=?').get(seed.turnId) as { state: string }).state, 'completed');
  db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES ('or_model_price',?,?)").run(JSON.stringify({ input_micro_per_token: 0.001, output_micro_per_token: 0.001 }), new Date(now).toISOString());
  scheduler.start();
  const setQuote = (price: unknown) => db.prepare('INSERT INTO runtime_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(BACKGROUND_TOOL_PRICES_KEY, JSON.stringify({ wishstar_special_dates: { max_cost_micro_usd: price } }), new Date(now).toISOString());
  const run = async (nextMode: 'external' | 'free' = 'external') => {
    runNo++; round = 0; mode = nextMode;
    const scheduled = taskService.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: `schedule-${runNo}`, note: '合成后台工具预算', delaySeconds: 1, createdBy: 'jiaming' }); assert.equal(scheduled.ok, true); if (!scheduled.ok) throw new Error(scheduled.code);
    now += 1001; await scheduler.tick();
    return db.prepare('SELECT id,state,result_code,reserved_cost_micro_usd,known_cost_micro_usd FROM background_runs WHERE task_id=?').get(scheduled.task.task_id) as { id: string; state: string; result_code: string; reserved_cost_micro_usd: number; known_cost_micro_usd: number };
  };
  return { db, config, tools, settings, supervisor, scheduler, run, setQuote, payloads, get externalCalls() { return externalCalls; } };
}

test('F-T01 no trusted external quote blocks before real handler and records no tool dispatch', async t => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(result.result_code, 'BUDGET_ESTIMATE_UNAVAILABLE'); assert.equal(f.externalCalls, 0);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM background_dispatches WHERE dispatch_kind='tool'").get() as { n: number }).n, 0);
  assert.equal(f.settings.effective().autonomous.daily_cost_cap_usd, 0.1, 'does not fill/raise cap');
});

test('F-T02 external upper-bound quote consumes same daily cap before dispatch; insufficient funds zero external calls', async t => {
  const f = await fixture(t); f.setQuote(200000); const result = await f.run();
  assert.equal(result.result_code, 'BACKGROUND_BUDGET_EXHAUSTED'); assert.equal(f.externalCalls, 0);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM background_dispatches WHERE dispatch_kind='tool'").get() as { n: number }).n, 0);
});

test('F-T03 successful external handler with no cost receipt retains positive reservation and blocks later overspend', async t => {
  const f = await fixture(t); f.setQuote(60000); const first = await f.run();
  assert.equal(f.externalCalls, 1); assert.equal(first.state, 'completed');
  const dispatch = f.db.prepare("SELECT capability_name,state,reserved_cost_micro_usd,actual_cost_micro_usd FROM background_dispatches WHERE run_id=? AND dispatch_kind='tool'").get(first.id) as Record<string, unknown>;
  assert.deepEqual({ ...dispatch }, { capability_name: 'wishstar_special_dates', state: 'unknown', reserved_cost_micro_usd: 60000, actual_cost_micro_usd: null });
  assert.equal(first.reserved_cost_micro_usd, 60000);
  const second = await f.run(); assert.equal(second.result_code, 'BACKGROUND_BUDGET_EXHAUSTED'); assert.equal(f.externalCalls, 1, 'unsettled first reservation prevents second external call');
});

test('F-T04 proven free successful publication settles actual zero and quote metadata never enters model output', async t => {
  const f = await fixture(t); const result = await f.run('free'); assert.equal(result.state, 'completed');
  const dispatch = f.db.prepare("SELECT capability_name,state,reserved_cost_micro_usd,actual_cost_micro_usd FROM background_dispatches WHERE run_id=? AND dispatch_kind='tool'").get(result.id) as Record<string, unknown>;
  assert.deepEqual({ ...dispatch }, { capability_name: 'chat_send_text', state: 'settled', reserved_cost_micro_usd: 0, actual_cost_micro_usd: 0 });
  assert.equal(f.externalCalls, 0);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE r.content='合成正式后台发言'").get() as { n: number }).n, 1);
  const wire = JSON.stringify(f.payloads); assert.equal(wire.includes('maxCostMicroUsd'), false); assert.equal(wire.includes('verifiedFree'), false); assert.equal(wire.includes('background_tool_prices'), false);
});

test('F-T05 malformed external quotes fail closed; existing schema/visibility checks precede quote admission', async t => {
  const f = await fixture(t);
  for (const price of [0, -1, 1.5, '1000', null]) { f.setQuote(price); assert.throws(() => quoteBackgroundTool(f.db, 'wishstar_special_dates'), /BUDGET_ESTIMATE_UNAVAILABLE/); }
  const windowId = (f.db.prepare("SELECT id FROM windows WHERE status='ACTIVE'").get() as { id: string }).id;
  let admissions = 0;
  const ctx: ToolExecContext = { roomId: 'primary', windowId, turnId: null, requestId: 'synthetic', purpose: 'proactive_turn', backgroundRunId: 'not-dispatched', activeReviewId: null, seenSequence: 0, seenMessages: [], beforeBackgroundTool() { admissions++; } };
  const invalid = await f.tools.execute('wishstar_special_dates', { unexpected: true }, ctx); assert.equal(invalid.ok, false);
  const hidden = await f.tools.execute('not_an_authorized_tool', {}, ctx); assert.equal(hidden.ok, false);
  assert.equal(admissions, 0); assert.equal(f.externalCalls, 0);
});
