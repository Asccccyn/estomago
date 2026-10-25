// AUD-11/12/13/24 回归：块身份按开放块顺序匹配、unmatched 隔离、子代理不进主聊、
// 截断单向、统一限额、起始正文只接一次。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { SdkEventNormalizer } from '../../apps/host/src/runtime/sdk-event-normalizer.ts';
import { fixtureScenario } from '../../packages/test-fixtures/src/sdk-stream.ts';
import {tempRoot, seedProbes } from '../helpers.ts';

function setup() {
  const root = tempRoot();
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  seedProbes(db);
  const events = new EventService(db);
  const reasoning = new ReasoningService(db, events);
  const norm = new SdkEventNormalizer();
  const apply = (ev: import('../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent) => {
    const base = { conversationId: 'c1', turnId: 't1', attemptId: 'a1', generation: 1 };
    if (ev.kind === 'content_block_start' && ev.block_type === 'thinking' && ev.channel === 'main') reasoning.startBlock({ ...base, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index });
    if (ev.kind === 'thinking_delta' && ev.channel === 'main') reasoning.appendDelta({ ...base, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index, text: ev.text });
    if (ev.kind === 'content_block_stop' && ev.channel === 'main') reasoning.markStreamBlockComplete({ attemptId: 'a1', sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index });
    if (ev.kind === 'complete_message' && ev.channel === 'main') reasoning.reconcileCompleteMessage({ ...base, sdkMessageId: ev.sdk_message_id, matched: ev.matched, unmatched: ev.unmatched });
  };
  return { db, reasoning, norm, apply, feed: (raw: ReturnType<typeof fixtureScenario>[number]) => { for (const ev of norm.normalize(raw)) apply(ev); } };
}

test('AUD-11（v0.3 歧义不猜）：多个同类型开放块时完整包一律 AMBIGUOUS-unmatched，绝不取最小 index', () => {
  const { db, feed } = setup();
  for (const raw of fixtureScenario('multi_complete', '')) feed(raw);
  // 两开放 thinking 块 → 三个完整包全部 ambiguous-unmatched（不猜归属）
  const unmatched = db.prepare("SELECT received_text, completeness FROM reasoning_blocks WHERE block_index < 0 AND attempt_id='a1' ORDER BY id").all() as Array<{ received_text: string; completeness: string }>;
  assert.equal(unmatched.length, 3, '三个完整包都不得匹配到开放块');
  assert.ok(unmatched.every((u) => /FIRST-RECEIVED|THIRD-RECEIVED|EXTRA-UNMATCHED/.test(u.received_text)));
  // 原开放块不被覆盖：received 保留流式文本
  const b0 = db.prepare("SELECT received_text FROM reasoning_blocks WHERE block_index = 0 AND attempt_id='a1'").get() as { received_text: string };
  assert.equal(b0.received_text, 'FIRST-RECEIVED', 'block0 绝不被完整包覆盖（取最小 index 的错配已消除）');
  const b2 = db.prepare("SELECT received_text FROM reasoning_blocks WHERE block_index = 2 AND attempt_id='a1'").get() as { received_text: string };
  assert.equal(b2.received_text, 'THIRD-RECEIVED');
  db.close();
});

test('AUD-11（v0.3 唯一候选可匹配）：单个同类型开放块时完整包正常核对', () => {
  const { db, feed } = setup();
  for (const raw of fixtureScenario('consistent', '')) feed(raw);
  const b0 = db.prepare("SELECT final_text, state FROM reasoning_blocks WHERE block_index = 0 AND attempt_id='a1'").get() as { final_text: string; state: string };
  assert.equal(b0.final_text?.includes('整理今天的时间线'), true);
  assert.equal(b0.state, 'complete');
  db.close();
});

test('AUD-12：子代理（parent_tool_use_id）thinking 不落入主聊 reasoning', () => {
  const { db, feed } = setup();
  for (const raw of fixtureScenario('subagent', '')) feed(raw);
  const rows = db.prepare("SELECT received_text FROM reasoning_blocks").all() as Array<{ received_text: string }>;
  assert.equal(rows.some((r) => r.received_text.includes('CHILD-AGENT')), false, '子代理思考不得进入主私聊投影');
  db.close();
});

test('AUD-13：超限 delta 截断为 truncated；block_stop 不得伪装 complete；事件只记实际持久文本', () => {
  const { db, events, reasoning } = setup();
  // 复用 events 变量（dispatch 依赖）
  void events;
  const big = 'x'.repeat(262145);
  reasoning.appendDelta({ conversationId: 'c1', turnId: 't', attemptId: 'a13', sdkMessageId: 'm13', blockIndex: 0, text: big, generation: 1 });
  const proj = db.prepare('SELECT received_text, state FROM reasoning_blocks WHERE attempt_id=?', ).get('a13') as { received_text: string; state: string };
  assert.equal(proj.received_text.length, 262144);
  assert.equal(proj.state, 'truncated');
  reasoning.markStreamBlockComplete({ attemptId: 'a13', sdkMessageId: 'm13', blockIndex: 0, generation: 1 });
  const after = db.prepare('SELECT state FROM reasoning_blocks WHERE attempt_id=?').get('a13') as { state: string };
  assert.equal(after.state, 'truncated', 'truncated 单向：block_stop 不得改成 complete');
  const ev = db.prepare("SELECT payload_ref FROM runtime_stream_events WHERE kind='reasoning.delta' ORDER BY sequence DESC LIMIT 1").get() as { payload_ref: string };
  const deltaLen = (JSON.parse(ev.payload_ref) as { payload: { delta?: string } }).payload.delta?.length ?? 0;
  assert.equal(deltaLen, 262144, '事件 delta 长度必须等于实际持久长度（262144）');
  db.close();
});

test('AUD-13：完整块同样受统一限额（300000 → 截断 + storage_limited）', () => {
  const { db, reasoning } = setup();
  reasoning.reconcileCompleteMessage({
    conversationId: 'c1', turnId: 't', attemptId: 'a13b', sdkMessageId: 'm13b',
    matched: [{ block_index: 0, block_type: 'thinking', text: 'y'.repeat(300000), tool_id: null, tool_name: null }],
    unmatched: [], generation: 1,
  });
  const row = db.prepare('SELECT length(received_text) len, state, completeness FROM reasoning_blocks WHERE attempt_id=?').get('a13b') as { len: number; state: string; completeness: string };
  assert.equal(row.len, 262144);
  assert.equal(row.completeness, 'storage_limited');
  db.close();
});

test('AUD-24：content_block_start 自带初始正文只接收一次且不丢失', () => {
  const { db, feed } = setup();
  for (const raw of fixtureScenario('initial_text', '')) feed(raw);
  const think = db.prepare("SELECT received_text, state FROM reasoning_blocks WHERE block_index = 0").get() as { received_text: string; state: string };
  assert.equal(think.received_text, '起始自带正文·后续增量');
  assert.equal(think.state, 'complete');
  db.close();
});
