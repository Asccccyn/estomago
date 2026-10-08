// AUD-03 回归（mock 层）：window→sdk_session_id 持久映射、同窗后续轮 resume、
// 重启后沿用、新窗新 session、跨会话隔离。真实 SDK session 语义验收另行 BLOCKED。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch, OBSERVED_SDK, pollUntil } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

const root = tempRoot('aud03-');
writeApprovedIdentity(root);
let host: Host;
let base = '';
let token = '';

before(async () => {
  const config = buildConfig({
    deployment: { port: 0 },
    runtime: { provider: 'mock', model: 'fixture-model', sdk_version: OBSERVED_SDK, runtime_version: 'node-test', auth_and_billing_verified: true, capability_state: 'verified' },
  });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
});
after(async () => { await host.stop(); });

async function submit(conv: string, cmid: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/conversations/${conv}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `m-${cmid}`, client_message_id: cmid }),
  });
  const data = (await res.json()) as { turn_id: string };
  return data.turn_id;
}
async function waitDone(turnId: string): Promise<void> {
  await pollUntil(async () => {
    const r = await fetch(`${base}/api/v1/turns/${turnId}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = (await r.json()) as { turn: { state: string } };
    return ['completed', 'failed', 'blocked', 'interrupted', 'route_pending'].includes(d.turn.state);
  }, 8000);
  const r = await fetch(`${base}/api/v1/turns/${turnId}`, { headers: { Authorization: `Bearer ${token}` } });
  const d = (await r.json()) as { turn: { state: string } };
  assert.equal(d.turn.state, 'completed', `turn 应完成（实际 ${d.turn.state}）`);
}
const dbSession = async () => (host.db.prepare("SELECT sdk_session_id FROM windows WHERE status='ACTIVE' AND conversation_id='primary'").get() as { sdk_session_id: string | null }).sdk_session_id;

test('首轮建立并持久化 session；第二轮 resume 同一 session', async () => {
  const t1 = await submit('primary', 's1');
  await waitDone(t1);
  const sess1 = await dbSession();
  assert.ok(sess1, '首轮后必须持久化 sdk_session_id');
  const t2 = await submit('primary', 's2');
  await waitDone(t2);
  const sess2 = await dbSession();
  assert.equal(sess2, sess1, '同窗后续轮沿用同一 session');
});

test('重启（同 state root 重组 Host）后从 DB 恢复 session 继续沿用', async () => {
  const sessBefore = await dbSession();
  await host.stop();
  const config = buildConfig({
    deployment: { port: 0 },
    runtime: { provider: 'mock', model: 'fixture-model', sdk_version: OBSERVED_SDK, runtime_version: 'node-test', auth_and_billing_verified: true, capability_state: 'verified' },
  });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  const sessAfter = await dbSession();
  assert.equal(sessAfter, sessBefore, '重启不得偷换单测上下文');
  const t3 = await submit('primary', 's3');
  await waitDone(t3);
  assert.equal(await dbSession(), sessBefore);
});

test('跨会话隔离：不同 conversation 不共用 session', async () => {
  const primarySession = await dbSession();
  // D3（2026-10-06）：HTTP 凭空建房已关——跨房隔离验证改为直接建房间行
  host.db.prepare("INSERT OR IGNORE INTO conversations(id, owner_service, scope, created_at) VALUES ('room-b','estomago','private',?)").run(new Date().toISOString());
  const t = await submit('room-b', 'b1');
  await waitDone(t);
  const bRow = host.db.prepare("SELECT sdk_session_id FROM windows WHERE status='ACTIVE' AND conversation_id='room-b'").get() as { sdk_session_id: string | null };
  assert.ok(bRow.sdk_session_id);
  assert.notEqual(bRow.sdk_session_id, primarySession, '房间 B 必须有独立 session');
});

test('换窗产生新 session（新窗 sdk_session_id 从 null 开始）', async () => {
  const before = await dbSession();
  const win = host.windows.activeWindow('primary')!;
  // WP3（2026-10-08 她裁定）：换窗历史只经人工选集——先确认选集再换窗
  //（SDK 驱动测试环境：明确空选合法；rotate 不再是无选集旁路）
  const confirmRes = await fetch(`${base}/api/v1/windows/${win.id}/context-selection/confirm`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ explicit_empty: true, idempotency_key: 'aud03-sel' }),
  });
  assert.equal(confirmRes.status, 200, `选集确认应 200：${await confirmRes.text()}`);
  const res = await fetch(`${base}/api/v1/windows/${win.id}/rotate`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  const newWin = host.windows.activeWindow('primary')!;
  assert.notEqual(newWin.id, win.id);
  assert.equal(newWin.sdk_session_id, null, '新窗从新 session 开始（旧 session 不续用）');
  const t = await submit('primary', 's4');
  await waitDone(t);
  const after = await dbSession();
  assert.ok(after && after !== before, '新窗首轮必须建立新 session');
});
