// P5（四仓合并审计 20261106）聚焦验收：
// - T16：提醒投递身份=task+到期时刻——同一提醒崩溃/重放（不同 run）只递交一次系统消息
// - T19：stopRun 对无在途执行者的 claimed run 直接收口 cancelled，不落永久 cancelling
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex, genId } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';
import { createBackgroundExecution } from '../../apps/host/src/application/background-execution.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

function setup() {
  const s = { runBackgroundTurnImpl: null as null | ((opts: { kind: string; runId: string }) => { outcome: 'completed' | 'noop' | 'failed' | 'unknown'; result_code?: string }) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-close-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const config = buildConfig({});
  const settings = new BackgroundSettingsService(db, config);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const exec = createBackgroundExecution({
    messages, events, bgSettings: settings,
    supervisor: { enqueueBackground: async <T,>(_cid: string, run: () => Promise<T>) => run(), runBackgroundTurn: (async (opts: { kind: string; runId: string }) => (s.runBackgroundTurnImpl?.(opts) ?? { outcome: 'completed' as const })) as never },
    scheduler: { recordDispatchStart: (async () => ({ allowed: true, dispatchId: 'd1' })) as never },
    db,
  });
  // T16/RB04：真实执行器接进调度器（领取→执行→finish→once 收尾走真实链，不再直调 executeRun 绕过收尾）
  const sched = new BackgroundScheduler({ db, config, settings, alerts: new SystemAlertService(db, events), executor: exec, now: () => Date.parse('2026-11-06T02:00:00.000Z'), tickMs: 3_600_000 });
  const seedReminder = (dueAt: string): string => {
    const id = `bgt_${genId('x').slice(2)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at)
       VALUES (?,?,'jiaming','reminder',1,1,'once',?,?,'Asia/Shanghai',NULL,NULL,'{"text":"体检提醒"}','qiaosheng','legacy_unknown',?,?)`,
    ).run(id, 'primary', dueAt, dueAt, now, now);
    return id;
  };
  const enableModelKinds = () => { settings.applyUpdate({ expectedRevision: settings.revision(), operationId: 'p5-enable', patch: { autonomous_enabled: true, free_activity_enabled: true, autonomous_daily_cost_cap_usd: 10, free_activity_daily_cost_cap_usd: 10 } }); };
  return { root, db, sched, exec, messages, settings, enableModelKinds, seedReminder, overrideRun: (impl: NonNullable<typeof s.runBackgroundTurnImpl>) => { s.runBackgroundTurnImpl = impl; }, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('T16/RB04：真实领取→崩溃→恢复→重放只递交一条系统消息；once 提醒收口不再伪 scheduled', async () => {
  const f = setup();
  try {
    const due = '2026-11-06T01:59:00.000Z';
    const taskId = f.seedReminder(due);
    // 崩溃现场：已领取（claimed，冻结 scheduled_for=due）、零派发、发布未发生
    const stuckRun = `run_${genId('x').slice(2)}`;
    const nowIso = new Date().toISOString();
    f.db.prepare(
      `INSERT INTO background_runs(id, task_id, task_revision, kind, state, occurrence_key, scheduled_for, conversation_id, actor_id, created_at, updated_at)
       VALUES (?,?,1,'reminder','claimed',?,?,'primary','jiaming',?,?)`,
    ).run(stuckRun, taskId, `${taskId}:1:${due}`, due, nowIso, nowIso);
    // 重启：start 内含恢复——零派发=释放 occurrence key，任务保持可领取（本次机会不丢）
    f.sched.start();
    try {
      assert.equal((f.db.prepare('SELECT state FROM background_runs WHERE id=?').get(stuckRun) as { state: string }).state, 'skipped', '零派发 claimed 恢复为 skipped');
      // 下一 tick 重新领取本次 due 并真实执行投递
      await f.sched.tick();
      const n1 = (f.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id='primary' AND client_message_id LIKE 'reminder:%'").get() as { n: number }).n;
      assert.equal(n1, 1, '恢复重放按 task+冻结 due 幂等——恰一条系统消息');
      // RB04：once 提醒投递后任务收口（旧实现 reminder 不在 finalize 范围：永远 enabled=1 伪 scheduled）
      const task = f.db.prepare('SELECT enabled, next_due_at, control_reason FROM background_tasks WHERE id=?').get(taskId) as { enabled: number; next_due_at: string | null; control_reason: string | null };
      assert.equal(task.enabled, 0, 'once 提醒完成后停用');
      assert.equal(task.next_due_at, null, '不再保留过期 due');
      assert.equal(task.control_reason, 'delivered');
      // 再 tick：无候选可领（不再每 tick 空扫已消费任务），消息不重复
      await f.sched.tick();
      const n2 = (f.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id='primary' AND client_message_id LIKE 'reminder:%'").get() as { n: number }).n;
      assert.equal(n2, 1, '收口后不重复投递');
      const runsAfter = (f.db.prepare('SELECT COUNT(*) n FROM background_runs WHERE task_id=? AND state IN (\'claimed\',\'running\')').get(taskId) as { n: number }).n;
      assert.equal(runsAfter, 0, '无在途 run 残留');
    } finally { f.sched.stop(); }
  } finally { f.close(); }
});

test('T19：stopRun 对无在途执行者的 claimed run 直接收口', () => {
  const f = setup();
  try {
    const taskId = f.seedReminder('2026-11-06T01:59:00.000Z');
    const runId = `run_${genId('x').slice(2)}`;
    const nowIso = new Date().toISOString();
    f.db.prepare(
      `INSERT INTO background_runs(id, task_id, task_revision, kind, state, occurrence_key, first_dispatch_started_at, conversation_id, actor_id, created_at, updated_at)
       VALUES (?,?,1,'reminder','claimed',?,NULL,'primary','jiaming',?,?)`,
    ).run(runId, taskId, `occ:${runId}`, nowIso, nowIso);
    const out = f.sched.stopRun(runId);
    assert.equal(out?.state, 'cancelled', '无执行者（等待派发）直接收口（旧实现永久 cancelling，挡住同 actor+kind 后续任务）');
    const row = f.db.prepare('SELECT state, finished_at FROM background_runs WHERE id=?').get(runId) as { state: string; finished_at: string | null };
    assert.equal(row.state, 'cancelled');
    assert.ok(row.finished_at !== null, 'run 已收口（有完成时间）');
  } finally { f.close(); }
});

// —— RB2-02/RB2-03（复审 20261106 第二轮）——

test('RB2-02：无执行者 stop 经共同收尾——run 与 task 资格一致（不再伪 scheduled）', async () => {
  const f = setup();
  try {
    const taskId = f.seedReminder('2026-11-06T01:59:00.000Z');
    f.sched.start();
    try {
      await f.sched.tick(); // 领取并投递（真实链）
      const stopped = f.db.prepare("SELECT id FROM background_runs WHERE task_id=? AND state='cancelled'").get(taskId) as { id: string } | undefined;
      void stopped;
      // 第二阶段：预约（autonomous+self_schedule）无活动窗→NO_ACTIVE_WINDOW 等待态（真实执行器如实返回）
      f.enableModelKinds();
      const taskId2 = `bgt_${genId('x').slice(2)}`;
      const now2 = new Date().toISOString();
      f.db.prepare(
        `INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at)
         VALUES (?,?,'jiaming','autonomous',1,1,'once',?,?,'Asia/Shanghai',NULL,NULL,'{}','qiaosheng','self_schedule',?,?)`,
      ).run(taskId2, 'primary', '2026-11-06T01:58:00.000Z', '2026-11-06T01:58:00.000Z', now2, now2);
      f.overrideRun(() => ({ outcome: 'noop' as const, result_code: 'NO_ACTIVE_WINDOW' }));
      await f.sched.tick();
      const waiting = f.db.prepare("SELECT id, state, result_code FROM background_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 1").get(taskId2) as { id: string; state: string; result_code: string | null };
      assert.equal(waiting.state, 'claimed', '零派发等待态保留 claimed（不上锁也不终结）');
      // 正式 stop：走共同收尾出口——run cancelled 且 task 资格一致收口
      const out = f.sched.stopRun(waiting.id);
      assert.equal(out?.state, 'cancelled');
      const run = f.db.prepare('SELECT state, finished_at FROM background_runs WHERE id=?').get(waiting.id) as { state: string; finished_at: string | null };
      assert.equal(run.state, 'cancelled');
      assert.ok(run.finished_at);
      const task = f.db.prepare('SELECT enabled, next_due_at, control_reason FROM background_tasks WHERE id=?').get(taskId2) as { enabled: number; next_due_at: string | null; control_reason: string | null };
      assert.equal(task.enabled, 0, 'RB2-02：once 任务随 stop 终结（旧实现 enabled=1 伪 scheduled）');
      assert.equal(task.next_due_at, null);
      assert.equal(task.control_reason, 'stopped_needs_review', '待核原因保留');
      // 另一到期任务不被阻塞
      const taskId3 = f.seedReminder('2026-11-06T01:57:00.000Z');
      f.overrideRun(null as never);
      await f.sched.tick();
      const run3 = f.db.prepare('SELECT state FROM background_runs WHERE task_id=?').get(taskId3) as { state: string };
      assert.equal(run3.state, 'completed', 'stop 后同 kind 后继任务可正常领取执行');
    } finally { f.sched.stop(); }
  } finally { f.close(); }
});

test('RB2-03：让位按控制类型分类——free_activity 让位、预约唤醒继续', async () => {
  const f = setup();
  try {
    const mkTask = (origin: string, due: string): string => {
      const id = `bgt_${genId('x').slice(2)}`;
      const now = new Date().toISOString();
      f.db.prepare(
        `INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at)
         VALUES (?,?,'jiaming','autonomous',1,1,'once',?,?,'Asia/Shanghai',NULL,NULL,'{}','qiaosheng',?,?,?)`,
      ).run(id, 'primary', due, due, origin, now, now);
      return id;
    };
    f.enableModelKinds();
    const cases: Array<[string, boolean]> = [['free_activity', true], ['self_schedule', false]];
    for (const [origin, shouldYield] of cases) {
      const taskId = mkTask(origin, '2026-11-06T01:59:00.000Z');
      f.sched.start();
      try {
        let runIdSeen: string | null = null;
        let yieldAtBoundary: boolean | null = null;
        f.overrideRun((opts) => {
          runIdSeen = opts.runId;
          // 用户消息在安全请求边界到达（执行体内——aborts 已登记，真实触发路径）；
          // 在 finish 清理之前观察让位标记
          f.sched.notePendingUserChat();
          yieldAtBoundary = f.sched.isYieldRequested(opts.runId);
          return { outcome: 'completed' as const, result_code: 'synthetic-done' };
        });
        await f.sched.tick();
        assert.ok(runIdSeen, '执行真实发生');
        assert.equal(yieldAtBoundary, shouldYield, `${origin} 的让位分类`);
        f.overrideRun(null as never);
      } finally { f.sched.stop(); }
    }
  } finally { f.close(); }
});
