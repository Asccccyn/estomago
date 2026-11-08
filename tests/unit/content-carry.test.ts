// 相册重构 P3 携带合同（GLM_ALBUM_REFACTOR_EXECUTION 20261108，03 §7/§8）：
// 三模式读写、跨相册去重计数、CARRY_IMAGE_LIMIT=10 写入校验（第 10 成/第 11 拒）、
// always 优先、consume-next-once 原子消费与幂等。直连 ContentServer HTTP（不起 Host）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { ContentServer } from '../../apps/content/src/service.ts';
import { CARRY_IMAGE_LIMIT } from '../../packages/contracts/src/content.ts';

const TOKEN = 'carry-test-token';
let server: ContentServer;
let base: string;

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-carry-test-'));
  server = new ContentServer({ stateRoot: path.join(root, 'content'), port, token: TOKEN });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});
after(async () => { await server.stop(); });

async function call(method: string, route: string, body?: unknown, key?: string, actor = 'qiaosheng', extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + route, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'x-actor': actor, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}), ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function addEntry(kind: string, assetId: string, carry: string | undefined, key: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return call('POST', `/api/v1/content/albums/${kind}/entries`, { asset_id: assetId, ...(carry ? { carry_mode: carry } : {}) }, key);
}

test('CARRY-1: 创建即携带 + carry-set 读取 + 非法模式拒绝', async () => {
  const a = await addEntry('important_photos', 'asset-c1', 'always', 'k-carry-1');
  assert.equal(a.status, 201);
  assert.equal(a.body['carry_mode'], 'always');
  const set = await call('GET', '/api/v1/content/carry-set');
  assert.equal(set.status, 200);
  assert.equal(set.body['limit'], CARRY_IMAGE_LIMIT);
  const items = set.body['items'] as Array<{ asset_id: string; mode: string }>;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.asset_id, 'asset-c1');
  assert.equal(items[0]!.mode, 'always');
  const bad = await addEntry('stickers', 'asset-c1x', 'forever', 'k-carry-1-bad');
  assert.equal(bad.status, 422);
  assert.equal(bad.body['error']['code'], 'carry_mode_invalid');
});

test('CARRY-2: 跨相册同 asset 去重；always 优先于 next_once', async () => {
  await addEntry('stickers', 'asset-c1', 'next_once', 'k-carry-2a'); // 同 asset 另一相册，next_once
  const set = await call('GET', '/api/v1/content/carry-set');
  const items = set.body['items'] as Array<{ asset_id: string; mode: string }>;
  assert.equal(items.length, 1, '同 asset 跨相册只算一张');
  assert.equal(items[0]!.mode, 'always', 'always 优先');
});

test('CARRY-3: 去重计数上限——第 10 张成功、第 11 张不同 asset 明确拒绝、减选后可再设', async () => {
  // 现有集合 1（asset-c1）；再补 8 张不同 asset 到 9
  for (let i = 2; i <= 9; i++) {
    const r = await addEntry('important_photos', `asset-n${i}`, 'next_once', `k-carry-3-${i}`);
    assert.equal(r.status, 201, `第 ${i} 张应成功`);
  }
  const tenth = await addEntry('important_photos', 'asset-n10', 'next_once', 'k-carry-3-10');
  assert.equal(tenth.status, 201, '第 10 张（去重后恰好满额）应成功');
  const eleventh = await addEntry('stickers', 'asset-n11', 'always', 'k-carry-3-11');
  assert.equal(eleventh.status, 422);
  assert.equal(eleventh.body['error']['code'], 'carry_limit_exceeded');
  // 已在集合内的 asset 再入新相册：新增的是关系不是一张图——集合仍 10、不超限
  const again = await addEntry('chat_screenshots', 'asset-c1', 'next_once', 'k-carry-3-12');
  assert.equal(again.status, 201);
  const setFull = await call('GET', '/api/v1/content/carry-set');
  assert.equal((setFull.body['items'] as unknown[]).length, CARRY_IMAGE_LIMIT, '去重后恰 10，不因跨相册重复计数');
  // 减选一张后第 11 张可入
  const setBefore = await call('GET', '/api/v1/content/carry-set');
  const firstEntry = (setBefore.body['items'] as Array<{ entry_id: string }>)[0]!;
  const cur = await call('GET', `/api/v1/content/albums/important_photos/entries`);
  const target = (cur.body['items'] as Array<{ id: string; asset_id: string; revision: number }>).find((e) => e.asset_id === 'asset-n2')!;
  void firstEntry;
  const del = await call('DELETE', `/api/v1/content/album-entries/${target.id}`, undefined, 'k-carry-3-del', 'qiaosheng', { 'if-match': `"${target.revision}"` });
  assert.equal(del.status, 200);
  const retry = await addEntry('stickers', 'asset-n11', 'always', 'k-carry-3-11b');
  assert.equal(retry.status, 201, '减选后原被拒项可入');
});

