// RRA-014 回访（2026-10-09 run-035424）：conversation_read 边界回归——
// 方向/范围/锚点/真实字节预算。此前残因：older 续页翻向无上界 newer_than
//（漏 1..7 且越过原上界）、range 丢 to_sequence（3..7 读到 12）、锚点被
// 前邻长文挤掉（所有续页路径到不了它）、控制字符转义后 18479B>16000。
import test from 'node:test';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 99, seenMessages: [], requestId: 'req-rra14' } as const;

function makeExecutor(root: string) {
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const { tools: executor } = assembleTestTools({ db: db, mariposa: new MariposaClient({ transport: async () => ({ ok: false, code: 'X', httpStatus: 404 }) }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  return { executor, db };
}

function seed(c: { db: ReturnType<typeof openDatabase> }, id: string, text: string, seq: number) {
  c.db.prepare("INSERT OR IGNORE INTO conversations(id, owner_service, scope, created_at) VALUES (?,'estomago','private','2026-01-01T00:00:00Z')").run('c1');
  c.db.prepare('INSERT INTO messages(id,conversation_id,sequence,speaker,kind,current_revision,published_at,created_at) VALUES (?,? ,? ,\'owner\',\'text\',1,NULL,\'2026-01-01T00:00:00Z\')').run(id, 'c1', seq);
  c.db.prepare("INSERT INTO message_revisions(message_id,revision,kind,content,content_hash,occurred_at,received_at,source) VALUES (?,1,'text',?,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','audit')").run(id, text, sha256Hex(text));
}

type Page = { entries: Array<{ seq: number }>; next_cursor?: Record<string, unknown> | null; has_more?: string | null; older_cursor?: Record<string, unknown> | null; newer_cursor?: Record<string, unknown> | null };
async function allPages(c: ReturnType<typeof makeExecutor>, first: Record<string, unknown>, max = 60) {
  const rows: Array<{ seq: number }> = [];
  const pages: Page[] = [];
  let args = first;
  for (let i = 0; i < max; i++) {
    const r = await c.executor.execute('conversation_read', args, CTX);
    assert.equal(r.ok, true, JSON.stringify(r.output).slice(0, 200));
    rows.push(...(r.output.entries as Array<{ seq: number }>));
    pages.push(r.output as Page);
    if (!(r.output as Page).next_cursor) return { rows, pages };
    args = { cursor: (r.output as Page).next_cursor, limit: first.limit };
  }
  throw new Error('cursor_not_terminated');
}

test('RRA014 对照：原全库 10 长条范围模式仍全可达（按消息聚合+逐条拼回）', async () => {
  const c = makeExecutor(tempRoot('rra14-ctrl-'));
  try {
    const bodies: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) { bodies[`m${i}`] = `row${i}:` + '中'.repeat(2990); seed(c, `m${i}`, bodies[`m${i}`], i); }
    const r = await allPages(c, { from_sequence: 1, to_sequence: 10, limit: 20 });
    // 长行可分多片交付（同消息多 entry，片序=交付序）——按消息聚合
    const pieces = new Map<string, string[]>();
    for (const e of r.rows as unknown as Array<{ seq: number; text: string }>) {
      pieces.set(e.seq, [...(pieces.get(e.seq) ?? []), e.text]);
    }
    assert.equal(pieces.size, 10, '十条全可达');
    for (const [mid, chunks] of pieces) {
      assert.equal(chunks.join(''), bodies[`m${mid}`], `m${mid} 分片按序拼回逐字一致`);
    }
  } finally { c.db.close(); }
});

test('RRA014 RED→FIX：older 续页保方向与原上界（不翻向无界 newer）', async () => {
  const c = makeExecutor(tempRoot('rra14-old-'));
  try {
    for (let i = 1; i <= 20; i++) seed(c, `m${i}`, `row${i}:` + '中'.repeat(2990), i);
    const r = await allPages(c, { cursor: { older_than: 11 }, limit: 3 });
    const seqs = [...new Set(r.rows.map((e) => e.seq))].sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'older_than=11 恰好交付 1..10——不漏 1..7、不越界到 11+');
  } finally { c.db.close(); }
});

test('RRA014 RED→FIX：range 续页携带 to_sequence（3..7 不得读到 8+）', async () => {
  const c = makeExecutor(tempRoot('rra14-range-'));
  try {
    for (let i = 1; i <= 12; i++) seed(c, `m${i}`, `short${i}`, i);
    const r = await allPages(c, { from_sequence: 3, to_sequence: 7, limit: 2 });
    assert.deepEqual(r.rows.map((e) => e.seq), [3, 4, 5, 6, 7], '范围恰好 3..7');
  } finally { c.db.close(); }
});

test('RRA014 RED→FIX：预算受限锚点页——锚点可达（不再被前邻长文永久挤掉）', async () => {
  const c = makeExecutor(tempRoot('rra14-anchor-'));
  try {
    for (let i = 1; i <= 11; i++) seed(c, `m${i}`, `row${i}:` + '中'.repeat(2990), i);
    const r = await c.executor.execute('conversation_read', { around_seq: 6, before: 5, after: 5 }, CTX);
    assert.equal(r.ok, true);
    const out = r.output as Page;
    const all = [...out.entries];
    for (const k of ['older_cursor', 'newer_cursor'] as const) {
      const cur = out[k];
      if (!cur) continue;
      const tail = await allPages(c, { cursor: cur });
      all.push(...tail.rows);
    }
    assert.ok(all.some((e) => e.seq === 6), '请求的锚点必须可达（首页或续页路径）');
    const seqs = [...new Set(all.map((e) => e.seq))].sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], '前后邻全可达');
  } finally { c.db.close(); }
});

