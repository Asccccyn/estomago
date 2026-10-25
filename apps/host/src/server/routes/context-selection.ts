// server/routes/context-selection.ts（P07.2 第四批b）：人工历史选集/会话运行态/路由决议/时间与记录组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序/响应与错误码逐字保持。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { PRIMARY_CONVERSATION } from '../../messages/constants.ts';
import { buildTimeContext } from '../../time/context.ts';
import { buildRecordSnapshot, listRecordEvents } from '../records.ts';
import type { RequestDeps } from '../http.ts';

/** 人工历史选集条目解析（自 http.ts 逐字随迁——preview/confirm 共用）。 */
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

/** 上下文组：context-selection awaiting/preview/confirm、conversations runtime、route-decisions、time/context、context-records。 */
export async function handleContextSelectionRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string, url: URL): Promise<void> {
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
}
