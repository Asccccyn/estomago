// WP1 回归：OR payload 构造/append-only 断言/用量归一（移植自参考实现契约，合成数据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrPayload, assertAppendOnly } from '../../apps/host/src/runtime/or-payload.ts';
import { normalizeOrUsage } from '../../apps/host/src/runtime/or-contract.ts';
import { ContractError } from '../../apps/host/src/runtime/or-contract.ts';

const MODEL = 'anthropic/claude-test-1';
const msg = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });

test('payload：控制字段固定，调用方/配置无法覆盖关键控制', () => {
  const p = buildOrPayload({
    model: MODEL, sessionId: 'es-abc', maxTokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }], cache_control: { type: 'ephemeral', ttl: '5m' } }],
    tools: [{ function: { name: 't', description: 'd' }, cache_control: { type: 'ephemeral', ttl: '5m' } }],
  });
  assert.equal((p.provider as { only: string[] }).only.join(), 'anthropic');
  assert.equal((p.provider as { allow_fallbacks: boolean }).allow_fallbacks, false);
  assert.equal((p.provider as { require_parameters: boolean }).require_parameters, true);
  assert.deepEqual(p.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(p.plugins, [{ id: 'context-compression', enabled: false }]);
  assert.equal(p.stream, true);
  assert.equal(p.max_tokens, 1024);
  // 调用方塞进 messages/tools 的 cache_control 全部剥掉（发送副本统一重规划，§7.2）
  const messages = p.messages as Array<{ content: Array<Record<string, unknown>>; cache_control?: unknown }>;
  assert.equal(messages[0]!.cache_control, undefined);
  assert.equal(messages[0]!.content[0]!.cache_control, undefined);
  assert.equal((p.tools as Array<Record<string, unknown>>)[0]!.cache_control, undefined);
});

test('payload：必须是明确 Claude 型号——auto/latest/别名/非 Claude 全拒', () => {
  for (const bad of ['auto', 'anthropic/claude-latest', 'openai/gpt-4o', 'claude-opus', 'anthropic/claude-x,,y']) {
    assert.throws(() => buildOrPayload({ model: bad, sessionId: 'es-1', messages: [msg('hi')] }), ContractError, bad);
  }
  assert.doesNotThrow(() => buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [msg('hi')] }));
});

test('payload：session_id 长度与 maxTokens 门', () => {
  assert.throws(() => buildOrPayload({ model: MODEL, sessionId: '', messages: [msg('hi')] }), /SESSION_ID_INVALID/);
  assert.throws(() => buildOrPayload({ model: MODEL, sessionId: 'x'.repeat(257), messages: [msg('hi')] }), /SESSION_ID_INVALID/);
  assert.throws(() => buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [msg('hi')], maxTokens: 0 }), /MAX_TOKENS_INVALID/);
  assert.throws(() => buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [] }), /MESSAGES_REQUIRED/);
});

test('payload：显式断点 ≤3、去重、必须落在 text 块', () => {
  const blocks = (text: string, n: number) => ({ role: 'user', content: Array.from({ length: n }, (_, i) => ({ type: 'text', text: `${text}${i}` })) });
  // 去重：同位置重复只算一个
  const dedup = buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [blocks('a', 2)], boundaries: [{ messageIndex: 0, contentIndex: 1 }, { messageIndex: 0, contentIndex: 1 }] });
  const dm = (dedup.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
  assert.deepEqual(dm[1]!.cache_control, { type: 'ephemeral', ttl: '1h' });
  // 第 4 个不同位置 → 拒绝
  assert.throws(() => buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [blocks('a', 5)], boundaries: [0, 1, 2, 3].map((contentIndex) => ({ messageIndex: 0, contentIndex })) }), /TOO_MANY_EXPLICIT_BREAKPOINTS/);
  // 非 blocks 内容（纯字符串）不能标
  assert.throws(() => buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [{ role: 'user', content: 'plain' }], boundaries: [{ messageIndex: 0, contentIndex: 0 }] }), /BOUNDARY_CONTENT_NOT_BLOCKS/);
  // 非 text 块不能标
  assert.throws(() => buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [{ role: 'user', content: [{ type: 'tool_use', id: 't1', name: 'n' }] }], boundaries: [{ messageIndex: 0, contentIndex: 0 }] }), /BOUNDARY_NOT_TEXT/);
});

test('assertAppendOnly：历史只追加、profile 段不变；缓存标记差异不触发', () => {
  const base = buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [msg('a'), msg('b')], tools: [{ function: { name: 't' } }] });
  const grown = buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [msg('a'), msg('b'), msg('c')], tools: [{ function: { name: 't' } }] });
  assert.equal(assertAppendOnly(base, grown), true);
  // 历史被改写 → 拒绝
  const mutated = buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [msg('a'), msg('B'), msg('c')], tools: [{ function: { name: 't' } }] });
  assert.throws(() => assertAppendOnly(base, mutated), /WIRE_TRAJECTORY_DIVERGED:content/);
  // 历史变短 → 拒绝
  assert.throws(() => assertAppendOnly(grown, base), /WIRE_TRAJECTORY_DIVERGED:shortened/);
  // 模型/工具变化 → 前缀 profile 变化
  const modelChanged = buildOrPayload({ model: 'anthropic/claude-test-2', sessionId: 'es-1', messages: [msg('a'), msg('b')] });
  assert.throws(() => assertAppendOnly(base, modelChanged), /PREFIX_PROFILE_CHANGED:model/);
  const toolsChanged = buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [msg('a'), msg('b')], tools: [{ function: { name: 't2' } }] });
  assert.throws(() => assertAppendOnly(base, toolsChanged), /PREFIX_PROFILE_CHANGED:tools/);
  // 边界（缓存标记）差异不影响 append-only 判定
  const withBoundary = buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [msg('a'), msg('b')], tools: [{ function: { name: 't' } }], boundaries: [{ messageIndex: 0, contentIndex: 0 }] });
  assert.equal(assertAppendOnly(base, withBoundary), true);
});

test('normalizeOrUsage：缺失=unknown 不补零；完整=complete；分类超总=anomaly', () => {
  const none = normalizeOrUsage(null);
  assert.equal(none.completeness, 'unknown');
  assert.equal(none.inputTotal, null);
  const full = normalizeOrUsage({ prompt_tokens: 100, completion_tokens: 40, cost: 0.01, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 20 } });
  assert.equal(full.completeness, 'complete');
  assert.equal(full.inputTotal, 100);
  assert.equal(full.noncached, 30); // 100-60-10，仅全已知才推导
  assert.equal(full.cacheRead, 60);
  assert.equal(full.cacheWrite, 10);
  assert.equal(full.reasoning, 20);
  const anomaly = normalizeOrUsage({ prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } });
  assert.equal(anomaly.completeness, 'anomaly');
  assert.ok(anomaly.anomalies.includes('CACHE_CATEGORIES_EXCEED_PROMPT'));
  assert.equal(anomaly.noncached, null, '不相容时不推导 noncached');
  const partial = normalizeOrUsage({ prompt_tokens: 10 });
  assert.equal(partial.completeness, 'partial');
  const reasoningOver = normalizeOrUsage({ prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 9 } });
  assert.ok(reasoningOver.anomalies.includes('REASONING_EXCEEDS_OUTPUT'));
});
