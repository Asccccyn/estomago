// 相册重构 P3 + ALB-05/06 整改（审计 2026-11-08）：图片生成两阶段合同。
// 离线固定响应 transport + 进程内 fake M（prepare/stage/finalize/object）+ 真实
// ContentServer/MediaService/ImageGenService/MediaToolsService。覆盖：
// 成功全链（M 落正+免桶作品+引用保护+media_view 可读）；M 503→MASTER_PENDING
// （同键重试只补落正不二次生成）；幂等键=client_operation_id（续轮换 requestId 不换键）；
// 作品条目失败→ENTRY_PENDING 可恢复；断连分类（拒绝=可重试/复位=结果待确认）；
// 未配置如实；超时 unknown。真实远端联调未执行（无授权）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { ContentServer } from '../../apps/content/src/service.ts';
import { contentClientFor } from '../../apps/host/src/integrations/content/client.ts';
import { ImageGenAdapter, type ImageGenTransport } from '../../apps/host/src/integrations/imagegen/adapter.ts';
import { ImageGenService, imageGenOpKey } from '../../apps/host/src/modules/imagegen/service.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MediaToolsService } from '../../apps/host/src/modules/media/service.ts';
import { MariposaMediaStore } from '../../apps/host/src/integrations/mariposa/media-store.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';

const PNG_FULL = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

// —— fake M（与 mariposa-media-master.test.ts 同款形状；可切 503）——
type FakeM = { url: string; fail: boolean; objects: Map<string, Buffer>; close(): void };
function startFakeM(): Promise<FakeM> {
  const objects = new Map<string, Buffer>();
  let lastStagedHash: string | null = null;
  const fake: FakeM = { url: '', fail: false, objects, close: () => {} };
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = req.url ?? '';
    if (fake.fail && !url.startsWith('/api/media/object/')) { reply(503, { ok: false, error: { code: 'UNAVAILABLE' } }); return; }
    if (req.method === 'POST' && url === '/api/capability/media.upload.prepare') {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => { reply(200, { ok: true, data: { upload_token: `tok_${Date.now()}`, stage_url: '/api/media/stage/t1', expires_in_s: 600 } }); });
      return;
    }
    if (req.method === 'PUT' && url.startsWith('/api/media/stage/')) {
      const chunks: Buffer[] = []; req.on('data', (c) => { chunks.push(c as Buffer); });
      req.on('end', () => { const bytes = Buffer.concat(chunks); lastStagedHash = sha256Hex(bytes); reply(200, { ok: true, data: { content_hash: lastStagedHash, staged: true, size: bytes.length } }); });
      return;
    }
    if (req.method === 'POST' && url === '/api/capability/media.upload.finalize') {
      const hash = lastStagedHash ?? sha256Hex(PNG_FULL);
      objects.set(hash, PNG_FULL);
      reply(200, { ok: true, data: { content_hash: hash, mime: 'image/png', deduplicated: false } });
      return;
    }
    const obj = /^\/api\/media\/object\/([0-9a-f]{64})$/.exec(url);
    if (req.method === 'GET' && obj) {
      const bytes = objects.get(obj[1]!);
      if (!bytes) { reply(404, { ok: false, error: { code: 'NOT_FOUND' } }); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(bytes);
      return;
    }
    reply(404, { ok: false, error: { code: 'NOT_FOUND' } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      fake.close = () => server.close();
      resolve(fake);
    });
  });
}

let server: ContentServer;
let fakeM: FakeM;
let root: string;
let db: ReturnType<typeof openDatabase>;
let client: ReturnType<typeof contentClientFor>;

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-imagegen2-'));
  server = new ContentServer({ stateRoot: path.join(root, 'content'), port, token: 'imagegen-test' });
  await server.start();
  fakeM = await startFakeM();
  db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  client = contentClientFor(root, server.port, true);
  process.env.EST_TEST_IMAGEGEN_KEY = 'test-key';
});
after(async () => { await server.stop(); fakeM.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.EST_TEST_IMAGEGEN_KEY; });

