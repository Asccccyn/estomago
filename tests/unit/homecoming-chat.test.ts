// 独立登录页接入后的聊天生命周期回归。只运行真实产品 JS + 严格 DOM/fetch VM；
// getElementById 不虚构已删除节点，不开服务器、不创建真实 EventSource。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SESSION = '/api/v1/auth/session';
const MESSAGES = '/api/v1/conversations/primary/messages?limit=500&order=latest';
const RUNTIME = '/api/v1/conversations/primary/runtime';
const OLD_IDS = ['login-btn', 'login-panel', 'token-input', 'token-submit', 'login-error'];
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const httpError = (status) => ({ ok: false, status, json: async () => ({}) });
const ready = () => ok({ identity: { state: 'READY' }, runner: { blocked: false } });

function harness({ autoBoot = false } = {}) {
  const html = fs.readFileSync(path.join(REPO, 'apps/web/src/index.html'), 'utf8');
  const nodes = new Map(), requestedIds = [], pending = [], requests = [], sources = [], redirects = [];
  const warnings = [], timers = [];
  function node() {
    let id = '';
    return {
      get id() { return id; },
      set id(value) { if (id) nodes.delete(id); id = value; if (value) nodes.set(value, this); },
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false,
      dataset: {}, style: {}, children: [], listeners: new Map(), scrollTop: 0, scrollHeight: 0,
      addEventListener(type, fn) { this.listeners.set(type, fn); },
      appendChild(child) { this.children.push(child); return child; },
      prepend(child) { this.children.unshift(child); }, before() {},
      querySelector() { return null; }, setAttribute() {},
      focus() {}, close() { this.open = false; }, showModal() { this.open = true; }, onclick: null,
    };
  }
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = node();
    el.id = match[1];
    el.hidden = /\shidden(?:\s|>|=)/.test(match[0]);
  }
  class FakeEventSource {
    url; closed = false; closeCount = 0; onmessage = null; onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.closed = true; this.closeCount++; }
  }
  let uuid = 0;
  const context = vm.createContext({
    console: { warn: (...args) => warnings.push(args[0]), error: (...args) => warnings.push(args[0]) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    URL, crypto: { randomUUID: () => `request-${++uuid}` }, EventSource: FakeEventSource,
    document: {
      body: node(), documentElement: { scrollHeight: 0 },
      getElementById(id) { requestedIds.push(id); return nodes.get(id) ?? null; },
      createElement: node,
    },
    fetch: (url, options) => {
      requests.push({ url, options });
      if (url === '/api/v1/system-alerts/summary') return Promise.resolve(ok({ unread_anomaly_count: 0 }));
      if (url === '/api/v1/runtime-settings') return Promise.resolve(httpError(503));
      return new Promise((resolve, reject) => pending.push({ url, options, resolve, reject }));
    },
    location: { replace: (url) => redirects.push(url), reload() { throw new Error('Unexpected reload'); } },
  });
  const composer = fs.readFileSync(path.join(REPO, 'apps/web/src/composer-logic.js'), 'utf8').replaceAll('export ', '');
  const app = fs.readFileSync(path.join(REPO, 'apps/web/src/app.js'), 'utf8')
    .replace(/^import .*$/m, '')
    .replace(/\nboot\(\);\s*$/, autoBoot ? '\nglobalThis.initialBoot = boot();\n' : '\n');
  vm.runInContext(composer + '\n' + app + '\nglobalThis.probe={state,boot,connectSse,redirectToLogin,composer,draftGuard,send};', context);
  return {
    ...context.probe, initialBoot: context.initialBoot,
    html, nodes, requestedIds, pending, requests, sources, redirects, warnings,
    take(url) {
      const index = pending.findIndex((request) => request.url === url);
      assert.notEqual(index, -1, `Expected pending request: ${url}`);
      return pending.splice(index, 1)[0];
    },
  };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
async function acceptSession(h) {
  const request = h.take(SESSION);
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
  request.resolve(ok({ authenticated: true }));
  await flush();
}
async function acceptMessages(h) {
  h.take(MESSAGES).resolve(ok({ messages: [] }));
  await flush();
}
async function completeBoot(h, running) {
  await acceptSession(h);
  await acceptMessages(h);
  h.take(RUNTIME).resolve(ready());
  await running;
  await flush();
}

test('真实首页 DOM 可自动启动，无旧 token 面板/绑定，未授权时不显示聊天', async () => {
  const h = harness({ autoBoot: true });
  for (const id of OLD_IDS) {
    assert.equal(h.nodes.has(id), false, `${id} must be removed from HTML`);
    assert.equal(h.requestedIds.includes(id), false, `${id} must not be referenced at startup`);
  }
  assert.equal(h.state.authorized, false);
  assert.equal(h.nodes.get('chat').hidden, true);
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0].url, SESSION);
  h.take(SESSION).resolve(httpError(503));
  await h.initialBoot;
  assert.equal(h.nodes.get('retry-connection-btn').hidden, false);
  assert.equal(typeof h.nodes.get('retry-connection-btn').onclick, 'function');
});

