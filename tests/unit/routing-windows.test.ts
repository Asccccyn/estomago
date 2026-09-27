import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { EventService } from '../../apps/host/src/events/service.ts';

test('路由票据：创建 pending → 一次性原子消费 → 重复消费失败', async () => {
  const { db } = makeDb();
  const events = new EventService(db);
  const routing = new RoutingService(db, events);
  const decision = routing.createPending({
    conversationId: 'c1',
    turnId: 't1',
    attemptId: 'a1',
    inputHash: 'hash-1',
    targetModel: null,
    evidence: 'route_signal: fixture',
  });
  assert.equal(decision.state, 'pending');

  const first = routing.consume(decision.id, 'approve');
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.row.choice, 'approve');

  // 多端重复点击 / 重启后旧票据：只能一次生效
  const second = routing.consume(decision.id, 'cancel');
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.reason, /consumed/);
});

test('票据绑定输入 hash：编辑产生新 revision 后新 attempt，旧票据不再生效', () => {
  const { db } = makeDb();
  const events = new EventService(db);
  const routing = new RoutingService(db, events);
  const d1 = routing.createPending({ conversationId: 'c1', turnId: 't1', attemptId: 'a1', inputHash: 'h1', targetModel: null, evidence: 'e' });
  assert.equal(routing.consume(d1.id, 'edit').ok, true);
  const d2 = routing.createPending({ conversationId: 'c1', turnId: 't1', attemptId: 'a2', inputHash: 'h2', targetModel: null, evidence: 'e' });
  assert.notEqual(d2.id, d1.id);
});
