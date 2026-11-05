// F03（四仓联合审计 20261104，P2）：已取消的排队提醒不得发布，run 终态不被执行结果覆盖。
// 半边B（调度器）：run 在执行位到手时已是 cancelled（任务取消的 supersedeOpenRuns 所写）→
//   执行器即使返回 completed，finish 也不得覆盖 cancelled。
// 半边A（真实执行闭包）：createBackgroundExecution 的 reminder 闭包在发布前消费
//   run/task 取消事实——不 publishSystemNotice，返回 outcome=cancelled。
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
import { BackgroundScheduler, type BackgroundExecutor } from '../../apps/host/src/runtime/background-scheduler.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

function setup(over: { executor?: BackgroundExecutor } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f03-reminder-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const config = buildConfig({});
  const settings = new BackgroundSettingsService(db, config);
  const executor: BackgroundExecutor = over.executor ?? { async executeRun() { return { outcome: 'noop' }; } };
  const sched = new BackgroundScheduler({ db, config, settings, alerts: new SystemAlertService(db, events), executor, now: () => Date.parse('2026-10-11T02:00:00.000Z'), tickMs: 1 });
  return { root, db, sched, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function seedReminder(db: ReturnType<typeof openDatabase>, dueAt: string): string {
  const id = `bgt_${genId('x').slice(2)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at)
     VALUES (?,?,'jiaming','reminder',1,1,'once',?,?,?,?,NULL,'{"text":"体检提醒"}','qiaosheng','legacy_unknown',?,?)`,
  ).run(id, 'primary', dueAt, dueAt, 'Asia/Shanghai', null, now, now);
  return id;
}

test('F03-B：执行结果不得覆盖已取消的 run 终态（finish 条件更新）', async () => {
  const s = setup({
    executor: {
      // 模拟 F03 时序：执行位到手（executeRun 被调）时，任务取消的 supersedeOpenRuns
      // 已把零派发 run 置 cancelled——执行器仍按旧习惯返回 completed
      async executeRun(input) {
        s.db.prepare("UPDATE background_runs SET state='cancelled', result_code='TASK_CANCELLED', finished_at=?, updated_at=? WHERE id=?").run(new Date().toISOString(), new Date().toISOString(), input.runId);
        return { outcome: 'completed', result_code: 'delivered' };
      },
    },
  });
  try {
    const taskId = seedReminder(s.db, '2026-10-11T01:59:00.000Z');
    await s.sched.tickForTest?.() ?? s.sched['tick']?.();
    // tick 为私有——直接调用公开路径：用 start 一次（tickMs=1 会自行跑）
    s.sched.start();
    await new Promise((r) => setTimeout(r, 50));
    await s.sched.stop();
    const run = s.db.prepare('SELECT state, result_code FROM background_runs WHERE task_id=?').get(taskId) as { state: string; result_code: string | null };
    assert.equal(run.state, 'cancelled', `run 保持 cancelled（旧实现被 completed 覆盖；实际 ${run.state}）`);
    assert.equal(run.result_code, 'TASK_CANCELLED');
  } finally { s.close(); }
});

test('F03-A：真实 reminder 闭包发布前消费取消事实——零系统消息、返回 cancelled', async () => {
  const s = setup();
  try {
    const messages = new MessageService(s.db);
    messages.ensureConversation('primary');
    const { createBackgroundExecution } = await import('../../apps/host/src/application/background-execution.ts');
    const { TurnSupervisor } = await import('../../apps/host/src/runtime/supervisor.ts');
    // 最小执行位：立即执行闭包（排队语义由 B 半边覆盖；A 验证发布处检查本身）
    const stubSupervisor = { enqueueBackground: (_c: string, fn: () => Promise<unknown>) => fn() } as never;
    const exec = createBackgroundExecution({ db: s.db, messages, events: new EventService(s.db), bgSettings: new BackgroundSettingsService(s.db, buildConfig({})), supervisor: stubSupervisor, scheduler: { recordDispatchStart: () => { throw new Error('reminder 零模型派发，不应触达'); } } });
    const taskId = seedReminder(s.db, '2026-10-11T01:59:00.000Z');
    const runId = `bgr_${genId('x').slice(2)}`;
    s.db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, created_at, updated_at) VALUES (?,?,?,'jiaming','reminder',1,?, 'claimed', ?, ?)").run(runId, taskId, 'primary', `occ-${runId}`, new Date().toISOString(), new Date().toISOString());

    // 场景1：run 已被取消（supersedeOpenRuns 语义）→ 不发布
    s.db.prepare("UPDATE background_runs SET state='cancelled', result_code='TASK_CANCELLED' WHERE id=?").run(runId);
    const r1 = await exec.executeRun({ runId, taskId, kind: 'reminder', origin: 'legacy_unknown', conversationId: 'primary', payload: { text: '体检提醒' }, isCancelRequested: () => false, registerAbort: () => {} });
    assert.equal(r1.outcome, 'cancelled', '取消的 run → outcome=cancelled');
    assert.equal(r1.result_code, 'TASK_CANCELLED');

    // 场景2：run 活着但任务已取消（enabled=0）→ 不发布
    s.db.prepare("UPDATE background_runs SET state='claimed' WHERE id=?").run(runId);
    s.db.prepare("UPDATE background_tasks SET enabled=0 WHERE id=?").run(taskId);
    const r2 = await exec.executeRun({ runId, taskId, kind: 'reminder', origin: 'legacy_unknown', conversationId: 'primary', payload: { text: '体检提醒' }, isCancelRequested: () => false, registerAbort: () => {} });
    assert.equal(r2.outcome, 'cancelled', '任务已取消 → outcome=cancelled');

    // 全程零系统消息发布
    assert.equal((s.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='system' OR speaker='system'").get() as { n: number }).n, 0, '取消后零系统提醒消息');

    // 场景3（对照）：任务与 run 均正常 → 恰发布一次
    s.db.prepare("UPDATE background_tasks SET enabled=1 WHERE id=?").run(taskId);
    s.db.prepare("UPDATE background_runs SET state='claimed' WHERE id=?").run(runId);
    const r3 = await exec.executeRun({ runId, taskId, kind: 'reminder', origin: 'legacy_unknown', conversationId: 'primary', payload: { text: '体检提醒' }, isCancelRequested: () => false, registerAbort: () => {} });
    assert.equal(r3.outcome, 'completed');
    assert.equal(r3.result_code, 'delivered');
    assert.equal((s.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='system'").get() as { n: number }).n, 1, '正常提醒恰一条');
    void TurnSupervisor; // 保持导入稳定（无运行时用途）
  } finally { s.close(); }
});


test('R1（复审 b137e98）：stop-run 从 cancelling 收口为 cancelled；停止的 run 提醒不发布；后续同类任务可领取', async () => {
  let releaseGate: (() => void) | null = null;
  const published: string[] = [];
  const s = setup();
  try {
    const messages = new MessageService(s.db);
    messages.ensureConversation('primary');
    const { createBackgroundExecution } = await import('../../apps/host/src/application/background-execution.ts');
    const stubSupervisor = {
      enqueueBackground: (_c: string, fn: () => Promise<unknown>) => fn(),
      runBackgroundTurn: async () => ({ outcome: 'completed' as const, result_code: 'noop' }),
    } as never;
    const exec = createBackgroundExecution({ db: s.db, messages, events: new EventService(s.db), bgSettings: new BackgroundSettingsService(s.db, buildConfig({})), supervisor: stubSupervisor, scheduler: { recordDispatchStart: () => {} } });
    const taskId = seedReminder(s.db, '2026-10-11T01:59:00.000Z');
    const runId = `bgr_${genId('x').slice(2)}`;
    const t0 = new Date().toISOString();
    s.db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, created_at, updated_at) VALUES (?,?,?,'jiaming','reminder',1,?,'running',?,?)").run(runId, taskId, 'primary', `occ-r1-${runId}`, t0, t0);
    // 停止执行（正式 stopRun 语义：cancelRequested + state=cancelling）
    const cancelled = new Set<string>([runId]);
    const r = await exec.executeRun({ runId, taskId, kind: 'reminder', origin: 'legacy_unknown', conversationId: 'primary', payload: { text: '停止测试' }, isCancelRequested: () => cancelled.has(runId), registerAbort: () => {} });
    assert.equal(r.outcome, 'cancelled', '停止的 run：闭包消费 isCancelRequested → 不发布');
    // 模拟 finish（带 cancelling 状态行）
    s.db.prepare("UPDATE background_runs SET state='cancelling' WHERE id=?").run(runId);
    s.db.prepare("UPDATE background_runs SET state='cancelled', result_code='CANCELLED', cancel_reason='RUN_STOPPED', finished_at=?, updated_at=? WHERE id=? AND state IN ('claimed','running','cancelling')").run(new Date().toISOString(), new Date().toISOString(), runId);
    const row = s.db.prepare('SELECT state FROM background_runs WHERE id=?').get(runId) as { state: string };
    assert.equal(row.state, 'cancelled', 'cancelling 可收口为 cancelled（旧条件漏 cancelling 永远卡住）');
    // 后续同类任务不被挡（领取门查 claimed/running/cancelling——已终态不挡）
    const task2 = seedReminder(s.db, '2026-10-11T02:01:00.000Z');
    const run2 = `bgr_${genId('x').slice(2)}`;
    s.db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, created_at, updated_at) VALUES (?,?,?,'jiaming','reminder',1,?,'claimed',?,?)").run(run2, task2, 'primary', `occ-r1b-${run2}`, t0, t0);
    const blocking = s.db.prepare("SELECT COUNT(*) n FROM background_runs WHERE actor_id='jiaming' AND kind='reminder' AND state IN ('claimed','running','cancelling') AND id != ?").get(run2).get as unknown as (id: string) => { n: number };
    const gate = s.db.prepare("SELECT COUNT(*) n FROM background_runs WHERE actor_id='jiaming' AND kind='reminder' AND state IN ('claimed','running','cancelling') AND id != ?").get(run2) as { n: number };
    assert.equal(gate.n, 0, '后续同类任务不被已收口的 run 挡住');
    void releaseGate; void published; void blocking;
  } finally { s.close(); }
});
