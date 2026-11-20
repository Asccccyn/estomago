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
// 复审 2026-11-09 二轮（GIF 证据修正）：finalize 落**实际 stage 字节**并按魔数
// 定 MIME；对象 GET 按对象自身的 MIME 回——不再固定 PNG（旧假 M 掩盖了 GIF 的
// M 落正与回源路径，绿测试只证明参数面）。
type FakeM = { url: string; fail: boolean; objects: Map<string, Buffer>; objectGets: number; close(): void };
const sniffMime = (bytes: Buffer): string => {
  if (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return 'application/octet-stream';
};
function startFakeM(): Promise<FakeM> {
  const objects = new Map<string, Buffer>();
  let lastStagedHash: string | null = null;
  let lastStagedBytes: Buffer | null = null;
  const fake: FakeM = { url: '', fail: false, objects, objectGets: 0, close: () => {} };
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
      req.on('end', () => { lastStagedBytes = Buffer.concat(chunks); lastStagedHash = sha256Hex(lastStagedBytes); reply(200, { ok: true, data: { content_hash: lastStagedHash, staged: true, size: lastStagedBytes.length } }); });
      return;
    }
    if (req.method === 'POST' && url === '/api/capability/media.upload.finalize') {
      const bytes = lastStagedBytes ?? PNG_FULL;
      const hash = lastStagedHash ?? sha256Hex(PNG_FULL);
      objects.set(hash, bytes);
      reply(200, { ok: true, data: { content_hash: hash, mime: sniffMime(bytes), deduplicated: false } });
      return;
    }
    const obj = /^\/api\/media\/object\/([0-9a-f]{64})$/.exec(url);
    if (req.method === 'GET' && obj) {
      const bytes = objects.get(obj[1]!);
      if (!bytes) { reply(404, { ok: false, error: { code: 'NOT_FOUND' } }); return; }
      fake.objectGets += 1;
      res.writeHead(200, { 'Content-Type': sniffMime(bytes) }); res.end(bytes);
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

function fixture(transport: ImageGenTransport, opts: { mFail?: boolean; messages?: import('../../apps/host/src/messages/service.ts').MessageService | null } = {}): { svc: ImageGenService; media: MediaService; mediaDir: string; calls: () => number } {
  fakeM.fail = opts.mFail === true;
  const config = buildConfig({});
  const store = new MariposaMediaStore({ baseUrl: fakeM.url, credentialEnv: 'EST_TEST_IMAGEGEN_KEY' });
  const mediaDir = path.join(root, `media-${Math.random().toString(36).slice(2, 8)}`);
  const media = new MediaService(db, mediaDir, config, store);
  let n = 0;
  const counting: ImageGenTransport = async (body, signal) => { n += 1; return transport(body, signal); };
  const adapter = new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'gpt-image-2.6-sunburst', transport: counting });
  return { svc: new ImageGenService({ db, adapter, media, contentClient: client, ...(opts.messages !== undefined ? { messages: opts.messages } : {}) }), media, mediaDir, calls: () => n };
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

// —— 复审 2026-11-09 二轮（GIF 证据修正）：真双帧夹具 + fake M 落实际字节/MIME +
// 缓存逐出后经真实资产 HTTP 路由回读（不再把 readContentResolvingMaster 的返回对象
// 称为"实际 HTTP 响应"）。夹具由 Pillow 生成：16×16 红/蓝两帧、duration=200ms、
// loop=0（NETSCAPE2.0 循环扩展），157 字节。

const ANIMATED_GIF = Buffer.from('R0lGODlhEAAQAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAEAAQAAAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBACH5BAEUAAEALAAAAAAQABAAgQAA/wAAAAAAAAAAAAgdAAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWBAQEAOw==', 'base64');

/** 逐块走 GIF 结构数图像描述符（0x2C）——不依赖解码器，够断言"仍是两帧"。 */
function gifFrameCount(buf: Buffer): number {
  const gct = (buf[10]! & 0x80) !== 0 ? 3 * (2 ** ((buf[10]! & 0x07) + 1)) : 0;
  let i = 13 + gct;
  let frames = 0;
  const skipSubBlocks = () => { let sz = buf[i]!; while (sz > 0) { i += 1 + sz; sz = buf[i]!; } i += 1; };
  while (i < buf.length) {
    const b = buf[i]!;
    if (b === 0x3b) break;
    if (b === 0x21) { i += 2; skipSubBlocks(); continue; } // 扩展块：标签后子块串
    if (b === 0x2c) {
      frames += 1;
      const packed = buf[i + 9]!;
      i += 10 + ((packed & 0x80) !== 0 ? 3 * (2 ** ((packed & 0x07) + 1)) : 0);
      i += 1; // LZW min code size
      skipSubBlocks();
      continue;
    }
    break;
  }
  return frames;
}

test('IG-GIF: 动图请求带 output_format/frame 参数；M 落实际字节+MIME；逐出缓存后真实资产 HTTP 回源，字节保真仍是两帧；同键重放不重画', async () => {
  assert.equal(gifFrameCount(ANIMATED_GIF), 2, '夹具前提：真实两帧');
  let sawBody: Record<string, unknown> | null = null;
  const gifTransport: ImageGenTransport = async (body) => {
    sawBody = { ...(body as Record<string, unknown>) };
    return { status: 200, json: { id: 'gen-gif', data: [{ b64_json: ANIMATED_GIF.toString('base64'), revised_prompt: '水獭挥手循环' }] } };
  };
  const f = fixture(gifTransport);
  const opKey = imageGenOpKey(CTX1, 'op-gif-1');
  const r = await f.svc.generateAndStore({ prompt: '一只圆滚滚的小水獭挥手，循环动画，镜头固定', opKey, title: '挥手水獭', format: 'gif', frameCount: 9, frameDurationMs: 200 });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  // 请求侧：官方 GIF 参数如实传到供应商（旧实现缺 output_format=根因：默认静态 PNG）
  assert.equal((sawBody as Record<string, unknown> | null)?.['output_format'], 'gif');
  assert.equal((sawBody as Record<string, unknown>)['frame_count'], 9);
  assert.equal((sawBody as Record<string, unknown>)['frame_duration_ms'], 200);
  // 存储侧：mime=gif、M 落的是实际 stage 字节（fake M 按魔数回 MIME，不再固定 PNG）
  const asset = f.media.getAsset(r.asset_id);
  assert.equal(asset.mime_type, 'image/gif');
  assert.equal(asset.m_sync_state, 'synced', 'GIF 同为 M 唯一正本（fake M 全链落正）');
  assert.ok(fakeM.objects.get(asset.m_content_hash ?? asset.content_sha256), 'M 对象库存有该 hash');
  // 逐出本地缓存（明确删除本服务目录下的缓存文件），再经**真实资产 HTTP 路由**回读
  for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('media-'))) {
    const abs = path.join(root, dir);
    if (!fs.statSync(abs).isDirectory()) continue;
    for (const ent of fs.readdirSync(abs, { recursive: true })) {
      const p = path.join(abs, ent as string);
      if (fs.statSync(p).isFile()) fs.unlinkSync(p);
    }
  }
  const assetServer = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://est');
    void (async () => {
      const { handleAssetsRoutes } = await import('../../apps/host/src/server/routes/assets.ts');
      await handleAssetsRoutes(req, res, { media: f.media } as never, `${req.method} ${u.pathname}`, u);
    })().catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  await new Promise<void>((resolve) => assetServer.listen(0, '127.0.0.1', resolve));
  try {
    const getsBefore = fakeM.objectGets;
    const httpRes = await fetch(`http://127.0.0.1:${(assetServer.address() as { port: number }).port}/api/v1/assets/${encodeURIComponent(r.asset_id)}/content`);
    const body = Buffer.from(await httpRes.arrayBuffer());
    assert.equal(httpRes.status, 200);
    assert.equal(httpRes.headers.get('content-type'), 'image/gif', '真实 HTTP 响应 Content-Type=image/gif');
    assert.ok(fakeM.objectGets > getsBefore, '缓存逐出后确实回源 M');
    assert.equal(Buffer.compare(body, ANIMATED_GIF), 0, 'HTTP 回读字节与生成字节完全一致（动画帧无损）');
    assert.equal(gifFrameCount(body), 2, '回读仍是两帧（无重编码）');
  } finally { assetServer.close(); }
  // 作品链：条目（content 正本经 HTTP 读回）+ 引用保护
  assert.ok(r.creation_id);
  const { contentForward } = await import('../../apps/host/src/integrations/content/client.ts');
  const crt = await contentForward(client as never, { method: 'GET', actor: 'jiaming', path: `/api/v1/content/creations/${encodeURIComponent(r.creation_id)}` });
  assert.equal((crt.body as { work_kind?: string }).work_kind, 'image');
  // 同键同参重放=原结果（P1-c：请求指纹含 prompt/帧参数——同键换参=IDEMPOTENCY_CONFLICT）
  const r2 = await f.svc.generateAndStore({ prompt: '一只圆滚滚的小水獭挥手，循环动画，镜头固定', opKey, format: 'gif', frameCount: 9, frameDurationMs: 200 });
  assert.equal(r2.ok, true);
  assert.equal(f.calls(), 1, '重放不再生成/计费');
});