test('RRA014 RED→FIX：分片预算按转义后真实 JSON 字节（≤16000）', async () => {
  const c = makeExecutor(tempRoot('rra14-bytes-'));
  try {
    seed(c, 'm1', '\u0001'.repeat(4000), 1);
    const r = await c.executor.execute('conversation_read', { from_sequence: 1, to_sequence: 1 }, CTX);
    assert.equal(r.ok, true);
    const bytes = Buffer.byteLength(JSON.stringify(r.output), 'utf8');
    assert.ok(bytes <= 16000, `完整输出 JSON ${bytes}B 超 16000（转义后真实字节口径）`);
    // 翻尽分片链，拼回逐字一致
    const pieces: string[] = [(r.output.entries[0] as { text: string }).text];
    let cur = (r.output as Page).next_cursor;
    let guard = 0;
    while (cur && guard < 40) {
      guard++;
      const p = await c.executor.execute('conversation_read', { cursor: cur }, CTX);
      assert.equal(p.ok, true);
      const out2 = p.output as Page;
      if (!out2.entries?.length) break; // 分片链尽后的方向终止空页（无 next_cursor）
      pieces.push((out2.entries[0] as { text: string }).text);
      cur = out2.next_cursor;
    }
    assert.equal(pieces.join(''), '\u0001'.repeat(4000), '控制字符分片拼回逐字一致');
  } finally { c.db.close(); }
});

// ------------ 二次回访（2026-10-10 run-073728）：字节单口径装页合同 ------------
// 根因：残留的 `cpLen<=3000` 码点门与整条顺延分支冲突——3001/4000 ASCII、
// 4000 中文等"能放空页"的行既不整装也不分片（range 静默结束、older 同
// 游标空页活锁）。修复后尺寸判定单口径=真实 JSON 字节。

for (const [label, body] of [['ascii3000', 'A'.repeat(3000)], ['ascii3001', 'A'.repeat(3001)], ['ascii4000', 'A'.repeat(4000)], ['cjk4000', '甲'.repeat(4000)]] as const) {
  test(`RRA014-2 字节单口径：${label} 能放空页必须整条交付`, async () => {
    const c = makeExecutor(tempRoot('rra14b2-'));
    try {
      seed(c, 'm1', body, 1);
      const r = await c.executor.execute('conversation_read', { from_sequence: 1, to_sequence: 1 }, CTX);
      assert.equal(r.ok, true);
      assert.equal(r.output.entries.length, 1, '整行放得下空页——不得消失');
      assert.equal(r.output.entries[0].text, body);
      assert.equal(r.output.entries[0].fragment, undefined, '能整装不得碎片化');
      assert.ok(Buffer.byteLength(JSON.stringify(r.output), 'utf8') <= 16000);
    } finally { c.db.close(); }
  });
}

