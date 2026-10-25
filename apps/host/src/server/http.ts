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


    // —— SSE 事件流+turn 组——P07.2 迁 server/routes/events.ts（逐字）；精确路由表委托。
    if (route === 'GET /api/v1/events'
      || /^GET \/api\/v1\/turns\/([^/]+)\/reasoning$/.test(route)) {
      return await handleTurnRoutes(req, res, d, route, url);
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
    if (/^POST \/api\/v1\/turns\/([^/]+)\/stop$/.test(route)
      || /^POST \/api\/v1\/windows\/([^/]+)\/rotate$/.test(route)
      || /^GET \/api\/v1\/turns\/([^/]+)\/usage$/.test(route)
      || /^GET \/api\/v1\/turns\/([^/]+)$/.test(route)) {
      return await handleTurnRoutes(req, res, d, route, url);
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
import { handleTurnRoutes, handleSse, toSseDto } from './routes/events.ts';
import { handleVoiceChatStream } from './routes/voice-stream.ts';
export { handleVoiceChatStream }; // P07.2：正本迁 routes/voice-stream.ts——re-export 供既有 ingress/b8/reaudit 测试直调
export { handleSse, toSseDto }; // P07.2：SSE 正本迁 routes/events.ts——re-export 供组件级背压回归（AUD-29）
import { json, readJson, ClientBodyError, estimateContextFor } from './http-leaf.ts';
export { handleVoiceCallLifecycle };
void handleVoiceCallLifecycle;

