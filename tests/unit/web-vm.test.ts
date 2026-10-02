// 二轮前端回归（受控 DOM/fetch VM，跑产品 JS 源码；非浏览器/输入法设备验收）：
//  - IME 合成期对普通发送/修订/pending 重试统一零请求（上轮反例：重试绕过 composing 守卫）
//  - compositionend 后同 key 同内容重试恢复
//  - route.resolved(edit) 携带 message 跨端吸收（旧 revision 不覆盖新 revision）
//  - approve 点击不发请求（无已验证继续动作）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function harness() {
  const nodes = new Map(), pendingFetches = [], timers = [], warnings = [];
  function node() {
    return {
      value: '', textContent: '', hidden: false, disabled: false, open: false, dataset: {}, children: [],
      addEventListener() {}, appendChild(n) { this.children.push(n); }, prepend(n) { this.children.unshift(n); },
      querySelector() { return null; }, focus() {}, close() { this.open = false; }, showModal() { this.open = true; },
      onclick: null,
    };
  }
  let uuid = 0;
  const context = vm.createContext({
    console: { warn: (...v) => warnings.push(v[0]), error: (...v) => warnings.push(v[0]) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cancelled: false }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    URL, crypto: { randomUUID: () => `id-${++uuid}` },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node },
    fetch: (url, options) => new Promise((resolve) => pendingFetches.push({ url, options, resolve })),
    location: { reload() {} },
  });
  const composer = fs.readFileSync(path.join(REPO, 'apps/web/src/composer-logic.js'), 'utf8').replaceAll('export ', '');
  const app = fs.readFileSync(path.join(REPO, 'apps/web/src/app.js'), 'utf8').replace(/^import .*$/m, '').replace(/\nboot\(\);\s*$/, '\n');
  vm.runInContext(composer + '\n' + app + '\nglobalThis.probe={state,composer,draftGuard,send,handleEvent,refreshSendButton,absorbMessage};', context);
  return { ...context.probe, pending: pendingFetches, nodes, timers, warnings };
}

const ok200 = (body) => ({ ok: true, status: 200, json: async () => body });
const msg = (id, text, revision = 1) => ({ id, turn_id: 'turn-a', speaker: 'owner', revision: { revision, content: text, occurred_at: '2026-10-02T00:00:00Z' } });
const payload = (p) => JSON.parse(p.options.body);
const snapshot = (h) => ({ composer: h.composer.value, pendingSend: h.state.pendingSend ? { ...h.state.pendingSend } : null, buttonDisabled: h.nodes.get('send-btn').disabled });

test('IME 合成期：pending 重试零请求；compositionend 后同 key 同内容重试恢复', async () => {
  const h = harness();
  h.composer.value = 'RETRY-ME';
  h.draftGuard.touch();
  h.refreshSendButton();
  const first = h.send();
  h.pending[0]!.resolve({ ok: false, status: 503 });
  await first;
  const failedKey = h.state.pendingSend.requestId;
  // 进入 IME 合成期
  h.state.composing = true;
  h.refreshSendButton();
  assert.equal(h.nodes.get('send-btn').disabled, true, '合成期按钮必须禁用');
  const before = h.pending.length;
  await h.send();
  assert.equal(h.pending.length, before, '合成期重试不得产生任何请求');
  // compositionend 后重试恢复
  h.state.composing = false;
  h.composer.value = '';
  h.refreshSendButton();
  assert.equal(h.nodes.get('send-btn').disabled, false, '合成期结束后有待重试项按钮可用');
  const retry = h.send();
  assert.equal(h.pending.length, before + 1, '恢复后重试产生请求');
  assert.equal(payload(h.pending.at(-1)!).client_message_id, failedKey, '同幂等键');
  assert.equal(payload(h.pending.at(-1)!).content, 'RETRY-ME', '同内容');
  h.pending.at(-1)!.resolve(ok200({ message: msg('b', 'RETRY-ME') }));
  await retry;
  assert.equal(h.state.pendingSend, null, '成功后 pending 清空');
});

test('IME 合成期：普通发送与修订同样零请求', async () => {
  const h = harness();
  h.state.composing = true;
  h.composer.value = '普通内容';
  h.refreshSendButton();
  const n = h.pending.length;
  await h.send();
  assert.equal(h.pending.length, n, '合成期普通发送零请求');
  // 修订路径
  h.state.pendingRouteEdit = { decisionId: 'd1', messageId: 'm1', original: 'x' };
  await h.send();
  assert.equal(h.pending.length, n, '合成期修订发送零请求');
});

test('跨端修订：route.resolved 携带 message → 按 ID+revision 吸收，旧事件不回退', () => {
  const h = harness();
  h.absorbMessage(msg('a', '旧内容', 1));
  h.handleEvent({ kind: 'route.resolved', turn_id: 'turn-a', decision_id: 'D', choice: 'edit', message: msg('a', '修订内容', 2) });
  assert.equal(h.state.messages.get('a').revision.content, '修订内容', '新 revision 被吸收');
  assert.equal(h.state.messages.get('a').revision.revision, 2);
  // 迟到的旧事件（无 message 或旧 revision）不回退
  h.handleEvent({ kind: 'route.resolved', turn_id: 'turn-a', decision_id: 'D-old', choice: 'edit' });
  assert.equal(h.state.messages.get('a').revision.content, '修订内容', '无 message 的旧事件不影响');
});

test('approve 点击：不发任何请求（票据不被触碰）', async () => {
  const h = harness();
  h.handleEvent({ kind: 'route.pending', turn_id: 'turn-a', decision_id: 'A' });
  const before = h.pending.length;
  await h.nodes.get('route-approve').onclick();
  assert.equal(h.pending.length, before, 'approve 不得发出请求');
  assert.ok(h.nodes.get('route-detail').textContent.includes('暂不可用'), '点击前可见不支持说明');
  assert.equal(h.state.routePending.decisionId, 'A', '票据保持待决');
});
