import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService, MediaError, STAGED_UPLOAD_MAX_AGE_MS } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import type { MariposaMediaStore } from '../../apps/host/src/integrations/mariposa/media-store.ts';
import { MariposaMediaStoreError } from '../../apps/host/src/integrations/mariposa/media-store.ts';
import { handleContentProxy } from '../../apps/host/src/server/routes/content.ts';

// 暂存上传（2026-11-23，乔乔裁定：未发送的附件不进 Mariposa）：输入框或帖子草稿里选中的文件
// 只存 E 本地；正式消息或内容引用它的同一请求里才落正 M；被放弃的暂存由 E 直接删除。

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#274a8f"/></svg>');

type FakeM = { uploads: string[]; fail: boolean };
const fakeM = (fail = false): FakeM => ({ uploads: [], fail });
const storeOf = (m: FakeM) => ({
  uploadBytes: async (bytes: Uint8Array) => {
    if (m.fail) throw new MariposaMediaStoreError('UNAVAILABLE', 'M 合成不可达');
    const content_hash = sha256Hex(Buffer.from(bytes));
    m.uploads.push(content_hash);
    return { content_hash };
  },
}) as unknown as MariposaMediaStore;

type Asset = { id: string; content_sha256: string; mime_type: string };

function fixture(m: FakeM | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-staged-test-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}), m ? storeOf(m) : null);
  const png = (fill: number) => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(48, fill)]);
  const staged = (fill: number, operationId: string) => media.saveBuffer({ bytes: png(fill), purpose: 'chat_image', operationId, createdBy: 'qiaosheng', origin: 'upload', staged: true });
  return { root, db, media, png, staged, messages: new MessageService(db),
    file: (a: Asset) => path.join(root, 'media', a.content_sha256.slice(0, 2), `${a.content_sha256}.png`),
    close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const missing = (e: unknown) => e instanceof MediaError && e.code === 'ASSET_NOT_FOUND';

test('SU-1：暂存上传只存本地——不进 M，后台重试与同键重放都不提前送', async () => {
  const m = fakeM(); const f = fixture(m);
  try {
    const a = await f.staged(3, 'upload:pick-1');
    assert.equal(a.state, 'available');
    assert.equal(a.m_sync_state, 'staged');
    assert.ok(fs.existsSync(f.file(a)), '本地字节已落盘');
    assert.equal(f.media.readContent(a.id).bytes.length, f.png(3).length, '本地照常可读');
    // A regular upload, such as the album page, still goes straight to the master store.
    const album = await f.media.saveBuffer({ bytes: f.png(4), purpose: 'chat_image', operationId: 'upload:album-1', createdBy: 'qiaosheng', origin: 'upload' });
    assert.equal(album.m_sync_state, 'synced');
    assert.deepEqual(m.uploads, [album.content_sha256], 'M 只收到普通上传');
    await f.media.saveBuffer({ bytes: f.png(3), purpose: 'chat_image', operationId: 'upload:pick-1', createdBy: 'qiaosheng', origin: 'upload', staged: true });
    assert.equal(await f.media.attemptMSync(a.id), false);
    assert.deepEqual(f.media.pendingMSyncBatch(10), [], '暂存不是待补落正');
    assert.equal(f.media.getAsset(a.id).m_sync_state, 'staged');
    assert.deepEqual(m.uploads, [album.content_sha256]);
  } finally { f.close(); }
});

test('SU-2：发送时才落正——M 拿不下则抛错并保持暂存，恢复后同一份落正一次', async () => {
  const m = fakeM(true); const f = fixture(m);
  try {
    const a = await f.staged(3, 'upload:pick-1');
    await assert.rejects(f.media.commitStagedAssets([a.id]), (e: MediaError) => e.code === 'ASSET_MASTER_COMMIT_FAILED' && e.httpStatus === 503);
    assert.equal(f.media.getAsset(a.id).m_sync_state, 'staged', '失败后仍是暂存，不会被后台重试补进 M');
    assert.equal(f.media.getAsset(a.id).m_sync_attempts, 1);
    assert.deepEqual(f.media.pendingMSyncBatch(10), []);
    await f.media.commitStagedAssets(['asset-unknown']);
    m.fail = false;
    await f.media.commitStagedAssets([a.id, a.id, 'asset-unknown']);
    assert.equal(f.media.getAsset(a.id).m_sync_state, 'synced');
    assert.equal(f.media.getAsset(a.id).m_content_hash, a.content_sha256);
    assert.deepEqual(m.uploads, [a.content_sha256], '同一份只落正一次');
    await f.media.commitStagedAssets([a.id]);
    assert.deepEqual(m.uploads, [a.content_sha256]);
  } finally { f.close(); }
  // M 未配置：与普通上传一致，如实转 pending，不拦发布。
  const g = fixture(null);
  try {
    const a = await g.staged(3, 'upload:pick-1');
    await g.media.commitStagedAssets([a.id]);
    assert.equal(g.media.getAsset(a.id).m_sync_state, 'pending');
    assert.deepEqual(g.media.pendingMSyncBatch(10).map(item => item.id), [a.id]);
  } finally { g.close(); }
});

test('SU-3：放弃暂存上传删行与本地字节；已被消息引用则拒绝；同字节的另一份仍需该文件时留文件', async () => {
  const m = fakeM(); const f = fixture(m); f.messages.ensureConversation('primary');
  try {
    const a = await f.staged(5, 'upload:pick-a');
    const file = f.file(a);
    assert.equal(f.media.discardStagedAssets([a.id]), 1);
    assert.throws(() => f.media.getAsset(a.id), missing);
    assert.equal(fs.existsSync(file), false, '本地字节一并删除');
    assert.equal(f.media.discardStagedAssets([a.id]), 0, '重复放弃无副作用');
    // Two drafts that picked the same picture share one stored copy.
    const first = await f.staged(6, 'upload:pick-b');
    const second = await f.staged(6, 'upload:pick-c');
    assert.equal(f.media.discardStagedAssets([first.id]), 1);
    assert.ok(fs.existsSync(f.file(second)), '另一份仍需这些字节');
    assert.equal(f.media.readContent(second.id).bytes.length, f.png(6).length);
    // A staged upload a message already refers to is no longer a draft.
    const sent = await f.staged(7, 'upload:pick-d');
    f.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '', clientMessageId: 'message-d', attachments: [{ asset_id: sent.id, presentation: 'image' }] });
    assert.throws(() => f.media.discardStagedAssets([sent.id]), (e: MediaError) => e.code === 'ASSET_REFERENCED');
    assert.equal(f.media.getAsset(sent.id).state, 'available');
    assert.deepEqual(m.uploads, [], '整个过程 M 什么都没收到');
  } finally { f.close(); }
});

