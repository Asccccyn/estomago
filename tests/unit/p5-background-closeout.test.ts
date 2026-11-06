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
    supervisor: { enqueueBackground: async <T,>(_cid: string, run: () => Promise<T>) => run(), runBackgroundTurn: (async () => ({ outcome: 'completed' as const })) as never },
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
  return { root, db, sched, exec, messages, seedReminder, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
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
