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

    // —— 2026-10-08 她裁定：聊天窗换模型/推理等级 ——
    const rtGet = route === 'GET /api/v1/runtime-settings';
    if (rtGet) {
      const cfg = d.config.openrouter;
      const effModel = d.settings ? d.settings.effectiveOrModel(cfg.model) : cfg.model;
      const effEffort = d.settings ? (d.settings.reasoningEffort() ?? 'default') : 'default';
      // 档位按当前生效模型的真实支持生成（OR 公开元数据；强制思考模型
      // 没有 none/minimal——此前静态全表会在这些模型上吃 400）
      let efforts: string[] | null = null;
      if (d.runnerSelection.status === 'ok' && d.runnerSelection.runner.kind === 'openrouter' && effModel) {
        const meta = await fetchOrModelMeta(cfg.base_url, effModel);
        efforts = effortsForModel(meta, effModel);
      }
      return json(res, 200, {
        driver: d.runnerSelection.status === 'ok' ? d.runnerSelection.runner.kind : 'unknown',
        or_model: { effective: effModel, override: d.settings?.orModel() ?? null, config_default: cfg.model },
        reasoning_effort: { effective: effEffort, override: d.settings?.reasoningEffort() ?? null, config_default: cfg.reasoning },
        model_options: cfg.model_options ?? [],
        effort_options: efforts ?? ['default'],
        effort_options_verified: efforts !== null,
        note: '切模型=运行边界变化，下一条消息将等待历史选集确认后换窗；切思考深度=立即生效，不换窗（上下文复用）',
      });
    }
    const rtPut = route === 'PUT /api/v1/runtime-settings';
    if (rtPut) {
      if (!d.settings) return json(res, 503, { error: { code: 'unavailable', message: '运行时设置服务未接线' } });
      const body = (await readJson(req, d)) as { or_model?: unknown; reasoning_effort?: unknown };
      // WP-04（JFA-B05/CX-10/C-016）：两字段全验通过后一次性写入——
      // 任一失败 422 且零写入（不再逐字段先写先错）；or_model 按配置层
      // 同款形状门（orModelIdIssue：auto/latest/逗号拼单/未知形态拒）
      const nextModel: string | null | undefined = body.or_model !== undefined
        ? (body.or_model === null || body.or_model === ''
            ? null
            : typeof body.or_model === 'string' && body.or_model.trim().length > 0 && body.or_model.length <= 128
              ? body.or_model.trim()
              : undefined)
        : undefined;
      if (body.or_model !== undefined && nextModel === undefined) {
        return json(res, 422, { error: { code: 'invalid_model', message: 'or_model 必须是非空字符串或 null（回落默认）' } });
      }
      if (nextModel !== undefined && nextModel !== null) {
        const issue = orModelIdIssue(nextModel);
        if (issue) return json(res, 422, { error: { code: 'invalid_model', message: issue, field: 'or_model' } });
      }
      let nextEffort: string | null | undefined = body.reasoning_effort !== undefined
        ? (body.reasoning_effort === null || body.reasoning_effort === 'default'
            ? null
            : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort as string)
              ? (body.reasoning_effort as string)
              : undefined)
        : undefined;
      if (body.reasoning_effort !== undefined && nextEffort === undefined) {
        return json(res, 422, { error: { code: 'invalid_effort', message: 'reasoning_effort 必须是 default|none|minimal|low|medium|high|xhigh|max 或 null' } });
      }
      // FU-001（二次回访 2026-10-10）：按合并 patch 后的**真实生效对**
      // 校验——此前 null/default 清除回落配置默认的组合不经校验：
      // 模型清空回落 A+low、档位清空回落 B+high 均被 200 落库。候选
      // 模型=patch ?? override ?? 配置默认；候选档位=patch ?? override
      // ?? 配置默认 effort（含 model-only 继承）。元数据可及时校验；
      // 具体模型优先使用官方已核实档位；未知模型元数据不可达时拒绝新设置。
      const candidateModel = (nextModel !== undefined ? nextModel : d.settings.orModel())
        ?? d.config.openrouter.model;
      const defEffort = (d.config.openrouter.reasoning as { effort?: unknown } | null | undefined)?.effort;
      const defEffortStr = typeof defEffort === 'string' && defEffort !== 'default' ? defEffort : null;
      const candidateEffort = (nextEffort !== undefined ? nextEffort : d.settings.reasoningEffort()) ?? defEffortStr;
      if (candidateEffort !== null && candidateModel) {
        const driver = d.runnerSelection.status === 'ok' ? d.runnerSelection.runner.kind : null;
        if (driver === 'openrouter') {
          const meta = await fetchOrModelMeta(d.config.openrouter.base_url, candidateModel);
          const allowed = effortsForModel(meta, candidateModel);
          if (!allowed) {
            return json(res, 422, { error: { code: 'effort_unverified', message: '当前模型的思考档位尚未核实，请稍后重试' } });
          }
          if (allowed && !allowed.includes(candidateEffort)) {
            return json(res, 422, { error: { code: 'effort_not_supported', message: `候选生效模型 ${candidateModel} 不支持思考档位 ${candidateEffort}`, supported: allowed } });
          }
        }
      }
      // FU-002（回访）：全验通过后**单事务**写入（setMany）——此前两字段
      // 各开事务，第二写失败后第一写已提交（半提交状态）
      const writes: Array<[string, string | null]> = [];
      if (nextModel !== undefined) writes.push(['or_model', nextModel]);
      if (nextEffort !== undefined) writes.push(['reasoning_effort', nextEffort]);
      d.settings.setMany(writes);
      const cfg2 = d.config.openrouter;
      return json(res, 200, {
        or_model: { effective: d.settings.effectiveOrModel(cfg2.model), override: d.settings.orModel() },
        reasoning_effort: { effective: d.settings.reasoningEffort() ?? 'default', override: d.settings.reasoningEffort() },
      });
    }

    // —— WP3（2026-10-08 她裁定）：人工历史选集 ——

    // WP-03（2026-10-09，JFA-009/B02）：当前 awaiting 选集行——无活动窗时
    // 前端的 fallback 锚（source_window_id 是 preview/confirm 的合法目标，
    // 含 csel-src-* 哨兵源；无 awaiting 返回 null，真首窗语义不变）
    const selAwaiting = /^GET \/api\/v1\/conversations\/([^/]+)\/context-selection$/.exec(route);
    if (selAwaiting) {
      const conversationId = decodeURIComponent(selAwaiting[1]!);
      const row = d.selections?.awaitingFor(conversationId) ?? null;
      return json(res, 200, { selection: row ? { id: row.selection_id, status: row.status, source_window_id: row.source_window_id } : null });
    }

    // preview（§6.2）：只读核验（引用/修订/hash/发布状态/间隙/粗估）——
    // 不跑模型、不 hold、不换窗、不写选集
    const selPreview = /^POST \/api\/v1\/windows\/([^/]+)\/context-selection\/preview$/.exec(route);
    if (selPreview) {
      const windowId = decodeURIComponent(selPreview[1]!);
      const body = (await readJson(req, d)) as { conversation_id?: unknown; items?: unknown };
      const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : PRIMARY_CONVERSATION;
      const items = parseSelectionItems(body.items);
      const result = d.supervisor.selectionPreview(conversationId, windowId, items);
      return json(res, result.ok ? 200 : 422, result.ok ? { preview: result.result } : { error: { code: result.error.code, detail: result.error } });
    }

    // confirm（§6.2/§6.3）：幂等键 + expected_window_revision CAS + explicit_empty；
    // 有被选集阻断的待回答输入时，确认后自动换窗并以原 input_message_id 恢复
    const selConfirm = /^POST \/api\/v1\/windows\/([^/]+)\/context-selection\/confirm$/.exec(route);
    if (selConfirm) {
      const windowId = decodeURIComponent(selConfirm[1]!);
      const body = (await readJson(req, d)) as { conversation_id?: unknown; items?: unknown; explicit_empty?: unknown; idempotency_key?: unknown; expected_window_revision?: unknown };
      const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : PRIMARY_CONVERSATION;
      const items = parseSelectionItems(body.items);
      const result = await d.supervisor.selectionConfirm({
        conversationId,
        windowId,
        items,
        explicitEmpty: body.explicit_empty === true,
        idempotencyKey: typeof body.idempotency_key === 'string' && body.idempotency_key.length > 0 ? body.idempotency_key : null,
        expectedWindowRevision: typeof body.expected_window_revision === 'number' && Number.isInteger(body.expected_window_revision) ? body.expected_window_revision : undefined,
      });
      return json(res, result.ok ? 200 : 422, result.ok
        ? { selection: { id: result.selection_id, rotated: result.rotated, window_id: result.windowId, resumed: result.resumed } }
        : { error: { code: result.error.code, detail: result.error } });
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
        // WP-07（CX-10）：无活动窗时附 awaiting 选集引用——UI 锚定确认
        // 入口（preview/confirm 以 source_window_id 为目标，含哨兵源）
        awaiting_selection: active ? null : (() => {
          const row = d.selections?.awaitingFor(conversationId) ?? null;
          return row ? { id: row.selection_id, source_window_id: row.source_window_id } : null;
        })(),
        thresholds: {
          status: d.config.windows.threshold_status,
          model_context_capacity: d.config.windows.model_context_capacity,
          soft_limit_tokens: d.config.windows.soft_limit_tokens,
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
      // 她 2026-10-24 裁定（approve 补完）：三选择统一走 validateAndConsume——
      // approve=接受路由结果并继续（路由信号时刻不存在完整可放行的回答：正文边流边落库、
      // 信号后内容被 fence 丢弃；service 层为同 turn 建 fresh_session=0 的新 attempt，
      // 续用窗口 session，已执行工具不重放）。票据校验（404/409/过期/绑定链）全部由
      // service 统一承担；续跑再次路由信号由 supervisor 终局守卫（ROUTE_SIGNAL_AFTER_APPROVE）
      // 收口，不开新票据。
      const consumed = d.routing.validateAndConsume(decisionId, body.choice === 'edit' ? { choice: 'edit', content: String(body.content ?? '') } : { choice: body.choice });
      if (!consumed.ok) return json(res, consumed.status, { error: { code: consumed.code, message: consumed.reason } });
      // 决议完成：重新驱动该房间排队的 turn（AUD-05）
      d.supervisor.requeueConversationQueuedTurns(consumed.row.conversation_id);
      if (body.choice === 'edit') {
        const turn = d.db.prepare('SELECT input_message_id FROM turns WHERE id = ?').get(consumed.turnId) as { input_message_id: string | null };
        const message = turn?.input_message_id ? d.messages.getMessage(turn.input_message_id) : null;
        return json(res, 200, { resolved: 'edit', message, attempt_id: consumed.newAttemptId, revision: consumed.editRevision, released_waiting: consumed.releasedWaiting });
      }
      if (body.choice === 'approve') {
        return json(res, 200, { resolved: 'approve', attempt_id: consumed.newAttemptId, released_waiting: consumed.releasedWaiting });
      }
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

    // —— EXEC_V1 §03.5.1（WP3/MEDIA-11）：active MIME 隔离预览——CSP sandbox + nosniff ——
    const sandboxPreview = /^GET \/api\/v1\/assets\/([^/]+)\/preview$/.exec(route);
    if (sandboxPreview) {
      if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
      try {
        const id = decodeURIComponent(sandboxPreview[1]!);
        const asset = d.media.getAsset(id);
        // 只有 SVG/HTML 走沙箱路径；普通图片走 content 端点
        if (asset.mime_type !== 'image/svg+xml' && asset.mime_type !== 'text/html') {
          return json(res, 400, { error: { code: 'not_active_mime', message: '此资产不需要沙箱预览（走 content 端点）' } });
        }
        const { bytes, mime } = d.media.readContent(id);
        // §03.5.1：不能只靠 iframe sandbox——资产 URL 被直接打开时也不能在 est 主站来源执行
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': String(bytes.length),
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'",
          'Cache-Control': 'no-store',
        });
        res.end(bytes);
        return;
      } catch (err) {
        if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
        throw err;
      }
    }

    // —— EXEC_V1 §06.7（WP6）：日历读聚合（月概要=计数/标记；日详情=分源分页）——
    if (route === 'GET /api/v1/calendar/month') {
      const month = url.searchParams.get('month') ?? '';
      if (!/^\d{4}-\d{2}$/.test(month)) return json(res, 400, { error: { code: 'bad_month', message: 'month 必须是 YYYY-MM' } });
      const result = buildCalendarMonth({
        db: d.db, config: d.config,
        mariposaReady: false,
        superpositionReady: false,
        contentReady: d.contentClient !== null && d.contentClient !== undefined,
      }, month);
      if (!result) return json(res, 400, { error: { code: 'bad_month', message: '月份非法' } });
      return json(res, 200, result);
    }
    if (route === 'GET /api/v1/calendar/day') {
      const date = url.searchParams.get('date') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: { code: 'bad_date', message: 'date 必须是 YYYY-MM-DD' } });
      // 日概要：各来源状态+入口（不返回全部原文）
      const sources = ['chat', 'memory', 'plans', 'stars', 'reminders', 'future_notes', 'creations'] as const;
      const summary: Record<string, unknown> = {};
      for (const src of sources) {
        const r = buildCalendarDayItems({ db: d.db, config: d.config, mariposaReady: false, superpositionReady: false, contentReady: Boolean(d.contentClient), contentClient: d.contentClient ?? null }, date, src, null, 1);
        if (r) summary[src] = { status: r.status, has_items: r.items.length > 0 || r.has_more };
      }
      return json(res, 200, { date, timezone: 'Asia/Shanghai', sources: summary });
    }
    if (route === 'GET /api/v1/calendar/day/items') {
      const date = url.searchParams.get('date') ?? '';
      const source = url.searchParams.get('source') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: { code: 'bad_date', message: 'date 必须是 YYYY-MM-DD' } });
      const validSources = ['chat', 'memory', 'plans', 'stars', 'reminders', 'future_notes', 'creations'];
      if (!validSources.includes(source)) return json(res, 400, { error: { code: 'bad_source', message: `source 必须是 ${validSources.join('|')}` } });
      const limit = Number(url.searchParams.get('limit')) || POLICY_CONSTANTS.pagination.default_limit;
      if (limit < 1 || limit > POLICY_CONSTANTS.pagination.max_limit) return json(res, 400, { error: { code: 'limit_invalid', message: `limit 必须在 1..${POLICY_CONSTANTS.pagination.max_limit}` } });
      const cursor = url.searchParams.get('cursor');
      const result = buildCalendarDayItems({ db: d.db, config: d.config, mariposaReady: false, superpositionReady: false, contentReady: Boolean(d.contentClient), contentClient: d.contentClient ?? null }, date, source as CalendarSource, cursor, limit);
      if (!result) return json(res, 400, { error: { code: 'bad_date', message: '日期非法' } });
      return json(res, 200, result);
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

    if (route === 'GET /api/v1/voice/status') {
      return json(res, 200, d.voice?.status() ?? { available: false, reason: 'voice_unavailable', verification: 'blocked' });
    }
    const voiceTranscribe = /^POST \/api\/v1\/assets\/([^/]+)\/transcribe$/.exec(route);
    if (voiceTranscribe) {
      if (!d.voice) return json(res, 503, { error: { code: 'voice_unavailable', message: '语音服务未装配' } });
      const opKey = String(req.headers['idempotency-key'] ?? '');
      if (!opKey || opKey.length > 256) return json(res, 400, { error: { code: 'missing_idempotency', message: '需要有效 Idempotency-Key' } });
      const body = (await readJson(req, d)) as { conversation_id?: unknown } | null;
      if (!body || typeof body.conversation_id !== 'string' || !body.conversation_id) return json(res, 400, { error: { code: 'bad_conversation', message: 'conversation_id 必填' } });
      try { return json(res, 200, await d.voice.transcribe(decodeURIComponent(voiceTranscribe[1]!), body.conversation_id, opKey)); }
      catch (err) {
        if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
        throw err;
      }
    }

    // —— EXEC_V1 §03.5（WP3）：媒体资产 API（Idempotency-Key 必带；二进制上传流式限量）——
    if (route === 'POST /api/v1/assets') {
      if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
      const purpose = url.searchParams.get('purpose') ?? '';
      const validPurposes = ['chat_image', 'chat_sticker', 'chat_voice', 'creation_icon', 'creation_work'];
      if (!validPurposes.includes(purpose)) return json(res, 400, { error: { code: 'bad_purpose', message: `purpose 必须是 ${validPurposes.join('|')}` } });
      const opKey = String(req.headers['idempotency-key'] ?? '');
      if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
      const cap = purpose === 'chat_voice' ? d.config.media.max_audio_bytes
        : purpose === 'chat_image' || purpose === 'chat_sticker' ? d.config.media.max_image_bytes
          : Math.max(d.config.media.max_code_artifact_bytes, d.config.media.max_video_bytes);
      try {
        const bytes = await readRawBody(req, cap);
        const asset = await d.media.saveBuffer({ bytes, purpose: purpose as IngestPurpose, operationId: `upload:${opKey}`, createdBy: 'qiaosheng', origin: 'upload' });
        return json(res, 201, { asset_id: asset.id, mime_type: asset.mime_type, byte_size: asset.byte_size, state: asset.state, content_sha256: asset.content_sha256, duplicate_content: asset.duplicate });
      } catch (err) {
        if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
        throw err;
      }
    }
    if (route === 'POST /api/v1/assets/import') {
      if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
      const opKey = String(req.headers['idempotency-key'] ?? '');
      if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
      const body = (await readJson(req, d)) as { source_url?: unknown };
      if (typeof body.source_url !== 'string' || !body.source_url) return json(res, 400, { error: { code: 'bad_source_url', message: 'source_url 必填' } });
      try {
        const asset = await d.media.importFromUrl({ sourceUrl: body.source_url, operationId: `import:${opKey}`, createdBy: 'qiaosheng' });
        return json(res, 201, { asset_id: asset.id, mime_type: asset.mime_type, byte_size: asset.byte_size, state: asset.state });
      } catch (err) {
        if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
        throw err;
      }
    }
    const assetGet = /^GET \/api\/v1\/assets\/([^/]+)$/.exec(route);
    if (assetGet) {
      if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
      try {
        const a = d.media.getAsset(decodeURIComponent(assetGet[1]!));
        return json(res, 200, { ...a, content_url: `/api/v1/assets/${encodeURIComponent(a.id)}/content` }); // 相对地址；不返回存储绝对路径/源站凭据
      } catch (err) {
        if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
        throw err;
      }
    }
    const assetContent = /^GET \/api\/v1\/assets\/([^/]+)\/content$/.exec(route);
    if (assetContent) {
      if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
      const id = decodeURIComponent(assetContent[1]!);
      try {
        const { bytes, mime } = d.media.readContent(id);
        const range = String(req.headers.range ?? '');
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        // 语音播放所需的最小 Range 行为（§5.1）：单区间
        if (m && (m[1] !== '' || m[2] !== '')) {
          const start = m[1] === '' ? Math.max(0, bytes.length - Number(m[2] || 0)) : Number(m[1]);
          const end = m[2] === '' ? bytes.length - 1 : Math.min(bytes.length - 1, Number(m[2]));
          if (start > end || start >= bytes.length) return json(res, 416, { error: { code: 'range_not_satisfiable', message: '区间越界' } });
          const slice = bytes.subarray(start, end + 1);
          const isActiveR = mime === 'image/svg+xml' || mime === 'text/html';
          const activeHeadersR: Record<string, string> = isActiveR ? {
            'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
            'Content-Disposition': 'attachment; filename="asset"',
          } : {};
          res.writeHead(206, { 'Content-Type': mime, 'Content-Length': String(slice.length), 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...activeHeadersR });
          res.end(slice);
          return;
        }
        // AUD-03 P1 修复：active MIME（SVG/HTML）在 content 端点也加隔离——不只靠 preview 路由
        const isActiveMime = mime === 'image/svg+xml' || mime === 'text/html';
        const activeHeaders: Record<string, string> = isActiveMime ? {
          'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
          'Content-Disposition': 'attachment; filename="asset"',
        } : {};
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...activeHeaders });
        res.end(bytes);
        return;
      } catch (err) {
        if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
        throw err;
      }
    }
    const refPost = /^POST \/api\/v1\/assets\/([^/]+)\/references$/.exec(route);
    if (refPost) {
      // §03.10.2：受控服务接口——调用方身份由宿主配置映射，不接受浏览器自报 owner_service 扩权
      if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
      const opKey = String(req.headers['idempotency-key'] ?? '');
      if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
      const body = (await readJson(req, d)) as { owner_service?: unknown; owner_type?: unknown; owner_id?: unknown; owner_revision?: unknown };
      // 允许的内容域（WP5 接线前静态注册；浏览器可用但仅限登记引用，不构成授权扩面）
      const ALLOWED_OWNERS: Record<string, string[]> = { content: ['album_entry', 'post', 'creation', 'future_note'] };
      const os = String(body.owner_service ?? '');
      const ot = String(body.owner_type ?? '');
      if (!(os in ALLOWED_OWNERS) || !ALLOWED_OWNERS[os]!.includes(ot)) return json(res, 403, { error: { code: 'owner_not_allowed', message: '不允许的引用域' } });
      if (typeof body.owner_id !== 'string' || !body.owner_id) return json(res, 400, { error: { code: 'bad_owner_id', message: 'owner_id 必填' } });
      try {
        const r = d.media.registerReference({ assetId: decodeURIComponent(refPost[1]!), ownerService: os, ownerType: ot, ownerId: body.owner_id, ownerRevision: typeof body.owner_revision === 'number' ? body.owner_revision : null, operationId: `ref:${opKey}` });
        return json(res, 201, { reference_id: r.referenceId, revision: r.revision, state: r.state });
      } catch (err) {
        if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
        throw err;
      }
    }
    const refDelete = /^DELETE \/api\/v1\/assets\/([^/]+)\/references\/([^/]+)$/.exec(route);
    if (refDelete) {
      if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
      const opKey = String(req.headers['idempotency-key'] ?? '');
      if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
      const ifMatch = String(req.headers['if-match'] ?? '').replace(/"/g, '');
      if (!ifMatch || !/^\d+$/.test(ifMatch)) return json(res, 428, { error: { code: 'precondition_required', message: '解除引用必须带 If-Match: "<revision>"（请刷新后重试）' } });
      try {
        const r = d.media.releaseReference({ referenceId: decodeURIComponent(refDelete[2]!), expectedRevision: Number(ifMatch), operationId: `unref:${opKey}` });
        return json(res, 200, { reference_id: r.referenceId, revision: r.revision, state: r.state });
      } catch (err) {
        if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
        throw err;
      }
    }

    // —— RE-12c（2026-10-24）：资产删除正式入口——markAssetMissing 的真实产品消费者。
    // 守卫：仍被任何消息修订附件或 protected/committed 外部引用的资产拒绝删除（多合法引用
    // 不误删）；通过→state=missing（本地源停止读取），有 oído 导入回执时同事务写远端删除
    // 意图，物理清理由既有 outbox 重试（delete-retry.ts）收口；pending≠已删。
    const assetDelete = /^DELETE \/api\/v1\/assets\/([^/]+)$/.exec(route);
    if (assetDelete) {
      if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
      const id = decodeURIComponent(assetDelete[1]!);
      try {
        d.media.getAsset(id); // 不存在=404
        const refs = d.media.isAssetReferenced(id);
        if (refs.referenced) {
          return json(res, 409, { error: { code: 'asset_referenced', message: `资产仍被引用（消息修订附件 ${refs.by_message_revisions} 条、外部引用 ${refs.by_external_refs} 条）；先解除全部引用再删除`, by_message_revisions: refs.by_message_revisions, by_external_refs: refs.by_external_refs } });
        }
        d.media.markAssetMissing(id);
        return json(res, 200, { asset_id: id, state: 'missing', note: '源已标删；远端派生副本（如有）由删除意图重试清理' });
      } catch (err) {
        if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
        throw err;
      }
    }

    // —— RE-05（2026-10-24）：oído 测量图二进制路由（UI 消费）——读 oido_view 工具落的本地
    // 派生工件（oido_view_artifacts → media 资产）；无工件 404 如实（不代理远端、不落 base64）。
    const oidoViewRoute = /^GET \/api\/v1\/oido\/views\/([^/]+)$/.exec(route);
    if (oidoViewRoute) {
      if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
      const analysisId = decodeURIComponent(oidoViewRoute[1]!);
      const rangeParam = String(url.searchParams.get('range_ms') ?? '');
      const rangeKey = /^\d+,\d+$/.test(rangeParam) ? rangeParam : 'full';
      const row = d.db.prepare('SELECT asset_id FROM oido_view_artifacts WHERE analysis_id=? AND range_json=?').get(analysisId, rangeKey) as { asset_id: string } | undefined;
      if (!row) return json(res, 404, { error: { code: 'view_not_found', message: '该分析没有已生成的测量图工件（先由 oido_view 生成）' } });
      try {
        const { bytes, mime } = d.media.readContent(row.asset_id);
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60' });
        res.end(bytes);
        return;
      } catch (err) {
        if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
        throw err;
      }
    }

    // —— B2/RE-04（2026-10-24）：正式前端建呼代理（owner 面）——est 后端持 Siren 内部地址，
    //    短 call token 只回给本次通话的页面（Siren 内部凭据不进前端）；同键立册 voice_calls
    //    （memory_only 生效）。挂断：DELETE /api/v1/calls/:callId（est 收口；WS 1000 由面板关闭）。
    // —— 她→他通话请求（2026-10-24 她要的功能：她发起，char可接可拒）——
    //     pending → accepted（他接：est 建 Siren 通话，连接信息挂请求上供前端取）
    //            | declined（他拒：他的话=拒绝轮正文自然落会话）
    //            | cancelled（她关面板/挂断等待）| expired（惰性判定，轮询时收口）
    const DIAL_DEFAULT_TTL_MS = 45_000;
    const dialExpireLazy = (now: number): void => {
      d.db.prepare("UPDATE dial_requests SET state='expired', updated_at=? WHERE state='pending' AND CAST(strftime('%s',created_at) AS INTEGER)*1000 + ttl_ms < ?")
        .run(new Date().toISOString(), now);
    };
    const dialCurrent = (): Record<string, unknown> | null => {
      dialExpireLazy(Date.now());
      const row = d.db.prepare("SELECT * FROM dial_requests WHERE conversation_id='primary' AND state IN ('pending','accepted','declined','expired') ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        request_id: row['id'], state: row['state'],
        ...(row['state'] === 'accepted' ? { ws_url: row['ws_url'], token: row['call_token'], call_id: row['call_id'] } : {}),
      };
    };
    if (route === 'POST /api/v1/calls/dial') {
      // 已有待处理请求：幂等返回（重复点击不重建）
      const cur = dialCurrent();
      if (cur && (cur['state'] === 'pending' || cur['state'] === 'accepted')) return json(res, 200, cur);
      const id = `dial_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const nowIso = new Date().toISOString();
      d.db.prepare("INSERT INTO dial_requests(id,conversation_id,state,ttl_ms,created_at,updated_at) VALUES (?,'primary','pending',?,?,?)").run(id, DIAL_DEFAULT_TTL_MS, nowIso, nowIso);
      // 告诉char（程序事实轮，同串行链；他闲着就立刻收到）
      try {
        d.supervisor.submitProgramFactTurn('primary', 'incoming_dial',
          `她刚刚发起语音通话请求（等你接听，约 45 秒内有效）。接听：调用 call_control，action=accept_call。拒绝：调用 call_control，action=decline_call，并在同一回复里自然地对她说一句为什么不方便或改约——她会看到你的话，通话不开始。超时不选即过期。`,
          `dial:${id}`);
      } catch { /* 事实轮失败=请求保持 pending 到期（如实降级） */ }
      return json(res, 200, { request_id: id, state: 'pending', note: '正在等char接听' });
    }
    if (route === 'GET /api/v1/calls/dial/current') {
      return json(res, 200, dialCurrent() ?? { state: 'idle' });
    }
    const dialCancel = /^DELETE \/api\/v1\/calls\/dial\/([^/]+)$/.exec(route);
    if (dialCancel) {
      d.db.prepare("UPDATE dial_requests SET state='cancelled', updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), dialCancel[1]!);
      return json(res, 200, { request_id: dialCancel[1]!, state: 'cancelled' });
    }

    if (route === 'POST /api/v1/calls') {
      const rawBody = (await readJson(req, d, 16 * 1024)) as { conversation_id?: unknown } | null;
      if (typeof rawBody?.conversation_id !== 'string' || !rawBody.conversation_id) return json(res, 400, { error: { code: 'bad_conversation', message: 'conversation_id 必填' } });
      if (!d.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(rawBody.conversation_id)) return json(res, 404, { error: { code: 'not_found', message: '会话不存在' } });
      const sirenBase = process.env.ESTOMAGO_SIREN_BASE_URL;
      if (!sirenBase) return json(res, 503, { error: { code: 'siren_unconfigured', message: 'Siren 通话服务未配置（能力缺口，如实拒绝）' } });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const sirenToken = process.env.ESTOMAGO_SIREN_INTERNAL_TOKEN;
      if (sirenToken) headers.Authorization = `Bearer ${sirenToken}`;
      let sirenRes: Response;
      try {
        sirenRes = await fetch(`${sirenBase.replace(/\/$/, '')}/v1/calls`, { method: 'POST', headers, body: JSON.stringify({ conversation_id: rawBody.conversation_id }), signal: AbortSignal.timeout(5000) });
      } catch {
        return json(res, 502, { error: { code: 'siren_unreachable', message: 'Siren 通话服务不可达（文字聊天不受影响）' } });
      }
      if (!sirenRes.ok) {
        const body = await sirenRes.text().catch(() => '');
        return json(res, 502, { error: { code: 'siren_call_failed', message: `Siren 建呼失败（${sirenRes.status}）：${body.slice(0, 120)}` } });
      }
      const created = await sirenRes.json() as { call_id?: string; ws_url?: string; token?: string; expires_at?: string };
      if (typeof created.call_id !== 'string' || typeof created.ws_url !== 'string' || typeof created.token !== 'string') {
        return json(res, 502, { error: { code: 'siren_contract_invalid', message: 'Siren 建呼回执合同不符' } });
      }
      d.db.prepare("INSERT OR REPLACE INTO voice_calls(call_id,conversation_id,state,started_at) VALUES (?,?,'active',?)")
        .run(created.call_id, rawBody.conversation_id, new Date().toISOString());
      return json(res, 200, { call_id: created.call_id, ws_url: created.ws_url, token: created.token, ...(typeof created.expires_at === 'string' ? { expires_at: created.expires_at } : {}), memory_only: true });
    }
    const estCallEnd = /^DELETE \/api\/v1\/calls\/([^/]+)$/.exec(route);
    if (estCallEnd) {
      const callId = decodeURIComponent(estCallEnd[1]!);
      const row = d.db.prepare('SELECT state FROM voice_calls WHERE call_id=?').get(callId) as { state: string } | undefined;
      if (!row) return json(res, 404, { error: { code: 'not_found', message: '通话不存在' } });
      if (row.state === 'active') d.db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id=?").run(new Date().toISOString(), callId);
      return json(res, 200, { call_id: callId, state: 'ended' });
    }

    // —— 协议①（2026-10-24）：来电邀请前端面（owner）——est 代理 Siren（内部凭据不进前端）。
    //    来电横幅/未接卡片的数据源；接听→前端再走既有 /api/v1/calls 建通话；拒接直接落终态。
    if (route === 'GET /api/v1/calls/invites') {
      if (!d.sirenCall) return json(res, 503, { error: { code: 'siren_unconfigured', message: 'Siren 通话服务未配置' } });
      try {
        const list = await d.sirenCall.listInvites('primary');
        return json(res, 200, list ?? { active: null, recent: [] });
      } catch (err) {
        return json(res, 502, { error: { code: 'siren_invite_query_failed', message: String((err as Error).message ?? err).slice(0, 120) } });
      }
    }
    const inviteAction = /^POST \/api\/v1\/calls\/invites\/([^/]+)\/(accept|decline)$/.exec(route);
    if (inviteAction) {
      if (!d.sirenCall) return json(res, 503, { error: { code: 'siren_unconfigured', message: 'Siren 通话服务未配置' } });
      try {
        const out = await d.sirenCall.transitionInvite(decodeURIComponent(inviteAction[1]!), inviteAction[2] === 'accept' ? 'accept' : 'decline');
        // 拒接留言调度①（2026-10-24）：她拒接 → char反应轮（他说一两句落本会话；
        // 程序事实注入，不伪造她的话；幂等——重复拒接/重试不重建）
        if (inviteAction[2] === 'decline' && (out?.['state'] as string | undefined) === 'declined') {
          try {
            const hm = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            d.supervisor.submitProgramFactTurn('primary', 'invite_declined',
              `她于 ${hm} 拒接了你发起的来电（这是她自己的选择，不是故障）。`,
              `invite:${inviteAction[1]}:declined`);
          } catch { /* 反应轮失败不拖垮拒接响应（如实降级：他不说这句） */ }
        }
        return json(res, 200, out ?? {});
      } catch (err) {
        return json(res, 502, { error: { code: 'siren_invite_transition_failed', message: String((err as Error).message ?? err).slice(0, 120) } });
      }
    }

    // —— EXEC_V1 §05.9：token 预估（语义只读：无幂等账本/If-Match；不写 message/turn/rotate）——
    if (route === 'POST /api/v1/token-estimates') {
      const rawBody = await readJson(req, d, d.config.token_estimates.max_body_bytes);
      const body = rawBody as { conversation_id?: unknown; client_draft_revision?: unknown; content?: unknown; attachments?: unknown; include_request_estimate?: unknown };
      if (typeof body.conversation_id !== 'string' || !body.conversation_id) return json(res, 400, { error: { code: 'bad_conversation', message: 'conversation_id 必填' } });
      if (typeof body.content !== 'string') return json(res, 400, { error: { code: 'bad_content', message: 'content 必须是字符串' } });
      const draftRevision = typeof body.client_draft_revision === 'number' ? body.client_draft_revision : typeof body.client_draft_revision === 'string' ? body.client_draft_revision : null;
      if (draftRevision === null) return json(res, 400, { error: { code: 'bad_draft_revision', message: 'client_draft_revision 必填（防慢响应覆盖新草稿）' } });
      // 附件元数据（§9：媒体预览只读取 est 已有资产元数据）——asset_id 由服务端查库取真实
      // mime/byte_size；kind 按资产实际类型推导，不信客户端自报（图片规则未核→未知，不猜）
      const attachments: AttachmentEstimateMeta[] = [];
      if (Array.isArray(body.attachments)) {
        for (const a of body.attachments as Array<Record<string, unknown>>) {
          if (typeof a?.asset_id === 'string' && a.asset_id) {
            if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
            try {
              const asset = d.media.getAsset(a.asset_id);
              const kind = asset.mime_type.startsWith('image/') && asset.ingest_purpose === 'chat_sticker' ? 'image'
                : asset.mime_type.startsWith('image/') ? 'image'
                  : asset.mime_type.startsWith('audio/') ? 'audio'
                    : asset.mime_type.startsWith('video/') ? 'video'
                      : 'code_artifact';
              attachments.push({ kind, fingerprint: asset.content_sha256, bytes: asset.byte_size, known_tokens: null });
            } catch (err) {
              if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
              throw err;
            }
            continue;
          }
          const kind = a?.kind;
          if (kind !== 'image' && kind !== 'audio' && kind !== 'video' && kind !== 'code_artifact') return json(res, 400, { error: { code: 'bad_attachment', message: 'attachments[].kind 非法' } });
          if (typeof a.fingerprint !== 'string' || !a.fingerprint) return json(res, 400, { error: { code: 'bad_attachment', message: 'attachments[].fingerprint 必填' } });
          const known = typeof a.known_tokens === 'number' && Number.isFinite(a.known_tokens) && a.known_tokens >= 0 ? a.known_tokens : null;
          attachments.push({ kind, fingerprint: a.fingerprint, bytes: typeof a.bytes === 'number' ? a.bytes : null, known_tokens: known });
        }
      }
      const ec = estimateContextFor(d);
      // 请求投影（§8.3/§9）：当前活动窗最近一次真实发送 payload 的序列化粗估（含系统/工具/历史），
      // 加本条草稿；无法无副作用重建（无活动窗=等人工选集 / 窗内尚无已发送投影）→ request 不可用，
      // message 照给——绝不只把 messages 正文相加冒充完整请求，也不替用户零选。
      let requestProjection: Parameters<typeof estimateTokens>[0]['requestProjection'] = null;
      if (body.include_request_estimate === true) {
        const win = d.windows.activeWindow(body.conversation_id);
        if (!win) {
          requestProjection = { tokens: null, unavailable_reason: 'pending_selection' };
        } else {
          const winRev = (d.db.prepare('SELECT revision FROM windows WHERE id = ?').get(win.id) as { revision: number } | undefined)?.revision ?? null;
          const row = d.db.prepare('SELECT payload_json, id FROM provider_requests WHERE window_id = ? AND sent_at IS NOT NULL AND payload_json IS NOT NULL ORDER BY sent_at DESC LIMIT 1').get(win.id) as { payload_json: string; id: string } | undefined;
          if (!row) {
            requestProjection = { tokens: null, unavailable_reason: 'no_sent_projection', window_id: win.id, window_revision: winRev };
          } else {
            const payloadTokens = Math.ceil([...row.payload_json].length / Math.max(ec.charsPerToken, 0.1));
            const draft = estimateTokens({ model: ec.model, charsPerToken: ec.charsPerToken, content: body.content, attachments, outputCapTokens: ec.outputCap });
            requestProjection = {
              tokens: draft.message_total_tokens === null ? null : payloadTokens + draft.message_total_tokens, // 附件未知 → 请求预估未知，不猜
              unavailable_reason: draft.message_total_tokens === null ? 'unavailable' : null,
              window_id: win.id, window_revision: winRev,
              projection_version: 'last_sent_payload_v1', payload_projection_hash: sha256Hex(row.id),
            };
          }
        }
      }
      const estimate = estimateTokens({ model: ec.model, charsPerToken: ec.charsPerToken, content: body.content, attachments, outputCapTokens: ec.outputCap, requestProjection });
      const modelSnapshotId = sha256Hex(`${ec.model ?? 'null'}|${ec.charsPerToken}|${ESTIMATOR_REVISION}`);
      const attachmentFingerprint = attachments.length === 0 ? null : sha256Hex(attachments.map((a) => `${a.kind}:${a.fingerprint}:${a.known_tokens ?? 'u'}`).join('|'));
      return json(res, 200, {
        client_draft_revision: draftRevision,
        model_snapshot_id: modelSnapshotId,
        window_id: estimate.source_window_id,
        window_revision: estimate.source_window_revision,
        attachment_fingerprint: attachmentFingerprint,
        chars_per_token: ec.charsPerToken, // 客户端本地粗估复用同一系数（§7.3 分段气泡显示）
        projection_version: estimate.projection_version,
        estimate,
        stale_after_state_change: true, // 前端只应用同时匹配 draft_revision/model_snapshot/附件指纹的响应
      });
    }

    // —— ESTOMAGO_CHAT_EXEC_V1 §05（WP1）：系统异常红点 ——
    // 快照/summary 只读；read 单调幂等。告警产生与恢复是内部服务接口，
    // 不向浏览器开放任意 code 创建或自填"已修复"（§5 末段）。
    if (route === 'GET /api/v1/system-alerts/summary') {
      if (!d.alerts) return json(res, 200, { unread_anomaly_count: 0, open_count: 0, highest_open_severity: null, snapshot_sequence: d.events.maxSequence(), service: 'not_configured' });
      return json(res, 200, d.alerts.summary(d.alerts.uiActorId));
    }
    if (route === 'GET /api/v1/system-alerts') {
      if (!d.alerts) return json(res, 200, { items: [], next_cursor: null, has_more: false, unread_anomaly_count: 0, open_count: 0, snapshot_sequence: d.events.maxSequence(), service: 'not_configured' });
      const lifecycle = url.searchParams.get('lifecycle');
      return json(res, 200, d.alerts.list({
        actorId: d.alerts.uiActorId,
        lifecycle: lifecycle === 'open' || lifecycle === 'resolved' ? lifecycle : 'all',
        unreadOnly: url.searchParams.get('unread_only') === 'true',
        limit: Number(url.searchParams.get('limit')) || undefined,
        cursor: url.searchParams.get('cursor'),
      }));
    }
    if (route === 'POST /api/v1/system-alerts/read') {
      if (!d.alerts) return json(res, 200, { accepted: 0, service: 'not_configured' });
      const body = (await readJson(req, d)) as { items?: Array<{ alert_id?: unknown; seen_event_sequence?: unknown }> };
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length > POLICY_CONSTANTS.system_alerts.read_batch_max) {
        return json(res, 400, { error: { code: 'read_batch_too_large', message: `单次最多 ${POLICY_CONSTANTS.system_alerts.read_batch_max} 条` } });
      }
      const accepted = d.alerts.markRead(d.alerts.uiActorId, items
        .map((it) => ({ alert_id: typeof it?.alert_id === 'string' ? it.alert_id : '', seen_event_sequence: Number(it?.seen_event_sequence) }))
        .filter((it) => it.alert_id !== '' && Number.isSafeInteger(it.seen_event_sequence) && it.seen_event_sequence >= 0));
      return json(res, 200, accepted);
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
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new MediaError('ASSET_TOO_LARGE', 413, `超过上限 ${maxBytes} 字节`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}


/** WP3（2026-10-08）：选集条目解析——只取 message_id/revision/content_hash
 *  三个受控字段（前端正文不进模型，服务端从真实修订读取）；坏条目剔除。 */
function parseSelectionItems(raw: unknown): Array<{ message_id: string; revision?: number; content_hash?: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ message_id: string; revision?: number; content_hash?: string }> = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const rec = x as Record<string, unknown>;
    if (typeof rec.message_id !== 'string' || rec.message_id.length === 0) continue;
    const item: { message_id: string; revision?: number; content_hash?: string } = { message_id: rec.message_id };
    if (typeof rec.revision === 'number' && Number.isInteger(rec.revision)) item.revision = rec.revision;
    if (typeof rec.content_hash === 'string') item.content_hash = rec.content_hash;
    out.push(item);
  }
  return out;
}


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
import { json, readJson, ClientBodyError, estimateContextFor } from './http-leaf.ts';
export { handleVoiceCallLifecycle };
void handleVoiceCallLifecycle;

