// Execute the production form controller with isolated DOM/fetch doubles; no real credentials or service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../apps/web/src/login/login.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../../apps/web/src/login/index.html', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const response = (status: number, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

function harness() {
  const nodes = new Map<string, any>();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    nodes.set(match[1]!, {
      value: '', textContent: '', disabled: false, attrs: new Map(), handlers: new Map(), valid: true,
      addEventListener(kind, fn) { this.handlers.set(kind, fn); },
      setAttribute(key, value) { this.attrs.set(key, value); },
      removeAttribute(key) { this.attrs.delete(key); },
      reportValidity() { return this.valid; }, focus() {},
    });
  }
  const requests: any[] = [], redirects: string[] = [], events = new Map(), timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id) ?? null },
    window: { addEventListener: (kind, fn) => events.set(kind, fn) },
    location: { replace: (target) => redirects.push(target) },
    fetch: (url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
      options.signal?.addEventListener('abort', () => reject(new Error('aborted fixture')), { once: true });
    }),
    AbortController,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    // Intentionally no storage or logging APIs: a credential must never flow through either.
  });
  vm.runInContext(source, context);
  return {
    nodes, requests, redirects, events, timers,
    submit: () => nodes.get('login-form').handlers.get('submit')({ preventDefault() {} }),
    input: () => nodes.get('login-form').handlers.get('input')(),
  };
}

test('approved form has a display-only owner and no preview controls or placeholder authentication', () => {
  assert.match(html, /id="account"[^>]*value="宿主用户"[^>]*readonly/);
  assert.match(html, /id="password"[^>]*type="password"[^>]*required/);
  assert.doesNotMatch(html, /id="(?:replay|play-pause|seek)"/);
  assert.doesNotMatch(source, /登录服务尚未连接|localStorage|sessionStorage|console\./);
});

test('existing valid session enters home without posting credentials', async () => {
  const h = harness();
  assert.equal(h.requests[0].url, '/api/v1/auth/session');
  assert.equal(h.requests[0].options.cache, 'no-store');
  h.requests[0].resolve(response(200, { authenticated: true }));
  await flush();
  assert.deepEqual(h.redirects, ['/']);
  assert.equal(h.requests.length, 1);
});

test('login posts only the existing token, locks duplicate submits, clears secret then enters home', async () => {
  const h = harness();
  h.requests[0].resolve(response(401));
  await flush();
  h.nodes.get('password').value = ' isolated-test-credential ';
  const pending = h.submit();
  assert.equal(h.nodes.get('login-submit').disabled, true);
  assert.equal(h.nodes.get('login-form').attrs.get('aria-busy'), 'true');
  await h.submit();
  assert.equal(h.requests.length, 2);
  const request = h.requests[1];
  assert.equal(request.url, '/api/v1/auth/login');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(request.options.body), { token: 'isolated-test-credential' });
  request.resolve(response(200, { ok: true }));
  await pending;
  assert.deepEqual(h.redirects, ['/']);
  assert.equal(h.nodes.get('password').value, '');
  assert.equal(h.nodes.get('login-submit').disabled, false);
});

test('wrong credentials, origin denial and server errors remain on the form and allow retry', async () => {
  const h = harness();
  h.requests[0].resolve(response(401));
  await flush();
  h.nodes.get('password').value = 'isolated-test-credential';
  for (const [status, expected] of [[401, '口令不正确'], [403, '登录请求被拒绝'], [503, '暂时连接不上']] as const) {
    const pending = h.submit();
    h.requests.at(-1).resolve(response(status));
    await pending;
    assert.ok(h.nodes.get('login-message').textContent.includes(expected));
    assert.equal(h.nodes.get('login-submit').disabled, false);
    assert.equal(h.nodes.get('login-form').attrs.has('aria-busy'), false);
    assert.deepEqual(h.redirects, []);
    h.input();
    assert.equal(h.nodes.get('login-message').textContent, '');
  }
});

test('failed session lookup or login request does not block a subsequent explicit login', async () => {
  const h = harness();
  h.requests[0].reject(new Error('offline fixture'));
  await flush();
  h.nodes.get('password').value = 'isolated-test-credential';
  const failed = h.submit();
  h.requests.at(-1).reject(new Error('offline fixture'));
  await failed;
  assert.equal(h.nodes.get('login-submit').disabled, false);
  assert.match(h.nodes.get('login-message').textContent, /暂时连接不上/);
  const retry = h.submit();
  h.requests.at(-1).resolve(response(200, { ok: true }));
  await retry;
  assert.deepEqual(h.redirects, ['/']);
});

test('late session lookup cannot override an in-progress submit; bfcache restoration rechecks session', async () => {
  const h = harness();
  h.nodes.get('password').value = 'isolated-test-credential';
  const pending = h.submit();
  h.requests[0].resolve(response(200, { authenticated: true }));
  await flush();
  assert.deepEqual(h.redirects, []);
  h.requests[1].resolve(response(401));
  await pending;
  h.events.get('pageshow')({ persisted: true });
  assert.equal(h.requests[2].url, '/api/v1/auth/session');
  h.requests[2].resolve(response(200, { authenticated: true }));
  await flush();
  assert.deepEqual(h.redirects, ['/']);
});

test('a stalled login times out and releases the form for retry', async () => {
  const h = harness();
  h.requests[0].resolve(response(401));
  await flush();
  h.nodes.get('password').value = 'isolated-test-credential';
  const pending = h.submit();
  const timeout = [...h.timers.values()][0];
  assert.equal(timeout.ms, 15000);
  timeout.fn();
  await pending;
  assert.equal(h.requests[1].options.signal.aborted, true);
  assert.equal(h.nodes.get('login-submit').disabled, false);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.redirects, []);
  assert.match(h.nodes.get('login-message').textContent, /暂时连接不上/);
});

test('empty or invalid password makes no login request; a malformed success cannot fake authentication', async () => {
  const h = harness();
  h.requests[0].resolve(response(401));
  await flush();
  h.nodes.get('password').value = '   ';
  await h.submit();
  assert.equal(h.requests.length, 1);
  h.nodes.get('password').value = 'isolated-test-credential';
  h.nodes.get('login-form').valid = false;
  await h.submit();
  assert.equal(h.requests.length, 1);
  h.nodes.get('login-form').valid = true;
  const pending = h.submit();
  h.requests[1].resolve(response(200, {}));
  await pending;
  assert.deepEqual(h.redirects, []);
  assert.match(h.nodes.get('login-message').textContent, /暂时连接不上/);
});
