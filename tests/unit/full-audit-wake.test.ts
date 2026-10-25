import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeDb } from '../helpers.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { BackgroundTaskService } from '../../apps/host/src/runtime/background-task-service.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';
import { TurnSupervisor, type SupervisorDeps } from '../../apps/host/src/runtime/supervisor.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';

function fixture(t: TestContext) {
  const { db, root } = makeDb();
  const config = buildConfig({ background: { keepwarm: { sleep_window: { enabled: false } } } });
  let now = Date.parse('2026-10-23T12:00:00+08:00');
  const settings = new BackgroundSettingsService(db, config);
  settings.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 1 } });
  const service = new BackgroundTaskService(db, settings, () => now);
  const calls: string[] = [];
  const scheduler = new BackgroundScheduler({ db, config, settings, now: () => now, alerts: new SystemAlertService(db, new EventService(db)), tickMs: 60_000, executor: { async executeRun(input) { calls.push(input.taskId); return { outcome: 'noop' }; } } });
  t.after(() => { scheduler.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const schedule = (operationId = 'create', delaySeconds = 60) => {
    const result = service.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId, note: '合成预约原文', delaySeconds, createdBy: 'jiaming' });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error(result.code);
    return result.task;
  };
  const seedRun = (taskId: string, state = 'running', runId = 'run-a') => {
    const iso = new Date(now).toISOString();
    db.prepare('INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at) VALUES (?,?,\'primary\',\'jiaming\',\'autonomous\',1,?,?,?,?)').run(runId, taskId, `wake:${taskId}:1`, state, iso, iso);
  };
  const dispatch = (key = 'model:1', estimate = 10) => scheduler.recordDispatchStart({ runId: 'run-a', logicalActionKey: key, attemptNo: 1, dispatchKind: 'model', capabilityName: null, reservedCostMicroUsd: estimate });
  return { db, config, settings, service, scheduler, calls, schedule, seedRun, dispatch, get now() { return now; }, setNow(value: number) { now = value; } };
}

test('F-W01 absolute schedule replay after due and disabled returns original receipt; no second task', t => {
  const f = fixture(t);
  const request = { actorId: 'jiaming', conversationId: 'primary', operationId: 'absolute', note: '合成原文', at: new Date(f.now + 1000).toISOString(), createdBy: 'jiaming' as const };
  const first = f.service.schedule(request);
  f.setNow(f.now + 2000);
  f.settings.applyUpdate({ expectedRevision: f.settings.revision(), patch: { autonomous_enabled: false } });
  const replay = f.service.schedule(request);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) { assert.deepEqual(replay.task, first.task); assert.equal(replay.duplicate, true); }
  assert.equal((f.db.prepare('SELECT COUNT(*) n FROM background_tasks').get() as { n: number }).n, 1);
});

test('F-W02 update replay preserves original due and receipt after later modification', t => {
  const f = fixture(t); const task = f.schedule();
  const request = { actorId: 'jiaming', conversationId: 'primary', operationId: 'update-a', taskId: task.task_id, expectedRevision: 1, delaySeconds: 30 };
  const first = f.service.update(request);
  assert.equal(first.ok, true);
  f.service.update({ ...request, operationId: 'update-b', expectedRevision: 2, delaySeconds: 120 });
  f.setNow(f.now + 31_000);
  f.settings.applyUpdate({ expectedRevision: f.settings.revision(), patch: { autonomous_enabled: false } });
  const replay = f.service.update(request);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) assert.deepEqual(replay.task, first.task, 'same operation returns its own receipt, not later task revision');
});

test('F-W03 disabled-period expiry without tick becomes needs_review before enable; explicit future reschedule restores it', t => {
  const f = fixture(t); const task = f.schedule();
  f.settings.applyUpdate({ expectedRevision: f.settings.revision(), patch: { autonomous_enabled: false } });
  // Host was stopped during the disabled interval; no scheduler tick can mark it.
  t.mock.timers.enable({ apis: ['Date'], now: f.now + 120_000 });
  f.setNow(f.now + 120_000);
  f.settings.applyUpdate({ expectedRevision: f.settings.revision(), patch: { autonomous_enabled: true } });
  const detail = f.service.detail({ actorId: 'jiaming', conversationId: 'primary', taskId: task.task_id });
  assert.equal(detail.ok && detail.task.status, 'needs_review');
  const updated = f.service.update({ actorId: 'jiaming', conversationId: 'primary', taskId: task.task_id, operationId: 'resume', expectedRevision: 1, delaySeconds: 60 });
  assert.equal(updated.ok && updated.task.status, 'scheduled');
  assert.equal((f.db.prepare('SELECT control_reason FROM background_tasks WHERE id = ?').get(task.task_id) as { control_reason: string | null }).control_reason, null);
});

