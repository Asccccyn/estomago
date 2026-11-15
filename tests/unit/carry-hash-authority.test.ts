// F1（复审 2026-11-09 二轮）：携带身份的服务端事实与存量回补（空集合起步，与
// carry-alias-identity.test.ts 的满额场景互补）。经真实代理路由（身份补注唯一
// 入口）+ 真实协调器 + 真实 ContentServer：hash 由 E 资产行确定（客户端自报
// 不采信）；存量 NULL 身份行经既有条目入口幂等补齐（仅补身份，不动 carry_mode）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { ContentServer } from '../../apps/content/src/service.ts';
import { contentClientFor } from '../../apps/host/src/integrations/content/client.ts';
import { ContentOperationCoordinator } from '../../apps/host/src/integrations/content/coordinator.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { handleContentProxy } from '../../apps/host/src/server/routes/content.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

const PNG_BYTES = (seed: number): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, seed)]);

let server: ContentServer;
let root: string;
let media: MediaService;
let routeServer: http.Server;
let proxyFn: (method: 'POST' | 'PUT' | 'DELETE', pathname: string, body: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> }>;

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-carry-hash-'));
  server = new ContentServer({ stateRoot: path.join(root, 'content'), port, token: 'carry-hash-token' });
  await server.start();
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const client = contentClientFor(root, server.port, true);
  if (!client) throw new Error('content client 未构造');
  media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const logger = new Logger(null);
  const contentOps = new ContentOperationCoordinator({ db, client, media, logger });
  // 真实代理路由挂真实本地 HTTP 服务器（同生产 handler 链）
  const deps = { contentClient: client, contentOps, media } as never;
  routeServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://est');
    void handleContentProxy(req, res, deps, url).catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  await new Promise<void>((resolve) => routeServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = (routeServer.address() as net.AddressInfo).port;
  proxyFn = async (method, pathname, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${pathname}`, {
      method, headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };
});

after(async () => { routeServer.close(); await server.stop(); fs.rmSync(root, { recursive: true, force: true }); });

// W0（复审 2026-11-10 证据修正）：操作键用独立自增序号——同 seed 再上传=不同上传 ID
// （旧写法 `hash-up-${seed}` 会使同字节"别名"复用同一资产，测不到不同 ID 场景）。
let uploadSeq = 0;
async function upload(seed: number): Promise<string> {
  const a = await media.saveBuffer({ bytes: PNG_BYTES(seed), purpose: 'chat_image', operationId: `hash-up-${seed}-${uploadSeq++}`, createdBy: 'qiaosheng', origin: 'upload' });
  return a.id;
}

test('F1-2: hash 是服务端事实——客户端自报的另一套身份不采信（覆盖）', async () => {
  const a = await upload(21);
  const real = media.getAsset(a).content_sha256;
  const fake = 'f'.repeat(64);
  const r = await proxyFn('POST', '/api/v1/content/albums/important_photos/entries', { asset_id: a, carry_mode: 'always', content_sha256: fake }, { 'idempotency-key': 'f1-fake-hash' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const set = await fetch(`http://127.0.0.1:${server.port}/api/v1/content/carry-set`, { headers: { authorization: 'Bearer carry-hash-token', 'x-actor': 'jiaming' } });
  const items = ((await set.json() as Record<string, unknown>)['items'] as Array<{ asset_id: string; content_sha256?: string }>);
  const item = items.find((i) => i.asset_id === a);
  assert.equal(item?.content_sha256, real, '入库身份=E 资产行（客户端假值被覆盖，不只在本填时补）');
});

