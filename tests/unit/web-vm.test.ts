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
  function node(tagName = 'div') {
    const attributes = new Map(), listeners = new Map();
    let text = '', markup = '';
    return {
      tagName: tagName.toUpperCase(), value: '', hidden: false, disabled: false, open: false,
      dataset: {}, style: {}, children: [], parentNode: null, className: '', scrollTop: 0, scrollHeight: 0,
      get textContent() { return text + this.children.map((child) => child.textContent).join(''); },
      set textContent(value) { this.replaceChildren(); text = String(value); markup = ''; },
      get innerHTML() { return markup; },
      set innerHTML(value) { this.replaceChildren(); markup = String(value); text = ''; },
      get firstChild() { return this.children[0] ?? null; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      hasAttribute(name) { return attributes.has(name); },
      removeAttribute(name) { attributes.delete(name); },
      addEventListener(type, listener) { const list = listeners.get(type) ?? []; list.push(listener); listeners.set(type, list); },
      removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener)); },
      appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; },
      prepend(child) { child.remove(); child.parentNode = this; this.children.unshift(child); },
      insertBefore(child, anchor) { child.remove(); const index = this.children.indexOf(anchor); child.parentNode = this; this.children.splice(index < 0 ? this.children.length : index, 0, child); return child; },
      replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; text = ''; markup = ''; for (const child of children) this.appendChild(child); },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; },
      querySelector(selector) {
        const message = selector.match(/^\[data-message-id="([^"]+)"\]$/);
        for (const child of this.children) {
          if (message ? child.dataset.messageId === message[1] : selector.startsWith('.') && child.className.split(/\s+/).includes(selector.slice(1))) return child;
          const nested = child.querySelector(selector);
          if (nested) return nested;
        }
        return null;
      },
      focus() {}, close() { this.open = false; }, showModal() { this.open = true; }, onclick: null,
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
  h.handleEvent({ kind: 'route.resolved', turn_id: 'turn-a', decision_id: 'D-old', choice: 'edit', message: msg('a', '迟到的旧内容', 1) });
  assert.equal(h.state.messages.get('a').revision.content, '修订内容', '完整旧修订事件也不能回退');
  assert.equal(h.state.messages.get('a').revision.revision, 2);
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

test('仅附件发送：只提交就绪附件，IME 和重复点击均不产生额外请求', async () => {
  const h = harness();
  const ready = { asset_id: 'asset-ready', presentation: 'image', name: '图片', status: 'ready' };
  const uploading = { presentation: 'image', name: '上传中', status: 'uploading' };
  const failed = { presentation: 'image', name: '失败项', status: 'failed' };
  h.state.attachments = [ready, uploading, failed];
  h.composer.value = '';
  h.state.composing = true;
  h.refreshSendButton();
  assert.equal(h.nodes.get('send-btn').disabled, true);
  await h.send();
  assert.equal(h.pending.length, 0, '合成期连仅附件发送也不能发出请求');

  h.state.composing = false;
  h.refreshSendButton();
  assert.equal(h.nodes.get('send-btn').disabled, false, '空正文、有就绪附件时可发送');
  assert.equal(h.nodes.get('send-btn').getAttribute('aria-label'), '发送');
  const sending = h.send();
  assert.equal(h.pending.length, 1);
  const request = h.pending[0];
  assert.equal(request.url, '/api/v1/conversations/primary/messages');
  assert.equal(request.options.method, 'POST');
  assert.equal(payload(request).content, '');
  assert.deepEqual(payload(request).attachments, [{ asset_id: 'asset-ready', presentation: 'image' }]);
  assert.equal(Object.hasOwn(payload(request), 'kind'), false, '附件种类交给宿主从已验证附件推导');
  assert.equal(h.nodes.get('send-btn').disabled, true, '在途发送禁用按钮');
  await h.send();
  assert.equal(h.pending.length, 1, '在途重复点击不得二次发送');

  request.resolve(ok200({ message: msg('attachment-message', '') }));
  await sending;
  assert.equal(h.state.pendingSend, null);
  assert.equal(h.state.sending, false);
  assert.deepEqual(Array.from(h.state.attachments), [uploading, failed], '仅清本次成功的附件，保留上传中和失败项');
  assert.equal(h.nodes.get('send-btn').disabled, true, '剩余附件未就绪，空正文不能继续发送');
});

test('附件重试冻结完整载荷：同幂等键同正文同附件，新草稿与新附件保留', async () => {
  const h = harness();
  const original = { asset_id: 'asset-original', presentation: 'image', caption: '原始说明', name: '原图', status: 'ready' };
  h.state.attachments = [original];
  h.composer.value = '  第一行\n第二行  ';
  h.draftGuard.touch();
  const first = h.send();
  const firstRequest = h.pending[0];
  const frozenBody = payload(firstRequest);
  firstRequest.resolve({ ok: false, status: 503 });
  await first;
  assert.equal(h.state.pendingSend.requestId, frozenBody.client_message_id);
  assert.equal(h.nodes.get('send-btn').getAttribute('aria-label'), '重试发送');

  const added = { asset_id: 'asset-added', presentation: 'image', name: '新图', status: 'ready' };
  const uploading = { presentation: 'image', name: '上传中', status: 'uploading' };
  const failed = { presentation: 'image', name: '失败项', status: 'failed' };
  h.state.attachments.push(added, uploading, failed);
  original.caption = '队列后来改过的说明';
  h.draftGuard.touch();
  const retry = h.send();
  const retryRequest = h.pending[1];
  assert.equal(retryRequest.options.headers['Idempotency-Key'], firstRequest.options.headers['Idempotency-Key']);
  assert.deepEqual(payload(retryRequest), frozenBody, '重试不能混入新附件或修改旧附件的冻结说明');
  assert.equal(payload(retryRequest).content, '  第一行\n第二行  ', '正文首尾空白和多行原样保存');

  h.composer.value = '重试期间继续写的新草稿';
  h.draftGuard.touch();
  retryRequest.resolve(ok200({ message: msg('retried-message', frozenBody.content) }));
  await retry;
  assert.equal(h.state.pendingSend, null);
  assert.equal(h.composer.value, '重试期间继续写的新草稿', '旧回执不能清掉新草稿');
  assert.deepEqual(Array.from(h.state.attachments), [added, uploading, failed], '只移除已成功提交的原附件');
  assert.equal(h.nodes.get('send-btn').disabled, false, '新草稿仍可继续发送');
});
