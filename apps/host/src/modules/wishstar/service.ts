// modules/wishstar/service.ts（P04.6）：许愿星现行工具组（HTTP 转发面，13 项）。
// 以 jiaming 身份调用许愿星。写星使用显式业务键，仪式等动作按原请求身份派生。
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';
import { sha256Hex } from '../../util/id.ts';

export const WISHSTAR_READ_ACTIONS = {
  hidden:'wishstar_hidden_stars', dates:'wishstar_special_dates',
  offers:'wishstar_list_offers', notifications:'wishstar_notifications', requests:'wishstar_requests',
} as const;

const STAR_UNKNOWN_DETAIL = '写星可能已经提交。用相同参数和原 idempotency_key 重试以取得原星 ID。';

// Keep this comparison aligned with Superposition create_star's Python str.strip().
function normalizedStarText(value: unknown): string | null {
  return typeof value === 'string'
    ? value.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, '') || null
    : null;
}

export class WishstarService {
  private readonly wishstar: { forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> } | null;

  constructor(deps: { wishstar: { forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> } | null }) {
    this.wishstar = deps.wishstar;
  }

  async wishstarTool(name: string, args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.wishstar) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '许愿星未接入（能力缺口，如实拒绝）' } };
    const calls: Record<string, { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown>; write: boolean }> = {
      wishstar_write_star: { method: 'POST', path: '/api/stars', body: { content: args.content, visibility: args.visibility, ...(args.mood_type ? { mood_type: args.mood_type } : {}), ...(args.mood_text ? { mood_text: args.mood_text } : {}), ...(args.note ? { note: args.note } : {}) }, write: true },
      wishstar_hidden_stars: { method: 'GET', path: '/api/stars/hidden/mine', write: false },
      wishstar_special_dates: { method: 'GET', path: '/api/special-dates', write: false },
      wishstar_start_session: { method: 'POST', path: '/api/sessions', body: { special_date_id: args.special_date_id }, write: true },
      wishstar_confirm_session: { method: 'POST', path: `/api/sessions/${encodeURIComponent(String(args.session_id))}/confirm`, write: true },
      wishstar_take_star: { method: 'POST', path: `/api/sessions/${encodeURIComponent(String(args.session_id))}/take-next`, write: true },
      wishstar_finish_session: { method: 'POST', path: `/api/sessions/${encodeURIComponent(String(args.session_id))}/finish`, write: true },
      wishstar_request_star: { method: 'POST', path: '/api/requests', write: true },
      wishstar_respond_request: { method: 'POST', path: `/api/requests/${encodeURIComponent(String(args.request_id))}/respond`, body: { decision: args.decision, ...(args.star_id ? { star_id: args.star_id } : {}) }, write: true },
      wishstar_offer_star: { method: 'POST', path: '/api/offers', body: { star_id: args.star_id, ...(args.message ? { message: args.message } : {}) }, write: true },
      wishstar_list_offers: { method: 'GET', path: '/api/offers', write: false },
      wishstar_accept_offer: { method: 'POST', path: `/api/offers/${encodeURIComponent(String(args.offer_id))}/accept`, write: true },
      wishstar_notifications: { method: 'GET', path: '/api/notifications', write: false },
      wishstar_requests: { method: 'GET', path: '/api/requests', write: false },
    };
    const call = calls[name];
    if (!call) return { ok: false, output: { error_code: 'TOOL_NOT_IN_ALLOWLIST' } };
    // 写星的同键重试可能跨模型请求；HTTP 只发送有界 ASCII 摘要。
    const isStarCreate = name === 'wishstar_write_star';
    const opKey = isStarCreate
      ? `ws:star:v1:${sha256Hex(JSON.stringify(['jiaming', name, args.idempotency_key]))}`
      : `ws:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:ro`;
    const r = await this.wishstar.forward(call.method, call.path, call.body, call.write ? opKey : undefined, ctx.signal);
    if (call.write && (r.status === 0 || r.status >= 500) && r.body.error_code !== 'WISHSTAR_NOT_CONFIGURED' && r.body.error_code !== 'WISHSTAR_CANCELLED') {
      const detail = isStarCreate
        ? STAR_UNKNOWN_DETAIL
        : '结果未知，可能已经提交。先用相关读取核对，不要把本次当成未执行另发一次。';
      return { ok: false, output: { error_code: 'WISHSTAR_OUTCOME_UNKNOWN', detail } };
    }
    if (isStarCreate && r.status >= 200 && r.status < 300) {
      if (typeof r.body.id !== 'string' || !r.body.id || typeof r.body.content !== 'string' || typeof r.body.visibility !== 'string') {
        return { ok: false, output: { error_code: 'WISHSTAR_OUTCOME_UNKNOWN', detail: STAR_UNKNOWN_DETAIL } };
      }
      // The remote transaction caches the original create result. It can replay
      // that receipt even when the caller subsequently changes the parameters.
      if (r.body.visibility !== args.visibility
        || ['content', 'mood_type', 'mood_text', 'note'].some(field => (r.body[field] ?? null) !== normalizedStarText(args[field]))) {
        return { ok: false, output: { error_code: 'WISHSTAR_IDEMPOTENCY_CONFLICT', detail: '这个业务键已用于不同参数。要写一颗新星，请换新键。' } };
      }
    }
    if (['wishstar_take_star','wishstar_accept_offer'].includes(name) && r.status >= 200 && r.status < 300 && typeof r.body.content !== 'string') {
      return {ok:false,output:{error_code:'WISHSTAR_OUTCOME_UNKNOWN',detail:'操作可能已提交，但回包缺打开的星正文；先核对状态，不要再次执行打开操作。'}};
    }
    if (r.status === 0 || r.status === 503) return { ok: false, output: { error_code: 'WISHSTAR_UNAVAILABLE', detail: String((r.body as { detail?: string }).detail ?? '许愿星服务不可用') } };
    if (r.status >= 400) return { ok: false, output: { error_code: `WISHSTAR_${r.status}`, detail: JSON.stringify(r.body).slice(0, 300) } };
    return { ok: true, output: r.body };
  }

}
