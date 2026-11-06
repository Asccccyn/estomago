// F06/F07 复审反例回归（RF01/RF02/RF03，复审报告 20261106 第三节）。
// 四个用例都走真实 Host/ContentServer/正式 HTTP，故障只注入在传输边界
// （丢响应/断请求）或用真实旧版服务（ef6698b 冻结夹具）产生旧格式回执；
// 不手写业务 SQL、不另造第二个协调器绕过宿主启动路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Host } from '../../apps/host/src/app-context.ts';
import { ContentServer } from '../../apps/content/src/service.ts';
import { ContentServer as OldContentServer } from '../fixtures/legacy-content-service-ef6698b.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { tempRoot, readyRuntimePatch, writeApprovedIdentity } from '../helpers.ts';
const realFetch = globalThis.fetch;

async function fixture(provider: 'mock' | 'openrouter' = 'mock') {
  const root = tempRoot('reaudit-content-'); writeApprovedIdentity(root);
  const content = new ContentServer({ stateRoot: path.join(root, 'content'), port: 0 }); await content.start();
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider }, openrouter: { model: 'anthropic/claude-test-1' }, content: { enabled: true, port: content.port }, deployment: { port: 0 } });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 }); await host.start();
  await new Promise(r => setTimeout(r, 25));
  const base = `http://127.0.0.1:${host.port}`;
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  const send = async (method: string, route: string, body?: unknown, key = 'operation-one') => {
    const r = await realFetch(base + route, { method, headers: { authorization: `Bearer ${token}`, origin: base, 'content-type': 'application/json', 'idempotency-key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  return { host, content, root, send, close: async () => { globalThis.fetch = realFetch; await host.stop(); await content.stop(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('RF01: 启动空批后，周期恢复消费者仍收口运行中的未知提交', async () => {
  const f = await fixture();
  let lost = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      if (String(input) === `http://127.0.0.1:${f.content.port}/api/v1/content/posts` && init?.method === 'POST' && lost++ === 0) {
        assert.equal(response.status, 201); await response.arrayBuffer(); throw new Error('synthetic response lost after real commit');
      }
      return response;
    };
    const write = await f.send('POST', '/api/v1/content/posts', { body: 'synthetic recovery item' });
    assert.equal(write.status, 504);
    assert.equal((f.content.db.prepare('SELECT COUNT(*) n FROM feed_posts').get() as { n: number }).n, 1);
    assert.equal((f.host.db.prepare("SELECT state FROM outbox WHERE target='content.operation'").get() as { state: string }).state, 'unknown_outcome');
    globalThis.fetch = realFetch;
    // 真实宿主 15 秒 timer——不是手动另造协调器的 recoverOnce
    await new Promise(r => setTimeout(r, 15_100));
    const row = f.host.db.prepare("SELECT state,attempt FROM outbox WHERE target='content.operation'").get() as { state: string; attempt: number };
    assert.equal(row?.state, 'acked', '生产周期消费者必须能收口启动空批之后发生的未知提交');
  } finally { await f.close(); }
});

test('RF02A: 本地已接受操作不被同键异参请求改写（远端尚无回执也不行）', async () => {
  const f = await fixture(); let dropped = false;
  try {
    globalThis.fetch = async (input, init) => {
      if (!dropped && String(input) === `http://127.0.0.1:${f.content.port}/api/v1/content/posts` && init?.method === 'POST') {
        dropped = true; throw new Error('synthetic failure before remote receipt');
      }
      return realFetch(input, init);
    };
    const first = await f.send('POST', '/api/v1/content/posts', { body: 'accepted original' });
    assert.equal(first.status, 504); assert.equal(dropped, true);
    assert.equal((f.content.db.prepare('SELECT COUNT(*) n FROM feed_posts').get() as { n: number }).n, 0);
    const saved = f.host.db.prepare("SELECT payload_ref FROM outbox WHERE target='content.operation'").get() as { payload_ref: string };
    assert.equal(JSON.parse(saved.payload_ref).body.body, 'accepted original');
    globalThis.fetch = realFetch;
    const changed = await f.send('POST', '/api/v1/content/posts', { body: 'different command' });
    assert.equal(changed.status, 409, '已接受身份边界必须拒 409，不能由远端尚无回执允许改写');
    assert.equal((f.content.db.prepare('SELECT COUNT(*) n FROM feed_posts').get() as { n: number }).n, 0);
    // 原意图仍在，同参重试走已持久原身份
    const retry = await f.send('POST', '/api/v1/content/posts', { body: 'accepted original' });
    assert.equal(retry.status, 201);
    assert.equal((f.content.db.prepare('SELECT COUNT(*) n FROM feed_posts').get() as { n: number }).n, 1);
    assert.equal((f.content.db.prepare('SELECT body FROM feed_posts').all() as Array<{ body: string }>)[0]!.body, 'accepted original');
  } finally { await f.close(); }
});

