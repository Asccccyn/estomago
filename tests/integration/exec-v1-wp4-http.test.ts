// ESTOMAGO_CHAT_EXEC_V1 · WP4 HTTP 面与提醒投递（04 §4/§11/§13；CW-01/02 + BACKGROUND-02/13/16 面）
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

test('BACKGROUND-01/02：默认三关状态如实；开自主无预算=422；有预算但执行器未接线=422；reminder 可开', async () => {
  const s0 = await (await fetch(`${base}/api/v1/background/settings`, { headers: auth() })).json() as { autonomous: { enabled: boolean; daily_cost_cap_usd: number | null }; reminders: { enabled: boolean }; executor_ready: { autonomous: boolean } };
  assert.equal(s0.autonomous.enabled, false); // CW-01：默认关闭
  assert.equal(s0.autonomous.daily_cost_cap_usd, null); // null=未配置非无限
  assert.equal(s0.reminders.enabled, true);
  assert.equal(s0.executor_ready.autonomous, false); // 如实披露，不冒充
  // 428：无 If-Match
  const noMatch = await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'k1' }), body: JSON.stringify({ autonomous: { enabled: true, daily_cost_cap_usd: 5 } }) });
  assert.equal(noMatch.status, 428);
  // CW-02：无预算开启=422（开关未生效）
  const noBudget = await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"0"', 'Idempotency-Key': 'k2' }), body: JSON.stringify({ autonomous: { enabled: true } }) });
  assert.equal(noBudget.status, 422);
  assert.equal(((await noBudget.json()) as { error: { code: string } }).error.code, 'background_budget_not_configured');
  // 有预算但执行器未接线=422（不先开功能再等付费失败）
  const notReady = await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"0"', 'Idempotency-Key': 'k3' }), body: JSON.stringify({ autonomous: { enabled: true, daily_cost_cap_usd: 5 } }) });
  assert.equal(notReady.status, 422);
  assert.equal(((await notReady.json()) as { error: { code: string } }).error.code, 'background_executor_not_ready');
  // 旧 If-Match 重放=409
  const stale = await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"0"', 'Idempotency-Key': 'k4' }), body: JSON.stringify({ reminders: { enabled: false } }) });
  assert.equal(stale.status, 200); // k4 是新键——reminders 关闭成功（revision 0→1）
  const stale2 = await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"0"', 'Idempotency-Key': 'k5' }), body: JSON.stringify({ reminders: { enabled: true } }) });
  assert.equal(stale2.status, 409, '旧 revision 拒（并发门）');
  // 恢复 reminders 开
  const ok = await fetch(`${base}/api/v1/background/settings`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"1"', 'Idempotency-Key': 'k6' }), body: JSON.stringify({ reminders: { enabled: true } }) });
  assert.equal(ok.status, 200);
});

test('BACKGROUND-16 面：任务 CRUD 的 If-Match/幂等键/保温不可手建；周期自主≥60min', async () => {
  const create = await fetch(`${base}/api/v1/background/tasks`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'task-1' }), body: JSON.stringify({ kind: 'reminder', schedule_kind: 'once', scheduled_at: '2099-01-01T00:00:00Z', payload: { text: '测试提醒' } }) });
  assert.equal(create.status, 201);
  const task = (await create.json()) as { task_id: string };
  // keepwarm 手建拒绝
  const kw = await fetch(`${base}/api/v1/background/tasks`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'task-kw' }), body: JSON.stringify({ kind: 'keepwarm', scheduled_at: '2099-01-01T00:00:00Z' }) });
  assert.equal(kw.status, 400);
  // 周期自主 <60min 拒
  const short = await fetch(`${base}/api/v1/background/tasks`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'task-s' }), body: JSON.stringify({ kind: 'autonomous', schedule_kind: 'interval', scheduled_at: '2099-01-01T00:00:00Z', interval_ms: 60000 }) });
  assert.equal(short.status, 422);
  // PUT 无 If-Match=428；错版本=409；对版本=200
  const p428 = await fetch(`${base}/api/v1/background/tasks/${task.task_id}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 't1a' }), body: JSON.stringify({ enabled: false }) });
  assert.equal(p428.status, 428);
  const p409 = await fetch(`${base}/api/v1/background/tasks/${task.task_id}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"9"', 'Idempotency-Key': 't1b' }), body: JSON.stringify({ enabled: false }) });
  assert.equal(p409.status, 409);
  const p200 = await fetch(`${base}/api/v1/background/tasks/${task.task_id}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"1"', 'Idempotency-Key': 't1c' }), body: JSON.stringify({ enabled: false }) });
  assert.equal(p200.status, 200);
  // DELETE：取消未来领取（不删历史执行记录）
  const del = await fetch(`${base}/api/v1/background/tasks/${task.task_id}`, { method: 'DELETE', headers: auth({ Origin: base, 'If-Match': '"2"', 'Idempotency-Key': 't1d' }) });
  assert.equal(del.status, 200);
  const list = await (await fetch(`${base}/api/v1/background/tasks`, { headers: auth() })).json() as { tasks: Array<{ id: string; enabled: number }> };
  const row = list.tasks.find((t) => t.id === task.task_id)!;
  assert.equal(row.enabled, 0, '取消=禁用未来领取（记录保留）');
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
  const runs = await (await fetch(`${base}/api/v1/background/runs`, { headers: auth() })).json() as { runs: Array<{ task_id: string; kind: string; state: string; result_code: string | null }> };
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
  const stopRes = await (await fetch(`${base}/api/v1/background/runs/${run!.state === 'completed' ? runs.runs[0]!.task_id : ''}/stop`, { method: 'POST', headers: auth({ Origin: base, 'Idempotency-Key': 's1' }) }).catch(() => null));
  void stopRes;
  const list2 = await (await fetch(`${base}/api/v1/background/runs`, { headers: auth() })).json() as { runs: Array<{ id: string; state: string }> };
  const doneRun = list2.runs.find((r) => r.state === 'completed')!;
  const stop = await (await fetch(`${base}/api/v1/background/runs/${doneRun.id}/stop`, { method: 'POST', headers: auth({ Origin: base, 'Idempotency-Key': 's2' }) })).json() as { state: string; stopping: boolean };
  assert.equal(stop.state, 'completed');
  assert.equal(stop.stopping, false, '已结束=如实（不拿按钮状态冒充）');
});
