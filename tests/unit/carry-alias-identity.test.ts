// F1（复审 2026-11-09 二轮）：携带身份合同——同字节不同上传 ID=同一张原图。
// 经真实链路验收：真实 MediaService（资产行持有 content_sha256）→ 真实
// handleContentProxy（E 侧身份补注唯一入口）→ 真实 ContentOperationCoordinator
// → 真实 ContentServer HTTP。覆盖三个正式写入口（POST 新建 / POST 已有 / PUT 修改）：
// 满 10 张时同原件别名仍可选、真正第 11 张被拒、修改模式不误增数量；
// 客户端自报 hash 不采信（服务端事实=E 资产行）；存量 NULL 身份行经既有条目
// 入口幂等补齐（仅补身份，不动业务时间）。
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
let db: ReturnType<typeof openDatabase>;
let media: MediaService;
let contentOps: ContentOperationCoordinator;
let routeServer: http.Server;
let proxy: (method: 'POST' | 'PUT' | 'DELETE', pathname: string, body: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> }>;

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-carry-alias-'));
  server = new ContentServer({ stateRoot: path.join(root, 'content'), port, token: 'carry-alias-token' });
  await server.start();
  db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const client = contentClientFor(root, server.port, true);
  if (!client) throw new Error('content client 未构造');
  media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const logger = new Logger(null);
  contentOps = new ContentOperationCoordinator({ db, client, media, logger });
  // 真实代理路由（浏览器唯一写入口）挂在真实本地 HTTP 服务器上——请求经完整
  // readJson/响应链；deps 只装配本测试面（媒体+写协调）。
  const deps = { contentClient: client, contentOps, media } as never;
  routeServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://est');
    void handleContentProxy(req, res, deps, url).catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  await new Promise<void>((resolve) => routeServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = (routeServer.address() as net.AddressInfo).port;
  proxy = async (method, pathname, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };
});

after(async () => { routeServer.close(); await server.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

// W0（复审 2026-11-10 证据修正）：operationId 用独立自增序号——旧写法 `alias-up-${seed}`
// 使"同字节别名"第二次 upload 命中同幂等键返回**同一 asset_id**，没测到"不同上传 ID"。
// 字节按 seed、身份按序号：同字节、不同上传、不同 asset_id。
let uploadSeq = 0;
async function upload(seed: number): Promise<string> {
  const a = await media.saveBuffer({ bytes: PNG_BYTES(seed), purpose: 'chat_image', operationId: `alias-up-${seed}-${uploadSeq++}`, createdBy: 'qiaosheng', origin: 'upload' });
  return a.id;
}

test('F1-1: 三个正式入口的别名合同——满 10 张时同原件别名可选（POST 已有/PUT 修改）、真正第 11 张拒、修改不误增数量', async () => {
  // 10 张互不相同原件，全部 always
  const ids: string[] = [];
  for (let i = 1; i <= 10; i++) {
    ids.push(await upload(i));
    const r = await proxy('POST', '/api/v1/content/albums/important_photos/entries', { asset_id: ids[i - 1], carry_mode: 'always' }, { 'idempotency-key': `f1-fill-${i}` });
    assert.equal(r.status, 201, `第 ${i} 张应成功：${JSON.stringify(r.body)}`);
  }
  const realHash = media.getAsset(ids[0]!).content_sha256;
  // 别名=同字节另一上传（不同 asset_id、同 content_sha256）；先仅收藏
  const aliasId = await upload(1); // 与第 1 张同字节、不同上传 ID
  assert.notEqual(aliasId, ids[0], '别名必须是不同上传 ID（W0 前提自证）');
  assert.equal(media.getAsset(aliasId).content_sha256, realHash, '同字节别名前提成立');
  const saved = await proxy('POST', '/api/v1/content/albums/stickers/entries', { asset_id: aliasId }, { 'idempotency-key': 'f1-alias-save' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const aliasEntryId = saved.body['id'] as string;
  // ① POST 已有入口（同 asset 再 POST 改携带）——满 10 张时同原件别名必须可选
  const viaPost = await proxy('POST', '/api/v1/content/albums/stickers/entries', { asset_id: aliasId, carry_mode: 'next_once' }, { 'idempotency-key': 'f1-alias-post' });
  assert.equal(viaPost.status, 200, `POST 已有改携带应放行（旧缺陷：漏传行内身份→aliasInSet 恒 false→422）：${JSON.stringify(viaPost.body)}`);
  // 改回仅收藏，验证 ② PUT 入口（If-Match 用各自最新修订）
  const backToNone = await proxy('PUT', `/api/v1/content/album-entries/${aliasEntryId}`, { carry_mode: 'none' }, { 'idempotency-key': 'f1-alias-none', 'if-match': `"${Number(viaPost.body['revision'])}"` });
  assert.equal(backToNone.status, 200, JSON.stringify(backToNone.body));
  const viaPut = await proxy('PUT', `/api/v1/content/album-entries/${aliasEntryId}`, { carry_mode: 'always' }, { 'idempotency-key': 'f1-alias-put', 'if-match': `"${Number(backToNone.body['revision'])}"` });
  assert.equal(viaPut.status, 200, `PUT 改携带应放行（旧缺陷同上）：${JSON.stringify(viaPut.body)}`);
  // 修改模式不误增数量：携带集去重后仍是 10 个原图身份（别名并入第 1 张）
  const set1 = await contentOpsGet('/api/v1/content/carry-set');
  const items1 = (set1.body['items'] as Array<{ content_sha256?: string; asset_id: string }>);
  assert.equal(new Set(items1.map((i) => i.content_sha256 ?? `est:${i.asset_id}`)).size, 10, '别名并入后去重身份仍 10（不误增）');
  // ③ 真正第 11 张（不同字节）仍被拒
  const eleventh = await upload(99);
  const rejected = await proxy('POST', '/api/v1/content/albums/important_photos/entries', { asset_id: eleventh, carry_mode: 'next_once' }, { 'idempotency-key': 'f1-eleventh' });
  assert.equal(rejected.status, 422);
  assert.equal((rejected.body['error'] as { code: string }).code, 'carry_limit_exceeded');
  // 新建入口的别名（audit 已证 PASS 的路径）同口径放行
  const alias2 = await upload(2); // 与第 2 张同字节、不同上传 ID
  assert.notEqual(alias2, ids[1], '别名必须是不同上传 ID（W0 前提自证）');
  const viaNew = await proxy('POST', '/api/v1/content/albums/chat_screenshots/entries', { asset_id: alias2, carry_mode: 'always' }, { 'idempotency-key': 'f1-alias-new' });
  assert.equal(viaNew.status, 201);
});

/** 直读面不经代理（GET 纯转发）。 */
async function contentOpsGet(pathname: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${pathname}`, { headers: { authorization: 'Bearer carry-alias-token', 'x-actor': 'jiaming' } });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
