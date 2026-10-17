import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
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
  assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie')!.split(';')[0]!;
});
after(async () => { await host?.stop(); cookie = ''; fs.rmSync(root, { recursive: true, force: true }); });

test('首页、聊天与主页内嵌页都经过既有登录门', async () => {
  for (const route of ['/', '/chat', '/home/scene.html']) {
    const response = await fetch(base + route, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  }
});
test('登录后主页与原React聊天页分别可达，主画板仍固定500×861', async () => {
  const home = await fetch(base + '/', { headers: { Cookie: cookie } });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /width="500" height="861"/);
  assert.match(html, /src="\/home\/scene.html/);
  const chat = await fetch(base + '/chat', { headers: { Cookie: cookie } });
  assert.equal(chat.status, 200);
  assert.match(await chat.text(), /chat-app\.js/);
  const scene = await fetch(base + '/home/scene.html', { headers: { Cookie: cookie } });
  assert.match(await scene.text(), /home-navigation\.js/);
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
    assert.equal(response.status, 404);
  }
});
test('只有头像聊天动作跳转原聊天路由，避免演示toast及其他入口误跳', async () => {
  const source = await (await fetch(base + '/home/home-navigation.js', { headers: { Cookie: cookie } })).text();
  let listener: ((event: any) => void) | undefined;
  const routes: string[] = [];
  vm.runInNewContext(source, { document: { addEventListener(name: string, fn: (event: any) => void) { assert.equal(name, 'home:action'); listener = fn; } }, window: { top: { location: { assign(route: string) { routes.push(route); } } } } });
  let cancelled = false;
  listener!({ detail: { action: 'chat' }, preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true);
  assert.deepEqual(routes, ['/chat']);
  for (const action of ['call', 'calendar', 'album:open']) listener!({ detail: { action }, preventDefault() { throw new Error('other action intercepted'); } });
  assert.deepEqual(routes, ['/chat']);
});
