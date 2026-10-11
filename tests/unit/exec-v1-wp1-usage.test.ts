// ESTOMAGO_CHAT_EXEC_V1 · WP1 用量归属与字段级归一（05 §6；USAGE-01..06）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { providerInputTotal, shanghaiDayOf, findSettlementBreaches, sweepUsageMissing } from '../../apps/host/src/usage/attribution.ts';

function make() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-v1-usage-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const alerts = new SystemAlertService(db, events);
  const usage = new UsageCollector(db, alerts);
  return { db, events, alerts, usage };
}

function seedTurn(db: ReturnType<typeof openDatabase>, convId = 'conv-u', trigger = 'user_message'): { turnId: string; attemptId: string } {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO conversations(id, created_at) VALUES (?,?) ON CONFLICT(id) DO NOTHING").run(convId, now);
  const turnId = `turn-${trigger}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES (?,?,?,'pending',?)").run(turnId, convId, trigger, now);
  const attemptId = `att-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,1,1,'pending')").run(attemptId, turnId);
  return { turnId, attemptId };
}

function seedWindow(db: ReturnType<typeof openDatabase>): string {
  const id = `win-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?,?,'ACTIVE',?,?)").run(id, 'conv-u', now, now);
  return id;
}

test('USAGE-01：同请求 stream/result 双观测只记一份；矛盾终值隔离并出 USAGE_INCONSISTENT', () => {
  const { db, alerts, usage } = make();
  const { turnId, attemptId } = seedTurn(db);
  // stream 先到（partial），result 后到（complete 终值）——同 attempt+scope+request+model
  usage.record({ turnId, attemptId, scope: 'request', requestId: 'req-1', model: 'anthropic/claude-sonnet-4.5', source: 'or_stream', completeness: 'partial', usage: { input_tokens: 90, output_tokens: 10 } });
  usage.record({ turnId, attemptId, scope: 'request', requestId: 'req-1', model: 'anthropic/claude-sonnet-4.5', source: 'or_stream', completeness: 'complete', usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 } });
  const rows = db.prepare('SELECT * FROM usage_observations').all() as Array<{ input_tokens: number; completeness: string }>;
  assert.equal(rows.length, 1); // 只记一份
  assert.equal(rows[0]!.input_tokens, 100); // 完整终值保留
  assert.equal(rows[0]!.completeness, 'complete');
  // 矛盾终值：另一份 complete 声称 input=50 → 隔离（不覆盖 100），出 warning 告警
  usage.record({ turnId, attemptId, scope: 'request', requestId: 'req-1', model: 'anthropic/claude-sonnet-4.5', source: 'or_stream', completeness: 'complete', usage: { input_tokens: 50, output_tokens: 50 } });
  assert.equal((db.prepare('SELECT input_tokens FROM usage_observations').get() as { input_tokens: number }).input_tokens, 100);
  const inconsistent = alerts.list({ actorId: 'qiaosheng' }).items.find((i) => i.code === 'USAGE_INCONSISTENT');
  assert.ok(inconsistent, '应有 USAGE_INCONSISTENT 告警');
  assert.equal(inconsistent!.severity, 'warning');
  db.close();
});

test('USAGE-02：token 完整与费用未知分开——完整 token 不被清空，cost=unknown 独立表达', () => {
  const { db, usage } = make();
  const { turnId, attemptId } = seedTurn(db);
  db.prepare("UPDATE turns SET state='completed' WHERE id = ?").run(turnId);
  // DS：不返回美元费用——token 完整、cost 未知
  usage.record({ turnId, attemptId, scope: 'request', requestId: null, model: 'deepseek-chat', source: 'ds_stream', completeness: 'complete', usage: { input_tokens: 100, output_tokens: 40 } });
  const s = usage.summaryForTurn(turnId);
  assert.equal(s.totals.fields.input_tokens.complete_total, 140 - 40); // input 完整：100
  assert.equal(s.totals.fields.input_tokens.unknown_count, 0);
  assert.equal(s.totals.fields.cost_usd.complete_total, null); // 费用未知
  assert.equal(s.totals.fields.cost_usd.unknown_count, 1);
  assert.equal(s.totals.fields.cost_usd.known_subtotal, 0);
  // 正常不报美元的能力不制造故障告警（无 USAGE_MISSING/INCONSISTENT）
  db.close();
});

test('USAGE-03：OR 与 SDK 缓存分类不双加——provider 归一化后总输入均 100', () => {
  const or = providerInputTotal({ source: 'or_stream', input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 });
  assert.equal(or, 100); // OR input 已含分类：不是 100+80+20
  const sdk = providerInputTotal({ source: 'sdk_result', input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 });
  assert.equal(sdk, 100); // SDK 原生 input 是未缓存部分：20+80+0
  // SDK 分类未知 → 总输入未知（不猜）
  assert.equal(providerInputTotal({ source: 'sdk_stream', input_tokens: 20, cache_read_input_tokens: null, cache_creation_input_tokens: null }), null);
  assert.equal(providerInputTotal({ source: 'or_stream', input_tokens: null, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 }), null);
  // 端到端：同轮 OR attempt + SDK attempt 各 100 → fields 合计 200（各自正确口径）
  const { db, usage } = make();
  const { turnId, attemptId: a1 } = seedTurn(db);
  usage.record({ turnId, attemptId: a1, scope: 'request', requestId: null, model: 'm1', source: 'or_stream', completeness: 'complete', usage: { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 } });
  const attemptId2 = `att2-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,2,1,'completed')").run(attemptId2, turnId);
  usage.record({ turnId, attemptId: attemptId2, scope: 'request', requestId: null, model: 'm1', source: 'sdk_result', completeness: 'complete', usage: { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 } });
  db.prepare("UPDATE turns SET state='completed' WHERE id = ?").run(turnId);
  const s = usage.summaryForTurn(turnId);
  assert.equal(s.totals.fields.input_tokens.complete_total, 200);
  assert.equal(s.totals.fields.input_tokens.unknown_count, 0);
  db.close();
});

