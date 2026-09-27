import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkEventNormalizer } from '../../apps/host/src/runtime/sdk-event-normalizer.ts';
import { fixtureScenario } from '../../packages/test-fixtures/src/sdk-stream.ts';

function run(script: ReturnType<typeof fixtureScenario>) {
  const n = new SdkEventNormalizer();
  return script.flatMap((raw) => n.normalize(raw));
}

test('接收矩阵：signature_delta 被吞掉，绝不向 UI 分发', () => {
  const events = run(fixtureScenario('consistent', ''));
  const sig = events.filter((e) => JSON.stringify(e).includes('SIGNATURE'));
  assert.equal(sig.length, 0);
  assert.equal(events.some((e) => e.kind === 'thinking_delta'), true);
});

test('thinking 与 text 分流：text_delta 不进 thinking，thinking_delta 不进正文', () => {
  const events = run(fixtureScenario('consistent', ''));
  const thinkingDeltas = events.filter((e) => e.kind === 'thinking_delta') as Array<{ text: string }>;
  const textDeltas = events.filter((e) => e.kind === 'text_delta') as Array<{ text: string }>;
  assert.equal(thinkingDeltas.every((d) => !d.text.includes('合成回复')), true);
  assert.equal(textDeltas.every((d) => !d.text.includes('夹具）')), true);
});

test('完整 AssistantMessage → complete_message（核对用，不重复追加）', () => {
  const events = run(fixtureScenario('consistent', ''));
  const complete = events.find((e) => e.kind === 'complete_message');
  assert.ok(complete, '应产出 complete_message');
  if (complete!.kind === 'complete_message') {
    assert.equal(complete.blocks[0]!.block_type, 'thinking');
    assert.equal(complete.blocks[1]!.block_type, 'text');
  }
});

test('message_stop 产生但 turn 由 result 决定；result 携带 turn 级用量', () => {
  const events = run(fixtureScenario('consistent', ''));
  assert.equal(events.some((e) => e.kind === 'message_stop'), true);
  const usage = events.find((e) => e.kind === 'usage');
  assert.ok(usage);
  if (usage!.kind === 'usage') {
    assert.equal(usage.scope, 'turn');
    assert.equal(usage.usage.input_tokens, 120);
  }
  assert.equal(events[events.length - 1]!.kind, 'turn_end');
});

test('route_signal 错误分类独立于普通拒绝/网络错误', () => {
  const events = run(fixtureScenario('route', ''));
  const end = events.find((e) => e.kind === 'turn_end');
  assert.ok(end);
  if (end!.kind === 'turn_end') {
    assert.equal(end.outcome, 'error');
    assert.equal(end.error_classified, 'route_signal');
  }
});

test('message_start 缺失时用本地步标识兜底，且不伪造供应商 ID（local_ 前缀）', () => {
  const n = new SdkEventNormalizer();
  const out = n.normalize({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x' } },
  });
  const start = out.find((e) => e.kind === 'message_start');
  assert.ok(start);
  if (start!.kind === 'message_start') assert.match(start.sdk_message_id, /^local_/);
});
