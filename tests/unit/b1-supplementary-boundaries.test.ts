// B1 补充断言（2026-10-24）：原独立反例 r3-r8 中 test 3/5/8 与 test 6/7 在
// 「无发布消息的转写可否读」上互斥（同夹具一要求 ok:true 一要求 ok:false）。
// 本文件按 02 批次文档 RE-07 的修复方向（未发送草稿拒绝；当前合法源仍可分页）补
// **合法源**（已发布消息+当前修订附件）下的版本化断言；原探针保持原样不改。
import { test } from 'node:test';
import { wireOidoCapabilitiesForTest } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { HostToolExecutor, type ToolExecContext } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { projectRevisionBlocks } from '../../apps/host/src/media/model-input.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-sup-'));
  const db = openDatabase(root); migrate(db, sha256Hex);
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const messages = new MessageService(db); messages.ensureConversation('a');
  const tools = new HostToolExecutor({ db, media, messages, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db)});
  wireOidoCapabilitiesForTest(tools, { oido: null, sirenCall: null });
  const ctx = (): ToolExecContext => ({ roomId: 'a', windowId: 'w', turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'b1sup' });
  // 合法源：上传语音→转写 ready→发布为当前修订消息附件（RE-07 授权边界）
  const createPublishedWithTranscript = async (text: string) => {
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x00]), purpose: 'chat_voice', operationId: `op-${Math.random().toString(36).slice(2, 8)}`, createdBy: 'q', origin: 'upload' });
    const row = db.prepare('SELECT content_sha256 FROM media_assets WHERE id=?').get(asset.id) as { content_sha256: string };
    db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,created_at,updated_at) VALUES (?,?,?,?,'ready',?,?,?)")
      .run(asset.id, 'a', 'b1sup-op', row.content_sha256, text, new Date().toISOString(), new Date().toISOString());
    messages.publishAssistantMessage({ conversationId: 'a', turnId: 'synthetic', content: '', kind: 'voice', clientMessageId: `m-${Math.random()}`, attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    return asset;
  };
  return { root, db, media, messages, tools, ctx, createPublishedWithTranscript, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

// RE-08 合法源：字节预算分页——每页序列化 ≤8192B 且能读尽拼回全文（4 字节汉字长文）
test('B1SUP legit-source transcript pages respect byte budget and roundtrip', async () => {
  const f = fixture();
  try {
    const text = '𠮷'.repeat(3000);
    const a = await f.createPublishedWithTranscript(text);
    let cursor: string | undefined, all = '', pages = 0; const sizes: number[] = [];
    do {
      const r = await f.tools.execute('transcript_read', { audio_ref: `est:${a.id}`, ...(cursor ? { cursor } : {}) }, f.ctx());
      assert.equal(r.ok, true, JSON.stringify(r.output));
      const bytes = Buffer.byteLength(JSON.stringify(r.output), 'utf8');
      sizes.push(bytes);
      assert.ok(bytes <= 8192, `page ${pages + 1} serialized ${bytes}B > 8192`);
      all += r.output.page_text as string;
      cursor = r.output.next_cursor as string | undefined;
      pages++;
      assert.ok(pages < 20);
    } while (cursor);
    assert.equal(all, text);
    console.log(JSON.stringify({ case: 'b1sup_roundtrip', pages, sizes }));
  } finally { f.close(); }
});

// RE-09 合法源：等长改写（甲→乙）后旧 cursor 拒绝（绑定转写内容身份而非长度）
test('B1SUP legit-source equal-length revision rejects prior cursor', async () => {
  const f = fixture();
  try {
    const a = await f.createPublishedWithTranscript('甲'.repeat(5000));
    const first = await f.tools.execute('transcript_read', { audio_ref: `est:${a.id}` }, f.ctx());
    assert.equal(first.ok, true);
    const cursor = first.output.next_cursor as string;
    assert.ok(cursor, '5000 字必分页');
    f.db.prepare('UPDATE voice_transcripts SET derived_text=? WHERE asset_id=?').run('乙'.repeat(5000), a.id);
    const second = await f.tools.execute('transcript_read', { audio_ref: `est:${a.id}`, cursor }, f.ctx());
    console.log(JSON.stringify({ case: 'b1sup_same_length', ok: second.ok, code: second.output.error_code }));
    assert.equal(second.ok, false);
    assert.equal(second.output.error_code, 'TRANSCRIPT_SOURCE_CHANGED');
  } finally { f.close(); }
});

// RE-08 旧窗语义：窗口无 transcript_read 时投影不得宣传续读，只给如实受限提示
test('B1SUP projection does not advertise continuation when window lacks the tool', () => {
  const text = '甲'.repeat(5000);
  const p = projectRevisionBlocks('', [{ asset_id: 'asset-x', presentation: 'voice', caption: null, derived_text: text, derived_source: 'siren:transcribe' }], { isCurrentInput: true, hearing: { available: true }, transcriptContinuationAvailable: false });
  const serialized = JSON.stringify(p.blocks);
  assert.ok(!serialized.includes('transcript_read'), 'old window projection must not advertise the missing tool');
  assert.ok(serialized.includes('本窗工具不含续读'), 'honest limitation note expected');
  assert.ok(serialized.length < 20000);
  const pNew = projectRevisionBlocks('', [{ asset_id: 'asset-x', presentation: 'voice', caption: null, derived_text: text, derived_source: 'siren:transcribe' }], { isCurrentInput: true, hearing: { available: true }, transcriptContinuationAvailable: true });
  assert.ok(JSON.stringify(pNew.blocks).includes('transcript_read'), 'new window keeps advertising continuation');
  console.log(JSON.stringify({ case: 'b1sup_oldwindow', bytes: Buffer.byteLength(serialized) }));
});
