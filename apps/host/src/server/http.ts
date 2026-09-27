// HTTP 路由 + SSE v0.2.2（AUD-06/08/09/29/15/28 修复）：
//  - 提交走 submitUserMessageWithTurn（单事务：消息+outbox+turn+attempt；幂等含自愈）。
//  - SSE：Last-Event-ID 优先于 query cursor；回放到连接时高水位分页追平后进 live，无空洞；
//    res.write 背压（drain 等待 + 待发字节上限 + 超时断开）。
//  - route-decisions：先验证后事务消费；非法请求不消耗票据。
//  - 错误日志只记稳定错误码（AUD-28）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema.ts';
import type { EstomagoPaths } from '../config/paths.ts';
import type { Db } from '../db/connection.ts';
import type { Logger } from '../observability/logging.ts';
import { stableErrorCode } from '../observability/errors.ts';
import type { EventService, SseSubscriber } from '../events/service.ts';
import type { MessageService } from '../messages/service.ts';
import type { IdentityService } from '../identity/service.ts';
import type { CapabilityMatrix } from '../runtime/capabilities.ts';
import type { RunnerSelection } from '../runtime/runner.ts';
import type { ReasoningService } from '../reasoning/service.ts';
import type { UsageCollector } from '../usage/collector.ts';
import type { RoutingService } from '../routing/service.ts';
import type { WindowManager } from '../windows/manager.ts';
import type { TurnSupervisor } from '../runtime/supervisor.ts';
import type { AuthService } from '../auth/tokens.ts';
import { buildReadyReport } from '../observability/health.ts';
import { buildTimeContext } from '../time/context.ts';
import { genId } from '../util/id.ts';
import type { SubmitMessageRequest } from '../../../../packages/contracts/src/api.ts';
import { PRIMARY_CONVERSATION } from '../app-context.ts';

export type RequestDeps = {
  config: Config;
  paths: EstomagoPaths;
  db: Db;
  logger: Logger;
  events: EventService;
  messages: MessageService;
  identity: IdentityService;
  capabilities: CapabilityMatrix;
  runnerSelection: RunnerSelection;
  reasoning: ReasoningService;
  usage: UsageCollector;
  routing: RoutingService;
  windows: WindowManager;
  supervisor: TurnSupervisor;
  auth: AuthService;
};

const WEB_DIR = path.resolve(import.meta.dirname, '../../../web/src');
const SSE_PAGE_LIMIT = 1000;
const SSE_MAX_PENDING_BYTES = 8 * 1024 * 1024; // 慢客户端待发字节上限（超限断开重连）
const SSE_DRAIN_TIMEOUT_MS = 20_000;

