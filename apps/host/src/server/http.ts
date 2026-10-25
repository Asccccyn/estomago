// HTTP 路由 + SSE v0.2.2（AUD-06/08/09/29/15/28 修复）：
//  - 提交走 submitUserMessageWithTurn（单事务：消息+outbox+turn+attempt；幂等含自愈）。
//  - SSE：Last-Event-ID 优先于 query cursor；回放到连接时高水位分页追平后进 live，无空洞；
//    res.write 背压（drain 等待 + 待发字节上限 + 超时断开）。
//  - route-decisions：先验证后事务消费；非法请求不消耗票据。
//  - 错误日志只记稳定错误码（AUD-28）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import { HOME_STATIC_FILES } from './home-assets.ts';
import path from 'node:path';
import type { Config } from '../config/schema.ts';
import type { EstomagoPaths } from '../config/paths.ts';
import type { Db } from '../db/connection.ts';
import { readSnapshot } from '../db/connection.ts';
import type { Logger } from '../observability/logging.ts';
import { stableErrorCode } from '../observability/errors.ts';
import { conversationSnapshot } from './snapshot.ts';
import type { EventService, SseSubscriber } from '../events/service.ts';
import type { MessageService } from '../messages/service.ts';
import { MessageRetryService, MessageRetryError } from '../messages/retry.ts';
import type { IdentityService } from '../identity/service.ts';
import type { CapabilityMatrix } from '../runtime/capabilities.ts';
import type { RunnerSelection } from '../runtime/runner.ts';
import type { ReasoningService } from '../reasoning/service.ts';
import type { UsageCollector } from '../usage/collector.ts';
import type { RoutingService } from '../routing/service.ts';
import type { WindowManager } from '../windows/manager.ts';
import type { TurnSupervisor } from '../runtime/supervisor.ts';
import type { ManualSelectionService } from '../context/manual-selection.ts';
import type { SystemAlertService } from '../observability/system-alerts.ts';
import type { MediaService, IngestPurpose } from '../media/assets.ts';
import { MediaError } from '../media/assets.ts';
import { POLICY_CONSTANTS } from '../config/policy-constants.ts';
import { contentProxyWithAssets } from '../integrations/content/client.ts';
import { buildCalendarMonth, buildCalendarDayItems, shanghaiDayRange, type CalendarSource } from './calendar-routes.ts';
import { fetchOrModelMeta, effortsForModel } from '../runtime/runtime-settings.ts';
import { orModelIdIssue } from '../config/schema.ts';
import type { AuthService } from '../auth/tokens.ts';
import { buildReadyReport } from '../observability/health.ts';
import { buildTimeContext } from '../time/context.ts';
import { buildRecordSnapshot, listRecordEvents } from './records.ts';
import { genId } from '../util/id.ts';
import type { SubmitMessageRequest, MessagePageDto } from '../../../../packages/contracts/src/api.ts';
import { estimateTokens, snapshotFor, ESTIMATOR_REVISION, type AttachmentEstimateMeta } from '../usage/estimator.ts';
import { sha256Hex } from '../util/id.ts';
import { PRIMARY_CONVERSATION } from '../messages/constants.ts';
import { keepwarmSleepState } from '../runtime/keepwarm-sleep.ts';
import { storedToolset } from '../runtime/tool-discovery.ts';

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
  selections?: ManualSelectionService; // WP3（2026-10-08）：人工历史选集
  settings?: import('../runtime/runtime-settings.ts').RuntimeSettingsService; // 2026-10-08：换模型/推理等级
  alerts?: SystemAlertService; // EXEC_V1 WP1：系统异常红点（未装配时端点如实降级）
  media?: MediaService; // EXEC_V1 WP3：媒体服务（未装配时资产端点如实降级）
  voice?: import('../media/voice.ts').VoiceService;
  bgSettings?: import('../runtime/background-settings.ts').BackgroundSettingsService; // EXEC_V1 WP4
  scheduler?: import('../runtime/background-scheduler.ts').BackgroundScheduler; // EXEC_V1 WP4
  mediaIndex?: import('../media/index/service.ts').MediaIndexService; // R8′：后台补索引独立循环（不经会话串行链）
  oido?: import('../integrations/oido/adapter.ts').OidoAdapter; // R6′：删除传播重试循环
  sirenCall?: import('../integrations/siren/adapter.ts').SirenAdapter; // 协议①②（2026-10-24）：邀请/接听/拒接/通话原声
  tools?: import('../capabilities/model-bridge.ts').ModelToolBridge; // R5：深听 UI 端点（会话绑定同门）
  bgExecutorReady?: { autonomous: boolean; keepwarm: boolean }; // WP4：模型执行器就绪状态（自主/保温接线批落地前 false）
  taskService?: import('../runtime/background-task-service.ts').BackgroundTaskService; // WAKE_KEEPWARM_V1：预约管理正本（HTTP 与 wake_manage 共用）
  activity?: import('../runtime/wake-activity.ts').ConversationActivityService; // WAKE_KEEPWARM_V1：活动投影/保温状态派生
  contentClient?: import('../integrations/content/client.ts').ContentClient | null; // EXEC_V1 WP5：内容服务薄代理
  surfacing?: import('../memory-surfacing/service.ts').SurfacingService | null; // 自动浮现（默认 disabled）
  auth: AuthService;
  archiveSync?: {
    health?(): import('../../../../packages/contracts/src/api.ts').HealthComponent;
    drainOnce(): Promise<unknown>; // 原文归档同步（未启用时不注入）
    rawSyncState?(conversationId: string): { pending: number; unknown_outcome: number; failed: number; acked: number; enabled: boolean };
  };
};

