import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { EstomagoClient } from '../../apps/web/react/src/chat-client.ts';

// Render the actual isolated UI component, not a copied template or source grep.
const requireWeb = createRequire(new URL('../../apps/web/react/package.json', import.meta.url));
const React = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const source = fs.readFileSync(new URL('../../apps/web/react/src/SystemAlerts.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const exports: Record<string, any> = {};
new Function('require', 'exports', compiled)(requireWeb, exports);
const render = (component: any, props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(component, props));

test('系统异常有独立可访问入口；已读清红点但待处理数不消失', () => {
  const unread = render(exports.SystemAlertsButton, { unread: 1, open: 1, onClick() {} });
  assert.match(unread, /系统异常，1 条未读，1 项待处理/);
  assert.match(unread, /data-testid="system-alert-dot"/);
  const read = render(exports.SystemAlertsButton, { unread: 0, open: 1, onClick() {} });
  assert.doesNotMatch(read, /system-alert-dot/);
  assert.match(read, /系统异常，0 条未读，1 项待处理/);
});

test('独立抽屉展示缺失段安全说明、严重度、恢复状态；不会把已读称作恢复', () => {
  const html = render(exports.SystemAlertsPanel, {
    alerts: [
      { alert_id: 'a', code: 'BOOTSTRAP_INCOMPLETE', severity: 'warning', lifecycle: 'open', unread: false,
        safe_summary: { title: '部分开窗资料未载全', detail: '只缺心情文字，已保留同快照核验过的 I 和计划。' } },
      { alert_id: 'b', code: 'BOOTSTRAP_INCOMPLETE', severity: 'critical', lifecycle: 'resolved', unread: false,
        safe_summary: { title: '<script>synthetic</script>', detail: '整包已经重新验证。' } },
    ], unread: 0, open: 1, error: '', hasMore: true,
    onClose() {}, onRefresh() {}, onRead() {}, onMore() {},
  });
  assert.match(html, /role="dialog"/);
  assert.match(html, /系统异常/);
  assert.match(html, /只缺心情文字，已保留同快照核验过的 I 和计划。/);
  assert.match(html, /待处理 · 警告/);
  assert.match(html, /已恢复 · 严重/);
  assert.match(html, /标为已读不会结束尚未恢复的异常/);
  assert.match(html, /加载更早记录/);
  assert.doesNotMatch(html, /<script>/);
});

test('读取失败展示错误而非伪造暂无记录', () => {
  const html = render(exports.SystemAlertsPanel, {
    alerts: [], unread: 0, open: 0, error: '系统异常状态暂时无法读取，请重试', hasMore: false,
    onClose() {}, onRefresh() {}, onRead() {}, onMore() {},
  });
  assert.match(html, /暂时无法读取/);
  assert.doesNotMatch(html, /暂无系统异常记录/);
});

test('突发告警合并重查；晚到旧summary不丢失新红点及打开抽屉的列表请求', async () => {
  let completeFirst!: (response: Response) => void;
  let summaries = 0, lists = 0;
  const client = new EstomagoClient({ fetch: async url => {
    if (String(url).endsWith('/summary')) {
      summaries++;
      if (summaries === 1) return new Promise(resolve => { completeFirst = resolve; });
      return Response.json({ unread_anomaly_count: 1, open_count: 1 });
    }
    lists++;
    return Response.json({ items: [{ alert_id: 'new-alert', code: 'BOOTSTRAP_INCOMPLETE',
      severity: 'warning', lifecycle: 'open', last_event_sequence: 2 }], has_more: false });
  }, redirect() {} });
  const first = client.loadAlerts(false);
  for (let i = 0; i < 50; i++) void client.loadAlerts(true);
  completeFirst(Response.json({ unread_anomaly_count: 0, open_count: 0 }));
  await first;
  assert.equal(summaries, 2);
  assert.equal(lists, 1);
  assert.equal(client.snapshot.unreadAlerts, 1);
  assert.equal(client.snapshot.alerts[0]!.alert_id, 'new-alert');
});

test('图片能力失败提示可访问且不展示不存在的回合重试按钮', () => {
  const controlsSource = fs.readFileSync(new URL('../../apps/web/react/src/IntegrationControls.tsx', import.meta.url), 'utf8');
  const controlsCompiled = ts.transpileModule(controlsSource, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const controls: Record<string, any> = {};
  new Function('require', 'exports', controlsCompiled)(requireWeb, controls);
  const notice = '暂时无法核实模型的图片能力，本轮未发送；消息已保存，请稍后重试。';
  const html = render(controls.IntegrationControls, { client: { notify() {} }, state: {
    notice, ready: true, selectionMode: false, route: null,
  } });
  assert.match(html, /role="status"/);
  assert.ok(html.includes(notice));
  assert.match(html, /aria-label="关闭提示"/);
  assert.doesNotMatch(html, />重试<\/button>/);
});
