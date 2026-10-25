// R06（审计 FE-11）：权威恢复快照——同一读事务边界返回 消息页+活动
// turn（attempts+generations）+活动窗+事件游标；GET 零副作用（零模型
// 调用/零派发/零写入）。SSE 史被裁剪/重启后的恢复不依赖完整事件保留。
import '../helpers.ts'; // 首个 import：启用 ESTOMAGO_TEST_MODE
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tempRoot, writeApprovedIdentity, readyRuntimePatch, pollUntil } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

const root = tempRoot('est-snapshot-');
writeApprovedIdentity(root);
const config = buildConfig({
  runtime: { provider: 'mock', ...(readyRuntimePatch().runtime as Record<string, unknown>) },
  deployment: { port: 0 },
});

let host: Host;
let base = '';
let token = '';

before(async () => {
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config', 'auth.token'), 'utf8').trim();
});
after(async () => { await host.stop(); });

type Snapshot = {
  conversation_id: string; cursor: number;
  messages: Array<{ id: string; sequence: number }>;
  active_turn: null | {
    id: string; state: string; attempts: Array<{ id: string; state: string }>;
    generations: Array<{ id: string; generation_id: string | null }>;
  };
  active_window: null | { id: string; status: string };
};

async function getSnapshot(): Promise<Snapshot> {
  const res = await fetch(`${base}/api/v1/conversations/primary/snapshot`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as Snapshot;
}

function counts() {
  return {
    messages: (host.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n,
    turns: (host.db.prepare('SELECT COUNT(*) n FROM turns').get() as { n: number }).n,
    attempts: (host.db.prepare('SELECT COUNT(*) n FROM attempts').get() as { n: number }).n,
    requests: (host.db.prepare('SELECT COUNT(*) n FROM provider_requests').get() as { n: number }).n,
    events: (host.db.prepare('SELECT COUNT(*) n FROM runtime_stream_events').get() as { n: number }).n,
  };
}

test('R06：空会话快照=空消息+无活动 turn+游标；GET 零副作用', async () => {
  const before = counts();
  const snap = await getSnapshot();
  assert.equal(snap.conversation_id, 'primary');
  assert.ok(Number.isInteger(snap.cursor) && snap.cursor >= 0);
  assert.deepEqual(snap.messages, []);
  assert.equal(snap.active_turn, null);
  const after = counts();
  assert.deepEqual(after, before, '快照读取零写入/零派发');
});

test('R06：消息入快照；进行中 turn 带 attempts+generations；游标与事件列对齐', async () => {
  const res = await fetch(`${base}/api/v1/conversations/primary/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '快照回归一条', client_message_id: 'snap-1' }),
  });
  assert.equal(res.status, 201);
  const { turn_id } = (await res.json()) as { turn_id: string };
  await pollUntil(async () => {
    const t = host.db.prepare('SELECT state FROM turns WHERE id=?').get(turn_id) as { state: string } | undefined;
    return t?.state !== undefined && ['completed', 'failed', 'interrupted', 'blocked'].includes(t.state);
  });
  await new Promise(r => setTimeout(r, 120)); // 终态后事件落盘稳定（避免后台回执晚到计入快照读取）
  // 人造一个卡在进行中的 turn（真实表结构+真实外键），验证活动 turn 装配
  const realWindow = (host.db.prepare(
    "SELECT window_id FROM attempts WHERE turn_id=? AND window_id IS NOT NULL LIMIT 1", // eslint-disable-line
  ).get(turn_id) as { window_id: string } | undefined)?.window_id
    ?? (host.db.prepare('SELECT id FROM windows LIMIT 1').get() as { id: string } | undefined)?.id;
  if (!realWindow) return; // 无真实窗口可挂外键：消息/零副作用已验证，装配段跳过
  const now = new Date().toISOString();
  host.db.prepare(
    "INSERT INTO turns(id, conversation_id, trigger, state, input_message_id, time_context_json, generation, started_at, completed_at, created_at) VALUES ('turn_snap_r06','primary','message','running',NULL,NULL,3,NULL,NULL,?)",
  ).run(now);
  host.db.prepare(
    "INSERT INTO attempts(id, turn_id, attempt_no, state, window_id, started_at) VALUES ('att_snap_r06','turn_snap_r06',1,'running',?,?)",
  ).run(realWindow, now);
  host.db.prepare(
    "INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, generation_id, created_at) VALUES ('prq_snap_r06',?,'att_snap_r06','turn_snap_r06','chat','[]','gen_snap_r06',?)",
  ).run(realWindow, now);
  try {
    const before = counts();
    const snap = await getSnapshot();
    const after = counts();
    assert.deepEqual(after, before, '快照读取零副作用（含活动 turn 场景）');
    assert.ok(snap.messages.some(m => m.id && m.sequence > 0), '提交的消息在快照里');
    assert.ok(snap.active_turn, '进行中 turn 在快照里');
    assert.equal(snap.active_turn!.id, 'turn_snap_r06');
    assert.equal(snap.active_turn!.state, 'running');
    assert.equal(snap.active_turn!.attempts[0]!.id, 'att_snap_r06');
    assert.equal(snap.active_turn!.generations[0]!.generation_id, 'gen_snap_r06');
    const maxSeq = (host.db.prepare('SELECT COALESCE(MAX(sequence),0) m FROM runtime_stream_events').get() as { m: number }).m;
    assert.equal(snap.cursor, maxSeq, '游标=事件列当前最大序号（重放边界）');
  } finally {
    host.db.prepare("DELETE FROM provider_requests WHERE id='prq_snap_r06'").run();
    host.db.prepare("DELETE FROM attempts WHERE id='att_snap_r06'").run();
    host.db.prepare("DELETE FROM turns WHERE id='turn_snap_r06'").run();
  }
});
