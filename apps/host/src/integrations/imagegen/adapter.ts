// 相册重构 P3（GLM_ALBUM_REFACTOR_EXECUTION 20261108 R12/04 §4）：OpenAI 图片生成适配。
// 只做供应商请求/响应/状态翻译；不负责相册 UI、原文同步、检索排序与二次编排。
// Key 由服务端持有（env 名引用），不进 prompt/日志/工具参数。transport 注入供离线
// 固定响应验证；真实远端联调须 Key 与授权——未执行时状态如实 BLOCKED。
// 生成结果不确定（超时/断连）：返回 outcome='unknown'（结果待确认），调用方不得
// 无条件重发（多次计费风险），按 R12 停在待核实状态。
import { sniffMime } from '../../media/assets.ts';

export type ImageGenRequest = { prompt: string; model: string; n?: number; size?: string; output_format?: string; frame_count?: number; frame_duration_ms?: number };
export type ImageGenTransportResult =
  | { status: number; json: unknown; transportError?: undefined }
  | { transportError: 'timeout' | 'network_refused' | 'network_unknown' | 'body_truncated'; status?: number; json?: undefined };

export type ImageGenTransport = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<ImageGenTransportResult>;

export type ImageGenResult =
  | { outcome: 'ok'; bytes: Buffer; mime: string; generationId: string | null; revisedPrompt: string | null }
  | { outcome: 'unknown'; reason: string } // 请求已发出但结果未确认——禁止自动重发
  // 二轮返修 P1-2（2026-11-15）：生成已成功、供应商回了结果 URL，但字节取回失败——
  // 重放只重取 URL（fetchImageResultUrl），不得重新发起付费生成。
  | { outcome: 'url_pending'; url: string; reason: string }
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

  /** 二轮返修 P1-2（2026-11-15）：取回供应商结果 URL 的字节——同一次生成的恢复动作，
   *  不重新计费。https-only、有界（50MiB 安全上限）、魔数校验须为图片；失败如实返回
   *  原因（调用方落 url_pending，同键重放只重取本 URL）。 */
  async fetchImageResultUrl(url: string): Promise<{ ok: true; bytes: Buffer; mime: string } | { ok: false; reason: string }> {
    let u: URL;
    try { u = new URL(url); } catch { return { ok: false, reason: '结果 URL 非法' }; }
    // 公网结果 URL 强制 https；环回（本机供应商部署/隔离验证）允许 http
    const isLoopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback)) return { ok: false, reason: '结果 URL 非 https' };
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status < 200 || res.status >= 300) return { ok: false, reason: `结果 URL 返回 ${res.status}` };
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (!reader) return { ok: false, reason: '结果 URL 无正文流' };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 50 * 1024 * 1024) { await reader.cancel(); return { ok: false, reason: '结果字节超过 50MiB 上限' }; }
        chunks.push(Buffer.from(value));
      }
      const bytes = Buffer.concat(chunks);
      const sniffed = sniffMime(bytes);
      if (sniffed === null || !sniffed.startsWith('image/')) return { ok: false, reason: `取回字节不是图片（${sniffed ?? 'unknown'}）` };
      return { ok: true, bytes, mime: sniffed };
    } catch (err) {
      return { ok: false, reason: `结果 URL 取回失败（${String((err as Error).message).slice(0, 80)}）` };
    }
  }

  async generate(prompt: string, opts: { format?: string; size?: string; frameCount?: number; frameDurationMs?: number } = {}): Promise<ImageGenResult> {
    if (!this.configured) return { outcome: 'error', code: 'IMAGEGEN_UNCONFIGURED', detail: '未配置图片生成 Key（服务端设置）——能力如实不可用，不切换其他供应商' };
    if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 32000) {
      return { outcome: 'error', code: 'IMAGEGEN_PROMPT_INVALID', detail: 'prompt 必须是 1..32000 字符' };
    }
    // GIF（2026-11-09 她/OpenAI 官方文档确认）：flare/sunburst 经 output_format=gif
    // 直接生动图（官方 2–16 帧、frame_duration_ms；GIF 不支持分帧流式）。不带
    // output_format 时供应商默认静态图——生产实证：三次动图请求全落 PNG（根因）。
    // 响应侧不信任声明格式，仍按字节魔数 sniff。
    const format = ['png', 'jpeg', 'webp', 'gif'].includes(String(opts.format)) ? String(opts.format) : undefined;
    // GIF（复审 2026-11-09 二轮）：参数校验按官方合同——size 官方支持 auto 与
    // WxH 两形；frame_duration_ms 官方最低 20ms。不自行发明另一组限制。
    if (opts.size !== undefined && opts.size !== 'auto' && !/^\d{3,4}x\d{3,4}$/.test(String(opts.size))) {
      return { outcome: 'error', code: 'IMAGEGEN_PARAM_INVALID', detail: 'size 形如 1024x1024 或 auto' };
    }
    const frameCount = typeof opts.frameCount === 'number' ? Math.trunc(opts.frameCount) : undefined;
    if (frameCount !== undefined && (frameCount < 2 || frameCount > 16)) {
      return { outcome: 'error', code: 'IMAGEGEN_PARAM_INVALID', detail: 'frame_count 官方范围 2..16' };
    }
    const frameDurationMs = typeof opts.frameDurationMs === 'number' ? Math.trunc(opts.frameDurationMs) : undefined;
    if (frameDurationMs !== undefined && frameDurationMs < 20) {
      return { outcome: 'error', code: 'IMAGEGEN_PARAM_INVALID', detail: 'frame_duration_ms 官方最低 20 毫秒' };
    }
    // M05（包1 2026-11-15）：生产实证 11-12——8 帧@1024x1024 被拒，供应商把 GIF 帧拼成
    // sprite sheet 且"最长边 ≤3840"。只拦截可证明必拒的组合：枚举全部整格拼法取最长边
    // 最小值，仍超 3840 才拒（如 16@1024 必拒）。能放下某种网格的组合同样可能被拒
    // （供应商实际支持的拼法集合未知，8@1024 即例），失败原因照常透传供应商原始说明。
    if (format === 'gif' && frameCount !== undefined && typeof opts.size === 'string' && opts.size !== 'auto') {
      const sm = /^(\d{3,4})x(\d{3,4})$/.exec(opts.size);
      if (sm) {
        const w = Number(sm[1]), h = Number(sm[2]);
        let minLongest = Infinity;
        for (let cols = 1; cols <= frameCount; cols++) {
          const rows = Math.ceil(frameCount / cols);
          minLongest = Math.min(minLongest, Math.max(cols * w, rows * h));
        }
        if (minLongest > 3840) {
          return { outcome: 'error', code: 'IMAGEGEN_PARAM_INVALID', detail: `gif ${frameCount} 帧 @ ${w}x${h}：任何拼接布局最长边至少 ${minLongest}，超过供应商上限 3840——减少帧数或改用更小尺寸` };
        }
      }
    }
    let res: ImageGenTransportResult;
    try {
      res = await this.transport({
        model: this.model, prompt, n: 1,
        ...(format ? { output_format: format } : {}),
        ...(opts.size ? { size: String(opts.size) } : {}),
        ...(format === 'gif' && frameCount !== undefined ? { frame_count: frameCount } : {}),
        ...(format === 'gif' && frameDurationMs !== undefined ? { frame_duration_ms: frameDurationMs } : {}),
      }, AbortSignal.timeout(this.timeoutMs));
    } catch (err) {
      // 自定义 transport 抛错（未走 defaultTransport 的分类）：同一套网络分类语义
      const kind = classifyNetworkError(err);
      if (kind === 'timeout') return { outcome: 'unknown', reason: '请求超时——生成结果未确认，不自动重发（避免重复计费）' };
      if (kind === 'network_refused') return { outcome: 'error', code: 'IMAGEGEN_NETWORK', detail: '连接未建立（DNS/拒绝）——请求未送达，可安全重试' };
      if (kind === 'network_unknown') return { outcome: 'unknown', reason: '网络中断（不能证明请求未送达）——结果未确认，不自动重发（避免重复计费）' };
      return { outcome: 'error', code: 'IMAGEGEN_TRANSPORT', detail: String((err as Error).message).slice(0, 120) };
    }
    if (res.transportError === 'timeout') return { outcome: 'unknown', reason: '请求超时——生成结果未确认，不自动重发（避免重复计费）' };
    // P1-c（审计 2026-11-15）：已收到响应头（含 200）但正文读取/解析失败——生成可能已
    // 成功且计费，字节未落手；重发即第二次付费请求。按结果未确认归类，不自动重发。
    if (res.transportError === 'body_truncated') return { outcome: 'unknown', reason: `收到供应商 ${res.status ?? ''} 应答但正文传输中断——生成可能已成功，重发有重复计费风险，不自动重发` };
    // ALB-06②（审计 2026-11-08）：不能把一般网络异常当作"请求未送达"的证据——
    // 服务端完整收到请求后断连（ECONNRESET 等）在客户端与连接阶段故障不可区分，
    // 重发即第二次付费请求。仅 DNS 解析失败/连接拒绝（连接从未建立、请求必然
    // 未送达）可安全重试；其余网络异常一律结果待确认。
    if (res.transportError === 'network_refused') return { outcome: 'error', code: 'IMAGEGEN_NETWORK', detail: '连接未建立（DNS/拒绝）——请求未送达，可安全重试' };
    if (res.transportError === 'network_unknown') return { outcome: 'unknown', reason: '网络中断（不能证明请求未送达）——结果未确认，不自动重发（避免重复计费）' };
    const status = res.status as number;
    if (status === 401 || status === 403) return { outcome: 'error', code: 'IMAGEGEN_AUTH', detail: `凭据被拒（${res.status}）` };
    if (status === 429) return { outcome: 'error', code: 'IMAGEGEN_RATE_LIMITED', detail: extractError(res.json) ?? '供应商限流；稍后重试' };
    if (status === 400 || status === 404 || status === 422) {
      const detail = extractError(res.json) ?? String(res.status);
      return { outcome: 'error', code: 'IMAGEGEN_REQUEST_REJECTED', detail };
    }
    // M04（包1 2026-11-15）：收到完整 5xx 应答=供应商明确失败，不是"结果未确认"——
    // 未确认只留给响应丢失（超时/断连，请求可能已送达且计费）。生产实证 11-12 一次
    // 500 被归 unknown 后同键永久卡死、被迫换键重新付费。同键重试据此重新请求上游。
    if (status >= 500) {
      // 二轮返修 P2-3：正文完整收到的 5xx（含非 JSON 的空/文本正文）按明确失败处理；
      // body_truncated（读取中断）已在上方统一归未确认。
      return { outcome: 'error', code: 'IMAGEGEN_UPSTREAM_ERROR', detail: extractError(res.json) ?? `供应商 ${res.status} 明确失败` };
    }
    if (status < 200 || status >= 300) return { outcome: 'error', code: `IMAGEGEN_HTTP_${status}`, detail: extractError(res.json) ?? String(status) };
    const data = (res.json as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> | null })?.data;
    const item = Array.isArray(data) ? data[0] : undefined;
    const b64 = typeof item?.b64_json === 'string' ? item.b64_json : null;
    if (!b64) {
      // 二轮返修 P1-2（2026-11-15）：生成已成功但只有结果 URL——先就地取回字节（同一次
      // 生成，不重新计费）；取不回落 url_pending，同键重放只重取 URL。
      if (typeof item?.url === 'string' && item.url.length > 0) {
        const fetched = await this.fetchImageResultUrl(item.url);
        if (fetched.ok) return { outcome: 'ok', bytes: fetched.bytes, mime: fetched.mime, generationId: (res.json as { id?: unknown }).id != null ? String((res.json as { id: unknown }).id) : null, revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : null };
        return { outcome: 'url_pending', url: item.url, reason: fetched.reason };
      }
      return { outcome: 'error', code: 'IMAGEGEN_NO_BYTES', detail: '响应缺图片字节' };
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

/** 连接阶段错误码：请求必然未到达服务端（TCP/TLS 从未建立），可安全重试。 */
const REFUSED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function classifyNetworkError(err: unknown): 'timeout' | 'network_refused' | 'network_unknown' {
  const name = (err as Error).name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  // fetch 失败原因挂在 cause（Node undici）；聚合 DNS 错误在 cause.errors[]
  const cause = (err as { cause?: { code?: string; errors?: Array<{ code?: string }> } }).cause;
  const codes = [cause?.code, ...(cause?.errors ?? []).map((e) => e.code)];
  if (codes.some((c) => typeof c === 'string' && REFUSED_CODES.has(c))) return 'network_refused';
  return 'network_unknown';
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
      // 二轮返修 P2-3（2026-11-15）：只有**读取中断**（连接断/超时，正文不完整）才是
      // 传输断流；正文完整收到但不是 JSON（429 空正文、502 纯文本、2xx 非 JSON）按
      // 状态码分类——旧实现把一切 JSON.parse 失败当断流，吞掉了限流与 5xx 的重试语义。
      let text: string;
      try {
        text = await res.text();
      } catch {
        return { transportError: 'body_truncated', status: res.status };
      }
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* 完整正文、非 JSON——按状态分类（json=null） */ }
      return { status: res.status, json };
    } catch (err) {
      return { transportError: classifyNetworkError(err) };
    }
  };
}