const WEB_DIR = path.resolve(import.meta.dirname, '../../../web/src');
// Only explicitly shipped public files are reachable. Never resolve a request path
// directly beneath WEB_DIR (login assets must not expose source or state files).
const STATIC_FILES = new Map<string, { file: string; type: string; cache: string }>([
  ['/', { file: 'home/index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' }],
  ['/chat', { file: '../dist/index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' }],
  ['/wishstar', { file: 'wishstar/index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' }],
  ...HOME_STATIC_FILES,
  ['/chat-app.js', { file: '../dist/chat-app.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' }],
  ['/chat-app.css', { file: '../dist/chat-app.css', type: 'text/css; charset=utf-8', cache: 'no-cache' }],
  ['/app.js', { file: '../dist/chat-app.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' }],
  ['/style.css', { file: '../dist/chat-app.css', type: 'text/css; charset=utf-8', cache: 'no-cache' }],
  ['/composer-logic.js', { file: 'composer-logic.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' }],
  ['/login', { file: 'login/index.html', type: 'text/html; charset=utf-8', cache: 'no-store' }],
  ...['player.css', 'login.css'].map((file): [string, { file: string; type: string; cache: string }] =>
    [`/login/${file}`, { file: `login/${file}`, type: 'text/css; charset=utf-8', cache: 'no-cache' }]),
  ...['player.js', 'cord.js', 'scene.js', 'journey.js', 'animation.js', 'login.js'].map((file): [string, { file: string; type: string; cache: string }] =>
    [`/login/${file}`, { file: `login/${file}`, type: 'text/javascript; charset=utf-8', cache: 'no-cache' }]),
  ['/login/assets/pinky-cels-original.png', { file: 'login/assets/pinky-cels-original.png', type: 'image/png', cache: 'no-cache' }],
  ['/login/assets/welcome-original-lettering.svg', { file: 'login/assets/welcome-original-lettering.svg', type: 'image/svg+xml', cache: 'no-cache' }],
  ['/login/assets/promise-handwriting.woff2', { file: 'login/assets/promise-handwriting.woff2', type: 'font/woff2', cache: 'no-cache' }],
]);
const SSE_PAGE_LIMIT = 1000;
const SSE_MAX_PENDING_BYTES = 8 * 1024 * 1024; // 慢客户端待发字节上限（超限断开，游标重连）
const SSE_DRAIN_TIMEOUT_MS = 20_000;
const sseDrainTimeoutMs = (): number => Number(process.env.ESTOMAGO_SSE_DRAIN_TIMEOUT_MS) || SSE_DRAIN_TIMEOUT_MS; // 测试可覆盖；生产默认不变

