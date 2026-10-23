import { keepwarmAdmission, keepwarmTargetMs, autonomousAdmission, canTransition } from '../reference/background-policy.ts';
// ESTOMAGO_CHAT_EXEC_V1 · WP4 地基（04 §4-§10）+ WAKE_KEEPWARM_V1（2026-10-22 改写）：
// 策略纯函数 + 设置原子开关 + 调度器（虚拟时钟/假 executor）。
// 2026-10-22 改写：60min 冷却（CW-06/07）与心跳零工具封锁（CW-13）按 U02/U06 退役；
// 聊天抢占改为心跳安全让位（S-05/S-06）；保温目标改由真实活动投影驱动（05）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex, genId } from '../../apps/host/src/util/id.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundScheduler, type BackgroundExecutor } from '../../apps/host/src/runtime/background-scheduler.ts';
import { budgetGate, restartDisposition, budgetDayOfMs, clockRegressionAction, effectiveSettings } from '../../apps/host/src/runtime/background-policy.ts';

function setup(over: { config?: Record<string, unknown>; now?: number; executor?: BackgroundExecutor } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-v1-wp4-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const alerts = new SystemAlertService(db, events);
  const config = buildConfig(over.config ?? {});
  const settings = new BackgroundSettingsService(db, config);
  const calls: Array<{ runId: string; kind: string }> = [];
  const executor: BackgroundExecutor = over.executor ?? {
    async executeRun(input) { calls.push({ runId: input.runId, kind: input.kind }); return { outcome: input.kind === 'reminder' ? 'completed' : 'noop', result_code: input.kind === 'reminder' ? 'delivered' : 'noop' }; },
  };
  let nowMs = over.now ?? Date.parse('2026-10-11T02:00:00.000Z');
  const sched = new BackgroundScheduler({ db, config, settings, alerts, executor, now: () => nowMs, tickMs: 1 });
  return { root, db, alerts, config, settings, sched, calls, setNow: (iso: string) => { nowMs = Date.parse(iso); }, get now() { return nowMs; } };
}

function seedTask(db: ReturnType<typeof openDatabase>, over: Partial<{ kind: string; schedule_kind: string; next_due_at: string | null; enabled: number; interval_ms: number | null; actor: string; payload: string }> = {}) {
  const id = `bgt_${genId('x').slice(2)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'Asia/Shanghai',?,?,?,'qiaosheng',?,?)`,
  ).run(id, 'primary', over.actor ?? 'jiaming', over.kind ?? 'reminder', over.enabled ?? 1, 1, over.schedule_kind ?? 'once', over.next_due_at ?? null, over.next_due_at ?? null, null, over.interval_ms ?? null, over.payload ?? '{}', now, now);
  return id;
}

// —— 策略纯函数（虚拟时钟语义；2026-10-22 版合同）——
test('U02 退役核验：60 分钟冷却函数已删除（不是留死分支）；常量面同步退役', async () => {
  const policyNs = await import('../../apps/host/src/runtime/background-policy.ts');
  assert.equal('autonomousCooldownDueAtMs' in policyNs, false, '冷却函数已删除');
});

test('CW-03 策略（2026-10-22 版）：保温准入=开关/证据/已冷/自主优先——用户在场不再是 skip 原因（U04）', () => {
  const t1000 = Date.parse('2026-10-11T02:00:00.000Z'); // 上海 10:00
  const s = effectiveSettings(buildConfig({ background: { keepwarm: { enabled: true } } }), 0, null);
  assert.equal(keepwarmAdmission({ settings: s, evidenceStartedAtMs: null, nowMs: t1000, autonomousRunOpen: false }).skip, 'KEEPWARM_CACHE_EVIDENCE_UNKNOWN', '无证据不宣称命中');
  assert.equal(keepwarmAdmission({ settings: s, evidenceStartedAtMs: t1000, nowMs: t1000 + 3_600_000 + 1, autonomousRunOpen: false }).skip, 'KEEPWARM_CACHE_ALREADY_COLD', '超 1h 不补冷写');
  assert.equal(keepwarmAdmission({ settings: s, evidenceStartedAtMs: t1000, nowMs: t1000 + 2_900_000, autonomousRunOpen: true }).skip, 'AUTONOMOUS_FIRST', '同到期自主优先（K-15）');
  // U04：用户在场（原 chatActive/pendingUserInput 参数已删除）不再构成保温 skip——排队由串行链处理
  assert.equal(keepwarmAdmission({ settings: s, evidenceStartedAtMs: t1000, nowMs: t1000 + 2_900_000, autonomousRunOpen: false }).skip, null, '证据有效即可发送（在场让位=执行位内安全边界）');
  assert.equal(keepwarmTargetMs(t1000), t1000 + 3_000_000, '+50min 语义保留（派发内重算）');
});

