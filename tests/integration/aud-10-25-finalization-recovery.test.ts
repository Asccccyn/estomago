// AUD-10/25 回归：runner throw / 无 result / 错误 result / 停止 / 重启 —— 全部落确定终态；
// 空流与 error result 绝不 completed；启动 recovery pass 收尾孤儿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex, genId } from '../../apps/host/src/util/id.ts';
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
import type { AgentRunner, RunnerRunRequest, RunnerRunResult } from '../../apps/host/src/runtime/runner.ts';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch, seedProbes } from '../helpers.ts';

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
  const capabilities = new CapabilityMatrix(config);
  const reasoning = new ReasoningService(db, events);
  const usage = new UsageCollector(db);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities, runnerSelection: { status: 'ok', runner }, reasoning, usage, routing, windows, logger });
  messages.ensureConversation('c1');
  return { db, messages, supervisor };
}

function submit(ctx: ReturnType<typeof compose>, cmid: string): { turnId: string; attemptId: string } {
  const r = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: cmid, clientMessageId: cmid });
  const attemptId = (ctx.db.prepare('SELECT id FROM attempts WHERE turn_id = ? ORDER BY attempt_no LIMIT 1').get(r.turnId) as { id: string }).id;
  ctx.supervisor.enqueue(r.turnId);
  return { turnId: r.turnId, attemptId };
}
const states = (ctx: ReturnType<typeof compose>, t: string) => ({
  turn: (ctx.db.prepare('SELECT state FROM turns WHERE id=?').get(t) as { state: string }),
  attempt: (ctx.db.prepare("SELECT state, blocked_reason FROM attempts WHERE turn_id=? AND attempt_no=1").get(t) as { state: string; blocked_reason: string | null }),
});

const throwingRunner: AgentRunner = {
  kind: 'mock', interruptSupport: 'claimed',
  async run(req) {
    req.onEvent({ kind: 'message_start', sdk_message_id: 'mx', model: 'm', session_id: 's', channel: 'main' });
    req.onEvent({ kind: 'thinking_delta', sdk_message_id: 'mx', block_index: 0, text: '崩溃前思考', channel: 'main' });
    throw new Error('AUDIT_SECRET_DO_NOT_LOG_runner_exploded');
  },
};

test('AUD-10：runner throw → turn/attempt=failed（不再永久 running），reasoning 落终态，日志只记错误码', async () => {
  const root = tempRoot('aud10a-');
  const ctx = compose(root, throwingRunner);
  const t = submit(ctx, 'crash1');
  await ctx.supervisor.waitIdle();
  const s = states(ctx, t.turnId);
  assert.equal(s.turn.state, 'failed');
  assert.equal(s.attempt.state, 'failed');
  assert.ok((s.attempt.blocked_reason ?? '').startsWith('RUNNER_THREW') || (s.attempt.blocked_reason ?? '').includes('INTERNAL'), `attempt 终态原因：${s.attempt.blocked_reason}`);
  const block = ctx.db.prepare('SELECT state FROM reasoning_blocks WHERE turn_id=?').get(t.turnId) as { state: string };
  assert.equal(block.state, 'failed', 'streaming 思考不得悬挂');
  await new Promise((r) => setTimeout(r, 300)); // 等日志流落盘
  const log = fs.readFileSync(path.join(root, 'logs/host.log'), 'utf8');
  assert.equal(log.includes('AUDIT_SECRET_DO_NOT_LOG_runner_exploded'), false, '日志不得包含原始错误文本（AUD-28）');
  assert.ok(log.includes('RUNNER_THREW') || log.includes('INTERNAL_ERROR'), '日志应含稳定错误码');
  ctx.db.close();
});

test('AUD-25：无最终 result（空流结束）→ failed/NO_FINAL_RESULT，绝不 completed', async () => {
  const noResultRunner: AgentRunner = {
    kind: 'mock', interruptSupport: 'claimed',
    async run(req) {
      req.onEvent({ kind: 'message_start', sdk_message_id: 'mn', model: 'm', session_id: 's2', channel: 'main' });
      req.onEvent({ kind: 'text_delta', sdk_message_id: 'mn', block_index: 0, text: '没有 result 的正文', channel: 'main' });
      return { outcome: 'no_final_result', errorClassified: null, errorCode: 'NO_FINAL_RESULT', errorMessage: null, sessionId: 's2', requestId: null };
    },
  };
  const root = tempRoot('aud25a-');
  const ctx = compose(root, noResultRunner);
  const t = submit(ctx, 'nr1');
  await ctx.supervisor.waitIdle();
  const s = states(ctx, t.turnId);
  assert.equal(s.turn.state, 'failed', '无 result 不得 completed');
  assert.ok((s.attempt.blocked_reason ?? '').startsWith('NO_FINAL_RESULT'));
  ctx.db.close();
});

