// 相册重构 P3：图片生成两阶段合同（GLM_ALBUM_REFACTOR_EXECUTION 20261108，R12/04 §4）。
// 固定响应 transport（离线）：成功→资产+免桶作品条目；入库失败→重试只走存储
// （transport 计数不增=不二次付费生成）；同 op 重放=saved 原样返回；未配置如实
// UNCONFIGURED；超时 unknown→停在待核实不自动重发。真实远端联调未执行（无 Key，
// 状态如实 BLOCKED）。真实 ContentServer + MediaService。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { ContentServer } from '../../apps/content/src/service.ts';
import { contentClientFor } from '../../apps/host/src/integrations/content/client.ts';
import { ImageGenAdapter, type ImageGenTransport } from '../../apps/host/src/integrations/imagegen/adapter.ts';
import { ImageGenService, imageGenOpKey } from '../../apps/host/src/modules/imagegen/service.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';

// 4x4 红色 PNG（合法魔数）
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 0xff, 'binary')]).subarray(0, 24) as Buffer;
const PNG_FULL = Buffer.from(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]));

let server: ContentServer;
let root: string;
let db: ReturnType<typeof openDatabase>;
let media: MediaService;
let client: ReturnType<typeof contentClientFor>;

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-imagegen-'));
  server = new ContentServer({ stateRoot: path.join(root, 'content'), port, token: 'imagegen-test' });
  await server.start();
  db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  media = new MediaService(db, buildPaths(root).mediaDir, buildConfig({}));
  client = contentClientFor(root, server.port, true);
  process.env.EST_TEST_IMAGEGEN_KEY = 'test-key';
});
after(async () => { await server.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.EST_TEST_IMAGEGEN_KEY; });

function fixture(transport: ImageGenTransport): ImageGenService {
  const adapter = new ImageGenAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_IMAGEGEN_KEY', model: 'gpt-image-2.6-flare', transport });
  return new ImageGenService({ db, adapter, media, contentClient: client });
}
const okTransport = (): { transport: ImageGenTransport; calls: () => number } => {
  let n = 0;
  return { calls: () => n, transport: async () => { n += 1; return { status: 200, json: { id: `gen-${n}`, data: [{ b64_json: PNG_FULL.toString('base64'), revised_prompt: '画好了' }] } }; } };
};
const CTX = { roomId: 'primary', turnId: 'turn-ig', requestId: 'req-ig', toolCallId: 'call-ig' } as const;

test('IG-1: 成功路径——生成 1 次→资产+免桶作品条目；同 op 重放原样返回不再生成', async () => {
  const t = okTransport();
  const svc = fixture(t.transport);
  const opKey = imageGenOpKey(CTX, 'op-1');
  const r = await svc.generateAndStore({ prompt: '画一只小水獭', opKey, title: '水獭' });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(t.calls(), 1);
  assert.equal(r.generation_call, 'first');
  assert.ok(r.creation_id, '自动进入作品（免桶图片作品）');
  assert.equal(r.revised_prompt, '画好了');
  // content：免桶作品 bucket_ref=null、work_kind=image
  const fwd = await fetch(`http://127.0.0.1:${server.port}/api/v1/content/creations/${r.creation_id}`, { headers: { authorization: 'Bearer imagegen-test', 'x-actor': 'jiaming' } });
  const creation = await fwd.json() as { bucket_ref: unknown; work_kind: string; work_asset_id: string };
  assert.equal(fwd.status, 200);
  assert.equal(creation.bucket_ref, null, '免桶图片作品无 bucket_ref');
  assert.equal(creation.work_kind, 'image');
  assert.equal(creation.work_asset_id, r.asset_id);
  // 重放：不再生成、返回同一资产
  const r2 = await svc.generateAndStore({ prompt: '画一只小水獭', opKey, title: '水獭' });
  assert.equal(r2.ok, true);
  if (r2.ok) { assert.equal(r2.asset_id, r.asset_id); assert.equal(r2.generation_call, 'none'); }
  assert.equal(t.calls(), 1, '同 op 重放不得再次调用生成');
});