test('IG-GIF-2 (参数合同): size=auto 官方形态放行透传；frame_duration_ms<20 按官方下限拒绝', async () => {
  const adapter = new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'm', transport: okTransport });
  const tooFast = await adapter.generate('x', { format: 'gif', frameDurationMs: 10 });
  assert.equal(tooFast.outcome, 'error');
  if (tooFast.outcome === 'error') assert.equal(tooFast.code, 'IMAGEGEN_PARAM_INVALID');
  let sawSize: unknown = null;
  const okAdapter = new ImageGenAdapter({
    baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'm',
    transport: async (body) => { sawSize = (body as Record<string, unknown>)['size']; return okTransport(body); },
  });
  const auto = await okAdapter.generate('x', { size: 'auto' });
  assert.equal(auto.outcome, 'ok');
  assert.equal(sawSize, 'auto', '官方 auto 形态透传（不自行发明另一组限制）');
});

test('IG-10 (RR7): 条目已建但快照 GET 失败→IMAGEGEN_SNAPSHOT_PENDING（行留 stored+creation_id）；恢复后同键只补快照', async () => {
  // content 框架代理：写路由转发真 content；references 读 503（模拟快照读取故障）
  const proxy = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && (req.url ?? '').includes('/references/')) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'unavailable' } })); return; }
      const opts = { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${server.port}` }, ...(req.method === 'POST' ? { body: raw } : {}) } as RequestInit;
      void fetch(`http://127.0.0.1:${server.port}${req.url}`, opts).then(async (up) => {
        res.writeHead(up.status, { 'Content-Type': 'application/json' });
        res.end(await up.text());
      });
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const failingClient = { baseUrl: proxyUrl, token: server.token };
    const config = buildConfig({});
    const store = new MariposaMediaStore({ baseUrl: fakeM.url, credentialEnv: 'EST_TEST_IMAGEGEN_KEY' });
    const media = new MediaService(db, path.join(root, `media-${Math.random().toString(36).slice(2, 8)}`), config, store);
    let n = 0;
    const counting: ImageGenTransport = async (body, signal) => { n += 1; return okTransport(body, signal); };
    const svc = new ImageGenService({ db, adapter: new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'm', transport: counting }), media, contentClient: failingClient as never });
    const opKey = imageGenOpKey(CTX1, 'op-snap-1');
    const r1 = await svc.generateAndStore({ prompt: '快照故障画', opKey });
    assert.equal(r1.ok, false, JSON.stringify(r1));
    if (r1.ok) return;
    assert.equal(r1.code, 'IMAGEGEN_SNAPSHOT_PENDING');
    assert.equal(r1.retryable, true);
    const row = db.prepare('SELECT state, creation_id FROM imagegen_operations WHERE op_key = ?').get(opKey) as { state: string; creation_id: string };
    assert.equal(row.state, 'stored', '快照未确认不再冒充 saved');
    assert.ok(row.creation_id, 'stored 行带 creation_id——恢复分支真实可达');
    // 恢复：改指真 content，同键重试只补快照（transport 不增）
    const healed = new ImageGenService({ db, adapter: new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'm', transport: counting }), media, contentClient: client });
    const r2 = await healed.generateAndStore({ prompt: '快照故障画', opKey });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(n, 1, '恢复不重新生成');
    const row2 = db.prepare('SELECT state FROM imagegen_operations WHERE op_key = ?').get(opKey) as { state: string };
    assert.equal(row2.state, 'saved');
  } finally { proxy.close(); }
});

