// 多选（人工选集）UI——她 2026-10-18：交互参照微信（左缘圆圈/整条可点/底部操作栏）、
// 视觉与现有前端一致、多选只带文本。渲染真组件（transpile + renderToStaticMarkup），非源码 grep。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const requireWeb = createRequire(new URL('../../apps/web/react/package.json', import.meta.url));
const React = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const source = fs.readFileSync(new URL('../../apps/web/react/src/SelectionControls.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const exports: Record<string, any> = {};
new Function('require', 'exports', compiled)(requireWeb, exports);
const render = (component: any, props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(component, props));

test('勾选圆圈两态：未选=空心圈（主题色不出现），选中=主题色实心对勾', () => {
  const unchecked = render(exports.SelectionCheck, { checked: false });
  assert.match(unchecked, /rounded-full/);
  assert.ok(unchecked.includes('border-black/15'), '未选应显示浅色空心圈');
  assert.doesNotMatch(unchecked, /bg-\[#c96442\]/, '未选不得出现主题色填充');
  const checked = render(exports.SelectionCheck, { checked: true });
  assert.match(checked, /bg-\[#c96442\]/, '选中为主题色实心');
});

test('底部操作栏：零选=确认禁用；有选=计数与可访问名称如实', () => {
  const noop = () => {};
  const empty = render(exports.SelectionBar, { count: 0, onConfirm: noop, onEmpty: noop, onCancel: noop });
  assert.match(empty, /role="toolbar"/);
  assert.match(empty, /disabled/, '零选时确认按钮必须禁用');
  assert.match(empty, /不带历史/);
  assert.match(empty, /取消/);
  const filled = render(exports.SelectionBar, { count: 3, onConfirm: noop, onEmpty: noop, onCancel: noop });
  assert.match(filled, /带所选换窗（3）/);
  assert.match(filled, /aria-label="携带所选 3 条文本历史换窗"/);
  assert.doesNotMatch(filled, /disabled/);
});

test('媒体占位：图片与语音只显示文本占位行，不渲染 img/播放控件', () => {
  const image = render(exports.SelectionMediaText, { kind: 'image', text: '' });
  assert.match(image, /\[图片\]/);
  assert.match(image, /只带文本，不随多选带入新窗/, '空文本图片要有不带图说明');
  assert.doesNotMatch(image, /<img/, '多选列表不渲染图片');
  const voice = render(exports.SelectionMediaText, { kind: 'voice', text: '转写的内容' });
  assert.match(voice, /\[语音\] 转写的内容/);
  assert.doesNotMatch(voice, /<img/);
});
