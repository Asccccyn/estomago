import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MariposaMediaStore, MariposaMediaStoreError } from '../../apps/host/src/integrations/mariposa/media-store.ts';

// 相册重构 P2（GLM_ALBUM_REFACTOR_EXECUTION 20261108）：M 唯一正本同步/回源合同（离线 fake M）。
// 覆盖：保存即落正成功；M 不可达→本地成功+pending+退避重试后补齐；读回源（删缓存→M 取回
// sha 校验+重建缓存）；voice 用途 out_of_scope 不进 M；同操作幂等重放不重复上传；
// store 客户端对 hash 不一致如实报错。真实 M（mariposa runtime/objects）联调未在本测试执行。

const TOKEN = 'test-media-token';

type FakeM = {
  url: string;
  objects: Map<string, Buffer>;
  counts: { prepare: number; finalize: number; objectGet: number };
  failMode: 'none' | 'prepare_503' | 'finalize_reject';
  close: () => void;
};

function startFakeM(): Promise<FakeM> {
  const objects = new Map<string, Buffer>();
  const staged = new Map<string, { bytes: Buffer; hash: string }>();
  const counts = { prepare: 0, finalize: 0, objectGet: 0 };
  const state: FakeM['failMode'] = 'none';
  const m: FakeM = { url: '', objects, counts, failMode: state, close: () => {} };
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { reply(401, { ok: false, error: { code: 'UNAUTHORIZED' } }); return; }
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/api/capability/media.upload.prepare') {
      counts.prepare += 1;
      if (m.failMode === 'prepare_503') { reply(503, { ok: false, error: { code: 'UNAVAILABLE' } }); return; }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const { arguments: args } = JSON.parse(raw) as { arguments: { mime: string; size: number } };
        const token = `tok_${counts.prepare}`;
        reply(200, { ok: true, data: { upload_token: token, stage_url: `/api/media/stage/${token}`, expires_in_s: 600, mime: args.mime, size: args.size } });
      });
      return;
    }
    const stage = /^\/api\/media\/stage\/(.+)$/.exec(url);
    if (req.method === 'PUT' && stage) {
      const chunks: Buffer[] = [];
      req.on('data', (c) => { chunks.push(c as Buffer); });
      req.on('end', () => {
        const bytes = Buffer.concat(chunks);
        staged.set(stage[1]!, { bytes, hash: sha256Hex(bytes) });
        reply(200, { ok: true, data: { content_hash: sha256Hex(bytes), staged: true, size: bytes.length } });
      });
      return;
    }
    if (req.method === 'POST' && url === '/api/capability/media.upload.finalize') {
      counts.finalize += 1;
      if (m.failMode === 'finalize_reject') { reply(403, { ok: false, error: { code: 'FORBIDDEN', message: 'mime not allowed' } }); return; }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const { arguments: args } = JSON.parse(raw) as { arguments: { upload_token: string } };
        const s = staged.get(args.upload_token);
        if (!s) { reply(404, { ok: false, error: { code: 'NOT_FOUND' } }); return; }
        staged.delete(args.upload_token);
        objects.set(s.hash, s.bytes);
        reply(200, { ok: true, data: { content_hash: s.hash, mime: 'image/png', deduplicated: false } });
      });
      return;
    }
    const obj = /^\/api\/media\/object\/([0-9a-f]{64})$/.exec(url);
    if (req.method === 'GET' && obj) {
      counts.objectGet += 1;
      const bytes = objects.get(obj[1]!);
      if (!bytes) { reply(404, { ok: false, error: { code: 'NOT_FOUND' } }); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(bytes);
      return;
    }
    reply(404, { ok: false, error: { code: 'NOT_FOUND' } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      m.url = `http://127.0.0.1:${addr.port}`;
      m.close = () => server.close();
      resolve(m);
    });
  });
}

