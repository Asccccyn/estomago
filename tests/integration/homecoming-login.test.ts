// Homecoming 登录页：隔离 mock Host，只检验静态入口与已有 token/cookie 认证，零真实服务。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { AuthService } from '../../apps/host/src/auth/tokens.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { execFileSync } from 'node:child_process';

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

test('owner sets web credentials, browser sessions change, API pairing remains valid and backup restores the login', async () => {
  const oldCookie = sessionCookie(await login(token));
  const credentials = { username: 'synthetic-owner', password: 'synthetic password one', confirm_password: 'synthetic password one' };
  const update = (headers: Record<string, string>, body = credentials) => fetch(base + '/api/v1/auth/account', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body),
  });
  const session = (cookie: string) => fetch(base + '/api/v1/auth/session', { headers: { Cookie: cookie } });
  assert.equal((await update({})).status, 401);
  assert.equal((await update({ Cookie: oldCookie, Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await update({ Cookie: oldCookie }, { ...credentials, confirm_password: 'different' })).status, 422);
  assert.equal(fs.existsSync(path.join(root, 'config/auth.web.json')), false);
  const saved = await update({ Cookie: oldCookie });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true, configured: true, username: 'synthetic-owner' });
  const newCookie = sessionCookie(saved);
  assert.equal((await session(oldCookie)).status, 401);
  assert.equal((await session(newCookie)).status, 200);
  assert.equal((await session('estomago_session=' + encodeURIComponent('界'.repeat(64)))).status, 401);
  assert.equal((await fetch(base + '/api/v1/auth/account', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  const passwordLogin = (username: string, password: string) => fetch(base + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username, password }),
  });
  assert.equal((await passwordLogin('wrong-owner', credentials.password)).status, 401);
  assert.equal((await passwordLogin(credentials.username, 'wrong-password')).status, 401);
  assert.equal((await passwordLogin(credentials.username, credentials.password)).status, 200);
  const stored = fs.readFileSync(path.join(root, 'config/auth.web.json'), 'utf8');
  assert.ok(!stored.includes(credentials.password), 'password must not be stored in plaintext');
  assert.equal(fs.statSync(path.join(root, 'config/auth.web.json')).mode & 0o777, 0o600);
  const reloaded = new AuthService(buildPaths(root));
  assert.equal(await reloaded.verifyPassword(credentials.username, credentials.password), true);
  const changed = await update({ Authorization: `Bearer ${token}` }, { ...credentials, password: 'synthetic password two', confirm_password: 'synthetic password two' });
  assert.equal(changed.status, 200);
  assert.equal((await session(newCookie)).status, 401);
  assert.equal((await passwordLogin(credentials.username, credentials.password)).status, 401);
  assert.equal(host!.db.prepare('SELECT count(*) n FROM provider_requests').get()?.n, 0);
  const repo = path.resolve(import.meta.dirname, '../..');
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, ESTOMAGO_HOME: root, ESTOMAGO_BACKUP_KEEP: '10000' };
  execFileSync(process.execPath, ['scripts/backup.mjs'], { cwd: repo, env, stdio: 'pipe' });
  const manifest = fs.readdirSync(path.join(root, 'backups')).find(name => name.endsWith('.manifest.json'))!;
  const backup = JSON.parse(fs.readFileSync(path.join(root, 'backups', manifest), 'utf8'));
  assert.ok(backup.meta_files.includes('auth.web.json'));
  const restoredRoot = tempRoot('estomago-account-restore-');
  try {
    execFileSync(process.execPath, ['scripts/restore.mjs', backup.file, '--into', restoredRoot], { cwd: repo, env, stdio: 'pipe' });
    const restored = new AuthService(buildPaths(restoredRoot));
    assert.equal(await restored.verifyPassword(credentials.username, 'synthetic password two'), true);
    assert.equal(restored.verifyToken(token), true);
  } finally { fs.rmSync(restoredRoot, { recursive: true, force: true }); }
});
