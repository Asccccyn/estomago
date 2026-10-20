import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Render the actual editor with React: preserve multiline body, expose the
// correct action, keep attachment-only messages editable, and lock in-flight saves.
const sourceUrl = new URL('../../apps/web/react/src/InlineMessageEditor.tsx', import.meta.url);
const requireEditor = createRequire(sourceUrl);
const React = requireEditor('react');
const { renderToStaticMarkup } = requireEditor('react-dom/server');
const compiled = ts.transpileModule(fs.readFileSync(sourceUrl, 'utf8'), { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const exports: Record<string, any> = {};
new Function('require', 'exports', compiled)(requireEditor, exports);
const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(exports.InlineMessageEditor, {
  value: '第一行\n\n  第二行', canRetry: true, onChange() {}, onCancel() {}, async onSave() { return true; }, ...props,
}));

test('编辑直接渲染为多行文本框，保留原文空行和缩进，没有对话框', () => {
  const html = render();
  assert.match(html, /aria-label="原位编辑消息"/);
  assert.match(html, /<textarea[^>]*aria-label="编辑消息正文"/);
  assert.ok(html.includes('第一行\n\n  第二行'));
  assert.match(html, /Enter 换行/);
  assert.match(html, /保存并重新发送/);
  assert.match(html, />取消<\/button>/);
  assert.doesNotMatch(html, /role="dialog"|aria-modal/);
});

test('历史消息只保存；失败的最新消息支持原文不变也重发', () => {
  const historical = render({ canRetry: false });
  assert.match(historical, /仅保存修改/);
  assert.doesNotMatch(historical, /保存并重新发送/);
  assert.doesNotMatch(render(), /\sdisabled=""/, '原文无需改变即可重发');
});

test('提交中锁住正文和操作，纯空白无附件不能提交，附件可保持空正文', () => {
  const pending = render({ pending: true });
  assert.match(pending, /<textarea[^>]*\sreadonly=""/i);
  assert.equal((pending.match(/\sdisabled=""/g) ?? []).length, 2);
  assert.match(pending, /正在提交/);
  const blank = render({ value: ' \n\u3000' });
  assert.equal((blank.match(/\sdisabled=""/g) ?? []).length, 1);
  const attachment = render({ value: '', hasAttachment: true, children: React.createElement('img', { src: '/synthetic.png', alt: '原附件' }) });
  assert.doesNotMatch(attachment, /\sdisabled=""/);
  assert.match(attachment, /<img[^>]*alt="原附件"/);
  assert.match(attachment, /<textarea[^>]*><\/textarea>/);
});

test('消息正文按文字显示，不能注入编辑 UI', () => {
  const html = render({ value: '<script>synthetic</script>' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;synthetic&lt;\/script&gt;/);
});

test('未知提交结果保留原内容并暂停修改，但确认和取消仍可用', () => {
  const html = render({ unconfirmed: true });
  assert.match(html, /<textarea[^>]*\sreadonly=""/i);
  assert.ok(html.includes('第一行\n\n  第二行'));
  assert.match(html, /确认上次提交<\/button>/);
  assert.match(html, />取消<\/button>/);
  assert.doesNotMatch(html, /\sdisabled=""/);
  assert.match(html, /role="status"/);
});
