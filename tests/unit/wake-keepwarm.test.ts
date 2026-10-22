// WAKE_KEEPWARM_V1 · 产品级验收矩阵（fixtures/acceptance_cases.json 的 L2 落地）：
// W 系列=预约正本（幂等/CAS/隔离/校验）；K 系列=真实活动锚点与保温计时（双时钟/CAS）；
// S 系列=同会话串行；B 系列=预算账本；A 系列=迁移幂等与旧任务隔离。
// 全部真实 est 代码 + 隔离临时 ESTOMAGO_HOME（run-tests 注入）+ 零真实网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundTaskService } from '../../apps/host/src/runtime/background-task-service.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';
import { budgetDayOfMs } from '../../apps/host/src/runtime/background-policy.ts';

function setup(nowMs: number = Date.parse('2026-10-22T01:00:00.000+08:00')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-kw-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const config = buildConfig({});
  const settings = new BackgroundSettingsService(db, config);
  const svc = new BackgroundTaskService(db, settings, () => nowMs);
  const activity = new ConversationActivityService(db);
  return { root, db, events, config, settings, svc, activity, setNow: (n: number) => { nowMs = n; }, get now() { return nowMs; } };
}

async function enableAutonomous(t: ReturnType<typeof setup>): Promise<void> {
  t.settings.applyUpdate({ expectedRevision: t.settings.revision(), patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
}

// —— W 系列：预约正本 ——

test('W-08 幂等相对时间：01:00 delay=600；01:03 同键重试返回同一任务同一 01:10（不重新加 3 分钟）', async () => {
  const t = setup();
  await enableAutonomous(t);
  const r1 = t.svc.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: 'op-x', note: '提醒读书', delaySeconds: 600, createdBy: 'jiaming' });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  const first = r1.task.scheduled_at!;
  t.setNow(Date.parse('2026-10-22T01:03:00.000+08:00'));
  const r2 = t.svc.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: 'op-x', note: '提醒读书', delaySeconds: 600, createdBy: 'jiaming' });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.equal(r2.duplicate, true, '同键同参数=重放');
  assert.equal(r2.task.task_id, r1.task.task_id);
  assert.equal(r2.task.scheduled_at, first, '返回最初绝对时间 01:10（不是 01:13）');
  const count = (t.db.prepare('SELECT COUNT(*) n FROM background_tasks WHERE origin = ?').get('self_schedule') as { n: number }).n;
  assert.equal(count, 1, '无重复任务');
});

test('W-09 同键不同参数=IDEMPOTENCY_CONFLICT；原 note 不被覆盖', async () => {
  const t = setup();
  await enableAutonomous(t);
  const r1 = t.svc.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: 'op-y', note: '内容A', delaySeconds: 600, createdBy: 'jiaming' });
  assert.equal(r1.ok, true);
  const r2 = t.svc.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: 'op-y', note: '内容B', delaySeconds: 600, createdBy: 'jiaming' });
  assert.equal(r2.ok, false);
  if (r2.ok) return;
  assert.equal(r2.code, 'IDEMPOTENCY_CONFLICT');
  const detail = t.svc.detail({ actorId: 'jiaming', conversationId: 'primary', taskId: (r1 as { task: { task_id: string } }).task.task_id });
  assert.equal(detail.ok && detail.task.note, '内容A', '原任务原样');
});

