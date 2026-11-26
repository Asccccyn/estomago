// ESTOMAGO_CHAT_EXEC_V1 · WP4 HTTP 面 + WAKE_KEEPWARM_V1（2026-10-22 改写）：
// 任务管理转 BackgroundTaskService 后的 HTTP 合同（A-02/A-03/A-06/A-04 面）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { BackgroundTaskService } from '../../apps/host/src/runtime/background-task-service.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';

const root = tempRoot('exec-v1-wp4-http-');
writeApprovedIdentity(root);
let host: Host;
let base = '';
let token = '';
const auth = (extra: Record<string, string> = {}): Record<string, string> => ({ Authorization: `Bearer ${token}`, ...extra });

before(async () => {
  const config = buildConfig({ ...readyRuntimePatch(), deployment: { port: 0 }, runtime: { ...readyRuntimePatch().runtime, provider: 'mock' } });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
});
after(async () => { await host.stop(); });

test('睡眠 JSON 元数据：配置可见，23:00 active/无排程，08:00解除；读设置零模型回合', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T23:00:00+08:00') });
  const read = async () => await (await fetch(`${base}/api/v1/background/settings`, { headers: auth() })).json() as {
    keepwarm: { sleep_window: { enabled: boolean; start: string; end: string; timezone: string } };
    keepwarm_status: { scheduled: boolean; sleep_window_active: boolean; blocked_reason: string | null; local_time: string; next_keepwarm_at?: string };
  };
  const sleep = await read();
  assert.deepEqual(sleep.keepwarm.sleep_window, { enabled: true, start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' });
  assert.equal(sleep.keepwarm_status.sleep_window_active, true);
  // v2.1：手动总开关关闭优先于一切自动暂停原因，同时仍如实暴露睡眠时段元数据。
  assert.equal(sleep.keepwarm_status.blocked_reason, 'KEEPWARM_DISABLED');
  assert.equal(sleep.keepwarm_status.scheduled, false);
  assert.equal(sleep.keepwarm_status.local_time, '23:00');
  assert.equal(sleep.keepwarm_status.next_keepwarm_at, undefined);
  t.mock.timers.setTime(Date.parse('2026-10-24T08:00:00+08:00'));
  const awake = await read();
  assert.equal(awake.keepwarm_status.sleep_window_active, false);
  // This fixture never switched keepwarm on: the page says so instead of showing a time.
  assert.equal(awake.keepwarm_status.blocked_reason, 'KEEPWARM_DISABLED');
  assert.equal(awake.keepwarm_status.local_time, '08:00');
  assert.equal((host.db.prepare('SELECT COUNT(*) n FROM turns').get() as { n: number }).n, 0);
});

test('BACKGROUND-01/02：默认三关状态如实；开自主无预算=422；有预算可开；revision CAS', async () => {
  const s0 = await (await fetch(`${base}/api/v1/background/settings`, { headers: auth() })).json() as { autonomous: { enabled: boolean; daily_cost_cap_usd: number | null }; reminders: { enabled: boolean }; executor_ready: { autonomous: boolean } };
  assert.equal(s0.autonomous.enabled, false); // CW-01：默认关闭
  assert.equal(s0.autonomous.daily_cost_cap_usd, null); // null=未配置非无限
  assert.equal(s0.reminders.enabled, true);
  assert.equal(s0.executor_ready.autonomous, true);
  // 428：无 If-Match
  const noMatch = await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'k1' }), body: JSON.stringify({ autonomous: { enabled: true, daily_cost_cap_usd: 5 } }) });
  assert.equal(noMatch.status, 428);
  // CW-02：无预算开启=422（开关未生效）
  const noBudget = await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"0"', 'Idempotency-Key': 'k2' }), body: JSON.stringify({ autonomous: { enabled: true } }) });
  assert.equal(noBudget.status, 422);
  // 有预算开启成功
  const enableOk = await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"0"', 'Idempotency-Key': 'k3' }), body: JSON.stringify({ autonomous: { enabled: true, daily_cost_cap_usd: 5 } }) });
  assert.equal(enableOk.status, 200);
  const stale = await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"0"', 'Idempotency-Key': 'k4' }), body: JSON.stringify({ reminders: { enabled: false } }) });
  assert.equal(stale.status, 409, 'A-05 面：旧 revision 拒');
  await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"1"', 'Idempotency-Key': 'k5' }), body: JSON.stringify({ autonomous: { enabled: false } }) });
});