function fixture(transport: ImageGenTransport, opts: { mFail?: boolean } = {}): { svc: ImageGenService; media: MediaService; calls: () => number } {
  fakeM.fail = opts.mFail === true;
  const config = buildConfig({});
  const store = new MariposaMediaStore({ baseUrl: fakeM.url, credentialEnv: 'EST_TEST_IMAGEGEN_KEY' });
  const media = new MediaService(db, path.join(root, `media-${Math.random().toString(36).slice(2, 8)}`), config, store);
  let n = 0;
  const counting: ImageGenTransport = async (body, signal) => { n += 1; return transport(body, signal); };
  const adapter = new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'gpt-image-2.6-sunburst', transport: counting });
  return { svc: new ImageGenService({ db, adapter, media, contentClient: client }), media, calls: () => n };
}
const okTransport: ImageGenTransport = async () => ({ status: 200, json: { id: 'gen-1', data: [{ b64_json: PNG_FULL.toString('base64'), revised_prompt: '画好了' }] } });
const CTX1 = { roomId: 'primary', turnId: 'turn-1', requestId: 'req-1', toolCallId: 'call-1' } as const;
const CTX2 = { roomId: 'primary', turnId: 'turn-1', requestId: 'req-2-round', toolCallId: 'call-9' } as const;

test('IG-1: 成功全链——生成 1 次→M 落正→免桶作品→引用保护→media_view 可读；同 op 重放不再生成', async () => {
  const f = fixture(okTransport);
  const opKey = imageGenOpKey(CTX1, 'op-1');
  const r = await f.svc.generateAndStore({ prompt: '画一只小水獭', opKey, title: '水獭' });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(f.calls(), 1);
  assert.ok(r.creation_id, '作品条目建立');
  const asset = f.media.getAsset(r.asset_id);
  assert.equal(asset.m_sync_state, 'synced', '完整成功必须 M synced');
  const ref = db.prepare("SELECT state FROM asset_external_refs WHERE asset_id=? AND owner_type='creation' AND state='committed'").get(r.asset_id) as { state: string } | undefined;
  assert.equal(ref?.state, 'committed', '作品资产引用已确认保护（ALB-05③）');
  const tools = new MediaToolsService({ db, contentClient: client, media: f.media });
  const img = await tools.readImage(r.asset_id, 'primary');
  assert.equal(img.mime, 'image/png', 'media_view 经作品成员授权可读（ALB-05④）');
  const r2 = await f.svc.generateAndStore({ prompt: '画一只小水獭', opKey, title: '水獭' });
  assert.equal(r2.ok, true);
  assert.equal(f.calls(), 1, '重放不再次生成');
});

test('IG-6: M 503→MASTER_PENDING（不建条目）；M 恢复后同键重试只补落正（transport 计数不增）', async () => {
  const f = fixture(okTransport, { mFail: true });
  const opKey = imageGenOpKey(CTX1, 'op-6');
  const fail = await f.svc.generateAndStore({ prompt: '画晚霞', opKey });
  assert.equal(fail.ok, false, 'M 未落正不得报成功（ALB-05①）');
  if (!fail.ok) { assert.equal(fail.code, 'IMAGEGEN_MASTER_PENDING'); assert.equal(fail.retryable, true); }
  assert.equal(f.calls(), 1, '生成阶段已完成');
  const st = db.prepare('SELECT state FROM imagegen_operations WHERE op_key=?').get(opKey) as { state: string };
  assert.equal(st.state, 'generated', '字节暂存待重试');
  const f2 = fixture(okTransport);
  const retry = await f2.svc.generateAndStore({ prompt: '画晚霞', opKey });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(f2.calls(), 0, '重试复用暂存字节，不调用生成');
  if (retry.ok) {
    assert.ok(retry.creation_id, 'M 恢复后补齐作品条目');
    assert.equal(f2.media.getAsset(retry.asset_id).m_sync_state, 'synced');
  }
});

