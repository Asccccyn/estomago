// Homecoming 登录页：隔离 mock Host，只检验静态入口与已有 token/cookie 认证，零真实服务。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

const root = tempRoot('estomago-homecoming-login-');
const previousHome = process.env.ESTOMAGO_HOME;
process.env.ESTOMAGO_HOME = root;
process.env.ESTOMAGO_TEST_MODE = '1';
writeApprovedIdentity(root);
let host: Host | undefined;
let base = '';
let token = '';

before(async () => {
  const config = buildConfig({
    deployment: { port: 0 },
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'mock' },
  });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  assert.equal(host.runnerSelection.status, 'ok');
  if (host.runnerSelection.status === 'ok') assert.equal(host.runnerSelection.runner.kind, 'mock');
});

after(async () => {
  await host?.stop();
  token = '';
  if (previousHome === undefined) delete process.env.ESTOMAGO_HOME;
  else process.env.ESTOMAGO_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function login(candidate: unknown, origin: string | undefined = base): Promise<Response> {
  return fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ token: candidate }),
  });
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  // Boolean assertions deliberately avoid printing the session token on failure.
  assert.ok(Boolean(cookie), '登录应设置会话 cookie');
  assert.ok(Boolean(cookie?.includes('; HttpOnly')), 'cookie 应为 HttpOnly');
  assert.ok(Boolean(cookie?.includes('; SameSite=Strict')), 'cookie 应为 SameSite=Strict');
  return cookie!.split(';', 1)[0]!;
}

test('未登录根入口进入独立 /login，允许清单内所有动效资源具有正确 MIME', async () => {
  const entry = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get('location'), '/login');
  assert.equal(entry.headers.get('cache-control'), 'no-store');

  const files: Array<[string, string]> = [
    ['/login', 'text/html; charset=utf-8'],
    ...['player.css', 'login.css'].map((file): [string, string] => [`/login/${file}`, 'text/css; charset=utf-8']),
    ...['player.js', 'cord.js', 'scene.js', 'journey.js', 'animation.js', 'login.js'].map((file): [string, string] => [`/login/${file}`, 'text/javascript; charset=utf-8']),
    ['/login/assets/pinky-cels-original.png', 'image/png'],
    ['/login/assets/welcome-original-lettering.svg', 'image/svg+xml'],
    ['/login/assets/promise-handwriting.woff2', 'font/woff2'],
    ['/app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'text/css; charset=utf-8'],
    ['/chat-app.js', 'text/javascript; charset=utf-8'],
    ['/chat-app.css', 'text/css; charset=utf-8'],
    ['/composer-logic.js', 'text/javascript; charset=utf-8'],
  ];
  for (const [file, type] of files) {
    const response = await fetch(`${base}${file}`);
    assert.equal(response.status, 200, `${file} 应可在登录前加载`);
    assert.equal(response.headers.get('content-type'), type, `${file} MIME`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), file === '/login' ? 'no-store' : 'no-cache');
    assert.ok((await response.arrayBuffer()).byteLength > 0, `${file} 不应为空`);
  }
});

test('未知登录资源与编码的上级目录请求拒绝，不泄漏磁盘路径、源码或凭证', async () => {
  const forbidden = [
    '/login/index.html',
    '/login/assets/not-shipped.png',
    '/login/assets/promise-handwriting-source.txt',
    '/login/%2e%2e%2fconfig/auth.token',
    '/login/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fhost/src/server/http.ts',
    '/login/assets/..%5c..%5cconfig/auth.token',
  ];
  for (const file of forbidden) {
    const response = await fetch(`${base}${file}`);
    assert.equal(response.status, 404, `${file} 应不在白名单中`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body, { error: { code: 'not_found', message: '静态资源不存在' } });
  }
});

test('session 经过认证门；错误、空或错误类型 token 均不产生会话 cookie', async () => {
  const unauthenticated: Array<Record<string, string>> = [{}, { Cookie: 'estomago_session=invalid-fixture' }];
  for (const headers of unauthenticated) {
    const response = await fetch(`${base}/api/v1/auth/session`, { headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { error: { code: 'unauthorized', message: '需要认证' } });
  }
  for (const candidate of ['wrong-fixture', '', null, 123]) {
    const response = await login(candidate);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { error: { code: 'unauthorized', message: 'token 不正确' } });
  }
});

test('有效 token 登录只返回成功状态；HttpOnly cookie 通过 session 门并进入原聊天页', async () => {
  const response = await login(token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true });
  const cookie = sessionCookie(response);

  const session = await fetch(`${base}/api/v1/auth/session`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await session.json(), { authenticated: true });

  const chat = await fetch(`${base}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('content-type'), 'text/html; charset=utf-8');
  await chat.arrayBuffer();

  const alreadyHome = await fetch(`${base}/login`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(alreadyHome.status, 302);
  assert.equal(alreadyHome.headers.get('location'), '/');
  assert.equal(alreadyHome.headers.get('cache-control'), 'no-store');
});

test('恶意或 null Origin 不可换取 cookie；无 Origin 的既有脚本登录与 Bearer 认证保留', async () => {
  for (const origin of ['https://untrusted.invalid', 'null']) {
    const response = await login(token, origin);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { error: { code: 'bad_origin', message: 'Origin 校验失败' } });
  }
  const compatible = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  });
  assert.equal(compatible.status, 200);
  sessionCookie(compatible);
  assert.deepEqual(await compatible.json(), { ok: true });

  const bearer = await fetch(`${base}/api/v1/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(bearer.status, 200);
  assert.deepEqual(await bearer.json(), { authenticated: true });
});