test('CW-02/BACKGROUND 预算（2026-10-22 版）：cap=null 不可开始；耗尽=EXHAUSTED；上界未知=UNAVAILABLE；心跳无单请求封锁', () => {
  const cfgNo = effectiveSettings(buildConfig({ background: { autonomous: { enabled: true } } }), 0, null); // 开关开、上限 null
  assert.equal(autonomousAdmission({ settings: cfgNo, totalSwitchEnabled: true, taskEnabled: true, budgetConfigured: false, nowMs: 0 }).skip, 'BACKGROUND_BUDGET_NOT_CONFIGURED');
  const cfgOk = effectiveSettings(buildConfig({ background: { autonomous: { enabled: true, daily_cost_cap_usd: 1 }, keepwarm: { enabled: true, daily_cost_cap_usd: 1 } } }), 0, null);
  assert.equal(autonomousAdmission({ settings: cfgOk, totalSwitchEnabled: true, taskEnabled: true, budgetConfigured: true, nowMs: 0 }).skip, null, 'U02/U04 语义下无冷却无在场取消——直接通过');
  const run = { model_requests_started: 0, tool_calls_started: 0, output_tokens_observed: 0, startedAtMs: 0, reserved_cost_micro_usd: 900_000, known_cost_micro_usd: 0, unknown_cost_count: 0 };
  const gate = budgetGate({ kind: 'autonomous', settings: cfgOk, run, nowMs: 1000, nextRequestCostMicroUsd: 200_000 });
  assert.equal((gate as { code: string }).code, 'BACKGROUND_BUDGET_EXHAUSTED', '0.9+0.2 > 1.0 → 阻止');
  const gate3 = budgetGate({ kind: 'autonomous', settings: cfgOk, run, nowMs: 1000, nextRequestCostMicroUsd: null });
  assert.equal((gate3 as { code: string }).code, 'BUDGET_ESTIMATE_UNAVAILABLE', '费用上界未知不发送');
  // 09：心跳不再有单请求/零工具封锁——多请求+工具在日预算内允许
  const kw = budgetGate({ kind: 'keepwarm', settings: cfgOk, run: { ...run, model_requests_started: 3, tool_calls_started: 5 }, nowMs: 1000, nextRequestCostMicroUsd: 50_000 });
  assert.equal((kw as { allowed: boolean }).allowed, true, '心跳多轮工具循环只受日预算与 max_run_ms 结构保护');
});

test('§9.1/9.2：状态机合法跃迁；重启孤儿=可恢复（W-14 语义）；时钟回拨暂停', () => {
  assert.ok(canTransition('claimed', 'running') && canTransition('running', 'noop') && canTransition('running', 'unknown') && canTransition('unknown', 'completed'));
  assert.ok(!canTransition('completed', 'running') && !canTransition('claimed', 'completed'), '终态不复活');
  assert.deepEqual(restartDisposition({ state: 'claimed', dispatchCount: 0 }), { to: 'skipped', resultCode: 'HOST_RESTART_BEFORE_SEND' });
  assert.deepEqual(restartDisposition({ state: 'running', dispatchCount: 2 }), { to: 'unknown', resultCode: 'HOST_RESTART_MID_RUN' });
  assert.equal(budgetDayOfMs(Date.parse('2026-10-10T16:30:00.000Z')), '2026-10-11', '上海日界');
  assert.equal(clockRegressionAction(Date.parse('2026-10-11T03:00:00.000Z'), Date.parse('2026-10-11T02:00:00.000Z')), 'BACKGROUND_CLOCK_REGRESSION');
  assert.equal(clockRegressionAction(1000, 1100), null);
});

// —— 设置面（§7.2 原子关闭）——
test('BACKGROUND-02/CW-23：设置原子写+revision 门；关闭自主使未执行领取失效', () => {
  const { db, settings } = setup();
  assert.equal(settings.effective().autonomous.enabled, false, 'CW-01：默认关闭');
  const r1 = settings.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
  assert.equal(r1.revision, 1);
  assert.equal(settings.effective().autonomous.enabled, true);
  assert.throws(() => settings.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: false } }), /REVISION_CONFLICT/); // 旧 If-Match 拒
  // 未执行自主领取 → 关闭后标 cancelled
  db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, claimed_at, created_at, updated_at) VALUES ('bgr1','t1','primary','jiaming','autonomous',1,'occ1','claimed',? ,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  settings.applyUpdate({ expectedRevision: 1, patch: { autonomous_enabled: false } });
  const run = db.prepare('SELECT state, result_code FROM background_runs WHERE id = ?').get('bgr1') as { state: string; result_code: string };
  assert.equal(run.state, 'cancelled');
  assert.equal(run.result_code, 'AUTONOMOUS_DISABLED');
});