test('WAKE/A-02/A-03/A-06：用户不能代设或改自约；管理面仍可读、取消并保留既有 CAS', async () => {
  // 自主开关无论开关，owner 不可以代创建。
  const disabled = await fetch(`${base}/api/v1/background/tasks`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'w-d1' }), body: JSON.stringify({ note: 'x', delay_seconds: 600 }) });
  assert.equal(disabled.status, 403);
  assert.equal(((await disabled.json()) as { error: { code: string } }).error.code, 'self_wake_owner_only');
  // 开自主（有预算）
  const cur = await (await fetch(`${base}/api/v1/background/settings`, { headers: auth() })).json() as { revision: number };
  await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': `"${cur.revision}"`, 'Idempotency-Key': 'w-e1' }), body: JSON.stringify({ autonomous: { enabled: true, daily_cost_cap_usd: 5 } }) });
  // 自主打开后仍不授予用户代设权。用拥有者 service 建立真实任务，
  // C07 另从模型工具创建/重放/调度。
  const c1 = await fetch(`${base}/api/v1/background/tasks`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'w-op1' }), body: JSON.stringify({ note: '提醒宿主用户读书', delay_seconds: 600 }) });
  assert.equal(c1.status, 403);
  const service = new BackgroundTaskService(host.db, new BackgroundSettingsService(host.db, host.config));
  const created = service.schedule({ actorId: 'jiaming', createdBy: 'jiaming', conversationId: 'primary', operationId: 'self-op-1', note: '提醒宿主用户读书', delaySeconds: 600 });
  assert.ok(created.ok);
  if (!created.ok) return;
  const t1 = created.task;
  // 用户 PUT 即便 revision 匹配也不获得改期/改正文权限。
  const p409 = await fetch(`${base}/api/v1/background/tasks/${t1.task_id}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"9"', 'Idempotency-Key': 'w-u1' }), body: JSON.stringify({ note: '改' }) });
  assert.equal(p409.status, 403);
  const p200 = await fetch(`${base}/api/v1/background/tasks/${t1.task_id}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': `"${t1.revision}"`, 'Idempotency-Key': 'w-u2' }), body: JSON.stringify({ note: '改后的note' }) });
  assert.equal(p200.status, 403);
  // A-06：列表瘦返回（无 payload/全文 note；有 note_preview/next_cursor）
  const list = await (await fetch(`${base}/api/v1/background/tasks`, { headers: auth() })).json() as { tasks: Array<{ task_id: string; revision: number; status: string; note_preview: string | null; payload_json?: unknown; note?: unknown }>; next_cursor: string | null };
  const row = list.tasks.find((t) => t.task_id === t1.task_id)!;
  assert.equal(row.revision, t1.revision, '代改不产生新修订');
  assert.ok(typeof row.note_preview === 'string' && row.note_preview.length <= 81, '短预览');
  assert.equal('payload_json' in row, false, '不回 payload');
  assert.equal('note' in row, false, '列表不回全文——详情按需读');
  // 详情含全文
  const detail = await (await fetch(`${base}/api/v1/background/tasks/${t1.task_id}`, { headers: auth() })).json() as { task: { note: string; created_by: string; scheduled_at: string } };
  assert.equal(detail.task.note, '提醒宿主用户读书');
  assert.equal(detail.task.created_by, 'jiaming');
  assert.equal(detail.task.scheduled_at, t1.scheduled_at);
  // A-03：DELETE 递增 revision（不只 enabled=0）
  const del = await fetch(`${base}/api/v1/background/tasks/${t1.task_id}`, { method: 'DELETE', headers: auth({ Origin: base, 'If-Match': `"${t1.revision}"`, 'Idempotency-Key': 'w-d2' }) });
  assert.equal(del.status, 200);
  const after = await (await fetch(`${base}/api/v1/background/tasks/${t1.task_id}`, { headers: auth() })).json() as { task: { revision: number; status: string } };
  assert.equal(after.task.revision, t1.revision + 1, '取消也递增 revision');
  assert.equal(after.task.status, 'cancelled');
});

