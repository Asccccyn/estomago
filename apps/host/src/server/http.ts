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
import { buildRecordSnapshot, listRecordEvents } from './records.ts';
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
  archiveSync?: {
    drainOnce(): Promise<unknown>; // 原文归档同步（未启用时不注入）
    rawSyncState?(conversationId: string): { pending: number; unknown_outcome: number; failed: number; acked: number; enabled: boolean };
  };
};

const WEB_DIR = path.resolve(import.meta.dirname, '../../../web/src');
const SSE_PAGE_LIMIT = 1000;
const SSE_MAX_PENDING_BYTES = 8 * 1024 * 1024; // 慢客户端待发字节上限（超限断开，游标重连）
const SSE_DRAIN_TIMEOUT_MS = 20_000;
const sseDrainTimeoutMs = (): number => Number(process.env.ESTOMAGO_SSE_DRAIN_TIMEOUT_MS) || SSE_DRAIN_TIMEOUT_MS; // 测试可覆盖；生产默认不变

export async function handleRequest(req: IncomingMessage, res: ServerResponse, d: RequestDeps): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /health/live') return json(res, 200, { status: 'ok' });
    if (route === 'GET /health/ready') {
      const kind = d.runnerSelection.status === 'ok' ? d.runnerSelection.runner.kind : null;
      const gateDriver = kind === 'openrouter' || kind === 'deepseek' ? kind : 'claude-agent-sdk';
      const report = buildReadyReport({
        config: d.config, gate: d.identity.evaluateGate(d.db, { driver: gateDriver }), // 审计 F29：状态按当前驱动判别——OR/DS 不被 SDK 前提误报阻断
        runnerSelection: d.runnerSelection, capabilities: d.capabilities, db: d.db,
      });
      // F-J-49（联合审计 2026-10-06）：ready 未认证可达——原因明细（含绝对路径/目录结构）
      // 不上公共面，只回状态码级摘要；完整诊断走已认证的 doctor
      // ReadyReport = { status, components: Record<name, HealthComponent> }——
      // 公共面只回状态码级摘要（component+status），detail（含路径/原因）不上未认证面
      const comps = (report as { components?: Record<string, { status: string; detail?: string }> }).components ?? {};
      const entries = Object.entries(comps);
      return json(res, 200, {
        ready: entries.length > 0 && entries.every(([, c]) => c.status === 'ok'),
        degraded: entries.filter(([, c]) => c.status !== 'ok').map(([k, c]) => ({ component: k, status: c.status })),
      });
    }
    if (route === 'POST /api/v1/auth/login') {
      const body = (await readJson(req, d)) as { token?: string };
      if (!d.auth.verifyToken(typeof body.token === 'string' ? body.token : null)) {
        return json(res, 401, { error: { code: 'unauthorized', message: 'token 不正确' } });
      }
      res.setHeader('Set-Cookie', `estomago_session=${encodeURIComponent(body.token!)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`); // 上方 verifyToken 已验证 token 为非空 string
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
        if ((err as Error).message.includes('INVALID_OCCURRED_AT')) return json(res, 422, { error: { code: 'invalid_occurred_at', message: (err as Error).message } });
        throw err;
      }
      // F12：无论 duplicate 与否，都确保事件已发 + 入队（duplicate 的 turn 可能因事件失败而 pending）
      const message = d.messages.getMessage(submitted.message.id)!;
      const eventExists = d.db.prepare('SELECT COUNT(*) n FROM runtime_stream_events WHERE kind = ? AND turn_id = ?').get('message.persisted', submitted.turnId) as { n: number };
      if (eventExists.n === 0) {
        d.events.publish('message.persisted', { conversationId, turnId: submitted.turnId, entityRef: message.id, entityRevision: message.sequence, payload: { message } });
      }
      const startedExists = d.db.prepare('SELECT COUNT(*) n FROM runtime_stream_events WHERE kind = ? AND turn_id = ?').get('turn.started', submitted.turnId) as { n: number };
      if (startedExists.n === 0) {
        d.events.publish('turn.started', { conversationId, turnId: submitted.turnId, attemptId: submitted.attemptId, payload: {} });
      }
      // F12：duplicate 但任一事件缺失（提交后事件写入失败）→ 补事件并重新入队，turn 不得滞留 pending
      if (!submitted.duplicate || submitted.repaired || eventExists.n === 0 || startedExists.n === 0) {
        d.supervisor.enqueue(submitted.turnId);
      }
      // 原文线独立于模型线：提交即触发同步 drain（未启用时 no-op；失败不阻塞提交）
      void d.archiveSync?.drainOnce().catch(() => {});
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
      // 审计 F05：手动换窗走与自动换窗同一条评审管线（互斥/未决写核验/CAS）——
      // 不再存在绕过评审直转 WindowManager 的旁路；SDK 驱动保持 v0.2.2 行为
      const result = await d.supervisor.manualRotate(win.conversation_id);
      return json(res, result.ok ? 200 : 409, result.ok ? { window: { id: result.windowId } } : { error: { code: 'rotate_blocked', message: result.reason } });
    }

    const runtime = /^GET \/api\/v1\/conversations\/([^/]+)\/runtime$/.exec(route);
    if (runtime) {
      const conversationId = decodeURIComponent(runtime[1]!);
      const kind = d.runnerSelection.status === 'ok' ? d.runnerSelection.runner.kind : null;
      const gateDriver = kind === 'openrouter' || kind === 'deepseek' ? kind : 'claude-agent-sdk';
      const gate = d.identity.evaluateGate(d.db, { driver: gateDriver }); // 审计 F29
      const active = d.windows.activeWindow(conversationId);
      // ESTOMAGO_OR_SELF_HOLD §6.1：OR/DS 配置状态只报"已配置/未配置"布尔与型号名；凭据值永不回显
      const orStatus = d.config.runtime.provider === 'openrouter'
        ? {
            model: d.config.openrouter.model,
            model_configured: d.config.openrouter.model !== null,
            key_env_configured: (() => { const v = process.env[d.config.openrouter.api_key_env]; return typeof v === 'string' && v.length > 0; })(),
            base_url: d.config.openrouter.base_url,
          }
        : null;
      const dsStatus = d.config.runtime.provider === 'deepseek'
        ? {
            model: d.config.deepseek.model,
            model_configured: d.config.deepseek.model !== null,
            key_env_configured: (() => { const v = process.env[d.config.deepseek.api_key_env]; return typeof v === 'string' && v.length > 0; })(),
            base_url: d.config.deepseek.base_url,
          }
        : null;
      return json(res, 200, {
        conversation_id: conversationId,
        identity: { state: gate.state, reasons: gate.reasons, manifest_status: gate.manifest?.status ?? null },
        runner: d.runnerSelection.status === 'ok' ? { kind: d.runnerSelection.runner.kind } : { blocked: d.runnerSelection.reasons },
        openrouter: orStatus,
        deepseek: dsStatus,
        capabilities: d.capabilities.describe(),
        active_window: active ? { id: active.id, status: active.status, sdk_session_bound: Boolean(active.sdk_session_id) } : null,
        thresholds: {
          status: d.config.windows.threshold_status,
          model_context_capacity: d.config.windows.model_context_capacity,
          soft_limit_tokens: d.config.windows.soft_limit_tokens,
          warning_tokens: d.config.windows.warning_tokens,
        },
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
      // F18：approve（按原配置重跑）没有已验证的单次继续动作——拒绝且不消耗票据；
      // 已消费/不存在的票据仍按原语义报 409/404（多端重复点击只有一个生效）
      if (body.choice === 'approve') {
        const row = d.routing.get(decisionId);
        if (!row) return json(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: '票据不存在' } });
        if (row.state !== 'pending') {
          return json(res, 409, { error: { code: 'ROUTE_ALREADY_RESOLVED', message: `票据已 ${row.state}${row.choice ? `(${row.choice})` : ''}` } });
        }
        return json(res, 422, { error: { code: 'approve_not_supported', message: '继续路由动作未验证（无平台级路由执行能力）：票据保持待决，可重新编辑或取消' } });
      }
      // AUD-06：先完整验证（RoutingService.validateAndConsume），非法请求票据不受影响
      const consumed = d.routing.validateAndConsume(decisionId, body.choice === 'edit' ? { choice: 'edit', content: String(body.content ?? '') } : { choice: body.choice });
      if (!consumed.ok) return json(res, consumed.status, { error: { code: consumed.code, message: consumed.reason } });
      // 决议完成：重新驱动该房间排队的 turn（AUD-05）
      d.supervisor.requeueConversationQueuedTurns(consumed.row.conversation_id);
      if (body.choice === 'edit') {
        const turn = d.db.prepare('SELECT input_message_id FROM turns WHERE id = ?').get(consumed.turnId) as { input_message_id: string | null };
        const message = turn?.input_message_id ? d.messages.getMessage(turn.input_message_id) : null;
        return json(res, 200, { resolved: 'edit', message, attempt_id: consumed.newAttemptId, revision: consumed.editRevision, released_waiting: consumed.releasedWaiting });
      }
      // F-J-31（typecheck 基线）：下方 approve 分支为死代码——choice='approve' 已在上方提前
      // return 422（approve_not_supported）/404/409，控制流到不了此处，按联合审计 B2 指示删除。
      return json(res, 200, { resolved: 'cancel' });
    }

    if (route === 'GET /api/v1/time/context') {
      const conversationId = url.searchParams.get('conversation_id') ?? PRIMARY_CONVERSATION;
      return json(res, 200, buildTimeContext(d.db, { conversationId, config: d.config }));
    }

    // —— 前台"记录"只读端点（contracts/records-api.md）：GET 严格只读，不触发任何生成/hold/换窗 ——
    const ctxRecords = /^GET \/api\/v1\/conversations\/([^/]+)\/context-records$/.exec(route);
    if (ctxRecords) {
      const conversationId = decodeURIComponent(ctxRecords[1]!);
      const lastSeq = (d.db.prepare('SELECT MAX(sequence) AS m FROM runtime_stream_events WHERE conversation_id = ?').get(conversationId) as { m: number | null }).m;
      const snapshot = buildRecordSnapshot(
        { db: d.db, config: d.config, windows: d.windows, runnerSelection: d.runnerSelection, rawSyncState: d.archiveSync?.rawSyncState?.(conversationId) ?? null },
        conversationId,
        lastSeq,
      );
      return json(res, 200, snapshot);
    }

    const ctxRecordsEvents = /^GET \/api\/v1\/conversations\/([^/]+)\/context-records\/events$/.exec(route);
    if (ctxRecordsEvents) {
      const conversationId = decodeURIComponent(ctxRecordsEvents[1]!);
      const after = Math.max(0, Number(url.searchParams.get('cursor') ?? '0') || 0);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '30') || 30));
      const before = url.searchParams.get('before') !== null ? Number(url.searchParams.get('before')) : null;
      const mode = before !== null ? 'older' : url.searchParams.get('last') === '1' ? 'recent' : 'forward'; // F21/F26：最近页/向更早/历史正向
      return json(res, 200, listRecordEvents(d.db, conversationId, after, limit, mode, Number.isFinite(before as number) ? (before as number) : null));
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
    // F-J-44：客户端请求体错误（超限/坏 JSON）按 4xx 语义返回，不混入 500
    if (err instanceof ClientBodyError) {
      d.logger.error('client_body_error', { route, code: err.code });
      if (!res.headersSent) return json(res, err.status, { error: { code: err.code, message: err.message } });
      res.end();
      return;
    }
    d.logger.error('route_error', { route, code: stableErrorCode(err) });
    if (!res.headersSent) return json(res, 500, { error: { code: 'internal', message: '内部错误（错误码见日志）' } });
    res.end();
  }
}

