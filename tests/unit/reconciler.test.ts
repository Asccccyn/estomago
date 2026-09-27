import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, unmatchedOutcome } from '../../apps/host/src/reasoning/reconciler.ts';

test('A=B → 只定稿，不重复追加', () => {
  assert.deepEqual(reconcile('abc', 'abc'), { action: 'already_complete' });
});

test('A 是 B 的前缀 → 只补缺段', () => {
  assert.deepEqual(reconcile('abc', 'abcdef'), { action: 'append_tail', tail: 'def' });
});

test('非前缀 → 冲突：不拼接 A+B，保留差异', () => {
  const out = reconcile('abc', 'xbcdef');
  assert.equal(out.action, 'conflict');
  assert.equal((out as { finalText: string }).finalText, 'xbcdef');
});

test('空接收 + 有完整块 → 前缀补齐', () => {
  assert.deepEqual(reconcile('', '完整摘要'), { action: 'append_tail', tail: '完整摘要' });
});

test('unmatched 超时前 partial、超时后 conflict', () => {
  assert.equal(unmatchedOutcome(1000, 5000), 'partial');
  assert.equal(unmatchedOutcome(6000, 5000), 'conflict');
});