test('IG-7: 幂等键=client_operation_id——续轮换 requestId/toolCallId 仍是同一操作（ALB-06①）', async () => {
  const f = fixture(okTransport);
  const r1 = await f.svc.generateAndStore({ prompt: '画山', opKey: imageGenOpKey(CTX1, 'op-7') });
  assert.equal(r1.ok, true);
  const r2 = await f.svc.generateAndStore({ prompt: '画山', opKey: imageGenOpKey(CTX2, 'op-7') });
  assert.equal(r2.ok, true);
  if (r1.ok && r2.ok) assert.equal(r2.asset_id, r1.asset_id, '同一资产，不二次生成');
  assert.equal(f.calls(), 1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM imagegen_operations WHERE op_key=?').get('tool-imagegen:op-7') as { n: number }).n, 1);
});

test('IG-8: 断连分类——连接拒绝=可安全重试；发送后断开=结果待确认不自动重发（ALB-06②）', async () => {
  const refused = new Error('fetch failed'); (refused as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
  const f1 = fixture(async () => { throw refused; });
  const r1 = await f1.svc.generateAndStore({ prompt: 'x', opKey: imageGenOpKey(CTX1, 'op-8a') });
  assert.equal(r1.ok, false);
  if (!r1.ok) { assert.equal(r1.code, 'IMAGEGEN_NETWORK'); assert.equal(r1.retryable, true); }
  const reset = new Error('socket hang up'); (reset as { cause?: unknown }).cause = { code: 'ECONNRESET' };
  const f2 = fixture(async () => { throw reset; });
  const r2 = await f2.svc.generateAndStore({ prompt: 'x', opKey: imageGenOpKey(CTX1, 'op-8b') });
  assert.equal(r2.ok, false, '发送后断开不能当作未送达');
  if (!r2.ok) { assert.equal(r2.code, 'IMAGEGEN_RESULT_UNCONFIRMED'); assert.equal(r2.retryable, false); }
  const r3 = await f2.svc.generateAndStore({ prompt: 'x', opKey: imageGenOpKey(CTX1, 'op-8b') });
  assert.equal(r3.ok, false, 'unknown 状态同键继续拒绝');
});

test('IG-9: 作品条目失败（content 不可达）→ENTRY_PENDING；恢复后同键补条目（ALB-05②）', async () => {
  const f = fixture(okTransport);
  const opKey = imageGenOpKey(CTX1, 'op-9');
  const badClient = { baseUrl: 'http://127.0.0.1:1', token: 'x' } as never;
  const svcBad = new ImageGenService({ db, adapter: new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'm', transport: okTransport }), media: f.media, contentClient: badClient });
  const fail = await svcBad.generateAndStore({ prompt: '画云', opKey });
  assert.equal(fail.ok, false);
  if (!fail.ok) { assert.equal(fail.code, 'IMAGEGEN_ENTRY_PENDING'); assert.equal(fail.retryable, true); }
  const row = db.prepare('SELECT asset_id FROM imagegen_operations WHERE op_key=?').get(opKey) as { asset_id: string };
  assert.equal(f.media.getAsset(row.asset_id).m_sync_state, 'synced', '资产与 M 已确认，只差条目');
  const retry = await f.svc.generateAndStore({ prompt: '画云', opKey });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(f.calls(), 0, '条目补齐不触碰生成（首次生成已在坏客户端实例完成且仅一次）');
});

test('IG-3: 未配置（adapter=null / Key 缺席）如实 UNCONFIGURED', async () => {
  const svc = new ImageGenService({ db, adapter: null, media: fixture(okTransport).media, contentClient: client });
  const r = await svc.generateAndStore({ prompt: 'x', opKey: imageGenOpKey(CTX1, 'op-3') });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'IMAGEGEN_UNCONFIGURED');
  process.env.EST_TEST_IMAGEGEN_KEY = '';
  const f = fixture(async () => ({ status: 200, json: {} }));
  const r2 = await f.svc.generateAndStore({ prompt: 'x', opKey: imageGenOpKey(CTX1, 'op-3b') });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.code, 'IMAGEGEN_UNCONFIGURED');
  process.env.EST_TEST_IMAGEGEN_KEY = 'test-key';
});

test('IG-4: 超时 unknown→停在待核实；同 op 再调用仍拒绝', async () => {
  const f = fixture(async () => ({ transportError: 'timeout' }));
  const opKey = imageGenOpKey(CTX1, 'op-4');
  const r = await f.svc.generateAndStore({ prompt: '画云', opKey });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'IMAGEGEN_RESULT_UNCONFIRMED');
  const r2 = await f.svc.generateAndStore({ prompt: '画云', opKey });
  assert.equal(r2.ok, false);
});
