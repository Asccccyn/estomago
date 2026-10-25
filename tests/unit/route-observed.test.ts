// F10/F18 二轮回归：SDK 结构化路由事实必须有产品状态与可见动作。
// fallback 已发生 → 事实落账+事件+实际模型记账+暂停；no_fallback → 记录不打断；
// approve 无已验证动作 → 422 且票据不被消耗；route.resolved 携带修订消息供跨端吸收。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
import type { AgentRunner } from '../../apps/host/src/runtime/runner.ts';
import {writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

function compose(root: string, runner: AgentRunner) {
  writeApprovedIdentity(root);
  const config = buildConfig(readyRuntimePatch());
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, events, routing, supervisor };
}

const fallbackRunner: AgentRunner = {
  kind: 'mock', interruptSupport: 'claimed',
  async run(req) {
    req.onEvent({ kind: 'message_start', sdk_message_id: 'm1', model: 'fixture-model', session_id: 's1', channel: 'main' });
    // usage 先按原模型来一笔
    req.onEvent({ kind: 'usage', scope: 'turn', usage: { input_tokens: 10, output_tokens: 1 }, source: 'sdk_result', completeness: 'complete' });
    req.onEvent({ kind: 'system_notice', subtype: 'model_refusal_fallback', content: 'fallback happened', original_model: 'fixture-model', fallback_model: 'fallback-model-x', session_id: 's1' });
    // 切换通知后 runner 应被 abort；若 runner 不合作继续投正文，fence 必须挡住
    req.onEvent({ kind: 'complete_message', sdk_message_id: 'm1', session_id: 's1', channel: 'main',
      matched: [], unmatched: [{ seq: -1, block_type: 'text', text: '切换后迟到正文', reason: 'no_open_block' }], packet_uuid: 'pu-f1' });
    // 切换后再来一笔 usage —— 应记 fallback 模型
    req.onEvent({ kind: 'usage', scope: 'turn', usage: { input_tokens: 99, output_tokens: 9 }, source: 'sdk_result', completeness: 'complete' });
    return { outcome: 'completed', errorClassified: null, errorCode: null, errorMessage: null, sessionId: 's1', requestId: null };
  },
};

test('fallback 已发生：事实落账+route.observed 事件+实际模型记账+暂停（迟到正文被挡）', async () => {
  const root = tempRoot('fb-');
  const ctx = compose(root, fallbackRunner);
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '触发fallback', clientMessageId: 'fb1' });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();

  const evt = ctx.db.prepare("SELECT * FROM sdk_route_events WHERE turn_id = ?").get(t.turnId) as { subtype: string; original_model: string | null; actual_model: string | null } | undefined;
  assert.ok(evt, 'sdk_route_events 必须有行');
  assert.equal(evt.subtype, 'model_refusal_fallback');
  assert.equal(evt.original_model, 'fixture-model');
  assert.equal(evt.actual_model, 'fallback-model-x');

  const observed = ctx.db.prepare("SELECT COUNT(*) n FROM runtime_stream_events WHERE kind = 'route.observed' AND turn_id = ?").get(t.turnId) as { n: number };
  assert.equal(observed.n, 1, 'route.observed 事件必须持久化且可回放');

  const turn = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string };
  const att = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE turn_id = ? AND attempt_no = 1').get(t.turnId) as { state: string; blocked_reason: string | null };
  assert.equal(turn.state, 'interrupted', '切换已发生 → 回合暂停收口');
  assert.equal(att.state, 'interrupted');
  assert.equal(att.blocked_reason, 'MODEL_FALLBACK_SWITCHED');

  const lateBody = ctx.db.prepare("SELECT COUNT(*) n FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.conversation_id='c1' AND m.speaker='assistant' AND r.content LIKE '%切换后迟到正文%'").get() as { n: number };
  assert.equal(lateBody.n, 0, '切换后的迟到正文不得发布');

  const usageModels = ctx.db.prepare('SELECT DISTINCT model FROM usage_observations WHERE turn_id = ? ORDER BY model').all(t.turnId) as Array<{ model: string | null }>;
  assert.deepEqual(usageModels.map((m) => m.model), ['fallback-model-x', 'fixture-model'], 'usage 必须同时含原模型与实际模型的真实观测');
  ctx.db.close();
});

