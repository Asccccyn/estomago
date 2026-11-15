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

test('PM-4: chat_voice 用途进 M 正本（宿主用户 2026-11-08 裁定：语音同图片）', async () => {
  const f = fixture(fakeM.url);
  try {
    // webm 在 M 白名单扩展后（mariposa 侧）可用；本 fake M 不校验 mime——断言同步语义
    const before = fakeM.objects.size;
    const v = await f.media.saveBuffer({ bytes: f.webm(32), purpose: 'chat_voice', operationId: 'op-pm4', createdBy: 'qiaosheng', origin: 'upload' });
    assert.equal(v.m_sync_state, 'synced', '新语音保存即落正 M');
    assert.equal(fakeM.objects.size, before + 1, '语音字节进入 M 对象库');
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

test('PM-7: ALB-01 缓存有界化——超预算 LRU 逐 synced 文件（含语音，新裁定）；逐出后读取回源 M 重建', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-mmedia-evict-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const config = buildConfig({ media: { cache_budget_bytes: 200 } }); // 预算=200B：三张 ~104B 图必超
  const mStore = new MariposaMediaStore({ baseUrl: fakeM.url, credentialEnv: 'EST_TEST_M_TOKEN' });
  const media = new MediaService(db, path.join(root, 'media'), config, mStore);
  const png = (n: number, fill = 1) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, fill)]);
  const webm = (n: number) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 7)]);
  try {
    const a1 = await media.saveBuffer({ bytes: png(60, 1), purpose: 'chat_image', operationId: 'ev-1', createdBy: 'q', origin: 'upload' });
    const a2 = await media.saveBuffer({ bytes: png(60, 2), purpose: 'chat_image', operationId: 'ev-2', createdBy: 'q', origin: 'upload' });
    const a3 = await media.saveBuffer({ bytes: png(60, 3), purpose: 'chat_image', operationId: 'ev-3', createdBy: 'q', origin: 'upload' });
    const v = await media.saveBuffer({ bytes: webm(30), purpose: 'chat_voice', operationId: 'ev-v', createdBy: 'q', origin: 'upload' });
    assert.equal(media.getAsset(a1.id).m_sync_state, 'synced');
    assert.equal(v.m_sync_state, 'synced', '语音亦落正 M（新裁定）');
    // 读 a2/a3 触 LRU（a1 最旧：NULL 触点=最旧）
    await media.readContentResolvingMaster(a2.id);
    await media.readContentResolvingMaster(a3.id);
    const ev = media.evictCacheOverBudget();
    assert.equal(ev.evicted >= 1, true, '超预算必须逐出');
    assert.ok(ev.cacheBytes <= 200, `逐出后缓存 ${(ev.cacheBytes)}B 应 ≤ 预算`);
    // 语音文件永不逐
    const voiceKey = (db.prepare('SELECT storage_key FROM media_assets WHERE id=?').get(v.id) as { storage_key: string }).storage_key;
    // 新裁定：语音有 M 正本，同样按 LRU 逐出（回源路径同图验证）
    // 被逐资产：行仍在 available/synced，读取从 M 回源重建缓存
    const evictedRow = db.prepare("SELECT id FROM media_assets WHERE m_sync_state='synced' AND id != ? AND id != ?").get(a2.id, a3.id) as { id: string } | undefined;
    if (evictedRow && evictedRow.id === a1.id) {
      const gone = (db.prepare('SELECT storage_key FROM media_assets WHERE id=?').get(a1.id) as { storage_key: string }).storage_key;
      assert.equal(fs.existsSync(path.join(root, 'media', gone)), false, '最旧者已逐出本地文件');
      assert.equal(media.getAsset(a1.id).state, 'available', '行保留');
      fakeM.counts.objectGet = 0;
      const back = await media.readContentResolvingMaster(a1.id);
      assert.equal(fakeM.counts.objectGet, 1, '回源 M 一次');
      assert.equal(sha256Hex(back.bytes), a1.content_sha256, '回源字节与正本一致');
      assert.equal(fs.existsSync(path.join(root, 'media', gone)), true, '缓存重建');
    }
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
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

test('PM-11 (P1-e 审计 2026-11-15): 逐出按物理文件——同字节别名只算一份；共享文件的待同步引用不逐', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-mmedia-evict2-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const config = buildConfig({ media: { cache_budget_bytes: 50 } }); // 低于单个 ~104B 文件——共享文件必须被逐（旧实现按行重复计账）
  const mStore = new MariposaMediaStore({ baseUrl: fakeM.url, credentialEnv: 'EST_TEST_M_TOKEN' });
  const media = new MediaService(db, path.join(root, 'media'), config, mStore);
  const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(96, fill)]);
  try {
    // ① 两个别名（同字节）都已 synced：磁盘只有一个文件；超预算逐出后=0（旧实现按行计 104 还剩 104）
    const a1 = await media.saveBuffer({ bytes: png(1), purpose: 'chat_image', operationId: 'ev2-1', createdBy: 'q', origin: 'upload' });
    const a2 = await media.saveBuffer({ bytes: png(1), purpose: 'chat_image', operationId: 'ev2-2', createdBy: 'q', origin: 'upload' });
    assert.equal(a2.id !== a1.id, true, '同字节不同操作=两个 asset 身份');
    assert.equal(media.getAsset(a1.id).m_sync_state, 'synced');
    assert.equal(media.getAsset(a2.id).m_sync_state, 'synced');
    const ev = media.evictCacheOverBudget();
    assert.equal(ev.evicted, 1, '超预算逐出该共享文件一次');
    assert.equal(ev.cacheBytes, 0, '容量按物理文件去重（旧实现报 104）');
    // ② A synced、同字节 B 遇 M 503 仍 pending：共享文件不可逐——B 的后台同步依赖本地字节
    fakeM.failMode = 'prepare_503';
    const a3 = await media.saveBuffer({ bytes: png(2), purpose: 'chat_image', operationId: 'ev2-3', createdBy: 'q', origin: 'upload' }); // 落正失败→pending，但本地字节在
    const a4 = await media.saveBuffer({ bytes: png(2), purpose: 'chat_image', operationId: 'ev2-4', createdBy: 'q', origin: 'upload' });
    fakeM.failMode = 'none';
    const b1 = media.getAsset(a3.id), b2 = media.getAsset(a4.id);
    // 制造一个 synced + 一个 pending 的共享对：a3/a4 同为 pending；补一次 a3 同步（关 fail 后 attemptMSync 幂等补）
    await media.attemptMSync(a3.id);
    assert.equal(media.getAsset(a3.id).m_sync_state, 'synced', 'a3 恢复落正');
    assert.equal(media.getAsset(a4.id).m_sync_state, 'pending', 'a4 仍待同步（其同步要用本地字节）');
    const ev2 = media.evictCacheOverBudget();
    assert.equal(ev2.evicted, 0, '共享文件存在未落正引用——本地是 a4 唯一字节，不逐');
    const key = (db.prepare('SELECT storage_key FROM media_assets WHERE id=?').get(a4.id) as { storage_key: string }).storage_key;
    assert.equal(fs.existsSync(path.join(root, 'media', key)), true, 'a4 的本地字节仍在，后台重试可用');
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('PM-12 (P1-4/P2-5 二轮返修): 标删别名不再保护共享文件；CLI 与后台共用规则；M 恢复后正式重试补同步', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const { buildPaths, resolveStateRoot } = await import('../../apps/host/src/config/paths.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'est-pm12-home-'));
  const paths = buildPaths(resolveStateRoot(home));
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(path.join(paths.configDir, 'estomago.yaml'), 'media:\n  cache_budget_bytes: 50\n');
  const db = openDatabase(path.join(home, 'data'));
  migrate(db, sha256Hex);
  const config = buildConfig({ media: { cache_budget_bytes: 50 } });
  const mStore = new MariposaMediaStore({ baseUrl: fakeM.url, credentialEnv: 'EST_TEST_M_TOKEN' });
  const media = new MediaService(db, paths.mediaDir, config, mStore);
  const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(96, fill)]);
  const runCli = (cliArgs: string[]) => exec('node', ['--experimental-strip-types', 'scripts/media-cache-evict.mjs', '--home', home, ...cliArgs], { cwd: process.cwd(), env: { ...process.env, ESTOMAGO_TEST_MODE: '1' } });
  const fileOf = (id: string) => path.join(paths.mediaDir, (db.prepare('SELECT storage_key FROM media_assets WHERE id=?').get(id) as { storage_key: string }).storage_key);
  try {
    // 前提：文件1（a1 pending + a2 synced，共享）受保护；文件2（a3/a4 均 synced）可逐
    fakeM.failMode = 'prepare_503';
    const a1 = await media.saveBuffer({ bytes: png(1), purpose: 'chat_image', operationId: 'pm12-1', createdBy: 'q', origin: 'upload' });
    fakeM.failMode = 'none';
    const a2 = await media.saveBuffer({ bytes: png(1), purpose: 'chat_image', operationId: 'pm12-2', createdBy: 'q', origin: 'upload' });
    const a3 = await media.saveBuffer({ bytes: png(2), purpose: 'chat_image', operationId: 'pm12-3', createdBy: 'q', origin: 'upload' });
    const a4 = await media.saveBuffer({ bytes: png(2), purpose: 'chat_image', operationId: 'pm12-4', createdBy: 'q', origin: 'upload' });
    void a4;
    assert.equal(media.getAsset(a1.id).m_sync_state, 'pending', '前提：a1 因 M 503 仍待同步（保护文件1）');
    assert.equal(media.getAsset(a2.id).m_sync_state, 'synced');
    assert.equal(media.getAsset(a3.id).m_sync_state, 'synced');
    // ① 预演（默认与 --to-budget）：只计文件2 一个/104B；两个文件都在（预演不删）
    const dry = await runCli([]);
    assert.ok(dry.stdout.includes('可逐文件（按物理文件去重）1 个'), dry.stdout);
    assert.ok(dry.stdout.includes('目标 1 个'), dry.stdout);
    const dryBudget = await runCli(['--to-budget']);
    void dryBudget;
    assert.equal(fs.existsSync(fileOf(a1.id)), true, '预演不删：待同步共享文件在');
    assert.equal(fs.existsSync(fileOf(a3.id)), true, '预演不删：可逐文件在');
    // ② 实际执行（按预算 / 全部候选）：都不删待同步共享文件1；只删可逐的文件2
    const applyBudget = await runCli(['--apply', '--to-budget']);
    assert.ok(applyBudget.stdout.includes('删除 1 个文件'), applyBudget.stdout);
    assert.equal(fs.existsSync(fileOf(a1.id)), true, '按预算模式保留待同步共享文件');
    assert.equal(fs.existsSync(fileOf(a3.id)), false);
    const applyAll = await runCli(['--apply']);
    assert.ok(applyAll.stdout.includes('删除 0 个文件') || applyAll.stdout.includes('目标 0 个'), applyAll.stdout);
    assert.equal(fs.existsSync(fileOf(a1.id)), true, '全部合格文件模式同样保留（它不是合格文件）');
    // ③ M 恢复：正式重试使待同步引用补落 synced（验收 4b）
    const recovered = await media.attemptMSync(a1.id);
    assert.equal(recovered, true, 'M 恢复后正式重试补同步成功');
    assert.equal(media.getAsset(a1.id).m_sync_state, 'synced');
    // ④ 文件1 变为可逐：预演目标 1 与实际执行一致；执行后从 M 回源 hash 一致（验收 4c）
    const dry2 = await runCli(['--to-budget']);
    assert.ok(dry2.stdout.includes('目标 1 个'), dry2.stdout);
    assert.equal(fs.existsSync(fileOf(a1.id)), true, '预演后文件仍在');
    const apply2 = await runCli(['--apply', '--to-budget']);
    assert.ok(apply2.stdout.includes('删除 1 个文件'), apply2.stdout);
    assert.equal(fs.existsSync(fileOf(a1.id)), false);
    const back = await media.readContentResolvingMaster(a1.id);
    assert.equal(sha256Hex(back.bytes), media.getAsset(a1.id).content_sha256, 'M 回源字节 hash 一致');
    // ⑤ P2-5：已标删别名不再保护——重建文件1 后标删 a2，预算 50 下应逐出 1 份；A 可回源、B 维持 missing
    assert.equal(fs.existsSync(fileOf(a2.id)), true, '回源已重建本地缓存');
    media.markAssetMissing(a2.id); // 正式删除原语（a2 无引用）
    const ev = media.evictCacheOverBudget();
    assert.equal(ev.evicted, 1, `标删别名不保护——104B 超预算 50B 应逐出（实际 ${ev.evicted}）`);
    assert.equal(fs.existsSync(fileOf(a2.id)), false);
    assert.equal(media.getAsset(a2.id).state, 'missing', 'B 维持 missing');
    const back2 = await media.readContentResolvingMaster(a1.id);
    assert.equal(sha256Hex(back2.bytes), media.getAsset(a1.id).content_sha256, 'A 从 M 回源 hash 一致');
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
