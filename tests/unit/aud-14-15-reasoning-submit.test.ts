// AUD-14 回归：投影与回放事件同事务（事件写失败 → 投影回滚）。
// AUD-15 回归：崩溃间隙消息的幂等重试自愈 side effects。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { tempRoot } from '../helpers.ts';

test('AUD-14：事件持久失败 → 投影更新一并回滚（原子性）', () => {
  const root = tempRoot();
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const before = (db.prepare('SELECT COUNT(*) n FROM runtime_stream_events').get() as { n: number }).n;
  const failingEvents = new Proxy(events, {
    get(t, p) {
      if (p === 'persistInTx') return () => { throw new Error('injected event write failure'); };
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const reasoning = new ReasoningService(db, failingEvents);
  let threw = false;
  try {
    reasoning.appendDelta({ conversationId: 'c1', turnId: 't', attemptId: 'a14', sdkMessageId: 'm14', blockIndex: 0, text: '原子性探针', generation: 1 });
  } catch { threw = true; }
  assert.equal(threw, true);
  const block = db.prepare("SELECT received_text, revision FROM reasoning_blocks WHERE attempt_id='a14'").get() as { received_text: string; revision: number } | undefined;
  assert.equal(block, undefined, '投影不得在事件失败时单独提交');
  const after = (db.prepare('SELECT COUNT(*) n FROM runtime_stream_events').get() as { n: number }).n;
  assert.equal(after, before);
  db.close();
});

test('AUD-15：消息有、turn/outbox 缺（崩溃间隙）→ 同 key 重试自愈，不再永久 duplicate+missing', () => {
  const root = tempRoot();
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  // 正常提交（含全部 side effects）
  const r = svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '崩溃前', clientMessageId: 'k15' });
  // 模拟崩溃残缺：清掉 turn/attempt/outbox（消息保留）
  db.prepare('DELETE FROM attempts WHERE turn_id = ?').run(r.turnId);
  db.prepare('DELETE FROM turns WHERE id = ?').run(r.turnId);
  db.prepare('DELETE FROM outbox').run();
  // 同幂等键重试 → 自愈
  const retry = svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '崩溃前（重试）', clientMessageId: 'k15' });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.repaired, true);
  assert.ok(retry.turnId, 'turn 必须被补齐');
  const turn = db.prepare('SELECT COUNT(*) n FROM turns WHERE input_message_id = ?').get(r.message.id) as { n: number };
  assert.equal(turn.n, 1);
  const attempt = db.prepare('SELECT COUNT(*) n FROM attempts WHERE turn_id = ?').get(retry.turnId) as { n: number };
  assert.equal(attempt.n, 1);
  const outbox = db.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number };
  assert.equal(outbox.n, 1, '归档任务必须补齐');
  assert.equal(retry.message.revision.content, '崩溃前', '幂等不覆盖原文');
  db.close();
});
