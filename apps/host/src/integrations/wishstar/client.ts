// 许愿星（superposition）HTTP 客户端——薄转发（她 2026-10-17 批准接入）。
// 两类凭据（都只经环境变量名引用，值不进日志/Git）：
//  - readonly：宿主开窗查临近纪念日（仅 GET /api/special-dates/upcoming，服务端锁权限）
//  - jiaming：char工具面身份（Bearer → 许愿星按 token 反推 actor=jiaming，他的操作归他名下）
import type { Config } from '../../config/schema.ts';

export type WishstarResult = { status: number; body: Record<string, unknown> };

export class WishstarClient {
  private baseUrl: string;
  private readonlyEnv: string;
  private jiamingEnv: string;
  private deps: { fetch?: typeof fetch };

  constructor(config: Config['wishstar'], deps: { fetch?: typeof fetch } = {}) {
    this.baseUrl = config.base_url.replace(/\/$/, '');
    this.readonlyEnv = config.readonly_token_env;
    this.jiamingEnv = config.jiaming_token_env;
    this.deps = deps;
  }

  private token(env: string): string | null {
    const v = process.env[env];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  /** 宿主面：临近纪念日（只读凭据；失败抛错由调用方降级） */
  async upcoming(days: number, signal?: AbortSignal): Promise<{ items: Array<{ name: string; date: string; days_until: number }> }> {
    const token = this.token(this.readonlyEnv);
    if (!token) throw new Error('WISHSTAR_READONLY_TOKEN 未配置');
    const r = await (this.deps.fetch ?? globalThis.fetch.bind(globalThis))(
      `${this.baseUrl}/api/special-dates/upcoming?days=${encodeURIComponent(days)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal, cache: 'no-store' },
    );
    const body = await r.json().catch(() => ({})) as Record<string, unknown>;
    if (!r.ok) throw new Error(`WISHSTAR_${r.status}`);
    return body as { items: Array<{ name: string; date: string; days_until: number }> };
  }

  /** 模型面：以 jiaming 身份转发（幂等键由调用方派生；错误原样上抛状态码）。
   *  P7（四仓审计 20261106）：signal 贯穿 fetch 与响应体读取——取消只停止本地等待
   *  与读取，不撤回已发出的写；已发出但响应未读完=结果未知，由调用方沿幂等键接管。 */
  async forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal): Promise<WishstarResult> {
    const token = this.token(this.jiamingEnv);
    if (!token) return { status: 503, body: { error_code: 'WISHSTAR_NOT_CONFIGURED', detail: 'WISHSTAR_JIAMING_TOKEN 未配置（能力缺口，如实拒绝）' } };
    if (signal?.aborted) return { status: 0, body: { error_code: 'WISHSTAR_CANCELLED', detail: '本地取消：请求未发出' } };
    try {
      const r = await (this.deps.fetch ?? globalThis.fetch.bind(globalThis))(
        `${this.baseUrl}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          cache: 'no-store',
          ...(signal ? { signal } : {}),
        },
      );
      let data: Record<string, unknown> | null;
      try {
        data = await r.json() as Record<string, unknown> | null;
      } catch {
        // RT02（复审 20261106）：响应头已到但 body 读取中断/断流/不可解析——不是
        // 成功空对象。已发写（POST）＝结果未知（提交可能已发生），取消走同一未知
        // 出口，调用方沿幂等键核对；读（GET）＝本次读取不可用，按不可用重试处理。
        if (signal?.aborted || method === 'POST') {
          return { status: 0, body: { error_code: signal?.aborted ? 'WISHSTAR_CANCELLED_UNKNOWN' : 'WISHSTAR_BODY_UNREADABLE_UNKNOWN', detail: '响应体未读完：请求可能已发出、结果未知——同幂等键核对后再决定是否重试' } };
        }
        return { status: 0, body: { error_code: 'WISHSTAR_BODY_UNREADABLE', detail: '响应体不可读（读取中断/非 JSON）' } };
      }
      return { status: r.status, body: data ?? {} };
    } catch (err) {
      // 发出后取消/断开=结果未知（写可能已提交）——与不可达区分，调用方沿幂等键核对
      if (signal?.aborted) return { status: 0, body: { error_code: 'WISHSTAR_CANCELLED_UNKNOWN', detail: '本地取消：请求可能已发出，结果未知——同幂等键核对后再决定是否重试' } };
      void err;
      return { status: 0, body: { error_code: 'WISHSTAR_UNREACHABLE', detail: '许愿星服务不可达' } };
    }
  }
}