test('IG-11 (RR4): creation_save_artifact 在 M 未落正时 CREATION_MASTER_PENDING（不建条目）；恢复后同键补齐 saved', async () => {
  const { ContentToolsService } = await import('../../apps/host/src/modules/content/service.ts');
  const f = fixture(okTransport, { mFail: true });
  const tools = new ContentToolsService({ media: f.media, contentClient: client, contentOps: null });
  const ctx = { roomId: 'primary', turnId: 't', requestId: 'r', purpose: 'chat' as const, activeReviewId: null, seenSequence: 0, seenMessages: [] };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>';
  const r1 = await tools.creationSaveArtifact({ format: 'svg', content: svg, client_operation_id: 'crt-m-1' }, ctx);
  assert.equal(r1.ok, false, JSON.stringify(r1.output));
  assert.equal(r1.output['error_code'], 'CREATION_MASTER_PENDING', 'M 唯一正本未落正不得 saved（旧实现 ok=true/saved=true）');
  assert.equal((db.prepare("SELECT COUNT(*) n FROM media_assets WHERE creation_operation_id = 'tool-creation:crt-m-1'").get() as { n: number }).n, 1, '资产已保存（落正未确认）');
  // 恢复 M：同键重试只补落正+条目（不重复保存资产）
  fakeM.fail = false;
  const r2 = await tools.creationSaveArtifact({ format: 'svg', content: svg, client_operation_id: 'crt-m-1' }, ctx);
  assert.equal(r2.ok, true, JSON.stringify(r2.output));
  const assetId = (r2.output as { asset_id: string }).asset_id;
  assert.equal(f.media.getAsset(assetId).m_sync_state, 'synced');
  assert.ok((r2.output as { creation_id: string | null }).creation_id, '作品条目补建');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM media_assets WHERE id = ?').get(assetId) as { n: number }).n, 1, '同键重试未产生第二份资产');
});

// —— 包1（2026-11-15）：M04 上游 5xx 分类 / M05 GIF 拼接上限 / M03 默认发布 ——

