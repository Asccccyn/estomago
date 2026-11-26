// F06/F07 第二轮复审反例回归（RF2-01/RF2-02，20261106 第二轮复审第三节）。
// 共同不变式：原操作事实不能被后一次传输错误覆盖；被接受的提交必须有有效保护。
// - RF2-01：content 已真实 commit、响应丢失后，同键重试遇鉴权失败（服务换 token 重启）
//   ——401 只说明本次未获准，不证明原操作未提交：意图保持 unknown、pin 不释放、资产不可删。
// - RF2-02：失败意图按现有合同重开（同键纠正参数）——重开即重新接受，必须重新取得
//   有效 pin：重开后真实 commit 再丢响应，资产仍不可删（旧实现 pin 停留 released）。
// 全程真实 Host/ContentServer/正式 HTTP；故障只注入传输边界；不手写业务 SQL。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Host } from '../../apps/host/src/app-context.ts';
import { ContentServer } from '../../apps/content/src/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { tempRoot, readyRuntimePatch, writeApprovedIdentity } from '../helpers.ts';
const realFetch = globalThis.fetch;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

async function fixture() {
  const root = tempRoot('rf2-protect-'); writeApprovedIdentity(root);
  const port = await freePort();
  const stateRoot = path.join(root, 'content');
  const mkServer = (token: string) => new ContentServer({ stateRoot, port, token });
  let content = mkServer('synthetic-token-a'); await content.start();
  const config = buildConfig({ ...readyRuntimePatch(), content: { enabled: true, port }, deployment: { port: 0 } });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 }); await host.start();
  await new Promise(r => setTimeout(r, 25));
  const base = `http://127.0.0.1:${host.port}`;
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  const send = async (method: string, route: string, body?: unknown, key?: string) => {
    const r = await realFetch(base + route, { method, headers: { authorization: `Bearer ${token}`, origin: base, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const uploadAsset = async (suffix: string): Promise<string> => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const r = await realFetch(`${base}/api/v1/assets?purpose=chat_image`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: base, 'content-type': 'image/png', 'idempotency-key': `rf2-asset-${suffix}` }, body: new Uint8Array(png) });
    assert.equal(r.status, 201);
    return ((await r.json()) as { asset_id: string }).asset_id;
  };
  return {
    host, get content() { return content; },
    send, uploadAsset,
    restartContentWithNewToken: async () => { await content.stop(); content = mkServer('synthetic-token-b'); await content.start(); },
    intentState: (key: string) => (host.db.prepare("SELECT state FROM outbox WHERE target='content.operation' AND operation_key=?").get(`content:qiaosheng:${key}`) as { state: string } | undefined)?.state,
    pinState: (assetId: string, key: string) => (host.db.prepare("SELECT state FROM asset_external_refs WHERE asset_id=? AND owner_id=? AND operation_id=?").get(assetId, `content:qiaosheng:${key}`, `content:qiaosheng:${key}`) as { state: string } | undefined)?.state,
    close: async () => { await host.stop(); await content.stop(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('RF2-01：未知提交的重试遇鉴权失败——原操作保持未决保护，资产不可删', async () => {
  const f = await fixture();
  try {
    const a = await f.uploadAsset('a');
    let lost = false;
    globalThis.fetch = async (input, init) => {
      const r = await realFetch(input, init);
      if (!lost && String(input).includes('/api/v1/content/posts') && init?.method === 'POST') {
        lost = true; await r.arrayBuffer(); throw new Error('synthetic response lost after real commit');
      }
      return r;
    };
    const w1 = await f.send('POST', '/api/v1/content/posts', { body: 'rf2-01 post', asset_ids: [a] }, 'rf2-01-key');
    globalThis.fetch = realFetch;
    assert.equal(w1.status, 504, '真实 commit 后丢响应=未知');
    assert.equal((f.content.db.prepare('SELECT COUNT(*) n FROM feed_posts').get() as { n: number }).n, 1, '业务已提交');
    assert.equal(f.intentState('rf2-01-key'), 'unknown_outcome');
    // 服务换 token 重启（同数据根/同端口）：宿主旧凭据的重试真实得到 401
    await f.restartContentWithNewToken();
    const retry = await f.send('POST', '/api/v1/content/posts', { body: 'rf2-01 post', asset_ids: [a] }, 'rf2-01-key');
    assert.notEqual(retry.status, 200, '重试不应被当成功回执');
    assert.equal(f.intentState('rf2-01-key'), 'unknown_outcome', 'RF2-01：鉴权失败≠原操作未提交——意图保持未决');
    // 保护仍在：资产 DELETE 409（旧实现 intent failed + pin released → 200）
    const del = await f.send('DELETE', `/api/v1/assets/${encodeURIComponent(a)}`, undefined, 'rf2-01-del');
    assert.equal(del.status, 409, '未决操作的 pin 不因重试鉴权失败而释放');
  } finally { globalThis.fetch = realFetch; await f.close(); }
});

test('RF2-02：失败意图重开重新取得有效 pin——重开后真实 commit 再丢响应，资产仍不可删', async () => {
  const f = await fixture();
  try {
    const a = await f.uploadAsset('b');
    // 第一次：work_kind 非法 → content 422（业务未提交），意图 failed、pin released
    const bad = await f.send('POST', '/api/v1/content/creations', { bucket_id: 'bk-rf2', icon_asset_id: a, work_asset_id: a, work_kind: 'bogus' }, 'rf2-02-key');
    assert.equal(bad.status, 422);
    assert.equal(f.intentState('rf2-02-key'), 'failed');
    assert.equal((f.content.db.prepare('SELECT COUNT(*) n FROM creations').get() as { n: number }).n, 0, '无业务对象');
    // 调用方纠正 work_kind 后原键重试（现有合同允许重开）——重开必须重新取得保护
    let lost = false;
    globalThis.fetch = async (input, init) => {
      const r = await realFetch(input, init);
      if (!lost && String(input).includes('/api/v1/content/creations') && init?.method === 'POST') {
        lost = true; await r.arrayBuffer(); throw new Error('synthetic response lost after real commit');
      }
      return r;
    };
    const retry = await f.send('POST', '/api/v1/content/creations', { bucket_id: 'bk-rf2', icon_asset_id: a, work_asset_id: a, work_kind: 'image' }, 'rf2-02-key');
    globalThis.fetch = realFetch;
    assert.equal(retry.status, 504, '重开后的真实 commit 丢响应=未知');
    assert.equal((f.content.db.prepare('SELECT COUNT(*) n FROM creations').get() as { n: number }).n, 1, '业务已提交');
    assert.equal(f.intentState('rf2-02-key'), 'unknown_outcome');
    assert.equal(f.pinState(a, 'rf2-02-key'), 'protected', 'RF2-02：重开重新取得有效 pin（旧实现停留 released）');
    const del = await f.send('DELETE', `/api/v1/assets/${encodeURIComponent(a)}`, undefined, 'rf2-02-del');
    assert.equal(del.status, 409, '被接受且未收口的提交资产不可删');
  } finally { globalThis.fetch = realFetch; await f.close(); }
});