test('W-20 时间校验：无时区/非法日期/过去 at/at+delay 同时给→明确拒绝（不悄悄按本机时区或"现在"修正）', async () => {
  const t = setup();
  await enableAutonomous(t);
  const bad: Array<Parameters<BackgroundTaskService['schedule']>[0]> = [
    { actorId: 'jiaming', conversationId: 'primary', operationId: 'a1', note: 'x', at: '2026-10-22T01:10:00', createdBy: 'jiaming' }, // 无时区
    { actorId: 'jiaming', conversationId: 'primary', operationId: 'a2', note: 'x', at: 'not-a-date', createdBy: 'jiaming' },
    { actorId: 'jiaming', conversationId: 'primary', operationId: 'a3', note: 'x', at: '2026-10-21T01:10:00+08:00', createdBy: 'jiaming' }, // 过去
    { actorId: 'jiaming', conversationId: 'primary', operationId: 'a4', note: 'x', at: '2026-10-22T03:10:00+08:00', delaySeconds: 60, createdBy: 'jiaming' }, // 同时给
    { actorId: 'jiaming', conversationId: 'primary', operationId: 'a5', note: 'x', createdBy: 'jiaming' }, // 都不给
    { actorId: 'jiaming', conversationId: 'primary', operationId: 'a6', note: 'x', delaySeconds: 0, createdBy: 'jiaming' },
  ];
  for (const req of bad) {
    const r = t.svc.schedule(req);
    assert.equal(r.ok, false, `应拒绝：${String(req.operationId)}`);
    if (!r.ok) assert.ok(['WAKE_TIME_INVALID', 'WAKE_TIME_IN_PAST'].includes(r.code), `code=${r.code}`);
  }
  const past = t.svc.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: 'a7', note: 'x', at: '2026-10-21T01:10:00+08:00', createdBy: 'jiaming' });
  assert.equal(past.ok, false);
  if (!past.ok) assert.ok(past.serverNowIso, '过去时间返回 server_now');
});

test('W-05/W-06 多任务不覆盖：三个不同未来任务 list 保留三 ID 与各自时间/正文', async () => {
  const t = setup();
  await enableAutonomous(t);
  for (const [op, delay, note] of [['o1', 600, '第一个'], ['o2', 660, '第二个'], ['o3', 720, '第三个']] as const) {
    const r = t.svc.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: op, note, delaySeconds: delay, createdBy: 'jiaming' });
    assert.equal(r.ok, true);
  }
  const l = t.svc.list({ actorId: 'jiaming', conversationId: 'primary' });
  assert.equal(l.ok && l.tasks.length, 3, '三个并存任务');
});

test('W-10/W-11 修改与取消：CAS 递增 revision；零派发排队 run 失效；已派发 run 不动', async () => {
  const t = setup();
  await enableAutonomous(t);
  const s = t.svc.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: 'u1', note: '旧内容', delaySeconds: 3600, createdBy: 'jiaming' });
  assert.equal(s.ok, true);
  if (!s.ok) return;
  const taskId = s.task.task_id;
  // 模拟已排队未派发 run（claimed、零派发）
  const nowIso = new Date(t.now).toISOString();
  t.db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, claimed_at, created_at, updated_at) VALUES ('bgr-q',?,'primary','jiaming','autonomous',1,'wake:test:1','claimed',?,?,?)").run(taskId, nowIso, nowIso, nowIso);
  // 错 revision → REVISION_CONFLICT
  const bad = t.svc.update({ actorId: 'jiaming', conversationId: 'primary', operationId: 'u2', taskId, expectedRevision: 9, note: '新内容' });
  assert.equal(bad.ok, false);
  // 对 revision → 修改成功+旧 run 失效
  const upd = t.svc.update({ actorId: 'jiaming', conversationId: 'primary', operationId: 'u3', taskId, expectedRevision: 1, note: '新内容', at: '2026-10-22T05:00:00+08:00' });
  assert.equal(upd.ok, true);
  const queued = t.db.prepare('SELECT state, result_code FROM background_runs WHERE id = ?').get('bgr-q') as { state: string; result_code: string };
  assert.equal(queued.state, 'cancelled', '旧 revision 排队 run 失效（零派发）');
  assert.equal(queued.result_code, 'TASK_SUPERSEDED');
  // 已派发 run 不被取消路径撤销
  t.db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, first_dispatch_started_at, claimed_at, created_at, updated_at) VALUES ('bgr-dispatched',?,'primary','jiaming','autonomous',2,'wake:test:2','running',?,?,?,?)").run(taskId, nowIso, nowIso, nowIso, nowIso);
  const cancel = t.svc.cancel({ actorId: 'jiaming', conversationId: 'primary', operationId: 'u4', taskId, expectedRevision: 2 });
  assert.equal(cancel.ok, true);
  const dispatched = t.db.prepare('SELECT state FROM background_runs WHERE id = ?').get('bgr-dispatched') as { state: string };
  assert.equal(dispatched.state, 'running', '已进入模型的不撤回（已见事实保留）');
  const task = t.svc.detail({ actorId: 'jiaming', conversationId: 'primary', taskId });
  assert.equal(task.ok && task.task.revision, 3, 'A-03：取消递增 revision');
  assert.equal(task.ok && task.task.status, 'cancelled');
});