function fixture(mUrl: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-mmedia-test-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const config = buildConfig({});
  const mStore = mUrl ? new MariposaMediaStore({ baseUrl: mUrl, credentialEnv: 'EST_TEST_M_TOKEN' }) : null;
  const media = new MediaService(db, path.join(root, 'media'), config, mStore);
  const png = (n: number, fill = 1) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, fill)]);
  const webm = (n: number) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 7)]);
  return { root, db, media, png, webm, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

let fakeM: FakeM;
before(async () => {
  process.env.EST_TEST_M_TOKEN = TOKEN;
  fakeM = await startFakeM();
});
after(() => { fakeM.close(); delete process.env.EST_TEST_M_TOKEN; });

test('PM-1: 保存即落正 M——synced 状态与 content_hash 一致，同操作幂等重放不重复上传', async () => {
  const f = fixture(fakeM.url);
  try {
    const a = await f.media.saveBuffer({ bytes: f.png(64, 3), purpose: 'chat_image', operationId: 'op-pm1', createdBy: 'qiaosheng', origin: 'upload' });
    assert.equal(a.m_sync_state, 'synced');
    assert.equal(a.m_content_hash, a.content_sha256);
    assert.equal(fakeM.objects.size, 1, 'M 端应恰好有一个对象');
    const b = await f.media.saveBuffer({ bytes: f.png(64, 3), purpose: 'chat_image', operationId: 'op-pm1', createdBy: 'qiaosheng', origin: 'upload' });
    assert.equal(b.id, a.id, '幂等重放返回同一资产');
    assert.equal(b.m_sync_state, 'synced');
    assert.equal(fakeM.objects.size, 1, '重放不得在 M 端新建对象');
    // 同字节不同操作（内容寻址去重后 M 端同 hash 复用，E 端资产身份各自成立）
    const c = await f.media.saveBuffer({ bytes: f.png(64, 3), purpose: 'chat_image', operationId: 'op-pm1b', createdBy: 'qiaosheng', origin: 'upload' });
    assert.notEqual(c.id, a.id);
    assert.equal(c.m_sync_state, 'synced');
    assert.equal(fakeM.objects.size, 1, '同 hash 字节在 M 端不产生第二份长期正本');
  } finally { f.close(); }
});

test('PM-2: M 不可达→本地保存成功且 pending 可见；恢复后补齐 synced', async () => {
  const f = fixture(fakeM.url);
  try {
    fakeM.failMode = 'prepare_503';
    const a = await f.media.saveBuffer({ bytes: f.png(48, 9), purpose: 'chat_sticker', operationId: 'op-pm2', createdBy: 'qiaosheng', origin: 'upload' });
    assert.equal(a.m_sync_state, 'pending', 'M 不可达时如实 pending，不假成功');
    assert.equal(a.m_sync_attempts >= 1, true);
    const local = await f.media.readContentResolvingMaster(a.id);
    assert.equal(local.bytes.length, a.byte_size, '本地缓存仍可读（唯一字节未丢）');
    fakeM.failMode = 'none';
    const pending = f.media.pendingMSyncBatch(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, a.id);
    const ok = await f.media.attemptMSync(a.id);
    assert.equal(ok, true);
    const after = f.media.getAsset(a.id);
    assert.equal(after.m_sync_state, 'synced');
    assert.equal(after.m_content_hash, a.content_sha256);
  } finally { fakeM.failMode = 'none'; f.close(); }
});

test('PM-3: 读回源——本地缓存删除后从 M 取回（sha 校验+缓存重建），二次读不再打 M', async () => {
  const f = fixture(fakeM.url);
  try {
    const a = await f.media.saveBuffer({ bytes: f.png(80, 5), purpose: 'chat_image', operationId: 'op-pm3', createdBy: 'qiaosheng', origin: 'upload' });
    const storageKey = (f.db.prepare('SELECT storage_key FROM media_assets WHERE id = ?').get(a.id) as { storage_key: string }).storage_key;
    fs.rmSync(path.join(f.root, 'media', storageKey));
    fakeM.counts.objectGet = 0;
    const r1 = await f.media.readContentResolvingMaster(a.id);
    assert.equal(fakeM.counts.objectGet, 1, '缓存缺失应从 M 回源一次');
    assert.equal(r1.bytes.length, a.byte_size);
    assert.equal(sha256Hex(r1.bytes), a.content_sha256, '回源字节与正本 hash 一致');
    assert.equal(fs.existsSync(path.join(f.root, 'media', storageKey)), true, '回源后重建本地缓存');
    const r2 = await f.media.readContentResolvingMaster(a.id);
    assert.equal(fakeM.counts.objectGet, 1, '缓存命中不再打 M');
    assert.equal(r2.bytes.length, a.byte_size);
  } finally { f.close(); }
});

test('PM-4: chat_voice 用途 out_of_scope——不进 M、不进待同步批次', async () => {
  const f = fixture(fakeM.url);
  try {
    const prepareBefore = fakeM.counts.prepare;
    const v = await f.media.saveBuffer({ bytes: f.webm(32), purpose: 'chat_voice', operationId: 'op-pm4', createdBy: 'qiaosheng', origin: 'upload' });
    assert.equal(v.m_sync_state, 'out_of_scope');
    assert.equal(fakeM.counts.prepare, prepareBefore, '语音字节不得触发 M 上传（A66 既有音频链路不动）');
    assert.equal(f.media.pendingMSyncBatch(50).some((x) => x.id === v.id), false);
  } finally { f.close(); }
});

test('PM-5: store 客户端——finalize 被拒如实报错、对象不存在如实 404、无凭据如实失败', async () => {
  const f = fixture(fakeM.url);
  try {
    fakeM.failMode = 'finalize_reject';
    const a = await f.media.saveBuffer({ bytes: f.png(40, 4), purpose: 'chat_image', operationId: 'op-pm5', createdBy: 'qiaosheng', origin: 'upload' });
    assert.equal(a.m_sync_state, 'pending');
    assert.equal(a.m_sync_attempts >= 1, true);
    fakeM.failMode = 'none';
    const store = new MariposaMediaStore({ baseUrl: fakeM.url, credentialEnv: 'EST_TEST_M_TOKEN' });
    await assert.rejects(() => store.fetchBytes('0'.repeat(64)), (err: unknown) => {
      assert.ok(err instanceof MariposaMediaStoreError);
      assert.match(err.code, /MARMEDIA_HTTP_404|MARMEDIA_NOT_FOUND/);
      return true;
    });
    const noAuth = new MariposaMediaStore({ baseUrl: fakeM.url, credentialEnv: 'EST_TEST_MISSING_TOKEN' });
    await assert.rejects(() => noAuth.uploadBytes(f.png(10), 'image/png'), (err: unknown) => {
      assert.ok(err instanceof MariposaMediaStoreError);
      assert.match(err.code, /MARMEDIA_UNAUTHORIZED/);
      return true;
    });
  } finally { fakeM.failMode = 'none'; f.close(); }
});

test('PM-6: M 未配置（mStore=null）——保存仍成功且如实 pending，回源路径不误报', async () => {
  const f = fixture(null);
  try {
    const a = await f.media.saveBuffer({ bytes: f.png(30, 6), purpose: 'chat_image', operationId: 'op-pm6', createdBy: 'qiaosheng', origin: 'upload' });
    assert.equal(a.m_sync_state, 'pending');
    assert.equal(await f.media.attemptMSync(a.id), false, '无 store 不得假装 synced');
    const local = await f.media.readContentResolvingMaster(a.id);
    assert.equal(local.bytes.length, a.byte_size);
  } finally { f.close(); }
});