test('F-W04 completed and all review statuses are distinct from scheduled/cancelled', t => {
  const f = fixture(t); const task = f.schedule();
  for (const reason of ['disabled_missed_needs_review', 'unknown_needs_review', 'failed_needs_review']) {
    f.db.prepare('UPDATE background_tasks SET control_reason = ? WHERE id = ?').run(reason, task.task_id);
    const detail = f.service.detail({ actorId: 'jiaming', conversationId: 'primary', taskId: task.task_id });
    assert.equal(detail.ok && detail.task.status, 'needs_review', reason);
  }
  f.db.prepare("UPDATE background_tasks SET control_reason = 'delivered', enabled = 0 WHERE id = ?").run(task.task_id);
  const done = f.service.detail({ actorId: 'jiaming', conversationId: 'primary', taskId: task.task_id });
  assert.equal(done.ok && done.task.status, 'completed');
});

test('F-W05 running zero-dispatch crash recovers original occurrence; dispatched crash remains unknown', async t => {
  const f = fixture(t); const task = f.schedule('recover', 1);
  f.seedRun(task.task_id);
  f.setNow(f.now + 2000); f.scheduler.start(); await f.scheduler.tick();
  assert.deepEqual(f.calls, [task.task_id]);
  assert.equal((f.db.prepare("SELECT state FROM background_runs WHERE id = 'run-a'").get() as { state: string }).state, 'skipped');
  const task2 = f.schedule('unknown', 1); f.seedRun(task2.task_id, 'running', 'run-b');
  const iso = new Date(f.now).toISOString();
  f.db.prepare("INSERT INTO background_dispatches(id,run_id,logical_action_key,attempt_no,dispatch_kind,state,budget_day,reserved_cost_micro_usd,created_at) VALUES ('d-b','run-b','m1',1,'model','reserved','2026-10-23',10,?)").run(iso);
  f.scheduler.recoverOnStart(); f.setNow(f.now + 2000); await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal((f.db.prepare("SELECT state FROM background_runs WHERE id = 'run-b'").get() as { state: string }).state, 'unknown');
});

test('F-W06 dispatch rechecks durable switch and task revision, even without local abort callback', t => {
  const f = fixture(t); const task = f.schedule(); f.seedRun(task.task_id);
  f.settings.applyUpdate({ expectedRevision: f.settings.revision(), patch: { autonomous_enabled: false } });
  assert.equal(f.dispatch('disabled').allowed, false);
  f.settings.applyUpdate({ expectedRevision: f.settings.revision(), patch: { autonomous_enabled: true } });
  f.service.update({ actorId: 'jiaming', conversationId: 'primary', operationId: 'edit', taskId: task.task_id, expectedRevision: 1, note: '新备注' });
  assert.equal(f.dispatch('old-revision').allowed, false);
  assert.equal((f.db.prepare('SELECT COUNT(*) n FROM background_dispatches').get() as { n: number }).n, 0);
});

test('F-W07 real dispatch rejects unconfigured budget and invalid reservations; settings validate finite caps', t => {
  const f = fixture(t); const task = f.schedule(); f.seedRun(task.task_id);
  for (const cap of [-1, 0, NaN, Infinity]) assert.throws(() => f.settings.applyUpdate({ expectedRevision: f.settings.revision(), patch: { autonomous_daily_cost_cap_usd: cap } }), /BUDGET/);
  for (const estimate of [-1, NaN, Infinity]) assert.equal(f.dispatch('bad', estimate).allowed, false);
  f.settings.applyUpdate({ expectedRevision: f.settings.revision(), patch: { autonomous_daily_cost_cap_usd: null } });
  assert.equal(f.dispatch('no-cap').allowed, false);
});

test('F-W08 background per-run budget policy runs at actual dispatch; settled accounting is idempotent', t => {
  const f = fixture(t); const task = f.schedule(); f.seedRun(task.task_id);
  for (let i = 0; i < 4; i++) assert.equal(f.dispatch(`m${i}`).allowed, true);
  assert.equal(f.dispatch('m5').allowed, false, 'autonomous configured per-run request budget');
});

test('F-W09 clock regression retains high-water mark until time catches up', async t => {
  const f = fixture(t); f.scheduler.start(); await f.scheduler.tick();
  const original = f.now;
  f.setNow(original - 60_000); await f.scheduler.tick();
  const task = f.schedule('regression', 1);
  f.setNow(original - 30_000); await f.scheduler.tick();
  assert.deepEqual(f.calls, [], 'second regressed tick must remain paused');
  f.setNow(original + 1000); await f.scheduler.tick(); assert.deepEqual(f.calls, [task.task_id]);
});

