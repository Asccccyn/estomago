// 联合施工 JOINT-VOICE-20261022（03/04）：oído 深听适配器。
// 单向 HTTP 叶子客户端——oído 永不回调 est；失败如实上抛状态码，不在发送
// 关键路径上做可达性探测（视觉门教训：目录查询失败曾整轮阻断）。
// 凭据沿用 credential_ref→env 间接引用（不落屏不落库）；audio_ref=est:<asset_id>。
export type OidoConfig = { base_url: string | null; credential_ref: string | null };

export type OidoOverview = {
  analysis_id: string; revision: number; state: 'ready' | 'partial';
  range_ms: [number, number];
  observations: Array<Record<string, unknown>>;
  limits?: string[];
  next_cursor?: string;
};
export type OidoTicket = { analysis_id: string; state: 'queued' | 'running' };
export type OidoPage = Record<string, unknown> & { analysis_id: string; revision: number; syllables: unknown[]; next_cursor?: string };

export class OidoAdapter {
  private readonly baseUrl: string;
  private readonly token: string | null;

  constructor(cfg: OidoConfig) {
    this.baseUrl = (cfg.base_url ?? 'http://127.0.0.1:8791').replace(/\/$/, '');
    this.token = cfg.credential_ref ? (process.env[cfg.credential_ref] ?? null) : null;
  }

  /** 配置就绪（base_url 已配）——仅表示"可尝试调用"，不是服务在线证明。 */
  get configured(): boolean {
    return this.token !== null;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    if (!this.token) throw new Error('OIDO_UNCONFIGURED: credential env not set');
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  /** 受信本地导入：推送原声字节（幂等，重放零成本）；transcript 有则一次带上。 */
  async ingestVoice(args: { assetId: string; bytes: Buffer; sha256: string; mime: string; transcript?: { text: string; source: string } | null; timeoutMs?: number }): Promise<{ audioId: string; deduplicated: boolean }> {
    const headers = this.headers({
      'Content-Type': 'application/octet-stream',
      'X-Oido-Audio-Ref': `est:${args.assetId}`,
      'X-Oido-Content-Sha256': args.sha256,
      'X-Oido-Mime': args.mime,
    });
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/audio:ingest`, {
        method: 'POST', headers, body: new Uint8Array(args.bytes), signal: AbortSignal.timeout(args.timeoutMs ?? 30_000),
      });
    } catch {
      throw new Error('OIDO_UNAVAILABLE');
    }
    if (res.status === 409) throw new Error('OIDO_CONTENT_CONFLICT');
    if (!res.ok) throw new Error(`OIDO_INGEST_${res.status}`);
    const body = await res.json() as { audio_id: string; deduplicated: boolean };
    if (args.transcript) {
      try {
        await fetch(`${this.baseUrl}/v1/audio/${encodeURIComponent(body.audio_id)}/transcript`, {
          method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(args.transcript),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // 转写补挂失败不阻断分析（oído 有 no_transcript 降级路径）；如实忽略
      }
    }
    return { audioId: body.audio_id, deduplicated: body.deduplicated };
  }

  /** 按需深听：有界同步等待内完成→概览；未完成→票据。 */
  async analyze(args: { assetId: string; rangeMs?: [number, number]; waitMs?: number; timeoutMs?: number }): Promise<OidoOverview | OidoTicket> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/analyses`, {
        method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          audio_ref: `est:${args.assetId}`,
          profile: 'prosody',
          ...(args.rangeMs ? { range_ms: args.rangeMs } : {}),
          wait_ms: args.waitMs ?? 6000,
        }),
        signal: AbortSignal.timeout(args.timeoutMs ?? (args.waitMs ?? 6000) + 8000),
      });
    } catch {
      throw new Error('OIDO_UNAVAILABLE');
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => null) as { code?: string } | null;
      throw new Error(`OIDO_ANALYZE_${res.status}${errBody?.code ? `:${errBody.code}` : ''}`);
    }
    const body = await res.json() as Record<string, unknown>;
    if (body['state'] === 'queued' || body['state'] === 'running') return body as unknown as OidoTicket;
    return body as unknown as OidoOverview;
  }

  async getOverview(analysisId: string): Promise<OidoOverview> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/analyses/${encodeURIComponent(analysisId)}`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Error('OIDO_UNAVAILABLE');
    }
    if (!res.ok) throw new Error(`OIDO_GET_${res.status}`);
    return await res.json() as OidoOverview;
  }

  async getProsodyPage(analysisId: string, cursor?: string): Promise<OidoPage> {
    let res: Response;
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    try {
      res = await fetch(`${this.baseUrl}/v1/analyses/${encodeURIComponent(analysisId)}/prosody${qs}`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Error('OIDO_UNAVAILABLE');
    }
    if (!res.ok) throw new Error(`OIDO_PAGE_${res.status}`);
    return await res.json() as OidoPage;
  }

  /** 能力探测（匿名面）：给后台/诊断用，不进发送关键路径。 */
  async capabilities(): Promise<{ ok: boolean; flags?: Record<string, boolean> }> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/capabilities`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return { ok: false };
      const body = await res.json() as { flags?: Record<string, boolean> };
      return { ok: true, flags: body.flags };
    } catch {
      return { ok: false };
    }
  }
}
