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
import type { ManualSelectionService } from '../context/manual-selection.ts';
import type { SystemAlertService } from '../observability/system-alerts.ts';
import type { MediaService, IngestPurpose } from '../media/assets.ts';
import { MediaError } from '../media/assets.ts';
import { POLICY_CONSTANTS } from '../config/policy-constants.ts';
import { fetchOrModelMeta, effortsForModel } from '../runtime/runtime-settings.ts';
import { orModelIdIssue } from '../config/schema.ts';
import type { AuthService } from '../auth/tokens.ts';
import { buildReadyReport } from '../observability/health.ts';
import { buildTimeContext } from '../time/context.ts';
import { buildRecordSnapshot, listRecordEvents } from './records.ts';
import { genId } from '../util/id.ts';
import type { SubmitMessageRequest } from '../../../../packages/contracts/src/api.ts';
import { estimateTokens, snapshotFor, ESTIMATOR_REVISION, type AttachmentEstimateMeta } from '../usage/estimator.ts';
import { sha256Hex } from '../util/id.ts';
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
  selections?: ManualSelectionService; // WP3（2026-10-08）：人工历史选集
  settings?: import('../runtime/runtime-settings.ts').RuntimeSettingsService; // 2026-10-08：换模型/推理等级
  alerts?: SystemAlertService; // EXEC_V1 WP1：系统异常红点（未装配时端点如实降级）
  media?: MediaService; // EXEC_V1 WP3：媒体服务（未装配时资产端点如实降级）
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

