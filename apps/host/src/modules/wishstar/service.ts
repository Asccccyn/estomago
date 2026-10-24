// modules/wishstar/service.ts（P04.6）：许愿星现行工具组（HTTP 转发面，13 项）。
// 原 HostToolExecutor.wishstarTool 逐字迁移：Bearer=jiaming 身份、幂等键 turn+request 派生、
// 写操作回执瘦身、错误如实上抛。不得因同前缀给任意 wishstar_* 放行——注册表逐项显式登记。
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';

export class WishstarService {
  private readonly wishstar: { forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<{ status: number; body: Record<string, unknown> }> } | null;

  constructor(deps: { wishstar: { forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<{ status: number; body: Record<string, unknown> }> } | null }) {
    this.wishstar = deps.wishstar;
  }

  async wishstarTool(name: string, args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.wishstar) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '许愿星未接入（能力缺口，如实拒绝）' } };
    const idem = typeof args.idempotency_key === 'string' ? args.idempotency_key : '';
    const opKey = `ws:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${idem || 'ro'}`;
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
    };
    const call = calls[name];
    if (!call) return { ok: false, output: { error_code: 'TOOL_NOT_IN_ALLOWLIST' } };
    const r = await this.wishstar.forward(call.method, call.path, call.body, call.write ? opKey : undefined);
    if (r.status === 0 || r.status === 503) return { ok: false, output: { error_code: 'WISHSTAR_UNAVAILABLE', detail: String((r.body as { detail?: string }).detail ?? '许愿星服务不可用') } };
    if (r.status >= 400) return { ok: false, output: { error_code: `WISHSTAR_${r.status}`, detail: JSON.stringify(r.body).slice(0, 300) } };
    const out = call.write
      ? Object.fromEntries(Object.entries(r.body).filter(([k]) => ['id', 'star_id', 'session_id', 'status', 'state', 'request_id', 'offer_id'].includes(k)))
      : r.body;
    return { ok: true, output: out };
  }

}