test('IG-12 (M04): 收到完整 5xx=明确失败可重试——同键重试重新请求上游并成功（不再永久卡 unknown）', async () => {
  let n500 = 0;
  const flaky: ImageGenTransport = async () => {
    if (n500++ === 0) return { status: 500, json: { error: { message: 'upstream exploded' } } };
    return okTransport();
  };
  const f = fixture(flaky);
  const opKey = imageGenOpKey(CTX1, 'op-12');
  const r1 = await f.svc.generateAndStore({ prompt: '画雨', opKey });
  assert.equal(r1.ok, false, JSON.stringify(r1));
  if (!r1.ok) {
    assert.equal(r1.code, 'IMAGEGEN_UPSTREAM_ERROR');
    assert.equal(r1.retryable, true);
    assert.ok(String(r1.detail).includes('upstream exploded'), '脱敏原因透传');
  }
  const st = db.prepare('SELECT state FROM imagegen_operations WHERE op_key=?').get(opKey) as { state: string };
  assert.equal(st.state, 'failed_retryable', '5xx 落可重试失败，不落 unknown');
  const r2 = await f.svc.generateAndStore({ prompt: '画雨', opKey });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  if (r2.ok) assert.equal(r2.generation_call, 'first', '重试真实重新请求上游');
  assert.equal(f.calls(), 2, '同键重试重新调用供应商一次');
});

test('IG-13 (M05): GIF 拼接 sheet 最长边≤3840——必拒组合付费请求前拦截；存在可放拼法的组合不本地拒绝', async () => {
  let calls = 0;
  const counting: ImageGenTransport = async (body, signal) => { calls += 1; return okTransport(body, signal); };
  const adapter = new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'm', transport: counting });
  // 16@1024：任何网格（含 4x4=4096）都超 3840——付费请求前拦截
  const reject = await adapter.generate('x', { format: 'gif', frameCount: 16, frameDurationMs: 100, size: '1024x1024' });
  assert.equal(reject.outcome, 'error');
  if (reject.outcome === 'error') { assert.equal(reject.code, 'IMAGEGEN_PARAM_INVALID'); assert.ok(reject.detail.includes('3840')); }
  assert.equal(calls, 0, '必拒组合不发出付费请求');
  // 8@1024：存在 3x3=3072≤3840 的拼法——本地放行（生产实证供应商仍可能拒，原因由其透传）
  const pass = await adapter.generate('x', { format: 'gif', frameCount: 8, frameDurationMs: 100, size: '1024x1024' });
  assert.equal(pass.outcome, 'ok', '本地只拦"任何拼法都超限"的组合，不编造拼法集合');
  assert.equal(calls, 1);
  const pass2 = await adapter.generate('x', { format: 'gif', frameCount: 8, size: '768x768' });
  assert.equal(pass2.outcome, 'ok');
});

test('IG-14 (M03): 默认交付 send——生成→保存→发布；save_only 不发布；发布失败只补发布不重生成；重放不重复发布（D06）', async () => {
  const { MessageService } = await import('../../apps/host/src/messages/service.ts');
  const messages = new MessageService(db);
  messages.ensureConversation('primary', null);
  const msgCount = (k: string) => (db.prepare('SELECT COUNT(*) n FROM messages WHERE client_message_id = ?').get(k) as { n: number }).n;
  const f = fixture(okTransport, { messages });
  const opKey = imageGenOpKey(CTX1, 'op-14');
  const r1 = await f.svc.generateAndStore({ prompt: '画太阳', opKey, deliver: 'send', roomId: 'primary', turnId: 'turn-1' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  if (r1.ok) assert.ok(r1.published_message_id, '默认交付发布到当前聊天');
  assert.equal(msgCount(`tool-imagegen:${opKey}:publish`), 1, '确定性发布幂等键恰好一条');
  const r2 = await f.svc.generateAndStore({ prompt: '画太阳', opKey, deliver: 'send', roomId: 'primary', turnId: 'turn-1' });
  assert.equal(r2.ok, true);
  if (r1.ok && r2.ok) assert.equal(r2.published_message_id, r1.published_message_id, '重放返回原消息，不再发第二条（D06）');
  assert.equal(f.calls(), 1);
  assert.equal(msgCount(`tool-imagegen:${opKey}:publish`), 1);
  // save_only：不发布
  const opKey2 = imageGenOpKey(CTX1, 'op-14-so');
  const r3 = await f.svc.generateAndStore({ prompt: '画月亮', opKey: opKey2, deliver: 'save_only', roomId: 'primary', turnId: 'turn-1' });
  assert.equal(r3.ok, true);
  if (r3.ok) assert.equal(r3.published_message_id, undefined, '仅保存未发送');
  assert.equal(msgCount(`tool-imagegen:${opKey2}:publish`), 0);
  // 发布失败（messages 未装配的真实形态）→ 已保存+发布失败回执；同键重试（装配后）只补发布
  const opKey3 = imageGenOpKey(CTX1, 'op-14-pf');
  const fNoMsg = fixture(okTransport);
  const r4 = await fNoMsg.svc.generateAndStore({ prompt: '画星星', opKey: opKey3, deliver: 'send', roomId: 'primary', turnId: 'turn-1' });
  assert.equal(r4.ok, false, JSON.stringify(r4));
  if (!r4.ok) {
    assert.equal(r4.code, 'IMAGEGEN_PUBLISH_FAILED');
    assert.equal(r4.retryable, true);
    assert.ok(r4.saved_asset_id, '回执带已保存资产引用');
  }
  assert.equal(fNoMsg.calls(), 1, '生成只发生一次');
  const healed = new ImageGenService({ db, adapter: new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'm', transport: okTransport }), media: fNoMsg.media, contentClient: client, messages });
  const r5 = await healed.generateAndStore({ prompt: '画星星', opKey: opKey3, deliver: 'send', roomId: 'primary', turnId: 'turn-1' });
  assert.equal(r5.ok, true, JSON.stringify(r5));
  if (r5.ok) assert.ok(r5.published_message_id, '补发布成功');
  const row = db.prepare('SELECT state FROM imagegen_operations WHERE op_key = ?').get(opKey3) as { state: string };
  assert.equal(row.state, 'saved');
  assert.equal(msgCount(`tool-imagegen:${opKey3}:publish`), 1, '补发布恰好一条，未重新生成');
});

