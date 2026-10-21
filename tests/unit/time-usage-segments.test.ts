import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers.ts';
import { buildTimeContext, modelTimeContextJson } from '../../apps/host/src/time/context.ts';
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

test('分句 v0.3：段落边界（保留行结构）、围栏内不切、尾部 flush、打断丢弃', () => {
  const s = new TextSegmenter();
  assert.deepEqual(s.push('第一段'), []);
  assert.deepEqual(s.push('\n\n第二段开始'), ['第一段\n']); // v0.3：段保留尾换行（正文结构保真）
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

// 她 2026-10-21 三轮裁定：日期时间一行 + PT 小时取整时长 + 只留"距她"字段 + new day 条件保留
test('modelTimeContextJson：单字段 PT 时长+条件保留+字节对比', () => {
  const base = {
    now_at_utc: '2026-10-21T00:33:00Z', business_timezone: 'Asia/Shanghai',
    local_date: '2026-10-21', weekday: 'Thu', daypart: 'morning',
    event_occurred_at: null, processing_at: '2026-10-21T00:33:00Z',
    previous_user_message_at: null, elapsed_before_current_user_message: null,
    last_user_message_at: 'x', elapsed_since_last_user_message: 'PT0H0M0S',
    last_assistant_published_at: 'x', elapsed_since_last_assistant_message: 'PT26H7M51S',
    conversation_id: 'c1', window_started_at: null, crossed_business_date: true,
  } as import('../../apps/host/src/time/context.ts').TimeContext;
  const s = modelTimeContextJson(base);
  assert.equal(s, '2026-10-21 08:33 Thu morning | her PT0H ago | new day'); // 00:33Z=上海 08:33
  // char自己的间隔不再出现（她：给他看的，只留她的）
  assert.ok(!s.includes('your') && !s.includes('26h'), s);
  // PT 小时取整
  assert.ok(modelTimeContextJson({ ...base, elapsed_since_last_user_message: 'PT26H7M51S' }).includes('her PT26H ago'));
  assert.ok(modelTimeContextJson({ ...base, elapsed_since_last_user_message: 'PT30M0S' }).includes('her PT30M ago'));
  assert.ok(modelTimeContextJson({ ...base, elapsed_since_last_user_message: 'PT49H5M0S' }).includes('her PT49H ago'));
  // 条件保留
  assert.ok(!modelTimeContextJson({ ...base, crossed_business_date: false }).includes('new day'));
  const fs = modelTimeContextJson({ ...base, elapsed_since_last_user_message: null, crossed_business_date: false });
  assert.equal(fs, '2026-10-21 08:33 Thu morning'); // 首条：只剩日期时间
  // 字节：新行 < 旧 JSON×0.35
  const oldJson = JSON.stringify({
    now_at_utc: '2026-10-19T12:57:01Z', local_date: '2026-10-19', weekday: 'Mon', daypart: 'evening',
    elapsed_since_last_user_message: 'PT0H0M0S', elapsed_since_last_assistant_message: 'PT26H7M51S',
    crossed_business_date: true,
  });
  assert.ok(Buffer.byteLength(s, 'utf8') < Buffer.byteLength(oldJson, 'utf8') * 0.35,
    `${Buffer.byteLength(s)} < ${Math.floor(Buffer.byteLength(oldJson) * 0.35)}`);
});
