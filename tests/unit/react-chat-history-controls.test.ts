import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const sourceUrl = new URL('../../apps/web/react/src/ChatHistoryControls.tsx', import.meta.url);
const requireComponent = createRequire(sourceUrl);
const React = requireComponent('react');
const { renderToStaticMarkup } = requireComponent('react-dom/server');
const source = ts.transpileModule(fs.readFileSync(sourceUrl, 'utf8'), { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const components: Record<string, any> = {};
new Function('require', 'exports', source)(requireComponent, components);
const render = (name: string, props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(components[name], props));

test('history controls distinguish loading, retry, and terminal boundaries', () => {
  const base = { direction: 'earlier', loading: false, hasMore: true, onLoad() {} };
  assert.match(render('HistoryBoundary', base), /上滑加载更早的消息/);
  assert.match(render('HistoryBoundary', { ...base, loading: true }), /role="status"[^>]*>正在加载更早/);
  assert.match(render('HistoryBoundary', { ...base, error: '网络暂不可用' }), /网络暂不可用 · 点击重试/);
  assert.match(render('HistoryBoundary', { ...base, hasMore: false }), /已到最早的消息/);
  assert.match(render('HistoryBoundary', { ...base, direction: 'later' }), /加载后续消息/);
});

// 2026-10-22 她裁定：删"回到最新"横幅，改微信式圆点（BackToLatestDot）
test('back-to-latest dot: visible while away/newer messages, red badge, hidden at latest', () => {
  const visible = render('BackToLatestDot', { visible: true, newMessages: true, busy: false, onLatest() {} });
  assert.match(visible, /aria-label="有新消息，回到最新"/);
  assert.match(visible, /回到最新/);
  assert.match(visible, /bg-\[#fa5151\]/, '新消息红点');
  assert.doesNotMatch(visible, /\sdisabled=""/);
  assert.match(render('BackToLatestDot', { visible: true, newMessages: false, busy: false, onLatest() {} }), /aria-label="回到最新"/);
  const disabled = render('BackToLatestDot', { visible: true, newMessages: true, busy: false, disabled: true, onLatest() {} });
  assert.match(disabled, /\sdisabled=""/);
  assert.equal(render('BackToLatestDot', { visible: false, newMessages: false, busy: false, onLatest() {} }), '', '在最新位置不渲染');
});

test('date picker exposes an accessible entry and can be disabled while editing', () => {
  const html = render('HistoryDatePicker', { date: null, timezone: 'Asia/Shanghai', busy: false, disabled: true, onPick: async () => true });
  assert.match(html, /aria-label="按日期查找聊天记录"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /\sdisabled=""/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test('calendar default date uses the stated timezone across a UTC day boundary', () => {
  const instant = new Date('2026-10-19T16:30:00Z');
  assert.equal(components.dateInTimezone('Asia/Shanghai', instant), '2026-10-20');
  assert.equal(components.dateInTimezone('America/Los_Angeles', instant), '2026-10-19');
});