// —— 包1审计返修（2026-11-15）：P1-c 同键三连 + P1-d 恢复补发布 ——

test('IG-15 (P1-c): 同键异参=IDEMPOTENCY_CONFLICT；并发同键第二个 IN_PROGRESS 只一次外呼；200 头正文断流=结果未确认', async () => {
  const f = fixture(okTransport);
  const opKey = imageGenOpKey(CTX1, 'op-15');
  const r0 = await f.svc.generateAndStore({ prompt: '画海', opKey });
  assert.equal(r0.ok, true);
  // ① 同键不同 prompt（审计复现：save_only 后换 prompt+send 把第一张图发进聊天）→ 冲突，不发布
  const r1 = await f.svc.generateAndStore({ prompt: '另一幅画', opKey, deliver: 'send', roomId: 'primary', turnId: 't' });
  assert.equal(r1.ok, false);
  if (!r1.ok) { assert.equal(r1.code, 'IDEMPOTENCY_CONFLICT'); assert.equal(r1.retryable, false); }
  assert.equal((db.prepare("SELECT COUNT(*) n FROM messages WHERE client_message_id = ?").get(`tool-imagegen:${opKey}:publish`) as { n: number }).n, 0, '冲突路径不发布');
  // 同键同参重放仍原结果
  const r1b = await f.svc.generateAndStore({ prompt: '画海', opKey });
  assert.equal(r1b.ok, true);
  assert.equal(f.calls(), 1);
  // ② 并发同键：慢 transport 下第二个调用进行中拒绝，外呼恰一次
  const slow: ImageGenTransport = async () => { await new Promise((r) => setTimeout(r, 60)); return okTransport(); };
  const f2 = fixture(slow);
  const opKey2 = imageGenOpKey(CTX1, 'op-15b');
  const p1 = f2.svc.generateAndStore({ prompt: '并发画', opKey: opKey2 });
  await new Promise((r) => setImmediate(r)); // 让 p1 走到 transport 等待点（calling 行+ACTIVE 已登记）
  const p2 = await f2.svc.generateAndStore({ prompt: '并发画', opKey: opKey2 });
  assert.equal(p2.ok, false, JSON.stringify(p2));
  if (!p2.ok) { assert.equal(p2.code, 'IMAGEGEN_IN_PROGRESS'); assert.equal(p2.retryable, true); }
  const done = await p1;
  assert.equal(done.ok, true);
  assert.equal(f2.calls(), 1, '并发同键只一次付费外呼');
  // ③ 200 头后正文断流（审计 flavor）：生成可能已成功——结果未确认，同键重试不自动重发
  const trunc: ImageGenTransport = async () => ({ transportError: 'body_truncated', status: 200 });
  const f3 = fixture(trunc);
  const opKey3 = imageGenOpKey(CTX1, 'op-15c');
  const r3 = await f3.svc.generateAndStore({ prompt: '断流画', opKey: opKey3 });
  assert.equal(r3.ok, false, JSON.stringify(r3));
  if (!r3.ok) { assert.equal(r3.code, 'IMAGEGEN_RESULT_UNCONFIRMED'); assert.equal(r3.retryable, false); }
  const st = db.prepare('SELECT state FROM imagegen_operations WHERE op_key=?').get(opKey3) as { state: string };
  assert.equal(st.state, 'unknown', '断流落未确认，不冒充明确失败');
  const r3b = await f3.svc.generateAndStore({ prompt: '断流画', opKey: opKey3 });
  assert.equal(r3b.ok, false);
  assert.equal(f3.calls(), 1, '未确认不自动重发（防重复计费）');
});