/** EXEC_V1 §05.8：预估上下文（模型/系数/输出上限按当前驱动与生效 override 取值） */
function estimateContextFor(d: RequestDeps): { model: string | null; charsPerToken: number; outputCap: number | null } {
  const driver = d.runnerSelection.status === 'ok' ? d.runnerSelection.runner.kind : null;
  if (driver === 'deepseek') return { model: d.config.deepseek.model, charsPerToken: d.config.deepseek.estimate_chars_per_token, outputCap: d.config.deepseek.max_output_tokens };
  if (driver === 'openrouter') {
    const eff = (d as { settings?: { effectiveOrModel: (m: string | null) => string | null } | null }).settings?.effectiveOrModel(d.config.openrouter.model) ?? d.config.openrouter.model;
    return { model: eff, charsPerToken: d.config.openrouter.estimate_chars_per_token, outputCap: d.config.openrouter.max_output_tokens };
  }
  if (driver === 'mock') return { model: 'mock', charsPerToken: 2.5, outputCap: 1024 };
  return { model: d.config.runtime.model, charsPerToken: 2.5, outputCap: null };
}

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
      const ready = entries.length > 0 && entries.every(([, c]) => c.status === 'ok');
      // WP-04（JFA-E07）：ready=false → 503（监控按状态码分辨）；
      // /health/live 保持 200（进程活着）
      return json(res, ready ? 200 : 503, {
        ready,
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
      const beforeRaw = url.searchParams.get('before');
      const before = beforeRaw !== null ? Number(beforeRaw) || 0 : undefined;
      const latest = new URL(req.url ?? '/', 'http://local').searchParams.get('order') === 'latest';
      return json(res, 200, { messages: d.messages.listMessages({ conversationId, afterSequence: after, beforeSequence: before, limit, latest }) });
    }

    // F-J-08（联合审计 2026-10-06）：用户消息编辑修订——服务端能力（editUserMessage：
    // 修订+supersedes+outbox 同事务）此前无 HTTP 入口，正常聊天内编辑不可达
    const putMsg = /^PUT \/api\/v1\/conversations\/([^/]+)\/messages\/([^/]+)$/.exec(route);
    if (putMsg) {
      const conversationId = decodeURIComponent(putMsg[1]!);
      const messageId = decodeURIComponent(putMsg[2]!);
      const body = (await readJson(req, d)) as Partial<{ content: string }>;
      if (typeof body.content !== 'string') return json(res, 400, { error: { code: 'bad_content', message: 'content 必须是字符串（多行正文整体提交）' } });
      const existing = d.messages.getMessage(messageId);
      if (!existing || existing.conversation_id !== conversationId) return json(res, 404, { error: { code: 'not_found', message: '消息不存在或不属于该房间' } });
      // EXEC_V1 §03.5.2（07 §5）：编辑加并发前置条件——缺 If-Match 返回 428 提示刷新（不自动套最新覆盖）
      const ifMatch = String(req.headers['if-match'] ?? '').replace(/"/g, '');
      if (!ifMatch || !/^\d+$/.test(ifMatch)) return json(res, 428, { error: { code: 'precondition_required', message: '编辑必须带 If-Match: "<revision>"（页面已更新，请刷新后重新编辑）' } });
      if (Number(ifMatch) !== existing.current_revision) return json(res, 409, { error: { code: 'revision_conflict', message: `修订不匹配：当前 ${existing.current_revision}，请求基于 ${ifMatch}` } });
      try {
        // EXEC_V1 §05.7.2：编辑=新 revision+新发送前快照（旧修订旧快照不动）
        const ec = estimateContextFor(d);
        const snapJson = JSON.stringify(snapshotFor({ model: ec.model, charsPerToken: ec.charsPerToken, content: body.content, attachments: [], outputCapTokens: ec.outputCap }, new Date().toISOString()));
        const message = d.messages.editUserMessage(messageId, body.content, snapJson);
        // R16（复审 2026-10-07）：编辑有自己的接线——发布修订事件（SSE 可见，
        // 客户端按 ID/修订吸收）并触发现有归档（编辑已在同事务写 outbox；
        // 归档失败不撤销本地编辑，drain 自带重试/死信路径）
        d.events.publish('message.edited', { conversationId, entityRef: messageId, entityRevision: message.current_revision, scope: 'private', payload: { message } });
        d.archiveSync?.drainOnce().catch(() => { /* 归档失败走 drain 重试/死信；编辑不回滚 */ });
        return json(res, 200, { message, revision_of: messageId });
      } catch (err) {
        const msg = String((err as Error).message ?? '');
        if (msg.includes('仅空白')) return json(res, 422, { error: { code: 'blank_content', message: msg } });
        if (msg.includes('只有用户消息可编辑')) return json(res, 403, { error: { code: 'not_editable', message: msg } });
        if (msg.includes('message not found')) return json(res, 404, { error: { code: 'not_found', message: '消息不存在' } });
        throw err;
      }
    }

    const postMsgs = /^POST \/api\/v1\/conversations\/([^/]+)\/messages$/.exec(route);
    if (postMsgs) {
      const conversationId = decodeURIComponent(postMsgs[1]!);
      const idempotencyKey = String(req.headers['idempotency-key'] ?? '');
      const body = (await readJson(req, d)) as Partial<SubmitMessageRequest>;
      const clientMessageId = body.client_message_id ?? idempotencyKey;
      if (!clientMessageId) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 client_message_id / Idempotency-Key' } });
      if (typeof body.content !== 'string') return json(res, 400, { error: { code: 'bad_content', message: 'content 必须是字符串（多行正文整体提交，不拆分）' } });
      // EXEC_V1 §03.5.2：附件先全量校验（存在/available/格式匹配 presentation），全过才进消息事务；
      // 不接受 URL/磁盘路径/Base64——必须先经 /api/v1/assets 建立资产
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      const parsedAttachments: Array<{ asset_id: string; presentation: 'image' | 'sticker' | 'voice'; caption?: string | null }> = [];
      for (const a of attachments as Array<Record<string, unknown>>) {
        if (typeof a?.asset_id !== 'string' || !a.asset_id) return json(res, 400, { error: { code: 'bad_attachment', message: 'attachments[].asset_id 必填（先经资产创建/导入）' } });
        if (a.presentation !== 'image' && a.presentation !== 'sticker' && a.presentation !== 'voice') return json(res, 400, { error: { code: 'bad_attachment', message: 'attachments[].presentation 必须是 image|sticker|voice' } });
        parsedAttachments.push({ asset_id: a.asset_id, presentation: a.presentation, caption: typeof a.caption === 'string' ? a.caption : null });
      }
      if (d.media && parsedAttachments.length > 0) {
        try { d.media.validateForSend(parsedAttachments); }
        catch (err) {
          if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
          throw err;
        }
      }
      // D3（她批 2026-10-06）：首版单批准房间——凭空建房防护（房间必须
      // 已存在；归档 grant 也按 primary 钉死，第二房间同步本就会拒）
      const exists = d.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId);
      if (!exists) return json(res, 404, { error: { code: 'conversation_not_found', message: '房间不存在（首版仅批准房间）' } });
      let submitted;
      try {
        // EXEC_V1 §05.7.2：随 revision 保存发送前估计快照（估计刷新不影响 content_hash/修订号）
        const ec = estimateContextFor(d);
        const snapJson = JSON.stringify(snapshotFor({ model: ec.model, charsPerToken: ec.charsPerToken, content: body.content, attachments: [], outputCapTokens: ec.outputCap }, new Date().toISOString()));
        submitted = d.messages.submitUserMessageWithTurn({ conversationId, content: body.content, clientMessageId, occurredAt: body.occurred_at ?? null, attachments: parsedAttachments, tokenEstimateJson: snapJson });
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
      // WP3（H07）：无已确认选集 → 409 context_selection_required（awaiting
      // 已持久化；输入已保存，确认后自动继续——rotate 不再是绕过选集的旁路）
      const result = await d.supervisor.manualRotate(win.conversation_id);
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
        efforts = effortsForModel(meta);
      }
      return json(res, 200, {
        driver: d.runnerSelection.status === 'ok' ? d.runnerSelection.runner.kind : 'unknown',
        or_model: { effective: effModel, override: d.settings?.orModel() ?? null, config_default: cfg.model },
        reasoning_effort: { effective: effEffort, override: d.settings?.reasoningEffort() ?? null, config_default: cfg.reasoning },
        model_options: cfg.model_options ?? [],
        effort_options: efforts ?? ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
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
      // 不可达时放行，真请求若被 OR 拒绝会如实失败——不冒称已验证
      const candidateModel = (nextModel !== undefined ? nextModel : d.settings.orModel())
        ?? d.config.openrouter.model;
      const defEffort = (d.config.openrouter.reasoning as { effort?: unknown } | null | undefined)?.effort;
      const defEffortStr = typeof defEffort === 'string' && defEffort !== 'default' ? defEffort : null;
      const candidateEffort = (nextEffort !== undefined ? nextEffort : d.settings.reasoningEffort()) ?? defEffortStr;
      if (candidateEffort !== null && candidateModel) {
        const driver = d.runnerSelection.status === 'ok' ? d.runnerSelection.runner.kind : null;
        if (driver === 'openrouter') {
          const meta = await fetchOrModelMeta(d.config.openrouter.base_url, candidateModel);
          const allowed = effortsForModel(meta);
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
          res.writeHead(206, { 'Content-Type': mime, 'Content-Length': String(slice.length), 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' });
          res.end(slice);
          return;
        }
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' });
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

async function readJson(req: IncomingMessage, d: RequestDeps, maxBytes = 5 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new ClientBodyError(413, 'payload_too_large', `请求体超过上限`);
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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