test('并发 boot 只恢复一次会话，消息成功后才授权，已启动时不重复 SSE', async () => {
  const h = harness();
  const running = h.boot();
  await h.boot();
  assert.equal(h.pending.length, 1);
  await acceptSession(h);
  assert.equal(h.state.authorized, false);
  assert.equal(h.nodes.get('chat').hidden, true);
  await h.boot();
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0].url, MESSAGES);
  await acceptMessages(h);
  assert.equal(h.state.authorized, true);
  assert.equal(h.nodes.get('chat').hidden, false);
  h.take(RUNTIME).resolve(ready());
  await running;
  const requestCount = h.requests.length;
  await h.boot();
  assert.equal(h.requests.length, requestCount);
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].closed, false);
  assert.equal(h.state.booting, false);
  for (const id of OLD_IDS) assert.equal(h.requestedIds.includes(id), false);
});

test('启动各阶段 401 只跳转独立 /login 一次并关闭 SSE', async () => {
  for (const stage of ['session', 'messages', 'runtime']) {
    const h = harness();
    h.connectSse();
    const source = h.sources[0];
    const running = h.boot();
    if (stage !== 'session') await acceptSession(h);
    if (stage === 'runtime') await acceptMessages(h);
    h.take(stage === 'session' ? SESSION : stage === 'messages' ? MESSAGES : RUNTIME).resolve(httpError(401));
    await running;
    h.redirectToLogin();
    await h.boot();
    assert.deepEqual(h.redirects, ['/login']);
    assert.equal(source.closeCount, 1);
    assert.equal(h.state.sse, null);
    assert.equal(h.state.authorized, false);
    assert.equal(h.state.booting, false);
    assert.equal(h.nodes.get('chat').hidden, true);
    assert.equal(h.pending.length, 0);
  }
});

const failures = [
  { name: 'session 网络中断', stage: 'session', reject: true },
  { name: 'session 503', stage: 'session', response: () => httpError(503) },
  { name: 'messages 503', stage: 'messages', response: () => httpError(503) },
  { name: 'messages JSON 损坏', stage: 'messages', response: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid JSON'); } }) },
  { name: 'messages 返回格式错误', stage: 'messages', response: () => ok({ error: 'unexpected response' }) },
  { name: 'runtime 503', stage: 'runtime', response: () => httpError(503) },
  { name: 'runtime JSON 损坏', stage: 'runtime', response: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid JSON'); } }) },
];
test('网络/503/JSON 失败释放启动锁，可通过按钮重试且保留草稿', async () => {
  for (const failure of failures) {
    const h = harness();
    h.composer.value = '尚未发送的\n草稿';
    h.draftGuard.touch();
    const running = h.boot();
    if (failure.stage !== 'session') await acceptSession(h);
    if (failure.stage === 'runtime') await acceptMessages(h);
    const request = h.take(failure.stage === 'session' ? SESSION : failure.stage === 'messages' ? MESSAGES : RUNTIME);
    if (failure.reject) request.reject(new TypeError('Network unavailable'));
    else request.resolve(failure.response());
    await running;
    assert.equal(h.state.authorized, false, failure.name);
    assert.equal(h.state.booting, false);
    assert.equal(h.state.sse, null);
    assert.deepEqual(h.redirects, []);
    assert.equal(h.nodes.get('retry-connection-btn').hidden, false);
    assert.equal(h.composer.value, '尚未发送的\n草稿');
    h.nodes.get('retry-connection-btn').onclick();
    assert.equal(h.nodes.get('retry-connection-btn').hidden, true);
    await completeBoot(h, undefined);
    assert.equal(h.state.authorized, true);
    assert.equal(h.state.booting, false);
    assert.equal(h.sources.length, 1);
    assert.equal(h.composer.value, '尚未发送的\n草稿');
  }
});

test('SSE error 会话检查单飞；503/网络错误保留连接，明确 401 才跳转', async () => {
  const h = harness();
  h.connectSse();
  const source = h.sources[0];
  const first = source.onerror();
  const repeated = source.onerror();
  assert.equal(first, repeated);
  assert.equal(h.pending.length, 1);
  h.take(SESSION).resolve(httpError(503));
  await first;
  assert.equal(source.closed, false);
  assert.deepEqual(h.redirects, []);
  const offline = source.onerror();
  h.take(SESSION).reject(new TypeError('Network unavailable'));
  await offline;
  assert.equal(source.closed, false);
  assert.deepEqual(h.redirects, []);
  const expired = source.onerror();
  source.onerror();
  assert.equal(h.pending.length, 1);
  h.take(SESSION).resolve(httpError(401));
  await expired;
  source.onerror();
  assert.deepEqual(h.redirects, ['/login']);
  assert.equal(source.closeCount, 1);
  assert.equal(h.sources.length, 1);
  assert.equal(h.pending.length, 0);
});

test('替换 SSE 先关闭旧连接，旧帧/旧会话回包不影响新连接', async () => {
  const h = harness();
  h.connectSse();
  const old = h.sources[0];
  const staleCheck = old.onerror();
  h.connectSse();
  const current = h.sources[1];
  assert.equal(old.closeCount, 1);
  assert.equal(current.closed, false);
  h.take(SESSION).resolve(httpError(401));
  await staleCheck;
  old.onerror();
  old.onmessage({ data: JSON.stringify({ sequence: 99, kind: 'unknown' }) });
  assert.equal(h.state.lastSequence, 0);
  assert.deepEqual(h.redirects, []);
  assert.equal(h.pending.length, 0);
  assert.equal(h.state.sse, current);
  current.onmessage({ data: JSON.stringify({ sequence: 2, kind: 'unknown' }) });
  current.onmessage({ data: JSON.stringify({ sequence: 1, kind: 'unknown' }) });
  assert.equal(h.state.lastSequence, 2);
});
