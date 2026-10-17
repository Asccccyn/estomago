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

  /** 模型面：以 jiaming 身份转发（幂等键由调用方派生；错误原样上抛状态码） */
  async forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<WishstarResult> {
    const token = this.token(this.jiamingEnv);
    if (!token) return { status: 503, body: { error_code: 'WISHSTAR_NOT_CONFIGURED', detail: 'WISHSTAR_JIAMING_TOKEN 未配置（能力缺口，如实拒绝）' } };
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
        },
      );
      const data = await r.json().catch(() => ({})) as Record<string, unknown>;
      return { status: r.status, body: data };
    } catch {
      return { status: 0, body: { error_code: 'WISHSTAR_UNREACHABLE', detail: '许愿星服务不可达' } };
    }
  }
}
