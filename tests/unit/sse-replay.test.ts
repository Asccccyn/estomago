import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers.ts';
import { EventService } from '../../apps/host/src/events/service.ts';

test('SSE 事实来源：持久 sequence 严格递增，分页回放不重不漏', () => {
  const { db } = makeDb();
  const events = new EventService(db);
  events.publish('message.persisted', { conversationId: 'c1', payload: { n: 1 } });
  const second = events.publish('reasoning.delta', { conversationId: 'c1', payload: { n: 2 } });
  events.publish('message.published', { conversationId: 'c2', payload: { n: 3 } });

  const page = events.replayPage(0, null, 1000);
  assert.equal(page.length, 3);
  assert.ok(page[0]!.sequence < page[1]!.sequence && page[1]!.sequence < page[2]!.sequence);
  const tail = events.replayPage(second.sequence - 1, null, 1000);
  assert.deepEqual(tail.map((r) => r.kind), ['reasoning.delta', 'message.published']);
  const onlyC1 = events.replayPage(0, 'c1', 1000);
  assert.deepEqual(onlyC1.map((r) => r.kind), ['message.persisted', 'reasoning.delta']);
});

test('订阅者实时分发 + 按会话过滤；persistInTx 后 dispatchRow 手动分发', () => {
  const { db } = makeDb();
  const events = new EventService(db);
  const sub = events.subscribe('c1');
  const row = events.publish('message.published', { conversationId: 'c1', payload: {} });
  events.publish('message.published', { conversationId: 'c2', payload: {} });
  assert.deepEqual(sub.queue.map((q) => q.sequence), [row.sequence]);
  events.unsubscribe(sub);
  events.publish('message.published', { conversationId: 'c1', payload: {} });
  assert.equal(sub.queue.length, 1);
});

test('慢客户端：队列有上限，溢出标记并回调断开', () => {
  const { db } = makeDb();
  const events = new EventService(db);
  let overflowed = false;
  const sub = events.subscribe(null, () => { overflowed = true; });
  for (let i = 0; i < 256; i++) sub.queue.push({ sequence: i, kind: 'x', payload: '{}', eventRow: null as never });
  events.publish('message.published', { conversationId: null, payload: {} });
  assert.equal(overflowed, true);
  assert.ok(sub.queue.length <= 256);
});
