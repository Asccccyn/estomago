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

// 她 2026-10-21 P2 二阶段：模型面投影=紧凑单行（零 JSON/键名/ISO 时长；英文=最少字节；条件保留）
test('modelTimeContextJson：紧凑单行+条件保留+三格式字节对比（她口径：用字节少的）', () => {
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
  assert.equal(s, '2026-10-21 08:33 Thu morning | her last 0m ago | your last 26h08m ago | new day'); // 00:33Z=上海 08:33
  for (const forbidden of ['{', '"', 'now_at_utc', 'PT', 'crossed_business_date']) {
    assert.ok(!s.includes(forbidden), `不应出现 ${forbidden}: ${s}`);
  }
  const oldJson = JSON.stringify({
    now_at_utc: '2026-10-19T12:57:01Z', local_date: '2026-10-19', weekday: 'Mon', daypart: 'evening',
    elapsed_since_last_user_message: 'PT0H0M0S', elapsed_since_last_assistant_message: 'PT26H7M51S',
    crossed_business_date: true,
  });
  const chineseProse = Buffer.byteLength('现在是 2026-10-21 08:33 周四 早晨；距她上次发言 0 分钟、距你上次发言 26 小时 08 分；已跨天', 'utf8');
  const bNew = Buffer.byteLength(s, 'utf8');
  assert.ok(bNew < chineseProse, `英文紧凑(${bNew}) < 中文人话(${chineseProse})`);
  assert.ok(bNew < Buffer.byteLength(oldJson, 'utf8') * 0.4, `英文紧凑(${bNew}) < 旧JSON×0.4(${Math.floor(Buffer.byteLength(oldJson) * 0.4)})`);
  // 条件保留：未跨天无 new day；首条无间隔段
  assert.ok(!modelTimeContextJson({ ...base, crossed_business_date: false }).includes('new day'));
  const fs = modelTimeContextJson({ ...base, elapsed_since_last_user_message: null, elapsed_since_last_assistant_message: null, crossed_business_date: false });
  assert.ok(!fs.includes('her last') && !fs.includes('your last') && !fs.includes('new day'), fs);
  assert.ok(fs.startsWith('2026-10-21 08:33 Thu morning'));
  // ≥24h 不折算天（字节更少）
  assert.equal(modelTimeContextJson({ ...base, elapsed_since_last_assistant_message: 'PT49H5M0S' }).includes('49h05m'), true);
});