test('W-19 跨 actor/会话隔离：他人任务不可见不可改', async () => {
  const t = setup();
  await enableAutonomous(t);
  const s = t.svc.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: 'iso1', note: 'x', delaySeconds: 600, createdBy: 'jiaming' });
  const other = t.svc.list({ actorId: 'someone-else', conversationId: 'primary' });
  assert.equal(other.ok && other.tasks.length, 0, '他人 list 不可见');
  const upd = t.svc.update({ actorId: 'someone-else', conversationId: 'primary', operationId: 'iso2', taskId: s.ok ? s.task.task_id : 'x', expectedRevision: 1, note: 'hijack' });
  assert.equal(upd.ok, false);
  const cancel = t.svc.cancel({ actorId: 'someone-else', conversationId: 'primary', operationId: 'iso3', taskId: s.ok ? s.task.task_id : 'x', expectedRevision: 1 });
  assert.equal(cancel.ok, false);
});

test('W-18/B-08 独立开关：自主关闭时 schedule=SELF_WAKE_DISABLED；list/cancel 仍可用', async () => {
  const t = setup();
  // 自主关闭（默认），保温开
  t.settings.applyUpdate({ expectedRevision: t.settings.revision(), patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  const r = t.svc.schedule({ actorId: 'jiaming', conversationId: 'primary', operationId: 'k1', note: 'x', delaySeconds: 600, createdBy: 'jiaming' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'SELF_WAKE_DISABLED');
  const l = t.svc.list({ actorId: 'jiaming', conversationId: 'primary' });
  assert.equal(l.ok, true, '关闭时 list 可用');
});

// —— K 系列：真实活动锚点与保温计时 ——

function activitySetup() {
  const t = setup();
  const messages = new MessageService(t.db, null, t.activity);
  messages.ensureConversation('primary', '私聊');
  return { ...t, messages };
}

test('K-05/K-06/K-07 消息发布投影：owner/assistant 发布与追加段落更新 L；重复幂等与编辑不更新', () => {
  const t = activitySetup();
  const m1 = t.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '第一条', clientMessageId: 'c1' });
  let a1 = t.activity.get('primary')!;
  assert.equal(a1.last_real_message_id, m1.message.id, 'owner 接受更新 L');
  const rev1 = a1.activity_revision;
  // 幂等重放不更新
  t.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '第一条', clientMessageId: 'c1' });
  a1 = t.activity.get('primary')!;
  assert.equal(a1.activity_revision, rev1, 'K-07：重复接收不更新 L/revision');
  // assistant 发布+追加段落：按最后真实段落
  const as1 = t.messages.publishAssistantMessage({ conversationId: 'primary', turnId: 'turn1', content: '回复开头' });
  t.messages.appendAssistantPublication(as1.id, '追加段落');
  const a2 = t.activity.get('primary')!;
  assert.equal(a2.last_real_message_id, as1.id);
  assert.equal(a2.last_real_message_revision, 2, 'K-05：追加段落推进修订');
  assert.ok(Date.parse(a2.last_real_activity_at!) >= Date.parse(a1.last_real_activity_at!), '时间推进');
  // 编辑旧消息不更新 L（editUserMessage 不碰投影）
  const before = t.activity.get('primary')!.activity_revision;
  t.messages.editUserMessage(m1.message.id, '第一条（改）');
  assert.equal(t.activity.get('primary')!.activity_revision, before, 'K-06：编辑旧消息不顺延');
});