export async function handleRequest(req: IncomingMessage, res: ServerResponse, d: RequestDeps): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /health/live') return json(res, 200, { status: 'ok' });
    if (route === 'GET /health/ready') {
      const report = buildReadyReport({
        config: d.config, gate: d.identity.evaluateGate(d.db),
        runnerSelection: d.runnerSelection, capabilities: d.capabilities, db: d.db,
      });
      return json(res, 200, report);
    }
    if (route === 'POST /api/v1/auth/login') {
      const body = (await readJson(req, d)) as { token?: string };
      if (!d.auth.verifyToken(typeof body.token === 'string' ? body.token : null)) {
        return json(res, 401, { error: { code: 'unauthorized', message: 'token 不正确' } });
      }
      res.setHeader('Set-Cookie', `estomago_session=${encodeURIComponent(body.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      return json(res, 200, { ok: true });
    }
    if (route === 'GET /' || route === 'GET /app.js' || route === 'GET /style.css' || route === 'GET /composer-logic.js') {
      return serveStatic(res, url.pathname);
    }

    if (!d.auth.isAuthorized(req)) {
      return json(res, 401, { error: { code: 'unauthorized', message: '需要认证' } });
    }
    const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
    if (mutating && !d.auth.originAllowed(req, String(req.headers.host ?? ''))) {
      return json(res, 403, { error: { code: 'bad_origin', message: 'Origin 校验失败' } });
    }

    if (route === 'GET /api/v1/conversations') {
      const rows = d.db.prepare('SELECT id, scope, title, created_at FROM conversations ORDER BY created_at').all();
      return json(res, 200, { conversations: rows });
    }

    const convMsgs = /^GET \/api\/v1\/conversations\/([^/]+)\/messages$/.exec(route);
    if (convMsgs) {
      const conversationId = decodeURIComponent(convMsgs[1]!);
      const after = Number(url.searchParams.get('after') ?? '0') || 0;
      const limit = Number(url.searchParams.get('limit') ?? '100') || 100;
      return json(res, 200, { messages: d.messages.listMessages({ conversationId, afterSequence: after, limit }) });
    }

    const postMsgs = /^POST \/api\/v1\/conversations\/([^/]+)\/messages$/.exec(route);
    if (postMsgs) {
      const conversationId = decodeURIComponent(postMsgs[1]!);
      const idempotencyKey = String(req.headers['idempotency-key'] ?? '');
      const body = (await readJson(req, d)) as Partial<SubmitMessageRequest>;
      const clientMessageId = body.client_message_id ?? idempotencyKey;
      if (!clientMessageId) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 client_message_id / Idempotency-Key' } });
      if (typeof body.content !== 'string') return json(res, 400, { error: { code: 'bad_content', message: 'content 必须是字符串（多行正文整体提交，不拆分）' } });
      d.messages.ensureConversation(conversationId);
      let submitted;
      try {
        submitted = d.messages.submitUserMessageWithTurn({ conversationId, content: body.content, clientMessageId, occurredAt: body.occurred_at ?? null });
      } catch (err) {
        if ((err as Error).message.includes('仅空白')) return json(res, 422, { error: { code: 'blank_content', message: (err as Error).message } });
        throw err;
      }
      if (!submitted.duplicate) {
        const message = d.messages.getMessage(submitted.message.id)!;
        d.events.publish('message.persisted', { conversationId, turnId: submitted.turnId, entityRef: message.id, entityRevision: message.sequence, payload: { message } });
        d.events.publish('turn.started', { conversationId, turnId: submitted.turnId, attemptId: submitted.attemptId, payload: {} });
        d.supervisor.enqueue(submitted.turnId);
      }
      return json(res, submitted.duplicate ? 200 : 201, { message: submitted.message, duplicate: submitted.duplicate, turn_id: submitted.turnId, repaired: submitted.repaired });
    }

    if (route === 'GET /api/v1/events') {
      return handleSse(req, res, d, url);
    }

    const reasoning = /^GET \/api\/v1\/turns\/([^/]+)\/reasoning$/.exec(route);
    if (reasoning) {
      const turnId = decodeURIComponent(reasoning[1]!);
      const attemptId = url.searchParams.get('attempt_id');
      return json(res, 200, { blocks: d.reasoning.listForTurn(turnId, attemptId) });
    }

    const stopTurn = /^POST \/api\/v1\/turns\/([^/]+)\/stop$/.exec(route);
    if (stopTurn) {
      const turnId = decodeURIComponent(stopTurn[1]!);
      const result = d.supervisor.stop(turnId);
      return json(res, result.stopped ? 200 : 409, { ...result, note: result.stopped ? '已 fence 当前代并请求中断' : '无活动代（可能已结束）' });
    }

    const rotate = /^POST \/api\/v1\/windows\/([^/]+)\/rotate$/.exec(route);
    if (rotate) {
      const windowId = decodeURIComponent(rotate[1]!);
      const win = d.windows.get(windowId);
      if (!win) return json(res, 404, { error: { code: 'not_found', message: '窗口不存在' } });
      const maxRow = d.db.prepare('SELECT COALESCE(MAX(sequence),0) AS m FROM messages WHERE conversation_id = ?').get(win.conversation_id) as { m: number };
      const result = d.windows.rotate({ conversationId: win.conversation_id, gate: d.identity.evaluateGate(d.db), maxSequence: maxRow.m });
      return json(res, result.ok ? 200 : 409, result.ok ? { window: result.window } : { error: { code: 'rotate_blocked', message: result.reason } });
    }

    const runtime = /^GET \/api\/v1\/conversations\/([^/]+)\/runtime$/.exec(route);
    if (runtime) {
      const conversationId = decodeURIComponent(runtime[1]!);
      const gate = d.identity.evaluateGate(d.db);
      const active = d.windows.activeWindow(conversationId);
      return json(res, 200, {
        conversation_id: conversationId,
        identity: { state: gate.state, reasons: gate.reasons, manifest_status: gate.manifest?.status ?? null },
        runner: d.runnerSelection.status === 'ok' ? { kind: d.runnerSelection.runner.kind } : { blocked: d.runnerSelection.reasons },
        capabilities: d.capabilities.describe(),
        active_window: active ? { id: active.id, status: active.status, sdk_session_bound: Boolean(active.sdk_session_id) } : null,
        thresholds: { status: d.config.windows.threshold_status, model_context_capacity: d.config.windows.model_context_capacity },
        reasoning_label: d.config.reasoning.label,
      });
    }

    const routeDecision = /^POST \/api\/v1\/route-decisions\/([^/]+)$/.exec(route);
    if (routeDecision) {
      const decisionId = decodeURIComponent(routeDecision[1]!);
      const body = (await readJson(req, d)) as { choice?: string; content?: string };
      if (body.choice !== 'approve' && body.choice !== 'edit' && body.choice !== 'cancel') {
        return json(res, 400, { error: { code: 'bad_choice', message: 'choice 必须是 approve/edit/cancel' } });
      }
      // AUD-06：先完整验证（RoutingService.validateAndConsume），非法请求票据不受影响
      const consumed = d.routing.validateAndConsume(decisionId, body.choice === 'edit' ? { choice: 'edit', content: String(body.content ?? '') } : { choice: body.choice });
      if (!consumed.ok) return json(res, consumed.status, { error: { code: consumed.code, message: consumed.reason } });
      // 决议完成：重新驱动该房间排队的 turn（AUD-05）
      d.supervisor.requeueConversationQueuedTurns(consumed.row.conversation_id);
      if (body.choice === 'edit') {
        const turn = d.db.prepare('SELECT input_message_id FROM turns WHERE id = ?').get(consumed.turnId) as { input_message_id: string | null };
        const message = turn?.input_message_id ? d.messages.getMessage(turn.input_message_id) : null;
        return json(res, 200, { resolved: 'edit', message, attempt_id: consumed.newAttemptId, revision: consumed.editRevision });
      }
      if (body.choice === 'approve') {
        return json(res, 200, { resolved: 'approve', attempt_id: consumed.newAttemptId, note: 'continue_capability=unknown：按新 attempt 重跑本输入，不代表平台级路由动作已执行' });
      }
      return json(res, 200, { resolved: 'cancel' });
    }

    if (route === 'GET /api/v1/time/context') {
      const conversationId = url.searchParams.get('conversation_id') ?? PRIMARY_CONVERSATION;
      return json(res, 200, buildTimeContext(d.db, { conversationId, config: d.config }));
    }

    const usageTurn = /^GET \/api\/v1\/turns\/([^/]+)\/usage$/.exec(route);
    if (usageTurn) {
      return json(res, 200, d.usage.summaryForTurn(decodeURIComponent(usageTurn[1]!)));
    }

    const getTurn = /^GET \/api\/v1\/turns\/([^/]+)$/.exec(route);
    if (getTurn) {
      const turnId = decodeURIComponent(getTurn[1]!);
      const turn = d.db.prepare('SELECT id, conversation_id, state, trigger, input_message_id, generation, created_at, completed_at FROM turns WHERE id = ?').get(turnId);
      if (!turn) return json(res, 404, { error: { code: 'not_found', message: 'turn 不存在' } });
      const attempts = d.db.prepare('SELECT id, attempt_no, state, blocked_reason, input_revision, window_id FROM attempts WHERE turn_id = ? ORDER BY attempt_no').all(turnId);
      const pendingDecision = d.db.prepare("SELECT id, state, target_model FROM route_decisions WHERE turn_id = ? AND state = 'pending'").get(turnId) ?? null;
      return json(res, 200, { turn, attempts, pending_route_decision: pendingDecision });
    }

    return json(res, 404, { error: { code: 'not_found', message: `未知路由：${route}` } });
  } catch (err) {
    // AUD-28：日志只记稳定错误码 + 路由，不落原始异常文本
    d.logger.error('route_error', { route, code: stableErrorCode(err) });
    if (!res.headersSent) return json(res, 500, { error: { code: 'internal', message: '内部错误（错误码见日志）' } });
    res.end();
  }
}

// —— SSE v0.2.2 ——
// 优先级（AUD-09）：Last-Event-ID（浏览器自动重连的标准恢复游标） > query cursor（仅显式初始化）。
// 回放（AUD-08）：连接时记录高水位，分页追平到高水位后才进 live；期间新事件由订阅队列承接
//（先订阅后回放），客户端以 sequence 去重 → 无漏、无重复、无空洞。
// 背压（AUD-29）：res.write false → 等 drain（带超时）；待发字节超上限 → 断开（客户端按游标重连）。
function handleSse(req: IncomingMessage, res: ServerResponse, d: RequestDeps, url: URL): void {
  const conversationId = url.searchParams.get('conversation_id');
  const lastEventIdHeader = req.headers['last-event-id'];
  let cursor: number;
  if (typeof lastEventIdHeader === 'string' && lastEventIdHeader !== '') {
    cursor = Number(lastEventIdHeader) || 0; // 标准恢复游标优先
  } else {
    cursor = Number(url.searchParams.get('cursor') ?? '0') || 0;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n');

  let pendingBytes = 0;
  let writeBlocked = false;
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (sub) d.events.unsubscribe(sub);
    clearInterval(flushTimer);
    clearInterval(beat);
    try { res.end(); } catch { /* 已断 */ }
  };

  // 先订阅（承接回放期间的 live 事件），再分页追平到高水位
  const sub: SseSubscriber = d.events.subscribe(conversationId, () => {
    res.write(': overflow\n\n');
    finish();
  });
  const highWater = d.events.maxSequence();

  const writeFrame = (row: { sequence: number; kind: string; payload_ref?: string; payload?: string; conversation_id: string | null; turn_id: string | null; attempt_id: string | null }): boolean => {
    if (closed) return true;
    const payloadRaw = row.payload_ref ?? row.payload ?? '{}';
    const body = JSON.stringify({
      sequence: row.sequence, kind: row.kind,
      conversation_id: row.conversation_id, turn_id: row.turn_id, attempt_id: row.attempt_id,
      ...JSON.parse(payloadRaw),
    });
    const frame = `id: ${row.sequence}\ndata: ${body}\n\n`;
    const ok = res.write(frame);
    if (!ok) {
      writeBlocked = true;
      pendingBytes += frame.length;
      const onDrain = (): void => { writeBlocked = false; };
      res.once('drain', onDrain);
      setTimeout(() => { res.removeListener('drain', onDrain); }, SSE_DRAIN_TIMEOUT_MS); // 超时兜底：仍阻塞则由字节上限/心跳断开
    } else {
      pendingBytes += frame.length;
    }
    if (pendingBytes > SSE_MAX_PENDING_BYTES) {
      res.write(': slow_client_disconnect\n\n');
      finish();
      return false;
    }
    return true;
  };

  // 回放追平（分页，AUD-08）
  let replayCursor = cursor;
  for (;;) {
    const page = d.events.replayPage(replayCursor, conversationId, SSE_PAGE_LIMIT);
    for (const row of page) {
      if (row.sequence > highWater) break; // 只追平到连接时高水位，之后的由订阅队列承接
      if (!writeFrame(row)) { finish(); return; }
      replayCursor = row.sequence;
    }
    if (page.length < SSE_PAGE_LIMIT || replayCursor >= highWater) break;
  }
  res.write(`: replayed cursor=${replayCursor}\n\n`);

  const flushTimer = setInterval(() => {
    if (writeBlocked || closed) return; // 背压：等 drain，不向 socket 无限堆数据（AUD-29）
    while (sub.queue.length > 0) {
      const item = sub.queue.shift()!;
      if (item.sequence <= replayCursor) continue; // 已在回放中发过
      if (!writeFrame(item)) return;
      replayCursor = item.sequence;
    }
    pendingBytes = Math.max(0, pendingBytes - 65536); // 粗略回收：socket 已 flush 的部分
  }, 25);
  const beat = setInterval(() => {
    if (!closed) {
      const ok = res.write(': ping\n\n');
      if (!ok) pendingBytes += 8;
    }
  }, 15000);
  req.on('close', finish);
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const file = pathname === '/' ? path.join(WEB_DIR, 'index.html') : path.join(WEB_DIR, path.basename(pathname));
  try {
    const content = fs.readFileSync(file);
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: '静态资源不存在' } }));
  }
}

async function readJson(req: IncomingMessage, d: RequestDeps): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 5 * 1024 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