test('CARRY-4: consume-next-once 只消费 next_once、不动 always；同键幂等重放原回执', async () => {
  const c1 = await call('POST', '/api/v1/content/carry-set/consume-next-once', {}, 'k-consume-1', 'jiaming');
  assert.equal(c1.status, 200);
  assert.ok((c1.body['consumed'] as number) >= 1, '至少消费了 next_once 条目');
  const set = await call('GET', '/api/v1/content/carry-set');
  for (const it of set.body['items'] as Array<{ mode: string }>) {
    assert.equal(it.mode, 'always', '消费后集合里只剩 always');
  }
  // 同键重放=原回执；新键重跑 consumed=0（状态已收敛）
  const replay = await call('POST', '/api/v1/content/carry-set/consume-next-once', {}, 'k-consume-1', 'jiaming');
  assert.equal(replay.status, 200);
  assert.equal(replay.body['consumed'], c1.body['consumed'], '同键重放回放原回执');
  const fresh = await call('POST', '/api/v1/content/carry-set/consume-next-once', {}, 'k-consume-2', 'jiaming');
  assert.equal(fresh.body['consumed'], 0);
  // before 过滤（P5 §7.4）：只消费该时刻之前设置的 next_once——投递后新设项不被补消费误吞
  await addEntry('stickers', 'asset-late1', 'next_once', 'k-carry-late');
  const pastConsume = await call('POST', '/api/v1/content/carry-set/consume-next-once', { before: '2000-01-01T00:00:00.000Z' }, 'k-consume-3', 'jiaming');
  assert.equal(pastConsume.body['consumed'], 0, '早于一切设置的 before 不消费任何项');
  const nowConsume = await call('POST', '/api/v1/content/carry-set/consume-next-once', { before: new Date().toISOString() }, 'k-consume-4', 'jiaming');
  assert.equal((nowConsume.body['consumed'] as number) >= 1, true, '含新设项的 before 正常消费');
});

test('CARRY-5: PUT 修改 carry_mode 走 If-Match 与上限校验', async () => {
  const created = await addEntry('stickers', 'asset-put1', 'none', 'k-carry-5');
  assert.equal(created.body['carry_mode'], 'none');
  const id = created.body['id'] as string;
  const rev = created.body['revision'] as number;
  // 缺 If-Match 按既有合同 428
  const noMatch = await call('PUT', `/api/v1/content/album-entries/${id}`, { carry_mode: 'next_once' }, 'k-carry-5-a');
  assert.equal(noMatch.status, 428);
  // 带 If-Match 成功改携带；caption 一并可改
  const put = await call('PUT', `/api/v1/content/album-entries/${id}`, { carry_mode: 'next_once', caption: 'char的话' }, 'k-carry-5-b', 'qiaosheng', { 'if-match': `"${rev}"` });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body['carry_mode'], 'next_once');
  assert.equal(put.body['caption'], 'char的话');
  // 只改 caption 不动携带：集合计数不受影响，且 carry_mode 保持
  const put2 = await call('PUT', `/api/v1/content/album-entries/${id}`, { caption: '改后的留言' }, 'k-carry-5-c', 'qiaosheng', { 'if-match': `"${put.body['revision']}"` });
  assert.equal(put2.status, 200);
  assert.equal(put2.body['carry_mode'], 'next_once');
  assert.equal(put2.body['caption'], '改后的留言');
});
