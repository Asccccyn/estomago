// 相册重构 P3（GLM_ALBUM_REFACTOR_EXECUTION 20261108 R12/04 §4）：OpenAI 图片生成适配。
// 只做供应商请求/响应/状态翻译；不负责相册 UI、原文同步、检索排序与二次编排。
// Key 由服务端持有（env 名引用），不进 prompt/日志/工具参数。transport 注入供离线
// 固定响应验证；真实远端联调须 Key 与授权——未执行时状态如实 BLOCKED。
// 生成结果不确定（超时/断连）：返回 outcome='unknown'（结果待确认），调用方不得
// 无条件重发（多次计费风险），按 R12 停在待核实状态。
import { sniffMime } from '../../media/assets.ts';

export type ImageGenRequest = { prompt: string; model: string; n?: number; size?: string };
export type ImageGenTransportResult =
  | { status: number; json: unknown; transportError?: undefined }
  | { transportError: 'timeout' | 'network'; status?: undefined; json?: undefined };

export type ImageGenTransport = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<ImageGenTransportResult>;

export type ImageGenResult =
  | { outcome: 'ok'; bytes: Buffer; mime: string; generationId: string | null; revisedPrompt: string | null }
  | { outcome: 'unknown'; reason: string } // 请求已发出但结果未确认——禁止自动重发
  | { outcome: 'error'; code: string; detail: string };

export class ImageGenAdapter {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKeyEnv: string | null;
  private readonly transport: ImageGenTransport;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl: string; apiKeyEnv: string | null; model: string; transport?: ImageGenTransport; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKeyEnv = opts.apiKeyEnv;
    this.model = opts.model;
    this.transport = opts.transport ?? defaultTransport(this.baseUrl, opts.apiKeyEnv);
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  get configured(): boolean {
    const v = this.apiKeyEnv ? process.env[this.apiKeyEnv] : null;
    return typeof v === 'string' && v.length > 0;
  }

  async generate(prompt: string): Promise<ImageGenResult> {
    if (!this.configured) return { outcome: 'error', code: 'IMAGEGEN_UNCONFIGURED', detail: '未配置图片生成 Key（服务端设置）——能力如实不可用，不切换其他供应商' };
    if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 32000) {
      return { outcome: 'error', code: 'IMAGEGEN_PROMPT_INVALID', detail: 'prompt 必须是 1..32000 字符' };
    }
    let res: ImageGenTransportResult;
    try {
      res = await this.transport({ model: this.model, prompt, n: 1 }, AbortSignal.timeout(this.timeoutMs));
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') return { outcome: 'unknown', reason: '请求超时——生成结果未确认，不自动重发（避免重复计费）' };
      return { outcome: 'error', code: 'IMAGEGEN_TRANSPORT', detail: String((err as Error).message).slice(0, 120) };
    }
    if (res.transportError === 'timeout') return { outcome: 'unknown', reason: '请求超时——生成结果未确认，不自动重发（避免重复计费）' };
    if (res.transportError === 'network') return { outcome: 'error', code: 'IMAGEGEN_NETWORK', detail: '网络故障（请求未送达，可安全重试）' };
    const status = res.status as number;
    if (status === 401 || status === 403) return { outcome: 'error', code: 'IMAGEGEN_AUTH', detail: `凭据被拒（${res.status}）` };
    if (status === 429) return { outcome: 'error', code: 'IMAGEGEN_RATE_LIMITED', detail: '供应商限流；稍后重试' };
    if (status === 400 || status === 404 || status === 422) {
      const detail = extractError(res.json) ?? String(res.status);
      return { outcome: 'error', code: 'IMAGEGEN_REQUEST_REJECTED', detail };
    }
    if (status >= 500) return { outcome: 'unknown', reason: `供应商 ${res.status}——结果未确认，不自动重发` };
    if (status < 200 || status >= 300) return { outcome: 'error', code: `IMAGEGEN_HTTP_${status}`, detail: extractError(res.json) ?? String(status) };
    const data = (res.json as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> | null })?.data;
    const item = Array.isArray(data) ? data[0] : undefined;
    const b64 = typeof item?.b64_json === 'string' ? item.b64_json : null;
    if (!b64) {
      // 只回 URL 未回字节：结果未落手——按需取回属供应商恢复能力，未配置时不猜
      return { outcome: 'error', code: 'IMAGEGEN_NO_BYTES', detail: item?.url ? '供应商只返回了临时 URL 未返回字节；不把外链当已保存' : '响应缺图片字节' };
    }
    const bytes = Buffer.from(b64, 'base64');
    const sniffed = sniffMime(bytes);
    if (sniffed === null || !sniffed.startsWith('image/')) return { outcome: 'error', code: 'IMAGEGEN_BAD_IMAGE', detail: `魔数校验失败（${sniffed ?? 'unknown'}）` };
    return { outcome: 'ok', bytes, mime: sniffed, generationId: (res.json as { id?: unknown }).id != null ? String((res.json as { id: unknown }).id) : null, revisedPrompt: typeof item?.revised_prompt === 'string' ? item.revised_prompt : null };
  }
}

function extractError(json: unknown): string | null {
  const e = (json as { error?: { message?: string } })?.error;
  return typeof e?.message === 'string' ? e.message.slice(0, 160) : null;
}

function defaultTransport(baseUrl: string, apiKeyEnv: string | null): ImageGenTransport {
  return async (body, signal) => {
    const key = apiKeyEnv ? process.env[apiKeyEnv] : null;
    if (!key) return { status: 401, json: { error: { message: 'UNCONFIGURED' } } };
    try {
      const res = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') return { transportError: 'timeout' };
      return { transportError: 'network' };
    }
  };
}