test('BACKGROUND-13/14：到期提醒零模型投递为 system 消息；runs 可见；stop 语义', async () => {
  // 建 1 秒后到期的提醒（完整时间不暗补）
  const dueAt = new Date(Date.now() + 300).toISOString();
  const create = await fetch(`${base}/api/v1/background/tasks`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'task-deliver' }), body: JSON.stringify({ kind: 'reminder', schedule_kind: 'once', scheduled_at: dueAt, payload: { text: '到点提醒测试' } }) });
  const task = (await create.json()) as { task_id: string };
  // 等调度器领取执行（宿主内 15s 心跳——手动踢一次 tick 加速）
  await new Promise((r) => setTimeout(r, 500));
  await host.scheduler!.tick();
  await new Promise((r) => setTimeout(r, 200));
  const runs = await (await fetch(`${base}/api/v1/background/runs`, { headers: auth() })).json() as { runs: Array<{ id: string; task_id: string; kind: string; state: string; result_code: string | null }> };
  const run = runs.runs.find((r) => r.task_id === task.task_id);
  assert.ok(run, '运行记录可见');
  assert.equal(run.kind, 'reminder');
  assert.equal(run.state, 'completed');
  assert.equal(run.result_code, 'delivered');
  // system 消息入聊天历史（零模型调用——mock runner 无 turn 产生）
  const msgs = await (await fetch(`${base}/api/v1/conversations/primary/messages?limit=50`, { headers: auth() })).json() as { messages: Array<{ speaker: string; kind: string; revision: { content: string } }> };
  const delivered = msgs.messages.find((m) => m.speaker === 'system' && m.revision.content.includes('到点提醒测试'));
  assert.ok(delivered, '提醒以 system 消息投递（不冒充char发言）');
  const turns = host.db.prepare('SELECT COUNT(*) n FROM turns').get() as { n: number };
  assert.equal(turns.n, 0, '全过程零模型回合');
  // stop：已结束的执行返回实际状态（不冒充停止中）
  const stop = await (await fetch(`${base}/api/v1/background/runs/${run!.id}/stop`, { method: 'POST', headers: auth({ Origin: base, 'Idempotency-Key': 's2' }) })).json() as { state: string; stopping: boolean };
  assert.equal(stop.state, 'completed');
  assert.equal(stop.stopping, false, '已结束=如实（不拿按钮状态冒充）');
});

type StatusBody = {
  revision: number
  keepwarm: { enabled: boolean }
  keepwarm_status: { scheduled: boolean; blocked_reason: string | null; sleep_window_active: boolean;
    next_keepwarm_at?: string; next_keepwarm_basis?: string; resting: boolean; rest_decided_at: string | null }
};