test('SU-4：过期且无引用的暂存上传被清掉；新鲜的、被引用的、已落正的和等待补落正的都不动', async () => {
  const m = fakeM(); const f = fixture(m); f.messages.ensureConversation('primary');
  const now = Date.now();
  const age = (a: Asset, ms: number) => f.db.prepare('UPDATE media_assets SET created_at = ? WHERE id = ?').run(new Date(now - ms).toISOString(), a.id);
  try {
    const old = await f.staged(1, 'upload:pick-old'); age(old, STAGED_UPLOAD_MAX_AGE_MS + 60_000);
    const fresh = await f.staged(2, 'upload:pick-fresh'); age(fresh, STAGED_UPLOAD_MAX_AGE_MS - 60_000);
    const referenced = await f.staged(3, 'upload:pick-referenced'); age(referenced, STAGED_UPLOAD_MAX_AGE_MS + 60_000);
    f.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '', clientMessageId: 'message-ref', attachments: [{ asset_id: referenced.id, presentation: 'image' }] });
    const synced = await f.media.saveBuffer({ bytes: f.png(4), purpose: 'chat_image', operationId: 'upload:album-1', createdBy: 'qiaosheng', origin: 'upload' });
    age(synced, STAGED_UPLOAD_MAX_AGE_MS + 60_000);
    m.fail = true;
    const waiting = await f.media.saveBuffer({ bytes: f.png(5), purpose: 'chat_image', operationId: 'upload:album-2', createdBy: 'qiaosheng', origin: 'upload' });
    m.fail = false;
    age(waiting, STAGED_UPLOAD_MAX_AGE_MS + 60_000);
    assert.equal(f.media.pruneStagedUploads(now), 1);
    assert.throws(() => f.media.getAsset(old.id), missing);
    for (const kept of [fresh, referenced, synced, waiting]) assert.ok(fs.existsSync(f.file(kept)), kept.id);
    assert.equal(f.media.pruneStagedUploads(now), 0);
  } finally { f.close(); }
});