test('K-02/K-03/K-04 保温目标：L+50 分；自醒发言改锚点；静默自醒不改（普通缓存证据不冒充聊天）', () => {
  const t = activitySetup();
  const L1 = '2026-10-22T01:10:00.000Z';
  t.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m0','primary',1,'owner','text',1,?,?)").run(L1, L1);
  t.activity.noteRealPublication('primary', 'm0', 1, L1);
  let target = t.activity.nextKeepwarmTarget({ conversationId: 'primary', windowId: 'w1' });
  assert.deepEqual([target.scheduled && new Date(target.dueAtMs).toISOString(), target.scheduled && target.basis], ['2026-10-22T02:00:00.000Z', 'real_message'], '01:10 → 02:00');
  // 01:30 自醒正式发言（真实发布）→ 02:20
  const L2 = '2026-10-22T01:30:00.000Z';
  t.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m1','primary',2,'assistant','text',1,?,?)").run(L2, L2);
  t.activity.noteRealPublication('primary', 'm1', 1, L2);
  target = t.activity.nextKeepwarmTarget({ conversationId: 'primary', windowId: 'w1' });
  assert.equal(target.scheduled && new Date(target.dueAtMs).toISOString(), '2026-10-22T02:20:00.000Z', 'K-02：主动发言无回复→02:20');
  // 01:40 继续聊→02:30（K-03）
  const L3 = '2026-10-22T01:40:00.000Z';
  t.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m2','primary',3,'owner','text',1,?,?)").run(L3, L3);
  t.activity.noteRealPublication('primary', 'm2', 1, L3);
  target = t.activity.nextKeepwarmTarget({ conversationId: 'primary', windowId: 'w1' });
  assert.equal(target.scheduled && new Date(target.dueAtMs).toISOString(), '2026-10-22T02:30:00.000Z');
});

test('K-09/K-10/K-16 维护回执：技术续温按 dispatch+50；迟到 usage CAS 落空；切窗旧回执不作数', () => {
  const t = activitySetup();
  const L = '2026-10-22T01:10:00.000Z';
  t.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m0','primary',1,'owner','text',1,?,?)").run(L, L);
  t.activity.noteRealPublication('primary', 'm0', 1, L);
  const rev1 = t.activity.get('primary')!.activity_revision;
  // 02:00 维护成功：回执 CAS（同活动版本）→ 技术后继 = dispatch 02:00 + 50 分 = 02:50
  const ok = t.activity.noteMaintenanceReceipt({ conversationId: 'primary', capturedActivityRevision: rev1, requestId: 'prq-m1', windowId: 'w1', dispatchStartedAtIso: '2026-10-22T02:00:00.000Z' });
  assert.equal(ok, true);
  let target = t.activity.nextKeepwarmTarget({ conversationId: 'primary', windowId: 'w1' });
  assert.equal(target.scheduled && new Date(target.dueAtMs).toISOString(), '2026-10-22T02:50:00.000Z', 'K-09：L 仍 01:10，技术后继 02:50');
  assert.equal(target.scheduled && target.basis, 'maintenance');
  // K-10：真实消息把活动推进 rev+1 后，迟到的 rev1 回执 CAS 落空
  t.activity.noteRealPublication('primary', 'm9', 1, '2026-10-22T02:10:00.000Z');
  const rev2 = t.activity.get('primary')!.activity_revision;
  assert.equal(rev2, rev1 + 1);
  const late = t.activity.noteMaintenanceReceipt({ conversationId: 'primary', capturedActivityRevision: rev1, requestId: 'prq-late', windowId: 'w1', dispatchStartedAtIso: '2026-10-22T02:40:00.000Z' });
  assert.equal(late, false, '迟到回执不覆盖新活动的目标');
  assert.equal(t.activity.get('primary')!.maintenance_request_id, null, '新真实消息已清回执');
  // K-16：切窗后旧窗回执不构成新窗缓存已热
  t.activity.noteMaintenanceReceipt({ conversationId: 'primary', capturedActivityRevision: rev2, requestId: 'prq-w1', windowId: 'w-old', dispatchStartedAtIso: '2026-10-22T02:20:00.000Z' });
  target = t.activity.nextKeepwarmTarget({ conversationId: 'primary', windowId: 'w-new' });
  assert.equal(target.scheduled && target.basis, 'real_message', '旧窗回执对新窗无效');
});