test('RF03: 真实旧库迁移的 creation 删除回执不能跨资源路由回放', async () => {
  const root = tempRoot('reaudit-legacy-'); const token = 'synthetic-legacy';
  let old: OldContentServer | undefined = new OldContentServer({ stateRoot: root, port: 0, token });
  let fresh: ContentServer | undefined;
  const call = async (port: number, method: string, route: string, body?: unknown, key = 'legacy-create', rev?: number) => {
    const r = await realFetch(`http://127.0.0.1:${port}/api/v1/content/` + route, { method, headers: { authorization: `Bearer ${token}`, 'x-actor': 'qiaosheng', 'content-type': 'application/json', 'idempotency-key': key, ...(rev ? { 'if-match': `"${rev}"` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  try {
    await old.start();
    const create = await call(old.port, 'POST', 'creations', { bucket_id: 'synthetic', icon_asset_id: 'synthetic-asset' });
    assert.equal(create.status, 201);
    const deleted = await call(old.port, 'DELETE', 'creations/' + (create.body as { id: string }).id, undefined, 'legacy-delete', 1); assert.equal(deleted.status, 200);
    await old.stop(); old = undefined;
    fresh = new ContentServer({ stateRoot: root, port: 0, token }); await fresh.start();
    const id = (create.body as { id: string }).id;
    // 同类型回放保留（13 旧回执的正例）
    const valid = await call(fresh.port, 'DELETE', 'creations/' + id, undefined, 'legacy-delete', 1); assert.equal(valid.status, 200);
    // 跨类型回放必须拒绝：旧删除回执 {id,deleted,asset_ids} 判不出类型≠放行
    const wrong = await call(fresh.port, 'DELETE', 'album-entries/' + id, undefined, 'legacy-delete', 1);
    assert.equal(wrong.status, 409, '旧回执必须有正面资源类型证据才可兼容回放');
  } finally { await old?.stop(); await fresh?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('RF02B: 模型同一业务 key 在续轮请求后仍复用原操作，未知提交不重复发帖', async () => {
  const f = await fixture('openrouter'); let lost = false; const wires: Array<Record<string, unknown>> = [];
  try {
    globalThis.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      if (!lost && String(input) === `http://127.0.0.1:${f.content.port}/api/v1/content/posts` && init?.method === 'POST') {
        assert.equal(response.status, 201); await response.arrayBuffer(); lost = true; throw new Error('synthetic commit response lost');
      }
      return response;
    };
    (f.host.runnerSelection as { runner: unknown }).runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, async payload => {
      wires.push(structuredClone(payload)); const n = wires.length;
      const call = n <= 2;
      const delta = call ? { tool_calls: [{ index: 0, id: `call-${n}`, type: 'function', function: { name: 'content_post_create', arguments: JSON.stringify({ body: 'same intended model post', idempotency_key: 'model-business-once' }) } }] } : { content: 'synthetic finished' };
      return { status: 200, headers: new Headers(), body: Readable.from([Buffer.from(`data: ${JSON.stringify({ id: `gen-${n}`, choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)]) };
    });
    const msg = await f.send('POST', '/api/v1/conversations/primary/messages', { content: 'synthetic model write', client_message_id: 'synthetic-client' });
    assert.equal(msg.status, 201); await f.host.supervisor.waitIdle();
    assert.equal(wires.length, 3); assert.equal(lost, true);
    const messages = (wires[1] as { messages: Array<{ content: string }> }).messages;
    const firstResult = JSON.parse(messages.at(-1)!.content) as { error_code: string };
    assert.equal(firstResult.error_code, 'CONTENT_POST_UNKNOWN', '未知提交以未知文案回给模型，不得伪装普通失败诱导换身份重做');
    const count = (f.content.db.prepare('SELECT COUNT(*) n FROM feed_posts').get() as { n: number }).n;
    assert.equal(count, 1, '模型重试复用原操作身份——provider 请求变化不产生第二个帖子');
  } finally { await f.close(); }
});
