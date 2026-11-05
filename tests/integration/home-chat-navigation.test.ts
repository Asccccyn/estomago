import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { HOME_STATIC_FILES } from '../../apps/host/src/server/home-assets.ts';

const root = tempRoot('estomago-home-chat-');
process.env.ESTOMAGO_HOME = root;
process.env.ESTOMAGO_TEST_MODE = '1';
writeApprovedIdentity(root);
let host: Host | undefined;
let base = '', cookie = '';
before(async () => {
  const config = buildConfig({ deployment: { port: 0 }, ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'mock' } });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token }) });
  assert.equal(response.status, 200, '/api/v1/auth/login');
  cookie = response.headers.get('set-cookie')!.split(';')[0]!;
});
after(async () => { await host?.stop(); cookie = ''; fs.rmSync(root, { recursive: true, force: true }); });

test('首页、聊天与保留的主页内嵌页都经过既有登录门', async () => {
  for (const route of ['/', '/chat', '/home/scene.html']) {
    const response = await fetch(base + route, { redirect: 'manual' });
    assert.equal(response.status, 302, route);
    assert.equal(response.headers.get('location'), '/login', route);
  }
});
test('登录后四季主页直接加载全屏画布，聊天与许愿星页面分别可达', async () => {
  const home = await fetch(base + '/', { headers: { Cookie: cookie } });
  assert.equal(home.status, 200, '/');
  const html = await home.text();
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /\/home\/seasons\.css/);
  assert.match(html, /\/home\/seasons\.js/);
  assert.match(html, /\/home\/home-navigation\.js/);
  assert.doesNotMatch(html, /<iframe\b/);
  const chat = await fetch(base + '/chat', { headers: { Cookie: cookie } });
  assert.equal(chat.status, 200, '/chat');
  assert.match(await chat.text(), /chat-app\.js/);
  const wishes = await fetch(base + '/wishstar', { headers: { Cookie: cookie } });
  assert.equal(wishes.status, 200, '/wishstar');
  assert.match(await wishes.text(), /许愿星/);
});
test('所有主页白名单资源可取，未知文件及目录逃逸被拒绝', async () => {
  for (const [route, asset] of HOME_STATIC_FILES) {
    const response = await fetch(base + route, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('content-type'), asset.type);
    assert.ok((await response.arrayBuffer()).byteLength > 0, route);
  }
  for (const route of ['/home/README.md', '/home/config/auth.token', '/home/%2e%2e%2fconfig/auth.token']) {
    const response = await fetch(base + route, { headers: { Cookie: cookie } });
    assert.equal(response.status, 404, route);
  }
});
test('已接页面通过真实导航脚本跳转，其余四季入口保留事件接口', async () => {
  const source = await (await fetch(base + '/home/home-navigation.js', { headers: { Cookie: cookie } })).text();
  const document = new EventTarget();
  const routes: string[] = [];
  vm.runInNewContext(source, { document, window: { top: { location: { assign(route: string) { routes.push(route); } } } } });
  for (const action of ['chat', 'wishes']) {
    const event = new CustomEvent('home:action', { detail: { action }, cancelable: true });
    assert.equal(document.dispatchEvent(event), false);
  }
  assert.deepEqual(routes, ['/chat', '/wishstar']);
  const pending = [
    { action: 'calendar', season: 'spring' },
    { action: 'reading', season: 'summer' },
    { action: 'anniversaries', season: 'summer' },
    { action: 'moments', season: 'autumn' },
    { action: 'album', season: 'winter', subject: 'otter' },
    { action: 'voice', season: 'winter' },
    { action: 'upstairs', season: 'winter' },
  ];
  const received: unknown[] = [];
  document.addEventListener('home:action', event => received.push((event as CustomEvent).detail));
  for (const detail of pending) {
    assert.equal(document.dispatchEvent(new CustomEvent('home:action', { detail, cancelable: true })), true);
  }
  assert.deepEqual(received, pending);
  assert.deepEqual(routes, ['/chat', '/wishstar']);

  const intercepted = new CustomEvent('home:action', { detail: { action: 'wishes' }, cancelable: true });
  intercepted.preventDefault();
  document.dispatchEvent(intercepted);
  assert.deepEqual(routes, ['/chat', '/wishstar']);
});
