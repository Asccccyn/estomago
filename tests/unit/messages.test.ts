import { test } from 'node:test';
import assert from 'node:assert/strict';
import {makeDb } from '../helpers.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';

test('多行正文是一条消息：CRLF 规范化为 LF，行序/空行保留，不拆分（含同事务 outbox+turn）', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const r = svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一行\r\n第二行\r\r\n\r\n空行后', clientMessageId: 'cmid-1' });
  assert.equal(r.message.revision.content, '第一行\n第二行\n\n\n空行后');
  assert.equal(svc.listMessages({ conversationId: 'c1' }).length, 1);
  // AUD-15：同事务侧效应
  assert.equal((db.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number }).n, 1);
  assert.ok(r.turnId && r.attemptId);
  assert.equal((db.prepare('SELECT turn_id FROM messages WHERE id=?').get(r.message.id) as { turn_id: string }).turn_id, r.turnId);
});

test('幂等：相同 client_message_id + 相同内容重试返回原记录 + 完整 side effects', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const first = svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '你好', clientMessageId: 'cmid-dup' });
  const second = svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '你好', clientMessageId: 'cmid-dup' }); // 她 1011 裁定：同内容重试
  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(second.turnId, first.turnId);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, 1);
});

test('AUD-29（她 1011 裁定）：同键不同内容=IDEMPOTENCY_CONFLICT', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '你好', clientMessageId: 'cmid-conflict' });
  assert.throws(
    () => svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '不同内容', clientMessageId: 'cmid-conflict' }),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test('仅空白拒绝；不 trim 重写正文', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  assert.throws(() => svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '  \n\u3000 ', clientMessageId: 'b1' }), /仅空白/);
  const r = svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '  你好  ', clientMessageId: 'b2' });
  assert.equal(r.message.revision.content, '  你好  ');
});

test('编辑产生新 revision + supersedes + 归档 outbox；旧版本保留审计', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const r = svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '原稿', clientMessageId: 'e1' });
  const outboxBefore = (db.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number }).n;
  const edited = svc.editUserMessage(r.message.id, '改后\n多行');
  assert.equal(edited.current_revision, 2);
  assert.equal(edited.revision.supersedes_revision, 1);
  assert.equal((db.prepare('SELECT content FROM message_revisions WHERE message_id = ? AND revision = 1').get(r.message.id) as { content: string }).content, '原稿');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number }).n, outboxBefore + 1);
});

test('助手发布走发布边界：published_at 非空、归档 outbox 记账', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const m = svc.publishAssistantMessage({ conversationId: 'c1', turnId: 't1', content: '第一段' });
  assert.ok(m.published_at);
  assert.equal(m.speaker, 'assistant');
  const obx = db.prepare("SELECT state FROM outbox WHERE target = 'mariposa.archive'").get() as { state: string };
  assert.equal(obx.state, 'pending');
});