// —— 调度器（虚拟时钟+假 executor）——
test('CW-01/BACKGROUND-13：reminder 到期投递（无模型）；自主/保温默认关闭零执行；once 完成后才终结', async () => {
  const { db, sched, calls, setNow } = setup();
  setNow('2026-10-11T02:00:00.000Z');
  seedTask(db, { kind: 'reminder', next_due_at: '2026-10-11T02:00:00.000Z', payload: '{"text":"早安"}' });
  seedTask(db, { kind: 'autonomous', next_due_at: '2026-10-11T02:00:00.000Z' });
  seedTask(db, { kind: 'keepwarm', schedule_kind: 'cache_idle', next_due_at: '2026-10-11T02:00:00.000Z' });
  sched.start();
  await sched.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.filter((c) => c.kind === 'reminder').length, 1, '提醒按时投递（一次）');
  assert.equal(calls.filter((c) => c.kind === 'autonomous' || c.kind === 'keepwarm').length, 0, '付费后台默认关闭零执行');
  const runs = db.prepare('SELECT kind, state FROM background_runs').all() as Array<{ kind: string; state: string }>;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.kind, 'reminder');
  // 领取≠消耗（once reminder 完成后不再投递）
  await sched.tick();
  assert.equal(calls.length, 1);
  sched.stop();
});

test('S-05（2026-10-22 版）：用户消息到来——自主唤醒不再被无差别取消；心跳进入让位集', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { db, setNow } = setup();
  setNow('2026-10-11T02:00:00.000Z');
  const events2 = new EventService(db);
  const settings2 = new BackgroundSettingsService(db, buildConfig({ background: { autonomous: { enabled: true, daily_cost_cap_usd: 5 } } }));
  settings2.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
  seedTask(db, { kind: 'autonomous', next_due_at: '2026-10-11T02:00:00.000Z' });
  const sched2 = new BackgroundScheduler({ db, config: buildConfig({ background: { autonomous: { enabled: true, daily_cost_cap_usd: 5 } } }), settings: settings2, alerts: new SystemAlertService(db, events2), executor: { async executeRun(input) { if (input.kind === 'autonomous') await gate; return { outcome: 'noop' }; } }, now: () => Date.parse('2026-10-11T02:00:00.000Z'), tickMs: 60000 });
  sched2.start();
  const runP = sched2.tick();
  await new Promise((r) => setTimeout(r, 5));
  // 用户消息到达：不取消自主执行（正在执行的预约按普通回合规则结束，S-05）
  sched2.notePendingUserChat();
  release();
  await runP;
  const run = db.prepare('SELECT state FROM background_runs WHERE kind = ?').get('autonomous') as { state: string };
  assert.equal(run.state, 'noop', '自主唤醒正常收口（无 USER_CHAT_PREEMPTED 无差别取消）');
  // 心跳运行中：进入让位集（安全边界让位，不立即 abort）
  db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, claimed_at, created_at, updated_at) VALUES ('bgr-kw','tkw','primary','jiaming','keepwarm',1,'occ-kw','running',?,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const c2 = new AbortController();
  (sched2 as unknown as { aborts: Map<string, AbortController> }).aborts.set('bgr-kw', c2);
  sched2.notePendingUserChat();
  assert.equal(sched2.isYieldRequested('bgr-kw'), true, '心跳=让位请求');
  assert.equal(c2.signal.aborted, false, '让位≠立即 abort（安全边界停止续轮）');
  sched2.stop();
});

