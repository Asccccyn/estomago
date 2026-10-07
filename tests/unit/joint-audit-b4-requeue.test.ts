// F-J-11（联合审计 2026-10-06）：outbox 受控恢复入口回归。
// 场景：msg1 dead（FORBIDDEN 等）→ msg2 因前驱缺失 pending→dead 级联；
// dry-run 只列不改；--apply 按 created_at 升序重排 failed/dead（unknown 不动、
// attempt≥10 跳过）；重排后由 drainOnce 以冻结 payload+同 op 重发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';

const REPO = path.resolve(fileURLToPath(import.meta.url), '../../..');
const T0 = '2026-10-05T10:00:00+08:00';

function seed(root: string) {
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(T0);
  const mk = (id: string, seq: number, at: string): string => {
    db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES (?,'c1',?,'owner','text',1,?)").run(id, seq, at);
    db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,?,'2026-10-05T10:00:00+08:00','2026-10-05T10:00:01+08:00','user')").run(id, `正文${id}`, sha256Hex(`正文${id}`));
    const obx = `obx-${id}`;
    db.prepare("INSERT INTO outbox(id, operation_key, target, payload_ref, state, attempt, last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,?, ?, ?)")
      .run(obx, `archive:${id}:1`, 'mariposa.archive', JSON.stringify({ message_id: id, revision: 1 }), 'failed', seq === 2 ? 10 : 1, seq === 1 ? 'FORBIDDEN' : 'SOURCE_NOT_READY', at, at);
    return obx;
  };
  const obx1 = mk('m1', 1, '2026-10-05T10:01:00+08:00');
  const obx2 = mk('m2', 2, '2026-10-05T10:02:00+08:00'); // attempt=10：应被跳过
  const obx3 = mk('m3', 3, '2026-10-05T10:03:00+08:00');
  db.prepare("INSERT INTO outbox(id, operation_key, target, payload_ref, state, attempt, last_error, created_at, updated_at) VALUES ('obx-u','archive:mu:1','mariposa.archive',?, 'unknown_outcome',3,'HTTP_502','2026-10-05T10:04:00+08:00','2026-10-05T10:04:00+08:00')")
    .run(JSON.stringify({ message_id: 'm3', revision: 2 }));
  db.close();
  return { obx1, obx2, obx3 };
}

function run(args: string[], envHome: string): string {
  return execFileSync('node', [path.join(REPO, 'scripts/outbox-requeue.mjs'), ...args], {
    env: { ...process.env, ESTOMAGO_HOME: envHome }, encoding: 'utf8',
  });
}

test('F-J-11：dry-run 只列不改；apply 升序重排 failed/dead，unknown 不动、attempt≥10 跳过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-'));
  const ids = seed(root);
  // dry-run
  const dry = run([], root);
  assert.ok(dry.includes('DRY-RUN'), '默认 dry-run');
  assert.ok(dry.includes('failed 3'), '列出 failed 行');
  assert.ok(dry.includes('unknown_outcome 1'), 'unknown 行列出');
  const db = openDatabase(path.join(root, 'data'));
  const states = () => db.prepare("SELECT id, state FROM outbox ORDER BY id").all() as Array<{ id: string; state: string }>;
  assert.ok(states().every((r) => r.state === 'failed' || r.state === 'unknown_outcome'), 'dry-run 未改动');
  // apply
  const out = run(['--apply', '--conversation', 'c1'], root);
  assert.ok(out.includes('已重排散行 2 行'), `散行重排 2（跳过 attempt=10）实际输出：${out.slice(-400)}`);
  const after = new Map(states().map((r) => [r.id, r.state]));
  assert.equal(after.get(ids.obx1), 'pending', '最早的 failed 重排');
  assert.equal(after.get(ids.obx3), 'pending', '第三条重排');
  assert.equal(after.get(ids.obx2), 'failed', 'attempt=10 跳过（不重置计数掩盖故障）');
  assert.equal(after.get('obx-u'), 'unknown_outcome', 'unknown 不自动重排');
  db.close();
});