test('T-A02：页面只给出调度器能兑现的预计时间——到点落在睡眠时段、休息中、开关关闭都不承诺唤醒', async (t) => {
  const settings = new BackgroundSettingsService(host.db, host.config);
  let revision = (await (await fetch(`${base}/api/v1/background/settings`, { headers: auth() })).json() as StatusBody).revision;
  if ((host.db.prepare("SELECT value FROM runtime_settings WHERE key='background.settings'").get() as { value: string } | undefined)) {
    host.db.prepare("DELETE FROM runtime_settings WHERE key='background.settings'").run();
    host.db.prepare("UPDATE background_tasks SET enabled=0 WHERE kind='keepwarm'").run();
  }
  host.messages.ensureConversation('primary');
  const stamp = new Date().toISOString();
  host.db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('status-window','primary','ACTIVE',?,?)").run(stamp, stamp);
  host.db.prepare("UPDATE conversations SET active_window_id='status-window' WHERE id='primary'").run();
  host.db.prepare("INSERT INTO conversation_activity(conversation_id,activity_revision,last_real_activity_at,updated_at) VALUES ('primary',1,'2026-10-23T14:40:00+08:00',?)").run(stamp);
  const read = async () => await (await fetch(`${base}/api/v1/background/settings`, { headers: auth() })).json() as StatusBody;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T14:45:00+08:00') });
  assert.equal((await read()).keepwarm_status.blocked_reason, 'KEEPWARM_DISABLED', '开关关闭时不给时间');
  settings.applyUpdate({ expectedRevision: revision, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 5 } });
  revision += 1;
  const day = await read();
  assert.equal(day.keepwarm_status.blocked_reason, null);
  assert.equal(day.keepwarm_status.scheduled, true);
  assert.equal(day.keepwarm_status.next_keepwarm_at, '2026-10-23T07:30:00.000Z', '白天照常给出 L+50 分钟');
  assert.equal(day.keepwarm_status.next_keepwarm_basis, 'real_message');

  // 22:40 的最后一条消息把目标推到 23:30：那一刻在睡眠时段里，不能显示成可执行的唤醒。
  t.mock.timers.setTime(Date.parse('2026-10-23T22:45:00+08:00'));
  host.db.prepare("UPDATE conversation_activity SET last_real_activity_at='2026-10-23T22:40:00+08:00' WHERE conversation_id='primary'").run();
  const ahead = (await read()).keepwarm_status;
  assert.deepEqual({ scheduled: ahead.scheduled, reason: ahead.blocked_reason, active: ahead.sleep_window_active, next: ahead.next_keepwarm_at },
    { scheduled: false, reason: 'KEEPWARM_SLEEP_WINDOW', active: false, next: undefined });
  t.mock.timers.setTime(Date.parse('2026-10-23T23:30:00+08:00'));
  assert.equal((await read()).keepwarm_status.sleep_window_active, true, '到点时确实在静默期内');

  // 休息中优先于一切时间；恢复后按原锚点重算，不另造一次补偿。
  t.mock.timers.setTime(Date.parse('2026-10-23T21:00:00+08:00'));
  host.db.prepare("UPDATE conversation_activity SET last_real_activity_at='2026-10-23T20:55:00+08:00' WHERE conversation_id='primary'").run();
  const resumed = await (await fetch(`${base}/api/v1/background/heartbeat/resume`, { method: 'POST', headers: auth({ Origin: base, 'Idempotency-Key': 'resume-before-rest' }) })).json();
  assert.deepEqual(resumed, { resting: false, changed: false, duplicate: false }, '没有在休息时恢复是空操作');
  host.db.prepare("UPDATE conversation_activity SET resting=1, rest_decided_at='2026-10-23T21:00:00+08:00', rest_source='owner_message', rest_recovery_mode='next_user_message', rest_morning_date=NULL WHERE conversation_id='primary'").run();
  const resting = (await read()).keepwarm_status;
  assert.equal(resting.resting, true);
  assert.equal(resting.rest_decided_at, '2026-10-23T21:00:00+08:00');
  assert.equal(resting.blocked_reason, 'KEEPWARM_RESTING_WAIT_USER');
  assert.equal(resting.scheduled, false);
  assert.equal(resting.next_keepwarm_at, undefined);
  // 正常夜休（morning_0800）按 v2.1 暂停普通心跳，并在 morning_wake 预告次晨 08:00 有条件兜底。
  host.db.prepare("UPDATE conversation_activity SET rest_recovery_mode='morning_0800', rest_morning_date='2026-10-24' WHERE conversation_id='primary'").run();
  const nightRest = (await read()).keepwarm_status as StatusBody['keepwarm_status'] & { morning_wake?: { scheduled: boolean; target_at?: string } };
  assert.equal(nightRest.resting, true);
  assert.equal(nightRest.blocked_reason, 'KEEPWARM_RESTING');
  assert.equal(nightRest.scheduled, false);
  assert.equal(nightRest.next_keepwarm_at, undefined);
  assert.equal(nightRest.morning_wake?.scheduled, true);
  assert.equal(nightRest.morning_wake?.target_at, '2026-10-24T00:00:00.000Z');
  const first = await (await fetch(`${base}/api/v1/background/heartbeat/resume`, { method: 'POST', headers: auth({ Origin: base, 'Idempotency-Key': 'resume-op' }) })).json();
  assert.deepEqual(first, { resting: false, changed: true, duplicate: false });
  const replay = await (await fetch(`${base}/api/v1/background/heartbeat/resume`, { method: 'POST', headers: auth({ Origin: base, 'Idempotency-Key': 'resume-op' }) })).json();
  assert.deepEqual(replay, { resting: false, changed: true, duplicate: true }, '同一操作重放首次结果');
  const again = await (await fetch(`${base}/api/v1/background/heartbeat/resume`, { method: 'POST', headers: auth({ Origin: base, 'Idempotency-Key': 'resume-again' }) })).json();
  assert.deepEqual(again, { resting: false, changed: false, duplicate: false });
  const after = await read();
  assert.equal(after.keepwarm_status.resting, false);
  assert.equal(after.keepwarm_status.scheduled, true);
  assert.equal(after.keepwarm_status.next_keepwarm_at, '2026-10-23T13:45:00.000Z', '锚点未被界面操作改动');
  assert.equal(after.keepwarm.enabled, true, '总开关保持原样');
  assert.equal((await fetch(`${base}/api/v1/background/heartbeat/resume`, { method: 'POST', headers: auth({ Origin: base }) })).status, 400, '缺少操作键被拒');

  // 开关原本关闭时，恢复休息不会替她打开。
  settings.applyUpdate({ expectedRevision: after.revision, patch: { keepwarm_enabled: false } });
  host.db.prepare("UPDATE conversation_activity SET resting=1 WHERE conversation_id='primary'").run();
  assert.equal((await read()).keepwarm_status.blocked_reason, 'KEEPWARM_DISABLED', '开关关闭先于休息说明');
  await fetch(`${base}/api/v1/background/heartbeat/resume`, { method: 'POST', headers: auth({ Origin: base, 'Idempotency-Key': 'resume-off-switch' }) });
  const closed = await read();
  assert.equal(closed.keepwarm.enabled, false);
  assert.equal(closed.keepwarm_status.resting, false);
  assert.equal(closed.keepwarm_status.blocked_reason, 'KEEPWARM_DISABLED');
  assert.equal((host.db.prepare("SELECT COUNT(*) n FROM messages WHERE client_message_id IS NULL AND speaker='owner'").get() as { n: number }).n, 0, '恢复不伪造聊天');
});
