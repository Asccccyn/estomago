// Real Chrome + real isolated Host smoke. Build apps/web/react first.
// node tests/cross-project/system-alerts-browser.mjs --playwright=/path/to/playwright
//   --chrome=/path/to/chrome --output=/path/to/synthetic-evidence
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { guardCheck } from '../../scripts/test-guard.mjs';

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const split = arg.indexOf('='); return [arg.slice(2, split), arg.slice(split + 1)];
}));
assert.ok(options.playwright && options.chrome && options.output,
  '--playwright, --chrome and --output are required');
const guard = guardCheck();
assert.ok(guard.ok, 'Use a credential-free environment and temporary ESTOMAGO_HOME');
assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
assert.ok(process.env.ESTOMAGO_HOME, 'Explicit isolated root required');
const { Host } = await import('../../apps/host/src/app-context.ts');
const { buildConfig } = await import('../../apps/host/src/config/schema.ts');
const { tempRoot, writeApprovedIdentity, readyRuntimePatch } = await import('../helpers.ts');
const { chromium } = createRequire(import.meta.url)(options.playwright);
const root = tempRoot('estomago-alerts-browser-');
writeApprovedIdentity(root);
const config = buildConfig({ deployment: { port: 0 }, ...readyRuntimePatch(),
  runtime: { ...readyRuntimePatch().runtime, provider: 'mock' } });
const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
let browser;
try {
  await host.start(); // Loopback-only ephemeral port; closed below.
  const base = `http://127.0.0.1:${host.port}`;
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  browser = await chromium.launch({ executablePath: options.chrome, headless: true, timeout: 15000,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps'] });
  const context = await browser.newContext({ viewport: { width: 980, height: 850 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const login = await context.request.post(base + '/api/v1/auth/login', { data: { token }, headers: { Origin: base } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '系统异常，0 条未读，0 项待处理' }).waitFor();

  host.alerts.observe({ code: 'BOOTSTRAP_INCOMPLETE', scopeKind: 'integration', scopeId: 'mariposa',
    dedupeKey: 'bootstrap:synthetic-browser-window', observationId: null,
    safeSummary: { title: '部分开窗资料未载全',
      detail: '只缺心情文字，已保留同快照核验过的 I 和计划。',
      reason: 'BOOTSTRAP_PAGE_TRANSPORT', window_id: 'synthetic-browser-window',
      action_taken: 'retained_verified_sections', retryable: true, count: 1 } });
  const notification = page.getByRole('button', { name: '系统异常，1 条未读，1 项待处理' });
  await notification.waitFor();
  assert.equal(await notification.locator('[data-testid="system-alert-dot"]').count(), 1);
  await notification.click();
  const dialog = page.getByRole('dialog', { name: '系统异常' });
  await dialog.getByText('只缺心情文字，已保留同快照核验过的 I 和计划。').waitFor();
  assert.match(await dialog.innerText(), /待处理 · 警告/);
  fs.mkdirSync(options.output, { recursive: true });
  await page.screenshot({ path: path.join(options.output, 'system-alert-warning.png'), animations: 'disabled' });

  await dialog.getByRole('button', { name: '将已显示记录标为已读' }).click();
  await page.getByRole('button', { name: '系统异常，0 条未读，1 项待处理' }).waitFor();
  assert.equal(await page.locator('[data-testid="system-alert-dot"]').count(), 0);
  assert.match(await dialog.innerText(), /待处理 · 警告/);
  assert.equal(host.alerts.summary('qiaosheng').open_count, 1);

  host.alerts.resolve('bootstrap:synthetic-browser-window', { summary: {
    title: '开窗资料已恢复', detail: '本窗口已完成完整快照验证。',
    action_taken: 'snapshot_verified_complete', window_id: 'synthetic-browser-window' } });
  await dialog.getByText('本窗口已完成完整快照验证。').waitFor();
  await page.getByRole('button', { name: '系统异常，0 条未读，0 项待处理' }).waitFor();
  assert.match(await dialog.innerText(), /已恢复 · 警告/);
  await page.screenshot({ path: path.join(options.output, 'system-alert-resolved.png'), animations: 'disabled' });

  host.alerts.observe({ code: 'BOOTSTRAP_INCOMPLETE', severity: 'critical', scopeKind: 'integration', scopeId: 'mariposa',
    dedupeKey: 'bootstrap:synthetic-other-window', observationId: null,
    safeSummary: { title: '开窗资料无法验证', detail: 'I 未能通过验证，本次开窗停止。',
      action_taken: 'bootstrap_blocked', reason: 'BOOTSTRAP_I_INVALID' } });
  await dialog.getByText('I 未能通过验证，本次开窗停止。').waitFor();
  assert.match(await dialog.innerText(), /待处理 · 严重/);
  await page.screenshot({ path: path.join(options.output, 'system-alert-critical.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  const requests = host.db.prepare('SELECT COUNT(*) n FROM provider_requests').get().n;
  const messages = host.db.prepare('SELECT COUNT(*) n FROM messages').get().n;
  assert.equal(requests, 0); assert.equal(messages, 0);
  console.log(JSON.stringify({ ok: true, chrome: true, http_sse: true,
    flows: ['unread_dot', 'independent_drawer', 'read_not_resolved', 'recovery', 'critical'],
    page_errors: errors.length, provider_requests: requests, messages, screenshots: 3 }));
} finally {
  await browser?.close();
  await host.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
