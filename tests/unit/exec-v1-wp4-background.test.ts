// ESTOMAGO_CHAT_EXEC_V1 · WP4 地基（04 §4-§10）：策略纯函数 + 设置原子开关 + 调度器（虚拟时钟/假 executor）
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
import { autonomousCooldownDueAtMs, keepwarmAdmission, keepwarmTargetMs, autonomousAdmission, budgetGate, canTransition, restartDisposition, budgetDayOfMs, clockRegressionAction, effectiveSettings } from '../../apps/host/src/runtime/background-policy.ts';
import { lastCacheEvidence } from '../../apps/host/src/runtime/cache-observation.ts';

function setup(over: { config?: Record<string, unknown>; now?: number; chatBusy?: () => boolean; executor?: BackgroundExecutor } = {}) {
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
  const sched = new BackgroundScheduler({ db, config, settings, alerts, executor, chatBusy: over.chatBusy ?? (() => false), now: () => nowMs, tickMs: 1 });
  return { root, db, alerts, config, settings, sched, calls, advance: (ms: number) => { nowMs += ms; }, setNow: (iso: string) => { nowMs = Date.parse(iso); }, get now() { return nowMs; } };
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

// —— 策略纯函数（虚拟时钟语义）——
test('CW-06/07 策略：滚动 60min 冷却按主体统一——10:59 首派发后 11:01 新任务被挡；多任务/换 ID 不重置', () => {
  const T0 = Date.parse('2026-10-11T02:59:00.000Z'); // 上海 10:59
  assert.equal(autonomousCooldownDueAtMs(null, T0 + 120_000), null, '无历史=可开始');
  const due = autonomousCooldownDueAtMs(new Date(T0).toISOString(), T0 + 120_000); // 11:01
  assert.ok(due !== null && due === T0 + 3_600_000, '11:01 仍在冷却，合法下次=11:59（不是整点分桶）');
  assert.equal(autonomousCooldownDueAtMs(new Date(T0).toISOString(), T0 + 3_600_000), null, '满 60min 放行');
});

test('CW-03 策略：保温目标=证据+50min 滚动；10:35 新证据→11:25（旧 10:50 作废）；冷/无证据不补写', () => {
  const t1000 = Date.parse('2026-10-11T02:00:00.000Z'); // 上海 10:00
  const t1035 = t1000 + 35 * 60_000;
  assert.equal(keepwarmTargetMs(t1000), t1000 + 3_000_000); // 10:50
  assert.equal(keepwarmTargetMs(t1035), t1035 + 3_000_000); // 11:25——新证据移动目标
  const s = effectiveSettings(buildConfig({ background: { keepwarm: { enabled: true } } }), 0, null);
  assert.equal(keepwarmAdmission({ settings: s, evidenceStartedAtMs: null, nowMs: t1035, chatActive: false, pendingUserInput: false, autonomousRunOpen: false }).skip, 'KEEPWARM_CACHE_EVIDENCE_UNKNOWN');
  assert.equal(keepwarmAdmission({ settings: s, evidenceStartedAtMs: t1000, nowMs: t1000 + 3_600_000 + 1, chatActive: false, pendingUserInput: false, autonomousRunOpen: false }).skip, 'KEEPWARM_CACHE_ALREADY_COLD', '超 1h 不补冷写');
  assert.equal(keepwarmAdmission({ settings: s, evidenceStartedAtMs: t1000, nowMs: t1000 + 2_900_000, chatActive: true, pendingUserInput: false, autonomousRunOpen: false }).skip, 'CHAT_ACTIVE', '聊天优先让出');
  assert.equal(keepwarmAdmission({ settings: s, evidenceStartedAtMs: t1000, nowMs: t1000 + 2_900_000, chatActive: false, pendingUserInput: false, autonomousRunOpen: true }).skip, 'AUTONOMOUS_FIRST', '到期自主先于保温');
});

test('CW-02/BACKGROUND 预算：daily_cap=null=未配置不可开始（非无限）；整数限额耗尽=EXHAUSTED；上界未知=UNAVAILABLE', () => {
  const cfgNo = effectiveSettings(buildConfig({ background: { autonomous: { enabled: true } } }), 0, null); // 开关开、上限 null
  assert.equal(autonomousAdmission({ settings: cfgNo, totalSwitchEnabled: true, taskEnabled: true, hasPendingUserChat: false, cooldownDueAtMs: null, budgetConfigured: false, nowMs: 0 }).skip, 'BACKGROUND_BUDGET_NOT_CONFIGURED');
  const cfgOk = effectiveSettings(buildConfig({ background: { autonomous: { enabled: true, daily_cost_cap_usd: 1 } } }), 0, null);
  assert.equal(autonomousAdmission({ settings: cfgOk, totalSwitchEnabled: true, taskEnabled: true, hasPendingUserChat: false, cooldownDueAtMs: null, budgetConfigured: true, nowMs: 0 }).skip, null);
  const run = { model_requests_started: 0, tool_calls_started: 0, output_tokens_observed: 0, startedAtMs: 0, reserved_cost_micro_usd: 900_000, known_cost_micro_usd: 0, unknown_cost_count: 0 };
  const gate = budgetGate({ kind: 'autonomous', settings: cfgOk, run, nowMs: 1000, nextRequestCostMicroUsd: 200_000 });
  assert.equal((gate as { allowed: boolean }).allowed, false, '0.9+0.2 > 1.0 美元上限→阻止（预占不释放）');
  assert.equal((gate as { code: string }).code, 'BACKGROUND_BUDGET_EXHAUSTED');
  const gate2 = budgetGate({ kind: 'autonomous', settings: cfgOk, run: { ...run, model_requests_started: 4 }, nowMs: 1000, nextRequestCostMicroUsd: 1 });
  assert.equal((gate2 as { code: string }).code, 'BACKGROUND_BUDGET_EXHAUSTED', '请求次数门（4/4）');
  const gate3 = budgetGate({ kind: 'autonomous', settings: cfgOk, run, nowMs: 1000, nextRequestCostMicroUsd: null });
  assert.equal((gate3 as { code: string }).code, 'BUDGET_ESTIMATE_UNAVAILABLE', '费用上界未知不发送');
});

test('§9.1/9.2：状态机合法跃迁；重启孤儿=skipped/进行中=unknown；时钟回拨暂停', () => {
  assert.ok(canTransition('claimed', 'running') && canTransition('running', 'noop') && canTransition('running', 'unknown') && canTransition('unknown', 'completed'));
  assert.ok(!canTransition('completed', 'running') && !canTransition('claimed', 'completed'), '终态不复活；claimed 不直接 completed');
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
  const r1 = settings.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true } });
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
test('CW-01/BACKGROUND-13：reminder 到期投递（无模型）；自主/保温默认关闭零执行', async () => {
  const { db, sched, calls, setNow, advance } = setup();
  setNow('2026-10-11T02:00:00.000Z');
  seedTask(db, { kind: 'reminder', next_due_at: '2026-10-11T02:00:00.000Z', payload: '{"text":"早安"}' });
  seedTask(db, { kind: 'autonomous', next_due_at: '2026-10-11T02:00:00.000Z' });
  seedTask(db, { kind: 'keepwarm', schedule_kind: 'cache_idle', next_due_at: '2026-10-11T02:00:00.000Z' });
  sched.start();
  await sched.tick();
  await new Promise((r) => setTimeout(r, 5));
  advance(1);
  assert.equal(calls.filter((c) => c.kind === 'reminder').length, 1, '提醒按时投递（一次）');
  assert.equal(calls.filter((c) => c.kind === 'autonomous' || c.kind === 'keepwarm').length, 0, '付费后台默认关闭零执行');
  const runs = db.prepare('SELECT kind, state, result_code FROM background_runs').all() as Array<{ kind: string; state: string; result_code: string }>;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.kind, 'reminder');
  // once 任务执行后禁用——不重复投递（同 occurrence 只一次）
  await sched.tick();
  assert.equal(calls.length, 1);
  sched.stop();
});

