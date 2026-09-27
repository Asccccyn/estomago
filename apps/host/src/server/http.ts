// HTTP 路由 + SSE（01 §17 拟新增接口的 v0 子集）。
// 纪律：401/403 不泄露原因细节；POST 校验 Origin；SSE 按持久 sequence 回放去重；
// 错误统一 {error:{code,message}}；/health 只给脱敏状态。
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema.ts';
import type { EstomagoPaths } from '../config/paths.ts';
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import type { Logger } from '../observability/logging.ts';
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

export async function handleRequest(req: IncomingMessage, res: ServerResponse, d: RequestDeps): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    // —— 无鉴权端点 ——
    if (route === 'GET /health/live') return json(res, 200, { status: 'ok' });
    if (route === 'GET /health/ready') {
      const report = buildReadyReport({
        config: d.config,
        gate: d.identity.evaluateGate(),
        runnerSelection: d.runnerSelection,
        capabilities: d.capabilities,
        db: d.db,
      });
      return json(res, 200, report);
    }
    if (route === 'POST /api/v1/auth/login') {
      const body = (await readJson(req)) as { token?: string };
      if (!d.auth.verifyToken(typeof body.token === 'string' ? body.token : null)) {
        return json(res, 401, { error: { code: 'unauthorized', message: 'token 不正确' } });
      }
      res.setHeader('Set-Cookie', `estomago_session=${encodeURIComponent(body.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      return json(res, 200, { ok: true });
    }
    if (route === 'GET /' || route === 'GET /app.js' || route === 'GET /style.css' || route === 'GET /composer-logic.js') {
      return serveStatic(res, url.pathname);
    }

    // —— 鉴权 ——
    if (!d.auth.isAuthorized(req)) {
      return json(res, 401, { error: { code: 'unauthorized', message: '需要认证（POST /api/v1/auth/login 或 Authorization: Bearer）' } });
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
      const body = (await readJson(req)) as Partial<SubmitMessageRequest>;
      const clientMessageId = body.client_message_id ?? idempotencyKey;
      if (!clientMessageId) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 client_message_id / Idempotency-Key' } });
      if (typeof body.content !== 'string') return json(res, 400, { error: { code: 'bad_content', message: 'content 必须是字符串（多行正文整体提交，不拆分）' } });
      d.messages.ensureConversation(conversationId);
      let submitted;
      try {
        submitted = d.messages.submitUserMessage({ conversationId, content: body.content, clientMessageId, occurredAt: body.occurred_at ?? null });
      } catch (err) {
        if ((err as Error).message.includes('仅空白')) return json(res, 422, { error: { code: 'blank_content', message: (err as Error).message } });
        throw err;
      }
      let turnId: string | null = null;
      if (!submitted.duplicate) {
        turnId = await createTurnForMessage(d, conversationId, submitted.message.id, submitted.message.current_revision);
      } else {
        const t = d.db.prepare('SELECT id FROM turns WHERE input_message_id = ? ORDER BY created_at DESC LIMIT 1').get(submitted.message.id) as { id: string } | undefined;
        turnId = t?.id ?? null;
      }
      // 建 turn 后重取 DTO：响应里的 turn_id 与库一致
      const message = d.messages.getMessage(submitted.message.id) ?? submitted.message;
      return json(res, submitted.duplicate ? 200 : 201, { message, duplicate: submitted.duplicate, turn_id: turnId });
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
      const result = d.windows.rotate({ conversationId: win.conversation_id, gate: d.identity.evaluateGate(), maxSequence: maxRow.m });
      return json(res, result.ok ? 200 : 409, result.ok ? { window: result.window } : { error: { code: 'rotate_blocked', message: result.reason } });
    }

    const runtime = /^GET \/api\/v1\/conversations\/([^/]+)\/runtime$/.exec(route);
    if (runtime) {
      const conversationId = decodeURIComponent(runtime[1]!);
      const gate = d.identity.evaluateGate();
      const active = d.windows.activeWindow(conversationId);
      return json(res, 200, {
        conversation_id: conversationId,
        identity: { state: gate.state, reasons: gate.reasons, manifest_status: gate.manifest?.status ?? null },
        runner: d.runnerSelection.status === 'ok' ? { kind: d.runnerSelection.runner.kind } : { blocked: d.runnerSelection.reasons },
        capabilities: d.capabilities.describe(),
        active_window: active ? { id: active.id, status: active.status } : null,
        thresholds: { status: d.config.windows.threshold_status, model_context_capacity: d.config.windows.model_context_capacity },
        reasoning_label: d.config.reasoning.label,
      });
    }

    const routeDecision = /^POST \/api\/v1\/route-decisions\/([^/]+)$/.exec(route);
    if (routeDecision) {
      const decisionId = decodeURIComponent(routeDecision[1]!);
      const body = (await readJson(req)) as { choice?: string; content?: string; client_message_id?: string };
      if (body.choice !== 'approve' && body.choice !== 'edit' && body.choice !== 'cancel') {
        return json(res, 400, { error: { code: 'bad_choice', message: 'choice 必须是 approve/edit/cancel' } });
      }
      const decision = d.routing.get(decisionId);
      if (!decision) return json(res, 404, { error: { code: 'not_found', message: '票据不存在' } });
      const consumed = d.routing.consume(decisionId, body.choice);
      if (!consumed.ok) return json(res, 409, { error: { code: 'already_consumed', message: consumed.reason } });

      if (body.choice === 'cancel') {
        tx(d.db, () => {
          d.db.prepare("UPDATE attempts SET state = 'blocked', blocked_reason = 'route_cancelled', completed_at = ? WHERE id = ?").run(new Date().toISOString(), decision.attempt_id);
          d.db.prepare("UPDATE turns SET state = 'blocked', completed_at = ? WHERE id = ?").run(new Date().toISOString(), decision.turn_id);
        });
        d.events.publish('turn.status', { conversationId: decision.conversation_id, turnId: decision.turn_id, attemptId: decision.attempt_id, payload: { state: 'blocked', reason: 'route_cancelled' } });
        return json(res, 200, { resolved: 'cancel' });
      }

      if (body.choice === 'edit') {
        if (typeof body.content !== 'string' || !body.client_message_id) {
          return json(res, 400, { error: { code: 'bad_edit', message: 'edit 需要 content 与 client_message_id' } });
        }
        const turn = d.db.prepare('SELECT input_message_id FROM turns WHERE id = ?').get(decision.turn_id) as { input_message_id: string | null } | undefined;
        if (!turn?.input_message_id) return json(res, 409, { error: { code: 'no_input_message', message: '无原始输入消息可编辑' } });
        const edited = d.messages.editUserMessage(turn.input_message_id, body.content);
        const attemptId = d.supervisor.createAttempt(decision.turn_id, edited.current_revision);
        d.supervisor.enqueue(decision.turn_id);
        return json(res, 200, { resolved: 'edit', message: edited, attempt_id: attemptId });
      }

      // approve：continue_capability=unknown —— 只能创建新 attempt 重跑本轮输入，不假装调用了平台级"继续"
      const attempt = d.db.prepare('SELECT input_revision FROM attempts WHERE id = ?').get(decision.attempt_id) as { input_revision: number | null } | undefined;
      const attemptId = d.supervisor.createAttempt(decision.turn_id, attempt?.input_revision ?? null);
      d.supervisor.enqueue(decision.turn_id);
      return json(res, 200, { resolved: 'approve', attempt_id: attemptId, note: 'continue_capability=unknown：按新 attempt 重跑，不代表平台级路由动作已执行' });
    }

    if (route === 'GET /api/v1/time/context') {
      const conversationId = url.searchParams.get('conversation_id') ?? PRIMARY_CONVERSATION;
      return json(res, 200, buildTimeContext(d.db, { conversationId, config: d.config }));
    }

    const usageTurn = /^GET \/api\/v1\/turns\/([^/]+)\/usage$/.exec(route);
    if (usageTurn) {
      return json(res, 200, { usage: d.usage.summaryForTurn(decodeURIComponent(usageTurn[1]!)) });
    }

    const getTurn = /^GET \/api\/v1\/turns\/([^/]+)$/.exec(route);
    if (getTurn) {
      const turnId = decodeURIComponent(getTurn[1]!);
      const turn = d.db.prepare('SELECT id, conversation_id, state, trigger, input_message_id, generation, created_at, completed_at FROM turns WHERE id = ?').get(turnId);
      if (!turn) return json(res, 404, { error: { code: 'not_found', message: 'turn 不存在' } });
      const attempts = d.db.prepare('SELECT id, attempt_no, state, blocked_reason, input_revision, window_id FROM attempts WHERE turn_id = ? ORDER BY attempt_no').all(turnId);
      const pendingDecision = d.db.prepare("SELECT id, state, target_model, source_evidence FROM route_decisions WHERE turn_id = ? AND state = 'pending'").get(turnId) ?? null;
      return json(res, 200, { turn, attempts, pending_route_decision: pendingDecision });
    }

    return json(res, 404, { error: { code: 'not_found', message: `未知路由：${route}` } });
  } catch (err) {
    d.logger.error('route_error', { route, error: (err as Error).message });
    if (!res.headersSent) return json(res, 500, { error: { code: 'internal', message: '内部错误（详情见日志）' } });
    res.end();
  }
}

async function createTurnForMessage(d: RequestDeps, conversationId: string, messageId: string, revision: number): Promise<string> {
  const turnId = genId('turn');
  const attemptId = genId('att');
  const now = new Date().toISOString();
  tx(d.db, () => {
    d.db
      .prepare("INSERT INTO turns(id, conversation_id, trigger, state, input_message_id, created_at) VALUES (?,?, 'user_message', 'pending', ?, ?)")
      .run(turnId, conversationId, messageId, now);
    d.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,1,?, 'pending')").run(attemptId, turnId, revision);
    d.db.prepare('UPDATE messages SET turn_id = ? WHERE id = ?').run(turnId, messageId);
  });
  const message = d.messages.getMessage(messageId)!;
  d.events.publish('message.persisted', { conversationId, turnId, entityRef: messageId, entityRevision: message.sequence, payload: { message } });
  d.events.publish('turn.started', { conversationId, turnId, attemptId, payload: {} });
  d.supervisor.enqueue(turnId);
  return turnId;
}

// —— SSE：先按 cursor 回放持久事件，再订阅实时；id= 持久 sequence，断线以 Last-Event-ID 续 ——
function handleSse(req: IncomingMessage, res: ServerResponse, d: RequestDeps, url: URL): void {
  const conversationId = url.searchParams.get('conversation_id');
  const lastEventId = req.headers['last-event-id'];
  let cursor = Number(url.searchParams.get('cursor') ?? (typeof lastEventId === 'string' ? lastEventId : '0')) || 0;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n`);

  for (const row of d.events.replay(cursor, conversationId)) {
    writeSseFrame(res, row.sequence, row.kind, row.payload_ref, row);
    cursor = row.sequence;
  }
  res.write(`: replayed cursor=${cursor}\n\n`);

  let sub: SseSubscriber;
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (sub) d.events.unsubscribe(sub);
    clearInterval(flushTimer);
    clearInterval(beat);
    res.end();
  };
  sub = d.events.subscribe(conversationId, () => {
    // 慢客户端溢出：断开，客户端按 cursor 重连（05 §5.3）
    res.write(`: overflow, reconnect with cursor\n\n`);
    finish();
  });
  const flushTimer = setInterval(() => {
    while (sub.queue.length > 0) {
      const item = sub.queue.shift()!;
      writeSseFrame(res, item.sequence, item.kind, item.payload, item.eventRow);
    }
  }, 25);
  const beat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 15000);
  req.on('close', finish);
}

function writeSseFrame(res: ServerResponse, sequence: number, kind: string, payload: string, row: { conversation_id: string | null; turn_id: string | null; attempt_id: string | null }): void {
  const body = {
    sequence,
    kind,
    conversation_id: row.conversation_id,
    turn_id: row.turn_id,
    attempt_id: row.attempt_id,
    ...JSON.parse(payload),
  };
  // event: 字段省略（统一 message 类型，data 内带 kind），EventSource onmessage 即可
  res.write(`id: ${sequence}\ndata: ${JSON.stringify(body)}\n\n`);
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const file =
    pathname === '/' ? path.join(WEB_DIR, 'index.html') : path.join(WEB_DIR, path.basename(pathname));
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 5 * 1024 * 1024) throw new Error('body 过大（>5MB）：附件上传走独立通道，不在这里堆内存');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
