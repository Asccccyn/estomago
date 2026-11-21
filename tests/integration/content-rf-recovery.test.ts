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

test('RF02B/F2: 中文显式键在同回合和后续回合均核回原帖，异参冲突且换新键独立发帖', async () => {
  const f = await fixture('openrouter');
  const wires: Array<Record<string, unknown>> = [];
  const postKeys: Array<string | null> = [];
  const commands: Array<{ text: string; idempotency_key: string }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      if (String(input) === `http://127.0.0.1:${f.content.port}/api/v1/content/posts` && init?.method === 'POST') {
        postKeys.push(new Headers(init.headers).get('Idempotency-Key'));
        if (postKeys.length === 1) {
          assert.equal(response.status, 201);
          await response.arrayBuffer();
          throw new Error('synthetic commit response lost');
        }
      }
      return response;
    };
    (f.host.runnerSelection as { runner: unknown }).runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, async payload => {
      wires.push(structuredClone(payload));
      const n = wires.length;
      const call = commands.shift();
      const delta = call ? { tool_calls: [{ index: 0, id: `call-${n}`, type: 'function', function: { name: 'content_post_create', arguments: JSON.stringify(call) } }] } : { content: 'synthetic finished' };
      return { status: 200, headers: new Headers(), body: Readable.from([Buffer.from(`data: ${JSON.stringify({ id: `gen-${n}`, choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)]) };
    });
    const original = { text: 'same intended model post', idempotency_key: '测试续轮操作' };
    const send = async (id: string, ...tools: typeof commands) => {
      const before = wires.length;
      commands.push(...tools);
      const user = await f.send('POST', '/api/v1/conversations/primary/messages', { content: 'synthetic model write', client_message_id: id });
      assert.equal(user.status, 201);
      await f.host.supervisor.waitIdle();
      assert.equal(f.host.db.prepare('SELECT state FROM turns WHERE id=?').get(String(user.body.turn_id))?.state, 'completed');
      assert.equal(wires.length - before, tools.length + 1);
      return wires.slice(before + 1).map(w => {
        const msg = (w as { messages: Array<{ role: string; content: string }> }).messages.at(-1)!;
        assert.equal(msg.role, 'tool');
        return JSON.parse(msg.content);
      });
    };

    const [failure, sameTurn] = await send('initial', original, original);
    const [sameKey] = await send('later-turn', original);
    assert.equal(postKeys.length, 1, '两个回合的原键只核回首笔事务');
    assert.match(postKeys[0] ?? '', /^[\x20-\x7e]+$/u, 'Content 请求头必须可安全传输');
    assert.equal(failure.error_code, 'CONTENT_POST_UNKNOWN');
    assert.equal(failure.idempotency_key, original.idempotency_key);
    assert.equal(failure.retryable, true);
    assert.equal(sameKey.id, sameTurn.id);
    const [changed] = await send('changed-args', { ...original, text: 'different content' });
    assert.equal(changed.error_code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(postKeys.length, 1, '同键异参在远端写之前被拒绝');
    const [separate] = await send('separate-operation', { ...original, idempotency_key: '第二个独立操作' });
    assert.notEqual(separate.id, sameTurn.id);
    const posts = f.content.db.prepare('SELECT id FROM feed_posts').all().map(row => row.id);
    assert.deepEqual(new Set(posts), new Set([sameTurn.id, separate.id]));
    assert.equal(postKeys.length, 2);
    assert.notEqual(postKeys[0], postKeys[1]);
  } finally { await f.close(); }
});
