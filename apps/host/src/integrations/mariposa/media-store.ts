// M 媒体间上传/回源客户端（相册重构 P2，GLM_ALBUM_REFACTOR_EXECUTION 20261108）。
// 合同：M `media.upload.prepare`（capability）→ `PUT /api/media/stage/{token}`（字节端点）
// → `media.upload.finalize`（capability）；读取走 `GET /api/media/object/{content_hash}`。
// E 的本地媒体文件自此降级为可重建缓存：新字节经本客户端落正到 M，缓存缺失时从 M 回源。
// 本文件只搬运字节与回执，不实现相册/分类/留言业务（那是 content 域），也不做静默兜底——
// M 不可达时如实抛错，由调用方记录待完成状态。
import { sha256Hex } from '../../util/id.ts';

export type MediaStoreUploadResult = { content_hash: string; mime: string; deduplicated: boolean };

export class MariposaMediaStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MariposaMediaStoreError';
    this.code = code;
  }
}

export type MariposaMediaStoreOptions = {
  baseUrl: string;
  /** 环境变量名（credential_ref 模式）：值在请求头构造处读取，不进日志/DB。 */
  credentialEnv: string | null;
  timeoutMs?: number;
};

export class MariposaMediaStore {
  private readonly baseUrl: string;
  private readonly credentialEnv: string | null;
  private readonly timeoutMs: number;

  constructor(opts: MariposaMediaStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.credentialEnv = opts.credentialEnv;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private authHeader(): Record<string, string> {
    const v = this.credentialEnv ? process.env[this.credentialEnv] : null;
    return typeof v === 'string' && v.length > 0 ? { authorization: `Bearer ${v}` } : {};
  }

  /** capability 面（与 client.ts defaultTransport 同形：{arguments:{...}} 信封，成功取 data）。 */
  private async callCapability(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/capability/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeader() },
        body: JSON.stringify({ arguments: args }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MariposaMediaStoreError('MARMEDIA_UNAVAILABLE', `调用 ${name} 失败`);
    }
    const body = await res.json().catch(() => null) as { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } } | null;
    if (!res.ok || !body || body.ok !== true || !body.data || typeof body.data !== 'object') {
      const code = body?.error?.code ?? `HTTP_${res.status}`;
      throw new MariposaMediaStoreError(`MARMEDIA_${code}`, `${name} 被拒绝：${String(body?.error?.message ?? res.status)}`);
    }
    return body.data;
  }

  /** 三步落正：prepare → stage（字节）→ finalize。返回 M 权威 content_hash。 */
  async uploadBytes(bytes: Uint8Array, mime: string): Promise<MediaStoreUploadResult> {
    const prepare = await this.callCapability('media.upload.prepare', { mime, size: bytes.byteLength });
    const token = typeof prepare.upload_token === 'string' ? prepare.upload_token : null;
    const stageUrl = typeof prepare.stage_url === 'string' ? prepare.stage_url : null;
    if (!token || !stageUrl) throw new MariposaMediaStoreError('MARMEDIA_BAD_RESPONSE', 'prepare 缺 upload_token/stage_url');
    let stageRes: Response;
    try {
      stageRes = await fetch(`${this.baseUrl}${stageUrl}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), ...this.authHeader() },
        body: Buffer.from(bytes),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MariposaMediaStoreError('MARMEDIA_UNAVAILABLE', 'stage 字节上传失败');
    }
    if (!stageRes.ok) {
      const err = await stageRes.json().catch(() => null) as { error?: { code?: string } } | null;
      throw new MariposaMediaStoreError(`MARMEDIA_${err?.error?.code ?? `HTTP_${stageRes.status}`}`, `stage 被拒绝 ${stageRes.status}`);
    }
    const staged = await stageRes.json().catch(() => null) as { ok?: boolean; data?: { content_hash?: string } } | null;
    const localHash = sha256Hex(Buffer.from(bytes));
    if (staged?.data?.content_hash !== localHash) {
      throw new MariposaMediaStoreError('MARMEDIA_HASH_MISMATCH', 'stage 返回的 content_hash 与本地 sha256 不一致');
    }
    const fin = await this.callCapability('media.upload.finalize', { upload_token: token });
    const contentHash = typeof fin.content_hash === 'string' ? fin.content_hash : null;
    if (!contentHash || contentHash !== localHash) {
      throw new MariposaMediaStoreError('MARMEDIA_HASH_MISMATCH', 'finalize 返回的 content_hash 与本地 sha256 不一致');
    }
    return { content_hash: contentHash, mime: typeof fin.mime === 'string' ? fin.mime : mime, deduplicated: fin.deduplicated === true };
  }

  /** 从 M 回源字节（授权同 capability 面：binding bearer，owner 主体）。 */
  async fetchBytes(contentHash: string): Promise<{ bytes: Buffer; mime: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/media/object/${encodeURIComponent(contentHash)}`, {
        headers: this.authHeader(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MariposaMediaStoreError('MARMEDIA_UNAVAILABLE', '对象读取失败');
    }
    if (!res.ok) throw new MariposaMediaStoreError(`MARMEDIA_HTTP_${res.status}`, `对象读取 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256Hex(buf) !== contentHash) throw new MariposaMediaStoreError('MARMEDIA_HASH_MISMATCH', '回源字节 sha256 与 content_hash 不一致');
    return { bytes: buf, mime: res.headers.get('content-type') ?? 'application/octet-stream' };
  }
}