test('no_fallback：记录为"拒绝未切换"，不打断回合', async () => {
  const noFallbackRunner: AgentRunner = {
    kind: 'mock', interruptSupport: 'claimed',
    async run(req) {
      req.onEvent({ kind: 'system_notice', subtype: 'model_refusal_no_fallback', content: 'refused', original_model: 'fixture-model', fallback_model: null, session_id: 's1' });
      req.onEvent({ kind: 'complete_message', sdk_message_id: 'm1', session_id: 's1', channel: 'main',
        matched: [], unmatched: [{ seq: -1, block_type: 'text', text: '拒绝前的正文。', reason: 'no_open_block' }], packet_uuid: 'pu-nf1' });
      return { outcome: 'error', errorClassified: 'refusal', errorCode: 'REFUSED', errorMessage: 'refused', sessionId: 's1', requestId: null };
    },
  };
  const root = tempRoot('nf-');
  const ctx = compose(root, noFallbackRunner);
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '被拒绝', clientMessageId: 'nf1' });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  const evt = ctx.db.prepare('SELECT subtype, actual_model FROM sdk_route_events WHERE turn_id = ?').get(t.turnId) as { subtype: string; actual_model: string | null };
  assert.equal(evt.subtype, 'model_refusal_no_fallback');
  assert.equal(evt.actual_model, null, 'no_fallback 不得伪造成已切换');
  const turn = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string };
  assert.equal(turn.state, 'failed', '拒绝按回合失败自然收口（不是 interrupted）');
  ctx.db.close();
});

test('approve：服务层消费建 fresh_session=0 新 attempt；route.resolved 如实携带', async () => {
  const root = tempRoot('rappr-');
  const ctx = compose(root, { kind: 'mock', interruptSupport: 'claimed', async run() { return { outcome: 'completed', errorClassified: null, errorCode: null, errorMessage: null, sessionId: 's', requestId: null }; } });
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '原文', clientMessageId: 'rap1' });
  const msg = ctx.messages.getMessage(t.message.id)!;
  const row = ctx.routing.createPending({ conversationId: 'c1', turnId: t.turnId, attemptId: t.attemptId, inputHash: msg.revision.content_hash, targetModel: null, evidenceCode: 'TEST', messageId: msg.id, inputRevision: msg.current_revision });
  const consumed = ctx.routing.validateAndConsume(row.id, { choice: 'approve' });
  assert.ok(consumed.ok, 'approve 消费应成功');
  const na = ctx.db.prepare('SELECT fresh_session, state FROM attempts WHERE id = ?').get(consumed.newAttemptId) as { fresh_session: number; state: string };
  assert.equal(na.fresh_session, 0, 'approve 续用原 session（与 edit 的 fresh_session=1 相对；工具继续态不重放）');
  assert.equal(na.state, 'pending', '新 attempt 待驱动');
  const turnRow = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string };
  assert.equal(turnRow.state, 'pending', 'turn 回 pending 等待续跑');
  const evt = ctx.db.prepare("SELECT payload_ref FROM runtime_stream_events WHERE kind = 'route.resolved' AND turn_id = ? ORDER BY sequence DESC LIMIT 1").get(t.turnId) as { payload_ref: string };
  const payload = JSON.parse(evt.payload_ref) as { choice?: string; new_attempt_id?: string | null };
  assert.equal(payload.choice, 'approve', '决议事件如实记录选择');
  assert.equal(payload.new_attempt_id, consumed.newAttemptId, '事件携带新 attempt 供跨端跟踪');
  ctx.db.close();
});

test('route.resolved(edit) 携带修订后消息 dto（跨端吸收依据）', async () => {
  const root = tempRoot('redit-');
  const ctx = compose(root, { kind: 'mock', interruptSupport: 'claimed', async run() { return { outcome: 'completed', errorClassified: null, errorCode: null, errorMessage: null, sessionId: 's', requestId: null }; } });
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '原文', clientMessageId: 're1' });
  const msg = ctx.messages.getMessage(t.message.id)!;
  const row = ctx.routing.createPending({ conversationId: 'c1', turnId: t.turnId, attemptId: t.attemptId, inputHash: msg.revision.content_hash, targetModel: null, evidenceCode: 'TEST', messageId: msg.id, inputRevision: msg.current_revision });
  const consumed = ctx.routing.validateAndConsume(row.id, { choice: 'edit', content: '修订后的正文' });
  assert.ok(consumed.ok, 'edit 消费应成功');
  const evt = ctx.db.prepare("SELECT payload_ref FROM runtime_stream_events WHERE kind = 'route.resolved' AND turn_id = ? ORDER BY sequence DESC LIMIT 1").get(t.turnId) as { payload: string };
  const payload = JSON.parse(evt.payload_ref) as { message?: { id: string; current_revision: number; revision: { content: string } }; new_attempt_id?: string };
  assert.ok(payload.message, 'resolved 事件必须携带修订后消息');
  assert.equal(payload.message.id, msg.id);
  assert.equal(payload.message.revision.content, '修订后的正文');
  // 新 attempt 必须 fresh_session=1（不 resume 旧 session）
  const na = ctx.db.prepare('SELECT fresh_session FROM attempts WHERE id = ?').get(payload.new_attempt_id) as { fresh_session: number };
  assert.equal(na.fresh_session, 1, 'route-edit 的新 attempt 必须标记 fresh_session');
  ctx.db.close();
});
