import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkEventNormalizer } from '../../apps/host/src/runtime/sdk-event-normalizer.ts';
import { fixtureScenario } from '../../packages/test-fixtures/src/sdk-stream.ts';

function run(script: ReturnType<typeof fixtureScenario>) {
  const n = new SdkEventNormalizer();
  return script.flatMap((raw) => n.normalize(raw));
}

test('signature_delta 被吞掉；thinking/text 分流', () => {
  const events = run(fixtureScenario('consistent', ''));
  assert.equal(events.some((e) => JSON.stringify(e).includes('SIGNATURE')), false);
  const thinkingDeltas = events.filter((e) => e.kind === 'thinking_delta') as Array<{ text: string }>;
  const textDeltas = events.filter((e) => e.kind === 'text_delta') as Array<{ text: string }>;
  assert.equal(thinkingDeltas.every((d) => !d.text.includes('合成回复')), true);
  assert.equal(textDeltas.every((d) => !d.text.includes('夹具）')), true);
});

test('完整 AssistantMessage → matched/unmatched（核对用，不重复追加）', () => {
  const events = run(fixtureScenario('consistent', ''));
  const complete = events.find((e) => e.kind === 'complete_message');
  assert.ok(complete);
  if (complete!.kind === 'complete_message') {
    assert.deepEqual(complete.matched.map((b) => b.block_type), ['thinking', 'text']);
    assert.equal(complete.unmatched.length, 0);
  }
});

test('result：success→completed；error_during_execution/is_error→error', () => {
  const n1 = new SdkEventNormalizer();
  const e1 = n1.normalize({ type: 'result', subtype: 'error_during_execution', is_error: true }).find((e) => e.kind === 'turn_end');
  assert.ok(e1 && e1.kind === 'turn_end' && e1.outcome === 'error');
  const n2 = new SdkEventNormalizer();
  const e2 = n2.normalize({ type: 'result', subtype: 'success' }).find((e) => e.kind === 'turn_end');
  assert.ok(e2 && e2.kind === 'turn_end' && e2.outcome === 'completed');
});

test('route_signal 分类独立于普通拒绝/网络错误', () => {
  const events = run(fixtureScenario('route', ''));
  const end = events.find((e) => e.kind === 'turn_end');
  assert.ok(end && end.kind === 'turn_end' && end.error_classified === 'route_signal');
});

test('子代理（parent_tool_use_id）标 channel=subagent 且不丢失归属', () => {
  const events = run(fixtureScenario('subagent', ''));
  const childEvents = events.filter((e) => 'channel' in e && e.channel === 'subagent');
  assert.ok(childEvents.length > 0);
  assert.equal(events.some((e) => e.kind === 'thinking_delta' && e.channel === 'subagent'), true);
});

test('message_start 缺失时 local_ 前缀兜底，不伪造供应商 ID', () => {
  const n = new SdkEventNormalizer();
  const out = n.normalize({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x' } } });
  const start = out.find((e) => e.kind === 'message_start');
  assert.ok(start && start.kind === 'message_start' && /^local_/.test(start.sdk_message_id));
});

test('session_id 从流消息捕获（AUD-03 归一化侧）', () => {
  const events = run(fixtureScenario('consistent', ''));
  const start = events.find((e) => e.kind === 'message_start');
  assert.ok(start && start.kind === 'message_start' && start.session_id === 'sess_fixture_1');
});
