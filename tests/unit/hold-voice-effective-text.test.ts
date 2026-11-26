// G3-F08（裁定 2026-11-03）：语音消息的有效正文三处同源。
// 模型输入（可读声学投影）、归档正文（RR-11：空正文取可信转写）、
// hold 引语/事件范围自此同一份文本、同一 hash 口径——已归档语音
// 不再被 EVENT_SOURCE_NOT_SYNCED 误报，转写不再被 quotes 排除。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MemoryToolsService } from '../../apps/host/src/modules/memory/service.ts';

const T0 = '2026-11-03T09:00:00+08:00';

function makeCtx() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-f08-'));
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  db.prepare("INSERT INTO conversations(id, created_at) VALUES('c1', ?)").run(T0);
  const svc = new MemoryToolsService({
    db, mariposa: null,
    reviews: new RotationReviewService(db),
    checkpoint: new HoldCheckpointService(db),
  });
  return { db, svc };
}

/** 正式形状的语音消息：空正文 + voice 附件（可信转写快照）。 */
function seedVoice(db: ReturnType<typeof openDatabase>, transcript: string) {
  const mid = 'msg_f08_voice';
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES(?, 'c1', 1, 'owner', 'voice', 1, ?)").run(mid, T0);
  db.prepare("INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES(?, ?, 1, 'voice', '', ?, ?, ?, 'client_submit')").run(`${mid}_r1`, mid, sha256Hex(''), T0, T0);
  db.prepare("INSERT INTO media_assets(id, creation_operation_id, state, mime_type, byte_size, content_sha256, storage_key, origin, created_by, ingest_purpose, created_at, updated_at) VALUES('asset_f08', 'op_asset_f08', 'available', 'audio/ogg', 8, ?, 'store-f08', 'upload', 'test', 'chat', ?, ?)").run(sha256Hex('bytes'), T0, T0);
  db.prepare("INSERT INTO message_attachments(message_id, revision, position, asset_id, presentation, caption, derived_text, derived_source, created_at) VALUES(?, 1, 0, 'asset_f08', 'voice', NULL, ?, 'siren:transcribe', ?)").run(mid, transcript, T0);
  // 归档收据：hash 按转写投影（RR-11 同口径）
  db.prepare("INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES('ssr_f08', 'op_f08', ?, 1, 'sc_f08', 'sm_f08', ?, ?, ?)").run(mid, sha256Hex(transcript), T0, T0);
  return mid;
}

test('effectiveTextOf：空正文语音=可信转写；非空正文原样', () => {
  const { db, svc } = makeCtx();
  try {
    const mid = seedVoice(db, '语音里说的原话是紫藤花开了');
    assert.equal(svc.effectiveTextOf(mid, 1, ''), '语音里说的原话是紫藤花开了');
    assert.equal(svc.effectiveTextOf(mid, 1, '  '), '语音里说的原话是紫藤花开了', '空白正文同转写路径');
    assert.equal(svc.effectiveTextOf('不存在', 1, '正文非空'), '正文非空');
    const none = svc.effectiveTextOf('msg_f08_voice', 9, ''); // 无该修订附件
    assert.equal(none, '', '无转写如实为空（B03 不伪造）');
  } finally { db.close(); }
});

test('hash 口径：sha256(有效正文) === 归档收据 hash（不再误报 NOT_SYNCED）', () => {
  const { db, svc } = makeCtx();
  try {
    const transcript = '今天风很大但是心情很好';
    const mid = seedVoice(db, transcript);
    const effective = svc.effectiveTextOf(mid, 1, '');
    const receipt = svc.receiptOf(mid, 1);
    assert.ok(receipt, '收据存在');
    assert.equal(sha256Hex(effective), receipt!.content_hash, 'F08：hold 复核口径与归档投影一致');
  } finally { db.close(); }
});