/** EXEC_V1 §05.8：预估上下文（模型/系数/输出上限按当前驱动与生效 override 取值） */
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
        archiveSync: d.archiveSync?.health ? { health: () => d.archiveSync!.health!() } : undefined,
      });
      // F-J-49（联合审计 2026-10-06）：ready 未认证可达——原因明细（含绝对路径/目录结构）
      // 不上公共面，只回状态码级摘要；完整诊断走已认证的 doctor
      // ReadyReport = { status, components: Record<name, HealthComponent> }——
      // 公共面只回状态码级摘要（component+status），detail（含路径/原因）不上未认证面
      const comps = (report as { components?: Record<string, { status: string; detail?: string }> }).components ?? {};
      const entries = Object.entries(comps);
      const ready = report.status === 'ready';
      // WP-04（JFA-E07）：ready=false → 503（监控按状态码分辨）；
      // /health/live 保持 200（进程活着）
      return json(res, ready ? 200 : 503, {
        ready,
        disabled: entries.filter(([, c]) => c.status === 'disabled').map(([k]) => k),
        degraded: entries.filter(([, c]) => c.status !== 'ok' && c.status !== 'disabled').map(([k, c]) => ({ component: k, status: c.status })),
      });
    }
    if (url.pathname === '/api/v1/auth/login' || url.pathname === '/api/v1/auth/session') {
      res.setHeader('Cache-Control', 'no-store');
    }
    if (route === 'POST /api/v1/auth/login') {
      if (!d.auth.originAllowed(req, String(req.headers.host ?? ''))) {
        return json(res, 403, { error: { code: 'bad_origin', message: 'Origin 校验失败' } });
      }
      const body = (await readJson(req, d)) as { token?: unknown } | null;
      const token = typeof body?.token === 'string' ? body.token : null;
      if (!d.auth.verifyToken(token)) {
        return json(res, 401, { error: { code: 'unauthorized', message: 'token 不正确' } });
      }
      res.setHeader('Set-Cookie', `estomago_session=${encodeURIComponent(token!)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`); // 上方 verifyToken 已验证 token 为非空 string
      return json(res, 200, { ok: true });
    }
    const protectedPage = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/chat' || url.pathname.startsWith('/home/'));
    if ((protectedPage && !d.auth.isAuthorized(req)) || (route === 'GET /login' && d.auth.isAuthorized(req))) {
      res.writeHead(302, { Location: url.pathname === '/login' ? '/' : '/login', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (req.method === 'GET' && (STATIC_FILES.has(url.pathname) || url.pathname.startsWith('/login/'))) {
      return serveStatic(res, url.pathname);
    }

    // R4/RE-01（2026-10-24 返修）：voice ingress 在 owner 通用认证**之前**分派——
    // 专用 Bearer 凭据只授权受控电话入口（Siren CoreBridge 不持有 owner 全权 token；
    // 鉴权/绑定/限额由 handleVoiceChatStream 自行执行）。错误会话/撤销仍拒。
    if (route === 'POST /v1/chat/stream') {
      return await handleVoiceChatStream(req, res, d);
    }
    if (route === 'POST /v1/calls' || /^DELETE \/v1\/calls\/([^/]+)$/.test(route)) {
      return await handleVoiceCallLifecycle(req, res, d, route);
    }

    if (!d.auth.isAuthorized(req)) {
      return json(res, 401, { error: { code: 'unauthorized', message: '需要认证' } });
    }
    const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
    if (mutating && !d.auth.originAllowed(req, String(req.headers.host ?? ''))) {
      return json(res, 403, { error: { code: 'bad_origin', message: 'Origin 校验失败' } });
    }
    if (route === 'GET /api/v1/auth/session') {
      return json(res, 200, { authenticated: true });
    }

    // —— 会话/消息/浮现视图组——P07.2 迁 server/routes/conversations.ts（逐字）。
    // 精确路由表委托（同 voice-call 模式）：未列出的 /api/v1/conversations/* 子路径继续走链尾 404，不被前缀抢占。
    if (route === 'GET /api/v1/conversations'
      || /^GET \/api\/v1\/conversations\/([^/]+)\/messages$/.test(route)
      || /^GET \/api\/v1\/conversations\/([^/]+)\/messages\/([^/]+)$/.test(route)
      || /^POST \/api\/v1\/conversations\/([^/]+)\/messages$/.test(route)
      || /^POST \/api\/v1\/conversations\/([^/]+)\/messages\/([^/]+)\/retry$/.test(route)
      || /^PUT \/api\/v1\/conversations\/([^/]+)\/messages\/([^/]+)$/.test(route)
      || /^GET \/api\/v1\/conversations\/([^/]+)\/snapshot$/.test(route)
      || /^GET \/api\/v1\/conversations\/([^/]+)\/turns\/([^/]+)\/memories(?:\/(.+))?$/.test(route)) {
      return await handleConversationRoutes(req, res, d, route, url);
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

    // —— 深听 UI 组——P07.1 补迁 server/routes/oido-ui.ts（逐字）；精确路由表委托。
    if (route === 'POST /api/v1/oido/analyze'
      || /^GET \/api\/v1\/oido\/analyses\/([^/]+)\/prosody$/.test(route)
      || /^GET \/api\/v1\/oido\/analyses\/([^/]+)\/image$/.test(route)
      || /^GET \/api\/v1\/oido\/analyses\/([^/]+)$/.test(route)) {
      return await handleOidoUiRoutes(req, res, d, route, url);
    }

    // R4（2026-10-23）：voice ingress——分派已在文件上方 owner 认证前完成（RE-01）；
    // 此处不再重复分派
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
      // 审计 F05：手动换窗走统一安全切换管线（互斥/未决写核验/CAS），不发起模型评审——
      // 不再存在绕过安全检查直转 WindowManager 的旁路
      // WP3（H07）：无已确认选集 → 409 context_selection_required（awaiting
      // 已持久化；输入已保存，确认后自动继续——rotate 不再是绕过选集的旁路）
      const result = await d.supervisor.manualRotate(win.conversation_id, windowId);
      if (!result.ok && result.reason.startsWith('CONTEXT_SELECTION_REQUIRED')) {
        const awaiting = d.selections?.awaitingFor(win.conversation_id) ?? null;
        return json(res, 409, { error: { code: 'context_selection_required', message: result.reason, selection_id: awaiting?.selection_id ?? null } });
      }
      return json(res, result.ok ? 200 : 409, result.ok ? { window: { id: result.windowId } } : { error: { code: 'rotate_blocked', message: result.reason } });
    }

    // —— 运行时设置组——P07.2 迁 server/routes/runtime-settings.ts（逐字）。
    if (route === 'GET /api/v1/runtime-settings' || route === 'PUT /api/v1/runtime-settings') {
      return await handleRuntimeSettingsRoutes(req, res, d, route);
    }


    // —— 上下文选集/运行态/路由决议/时间/记录组——P07.2 迁 server/routes/context-selection.ts（逐字）。
    if (route === 'GET /api/v1/time/context'
      || /^GET \/api\/v1\/conversations\/([^/]+)\/context-selection$/.test(route)
      || /^GET \/api\/v1\/conversations\/([^/]+)\/runtime$/.test(route)
      || /^GET \/api\/v1\/conversations\/([^/]+)\/context-records(?:\/events)?$/.test(route)
      || /^POST \/api\/v1\/windows\/([^/]+)\/context-selection\/(preview|confirm)$/.test(route)
      || /^POST \/api\/v1\/route-decisions\/([^/]+)$/.test(route)) {
      return await handleContextSelectionRoutes(req, res, d, route, url);
    }


    // —— 资产组（两段：sandbox 预览 + voice/资产/oido 图）——P07.2 迁 server/routes/assets.ts（逐字）。
    if (/^GET \/api\/v1\/assets\/([^/]+)\/preview$/.test(route)) {
      return await handleAssetsRoutes(req, res, d, route, url);
    }


    // —— 日历读聚合组——P07.2 迁 server/routes/calendar.ts（逐字）。
    if (route === 'GET /api/v1/calendar/month' || route === 'GET /api/v1/calendar/day' || route === 'GET /api/v1/calendar/day/items') {
      return handleCalendarRoutes(req, res, d, route, url);
    }


    // —— EXEC_V1 §06.4/5（WP5）：content 薄代理——P07.2 迁 server/routes/content.ts（逐字）
    if (url.pathname.startsWith('/api/v1/content/')) {
      return await handleContentProxy(req, res, d, url);
    }

    // —— EXEC_V1 §04.11（WP4）+ WAKE_KEEPWARM_V1 §08：后台设置/任务/运行——P07.2 迁 server/routes/background.ts（逐字）。
    // 精确路由表委托（同 voice-call 模式）：未列出的 /api/v1/background/* 子路径继续走链尾 404，不被前缀抢占。
    if (route === 'GET /api/v1/background/settings' || route === 'PUT /api/v1/background/settings'
      || route === 'GET /api/v1/background/tasks' || route === 'POST /api/v1/background/tasks'
      || route === 'GET /api/v1/background/runs'
      || /^GET \/api\/v1\/background\/tasks\/([^/]+)$/.test(route)
      || /^PUT \/api\/v1\/background\/tasks\/([^/]+)$/.test(route)
      || /^DELETE \/api\/v1\/background\/tasks\/([^/]+)$/.test(route)
      || /^POST \/api\/v1\/background\/runs\/([^/]+)\/stop$/.test(route)) {
      return await handleBackgroundRoutes(req, res, d, route, url);
    }

    // —— 资产组后半：voice 状态/转写/assets CRUD/references/oido 图——routes/assets.ts（逐字）。
    if (route === 'GET /api/v1/voice/status'
      || /^POST \/api\/v1\/assets\/([^/]+)\/transcribe$/.test(route)
      || route === 'POST /api/v1/assets' || route === 'POST /api/v1/assets/import'
      || /^GET \/api\/v1\/assets\/([^/]+)$/.test(route)
      || /^GET \/api\/v1\/assets\/([^/]+)\/content$/.test(route)
      || /^POST \/api\/v1\/assets\/([^/]+)\/references$/.test(route)
      || /^DELETE \/api\/v1\/assets\/([^/]+)\/references\/([^/]+)$/.test(route)
      || /^DELETE \/api\/v1\/assets\/([^/]+)$/.test(route)
      || /^GET \/api\/v1\/oido\/views\/([^/]+)$/.test(route)) {
      return await handleAssetsRoutes(req, res, d, route, url);
    }


    // —— 建呼/通话请求/邀请组——P07.2 迁 server/routes/dial.ts（逐字）；精确路由表委托。
    if (route === 'POST /api/v1/calls/dial' || route === 'GET /api/v1/calls/dial/current'
      || route === 'POST /api/v1/calls' || route === 'GET /api/v1/calls/invites'
      || /^DELETE \/api\/v1\/calls\/dial\/([^/]+)$/.test(route)
      || /^DELETE \/api\/v1\/calls\/([^/]+)$/.test(route)
      || /^POST \/api\/v1\/calls\/invites\/([^/]+)\/(accept|decline)$/.test(route)) {
      return await handleDialRoutes(req, res, d, route);
    }
    // —— token 预估+系统红点组——P07.2 迁 server/routes/system.ts（逐字）；精确路由表委托。
    if (route === 'POST /api/v1/token-estimates'
      || route === 'GET /api/v1/system-alerts/summary' || route === 'GET /api/v1/system-alerts'
      || route === 'POST /api/v1/system-alerts/read') {
      return await handleSystemRoutes(req, res, d, route, url);
    }
    const usageTurn = /^GET \/api\/v1\/turns\/([^/]+)\/usage$/.exec(route);    if (usageTurn) {
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
  } catch (err: unknown) {
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
  const asset = STATIC_FILES.get(pathname);
  if (!asset) {
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 404, { error: { code: 'not_found', message: '静态资源不存在' } });
  }
  try {
    const content = fs.readFileSync(path.join(WEB_DIR, asset.file));
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': asset.cache, 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    json(res, 404, { error: { code: 'not_found', message: '静态资源不存在' } });
  }
}


/** §03.5.1：二进制上传不走 readJson——流式限量读原始字节。 */


/** WP3（2026-10-08）：选集条目解析——只取 message_id/revision/content_hash
 *  三个受控字段（前端正文不进模型，服务端从真实修订读取）；坏条目剔除。 */

/** 协议②（2026-10-24）：oído 快证据——宿主受信导入+短等待分析，取最多一条可靠观察。
 *  ready 就返回（≤N 字符）；未就绪/无证据= null（不拖电话、不回写历史、不猜情绪）。 */
async function quickVoiceObservation(d: RequestDeps, a: { assetId: string; bytes: Uint8Array; sha256: string; mime: string; transcript: string; signal?: AbortSignal }): Promise<string | null> {
  // 审计修复：signal 贯穿（oído 适配器已有 lifetime 合并机制，复用）；ingest 返回真实 receipt 先保留，再检查取消，禁止继续 analyze
  const receipt = await d.oido!.ingestVoice({ assetId: a.assetId, bytes: Buffer.from(a.bytes), sha256: a.sha256, mime: a.mime, transcript: { text: a.transcript, source: 'siren:call' }, timeoutMs: 6000, signal: a.signal });
  d.db.prepare('INSERT INTO oido_ingest_receipts(est_asset_id,content_sha256,oido_audio_id,deduplicated,ingested_at) VALUES (?,?,?,?,?) ON CONFLICT(est_asset_id) DO UPDATE SET oido_audio_id=excluded.oido_audio_id,deduplicated=excluded.deduplicated,ingested_at=excluded.ingested_at')
    .run(a.assetId, a.sha256, receipt.audioId, receipt.deduplicated ? 1 : 0, new Date().toISOString());
  if (a.signal?.aborted) throw Object.assign(new Error('CANCELLED_AFTER_INGEST'), { name: 'AbortError' });
  const result = await d.oido!.analyze({ assetId: a.assetId, waitMs: 600, idempotencyKey: `es-call-${a.assetId}`, timeoutMs: 4000, signal: a.signal }).catch((err: unknown) => { if (a.signal?.aborted) throw err; return null; });
  if (!result || (result.state !== 'ready' && result.state !== 'partial')) return null;
  const observations = (result as { observations?: Array<Record<string, unknown>> }).observations;
  if (!Array.isArray(observations) || observations.length === 0) return null;
  const first = observations[0]!;
  const kind = String(first['kind'] ?? '观察');
  const value = first['value'] == null ? String(first['reason'] ?? '不可用') : `${first['value']}${first['unit'] ? ' ' + first['unit'] : ''}`;
  const text = `${kind}：${value}`.slice(0, 120);
  return text;
}

// ── R4（2026-10-23）：voice ingress——Siren CoreBridge 的同窗电话入口（NDJSON）──────────
// 合同（Siren packages/core-bridge/src/http-core-bridge.ts，逐字段对齐）：
//   POST /v1/chat/stream，content-type application/x-ndjson，body=单 JSON 对象
//   {conversation_id, call_id, turn_id, modality, text, interrupted_turn?{...}}
//   响应逐行 NDJSON：{"type":"delta","text"}* → {"type":"done"}；失败 {"type":"error","message"}
// B2 返修（2026-10-24，RE-02/03 + NDJSON_PLAN）：
//   - 正文=同一生成流真实新增（supervisor 语音抽头，与聊天落库同源、provider 速度）；
//     按句成帧（。！？!?…），取消代际内不再供给——拼接与聊天正本逐字一致、单句不必等整轮结束
//   - 幂等接纳 (call_id, turn_id)：同键同文已完成=重放终态回执（不再开模型/不再订未来事件）；
//     同键异文=409；在途重复=409；缺 call_id/turn_id=422（不再回落固定字面量）
//   - 断开=stop（含排队轮：CANCELLED_BEFORE_DISPATCH 不派发）；接纳行落确定终态
//   - 请求体走 readJson（限额+字节安全，分片 UTF-8 不破）；modality/interrupted_turn 入册
// 鉴权：Bearer 对 ESTOMAGO_VOICE_INGRESS_TOKEN（未配置=503 fail-closed，不静默开放）。
export async function handleVoiceChatStream(req: IncomingMessage, res: ServerResponse, d: RequestDeps): Promise<void> {
  const ndjsonError = (status: number, message: string): void => {
    try { res.writeHead(status, { 'Content-Type': 'application/x-ndjson' }); res.end(JSON.stringify({ type: 'error', message }) + '\n'); } catch { /* 已断 */ }
  };
  const token = process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
  if (!token || !token.trim()) return ndjsonError(503, 'voice ingress not configured');
  const authz = String(req.headers.authorization ?? '');
  if (authz !== `Bearer ${token}`) return ndjsonError(401, 'unauthorized');
  let input: { conversation_id?: unknown; call_id?: unknown; turn_id?: unknown; modality?: unknown; text?: unknown; interrupted_turn?: unknown; audio_ref?: unknown };
  try {
    input = (await readJson(req, d, 256 * 1024)) as typeof input;
  } catch (err) {
    const status = err instanceof ClientBodyError ? err.status : 400;
    return ndjsonError(status, 'invalid body');
  }
  const idOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
  if (!idOk(input.conversation_id) || !idOk(input.call_id) || !idOk(input.turn_id)) {
    return ndjsonError(422, 'conversation_id, call_id and turn_id are required (1..128 chars)');
  }
  if (typeof input.text !== 'string' || input.text.length === 0) return ndjsonError(422, 'non-empty text required');
  if (input.modality !== undefined && input.modality !== 'voice' && input.modality !== 'voice_call') return ndjsonError(422, 'modality must be voice|voice_call');
  const conversationId: string = input.conversation_id;
  const callId: string = input.call_id;
  const turnKey: string = input.turn_id;
  const conv = d.db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId) as { id: string } | undefined;
  if (!conv) return ndjsonError(404, 'conversation not found');

  // —— RE-03：幂等接纳（同窗提交仍走文字轮同一串行链/窗口工具/轨迹/计量）——
  const nowIso = new Date().toISOString();
  const textSha = sha256Hex(input.text);
  const prior = d.db.prepare('SELECT text_sha256, state FROM voice_stream_turns WHERE call_id=? AND turn_key=?').get(callId, turnKey) as { text_sha256: string; state: string } | undefined;
  if (prior) {
    if (prior.text_sha256 !== textSha) return ndjsonError(409, 'idempotency conflict: same call/turn with different text');
    if (prior.state === 'completed' || prior.state === 'failed' || prior.state === 'cancelled') {
      // 完成重试：返回合同终态回执——不再开模型、不再订阅未来事件、不重播整段旧音频
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform' });
      try { res.end(JSON.stringify({ type: 'done', replayed: true, prior_state: prior.state }) + '\n'); } catch { /* 已断 */ }
      return;
    }
    return ndjsonError(409, 'same call/turn already in flight');
  }
  d.db.prepare('INSERT INTO voice_stream_turns(call_id,turn_key,conversation_id,text_sha256,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(callId, turnKey, conversationId, textSha, 'admitted', nowIso, nowIso);
  // 通话登记：未显式 POST /v1/calls 时按首个电话轮自动立册（memory_only 以此为准；挂断由 DELETE /v1/calls 收口）
  if (!d.db.prepare('SELECT 1 FROM voice_calls WHERE call_id=?').get(callId)) {
    d.db.prepare("INSERT OR IGNORE INTO voice_calls(call_id,conversation_id,state,started_at) VALUES (?,?,'active',?)").run(callId, conversationId, nowIso);
  }
  if (input.interrupted_turn !== undefined && (typeof input.interrupted_turn !== 'object' || input.interrupted_turn === null)) {
    return ndjsonError(422, 'interrupted_turn must be an object');
  }

  // —— 审计修复（电话准备阶段取消失效）：幂等接纳完成后、第一次音频异步操作之前，
  //    建立本请求的取消处理。响应**非正常关闭**（res.close 且 !writableEnded）=客户端断开；
  //    req.close 不再监听（正常请求体读取结束也可能产生该事件，旧实现把它一律当取消）。
  const prepareAbort = new AbortController();
  let estTurnId: string | null = null; // turnId 可为空：timer/voiceTap/事件订阅在流阶段才建立
  let clientGone = false;
  let streamingCleanup: (() => void) | null = null;
  const closeAdmission = (state: 'completed' | 'failed' | 'cancelled'): void => {
    d.db.prepare("UPDATE voice_stream_turns SET state=?, updated_at=? WHERE call_id=? AND turn_key=? AND state NOT IN ('completed','failed','cancelled')")
      .run(state, new Date().toISOString(), callId, turnKey);
  };
  const onClientGone = (): void => {
    if (clientGone) return;
    clientGone = true;
    prepareAbort.abort(new Error('client disconnected'));
    // 接纳记录非终态收口为 cancelled（同键重试返回原终态）；不新建取消轮，不顺手结束 voice_calls
    closeAdmission('cancelled');
    // 已有 turn 才停止（准备阶段 turnId 可为空）
    if (estTurnId) void d.supervisor.stop(estTurnId);
    // 流阶段资源（timer/voiceTap/事件订阅/响应）存在才释放；准备阶段无可释放
    if (streamingCleanup) streamingCleanup();
  };
  res.on('close', () => { if (!res.writableEnded) onClientGone(); });
  // 安装后立即检查连接是否已经销毁（极快断开的窗口）
  if (res.destroyed && !res.writableEnded) onClientGone();

  // —— 协议②（2026-10-24）：本轮用户原声——Siren 已按 audio_ref=siren:<asset_id> 落资产，
  //    est 取回字节存本地 chat_voice 资产并绑定为该消息附件（oído 快证据/按需深听可用）。
  //    失败不阻断通话（如实降级为纯文字轮）；快证据有界等待（≤600ms，未就绪不拖电话）。
  //    审计修复：取消不得被降级 catch 吞掉——每个异步操作返回后先复核请求存活再落副作用。
  const audioRef = typeof input.audio_ref === 'string' && /^siren:[A-Za-z0-9_-]{1,128}$/.test(input.audio_ref) ? input.audio_ref.slice('siren:'.length) : null;
  let attachment: { asset_id: string; presentation: 'voice' } | null = null;
  let transcriptText: string | null = null;
  if (audioRef && d.media && d.sirenCall) {
    try {
      const audio = await d.sirenCall.fetchVoiceAssetAudio(audioRef, { timeoutMs: 8000, signal: prepareAbort.signal });
      if (prepareAbort.signal.aborted) return; // 取消：接纳已收口，无后续副作用
      if (audio) {
        const asset = await d.media.saveBuffer({
          bytes: audio.bytes, purpose: 'chat_voice',
          operationId: `siren-call:${callId}:${turnKey}`,
          createdBy: 'siren-bridge', origin: 'import', originService: 'siren', originRef: audioRef,
        });
        if (prepareAbort.signal.aborted) return; // 资产已存（副作用如实保留）；不继续
        transcriptText = input.text;
        d.db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,derived_source,duration_ms,created_at,updated_at) VALUES (?,?,?,?,'ready',?,?,NULL,?,?) ON CONFLICT(asset_id) DO UPDATE SET derived_text=excluded.derived_text,updated_at=excluded.updated_at")
          .run(asset.id, conversationId, `siren:${callId}:${turnKey}`, asset.content_sha256, transcriptText, 'siren:call', new Date().toISOString(), new Date().toISOString());
        // 快证据（A14 语义：宿主消费，非模型工具轮）：有界等待；未就绪=不带，不回写不拖电话。
        // 审计修复：signal 贯穿 ingest/analyze；ingest 已返回真实 receipt 时先保留 receipt 再检查取消，
        // 禁止继续 analyze；取消不得被"快证据失败忽略"吞掉。
        if (d.oido?.configured) {
          try {
            const obs = await quickVoiceObservation(d, { assetId: asset.id, bytes: audio.bytes, sha256: asset.content_sha256, mime: audio.mime, transcript: input.text, signal: prepareAbort.signal });
            if (prepareAbort.signal.aborted) return; // receipt 已持久化；不提交正式消息
            if (obs) {
              const marked = `\n[声音观察（oído 快证据，非转写）：${obs}]`;
              d.db.prepare('UPDATE voice_transcripts SET derived_text=? WHERE asset_id=?').run(transcriptText + marked, asset.id);
              transcriptText = transcriptText + marked;
            }
          } catch (err) {
            if (prepareAbort.signal.aborted) return; // 取消不得被吞
            /* 快证据失败=不带（如实缺省） */
          }
        }
        d.media.validateForSend([{ asset_id: asset.id, presentation: 'voice' }]); // §5.2：附件先全量校验再入事务
        if (prepareAbort.signal.aborted) return; // 提交正式消息前再检查一次（操作期间存活的请求状态复核）
        attachment = { asset_id: asset.id, presentation: 'voice' };
      }
    } catch (err) {
      if (prepareAbort.signal.aborted) return; // 取消不得被"音频失败降级纯文字"吞掉
      /* 原声取回失败=纯文字轮（如实降级） */
    }
  }
  // 提交正式消息前最后复核（操作期间会变化的请求存活状态，非重复校验静态参数）
  if (prepareAbort.signal.aborted) return;

  const sub = d.messages.submitUserMessageWithTurn({
    conversationId: conversationId,
    content: attachment ? '' : input.text,
    clientMessageId: `voice:${callId}:${turnKey}`,
    occurredAt: new Date().toISOString(),
    ...(attachment ? { attachments: [attachment] } : {}),
  });
  estTurnId = sub.turnId; // 审计修复：turnId 接线到统一取消处理（此后断开→stop 该 turn）
  d.db.prepare("UPDATE voice_stream_turns SET est_turn_id=?, state='running', updated_at=? WHERE call_id=? AND turn_key=?")
    .run(sub.turnId, new Date().toISOString(), callId, turnKey);

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform' });
  const send = (obj: Record<string, unknown>): boolean => { try { return res.write(JSON.stringify(obj) + '\n'); } catch { return false; } };

  // —— RE-02：同一生成流的语音正文通道 ——
  // 行首学舌标记剥离与聊天发布层同规则；句级成帧（含无换行短句：完整句尾即发）；
  // 末尾残余在终态前冲刷。拼接==聊天正本（正常内容逐字一致）。
  let pending = '';
  let atLineStart = true;
  const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…']);
  const stripMarker = (t: string): string => t.replace(/^(\[seq ?\d+\]|\[\d+\])\s*/, '');
  const emitSentences = (flush: boolean): void => {
    for (;;) {
      const chars = [...pending];
      let cut = -1;
      for (let i = 0; i < chars.length; i++) {
        if (SENTENCE_END.has(chars[i]!)) cut = i + 1;
      }
      if (cut <= 0) break;
      let chunk = chars.slice(0, cut).join('');
      pending = chars.slice(cut).join('');
      if (atLineStart) chunk = stripMarker(chunk);
      atLineStart = chunk.endsWith('\n');
      if (chunk.length > 0) send({ type: 'delta', text: chunk });
    }
    if (flush && pending.length > 0) {
      let chunk = pending;
      pending = '';
      if (atLineStart) chunk = stripMarker(chunk);
      atLineStart = chunk.endsWith('\n');
      if (chunk.length > 0) send({ type: 'delta', text: chunk });
    }
  };
  const detachTap = d.supervisor.registerVoiceTap(sub.turnId, (tail) => {
    // 行边界维护：换行符原样保留（拼接与正本逐字一致）；行首标记按聊天发布层同规则剥离
    const lines = tail.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) { pending += '\n'; atLineStart = true; }
      const piece = lines[i]!;
      pending += atLineStart ? stripMarker(piece) : piece;
      if (piece.length > 0) atLineStart = false;
    }
    emitSentences(false);
  });

  const subEvents = d.events.subscribe(conversationId);
  let closed = false;
  // 审计修复：admissionClose 与 closeAdmission 同语义（统一收口）；cleanup 同步给准备阶段取消处理
  const admissionClose = closeAdmission;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pump);
    detachTap();
    d.events.unsubscribe(subEvents);
    try { res.end(); } catch { /* 已断 */ }
  };
  streamingCleanup = () => cleanup();
  // 审计修复：req.on('close') 删除——正常请求体读取结束也可能产生该事件，不得一律当取消；
  // 客户端断开由统一 res.close 处理（onClientGone：区分 writableEnded；已生成原文保留）
  const pump = setInterval(() => {
    if (closed) return;
    for (const queued of subEvents.queue.splice(0)) {
      const row = toSseDto(queued.eventRow);
      if (row.turn_id !== sub.turnId) continue;
      if (row.kind === 'turn.completed') {
        emitSentences(true);
        send({ type: 'done' });
        admissionClose('completed');
        cleanup();
        return;
      } else if (row.kind === 'turn.interrupted') {
        emitSentences(true);
        send({ type: 'done', interrupted: true }); // 打断=已生成原文保留；作为完成流收口
        admissionClose('completed');
        cleanup();
        return;
      } else if (row.kind === 'turn.status') {
        const state = row['state'] as string | undefined;
        const reason = row['reason'] as string | undefined;
        if (state === 'failed') {
          send({ type: 'error', message: reason ?? 'turn failed' });
          admissionClose('failed');
          cleanup();
          return;
        }
      }
    }
  }, 25);
  d.supervisor.enqueue(sub.turnId);
}

// P07.1 第一批：voice/call 路由组迁 server/routes/voice-call.ts（响应/认证/路径逐字保持；
// 本处转发 shim 保持既有 import 位置兼容调用点，P09 复核收口）。
import { handleVoiceCallLifecycle } from './routes/voice-call.ts';
import { handleContentProxy } from './routes/content.ts';
import { handleBackgroundRoutes } from './routes/background.ts';
import { handleConversationRoutes } from './routes/conversations.ts';
import { handleOidoUiRoutes } from './routes/oido-ui.ts';
import { handleRuntimeSettingsRoutes } from './routes/runtime-settings.ts';
import { handleContextSelectionRoutes } from './routes/context-selection.ts';
import { handleCalendarRoutes } from './routes/calendar.ts';
import { handleAssetsRoutes } from './routes/assets.ts';
import { handleDialRoutes } from './routes/dial.ts';
import { handleSystemRoutes } from './routes/system.ts';
import { json, readJson, ClientBodyError, estimateContextFor } from './http-leaf.ts';
export { handleVoiceCallLifecycle };
void handleVoiceCallLifecycle;

