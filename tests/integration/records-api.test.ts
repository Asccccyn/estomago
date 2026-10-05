// WP5 回归：记录只读端点（快照形状/事件白名单分页/只读性/鉴权）。mock runner，零网络。
import '../helpers.ts'; // 首个 import：启用 ESTOMAGO_TEST_MODE
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

const root = tempRoot('estomago-rec-');
writeApprovedIdentity(root);
const config = buildConfig({
  runtime: { provider: 'mock', ...(readyRuntimePatch().runtime as Record<string, unknown>) },
  deployment: { port: 0 },
});

let host: Host;
let base = '';
let token = '';

test.before(async () => {
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config', 'auth.token'), 'utf8').trim();
});
test.after(async () => { await host.stop(); });

test('快照：形状、只读、鉴权', async () => {
  const unauth = await fetch(`${base}/api/v1/conversations/primary/context-records`);
  assert.equal(unauth.status, 401, '沿用同源鉴权——只知道 room ID 读不到');
  const res = await fetch(`${base}/api/v1/conversations/primary/context-records`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const snap = (await res.json()) as Record<string, unknown>;
  assert.equal(snap.roomId, 'primary');
  assert.equal(snap.driver, 'mock');
  assert.equal(snap.cache.requestedTtl, '1h');
  assert.equal(snap.cache.keeperEnabled, false);
  assert.equal(snap.rawSync.state, 'saved_pending_sync', '未启用归档：本地已保存、远端未同步，不冒充 synced');
  assert.equal(snap.context.hardCapacity, null, '容量未测量=null，不画假百分比');
  // 只读性：GET 前后无任何运行状态变化（无模型调用/无事件新增）
  const eventsRes = await fetch(`${base}/api/v1/conversations/primary/context-records/events?limit=10`, { headers: { Authorization: `Bearer ${token}` } });
  const ev1 = (await eventsRes.json()) as { events: unknown[] };
  const snap2 = await (await fetch(`${base}/api/v1/conversations/primary/context-records`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const ev2 = (await (await fetch(`${base}/api/v1/conversations/primary/context-records/events?limit=10`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { events: unknown[] };
  assert.equal((snap2 as { cursor: string | null }).cursor, snap.cursor, '查询不产生新事件');
  assert.equal(ev2.events.length, ev1.events.length);
});

test('事件端点：白名单 kind、有界分页、limit 上限', async () => {
  // 造几条白名单事件（经 EventService 直接发布——形状与运行时一致）
  host.events.publish('context.warning', { conversationId: 'primary', entityRef: 'win_x', scope: 'private', payload: { estimate: 57000, quality: 'rough' } });
  host.events.publish('review.sent', { conversationId: 'primary', entityRef: 'rev_x', scope: 'private', payload: { reason: 'idle', focus_count: 2 } });
  host.events.publish('window.rotated', { conversationId: 'primary', entityRef: 'win_y', scope: 'private', payload: { reason: 'idle' } });
  host.events.publish('message.published', { conversationId: 'primary', entityRef: 'msg_x', scope: 'private', payload: { message: { id: 'msg_x' } } }); // 非白名单：不出现
  const res = await fetch(`${base}/api/v1/conversations/primary/context-records/events?limit=2`, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await res.json()) as { events: Array<{ kind: string; sequence: number }>; nextCursor: string | null };
  assert.equal(data.events.length, 2);
  assert.ok(data.nextCursor, '有下一页游标');
  const kinds = data.events.map((e) => e.kind);
  assert.ok(kinds.every((k) => ['archive.sync', 'context.warning', 'review.sent', 'review.failed', 'window.rotated'].includes(k)), '只含白名单 kind');
  const page2 = await (await fetch(`${base}/api/v1/conversations/primary/context-records/events?limit=2&cursor=${data.nextCursor}`, { headers: { Authorization: `Bearer ${token}` } })).json() as { events: Array<{ kind: string }> };
  assert.equal(page2.events.length, 1, '剩余一条（message.published 不计入）');
  assert.equal(page2.events[0]!.kind, 'window.rotated');
  // limit 上限 100：不接受超大值
  const capped = await fetch(`${base}/api/v1/conversations/primary/context-records/events?limit=99999`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(capped.status, 200, '上限截断而非报错');
});

test('F21：last=1 最近页语义——超过 30 条后能看到最新事件（不再永远显示最早 30 条）', async () => {
  for (let i = 0; i < 35; i++) {
    host.events.publish('context.warning', { conversationId: 'primary', entityRef: `w${i}`, scope: 'private', payload: { estimate: i, quality: 'rough' } });
  }
  const res = await fetch(`${base}/api/v1/conversations/primary/context-records/events?limit=30&last=1`, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await res.json()) as { events: Array<{ sequence: number }>; prevCursor: string | null };
  assert.equal(data.events.length, 30);
  const seqs = data.events.map((e) => e.sequence);
  assert.ok(Math.max(...seqs) >= 35, '最新事件在其中（旧实现永远只给最早的 30 条）');
  assert.ok(data.prevCursor, '可向更早翻页');
  // 审计 F26：更早页必须严格前移且与当前页无交集（旧 forward 会原样重发当前页，旧断言把错误锁成绿）
  const older = await (await fetch(`${base}/api/v1/conversations/primary/context-records/events?limit=30&before=${data.prevCursor}`, { headers: { Authorization: `Bearer ${token}` } })).json() as { events: Array<{ sequence: number }>; prevCursor: string | null };
  const currentSeqs = new Set(data.events.map((e) => e.sequence));
  assert.ok(older.events.length > 0 && older.events.length <= 30, '更早页有界有内容');
  assert.ok(older.events.every((e) => !currentSeqs.has(e.sequence)), '更早页与当前页无交集');
  assert.ok(Math.max(...older.events.map((e) => e.sequence)) < Math.min(...data.events.map((e) => e.sequence)), '严格前移');
});

test('F22：换窗后最近检查结果不消失（按房间保留 + 标注非当前窗）', async () => {
  const db = host.db;
  // 旧窗的 completed 评审 + 新活动窗
  db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES ('win_old_f22','primary','CLOSED','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')").run();
  db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES ('win_new_f22','primary','ACTIVE','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z')").run();
  db.prepare("UPDATE conversations SET active_window_id = 'win_new_f22' WHERE id = 'primary'").run();
  db.prepare("INSERT INTO rotation_reviews(id, window_id, room_id, epoch_revision, range_keys_json, status, decision, created_at, updated_at) VALUES ('rev_f22','win_old_f22','primary',1,'[]','completed','no_new_hold','2026-10-01T01:00:00Z','2026-10-01T01:00:00Z')").run();
  const res = await fetch(`${base}/api/v1/conversations/primary/context-records`, { headers: { Authorization: `Bearer ${token}` } });
  const snap = (await res.json()) as { review: { id: string; status: string; decision: string | null; windowId: string; isCurrentWindow: boolean } | null };
  assert.ok(snap.review, '换窗后最近检查结果仍显示（旧实现变 null）');
  assert.equal(snap.review!.id, 'rev_f22');
  assert.equal(snap.review!.decision, 'no_new_hold');
  assert.equal(snap.review!.isCurrentWindow, false, '如实标注：这是上一窗口的结果');
});