test('CW-05/BACKGROUND-06：聊天抢占——用户输入取消后台执行，状态=cancelled/USER_CHAT_PREEMPTED', async () => {
  const started = new Promise<() => void>((res) => { void res; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { db, sched, setNow } = setup({
    executor: {
      async executeRun(input) {
        if (input.kind === 'autonomous') await gate; // 模拟长工具链
        return { outcome: 'noop' };
      },
    },
  });
  void started;
  setNow('2026-10-11T02:00:00.000Z');
  // 打开自主+预算，seed 到期任务
  const events2 = new EventService(db);
  const settings2 = new BackgroundSettingsService(db, buildConfig({ background: { autonomous: { enabled: true, daily_cost_cap_usd: 5 } } }));
  settings2.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true } });
  seedTask(db, { kind: 'autonomous', next_due_at: '2026-10-11T02:00:00.000Z' });
  const alerts2 = new SystemAlertService(db, events2);
  const sched2 = new BackgroundScheduler({ db, config: buildConfig({ background: { autonomous: { enabled: true, daily_cost_cap_usd: 5 } } }), settings: settings2, alerts: alerts2, executor: { async executeRun(input) { if (input.kind === 'autonomous') await gate; return { outcome: 'noop' }; } }, chatBusy: () => false, now: () => Date.parse('2026-10-11T02:00:00.000Z'), tickMs: 60000 });
  sched2.start();
  const runP = (async () => { await sched2.tick(); })();
  await new Promise((r) => setTimeout(r, 5));
  // 用户消息到达：立即请求取消
  sched2.notePendingUserChat();
  release(); // 后台闭包恢复 → 收口 cancelled
  await runP;
  const run = db.prepare('SELECT state, cancel_reason FROM background_runs WHERE kind = ?').get('autonomous') as { state: string; cancel_reason: string };
  assert.equal(run.state, 'cancelled');
  assert.equal(run.cancel_reason, 'USER_CHAT_PREEMPTED');
  sched2.stop();
  void sched;
});

