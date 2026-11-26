// Real Chrome + real isolated Host + real built frontend smoke：浮现记忆前端闭环。
// 她 2026-10-24 裁定（浮现实机验收④）：前端确实显示本次浮现；展开能看分类/心情/
// 我们的话/关系/原文；展开沿本次 memory_ref 读取、不重新发起检索。
// Build apps/web/react first（system-alerts-browser 同款前置）。
// node tests/cross-project/surfacing-browser.mjs --playwright=/path/to/playwright-core
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
process.env.ESTOMAGO_MOCK_SCENARIO = 'consistent'; // 真 turn：mock 流完整收口，气泡带 turnId

const { Host } = await import('../../apps/host/src/app-context.ts');
const { buildConfig } = await import('../../apps/host/src/config/schema.ts');
const { tempRoot, writeApprovedIdentity, readyRuntimePatch } = await import('../helpers.ts');
const { chromium } = createRequire(import.meta.url)(options.playwright);

const root = tempRoot('estomago-surfacing-browser-');
writeApprovedIdentity(root);
const config = buildConfig({ deployment: { port: 0 }, ...readyRuntimePatch(),
  runtime: { ...readyRuntimePatch().runtime, provider: 'mock' } });
const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
let browser;
try {
  // 浮现数据注入（真实链路已由 surfacing-core/seam/detail-http 验收；本 smoke 职责=DOM 渲染
  // 与交互闭环）。visibleMemoriesForTurn=AC015 形状（memory_ref/date/text，无内部字段）。
  const SURFACE = { memory_ref: 'sf_dom_1', kind: 'words', title: '记忆库建成', mood_tags:['开心','期待'], date: '2026-07-09', text: '记忆库在那天建成。', our_words: [{speaker:'char',text:'我们做到了'},{speaker:'宿主用户',text:'这一句也存着'}] };
  const RAW = { memory_ref: 'sf_dom_raw', kind: 'words', date: '2026-07-09', speaker: 'char', text: '我们周末见。',
    context: '宿主用户(2026-07-09 21:30)：是说周六，不是周日。\nchar(2026-07-09 21:31)：好，我周六等你。' };
  let captureRawTurn = false;
  let rawTurn = '';
  host.surfacing.visibleMemoriesForTurn = (_room, turn) => turn ? [turn === rawTurn ? RAW : SURFACE] : [];
  const reads = [];
  host.surfacing.readMemoryForTurn = async (_room, _turn, ref, cursor, section) => {
    reads.push({ ref, cursor: cursor ?? null, section });
    if (ref !== SURFACE.memory_ref) return { ok: false, code: 'DETAIL_REF_NOT_SEEN', message: 'not seen' };
    if (section === 'relations') return { ok: true, data: { relations: [
      { relation_type: 'same_day', direction: 'in', target: { title: '结婚纪念日' }, text: '同一天也是我们的结婚纪念日' },
    ] } };
    if (section === 'source') return { ok: true, data: { source: [
      { conversation_title: '私聊', speaker: 'qiaosheng', display_speaker: '宿主用户', occurred_at: '2026-07-09 21:30', text: '我们把记忆库建成了' },
    ] } };
    // memory 分节：首页含全部字段+next_cursor，次页终页（验"继续读取"翻页）
    if (!cursor) return { ok: true, data: { date: '2026-07-09', title: '记忆库建成',
      text: '记忆库在那天建成。', categories: ['sweet', 'milestone'],
      mood: { tags: ['开心', '期待'], text: '那一天我们都很开心' },
      our_words: [{ speaker: 'jiaming', display_speaker: 'char', text: '我们做到了' }, { speaker: 'qiaosheng', display_speaker: '宿主用户', text: '这一句也存着' }], next_cursor: 'p1' } };
    return { ok: true, data: { date: '2026-07-09', title: '记忆库建成',
      text: SURFACE.text, changed_since_surface: false } };
  };
  // 哨兵：记录全部 turn 派发（不阻断）——展开浮现不得触发任何新检索/新回合
  const realEnqueue = host.supervisor.enqueue.bind(host.supervisor);
  const enqueued = [];
  host.supervisor.enqueue = (id) => { enqueued.push(id); if (captureRawTurn) rawTurn = id; return realEnqueue(id); };

  await host.start();
  const base = `http://127.0.0.1:${host.port}`;
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  browser = await chromium.launch({ executablePath: options.chrome, headless: true, timeout: 15000,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps'] });
  const context = await browser.newContext({ viewport: { width: 980, height: 850 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const login = await context.request.post(base + '/api/v1/auth/login', { data: { token }, headers: { Origin: base } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto(base + '/chat', { waitUntil: 'domcontentloaded' });
  // 真 turn：发送一条消息（mock consistent 流完整收口，助手气泡带 turnId）
  const composer = page.getByRole('textbox', { name: '回复消息' });
  await composer.waitFor();
  await composer.fill('还记得我们建记忆库那天吗');
  const enqueuedBefore = enqueued.length;
  await page.getByRole('button', { name: '发送' }).click();

  // 浮现区块挂载即拉取且默认展开（2026-10-22 她要求）
  const surfacePanel = page.getByRole('button', { name: 'char想起了一段往事', exact: true });
  await surfacePanel.waitFor();
  const panel = page.getByText('char：我们做到了', {exact:true});
  await panel.waitFor();
  await page.getByRole('heading', { name: '记忆库建成', exact:true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '当时的聊天前后文' }).count(), 0);
  await page.getByText('当时的心情：开心、期待', {exact:true}).waitFor();
  assert.ok(enqueued.length > enqueuedBefore, '消息真实进入宿主 turn 链');
  await page.getByText('命中我们的话 · 2026-07-09', {exact:true}).waitFor();
  const enqueuedBeforeDetail = enqueued.length;
  fs.mkdirSync(options.output, { recursive: true });
  await page.screenshot({ path: path.join(options.output, 'surfacing-list.png'), animations: 'disabled', fullPage: true });

  // 展开详情：分类/心情/我们的话；翻页（next_cursor → 继续读取 → 终页）
  await page.getByRole('button', { name: '查看详情' }).click();
  await page.getByText('记忆库建成').first().waitFor();
  await page.getByText('sweet · milestone').waitFor();
  await page.getByText('开心 · 期待').waitFor();
  await page.getByText('那一天我们都很开心').waitFor();
  await page.getByRole('heading', { name: '我们的话', exact: true }).waitFor();
  await page.getByText('宿主用户：这一句也存着', {exact:true}).waitFor();
  assert.equal(await page.getByText('char：我们做到了', {exact:true}).count(), 1);
  await page.getByRole('button', { name: '继续读取' }).click();
  await page.getByText('这条记忆在浮现后有更新，下面是当前内容。').waitFor({ state: 'detached' }).catch(() => {});
  await page.screenshot({ path: path.join(options.output, 'surfacing-detail.png'), animations: 'disabled', fullPage: true });

  // 关系与原文分节
  await page.getByRole('button', { name: '查看关系' }).click();
  await page.getByText('same_day · 指向这条记忆 · 结婚纪念日').waitFor();
  await page.getByText('同一天也是我们的结婚纪念日').waitFor();
  await page.getByRole('button', { name: '查看绑定原文' }).click();
  await page.getByText('私聊 · 宿主用户 2026-07-09 21:30').waitFor();
  await page.getByText('我们把记忆库建成了', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(options.output, 'surfacing-source.png'), animations: 'disabled', fullPage: true });

  // 展开零重检索：全部读取为 detail 端点（沿 memory_ref），无新 turn 派发
  assert.equal(enqueued.length, enqueuedBeforeDetail, '展开/翻页不触发新回合');
  assert.ok(reads.every(r => r.ref === SURFACE.memory_ref), '全部详情读取沿本次 memory_ref');
  assert.ok(reads.some(r => r.cursor === 'p1'), '翻页游标真实传递');

  const readsBeforeRaw = reads.length;
  captureRawTurn = true;
  await composer.fill('请查看周末见那句话和前后文');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByText('char：我们周末见。', { exact: true }).waitFor();
  const rawSection = page.getByRole('heading', { name: '当时的聊天前后文', exact: true }).locator('..');
  const neighbor = rawSection.locator('p');
  assert.equal(await neighbor.textContent(), RAW.context);
  assert.equal(await neighbor.evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap');
  assert.equal(enqueued.length, enqueuedBeforeDetail + 1);
  assert.equal(reads.length, readsBeforeRaw, '已投递的邻句从本轮列表直接展示');
  assert.equal(errors.length, 0, `页面零 JS 错误（${errors.join('; ')}）`);
  console.log('[surfacing-browser] PASS：列表默认展开、原文邻句与署名、详情三区、翻页游标、零重检索；reads=' + JSON.stringify(reads.map(r => r.section + (r.cursor ? '+cursor' : ''))));
} finally {
  delete process.env.ESTOMAGO_MOCK_SCENARIO;
  if (browser) await browser.close().catch(() => {});
  await host.stop().catch(() => {});
}
