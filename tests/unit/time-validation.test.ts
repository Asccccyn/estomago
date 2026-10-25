// F14 二轮回归：严格时间验证器 + v6 迁移保留原值 + TimeContext 不抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { validateAbsoluteIso } from '../../apps/host/src/util/time.ts';
import { buildTimeContext } from '../../apps/host/src/time/context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import {tempRoot } from '../helpers.ts';

test('验证器：合法值通过（闰日/偏移/毫秒）；非法值逐项拒绝', () => {
  for (const good of ['2026-01-01T00:00:00Z', '2024-02-29T12:00:00+08:00', '2026-12-31T23:59:59.123-05:00']) {
    assert.equal(validateAbsoluteIso(good).ok, true, `${good} 应合法`);
  }
  for (const bad of [
    0, '', '2026-02-30T00:00:00Z', '2023-02-29T00:00:00Z', '2026-99-01T00:00:00Z',
    '2026-01-01T25:00:00Z', '2026-01-01T00:61:00Z', '2026-01-01T00:00:00', '2026-01-01',
    '2026-01-01T00:00:00+99:00', 1700000000,
  ] as unknown[]) {
    assert.equal(validateAbsoluteIso(bad).ok, false, `${JSON.stringify(bad)} 应被拒绝`);
  }
});

test('v6 迁移：v4 时代漏网的日历无效值被修复且保留原值与原因', () => {
  const root = tempRoot('tv6-');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = openDatabase(path.join(root, 'data', 'chat.sqlite3'));
  migrate(db, sha256Hex, 4);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, title, created_at) VALUES ('c1','estomago','private',NULL,'2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES ('m1','c1',1,'owner','text',1,'2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('r1','m1',1,'text','x','h1','2026-99-01T00:00:00Z','2026-10-01T00:00:00Z','client_submit')").run();
  migrate(db, sha256Hex); // → v6，repair 处理日历无效值
  const row = db.prepare('SELECT occurred_at, occurred_at_raw, occurred_at_repair FROM message_revisions WHERE id = ?').get('r1') as { occurred_at: string; occurred_at_raw: string; occurred_at_repair: string };
  assert.equal(row.occurred_at, '2026-10-01T00:00:00Z', 'occurred_at 回填 received_at');
  assert.equal(row.occurred_at_raw, '2026-99-01T00:00:00Z', '原始值必须保留可追踪');
  assert.equal(row.occurred_at_repair, 'v6_calendar_repair_to_received_at', '修复原因如实标注');
  db.close();
});

test('TimeContext：存量无效时间不抛 RangeError，间隔为 null、跨日 false', () => {
  const root = tempRoot('ttc-');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = openDatabase(path.join(root, 'data', 'chat.sqlite3'));
  migrate(db, sha256Hex);
  const config = buildConfig({});
  db.prepare("INSERT INTO conversations(id, owner_service, scope, title, created_at) VALUES ('c1','estomago','private',NULL,'2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES ('m1','c1',1,'owner','text',1,'2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES ('m2','c1',2,'owner','text',1,'2026-01-02T00:00:00Z')").run();
  db.prepare("INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('r1','m1',1,'text','a','h1','2026-02-30T00:00:00Z','2026-01-01T00:00:00Z','client_submit')").run();
  db.prepare("INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('r2','m2',1,'text','b','h2','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','client_submit')").run();
  const ctx = buildTimeContext(db, { conversationId: 'c1', config, eventOccurredAt: '2026-02-30T00:00:00Z', currentInputSequence: 2 });
  assert.equal(ctx.elapsed_before_current_user_message, null, '无效发生时间 → 间隔未知（不抛不归零）');
  assert.equal(ctx.crossed_business_date, false, '跨日无法判定为 false（不是抛错）');
  db.close();
});