test('AUD-25：error result → failed（不再伪装 completed）', async () => {
  const errorRunner: AgentRunner = {
    kind: 'mock', interruptSupport: 'claimed',
    async run(req) {
      req.onEvent({ kind: 'turn_end', outcome: 'error', error_classified: 'network', error_message: 'boom', session_id: 's3', request_id: null });
      return { outcome: 'error', errorClassified: 'network', errorCode: 'SDK_STREAM_ERROR', errorMessage: 'boom', sessionId: 's3', requestId: null };
    },
  };
  const root = tempRoot('aud25b-');
  const ctx = compose(root, errorRunner);
  const t = submit(ctx, 'err1');
  await ctx.supervisor.waitIdle();
  assert.equal(states(ctx, t.turnId).turn.state, 'failed');
  ctx.db.close();
});

test('AUD-10：启动 recovery pass 收尾孤儿 running/streaming（不重跑模型）', () => {
  const root = tempRoot('aud10b-');
  const ctx = compose(root, throwingRunner);
  // 人造孤儿：直接把一个 turn/attempt 置 running + reasoning streaming（等价宿主崩溃残留）
  const msg = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '孤儿', clientMessageId: 'orph' });
  const now = new Date().toISOString();
  ctx.db.prepare("UPDATE turns SET state='running' WHERE id=?").run(msg.turnId);
  ctx.db.prepare("UPDATE attempts SET state='running' WHERE turn_id=?").run(msg.turnId);
  ctx.db.prepare("INSERT INTO reasoning_blocks(id, conversation_id, turn_id, attempt_id, sdk_message_id, block_index, origin, visibility, state, created_at, updated_at) VALUES (?,?,?,?,?,'0','stream','summary','streaming',?,?)")
    .run(genId('rbl'), 'c1', msg.turnId, msg.attemptId, 'orphan', now, now);
  const r = TurnSupervisor.recoveryPass(ctx.db, { warn: () => {} });
  assert.ok(r.turns >= 1 && r.attempts >= 1 && r.blocks >= 1);
  assert.equal((ctx.db.prepare('SELECT state FROM turns WHERE id=?').get(msg.turnId) as { state: string }).state, 'failed');
  assert.equal((ctx.db.prepare('SELECT blocked_reason FROM attempts WHERE id=?').get(msg.attemptId) as { blocked_reason: string }).blocked_reason, 'RECOVERY_HOST_RESTART');
  assert.equal((ctx.db.prepare('SELECT state FROM reasoning_blocks WHERE attempt_id=?').get(msg.attemptId) as { state: string }).state, 'failed');
  ctx.db.close();
});

test('AUD-05 附：route signal 后 fence 生效——迟到气泡/思考不发布，attempt=route_pending', async () => {
  const routeRunner: AgentRunner = {
    kind: 'mock', interruptSupport: 'claimed',
    async run(req) {
      req.onEvent({ kind: 'message_start', sdk_message_id: 'mr', model: 'm', session_id: 's4', channel: 'main' });
      req.onEvent({ kind: 'thinking_delta', sdk_message_id: 'mr', block_index: 0, text: '路由前思考', channel: 'main' });
      req.onEvent({ kind: 'turn_end', outcome: 'error', error_classified: 'route_signal', error_message: 'route_signal: model_switch_requested', session_id: 's4', request_id: null });
      // 迟到增量（fence 之后）：
      req.onEvent({ kind: 'text_delta', sdk_message_id: 'mr', block_index: 1, text: 'AFTER-ROUTE 迟到气泡', channel: 'main' });
      req.onEvent({ kind: 'thinking_delta', sdk_message_id: 'mr', block_index: 0, text: '迟到思考', channel: 'main' });
      return { outcome: 'error', errorClassified: 'route_signal', errorCode: 'SDK_ROUTE_SIGNAL', errorMessage: 'route_signal', sessionId: 's4', requestId: null };
    },
  };
  const root = tempRoot('aud05r-');
  const ctx = compose(root, routeRunner);
  const t = submit(ctx, 'r1');
  await ctx.supervisor.waitIdle();
  const s = states(ctx, t.turnId);
  assert.equal(s.attempt.state, 'route_pending');
  assert.equal(s.turn.state, 'route_pending');
  const lateBubble = ctx.db.prepare("SELECT COUNT(*) n FROM message_revisions r JOIN messages m ON m.id=r.message_id WHERE r.content LIKE '%AFTER-ROUTE%'").get() as { n: number };
  assert.equal(lateBubble.n, 0, 'fence 后迟到气泡不得发布');
  const lateThink = ctx.db.prepare("SELECT received_text FROM reasoning_blocks WHERE turn_id=?").get(t.turnId) as { received_text: string };
  assert.equal(lateThink.received_text.includes('迟到思考'), false, 'fence 后迟到思考不得入投影');
  const ticket = ctx.db.prepare("SELECT COUNT(*) n FROM route_decisions WHERE turn_id=? AND state='pending'").get(t.turnId) as { n: number };
  assert.equal(ticket.n, 1);
  ctx.db.close();
});