// —— SSE v0.3（AUD-35/29 §17/§18）——
// toSseDto 是 replay 与 live 的唯一序列化函数（契约：同一 event row → 同一 DTO）。
// 优先级：Last-Event-ID > query cursor。回放分页追平到连接时高水位后转 live（先订阅后回放，无空洞）。
// 背压：res.write false → await drain（超时断开）；待发字节超上限断开；客户端按游标重连。

export function toSseDto(row: { sequence: number; kind: string; payload_ref?: string; payload?: string; conversation_id: string | null; turn_id: string | null; attempt_id: string | null }): Record<string, unknown> {
  const payloadRaw = row.payload_ref ?? row.payload ?? '{}';
  return {
    sequence: row.sequence,
    kind: row.kind,
    conversation_id: row.conversation_id,
    turn_id: row.turn_id,
    attempt_id: row.attempt_id,
    ...JSON.parse(payloadRaw),
  };
}

export function handleSse(req: IncomingMessage, res: ServerResponse, d: RequestDeps, url: URL): void { // 导出供组件级背压回归（AUD-29）
  const conversationId = url.searchParams.get('conversation_id');
  const lastEventIdHeader = req.headers['last-event-id'];
  let cursor: number;
  if (typeof lastEventIdHeader === 'string' && lastEventIdHeader !== '') {
    cursor = Number(lastEventIdHeader) || 0; // 标准恢复游标优先（AUD-09）
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

  let closed = false;
  let pendingBytes = 0;
  let drained = true;
  let drainWaiter: (() => void) | null = null;
  res.on('drain', () => {
    drained = true;
    pendingBytes = 0; // socket 已 flush
    drainWaiter?.();
    drainWaiter = null;
  });
  const sub: SseSubscriber = d.events.subscribe(conversationId, () => finish());
  const finish = (): void => {
    if (closed) return;
    closed = true;
    d.events.unsubscribe(sub);
    clearInterval(beat);
    drainWaiter?.(); // 唤醒挂起的 waitDrain，防 pump 协程悬挂
    drainWaiter = null;
    try { res.end(); } catch { /* 已断 */ }
    // 停滞客户端：FIN 可能被满窗口内核队列卡住——硬关闭保证断开可观测（客户端按游标重连）
    try { res.destroy?.(); } catch { /* 已断 */ }
  };
  req.on('close', finish);

  const writeFrame = (row: Parameters<typeof toSseDto>[0]): 'ok' | 'blocked' | 'cap' => {
    if (closed) return 'blocked';
    const frame = `id: ${row.sequence}\ndata: ${JSON.stringify(toSseDto(row))}\n\n`; // §17：唯一 DTO 函数
    // D26（审计 3655d60）：内存水位只统计**未 flush 的待发字节**——write 同步成功即清零；
    // 旧实现把连接终生已发送字节累进队列上限，健康长连接写满 8MiB 被误断。
    // 真正的慢客户端由 write=false + drain 超时 + 订阅队列上限三道防线处理。
    pendingBytes += Buffer.byteLength(frame, 'utf8'); // F-J-47：按 UTF-8 字节计——JS length 是 UTF-16 码元，中文正文低估约 3 倍
    if (pendingBytes > SSE_MAX_PENDING_BYTES) return 'cap'; // 无论 write 返回值：累计超限即断开（内核缓冲吞不掉了）
    drained = res.write(frame); // false = 内部缓冲已满 → 必须等 drain（§18）
    if (drained) pendingBytes = 0; // 同步 flush 完成：待发水位归零
    return drained ? 'ok' : 'blocked';
  };
  const waitDrain = async (): Promise<boolean> => {
    if (drained) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), sseDrainTimeoutMs());
      timer.unref?.(); // 不因等待 drain 拖延进程退出
      drainWaiter = () => { clearTimeout(timer); resolve(true); };
    });
  };

  const highWater = d.events.maxSequence();
  let replayCursor = cursor;
  const beat = setInterval(() => { if (!closed) res.write(': ping\n'); }, 15000);

  // 单一 pump：回放分页 → live 队列；写满即等 drain，超时/超量断开
  const pump = (async () => {
    for (;;) {
      if (closed) return;
      // 回放阶段：追平到 highWater
      const page = d.events.replayPage(replayCursor, conversationId, SSE_PAGE_LIMIT);
      // F-J-46（联合审计 2026-10-06）：满页且首行即越 highWater 时，for 内 break 会让
      // 外层 while 条件（page.length < LIMIT || replayCursor >= highWater）双双不满足——
      // 理论活锁（每轮一次 DB 查询无进展）。改为直接结束回放阶段：越界行由 live 队列
      // 按 > replayCursor 规则交付，不漏不重
      if (page.length >= SSE_PAGE_LIMIT && page[0]!.sequence > highWater) break;
      for (const row of page) {
        if (row.sequence > highWater) break;
        if (closed) return;
        const wr = writeFrame(row);
        if (wr === 'cap') { finish(); return; } // §18：累计超限立即断开（客户端按游标重连）
        if (wr === 'blocked' && !(await waitDrain())) { finish(); return; } // 等 drain，超时断开
        replayCursor = row.sequence;
      }
      if (page.length < SSE_PAGE_LIMIT || replayCursor >= highWater) break;
    }
    if (closed) return;
    res.write(`: replayed cursor=${replayCursor}\n\n`);
    // live 阶段
    for (;;) {
      if (closed) return;
      while (sub.queue.length > 0) {
        const item = sub.queue.shift()!;
        if (item.sequence <= replayCursor) continue; // 回放已覆盖（客户端另以 sequence 去重）
        const wr = writeFrame(item.eventRow);
        if (wr === 'cap') { finish(); return; }
        if (wr === 'blocked' && !(await waitDrain())) { finish(); return; }
        replayCursor = item.sequence;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
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

class ClientBodyError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson(req: IncomingMessage, d: RequestDeps): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 5 * 1024 * 1024) throw new ClientBodyError(413, 'payload_too_large', '请求体超过 5MiB 上限');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // F-J-44（联合审计 2026-10-06）：坏 JSON 是客户端错误（400），不是 500——
    // 此前 SyntaxError 落进外层 catch 污染 500 口径
    throw new ClientBodyError(400, 'invalid_json', '请求体不是合法 JSON');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