test('W-02/W-05（2026-10-22 版）：十分钟预约到期执行——无 60 分钟冷却拦截；短间隔两预约都执行；once 完成后才终结', async () => {
  const { db, calls, setNow } = setup();
  setNow('2026-10-11T02:00:00.000Z');
  const events2 = new EventService(db);
  const settings2 = new BackgroundSettingsService(db, buildConfig({ background: { autonomous: { enabled: true, daily_cost_cap_usd: 5 } } }));
  settings2.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
  const t1 = seedTask(db, { kind: 'autonomous', next_due_at: '2026-10-11T02:10:00.000Z' });
  seedTask(db, { kind: 'autonomous', next_due_at: '2026-10-11T02:11:00.000Z' });
  let nowMs = Date.parse('2026-10-11T02:00:00.000Z');
  const sched2 = new BackgroundScheduler({ db, config: buildConfig({ background: { autonomous: { enabled: true, daily_cost_cap_usd: 5 } } }), settings: settings2, alerts: new SystemAlertService(db, events2), executor: { async executeRun(input) { calls.push({ runId: input.runId, kind: input.kind }); return { outcome: 'completed', result_code: 'complete:done' }; } }, now: () => nowMs, tickMs: 1 });
  sched2.start();
  nowMs = Date.parse('2026-10-11T02:10:00.000Z'); await sched2.tick();
  nowMs = Date.parse('2026-10-11T02:11:00.000Z'); await sched2.tick();
  assert.equal(calls.filter((c) => c.kind === 'autonomous').length, 2, 'W-05：短间隔两个预约都执行（无冷却/配额）');
  const s1 = db.prepare('SELECT enabled, control_reason FROM background_tasks WHERE id = ?').get(t1) as { enabled: number; control_reason: string };
  assert.equal(s1.enabled, 0, 'once 完成后终结（领取≠消耗——完成才禁用）');
  assert.equal(s1.control_reason, 'delivered');
  sched2.stop();
});

test('CW-21：并发领取相同 occurrence 只一条执行（唯一约束）', async () => {
  const { db, sched, calls, setNow } = setup();
  setNow('2026-10-11T02:00:00.000Z');
  const taskId = seedTask(db, { kind: 'reminder', next_due_at: '2026-10-11T02:00:00.000Z' });
  sched.start();
  db.prepare("INSERT OR IGNORE INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, claimed_at, created_at, updated_at) VALUES ('bgr-dup',?,'primary','jiaming','reminder',1,?,'claimed',?,?,?)")
    .run(taskId, `${taskId}:1:2026-10-11T02:00:00.000Z`, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  await sched.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 0, '被占用的 occurrence 不二次领取');
  const sameOcc = db.prepare('SELECT COUNT(*) n FROM background_runs WHERE occurrence_key = ?').get(`${taskId}:1:2026-10-11T02:00:00.000Z`) as { n: number };
  assert.equal(sameOcc.n, 1);
  sched.stop();
});

test('CW-12/W-14：重启恢复——零派发 claimed=可恢复（释放 occurrence，任务保持可领取）；进行中=unknown 预占保留', () => {
  const { db, sched: s1, setNow } = setup();
  setNow('2026-10-11T02:00:00.000Z');
  // 进行中 run（有派发）
  db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, reserved_cost_micro_usd, claimed_at, created_at, updated_at) VALUES ('bgr-run1','t','primary','jiaming','autonomous',1,'occ-r1','running',700000,?,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO background_dispatches(id, run_id, logical_action_key, attempt_no, dispatch_kind, state, budget_day, reserved_cost_micro_usd, dispatch_started_at, created_at) VALUES ('bgd1','bgr-run1','model:1',1,'model','started','2026-10-11',700000,?,?)").run(new Date().toISOString(), new Date().toISOString());
  s1.recoverOnStart();
  const run1 = db.prepare('SELECT state, result_code FROM background_runs WHERE id = ?').get('bgr-run1') as { state: string; result_code: string };
  assert.equal(run1.state, 'unknown', '已开始派发=unknown（不补跑不撤销）');
  assert.equal((db.prepare('SELECT reserved_cost_micro_usd FROM background_runs WHERE id = ?').get('bgr-run1') as { reserved_cost_micro_usd: number }).reserved_cost_micro_usd, 700000, '预占保留');
  // 孤儿 claimed 零派发：释放原 occurrence key（行留档 skipped），任务保持可领取
  db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, claimed_at, created_at, updated_at) VALUES ('bgr-orphan','t2','primary','jiaming','autonomous',1,'occ-r2','claimed',?,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  s1.recoverOnStart();
  const orphan = db.prepare('SELECT state, occurrence_key FROM background_runs WHERE id = ?').get('bgr-orphan') as { state: string; occurrence_key: string };
  assert.equal(orphan.state, 'skipped');
  assert.notEqual(orphan.occurrence_key, 'occ-r2', '原 occurrence 已释放——同机会可重新领取（W-14）');
  s1.stop();
});