test('IG-16 (P1-d): stored→saved 恢复进入同一交付分支——deliver=send 恢复后补发布，不重生成', async () => {
  const { MessageService } = await import('../../apps/host/src/messages/service.ts');
  const messages = new MessageService(db);
  messages.ensureConversation('primary', null);
  const msgCount = (k: string) => (db.prepare('SELECT COUNT(*) n FROM messages WHERE client_message_id = ?').get(k) as { n: number }).n;
  // 快照 503 代理（IG-10 同款）：条目已建、快照读不到 → SNAPSHOT_PENDING（stored 行）
  const proxy = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && (req.url ?? '').includes('/references/')) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'unavailable' } })); return; }
      const opts = { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${server.port}` }, ...(req.method === 'POST' ? { body: raw } : {}) } as RequestInit;
      void fetch(`http://127.0.0.1:${server.port}${req.url}`, opts).then(async (up) => {
        res.writeHead(up.status, { 'Content-Type': 'application/json' });
        res.end(await up.text());
      });
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const failingClient = { baseUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, token: server.token };
    const f = fixture(okTransport);
    const svcFail = new ImageGenService({ db, adapter: new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'm', transport: async (b, s) => okTransport(b, s) }), media: f.media, contentClient: failingClient as never });
    const opKey = imageGenOpKey(CTX1, 'op-16');
    const r1 = await svcFail.generateAndStore({ prompt: '快照期画', opKey, deliver: 'send', roomId: 'primary', turnId: 't16' });
    assert.equal(r1.ok, false, JSON.stringify(r1));
    if (r1.ok) return;
    assert.equal(r1.code, 'IMAGEGEN_SNAPSHOT_PENDING');
    assert.equal(msgCount(`tool-imagegen:${opKey}:publish`), 0, '快照未确认时未发布');
    // 恢复：真 content + messages——同键重试补快照后必须补发布（旧缺陷：直接 ok 且像 save_only）
    const healed = new ImageGenService({ db, adapter: new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'm', transport: okTransport }), media: f.media, contentClient: client, messages });
    const r2 = await healed.generateAndStore({ prompt: '快照期画', opKey, deliver: 'send', roomId: 'primary', turnId: 't16' });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    if (r2.ok) { assert.ok(r2.published_message_id, '恢复进入 saved 后补发布（P1-d）'); assert.equal(r2.generation_call, 'none', '恢复不重新生成'); }
    assert.equal(msgCount(`tool-imagegen:${opKey}:publish`), 1);
  } finally { proxy.close(); }
});

// —— 二轮返修（2026-11-15）：P1-1 旧记录升级不自动发布 / P1-2 URL 恢复 / P2-3 完整错误应答 ——

