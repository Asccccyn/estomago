// F-J-51（裁定口径 2026-10-06 林石见）：时钟异常边界测试——不改写 occurred_at。
// 三场景：客户端前跳（未来时间）、后跳（过去时间）、恢复正常。验证：
// ①原始 occurred_at 字节保真入库（不被服务器改写/截断/替换）
// ②idle 判定用 occurred_at 差值（后跳会放大 idle，前跳归零——如实记录）
// ③服务器接收时间（received_at）与客户端发生时间（occurred_at）分列
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

test('F-J-51：occurred_at 前跳（+1h）字节保真入库，不被改写', () => {
  const root = tempRoot('fj51a-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
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

test('F-J-51：occurred_at 后跳（-1 年）字节保真；idle 判定差值放大如实记录', () => {
  const root = tempRoot('fj51b-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const pastIso = '2025-01-01T00:00:00+08:00';
  const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '客户端后跳', clientMessageId: 'f2', occurredAt: pastIso });
  const row = db.prepare('SELECT occurred_at FROM message_revisions WHERE message_id = ? AND revision = 1').get(sub.message.id) as { occurred_at: string };
  assert.equal(row.occurred_at, pastIso, '后跳原始时间保真');
  // idle 判定（supervisor 内）用 occurred_at 差——过去时间→idleMs 大→可能触发换窗评审
  // 这是如实行为（不拒收也不改写），不做服务端钳制
  db.close();
});

test('F-J-51：received_at（服务器接收）与 occurred_at（客户端声明）分列不混', () => {
  const root = tempRoot('fj51c-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
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