test('RRA014-2 字节单口径：older 在 4000 ASCII 行上必须前进（不空页活锁）', async () => {
  const c = makeExecutor(tempRoot('rra14b2o-'));
  try {
    seed(c, 'm1', 'A'.repeat(4000), 1);
    const r = await c.executor.execute('conversation_read', { cursor: { older_than: 2 } }, CTX);
    assert.ok(r.output.entries.length > 0, '非空输入必须前进（此前空页+同游标活锁）');
    assert.equal(r.output.entries[0].text, 'A'.repeat(4000), '整条交付');
    assert.equal(r.output.entries[0].fragment, undefined);
    if (r.output.next_cursor) {
      const r2 = await c.executor.execute('conversation_read', { cursor: r.output.next_cursor }, CTX);
      assert.equal(r2.output.entries.length, 0, '翻尽后自然终止');
      assert.equal(r2.output.next_cursor, undefined);
    } else {
      assert.equal(r.output.has_more, undefined, '单行翻尽即终止');
    }
  } finally { c.db.close(); }
});

test('RRA014-2 超限控制字符：全部页 ≤16000、片区间首尾相接、逐字拼回', async () => {
  const c = makeExecutor(tempRoot('rra14b2e-'));
  try {
    const expected = '\u0001'.repeat(10000);
    seed(c, 'm1', expected, 1);
    const rows: Array<{ text: string; fragment: { start_char: number; end_char: number } }> = [];
    const bytes: number[] = [];
    let args: Record<string, unknown> = { from_sequence: 1, to_sequence: 1 };
    for (let i = 0; i < 30; i++) {
      const r = await c.executor.execute('conversation_read', args, CTX);
      assert.equal(r.ok, true);
      const b = Buffer.byteLength(JSON.stringify(r.output), 'utf8');
      bytes.push(b);
      assert.ok(b <= 16000, `第 ${i + 1} 页 ${b}B 超 16000`);
      rows.push(...(r.output.entries as typeof rows));
      if (!r.output.next_cursor) break;
      args = { cursor: r.output.next_cursor };
      assert.ok(i < 29, '必须收敛');
    }
    assert.equal(rows.map((x) => x.text).join(''), expected, '逐字拼回');
    let pos = 0;
    for (const x of rows) {
      assert.equal(x.fragment.start_char, pos, '片区间首尾相接');
      pos = x.fragment.end_char;
    }
    assert.equal(pos, 10000);
  } finally { c.db.close(); }
});

test('RRA014-2 对照：两条 2995 中文整行分页各自整条交付（顺延不碎片化）', async () => {
  const c = makeExecutor(tempRoot('rra14b2d-'));
  try {
    const bodies = ['row1:' + '中'.repeat(2990), 'row2:' + '中'.repeat(2990)];
    bodies.forEach((v, i) => seed(c, `m${i + 1}`, v, i + 1));
    const r = await c.executor.execute('conversation_read', { from_sequence: 1, to_sequence: 2 }, CTX);
    const r2 = await c.executor.execute('conversation_read', { cursor: r.output.next_cursor }, CTX);
    assert.deepEqual(r.output.entries.map((x: { seq: number }) => x.seq), [1]);
    assert.deepEqual(r2.output.entries.map((x: { seq: number }) => x.seq), [2]);
    assert.equal(r.output.entries[0].text, bodies[0]);
    assert.equal(r2.output.entries[0].text, bodies[1]);
    assert.equal(r.output.entries[0].fragment, undefined);
    assert.equal(r2.output.entries[0].fragment, undefined);
  } finally { c.db.close(); }
});