test('IG-17 (P1-1): 升级存量（无请求指纹）同键重放不自动发布——saved 与 stored 恢复同口径', async () => {
  const { MessageService } = await import('../../apps/host/src/messages/service.ts');
  const messages = new MessageService(db);
  messages.ensureConversation('primary', null);
  const msgCount = (k: string) => (db.prepare('SELECT COUNT(*) n FROM messages WHERE client_message_id = ?').get(k) as { n: number }).n;
  const f = fixture(okTransport, { messages });
  const opKey = imageGenOpKey(CTX1, 'op-17');
  // 先用现行实现做一次真实保存（含指纹与作品条目），再把指纹清空=v72 升级存量的形状
  const r0 = await f.svc.generateAndStore({ prompt: '升级前的原画', opKey, deliver: 'save_only', roomId: 'primary', turnId: 't17' });
  assert.equal(r0.ok, true, JSON.stringify(r0));
  db.prepare('UPDATE imagegen_operations SET request_fingerprint = NULL WHERE op_key = ?').run(opKey);
  // 同键换 prompt、默认 send：旧记录无请求证据——不冲突也不发布，回执给显式发送入口
  const r1 = await f.svc.generateAndStore({ prompt: '另一段提示词', opKey, deliver: 'send', roomId: 'primary', turnId: 't17' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  if (r1.ok) {
    assert.equal(r1.published_message_id, undefined, '无原请求指纹不得补成发布授权');
    assert.ok(r1.note?.includes('chat_send_attachment'), '回执给显式发送入口');
    if (r0.ok) assert.equal(r1.asset_id, r0.asset_id, '原作品仍可定位');
  }
  assert.equal(msgCount(`tool-imagegen:${opKey}:publish`), 0, '新增聊天消息 0');
  assert.equal(f.calls(), 1, '新增生成请求 0（共 1 次=首次那一次）');
  // stored 恢复同口径：把行拨回 stored（快照未确认形状）并清指纹，恢复到 saved 也不发布
  const r2 = await f.svc.generateAndStore({ prompt: '升级前的原画', opKey, deliver: 'send', roomId: 'primary', turnId: 't17' });
  assert.equal(r2.ok, true);
  db.prepare("UPDATE imagegen_operations SET state='stored', result_b64=NULL, request_fingerprint=NULL WHERE op_key = ?").run(opKey);
  const r3 = await f.svc.generateAndStore({ prompt: '升级前的原画', opKey, deliver: 'send', roomId: 'primary', turnId: 't17' });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  if (r3.ok) {
    assert.equal(r3.published_message_id, undefined, 'stored→saved 恢复同样不自动发布');
    assert.ok(r3.note?.includes('旧版本'));
  }
  assert.equal(msgCount(`tool-imagegen:${opKey}:publish`), 0);
  const row = db.prepare('SELECT state FROM imagegen_operations WHERE op_key = ?').get(opKey) as { state: string };
  assert.equal(row.state, 'saved', '恢复仍收口到 saved（保存结果保留）');
});

test('IG-18 (P1-2): 供应商 200+URL-only——就地取回字节成活；取不回落 url_pending，同键重放只重取 URL 不再生成', async () => {
  const { MessageService } = await import('../../apps/host/src/messages/service.ts');
  const messages = new MessageService(db);
  messages.ensureConversation('primary', null);
  const msgCount = (k: string) => (db.prepare('SELECT COUNT(*) n FROM messages WHERE client_message_id = ?').get(k) as { n: number }).n;
  // 结果 URL 服务器：可切换 503/200+PNG 字节
  let urlUp = true;
  const urlServer = http.createServer((req, res) => {
    if (!urlUp) { res.writeHead(503); res.end('down'); return; }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG_FULL);
  });
  await new Promise<void>((resolve) => urlServer.listen(0, '127.0.0.1', resolve));
  const urlPort = (urlServer.address() as { port: number }).port;
  const urlTransport: ImageGenTransport = async () => ({ status: 200, json: { id: 'gen-url', data: [{ url: `http://127.0.0.1:${urlPort}/generated.png` }] } });
  try {
    // ① 取回成功：一次生成调用完成 生成→保存→发布（默认 send）
    const f = fixture(urlTransport, { messages });
    const opKey = imageGenOpKey(CTX1, 'op-18');
    const r1 = await f.svc.generateAndStore({ prompt: 'URL 回包画', opKey, deliver: 'send', roomId: 'primary', turnId: 't18' });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    if (r1.ok) assert.ok(r1.published_message_id, '默认发送照常发布');
    assert.equal(msgCount(`tool-imagegen:${opKey}:publish`), 1, '恰好一条消息');
    assert.equal(f.calls(), 1, '生成请求总数 1');
    // ② 取不回落 url_pending：重放只重取 URL，生成计数不增；URL 恢复后同键收口成功
    const f2 = fixture(urlTransport, { messages });
    const opKey2 = imageGenOpKey(CTX1, 'op-18b');
    urlUp = false;
    const r2 = await f2.svc.generateAndStore({ prompt: 'URL 断取画', opKey: opKey2, deliver: 'send', roomId: 'primary', turnId: 't18b' });
    assert.equal(r2.ok, false, JSON.stringify(r2));
    if (!r2.ok) { assert.equal(r2.code, 'IMAGEGEN_URL_PENDING'); assert.equal(r2.retryable, true); }
    const st = db.prepare('SELECT state, result_url FROM imagegen_operations WHERE op_key=?').get(opKey2) as { state: string; result_url: string };
    assert.equal(st.state, 'url_pending', '落 url_pending（不是 failed_generation）');
    assert.ok(st.result_url, '结果 URL 留存');
    assert.equal(f2.calls(), 1, '生成请求 1');
    // URL 仍挂：同键重放还是 PENDING，仍不生成
    const r2b = await f2.svc.generateAndStore({ prompt: 'URL 断取画', opKey: opKey2, deliver: 'send', roomId: 'primary', turnId: 't18b' });
    assert.equal(r2b.ok, false);
    if (!r2b.ok) assert.equal(r2b.code, 'IMAGEGEN_URL_PENDING', '第二次回执说明只重取 URL、未重新生成');
    assert.equal(f2.calls(), 1, '生成请求总数仍 1');
    assert.equal(msgCount(`tool-imagegen:${opKey2}:publish`), 0, '新增作品前的失败路径不发布');
    // URL 恢复：同键重试 → 取回字节 → 保存+发布，生成仍 1 次
    urlUp = true;
    const r2c = await f2.svc.generateAndStore({ prompt: 'URL 断取画', opKey: opKey2, deliver: 'send', roomId: 'primary', turnId: 't18b' });
    assert.equal(r2c.ok, true, JSON.stringify(r2c));
    if (r2c.ok) assert.ok(r2c.published_message_id);
    assert.equal(f2.calls(), 1, '恢复取回不重新生成');
    assert.equal(msgCount(`tool-imagegen:${opKey2}:publish`), 1);
  } finally { urlServer.close(); }
});

test('IG-19 (P2-3): 完整 429 空正文/502 纯文本=明确错误可重试；200 头后半截 JSON 断流=未确认不重发', async () => {
  // 真实 defaultTransport（不注入 transport）：本机 HTTP 上游切换四种应答形态
  let mode: 'ok' | 'rate429' | 'bad502' | 'trunc200' = 'ok';
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits += 1;
    if (mode === 'rate429') { res.writeHead(429, { 'Content-Length': 0 }); res.end(); return; }
    if (mode === 'bad502') { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Bad Gateway'); return; }
    if (mode === 'trunc200') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"data":[{"b64_js'); res.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'gen-h', data: [{ b64_json: PNG_FULL.toString('base64') }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  const makeAdapter = () => new ImageGenAdapter({ baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'm' });
  const store = new MariposaMediaStore({ baseUrl: fakeM.url, credentialEnv: 'EST_TEST_IMAGEGEN_KEY' });
  const media = new MediaService(db, path.join(root, `media-ig19-${Math.random().toString(36).slice(2, 8)}`), buildConfig({}), store);
  const svc = new ImageGenService({ db, adapter: makeAdapter(), media, contentClient: client });
  try {
    // ① 429 空正文：完整错误应答→RATE_LIMITED 可重试；重试成功后上游累计 2 次
    mode = 'rate429'; hits = 0;
    const k1 = imageGenOpKey(CTX1, 'op-19-429');
    const r1 = await svc.generateAndStore({ prompt: 'x', opKey: k1 });
    assert.equal(r1.ok, false, JSON.stringify(r1));
    if (!r1.ok) { assert.equal(r1.code, 'IMAGEGEN_RATE_LIMITED'); assert.equal(r1.retryable, true); }
    mode = 'ok';
    const r1b = await svc.generateAndStore({ prompt: 'x', opKey: k1 });
    assert.equal(r1b.ok, true, JSON.stringify(r1b));
    assert.equal(hits, 2, '429→重试成功：上游累计 2 次');
    // ② 502 纯文本：完整错误应答→UPSTREAM_ERROR 可重试
    mode = 'bad502'; hits = 0;
    const k2 = imageGenOpKey(CTX1, 'op-19-502');
    const r2 = await svc.generateAndStore({ prompt: 'x', opKey: k2 });
    assert.equal(r2.ok, false, JSON.stringify(r2));
    if (!r2.ok) { assert.equal(r2.code, 'IMAGEGEN_UPSTREAM_ERROR'); assert.equal(r2.retryable, true); }
    assert.equal(hits, 1);
    // ③ 200 头+半截 JSON 后断连：读取中断=未确认；同键重放仍未确认，上游累计 1 次
    mode = 'trunc200'; hits = 0;
    const k3 = imageGenOpKey(CTX1, 'op-19-trunc');
    const r3 = await svc.generateAndStore({ prompt: 'x', opKey: k3 });
    assert.equal(r3.ok, false, JSON.stringify(r3));
    if (!r3.ok) { assert.equal(r3.code, 'IMAGEGEN_RESULT_UNCONFIRMED'); assert.equal(r3.retryable, false); }
    const r3b = await svc.generateAndStore({ prompt: 'x', opKey: k3 });
    assert.equal(r3b.ok, false);
    assert.equal(hits, 1, '未确认不自动重发（上游累计 1 次）');
  } finally { upstream.close(); }
});

test('IG-20：停止信号到达在途生成，仍收到的图片可保存，续调用只补发布', async () => {
  const { MessageService } = await import('../../apps/host/src/messages/service.ts');
  const messages = new MessageService(db);
  messages.ensureConversation('primary', null);
  const controller = new AbortController();
  let dispatched!: (signal: AbortSignal) => void;
  let respond!: () => void;
  const sent = new Promise<AbortSignal>(resolve => { dispatched = resolve; });
  const delivery = new Promise<void>(resolve => { respond = resolve; });
  const f = fixture(async (body, signal) => {
    assert.ok(signal);
    dispatched(signal);
    await delivery;
    return okTransport(body, signal);
  }, { messages });
  const opKey = imageGenOpKey(CTX1, 'op-20');
  const args = { opKey, prompt: '画海', deliver: 'send' as const, roomId: 'primary', turnId: 'original' };
  const pending = f.svc.generateAndStore({ ...args, signal: controller.signal });
  const supplierSignal = await sent;
  controller.abort();
  assert.ok(supplierSignal.aborted);
  respond();
  const stopped = await pending;
  assert.equal(stopped.ok, false);
  if (stopped.ok) return;
  assert.equal(stopped.code, 'IMAGEGEN_PUBLISH_CANCELLED');
  assert.ok(stopped.saved_asset_id);
  const key = `tool-imagegen:${opKey}:publish`;
  assert.equal(db.prepare('SELECT turn_id FROM messages WHERE client_message_id=?').get(key), undefined);
  const resumed = await f.svc.generateAndStore({ ...args, turnId: 'current' });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.asset_id, stopped.saved_asset_id);
  assert.equal(db.prepare('SELECT turn_id FROM messages WHERE client_message_id=?').get(key)?.turn_id, 'current');
  assert.equal(f.calls(), 1);
});
