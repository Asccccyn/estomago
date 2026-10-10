// WP-05 死表清退（她 2026-10-10 批"删吧"；run-160858 复审开放项）：
// v20 DROP wakeups/effects/members；audit_events 保留（prune 维护审计在写，
// 审计期"4 死表"口径对 audit_events 已过时——复审勘误）。
// 两路验证：fresh 全新库终态 + v19 旧库升级路径（upTo 构造历史库）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { tempRoot } from '../helpers.ts';

const has = (db: ReturnType<typeof openDatabase>, t: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

test('v20：fresh 库不建死表，audit_events 保留', () => {
  const root = tempRoot('wp5-v20-fresh-');
  const db = openDatabase(path.join(root, 'data'));
  const r = migrate(db, sha256Hex);
  assert.equal(r.applied.at(-1), 20, '最后应用=20');
  assert.equal(has(db, 'wakeups'), false, 'wakeups 不再存在');
  assert.equal(has(db, 'effects'), false, 'effects 不再存在');
  assert.equal(has(db, 'members'), false, 'members 不再存在');
  assert.equal(has(db, 'audit_events'), true, 'audit_events 保留（prune 审计账本）');
  assert.equal(has(db, 'runtime_settings'), true, '既有 v19 表不受影响');
  db.close();
});

test('v20：v19 旧库升级后三表被 DROP（升级=fresh 同码收敛）', () => {
  const root = tempRoot('wp5-v20-upg-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex, 19);
  assert.equal(has(db, 'wakeups'), true, 'v19 历史库仍有 wakeups');
  assert.equal(has(db, 'members'), true, 'v19 历史库仍有 members');
  const r = migrate(db, sha256Hex);
  assert.deepEqual(r.applied, [20], '只补应用 v20');
  assert.equal(has(db, 'wakeups'), false);
  assert.equal(has(db, 'effects'), false);
  assert.equal(has(db, 'members'), false);
  assert.equal(has(db, 'audit_events'), true, '升级路径同样保留 audit_events');
  db.close();
});

test('v20：members 写入点移除后建房仍正常（ensureConversation 幂等）', async () => {
  const { MessageService } = await import('../../apps/host/src/messages/service.ts');
  const root = tempRoot('wp5-v20-conv-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const svc = new MessageService(db);
  svc.ensureConversation('c1', '房间');
  svc.ensureConversation('c1', '房间'); // 幂等：不重复插
  const n = db.prepare('SELECT COUNT(*) n FROM conversations WHERE id=?').get('c1') as { n: number };
  assert.equal(n.n, 1, 'conversations 恰一行');
  db.close();
});