test('USAGE-04/05：无用户消息 turn 的后台费用可归属；budget_day=派发开始上海日；迟到观测不挪日', () => {
  const { db, usage } = make();
  // cache_keepalive 后台跑：有自己的 turn（无用户消息）
  const { turnId, attemptId } = seedTurn(db, 'conv-u', 'cache_keepalive');
  const winId = seedWindow(db);
  // 派发开始 2026-10-10T16:30:00Z = 上海 10-11 00:30 → budget_day=2026-10-11
  const sentAt = '2026-10-10T16:30:00.000Z';
  const requestId = 'preq-keepalive-1';
  db.prepare("INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, outcome, created_at, sent_at) VALUES (?,?,?,?,?,'{}','sent',?,?)")
    .run(requestId, winId, attemptId, turnId, 'cache_keepalive', sentAt, sentAt);
  // 迟到 usage 证据在次日（10-12）到达——不挪到新一天
  usage.record({ turnId, attemptId, scope: 'request', requestId, model: 'm', source: 'or_stream', completeness: 'complete', usage: { input_tokens: 500, output_tokens: 10, cost_usd: 0.002 } });
  const row = db.prepare('SELECT purpose, budget_day, dispatch_started_at, legacy_observed_at FROM usage_observations WHERE request_id = ?').get(requestId) as { purpose: string; budget_day: string; dispatch_started_at: string; legacy_observed_at: number };
  assert.equal(row.purpose, 'cache_keepalive');
  assert.equal(row.budget_day, '2026-10-11'); // 派发时上海日，不是证据时间日
  assert.equal(row.legacy_observed_at, 0);
  // 无请求行的旧观测：budget_day 取证据时间日并标 legacy（不虚构派发时刻）
  const { turnId: t2, attemptId: a2 } = seedTurn(db, 'conv-u', 'chat');
  usage.record({ turnId: t2, attemptId: a2, scope: 'request', requestId: null, model: 'm', source: 'or_stream', completeness: 'complete', usage: { input_tokens: 10 } });
  const legacy = db.prepare('SELECT budget_day, legacy_observed_at FROM usage_observations WHERE request_id IS NULL').get() as { budget_day: string; legacy_observed_at: number };
  assert.equal(legacy.legacy_observed_at, 1);
  // 按日汇总：后台费用按 purpose 可见，不因无用户 turn 消失
  const day = usage.summaryByDay('2026-10-11');
  const keepalive = day.purposes.find((p) => p.purpose === 'cache_keepalive');
  assert.ok(keepalive);
  assert.equal(keepalive!.row_count, 1);
  assert.equal(keepalive!.known_cost_usd, 0.002);
  // 上海日函数边界
  assert.equal(shanghaiDayOf('2026-10-10T15:59:59.000Z'), '2026-10-10');
  assert.equal(shanghaiDayOf('2026-10-10T16:00:00.000Z'), '2026-10-11');
  db.close();
});

test('USAGE-06：结算宽限后 USAGE_MISSING；不发第二次请求确认；有确证才不再报', () => {
  const { db, alerts, usage } = make();
  const { turnId, attemptId } = seedTurn(db, 'conv-u', 'chat');
  const winId = seedWindow(db);
  const sentAt = '2026-10-10T10:00:00.000Z';
  db.prepare("INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, outcome, created_at, sent_at) VALUES (?,?,?,?,?,'{}','sent',?,?)")
    .run('preq-missing-1', winId, attemptId, turnId, 'chat', sentAt, sentAt);
  db.prepare("UPDATE turns SET state='completed' WHERE id = ?").run(turnId);
  const now = '2026-10-10T10:05:00.000Z'; // 5 分钟后 > 宽限默认 60s
  // 尚在宽限内（now=10:00:30）→ 不报
  assert.equal(findSettlementBreaches(db, 60_000, '2026-10-10T10:00:30.000Z').length, 0);
  // 回合未终态 → 不算"已可能执行结束"
  db.prepare("UPDATE turns SET state='running' WHERE id = ?").run(turnId);
  assert.equal(findSettlementBreaches(db, 60_000, now).length, 0);
  db.prepare("UPDATE turns SET state='completed' WHERE id = ?").run(turnId);
  // 宽限过、终态、无 usage → 报；幂等：再 sweep 不重复计数
  assert.equal(sweepUsageMissing(db, alerts, 60_000, now), 1);
  assert.equal(sweepUsageMissing(db, alerts, 60_000, now), 0);
  const item = alerts.list({ actorId: 'qiaosheng' }).items.find((i) => i.code === 'USAGE_MISSING');
  assert.ok(item);
  assert.equal(item!.occurrence_count, 1);
  // 有确证（complete usage 到达）后：不再列入 breach；告警本身由闭环核对后 resolve（无计时器自动 resolve）
  usage.record({ turnId, attemptId, scope: 'request', requestId: 'preq-missing-1', model: 'm', source: 'or_stream', completeness: 'complete', usage: { input_tokens: 5, cost_usd: 0.001 } });
  assert.equal(findSettlementBreaches(db, 60_000, now).length, 0);
  assert.equal(alerts.list({ actorId: 'qiaosheng' }).items.find((i) => i.code === 'USAGE_MISSING')!.lifecycle, 'open'); // 不自动 resolve
  db.close();
});
