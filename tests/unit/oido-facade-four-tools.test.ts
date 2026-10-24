// R5（2026-10-23）：oído 六工具 façade 补齐——capabilities/view/find/compare（会话绑定同门）。
import { test } from 'node:test';
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

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-facade-'));
  const db = openDatabase(root); migrate(db, sha256Hex);
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const messages = new MessageService(db); messages.ensureConversation('a'); messages.ensureConversation('b');
  const calls: Record<string, unknown>[] = [];
  const adapter = {
    configured: true,
    capabilities: async () => ({ ok: true, providers: [{ name: 'local' }], status: 'ok' }),
    getView: async (id: string) => { calls.push({ view: id }); return { mime: 'image/png', pngBase64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), metadata: { analysis_id: id } }; },
    find: async (a: Record<string, unknown>) => { calls.push({ find: a }); return { state: 'candidates', items: [{ range_ms: [0, 500], match: '嗯' }] }; },
    compare: async (a: Record<string, unknown>) => { calls.push({ compare: a }); return { metrics: [], limits: [], baseline_comparison: { state: 'unavailable' } }; },
  };
  const tools = new HostToolExecutor({ db, media, messages, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), oido: adapter as never });
  const ctx = (roomId = 'a'): ToolExecContext => ({ roomId, windowId: 'w', turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r5' });
  const create = async () => {
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x00]), purpose: 'chat_voice', operationId: `op-${Math.random().toString(36).slice(2, 8)}`, createdBy: 'q', origin: 'upload' });
    messages.publishAssistantMessage({ conversationId: 'a', turnId: 't', content: '', kind: 'voice', clientMessageId: `m-${Math.random()}`, attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    return asset;
  };
  return { db, tools, ctx, create, calls, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('capabilities 直达；view/find/compare 跨会话拒（绑定同门）', async () => {
  const f = fixture();
  try {
    const caps = await f.tools.execute('oido_capabilities', {}, f.ctx());
    assert.equal(caps.ok, true);
    const a = await f.create();
    f.db.prepare('INSERT INTO oido_source_bindings(analysis_id,conversation_id,asset_id,content_sha256) VALUES (?,?,?,?)')
      .run('an-x', 'a', a.id, (f.db.prepare('SELECT content_sha256 FROM media_assets WHERE id=?').get(a.id) as { content_sha256: string }).content_sha256);
    // view 绑定门：a 会话过、b 会话拒
    const v1 = await f.tools.execute('oido_view', { analysis_id: 'an-x' }, f.ctx('a'));
    assert.equal(v1.ok, true);
    // R3″/RE-05（2026-10-24）：图与正文分路——模型 JSON 不再含 base64/image_mime；
    // 图存为界面资产（ui_ref），播放器/界面走宿主二进制路由
    const img = (v1.output as Record<string, unknown>)['image'] as Record<string, unknown>;
    assert.equal(img['view'], 'ui_only');
    assert.equal(img['mime'], 'image/png');
    assert.ok(typeof img['ui_ref'] === 'string' && String(img['ui_ref']).startsWith('/api/v1/oido/views/'));
    assert.ok(!('image_base64' in (v1.output as Record<string, unknown>)));
    const v2 = await f.tools.execute('oido_view', { analysis_id: 'an-x' }, f.ctx('b'));
    assert.equal(v2.ok, false, '跨会话拒读');
    // find/compare 源门
    const f1 = await f.tools.execute('oido_find', { audio_ref: `est:${a.id}`, query: '嗯' }, f.ctx('a'));
    assert.equal(f1.ok, true);
    const f2 = await f.tools.execute('oido_find', { audio_ref: `est:${a.id}`, query: '嗯' }, f.ctx('b'));
    assert.equal(f2.ok, false);
    const c1 = await f.tools.execute('oido_compare', { left: { audio_ref: `est:${a.id}` }, right: { audio_ref: `est:${a.id}` } }, f.ctx('a'));
    assert.equal(c1.ok, true);
    const c2 = await f.tools.execute('oido_compare', { left: { audio_ref: `est:${a.id}` }, right: { audio_ref: `est:${a.id}` } }, f.ctx('b'));
    assert.equal(c2.ok, false);
  } finally { f.close(); }
});
