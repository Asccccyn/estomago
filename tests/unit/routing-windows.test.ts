import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';

test('路由票据：创建 pending → 一次性原子消费 → 重复消费失败', () => {
  const { db } = makeDb();
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const msg = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'x', clientMessageId: 'k' });
  const routing = new RoutingService(db, events, messages);
  const decision = routing.createPending({ conversationId: 'c1', turnId: msg.turnId, attemptId: msg.attemptId, inputHash: msg.message.revision.content_hash, targetModel: null, evidenceCode: 'SDK_ROUTE_SIGNAL' });
  assert.equal(decision.state, 'pending');
  const first = routing.validateAndConsume(decision.id, { choice: 'approve' });
  assert.equal(first.ok, true);
  const second = routing.validateAndConsume(decision.id, { choice: 'cancel' });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, 'ROUTE_ALREADY_RESOLVED');
});
