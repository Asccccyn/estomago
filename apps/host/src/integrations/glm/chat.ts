// 包2 批C（BIND-04，2026-11-16）：来源绑定判断用的服务端 GLM 聊天客户端。
// 模式沿 imagegen adapter：baseUrl + apiKeyEnv（环境变量名引用，凭据不进配置/日志）
// + model + timeout；transport 可注入供离线验证。只做请求/解析——业务资格、写入与
// 版本由领域服务处理（04 §3 单向依赖）。凭据未配置=如实不可用，不静默换供应商。
export type GlmChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type GlmChatTransport = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<{ status: number; json: unknown } | { transportError: 'timeout' | 'network' }>;

export type GlmChatResult =
  | { ok: true; content: string }
  | { ok: false; retryable: boolean; reason: string };

const REFUSED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

export class GlmChatAdapter {
  private readonly baseUrl: string;
  private readonly apiKeyEnv: string | null;
  private readonly model: string;
  private readonly transport: GlmChatTransport;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl: string; apiKeyEnv: string | null; model: string; transport?: GlmChatTransport; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKeyEnv = opts.apiKeyEnv;
    this.model = opts.model;
    this.transport = opts.transport ?? defaultTransport(this.baseUrl, opts.apiKeyEnv);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  get configured(): boolean {
    const v = this.apiKeyEnv ? process.env[this.apiKeyEnv] : null;
    return typeof v === 'string' && v.length > 0;
  }

  /** 单轮补全（判断任务无多轮状态）。响应取 choices[0].message.content；错误脱敏有界。 */
  async chat(messages: GlmChatMessage[], opts: { temperature?: number; responseJson?: boolean } = {}): Promise<GlmChatResult> {
    if (!this.configured) return { ok: false, retryable: false, reason: 'GLM 凭据未配置（服务端环境）——任务如实未启用' };
    let res: Awaited<ReturnType<GlmChatTransport>>;
    try {
      res = await this.transport({
        model: this.model, messages,
        temperature: opts.temperature ?? 0,
        ...(opts.responseJson ? { response_format: { type: 'json_object' } } : {}),
      }, AbortSignal.timeout(this.timeoutMs));
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      if (cause && REFUSED_CODES.has(cause)) return { ok: false, retryable: true, reason: `连接未建立（${cause}）——请求未送达，可重试` };
      return { ok: false, retryable: false, reason: `请求失败（${String((err as Error).name ?? '').slice(0, 40)}）——结果未知不自动重发` };
    }
    if ('transportError' in res) {
      return res.transportError === 'timeout'
        ? { ok: false, retryable: false, reason: '请求超时——判断结果未知，不自动重发（避免重复计费）' }
        : { ok: false, retryable: true, reason: '网络中断前请求未送达，可重试' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, retryable: false, reason: `凭据被拒（${res.status}）` };
    if (res.status === 429) return { ok: false, retryable: true, reason: '限流；稍后重试' };
    if (res.status >= 500) return { ok: false, retryable: true, reason: `上游 ${res.status} 明确失败，可重试` };
    if (res.status < 200 || res.status >= 300) return { ok: false, retryable: false, reason: `HTTP ${res.status}` };
    const content = (res.json as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) return { ok: false, retryable: false, reason: '响应缺正文内容' };
    return { ok: true, content };
  }
}

function defaultTransport(baseUrl: string, apiKeyEnv: string | null): GlmChatTransport {
  return async (body, signal) => {
    const key = apiKeyEnv ? process.env[apiKeyEnv] : null;
    if (!key) return { status: 401, json: { error: { message: 'UNCONFIGURED' } } };
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* 非 JSON 错误体按状态码分类 */ }
    return { status: res.status, json };
  };
}