test('F-W10 claim database error is not swallowed as a duplicate occurrence', async t => {
  const f = fixture(t); f.schedule('db-error', 1); f.setNow(f.now + 2000);
  f.db.exec("CREATE TRIGGER reject_background_claim BEFORE INSERT ON background_runs BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END;");
  f.scheduler.start();
  await assert.rejects(f.scheduler.tick(), /BACKGROUND_CLAIM_FAILED/);
});

test('F-W11 user-configured cap supports enabling; explicit null cannot inherit the previous cap', t => {
  const f = fixture(t);
  const configured = new BackgroundSettingsService(f.db, buildConfig({ background: { keepwarm: { daily_cost_cap_usd: 1 } } }));
  assert.doesNotThrow(() => configured.applyUpdate({ expectedRevision: configured.revision(), patch: { keepwarm_enabled: true } }));
  assert.throws(() => configured.applyUpdate({ expectedRevision: configured.revision(), patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: null } }), /BUDGET_NOT_CONFIGURED/);
});

test('F-W12 invalid civil dates and out-of-range relative timestamps are explicit validation errors', t => {
  const f = fixture(t);
  const invalid = f.service.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: 'invalid-date', note: '合成', at: '2027-02-30T12:00:00+08:00', createdBy: 'jiaming' });
  assert.equal(invalid.ok, false);
  assert.doesNotThrow(() => { const huge = f.service.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: 'huge-delay', note: '合成', delaySeconds: Number.MAX_SAFE_INTEGER, createdBy: 'jiaming' }); assert.equal(huge.ok, false); });
});

