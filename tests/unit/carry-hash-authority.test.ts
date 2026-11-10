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

async function upload(seed: number): Promise<string> {
  const a = await media.saveBuffer({ bytes: PNG_BYTES(seed), purpose: 'chat_image', operationId: `hash-up-${seed}`, createdBy: 'qiaosheng', origin: 'upload' });
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
