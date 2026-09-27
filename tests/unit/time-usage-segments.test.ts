import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers.ts';
import { buildTimeContext } from '../../apps/host/src/time/context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { TextSegmenter } from '../../apps/host/src/output/segments.ts';

test('两个"多久"分开；助手发言不重置用户沉默', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const t0 = new Date(Date.now() - 3 * 3600_000).toISOString();
  const t1 = new Date(Date.now() - 10 * 60_000).toISOString();
  svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '早些的消息', clientMessageId: 'k0', occurredAt: t0 });
  svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '最新消息', clientMessageId: 'k1', occurredAt: t1 });
  svc.publishAssistantMessage({ conversationId: 'c1', turnId: 't', content: '助手刚说' });
  const ctx = buildTimeContext(db, { conversationId: 'c1', config: buildConfig({}), eventOccurredAt: t1 });
  assert.equal(ctx.previous_user_message_at, t0);
  assert.equal(ctx.last_user_message_at, t1);
  const claimed = parseIsoDurationMs(ctx.elapsed_since_last_user_message!);
  const sinceLastUserMs = Date.now() - new Date(t1).getTime();
  assert.ok(Math.abs(claimed - sinceLastUserMs) < 5000);
});

test('跨业务日（Asia/Shanghai）判定', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const lateNight = new Date('2026-09-25T15:50:00Z').toISOString();
  const afterMidnight = new Date('2026-09-25T16:10:00Z').toISOString();
  svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '睡前的', clientMessageId: 'd0', occurredAt: lateNight });
  svc.submitUserMessageWithTurn({ conversationId: 'c1', content: '次日的', clientMessageId: 'd1', occurredAt: afterMidnight });
  const ctx = buildTimeContext(db, { conversationId: 'c1', config: buildConfig({}), eventOccurredAt: afterMidnight, currentInputSequence: 2 });
  assert.equal(ctx.previous_user_message_at, lateNight);
  assert.equal(ctx.crossed_business_date, true);
});

test('用量账本：同轮多 attempt 分列 + 总量求和（不再覆盖）', () => {
  const { db } = makeDb();
  const usage = new UsageCollector(db);
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'turn', usage: { input_tokens: 120, output_tokens: 10 }, model: 'm1', source: 'sdk_result' });
  usage.record({ turnId: 't1', attemptId: 'a2', scope: 'turn', usage: { input_tokens: 30, output_tokens: 5 }, model: 'm1', source: 'sdk_result' });
  const s = usage.summaryForTurn('t1');
  assert.equal(s.attempts.length, 2);
  assert.equal(s.totals.input_tokens, 150);
  assert.equal(s.totals.output_tokens, 15);
});

test('用量未知不填零；重试消耗不静默覆盖', () => {
  const { db } = makeDb();
  const usage = new UsageCollector(db);
  usage.record({ turnId: 't2', attemptId: 'a1', scope: 'turn', usage: { input_tokens: 10 }, model: 'm1', source: 'sdk_result' });
  usage.record({ turnId: 't2', attemptId: 'a1', scope: 'turn', usage: { input_tokens: 10 }, model: 'm1', source: 'sdk_result' }); // 幂等重放
  const s = usage.summaryForTurn('t2');
  assert.equal(s.attempts.length, 1);
  assert.equal(s.totals.output_tokens, null);
  assert.equal(s.totals.unknown_present, true);
});

test('分句：段落边界发布、围栏内不切、尾部 flush、打断丢弃', () => {
  const s = new TextSegmenter();
  assert.deepEqual(s.push('第一段'), []);
  assert.deepEqual(s.push('\n\n第二段开始'), ['第一段']);
  const forced = new TextSegmenter(20);
  forced.push('第二段开始');
  const f = forced.push('很长很长很长很长很长很长很长很长');
  assert.ok(f.length >= 1);
  const s3 = new TextSegmenter();
  s3.push('尾巴文本');
  assert.equal(s3.flushTail(), '尾巴文本');
  const s4 = new TextSegmenter();
  s4.push('未发布缓冲');
  s4.drop();
  assert.equal(s4.flushTail(), null);
});

function parseIsoDurationMs(d: string): number {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d);
  return (Number(m?.[1] ?? 0) * 3600 + Number(m?.[2] ?? 0) * 60 + Number(m?.[3] ?? 0)) * 1000;
}