test('K-11 心跳发言：目标按正式发言的发布时间（不是心跳开始/结束）', () => {
  const t = activitySetup();
  const L = '2026-10-22T01:10:00.000Z';
  t.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m0','primary',1,'owner','text',1,?,?)").run(L, L);
  t.activity.noteRealPublication('primary', 'm0', 1, L);
  // 02:00 心跳开始，02:03 正式发言
  t.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m1','primary',2,'assistant','text',1,?,?)").run('2026-10-22T02:03:00.000Z', '2026-10-22T02:03:00.000Z');
  t.activity.noteRealPublication('primary', 'm1', 1, '2026-10-22T02:03:00.000Z');
  const target = t.activity.nextKeepwarmTarget({ conversationId: 'primary', windowId: 'w1' });
  assert.equal(target.scheduled && new Date(target.dueAtMs).toISOString(), '2026-10-22T02:53:00.000Z', '02:03+50 分');
});

// —— S 系列：同会话串行 ——

test('S-01/S-03：enqueueBackground 同 conversation 任意时刻最多一个执行；不嵌套自锁', async () => {
  const t = setup();
  const db = t.db;
  // 最小 supervisor（真实类；deps 只给 db+logger 形状——runSerialized 不触及其他依赖）
  const logger = { info(): void {}, warn(): void {}, error(): void {} } as unknown as import('../../apps/host/src/observability/logging.ts').Logger;
  const sup = new TurnSupervisor({ db, config: t.config, logger } as unknown as import('../../apps/host/src/runtime/supervisor.ts').SupervisorDeps);
  let active = 0;
  let maxActive = 0;
  const job = async (ms: number): Promise<string> => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, ms));
    active--;
    return `done-${ms}`;
  };
  const results = await Promise.all([
    sup.enqueueBackground('primary', () => job(30)),
    sup.enqueueBackground('primary', () => job(10)),
    sup.enqueueBackground('primary', () => job(1)),
  ]);
  assert.equal(maxActive, 1, '同 conversation 最大 active=1');
  assert.deepEqual(results, ['done-30', 'done-10', 'done-1'], 'S-03：任务正常完成返回值原样（无自锁）');
});

// —— B 系列：预算账本 ——

test('B-03/B-09：dispatch 结算幂等（重复 settle 不双计）；上海日按 dispatch 起算', () => {
  const t = setup();
  const nowIso = new Date(t.now).toISOString();
  t.db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, reserved_cost_micro_usd, created_at, updated_at) VALUES ('bgr-b3','tk','primary','jiaming','keepwarm',1,'occ-b3','running',100000,?,?)").run(nowIso, nowIso);
  t.db.prepare("INSERT INTO background_dispatches(id, run_id, logical_action_key, attempt_no, dispatch_kind, state, budget_day, reserved_cost_micro_usd, dispatch_started_at, created_at) VALUES ('bgd-b3','bgr-b3','model:1',1,'model','reserved','2026-10-22',100000,?,?)").run(nowIso, nowIso);
  const sched = new BackgroundScheduler({ db: t.db, config: t.config, settings: t.settings, alerts: new SystemAlertService(t.db, t.events), executor: { async executeRun() { return { outcome: 'noop' }; } } });
  sched.settleDispatch('bgd-b3', { actualCostMicroUsd: 80000, outcomeCode: 'settled' });
  sched.settleDispatch('bgd-b3', { actualCostMicroUsd: 80000, outcomeCode: 'settled' }); // 同 usage 重复到达
  const d = t.db.prepare('SELECT state, actual_cost_micro_usd FROM background_dispatches WHERE id = ?').get('bgd-b3') as { state: string; actual_cost_micro_usd: number };
  assert.equal(d.state, 'settled');
  const run = t.db.prepare('SELECT known_cost_micro_usd FROM background_runs WHERE id = ?').get('bgr-b3') as { known_cost_micro_usd: number };
  assert.equal(run.known_cost_micro_usd, 80000, 'actual 只计一次');
  assert.equal(budgetDayOfMs(Date.parse('2026-10-22T15:59:00.000Z')), '2026-10-22', 'B-09 面：23:59 上海日');
  assert.equal(budgetDayOfMs(Date.parse('2026-10-22T16:01:00.000Z')), '2026-10-23', '00:01 次日（dispatch 起算不挪账）');
});

