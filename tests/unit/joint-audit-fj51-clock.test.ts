// F-J-51（裁定口径 2026-10-06 林石见）：时钟异常边界测试——不改写 occurred_at。
// 验证：①原始 occurred_at 字节保真入库（不被服务器改写/截断/替换）
// ②服务器接收时间（received_at）与客户端发生时间（occurred_at）分列
// （idle 差值放大是 supervisor 内部行为，此处不宣称已验证——R04 2026-10-23 裁定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { tempRoot } from '../helpers.ts';

test('F-J-51：occurred_at 前跳（+1h）字节保真入库，不被改写', () => {
  const root = tempRoot('fj51a-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const futureIso = '2026-12-31T23:59:59+08:00';
  const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '客户端前跳', clientMessageId: 'f1', occurredAt: futureIso });
  const row = db.prepare('SELECT occurred_at FROM message_revisions WHERE message_id = ? AND revision = 1').get(sub.message.id) as { occurred_at: string };
  assert.equal(row.occurred_at, futureIso, '原始 occurred_at 字节保真（不改写/不截断）');
  db.close();
});

test('F-J-51：occurred_at 后跳（-1 年）字节保真入库，不被改写', () => {
  const root = tempRoot('fj51b-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const pastIso = '2025-01-01T00:00:00+08:00';
  const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '客户端后跳', clientMessageId: 'f2', occurredAt: pastIso });
  const row = db.prepare('SELECT occurred_at FROM message_revisions WHERE message_id = ? AND revision = 1').get(sub.message.id) as { occurred_at: string };
  assert.equal(row.occurred_at, pastIso, '后跳原始时间保真');
  db.close();
});

test('F-J-51：received_at（服务器接收）与 occurred_at（客户端声明）分列不混', () => {
  const root = tempRoot('fj51c-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const claimed = '2026-06-01T12:00:00+08:00';
  const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '时间分列', clientMessageId: 'f3', occurredAt: claimed });
  const row = db.prepare('SELECT occurred_at, received_at FROM message_revisions WHERE message_id = ? AND revision = 1').get(sub.message.id) as { occurred_at: string; received_at: string };
  assert.equal(row.occurred_at, claimed, '客户端声明时间原样');
  assert.notEqual(row.received_at, claimed, '服务器接收时间独立（≈当前真实时间）');
  assert.ok(new Date(row.received_at).getTime() > new Date('2026-10-01').getTime(), 'received_at 是服务器侧近期时间');
  db.close();
});
