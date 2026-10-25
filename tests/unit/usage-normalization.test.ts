// F15 二轮回归：用量两步归一化。turn 权威、request 去重（source 不进键）、
// 仅 cumulative=unknown、缺观测/partial 不冒充。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import {tempRoot } from '../helpers.ts';

function setup(state: 'completed' | 'failed') {
  const root = tempRoot('usage-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, title, created_at) VALUES ('c1','estomago','private',NULL,'2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, input_message_id, created_at) VALUES ('t1','c1','user_message',?,NULL,'2026-01-01T00:00:00Z')").run(state);
  db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES ('a1','t1',1,1,?)").run(state);
  return { db, usage: new UsageCollector(db) };
}

test('request 100+200 与完整 turn 300 共存 → 总额 300（turn 权威，不双计）', () => {
  const { db, usage } = setup('completed');
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'request', usage: { input_tokens: 100, output_tokens: 10 }, requestId: 'r1', source: 'sdk_result', completeness: 'complete' });
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'request', usage: { input_tokens: 200, output_tokens: 20 }, requestId: 'r2', source: 'sdk_result', completeness: 'complete' });
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'turn', usage: { input_tokens: 300, output_tokens: 30 }, source: 'sdk_result', completeness: 'complete' });
  const s = usage.summaryForTurn('t1');
  assert.equal(s.totals.input_tokens, 300);
  assert.equal(s.totals.output_tokens, 30);
  db.close();
});

test('只有一个 request 100 但有可靠 turn 300 → 总额 300（不因 request 不全舍弃 turn）', () => {
  const { db, usage } = setup('completed');
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'request', usage: { input_tokens: 100, output_tokens: 10 }, requestId: 'r1', source: 'sdk_result', completeness: 'complete' });
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'turn', usage: { input_tokens: 300, output_tokens: 30 }, source: 'sdk_result', completeness: 'complete' });
  const s = usage.summaryForTurn('t1');
  assert.equal(s.totals.input_tokens, 300);
  assert.equal(s.totals.unknown_present, false);
  db.close();
});

test('同请求跨 source（stream partial + result complete）→ 只算一次，值取 complete', () => {
  const { db, usage } = setup('completed');
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'request', usage: { input_tokens: 50, output_tokens: 5 }, requestId: 'r1', source: 'sdk_stream', completeness: 'partial' });
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'request', usage: { input_tokens: 100, output_tokens: 10 }, requestId: 'r1', source: 'sdk_result', completeness: 'complete' });
  const n = db.prepare("SELECT COUNT(*) n FROM usage_observations WHERE attempt_id='a1'").get() as { n: number };
  assert.equal(n.n, 1, '同 (attempt,scope,request_id,model) 只允许一行——source 不进幂等键');
  const s = usage.summaryForTurn('t1');
  assert.equal(s.totals.input_tokens, 100, 'complete 覆盖 partial');
  db.close();
});

test('同请求：迟到 partial 不覆盖已有 complete', () => {
  const { db, usage } = setup('completed');
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'request', usage: { input_tokens: 100, output_tokens: 10 }, requestId: 'r1', source: 'sdk_result', completeness: 'complete' });
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'request', usage: { input_tokens: 40, output_tokens: 4 }, requestId: 'r1', source: 'sdk_stream', completeness: 'partial' });
  const s = usage.summaryForTurn('t1');
  assert.equal(s.totals.input_tokens, 100);
  db.close();
});

test('仅 cumulative=1000/100 → 总额 null/null 且 unknown_present=true（不冒充本轮 0/0）', () => {
  const { db, usage } = setup('completed');
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'cumulative', usage: { input_tokens: 1000, output_tokens: 100 }, source: 'sdk_result', completeness: 'complete' });
  const s = usage.summaryForTurn('t1');
  assert.equal(s.totals.input_tokens, null);
  assert.equal(s.totals.output_tokens, null);
  assert.equal(s.totals.unknown_present, true);
  assert.equal(s.attempts.length, 1, 'cumulative 快照单列展示');
  assert.equal(s.attempts[0]!.scope, 'cumulative');
  db.close();
});

test('无可靠 turn、请求集合不完整（回合未 completed）→ 总额 unknown，观测保留', () => {
  const { db, usage } = setup('failed');
  usage.record({ turnId: 't1', attemptId: 'a1', scope: 'request', usage: { input_tokens: 100, output_tokens: 10 }, requestId: 'r1', source: 'sdk_result', completeness: 'complete' });
  const s = usage.summaryForTurn('t1');
  assert.equal(s.totals.input_tokens, null, '回合未完成时单条 request 完整 ≠ 请求集合完整');
  assert.equal(s.totals.unknown_present, true);
  assert.equal(s.attempts[0]!.input_tokens, 100, '部分观测仍保留可核对');
  db.close();
});

test('声明了 attempt 但零观测 → null 行 + unknown', () => {
  const { db, usage } = setup('failed');
  const s = usage.summaryForTurn('t1');
  assert.equal(s.attempts.length, 1);
  assert.equal(s.attempts[0]!.completeness, 'missing');
  assert.equal(s.totals.unknown_present, true);
  db.close();
});
