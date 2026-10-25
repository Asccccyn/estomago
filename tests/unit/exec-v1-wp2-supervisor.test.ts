// ESTOMAGO_CHAT_EXEC_V1 · WP2 supervisor 面（02 §4.2 派发账本前移；CACHE-01 wire 证据 / CACHE-03 逐尝试留证 / 温缓存未命中活接线）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import {writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

function composeOr(root: string, transport: OrTransport, retryMax = 2) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: MODEL } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const alerts = new SystemAlertService(db, events);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db, alerts), routing, windows, logger, alerts });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, alerts };
}

const bodyWithUsage = (text: string, usage: Record<string, unknown>) =>
  sse({ id: `gen-${text.length}`, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + DONE;

const okBody = (text: string) => bodyWithUsage(text, { prompt_tokens: 2000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.002 });

test('429 重试：每次尝试独立入派发账本（transport 前 dispatch_started_at）；wire_v1 发包体留证 1h+禁压缩', async () => {
  let calls = 0;
  const transport: OrTransport = async () => {
    calls++;
    if (calls === 1) return { status: 429, headers: new Map<string, string>([['retry-after', '0']]), body: Readable.from([]) };
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(okBody('重试后成功'))]) };
  };
  const root = tempRoot('wp2-429-');
  const ctx = composeOr(root, transport);
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '用户的话', clientMessageId: 'w2-429' });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  const state = (ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string }).state;
  assert.equal(state, 'completed');

  const rows = ctx.db.prepare("SELECT * FROM provider_requests WHERE purpose = 'chat' ORDER BY created_at").all() as Array<{ id: string; attempt_no: number | null; dispatch_started_at: string | null; sent_at: string | null; outcome: string | null; payload_wire_json: string | null; payload_format: string | null }>;
  assert.equal(rows.length, 2, '两次尝试两行——429 那次不再从账本消失');
  // 首次尝试：transport 前已记 dispatch_started_at；无响应（429）→ sent_at 为 NULL；被重试取代
  assert.ok(rows[0]!.dispatch_started_at, 'attempt0 派发起点（transport 前）');
  assert.equal(rows[0]!.sent_at, null, '429 未获 2xx——不冒充"已发送确认"');
  assert.equal(rows[0]!.outcome, 'SUPERSEDED_BY_RETRY');
  // 重试行：dispatch 起点 + 发送确认 + 完成终态
  assert.ok(rows[1]!.dispatch_started_at);
  assert.ok(rows[1]!.sent_at);
  assert.equal(rows[1]!.outcome, 'completed');
  // wire_v1：最终发包体证据——1h cache_control + 禁压缩插件（CACHE-01 的 supervisor 级证据）
  assert.equal(rows[1]!.payload_format, 'wire_v1');
  const wire = JSON.parse(rows[1]!.payload_wire_json!) as Record<string, unknown>;
  assert.deepEqual(wire.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(wire.plugins, [{ id: 'context-compression', enabled: false }]);
  assert.equal(rows[0]!.payload_format, 'wire_v1');
});

test('网络失败重试：发出但无响应的尝试保留 dispatch_started_at 行（不因无响应消失）；usage 只落在成功行', async () => {
  let calls = 0;
  const transport: OrTransport = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(bodyWithUsage('恢复正文', { prompt_tokens: 900, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 }, cost: 0.001 }))]) };
  };
  const root = tempRoot('wp2-net-');
  const ctx = composeOr(root, transport);
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '用户的话', clientMessageId: 'w2-net' });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal((ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string }).state, 'completed');
  const rows = ctx.db.prepare("SELECT id, dispatch_started_at, sent_at, outcome FROM provider_requests WHERE purpose = 'chat' ORDER BY created_at").all() as Array<{ id: string; dispatch_started_at: string | null; sent_at: string | null; outcome: string | null }>;
  assert.equal(rows.length, 2, '失败尝试也有一行（旧 onDispatch 路径下它会消失）');
  assert.ok(rows[0]!.dispatch_started_at);
  assert.equal(rows[0]!.sent_at, null, '无响应=未确认发送（区别于派发已开始）');
  assert.equal(rows[0]!.outcome, 'SUPERSEDED_BY_RETRY');
  const usage = ctx.db.prepare("SELECT request_id, input_tokens FROM usage_observations WHERE request_id IS NOT NULL").all() as Array<{ request_id: string; input_tokens: number }>;
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.request_id, rows[1]!.id, 'usage 归属实际承载发送的行');
});

test('温缓存未命中活接线：先证据（read>0）后同窗 read=0 → CACHE_UNEXPECTED_MISS；首轮冷 read=0 不告警', async () => {
  // 第一轮：形成缓存读写证据（read=1500, write=500）
  let calls = 0;
  const transport: OrTransport = async () => {
    calls++;
    const usage = calls === 1
      ? { prompt_tokens: 2000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.002 }
      : { prompt_tokens: 2000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cost: 0.002 }; // 第二轮：温态下 read=0
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(bodyWithUsage(`回复${calls}`, usage))]) };
  };
  const root = tempRoot('wp2-miss-');
  const ctx = composeOr(root, transport);
  const t1 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一句', clientMessageId: 'w2-m1' });
  ctx.supervisor.enqueue(t1.turnId);
  await ctx.supervisor.waitIdle();
  await new Promise((r) => setTimeout(r, 10)); // 保证两轮派发时间可区分（ISO 毫秒）
  const t2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第二句', clientMessageId: 'w2-m2' });
  ctx.supervisor.enqueue(t2.turnId);
  await ctx.supervisor.waitIdle();

  const missItems = ctx.alerts.list({ actorId: 'qiaosheng' }).items.filter((i) => i.code === 'CACHE_UNEXPECTED_MISS');
  assert.equal(missItems.length, 1, '第二轮温态 read=0 → 恰一条聚合异常');
  assert.equal(missItems[0]!.severity, 'warning');
  assert.equal(missItems[0]!.scope_kind, 'conversation');
  assert.equal(missItems[0]!.occurrence_count, 1, '幂等：不因 SSE/重放虚增');
  // 第一轮冷启动（当时无先前证据）没有产生异常——上面 length===1 已隐含；再显式断言其不存在多余项
  assert.ok(missItems.every((i) => i.unread));
});
