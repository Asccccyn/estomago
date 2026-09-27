import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers.ts';
import { EventService } from '../../apps/host/src/events/service.ts';

test('SSE 事实来源：持久 sequence 严格递增，cursor 回放不重不漏', () => {
  const { db } = makeDb();
  const events = new EventService(db);
  events.publish('message.persisted', { conversationId: 'c1', payload: { n: 1 } });
  const second = events.publish('reasoning.delta', { conversationId: 'c1', payload: { n: 2 } });
  events.publish('message.published', { conversationId: 'c2', payload: { n: 3 } });

  const all = events.replay(0, null);
  assert.equal(all.length, 3);
  assert.ok(all[0]!.sequence < all[1]!.sequence && all[1]!.sequence < all[2]!.sequence);

  const tail = events.replay(second.sequence - 1, null);
  assert.deepEqual(tail.map((r) => r.kind), ['reasoning.delta', 'message.published']);

  const onlyC1 = events.replay(0, 'c1');
  assert.deepEqual(onlyC1.map((r) => r.kind), ['message.persisted', 'reasoning.delta']);
});

test('订阅者收到实时事件；按 conversation 过滤', () => {
  const { db } = makeDb();
  const events = new EventService(db);
  const sub = events.subscribe('c1');
  events.publish('message.published', { conversationId: 'c1', payload: {} });
  events.publish('message.published', { conversationId: 'c2', payload: {} });
  assert.deepEqual(sub.queue.map((q) => q.eventRow.conversation_id), ['c1']);
  events.unsubscribe(sub);
  events.publish('message.published', { conversationId: 'c1', payload: {} });
  assert.equal(sub.queue.length, 1);
});

test('慢客户端：队列有上限，溢出标记并回调断开（重连靠 cursor）', () => {
  const { db } = makeDb();
  const events = new EventService(db);
  let overflowed = false;
  const sub = events.subscribe(null, () => {
    overflowed = true;
  });
  // 人工灌到上限（256），再 publish 一条 → 溢出：不追加、标记并回调断开
  for (let i = 0; i < 256; i++) sub.queue.push({ sequence: i, kind: 'x', payload: '{}', eventRow: null as never });
  events.publish('message.published', { conversationId: null, payload: {} });
  assert.equal(overflowed, true);
  assert.ok(sub.queue.length <= 256, '不得无限堆内存');
});
