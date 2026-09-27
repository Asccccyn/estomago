// AUD-05/06/23 回归：会话级 gate、票据事务消费、非法 edit 不消耗、过期拒绝、真修订。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempRoot, makeDb, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';

function setup() {
  const root = tempRoot();
  writeApprovedIdentity(root);
  const { db } = makeDb(root);
  const events = new EventService(db);
  const messages = new MessageService(db);
  const routing = new RoutingService(db, events, messages);
  messages.ensureConversation('c1');
  return { root, db, events, messages, routing };
}

test('AUD-23：缺字段 edit → 400 级拒绝，票据保持 pending 可用；随后合法 edit 成功', () => {
  const { db, messages, routing } = setup();
  const msg = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '原始', clientMessageId: 'k1' });
  const d = routing.createPending({ conversationId: 'c1', turnId: msg.turnId, attemptId: msg.attemptId, inputHash: msg.message.revision.content_hash, targetModel: null, evidenceCode: 'SDK_ROUTE_SIGNAL' });
  const bad = routing.validateAndConsume(d.id, { choice: 'edit', content: '' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'ROUTE_INVALID_EDIT');
  assert.equal(routing.get(d.id)!.state, 'pending', '非法请求不得消耗票据');
  const good = routing.validateAndConsume(d.id, { choice: 'edit', content: '修订后的正文\n多行' });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.editRevision, 2);
    const m = messages.getMessage(msg.message.id)!;
    assert.equal(m.current_revision, 2);
    assert.equal(m.revision.supersedes_revision, 1);
    assert.equal(m.revision.content, '修订后的正文\n多行');
    const attempts = db.prepare('SELECT COUNT(*) n FROM attempts WHERE turn_id = ?').get(msg.turnId) as { n: number };
    assert.equal(attempts.n, 2, '新 attempt 已建');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM messages WHERE speaker = ?').get('owner') as { n: number }).n, 1, '不得新建 owner 消息（AUD-07）');
    assert.equal(routing.get(d.id)!.state, 'consumed');
  }
});

test('AUD-23：过期票据拒绝并标 expired（2000 年负例）', () => {
  const { db, messages, routing } = setup();
  const msg = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'x', clientMessageId: 'k2' });
  const d = routing.createPending({ conversationId: 'c1', turnId: msg.turnId, attemptId: msg.attemptId, inputHash: msg.message.revision.content_hash, targetModel: null, evidenceCode: 'SDK_ROUTE_SIGNAL' });
  db.prepare("UPDATE route_decisions SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(d.id);
  const r = routing.validateAndConsume(d.id, { choice: 'approve' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'ROUTE_EXPIRED');
  assert.equal(routing.get(d.id)!.state, 'expired');
});

test('AUD-23：输入 hash 失配（消息被外部修订）→ 拒绝，票据不消耗', () => {
  const { messages, routing } = setup();
  const msg = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'v1', clientMessageId: 'k3' });
  const d = routing.createPending({ conversationId: 'c1', turnId: msg.turnId, attemptId: msg.attemptId, inputHash: 'stale-hash', targetModel: null, evidenceCode: 'SDK_ROUTE_SIGNAL' });
  const r = routing.validateAndConsume(d.id, { choice: 'approve' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'ROUTE_INPUT_STALE');
  assert.equal(routing.get(d.id)!.state, 'pending');
});

test('AUD-05：会话级 pending gate——pendingForConversation 命中任一票据', () => {
  const { messages, routing } = setup();
  const t1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'a', clientMessageId: 'a' });
  const t2 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'b', clientMessageId: 'b' });
  routing.createPending({ conversationId: 'c1', turnId: t1.turnId, attemptId: t1.attemptId, inputHash: 'h1', targetModel: null, evidenceCode: 'SDK_ROUTE_SIGNAL' });
  const room = routing.pendingForConversation('c1');
  assert.ok(room, '房间存在待决即冻结（任何 turn）');
  assert.equal(room!.turn_id, t1.turnId);
  assert.equal(routing.pendingForConversation('other-room'), null);
  void t2;
});
