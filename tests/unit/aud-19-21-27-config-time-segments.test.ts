// AUD-19/21/27 回归：nullable 数字显式类型；排队输入各自正确前驱；分句器 Unicode/围栏。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../apps/host/src/config/schema.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { makeDb } from '../helpers.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { buildTimeContext } from '../../apps/host/src/time/context.ts';
import { TextSegmenter } from '../../apps/host/src/output/segments.ts';

test('AUD-19：nullable 数字矩阵（null/int/float/数字串/乱串/缺失）', () => {
  const ok = validateConfig({ windows: { soft_limit_tokens: 200000 }, reasoning: { auto_delete_days: 30, maximum_buffer_bytes: 65536 }, archive: { semantic_auto_binding_threshold: 0.75 } });
  assert.equal(ok.issues.length, 0);
  const nullOk = validateConfig({ windows: { soft_limit_tokens: null } });
  assert.equal(nullOk.issues.length, 0);
  const numericString = validateConfig({ windows: { soft_limit_tokens: '200000' } });
  assert.ok(numericString.issues.some((i) => i.path === 'windows.soft_limit_tokens'));
  const garbage = validateConfig({ windows: { soft_limit_tokens: 'banana' }, reasoning: { auto_delete_days: [] } });
  assert.ok(garbage.issues.length >= 2);
  const missing = validateConfig({});
  assert.equal(missing.issues.length, 0);
});

test('AUD-21：A/B/C 快速排队——每条输入各自正确的 predecessor', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const A = '2026-09-27T00:00:00Z', B = '2026-09-27T01:00:00Z', C = '2026-09-27T02:00:00Z';
  svc.submitUserMessageWithTurn({ conversationId: 'c1', content: 'A', clientMessageId: 'a', occurredAt: A });
  svc.submitUserMessageWithTurn({ conversationId: 'c1', content: 'B', clientMessageId: 'b', occurredAt: B });
  svc.submitUserMessageWithTurn({ conversationId: 'c1', content: 'C', clientMessageId: 'c', occurredAt: C });
  const config = buildConfig({});
  const seqB = 2;
  const ctxB = buildTimeContext(db, { conversationId: 'c1', config, eventOccurredAt: B, currentInputSequence: seqB });
  assert.equal(ctxB.previous_user_message_at, A, 'B 的前驱必须是 A');
  assert.notEqual(ctxB.elapsed_before_current_user_message, 'PT0H0M0S');
  const ctxC = buildTimeContext(db, { conversationId: 'c1', config, eventOccurredAt: C, currentInputSequence: 3 });
  assert.equal(ctxC.previous_user_message_at, B, 'C 的前驱必须是 B');
  const ctxA = buildTimeContext(db, { conversationId: 'c1', config, eventOccurredAt: A, currentInputSequence: 1 });
  assert.equal(ctxA.previous_user_message_at, null, 'A 无前驱');
  db.close();
});

test('AUD-27：围栏内空行不切泡；代码块保持单泡且围栏成对', () => {
  const s = new TextSegmenter();
  const code = '说明：\n```js\nconst a = 1;\n\nconst b = 2;\n```\n结束';
  const segs = [];
  segs.push(...s.push(code));
  const tail = s.flushTail();
  if (tail) segs.push(tail);
  assert.equal(segs.length, 1, '围栏内空行不是边界');
  assert.equal((segs[0]!.match(/```/g) ?? []).length % 2, 0);
});

test('AUD-27：代理对/组合字符永不在中间切断', () => {
  const s = new TextSegmenter(4);
  const a = s.push('ab\ud83d'); // 高代理项在尾部且超限
  const b = s.push('\ude00cd');
  const t = s.flushTail();
  const emitted = [...a, ...b, ...(t ? [t] : [])];
  for (const seg of emitted) {
    assert.equal(/[\ud800-\udbff]$/.test(seg), false, '段尾不得是孤立高代理项');
    assert.equal(/^[\udc00-\udfff]/.test(seg), false, '段首不得是孤立低代理项');
  }
});

test('AUD-27：超长围栏强切后每泡围栏仍成对可恢复', () => {
  const s = new TextSegmenter(60);
  const long = '说明\n```python\n' + 'x = 1\n'.repeat(40) + '```\n完';
  const segs = [];
  segs.push(...s.push(long));
  const tail = s.flushTail();
  if (tail) segs.push(tail);
  assert.ok(segs.length >= 2);
  for (const seg of segs) assert.equal((seg.match(/```/g) ?? []).length % 2, 0, `每泡围栏成对：${seg.slice(0, 30)}…`);
});