test('F1-3: 存量 NULL 身份行经既有条目入口补齐——仅补身份，不动 carry_mode', async () => {
  const asset = await upload(31);
  const realHash = media.getAsset(asset).content_sha256;
  // 直连 content 造一行无身份的携带行（模拟 v7 前存量：不经代理=无 E 补注）
  const raw = await fetch(`http://127.0.0.1:${server.port}/api/v1/content/albums/important_photos/entries`, {
    method: 'POST', headers: { authorization: 'Bearer carry-hash-token', 'x-actor': 'qiaosheng', 'content-type': 'application/json', 'idempotency-key': 'f1-legacy-raw' },
    body: JSON.stringify({ asset_id: asset, carry_mode: 'always' }),
  });
  assert.equal(raw.status, 201);
  const setBefore = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/content/carry-set`, { headers: { authorization: 'Bearer carry-hash-token', 'x-actor': 'jiaming' } })).json() as { items: Array<{ asset_id: string; content_sha256?: string; mode: string }> };
  const legacy = setBefore.items.find((i) => i.asset_id === asset);
  assert.ok(legacy, '存量行在携带集');
  assert.equal(legacy!.content_sha256, undefined, '前提：行内无身份（按 asset 计）');
  assert.equal(legacy!.mode, 'always');
  // E 侧对账补身份=同入口再 POST 一次带真实 hash（supervisor.resolveWindowCarry 同链）
  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/content/albums/important_photos/entries`, {
    method: 'POST', headers: { authorization: 'Bearer carry-hash-token', 'x-actor': 'jiaming', 'content-type': 'application/json', 'idempotency-key': 'f1-backfill' },
    body: JSON.stringify({ asset_id: asset, content_sha256: realHash }),
  });
  assert.equal(res.status, 200, '既有条目幂等返回（duplicate）');
  const setAfter = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/content/carry-set`, { headers: { authorization: 'Bearer carry-hash-token', 'x-actor': 'jiaming' } })).json() as { items: Array<{ asset_id: string; content_sha256?: string; mode: string }> };
  const backfilled = setAfter.items.find((i) => i.asset_id === asset);
  assert.equal(backfilled?.content_sha256, realHash, '身份已补齐（后续限额按原图归并）');
  assert.equal(backfilled?.mode, 'always', '仅补身份——carry_mode 不动');
});

test('W1: 旧仅收藏 NULL 身份行改携带——代理 PUT 先按 E 资产行补身份再算十张（别名不误拒）；自报 hash 被覆盖', async () => {
  const carrySetItems = async () => ((await (await fetch(`http://127.0.0.1:${server.port}/api/v1/content/carry-set`, { headers: { authorization: 'Bearer carry-hash-token', 'x-actor': 'jiaming' } })).json()) as { items: Array<{ asset_id: string; content_sha256?: string; mode: string }> }).items;
  // 满 10 张互不相同原件（本文件 F1-2/F1-3 已各留 1 张携带行——共享 DB，再补 8 张），
  // 全部 always（经真实代理 POST——身份由代理补注）
  for (let i = 1; i <= 8; i++) {
    const a = await upload(i);
    const r = await proxyFn('POST', '/api/v1/content/albums/important_photos/entries', { asset_id: a, carry_mode: 'always' }, { 'idempotency-key': `w1-fill-${i}` });
    assert.equal(r.status, 201, `i=${i} ${JSON.stringify(r.body)}`);
  }
  // 两条旧"仅收藏"行：与第 1/2 张同字节的不同上传 ID、直连 content 建（无 E 补注=无身份）
  const alias1 = await upload(1);
  const alias2 = await upload(2);
  const mkLegacy = async (assetId: string, key: string): Promise<{ id: string; revision: number }> => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/content/albums/important_photos/entries`, {
      method: 'POST', headers: { authorization: 'Bearer carry-hash-token', 'x-actor': 'qiaosheng', 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ asset_id: assetId }),
    });
    assert.equal(res.status, 201);
    const b = await res.json() as { id: string; revision: number };
    return b;
  };
  const leg1 = await mkLegacy(alias1, 'w1-legacy-1');
  const leg2 = await mkLegacy(alias2, 'w1-legacy-2');
  const before = await carrySetItems();
  assert.equal(before.filter((i) => i.asset_id === alias1)[0], undefined, '前提：仅收藏行不在携带集');
  // ① 旧行改携带（浏览器 PUT：只带 carry_mode；自报假 hash 必须被代理覆盖）——满 10 张下
  // 旧缺陷=422（NULL 身份按 asset 计数）；W1=先补身份再算上限→别名放行
  const fake = 'e'.repeat(64);
  const put1 = await proxyFn('PUT', `/api/v1/content/album-entries/${leg1.id}`, { carry_mode: 'always', content_sha256: fake }, { 'idempotency-key': 'w1-put-1', 'if-match': `"${leg1.revision}"` });
  assert.equal(put1.status, 200, `旧收藏改携带应放行（W1：先补身份再算十张）：${JSON.stringify(put1.body)}`);
  // ② 无自报 hash 的普通 PUT 同样放行且补真实身份
  const put2 = await proxyFn('PUT', `/api/v1/content/album-entries/${leg2.id}`, { carry_mode: 'always' }, { 'idempotency-key': 'w1-put-2', 'if-match': `"${leg2.revision}"` });
  assert.equal(put2.status, 200, JSON.stringify(put2.body));
  // 语义核验：身份=真实 hash（假值被覆盖）；去重身份仍 10（别名并入原件，不误增）
  const after = await carrySetItems();
  const a1 = after.find((i) => i.asset_id === alias1);
  const a2 = after.find((i) => i.asset_id === alias2);
  assert.equal(a1?.content_sha256, media.getAsset(alias1).content_sha256, '补齐身份=E 资产行事实（自报假值被覆盖）');
  assert.equal(a2?.content_sha256, media.getAsset(alias2).content_sha256, '无自报值同样按 E 资产行补齐');
  assert.equal(new Set(after.map((i) => i.content_sha256 ?? `est:${i.asset_id}`)).size, 10, '别名并入后去重身份仍 10');
});

test('M07（包1 2026-11-15 宿主用户裁定）：同资产新键=修改既有条目——caption 显式替换/空串清空/省略保留；修改不占携带名额', async () => {
  const assetId = (await media.saveBuffer({ bytes: PNG_BYTES(90), purpose: 'chat_image', operationId: 'm07-op-90', createdBy: 'qiaosheng', origin: 'upload' })).id;
  const post = async (key: string, body: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/content/albums/important_photos/entries`, {
      method: 'POST', headers: { authorization: 'Bearer carry-hash-token', 'x-actor': 'qiaosheng', 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const c1 = await post('m07-k1', { asset_id: assetId, caption: '当时的原话', meaning: '我的说明' });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  const entryId = c1.body['id'] as string;
  // 新键+空串 caption=删除留言；meaning 省略=保留原值
  const c2 = await post('m07-k2', { asset_id: assetId, caption: '' });
  assert.equal(c2.status, 200, '同资产=既有条目身份，不新建');
  assert.equal(c2.body['id'], entryId);
  assert.equal(c2.body['caption'], '', '空串=清空留言');
  assert.equal(c2.body['meaning'], '我的说明', '省略=保留原值');
  // 新键无实际变化（carry 同值、caption 省略）→ 不推进修订、不清留言
  // （携带名额满 10 场景下改携带的边界由本文件 W1/F1 用例覆盖，此处不重复灌集合）
  const c3 = await post('m07-k3', { asset_id: assetId, carry_mode: 'none' });
  assert.equal(c3.status, 200, JSON.stringify(c3.body));
  assert.equal(c3.body['carry_mode'], 'none');
  assert.equal(c3.body['caption'], '', '省略=保留清空后的值');
  assert.equal(c3.body['revision'], c2.body['revision'], '无实际变化不推进修订');
  // 新键+新 caption=替换
  const c4 = await post('m07-k4', { asset_id: assetId, caption: '新原话' });
  assert.equal(c4.body['caption'], '新原话');
  assert.ok(Number(c4.body['revision']) > Number(c3.body['revision']), '实际替换推进修订');
  // 同键同指纹重放=原回执，不推进修订
  const c5 = await post('m07-k4', { asset_id: assetId, caption: '新原话' });
  assert.equal(c5.status, 200);
  assert.equal(c5.body['revision'], c4.body['revision'], '同键重放不重复执行');
});
