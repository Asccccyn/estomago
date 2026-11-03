// G1-F03（裁定 2026-11-03）：当前上下文来源映射改用真实窗口内容。
// 旧实现读 ACTIVE 窗的 cutoff_sequence——该列只在旧窗关闭时写入、
// 新窗恒 NULL → 按 0 = 会话最近 N 条，既误排未携带旧文也漏排已携带
// 原文。修正：边界取最近 CLOSED 窗的 cutoff；携带原文并入轨迹
// manifest 的 id。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { windowContextMessageIds } from '../../apps/host/src/memory-surfacing/source-boundary.ts';

function makeDb(root: string) {
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  return db;
}

function seedMessages(db: ReturnType<typeof makeDb>, texts: string[]) {
  db.prepare("INSERT INTO conversations(id, created_at) VALUES('c1', ?)").run('2026-11-03T00:00:00Z');
  const ids: string[] = [];
  let seq = 0;
  for (const t of texts) {
    seq += 1;
    const id = `msg_f03_${seq}`;
    db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES(?,?,?, 'owner','text',1,?)").run(id, 'c1', seq, '2026-11-03T00:00:00Z');
    db.prepare("INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES(?,?,1,'text',?,?,?,?,'test')").run(`${id}_r1`, id, t, sha256Hex(t), '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z');
    ids.push(id);
  }
  return ids;
}

test('G1-F03：新 ACTIVE 窗（cutoff 为 NULL）不再退化为会话最近 N 条', () => {
  const db = makeDb(fs.mkdtempSync(path.join(os.tmpdir(), 'est-f03-a-')));
  try {
    const ids = seedMessages(db, ['旧1', '旧2', '边界后新1']);
    // 旧窗关闭于 seq=2；新 ACTIVE 窗（cutoff 列未写，恒 NULL）
    db.prepare("INSERT INTO windows(id, conversation_id, status, cutoff_sequence, created_at, updated_at) VALUES('w_old','c1','CLOSED',2,?,?)").run('2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z');
    db.prepare("INSERT INTO windows(id, conversation_id, status, cutoff_sequence, created_at, updated_at) VALUES('w_new','c1','ACTIVE',NULL,?,?)").run('2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z');
    const got = windowContextMessageIds(db, 'c1');
    assert.deepEqual(got, [ids[2]!], '只含边界后消息——不再是"最近 N 条"冒充当前上下文');
  } finally { db.close(); }
});

test('G1-F03：换窗携带的旧原文（manifest id）并入当前上下文', () => {
  const db = makeDb(fs.mkdtempSync(path.join(os.tmpdir(), 'est-f03-b-')));
  try {
    const ids = seedMessages(db, ['被携带的旧原文', '边界后新1']);
    db.prepare("INSERT INTO windows(id, conversation_id, status, cutoff_sequence, created_at, updated_at) VALUES('w_old','c1','CLOSED',1,?,?)").run('2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z');
    db.prepare("INSERT INTO windows(id, conversation_id, status, cutoff_sequence, created_at, updated_at) VALUES('w_new','c1','ACTIVE',NULL,?,?)").run('2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z');
    db.prepare("INSERT INTO window_trajectories(window_id, messages_json, manifest_json, updated_at) VALUES('w_new','[]',?, ?)").run(
      JSON.stringify([{ id: ids[0], revision: 1, seq: 1, origin: 'dialogue', visible: true }]),
      '2026-11-03T00:00:00Z',
    );
    const got = new Set(windowContextMessageIds(db, 'c1'));
    assert.ok(got.has(ids[0]!), '人工携带的旧原文进入当前上下文集合');
    assert.ok(got.has(ids[1]!), '本窗新消息同样在集合内');
  } finally { db.close(); }
});
