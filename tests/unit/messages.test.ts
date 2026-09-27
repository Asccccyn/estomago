import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';

test('多行正文是一条消息：\r\n 规范化为 \n，行序/空行保留，不拆分', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const { message } = svc.submitUserMessage({
    conversationId: 'c1',
    content: '第一行\r\n第二行\r\r\n\r\n空行后',
    clientMessageId: 'cmid-1',
  });
  assert.equal(message.revision.content, '第一行\n第二行\n\n\n空行后');
  const all = svc.listMessages({ conversationId: 'c1' });
  assert.equal(all.length, 1); // 换行不是分句信号：绝不拆成多条
});

test('幂等：相同 client_message_id 重发返回原记录（duplicate=true）', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const first = svc.submitUserMessage({ conversationId: 'c1', content: '你好', clientMessageId: 'cmid-dup' });
  const second = svc.submitUserMessage({ conversationId: 'c1', content: '你好（重试同键）', clientMessageId: 'cmid-dup' });
  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(second.message.revision.content, '你好'); // 原记录不被覆盖
  assert.equal(svc.listMessages({ conversationId: 'c1' }).length, 1);
});

test('仅空白拒绝；不 trim 重写正文', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  assert.throws(() => svc.submitUserMessage({ conversationId: 'c1', content: '  \n\u3000 ', clientMessageId: 'b1' }), /仅空白/);
  // 前后空格属于正文结构：原样保留
  const { message } = svc.submitUserMessage({ conversationId: 'c1', content: '  你好  ', clientMessageId: 'b2' });
  assert.equal(message.revision.content, '  你好  ');
});

test('编辑产生新 revision + supersedes，旧版本保留审计', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const { message } = svc.submitUserMessage({ conversationId: 'c1', content: '原稿', clientMessageId: 'e1' });
  const edited = svc.editUserMessage(message.id, '改后\n多行');
  assert.equal(edited.current_revision, 2);
  assert.equal(edited.revision.content, '改后\n多行');
  assert.equal(edited.revision.supersedes_revision, 1);
  const old = db.prepare('SELECT content FROM message_revisions WHERE message_id = ? AND revision = 1').get(message.id);
  assert.equal((old as { content: string }).content, '原稿'); // 旧版本不覆盖
});

test('助手发布走发布边界：顺序递增、published_at 非空、归档 outbox 有记录', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const m = svc.publishAssistantMessage({ conversationId: 'c1', turnId: 't1', content: '第一段' });
  assert.ok(m.published_at);
  assert.equal(m.speaker, 'assistant');
  const obx = db.prepare("SELECT state FROM outbox WHERE target = 'mariposa.archive'").get() as { state: string };
  assert.equal(obx.state, 'pending'); // 只代表"待归档"，不代表已归档到记忆库
});
