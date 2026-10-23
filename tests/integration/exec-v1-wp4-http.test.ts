// ESTOMAGO_CHAT_EXEC_V1 · WP4 HTTP 面 + WAKE_KEEPWARM_V1（2026-10-22 改写）：
// 任务管理转 BackgroundTaskService 后的 HTTP 合同（A-02/A-03/A-06/A-04 面）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

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
  assert.equal(sleep.keepwarm_status.blocked_reason, 'KEEPWARM_SLEEP_WINDOW');
  assert.equal(sleep.keepwarm_status.scheduled, false);
  assert.equal(sleep.keepwarm_status.local_time, '23:00');
  assert.equal(sleep.keepwarm_status.next_keepwarm_at, undefined);
  t.mock.timers.setTime(Date.parse('2026-10-24T08:00:00+08:00'));
  const awake = await read();
  assert.equal(awake.keepwarm_status.sleep_window_active, false);
  assert.equal(awake.keepwarm_status.blocked_reason, null);
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

test('WAKE/A-02/A-03/A-06：自主预约 HTTP 创建走 service——服务端幂等+CAS+瘦返回；取消递增 revision', async () => {
  // 自主开关关 → SELF_WAKE_DISABLED（422）
  const disabled = await fetch(`${base}/api/v1/background/tasks`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'w-d1' }), body: JSON.stringify({ note: 'x', delay_seconds: 600 }) });
  assert.equal(disabled.status, 422);
  assert.equal(((await disabled.json()) as { error: { code: string } }).error.code, 'self_wake_disabled');
  // 开自主（有预算）
  const cur = await (await fetch(`${base}/api/v1/background/settings`, { headers: auth() })).json() as { revision: number };
  await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': `"${cur.revision}"`, 'Idempotency-Key': 'w-e1' }), body: JSON.stringify({ autonomous: { enabled: true, daily_cost_cap_usd: 5 } }) });
  // 创建（服务端幂等：同 Idempotency-Key 重放返回同一任务）
  const c1 = await fetch(`${base}/api/v1/background/tasks`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'w-op1' }), body: JSON.stringify({ note: '提醒宿主用户读书', delay_seconds: 600 }) });
  assert.equal(c1.status, 201);
  const t1 = (await c1.json()) as { task_id: string; scheduled_at: string; revision: number };
  const c2 = await fetch(`${base}/api/v1/background/tasks`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'w-op1' }), body: JSON.stringify({ note: '提醒宿主用户读书', delay_seconds: 600 }) });
  assert.equal(c2.status, 200);
  const t2 = (await c2.json()) as { task_id: string; duplicate: boolean };
  assert.equal(t2.task_id, t1.task_id, 'W-08 面：同键重放同一任务');
  assert.equal(t2.duplicate, true);
  // 时间校验：过去时间 422 + server_now
  const past = await fetch(`${base}/api/v1/background/tasks`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'w-op2' }), body: JSON.stringify({ note: 'x', at: '2020-01-01T00:00:00Z' }) });
  assert.equal(past.status, 422);
  // A-02：PUT CAS——旧 revision 409
  const p409 = await fetch(`${base}/api/v1/background/tasks/${t1.task_id}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"9"', 'Idempotency-Key': 'w-u1' }), body: JSON.stringify({ note: '改' }) });
  assert.equal(p409.status, 409);
  const p200 = await fetch(`${base}/api/v1/background/tasks/${t1.task_id}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': `"${t1.revision}"`, 'Idempotency-Key': 'w-u2' }), body: JSON.stringify({ note: '改后的note' }) });
  assert.equal(p200.status, 200);
  // A-06：列表瘦返回（无 payload/全文 note；有 note_preview/next_cursor）
  const list = await (await fetch(`${base}/api/v1/background/tasks`, { headers: auth() })).json() as { tasks: Array<{ task_id: string; revision: number; status: string; note_preview: string | null; payload_json?: unknown; note?: unknown }>; next_cursor: string | null };
  const row = list.tasks.find((t) => t.task_id === t1.task_id)!;
  assert.equal(row.revision, t1.revision + 1, '修改递增 revision');
  assert.ok(typeof row.note_preview === 'string' && row.note_preview.length <= 81, '短预览');
  assert.equal('payload_json' in row, false, '不回 payload');
  assert.equal('note' in row, false, '列表不回全文——详情按需读');
  // 详情含全文
  const detail = await (await fetch(`${base}/api/v1/background/tasks/${t1.task_id}`, { headers: auth() })).json() as { task: { note: string } };
  assert.equal(detail.task.note, '改后的note');
  // A-03：DELETE 递增 revision（不只 enabled=0）
  const del = await fetch(`${base}/api/v1/background/tasks/${t1.task_id}`, { method: 'DELETE', headers: auth({ Origin: base, 'If-Match': `"${t1.revision + 1}"`, 'Idempotency-Key': 'w-d2' }) });
  assert.equal(del.status, 200);
  const after = await (await fetch(`${base}/api/v1/background/tasks/${t1.task_id}`, { headers: auth() })).json() as { task: { revision: number; status: string } };
  assert.equal(after.task.revision, t1.revision + 2, '取消也递增 revision');
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
