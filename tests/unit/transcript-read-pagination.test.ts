// R3′（2026-10-23，她批 R3P 方案）：长转写分页——首页 ≤8192B、续读读尽拼回全文、
// 源变更/跨会话/已删资产如实拒读（不静默截断、不静默重读新版本）。
import { test } from 'node:test';
import { assembleTestTools } from '../helpers.ts';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3p-est-'));
  const db = openDatabase(root); migrate(db, sha256Hex);
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const messages = new MessageService(db); messages.ensureConversation('a'); messages.ensureConversation('b');
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), media: media, messages: messages });
  const ctx = (roomId = 'a'): ToolExecContext => ({ roomId, windowId: 'w', turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r3p' });
  const createWithTranscript = async (text: string) => {
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x00]), purpose: 'chat_voice', operationId: `op-${Math.random().toString(36).slice(2, 8)}`, createdBy: 'qiaosheng', origin: 'upload' });
    const row = db.prepare('SELECT content_sha256 FROM media_assets WHERE id=?').get(asset.id) as { content_sha256: string };
    db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,created_at,updated_at) VALUES (?,?,?,?,'ready',?,?,?)")
      .run(asset.id, 'a', 'r3p-op', row.content_sha256, text, new Date().toISOString(), new Date().toISOString());
    // RE-07（2026-10-24）：合法源=已发布消息附件（当前修订）——未发布草稿不可读
    messages.publishAssistantMessage({ conversationId: 'a', turnId: 'synthetic', content: '', kind: 'voice', clientMessageId: `m-${Math.random()}`, attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    return asset;
  };
  return { root, db, media, messages, tools, ctx, createWithTranscript, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('投影分页：10k 字转写首页 ≤8192B、提示续读、全文不整段出现', async () => {
  const f = fixture();
  try {
    const text = '窗'.repeat(10000);
    const a = await f.createWithTranscript(text);
    const proj = projectRevisionBlocks('', [{ asset_id: a.id, presentation: 'voice', caption: null, derived_text: text, derived_source: 'siren:transcribe' }], { isCurrentInput: true, hearing: { available: true }, transcriptContinuationAvailable: true });
    const block = proj.blocks[0] as { type: string; text: string };
    assert.equal(block.type, 'text');
    const bytes = Buffer.byteLength(block.text, 'utf8');
    assert.ok(bytes <= 8192, `首页块 ${bytes}B 须 ≤8192B`);
    assert.match(block.text, /转写第 1\/\? 页/); // R3″：字节预算分页（页数随内容字宽变化，不再固定 2400 字/页）
    assert.match(block.text, /transcript_read/);
    assert.equal(block.text.includes('窗'.repeat(10000)), false, '不整段全文');
  } finally { f.close(); }
});

test('续读读尽：首页+翻页拼回全文逐字相等；游标元数据如空', async () => {
  const f = fixture();
  try {
    const text = '甲乙丙丁'.repeat(3000); // 12000 字 = 5 页
    const a = await f.createWithTranscript(text);
    let cursor: string | undefined;
    let collected = '';
    let pages = 0;
    for (;;) {
      const r = await f.tools.execute('transcript_read', { audio_ref: `est:${a.id}`, ...(cursor ? { cursor } : {}) }, f.ctx());
      assert.equal(r.ok, true, JSON.stringify(r.output));
      const out = r.output as { page_text: string; next_cursor?: string; total_pages: number };
      collected += out.page_text;
      pages += 1;
      if (!out.next_cursor) break;
      cursor = out.next_cursor;
      assert.ok(pages < 10, '不收敛');
    }
    assert.ok(pages >= 2, `字节预算分页应至少 2 页（12000 汉字），实际 ${pages}`);
    assert.equal(collected, text, '拼回全文逐字相等');
  } finally { f.close(); }
});

test('源变更：转写内容变化后旧游标拒读（TRANSCRIPT_SOURCE_CHANGED）', async () => {
  const f = fixture();
  try {
    const a = await f.createWithTranscript('旧内容'.repeat(1000));
    const r1 = await f.tools.execute('transcript_read', { audio_ref: `est:${a.id}` }, f.ctx());
    const cursor = (r1.output as { next_cursor: string }).next_cursor;
    f.db.prepare('UPDATE voice_transcripts SET derived_text=? WHERE asset_id=?').run('新内容已变化'.repeat(900), a.id);
    const r2 = await f.tools.execute('transcript_read', { audio_ref: `est:${a.id}`, cursor }, f.ctx());
    assert.equal(r2.ok, false);
    assert.equal((r2.output as { error_code: string }).error_code, 'TRANSCRIPT_SOURCE_CHANGED');
  } finally { f.close(); }
});

test('跨会话与已删资产如实拒读', async () => {
  const f = fixture();
  try {
    const a = await f.createWithTranscript('内容');
    const cross = await f.tools.execute('transcript_read', { audio_ref: `est:${a.id}` }, f.ctx('b'));
    assert.equal(cross.ok, false, '跨会话拒读');
    f.db.prepare('DELETE FROM voice_transcripts WHERE asset_id=?').run(a.id);
    f.db.prepare('DELETE FROM media_assets WHERE id=?').run(a.id);
    const gone = await f.tools.execute('transcript_read', { audio_ref: `est:${a.id}` }, f.ctx());
    assert.equal(gone.ok, false, '资产删除拒读');
  } finally { f.close(); }
});
