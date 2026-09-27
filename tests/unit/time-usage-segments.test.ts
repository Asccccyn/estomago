import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers.ts';
import { buildTimeContext } from '../../apps/host/src/time/context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { TextSegmenter } from '../../apps/host/src/output/segments.ts';

test('两个"多久"分开：previous vs last；助手发言不重置用户沉默', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  const t0 = new Date(Date.now() - 3 * 3600_000).toISOString();
  const t1 = new Date(Date.now() - 10 * 60_000).toISOString();
  svc.submitUserMessage({ conversationId: 'c1', content: '早些的消息', clientMessageId: 'k0', occurredAt: t0 });
  svc.submitUserMessage({ conversationId: 'c1', content: '最新消息', clientMessageId: 'k1', occurredAt: t1 });
  svc.publishAssistantMessage({ conversationId: 'c1', turnId: 't', content: '助手刚说' }); // 现在

  const ctx = buildTimeContext(db, { conversationId: 'c1', config: buildConfig({}), eventOccurredAt: t1 });
  assert.equal(ctx.previous_user_message_at, t0);
  assert.equal(ctx.last_user_message_at, t1);
  assert.ok(ctx.elapsed_before_current_user_message);
  assert.ok(ctx.elapsed_since_last_user_message);
  // "多久没收到她消息"必须基于 t1（用户），不是助手
  const sinceLastUserMs = Date.now() - new Date(t1).getTime();
  const claimed = parseIsoDurationMs(ctx.elapsed_since_last_user_message!);
  assert.ok(Math.abs(claimed - sinceLastUserMs) < 5000, `用户间隔 ${claimed}ms 应 ≈ ${sinceLastUserMs}ms`);
});

test('跨业务日（Asia/Shanghai）判定', () => {
  const { db } = makeDb();
  const svc = new MessageService(db);
  svc.ensureConversation('c1');
  // 上海 2026-09-25 23:50 与 2026-09-26 00:10（UTC 表示）
  const lateNight = new Date('2026-09-25T15:50:00Z').toISOString();
  const afterMidnight = new Date('2026-09-25T16:10:00Z').toISOString();
  svc.submitUserMessage({ conversationId: 'c1', content: '睡前的', clientMessageId: 'd0', occurredAt: lateNight });
  const ctx = buildTimeContext(db, {
    conversationId: 'c1',
    config: buildConfig({}),
    eventOccurredAt: afterMidnight,
    previousUserMessageAt: lateNight,
  });
  assert.equal(ctx.crossed_business_date, true);
  assert.equal(ctx.business_timezone, 'Asia/Shanghai');
});

function parseIsoDurationMs(d: string): number {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d);
  return (Number(m?.[1] ?? 0) * 3600 + Number(m?.[2] ?? 0) * 60 + Number(m?.[3] ?? 0)) * 1000;
}

test('用量口径分开；未知为 null 不填零', () => {
  const { db } = makeDb();
  const usage = new UsageCollector(db);
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'turn', usage: { input_tokens: 120, output_tokens: 48 }, model: 'm1', source: 'sdk_result' });
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'request', usage: { input_tokens: 30 }, model: 'm1', source: 'sdk_stream', completeness: 'partial' });
  const summary = usage.summaryForTurn('t1');
  const turnScope = summary.find((s) => s.scope === 'turn')!;
  const requestScope = summary.find((s) => s.scope === 'request')!;
  assert.equal(turnScope.input_tokens, 120);
  assert.equal(requestScope.input_tokens, 30);
  assert.equal(requestScope.output_tokens, null, '未知输出不得填 0');
  assert.equal(requestScope.completeness, 'partial');
});

test('分句缓冲：段落边界发布、上限强切、尾部 flush、打断丢弃', () => {
  const s = new TextSegmenter(20);
  assert.deepEqual(s.push('第一段'), []);
  assert.deepEqual(s.push('\n\n第二段开始'), ['第一段']);
  const forced = s.push('很长很长很长很长很长很长很长很长'); // 超上限强制切
  assert.ok(forced.length >= 1);
  assert.equal(s.flushTail(), null); // 已被强切清空
  const s2 = new TextSegmenter();
  s2.push('尾巴文本');
  assert.equal(s2.flushTail(), '尾巴文本');
  const s3 = new TextSegmenter();
  s3.push('未发布缓冲');
  s3.drop();
  assert.equal(s3.flushTail(), null);
});
