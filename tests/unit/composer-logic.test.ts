import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canSend,
  isBlankContent,
  buildOutgoingDraft,
  newClientMessageId,
  shouldSendOnKeydown,
  normalizeNewlines,
} from '../../apps/web/src/composer-logic.js';

test('2026-10-17 她裁定：Claude 官端口径——裸 Enter 发送，组合键/IME 不发送', () => {
  const ev = (over = {}) => ({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, keyCode: 13, nativeEvent: { isComposing: false }, ...over });
  assert.equal(shouldSendOnKeydown(ev()), true, '裸 Enter=发送一段');
  assert.equal(shouldSendOnKeydown(ev({ shiftKey: true })), false, 'Shift+Enter=换行');
  assert.equal(shouldSendOnKeydown(ev({ metaKey: true })), false);
  assert.equal(shouldSendOnKeydown(ev({ ctrlKey: true })), false);
  assert.equal(shouldSendOnKeydown(ev({ keyCode: 229 })), false, 'IME 合成期 Enter 不发送');
  assert.equal(shouldSendOnKeydown(ev({ nativeEvent: { isComposing: true } })), false);
  assert.equal(shouldSendOnKeydown(ev({ key: 'a' })), false);
  assert.equal(shouldSendOnKeydown(), false);
});

test('IME 合成期间不可发送（候选确认≠发送）', () => {
  assert.equal(canSend('打字中', { composing: true }), false);
  assert.equal(canSend('打字中', { composing: false }), true);
});

test('仅空白（含全角空格/空行）不可发送；多行非空白可发送', () => {
  assert.equal(isBlankContent(' \n\t\u3000'), true);
  assert.equal(canSend('\n\n  \n', {}), false);
  assert.equal(canSend('第一行\n第二行', {}), true);
});

test('草稿只做换行规范化（LF），保留行序/空行/首尾空格，绝不 trim', () => {
  const draft = buildOutgoingDraft('  a\r\nb\r\rc\n\n', 'cmid');
  assert.equal(draft.content, '  a\nb\n\nc\n\n'); // \r 各自规范为 \n，不合并语义
  assert.equal(draft.client_message_id, 'cmid');
});

test('一次点击一个幂等键；uuid 形状', () => {
  const a = newClientMessageId({ randomUUID: () => '00000000-0000-4000-8000-000000000000' });
  assert.equal(a, '00000000-0000-4000-8000-000000000000');
});
