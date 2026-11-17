// E 库种子：与 M 种子共享 sm/sc id；committed hold 在边界前
import { openDatabase } from '/Users/owner/Projects/estomago/apps/host/src/db/connection.ts';
import { migrate } from '/Users/owner/Projects/estomago/apps/host/src/db/migrations.ts';
import { genId, sha256Hex } from '/Users/owner/Projects/estomago/apps/host/src/util/id.ts';
import path from 'node:path';
const root = process.argv[2];
const db = openDatabase(path.join(root, 'data')); migrate(db, sha256Hex);
const committedAt = '2026-01-01T00:00:00.000Z';
const conv = 'conv_probe';
db.prepare("INSERT INTO conversations(id, title, created_at) VALUES (?,NULL,?)").run(conv, committedAt);
let seqBase = 0;
for (const mid of [process.argv[3] ?? 'probe_a']) {
  const turnId = 'turn_' + mid; seqBase += 10;
  db.prepare("INSERT INTO turns(id, conversation_id, state, trigger, input_message_id, created_at) VALUES (?,?,?,'user_input',NULL,?)").run(turnId, conv, 'completed', committedAt);
  const msgIds = [];
  for (let i = 1; i <= 4; i++) {
    const id = `msg_${mid}_${i}`;
    db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, turn_id, kind, current_revision, published_at, created_at) VALUES (?,?,?,?,?,'text',1,?,?)")
      .run(id, conv, seqBase + i, i === 2 ? 'assistant' : 'owner', turnId, committedAt, committedAt);
    const content = i === 2 ? '我把落日的照片发给你了' : `第${i}句：海边的风好大`;
    db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,?,?,?,'user_input')").run(id, content, sha256Hex(content), committedAt, committedAt);
    msgIds.push(id);
  }
  db.prepare('UPDATE turns SET input_message_id = ? WHERE id = ?').run(msgIds[2], turnId);
  for (const id of msgIds) {
    db.prepare('INSERT INTO source_sync_receipts(id, origin_message_id, revision, source_message_id, source_conversation_id, content_hash, operation_id, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(genId('ssr'), id, 1, 'sm_' + id, 'sc_probe', sha256Hex('probe:sm_' + id), 'op_sync_' + mid, 'acked', committedAt);
  }
  db.prepare("INSERT INTO tool_side_effects(id, review_id, turn_id, window_id, kind, state, verified, memory_id, operation_id, tool_call_id, seen_sequence, created_at, updated_at) VALUES (?,?,?,NULL,'hold','committed',1,?,?,?,0,?,?)")
    .run(genId('tse'), null, turnId, mid, 'op_' + mid, 'call_' + mid, committedAt, committedAt);
}
db.close();
