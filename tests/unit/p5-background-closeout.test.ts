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
  const sched = new BackgroundScheduler({ db, config, settings, alerts: new SystemAlertService(db, events), executor: { async executeRun() { return { outcome: 'noop' }; } }, now: () => Date.parse('2026-11-06T02:00:00.000Z'), tickMs: 3_600_000 });
  const exec = createBackgroundExecution({
    messages, events, bgSettings: settings,
    supervisor: { enqueueBackground: async <T,>(_cid: string, run: () => Promise<T>) => run(), runBackgroundTurn: (async () => ({ outcome: 'completed' as const })) as never },
    scheduler: { recordDispatchStart: (async () => ({ allowed: true, dispatchId: 'd1' })) as never },
    db,
  });
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

test('T16：同一提醒两次执行（不同 run，同一 due）只递交一条系统消息', async () => {
  const f = setup();
  try {
    const taskId = f.seedReminder('2026-11-06T01:59:00.000Z');
    const mkRun = (rid: string): Parameters<typeof f.exec.executeRun>[0] => ({
      runId: rid, taskId, kind: 'reminder', origin: 'legacy_unknown', conversationId: 'primary',
      payload: { text: '体检提醒' }, isCancelRequested: () => false, registerAbort: () => {},
    });
    const first = await f.exec.executeRun(mkRun('run_a'));
    assert.equal(first.outcome, 'completed');
    // 崩溃重放：发布后未及 finish → 恢复重新领取（新 run），task.next_due_at 未推进
    const replay = await f.exec.executeRun(mkRun('run_b'));
    assert.equal(replay.outcome, 'completed');
    const n = (f.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id='primary' AND client_message_id LIKE 'reminder:%'").get() as { n: number }).n;
    assert.equal(n, 1, '投递身份按 task+due 稳定——重放幂等（旧实现按 run 计 → SIGKILL 后重复递交）');
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