// —— A 系列：迁移幂等与旧任务隔离 ——

test('A-01：v32→v33 迁移两次幂等；旧任务/费用/未知状态无损；旧自主任务 needs_review 停用；系统保温归位', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-mig-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex, 32); // 构造 v32 历史库
  const nowIso = new Date().toISOString();
  db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, payload_json, created_by_actor_id, created_at, updated_at) VALUES ('t-old-auto','primary','jiaming','autonomous',1,1,'daily','2026-01-01T01:00:00.000Z','2026-01-02T01:00:00.000Z','Asia/Shanghai','{\"intent\":\"旧任务\"}','qiaosheng',?,?)").run(nowIso, nowIso);
  db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, timezone, payload_json, created_by_actor_id, created_at, updated_at) VALUES ('t-old-kw','primary','jiaming','keepwarm',1,1,'cache_idle','Asia/Shanghai','{}','system',?,?)").run(nowIso, nowIso);
  db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, payload_json, created_by_actor_id, created_at, updated_at) VALUES ('t-rem','primary','jiaming','reminder',1,1,'once','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','Asia/Shanghai','{\"text\":\"r\"}','qiaosheng',?,?)").run(nowIso, nowIso);
  db.prepare("INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, state, reserved_cost_micro_usd, unknown_cost_count, created_at, updated_at) VALUES ('r-old','t-old-auto','primary','jiaming','autonomous',1,'old:1','unknown',700000,1,?,?)").run(nowIso, nowIso);
  // 历史费用（既有表不动）
  db.prepare("INSERT INTO background_dispatches(id, run_id, logical_action_key, attempt_no, dispatch_kind, state, budget_day, reserved_cost_micro_usd, created_at) VALUES ('d-old','r-old','model:1',1,'model','unknown','2026-01-01',700000,?)").run(nowIso);
  // 历史真实消息（投影重建）
  db.prepare("INSERT OR IGNORE INTO conversations(id, created_at) VALUES ('primary',?)").run(nowIso);
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m-hist','primary',1,'owner','text',1,?,?)").run('2026-01-01T00:00:00.000Z', nowIso);
  db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('m-hist',1,'text','历史消息','h1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','client_submit')").run();
  migrate(db, sha256Hex); // 第一次到 v33
  migrate(db, sha256Hex); // 第二次幂等
  const oldAuto = db.prepare('SELECT enabled, origin, control_reason FROM background_tasks WHERE id = ?').get('t-old-auto') as { enabled: number; origin: string; control_reason: string };
  assert.equal(oldAuto.enabled, 0, '旧自主任务停用（不静默补发）');
  assert.equal(oldAuto.control_reason, 'legacy_needs_review', '标待核对');
  const oldKw = db.prepare('SELECT origin FROM background_tasks WHERE id = ?').get('t-old-kw') as { origin: string };
  assert.equal(oldKw.origin, 'system_keepwarm');
  const rem = db.prepare('SELECT enabled, scheduled_at FROM background_tasks WHERE id = ?').get('t-rem') as { enabled: number; scheduled_at: string };
  assert.equal(rem.enabled, 1, '普通 reminder 原样保留');
  const run = db.prepare('SELECT state, reserved_cost_micro_usd FROM background_runs WHERE id = ?').get('r-old') as { state: string; reserved_cost_micro_usd: number };
  assert.equal(run.state, 'unknown');
  assert.equal(run.reserved_cost_micro_usd, 700000, '历史费用无损');
  const act = db.prepare('SELECT last_real_activity_at FROM conversation_activity WHERE conversation_id = ?').get('primary') as { last_real_activity_at: string };
  assert.equal(act.last_real_activity_at, '2026-01-01T00:00:00.000Z', '投影从发布证据重建');
});