test('F-W13 settings idempotency retries reuse original revision; conflicting request is rejected', t => {
  const f = fixture(t);
  const request = { expectedRevision: f.settings.revision(), operationId: 'toggle-once', patch: { autonomous_enabled: false } };
  const first = f.settings.applyUpdate(request);
  assert.deepEqual(f.settings.applyUpdate(request), { revision: first.revision, duplicate: true });
  assert.throws(() => f.settings.applyUpdate({ ...request, patch: { autonomous_enabled: true } }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(f.settings.revision(), first.revision);
});

test('F-W14 keepwarm tool turns use the normal run timeout, not obsolete 30-second pure-cache limit', t => {
  const f = fixture(t);
  f.settings.applyUpdate({ expectedRevision: f.settings.revision(), patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  f.seedRun('bgt_keepwarm_system');
  f.db.prepare("UPDATE background_runs SET kind='keepwarm' WHERE id='run-a'").run();
  assert.equal(f.dispatch('before').allowed, true);
  f.setNow(f.now + 31_000);
  assert.equal(f.dispatch('after-31s').allowed, true);
  f.setNow(f.now + f.config.background.autonomous.max_run_ms);
  assert.equal(f.dispatch('over-normal-timeout').allowed, false);
});

test('F-W15 missing window waits on the same run and original due; later available window executes once', async t => {
  const f = fixture(t); const task = f.schedule('window-wait', 1); f.setNow(f.now + 2000);
  let available = false; const runIds: string[] = [];
  const scheduler = new BackgroundScheduler({ db: f.db, config: f.config, settings: f.settings, now: () => f.now, alerts: new SystemAlertService(f.db, new EventService(f.db)), tickMs: 60_000, executor: { async executeRun(input) { runIds.push(input.runId); return available ? { outcome: 'noop' } : { outcome: 'failed', result_code: 'NO_ACTIVE_WINDOW' }; } } });
  t.after(() => scheduler.stop()); scheduler.start();
  await scheduler.tick(); await scheduler.tick();
  assert.equal(new Set(runIds).size, 1, 'waiting does not manufacture new business runs every tick');
  const waiting = f.service.detail({ actorId: 'jiaming', conversationId: 'primary', taskId: task.task_id });
  assert.equal(waiting.ok && waiting.task.scheduled_at, task.scheduled_at);
  assert.equal(waiting.ok && waiting.task.status, 'scheduled');
  available = true; await scheduler.tick(); await scheduler.tick();
  assert.equal(runIds.length, 3, 'three execution-position checks, then terminal; zero provider calls in this fixture');
  const done = f.service.detail({ actorId: 'jiaming', conversationId: 'primary', taskId: task.task_id }); assert.equal(done.ok && done.task.status, 'completed');
});

test('F-W16 orderly host stop while queued preserves a zero-dispatch wake for restart', async t => {
  const f = fixture(t); const task = f.schedule('host-stop', 1); f.setNow(f.now + 2000);
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }); let attempts = 0;
  const scheduler = new BackgroundScheduler({ db: f.db, config: f.config, settings: f.settings, now: () => f.now, alerts: new SystemAlertService(f.db, new EventService(f.db)), tickMs: 60_000, executor: { async executeRun() { attempts++; if (attempts === 1) { entered(); await new Promise<void>(resolve => { release = resolve; }); } return { outcome: 'noop' }; } } });
  t.after(() => scheduler.stop()); scheduler.start(); const first = scheduler.tick(); await ready; scheduler.stop(); release(); await first;
  scheduler.start(); await scheduler.tick(); await scheduler.tick();
  assert.equal(attempts, 2, 'only the second check delivers; stopped first check had zero dispatch');
  const done = f.service.detail({ actorId: 'jiaming', conversationId: 'primary', taskId: task.task_id }); assert.equal(done.ok && done.task.status, 'completed');
});

test('F-W18 same-due appointments precede keepwarm, share FIFO with later user work, and all keep original due', async t => {
  const f = fixture(t); const tasks = [f.schedule('fair-a', 1), f.schedule('fair-b', 1), f.schedule('fair-c', 1)]; f.setNow(f.now + 2000);
  f.settings.applyUpdate({ expectedRevision: f.settings.revision(), patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  const iso = new Date(f.now).toISOString();
  new MessageService(f.db).ensureConversation('primary');
  f.db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('fair-win','primary','ACTIVE',?,?)").run(iso, iso);
  new ConversationActivityService(f.db).noteRealPublication('primary', 'synthetic', 1, new Date(Date.parse(tasks[0]!.scheduled_at!) - 3_000_000).toISOString());
  const supervisor = new TurnSupervisor({ db: f.db, config: f.config, logger: { info() {}, warn() {}, error() {} } } as unknown as SupervisorDeps);
  let release!: () => void; let entered!: () => void; let active = 0, maxActive = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const order: string[] = [];
  const work = async (name: string) => { active++; maxActive = Math.max(active, maxActive); order.push(name); await new Promise<void>(resolve => setTimeout(resolve, 1)); active--; };
  const currentChat = supervisor.enqueueBackground('primary', async () => { active++; maxActive = Math.max(active, maxActive); entered(); await new Promise<void>(resolve => { release = resolve; }); active--; });
  await started;
  const scheduler = new BackgroundScheduler({ db: f.db, config: f.config, settings: f.settings, now: () => f.now, alerts: new SystemAlertService(f.db, new EventService(f.db)), tickMs: 60_000, executor: { async executeRun(input) { await supervisor.enqueueBackground(input.conversationId, () => work(input.kind + ':' + input.taskId)); return { outcome: 'noop' }; } } });
  t.after(() => scheduler.stop()); scheduler.start(); const tick = scheduler.tick();
  const laterUser = Array.from({ length: 10 }, (_, i) => supervisor.enqueueBackground('primary', () => work(`user-${i}`)));
  release(); await currentChat; await tick; await Promise.all(laterUser);
  assert.equal(maxActive, 1);
  assert.ok(order[0]!.startsWith('autonomous:'), 'first due wake was enqueued before later user work');
  const bg = order.filter(item => !item.startsWith('user-'));
  assert.equal(bg.length, 4); assert.ok(bg.slice(0, 3).every(item => item.startsWith('autonomous:'))); assert.ok(bg[3]!.startsWith('keepwarm:'));
  for (const task of tasks) assert.equal((f.db.prepare('SELECT scheduled_at FROM background_tasks WHERE id=?').get(task.task_id) as { scheduled_at: string }).scheduled_at, task.scheduled_at);
});

test('F-W19 late maintenance receipt cannot replace a newer receipt even without new real activity', t => {
  const f = fixture(t); const activity = new ConversationActivityService(f.db);
  activity.noteRealPublication('primary', 'synthetic', 1, new Date(f.now - 3_600_000).toISOString());
  const revision = activity.get('primary')!.activity_revision;
  assert.equal(activity.noteMaintenanceReceipt({ conversationId: 'primary', capturedActivityRevision: revision, requestId: 'new-receipt', windowId: 'new-window', dispatchStartedAtIso: new Date(f.now).toISOString() }), true);
  assert.equal(activity.noteMaintenanceReceipt({ conversationId: 'primary', capturedActivityRevision: revision, requestId: 'late-old-receipt', windowId: 'old-window', dispatchStartedAtIso: new Date(f.now - 3_000_000).toISOString() }), false);
  assert.equal(activity.get('primary')!.maintenance_request_id, 'new-receipt');
  const target = activity.nextKeepwarmTarget({ conversationId: 'primary', windowId: 'new-window' });
  assert.equal(target.scheduled && target.dueAtMs, f.now + 3_000_000);
});