test('IG-2: 生成成功+入库失败→重试只走存储（transport 计数不增），字节复用不重复计费', async () => {
  const t = okTransport();
  const svc = fixture(t.transport);
  const opKey = imageGenOpKey(CTX, 'op-2');
  // 第一次：media.saveBuffer 注入一次失败（包装真实服务）
  let failOnce = true;
  const flakyMedia = new Proxy(media, { get(target, prop, recv) {
    if (prop === 'saveBuffer') return async (opts: unknown) => { if (failOnce) { failOnce = false; throw new Error('ASSET_STORAGE_UNAVAILABLE: 注入失败'); } return (target.saveBuffer as (o: unknown) => Promise<unknown>)(opts); };
    return Reflect.get(target, prop, recv);
  } }) as MediaService;
  const flakySvc = new ImageGenService({ db, adapter: (svc as unknown as { deps: { adapter: ImageGenAdapter } }).deps.adapter, media: flakyMedia, contentClient: client });
  const fail = await flakySvc.generateAndStore({ prompt: '画晚霞', opKey });
  assert.equal(fail.ok, false);
  if (!fail.ok) { assert.equal(fail.code, 'IMAGEGEN_STORAGE_FAILED'); assert.equal(fail.retryable, true); }
  assert.equal(t.calls(), 1, '生成已成功——入库失败不退回生成');
  const state = db.prepare('SELECT state, result_b64 FROM imagegen_operations WHERE op_key=?').get(opKey) as { state: string; result_b64: string | null };
  assert.equal(state.state, 'generated');
  assert.ok(state.result_b64, '生成字节已暂存（供存储重试复用）');
  // 重试（同一 op、恢复正常 media）：只走存储，不二次生成
  const retry = await svc.generateAndStore({ prompt: '画晚霞', opKey });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(t.calls(), 1, '重试不得再次调用付费生成');
});

test('IG-3: 未配置（adapter=null / Key 缺席）如实 UNCONFIGURED；不伪造成功', async () => {
  const svc = new ImageGenService({ db, adapter: null, media, contentClient: client });
  const r = await svc.generateAndStore({ prompt: 'x', opKey: imageGenOpKey(CTX, 'op-3') });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'IMAGEGEN_UNCONFIGURED');
  // adapter 在而 Key 缺席：configured=false → 同码
  process.env.EST_TEST_IMAGEGEN_KEY = '';
  const svc2 = fixture(async () => ({ status: 200, json: {} }));
  const r2 = await svc2.generateAndStore({ prompt: 'x', opKey: imageGenOpKey(CTX, 'op-3b') });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.code, 'IMAGEGEN_UNCONFIGURED');
  process.env.EST_TEST_IMAGEGEN_KEY = 'test-key';
});

test('IG-4: 超时 unknown→停在待核实；同 op 再调用仍拒绝（不自动重发）', async () => {
  const svc = fixture(async () => ({ transportError: 'timeout' }));
  const opKey = imageGenOpKey(CTX, 'op-4');
  const r = await svc.generateAndStore({ prompt: '画云', opKey });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'IMAGEGEN_RESULT_UNCONFIRMED');
  const r2 = await svc.generateAndStore({ prompt: '画云', opKey });
  assert.equal(r2.ok, false, '结果未确认时同 op 重试继续拒绝（避免重复计费）');
  void PNG;
});

test('IG-5: 网络未送达可安全重试；供应商拒绝如实透传', async () => {
  let n = 0;
  const svc = fixture(async () => { n += 1; return n === 1 ? { transportError: 'network' } : { status: 200, json: { data: [{ b64_json: PNG_FULL.toString('base64') }] } }; });
  const opKey = imageGenOpKey(CTX, 'op-5');
  const r1 = await svc.generateAndStore({ prompt: '画山', opKey });
  assert.equal(r1.ok, false);
  if (!r1.ok) { assert.equal(r1.code, 'IMAGEGEN_NETWORK'); assert.equal(r1.retryable, true); }
  const r2 = await svc.generateAndStore({ prompt: '画山', opKey });
  assert.equal(r2.ok, true, '请求未送达的网络失败可安全重试');
  const rejected = await fixture(async () => ({ status: 400, json: { error: { message: 'prompt too long' } } })).generateAndStore({ prompt: 'x', opKey: imageGenOpKey(CTX, 'op-5b') });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) { assert.equal(rejected.code, 'IMAGEGEN_REQUEST_REJECTED'); assert.match(rejected.detail, /prompt too long/); }
});