test('SU-5：暂存的静态 SVG 连同它的 PNG 视图一起留在本地，落正或放弃时一起处理', async () => {
  const m = fakeM(); const f = fixture(m);
  try {
    const a = await f.media.saveStaticSvg({ bytes: SVG, operationId: 'upload:svg-draft-1', createdBy: 'qiaosheng', origin: 'upload', staged: true });
    assert.ok(a);
    assert.equal(a.m_sync_state, 'staged');
    assert.equal(f.media.canProvideImage(f.media.getAsset(a.id)), false, '视图未落正，暂存期间不能当作可发送图片');
    assert.deepEqual(m.uploads, []);
    await f.media.commitStagedAssets([a.id]);
    assert.equal(f.media.getAsset(a.id).m_sync_state, 'synced');
    assert.equal(f.media.canProvideImage(f.media.getAsset(a.id)), true);
    assert.equal(m.uploads.length, 2, '原件与视图各一份');
    const b = await f.media.saveStaticSvg({ bytes: SVG, operationId: 'upload:svg-draft-2', createdBy: 'qiaosheng', origin: 'upload', staged: true });
    assert.ok(b);
    assert.equal(f.media.discardStagedAssets([b.id]), 1);
    assert.throws(() => f.media.getAsset(b.id), missing);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE origin_ref = ?').get(b.id) as { n: number }).n, 0, '视图随原件一起删除');
    assert.equal(m.uploads.length, 2);
  } finally { f.close(); }
});

test('SU-6：暂存文件是唯一副本，缓存逐出不碰它', async () => {
  const m = fakeM(); const f = fixture(m);
  try {
    const a = await f.staged(9, 'upload:pick-1');
    assert.equal(f.media.evictCacheOverBudget().evicted, 0);
    assert.ok(fs.existsSync(f.file(a)));
  } finally { f.close(); }
});

test('SU-7：帖子保存时，草稿里的暂存附件先落正再交给 Content；落正失败则不写', async () => {
  const m = fakeM(true); const f = fixture(m);
  try {
    const a = await f.staged(3, 'upload:pick-1');
    const written: unknown[] = [];
    const deps = { db: f.db, media: f.media, contentClient: { baseUrl: 'http://content.test', token: 'synthetic-only' },
      contentOps: { write: async (request: unknown) => { written.push(request); return { status: 201, body: { id: 'post-1' } }; } } } as never;
    const save = async (body: unknown) => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/api/v1/content/posts', headers: {} }) as unknown as IncomingMessage;
      const res = { status: 0, payload: '', writeHead(status: number) { this.status = status; return this; },
        end(payload?: string) { this.payload = payload ?? ''; } } as unknown as ServerResponse & { status: number; payload: string };
      await handleContentProxy(req, res, deps, new URL('http://est.test/api/v1/content/posts'));
      return { status: res.status, body: JSON.parse(res.payload || 'null') as { id?: string; error?: { code: string } } };
    };
    const refused = await save({ body: '合成帖子', title: '带附件', asset_ids: [a.id] });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error?.code, 'asset_master_commit_failed');
    assert.equal(written.length, 0);
    m.fail = false;
    const saved = await save({ body: '合成帖子', title: '带附件', asset_ids: [a.id] });
    assert.equal(saved.status, 201);
    assert.equal(written.length, 1);
    assert.equal(f.media.getAsset(a.id).m_sync_state, 'synced');
  } finally { f.close(); }
});