test('CW-21：并发领取相同 occurrence 只一条执行（唯一约束）', async () => {
  const { db, sched, calls, setNow } = setup();
  setNow('2026-10-11T02:00:00.000Z');
  const taskId = seedTask(db, { kind: 'reminder', next_due_at: '2026-10-11T02:00:00.000Z' });
  sched.start();
  // 模拟双回调竞态：另一路先以同 occurrence 领取
  db.prepare("INSERT OR IGNORE INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, claimed_at, created_at, updated_at) VALUES ('bgr-dup',?,'primary','jiaming','reminder',1,?,'claimed',?,?,?)")
    .run(taskId, `${taskId}:1:2026-10-11T02:00:00.000Z`, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  await sched.tick();
  await new Promise((r) => setTimeout(r, 5));
  // 同 occurrence 唯一——调度器领不到第二条（calls=0），只有一条执行记录
  assert.equal(calls.length, 0, '被占用的 occurrence 不二次领取');
  const sameOcc = db.prepare('SELECT COUNT(*) n FROM background_runs WHERE occurrence_key = ?').get(`${taskId}:1:2026-10-11T02:00:00.000Z`) as { n: number };
  assert.equal(sameOcc.n, 1);
  db.prepare("UPDATE background_runs SET state = 'completed', finished_at = ?, updated_at = ? WHERE id = 'bgr-dup'").run(new Date().toISOString(), new Date().toISOString());
  const open = db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind='reminder' AND state IN ('claimed','running')").get() as { n: number };
  assert.equal(open.n, 0);
  sched.stop();
});

test('CW-12：重启恢复——孤儿 claimed(零派发)=skipped；进行中=unknown 预占保留；缓存证据派生保温目标', async () => {
  const { db, sched: s1, setNow } = setup();
  setNow('2026-10-11T02:00:00.000Z');
  // 进行中 run（有派发）
  db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, reserved_cost_micro_usd, claimed_at, created_at, updated_at) VALUES ('bgr-run1','t','primary','jiaming','autonomous',1,'occ-r1','running',700000,?,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO background_dispatches(id, run_id, logical_action_key, attempt_no, dispatch_kind, state, budget_day, reserved_cost_micro_usd, dispatch_started_at, created_at) VALUES ('bgd1','bgr-run1','model:1',1,'model','started','2026-10-11',700000,?,?)").run(new Date().toISOString(), new Date().toISOString());
  s1.recoverOnStart();
  const run1 = db.prepare('SELECT state, result_code FROM background_runs WHERE id = ?').get('bgr-run1') as { state: string; result_code: string };
  assert.equal(run1.state, 'unknown', '已开始派发=unknown（不补跑不撤销）');
  assert.equal((db.prepare('SELECT reserved_cost_micro_usd FROM background_runs WHERE id = ?').get('bgr-run1') as { reserved_cost_micro_usd: number }).reserved_cost_micro_usd, 700000, '预占保留');
  // 孤儿 claimed 零派发
  db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, claimed_at, created_at, updated_at) VALUES ('bgr-orphan','t2','primary','jiaming','autonomous',1,'occ-r2','claimed',?,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  s1.recoverOnStart();
  assert.equal((db.prepare('SELECT state FROM background_runs WHERE id = ?').get('bgr-orphan') as { state: string }).state, 'skipped');
  // 缓存证据 → keepwarm 任务目标=证据+50min；无证据=目标清空
  const win = 'win-cw12';
  const nowIso = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO conversations(id, created_at) VALUES ('primary',?)").run(nowIso);
  db.prepare("INSERT OR IGNORE INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?,'primary','ACTIVE',?,?)").run(win, nowIso, nowIso);
  const turn = `t-${Math.random().toString(36).slice(2, 7)}`; const att = `a-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES (?,?,'chat','completed',?)").run(turn, 'primary', nowIso);
  db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,1,1,'completed')").run(att, turn);
  const prq = `p-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare("INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, outcome, created_at, dispatch_started_at, sent_at) VALUES (?,?,?,?, 'chat','{}','completed',?,?,?)").run(prq, win, att, turn, nowIso, '2026-10-11T02:00:00.000Z', '2026-10-11T02:00:00.000Z');
  db.prepare("INSERT INTO usage_observations(id, request_id, attempt_id, turn_id, scope, model, input_tokens, cache_read_input_tokens, cache_creation_input_tokens, source, completeness, observed_at) VALUES (?,?,?,?, 'request','m',2000,1500,500,'or_stream','complete',?)").run(`u-${Math.random().toString(36).slice(2, 7)}`, prq, att, turn, nowIso);
  assert.ok(lastCacheEvidence(db, win), '证据可派生');
  const events2 = new EventService(db);
  const settings2 = new BackgroundSettingsService(db, buildConfig({}));
  settings2.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true } });
  seedTask(db, { kind: 'keepwarm', schedule_kind: 'cache_idle', next_due_at: '2026-10-11T02:40:00.000Z' }); // 旧 10:40 目标
  const sched2 = new BackgroundScheduler({ db, config: buildConfig({}), settings: settings2, alerts: new SystemAlertService(db, events2), executor: { async executeRun() { return { outcome: 'noop' }; } }, chatBusy: () => false, now: () => Date.parse('2026-10-11T02:45:00.000Z'), tickMs: 1 });
  sched2.start();
  await sched2.tick();
  const target = (db.prepare('SELECT next_due_at FROM background_tasks WHERE kind = ?').get('keepwarm') as { next_due_at: string | null }).next_due_at;
  assert.equal(target, '2026-10-11T02:50:00.000Z', '目标按最新证据重算（10:00 证据→10:50），旧 10:40 作废且未发送（已过期被重排）');
  sched2.stop();
  s1.stop();
});
