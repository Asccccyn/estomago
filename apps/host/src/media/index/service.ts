// JOINT-VOICE-20261022（07）P4：est 媒体语义索引服务（图片检索闭环）。
// worker 只编码；本服务拥有业务索引：namespace 指纹校验（不混库）、查询时权限门
// （活资产+会话绑定 join——删除/撤权立即阻断，索引行只是候选源）、top_k 限额、
// no_match 如实返回。向量 float32 小端 BLOB 入库（v34）。
import type { Db } from '../../db/connection.ts';
import type { MediaService } from '../assets.ts';

export type EmbedWorkerConfig = { base_url: string | null };
export type MediaCandidates = {
  state: 'candidates' | 'no_match';
  items: Array<{ asset_ref: string; kind: 'image'; range_ms?: [number, number] }>;
  next_cursor?: string;
};

const DIMS = 768;
const DEFAULT_TOP_K = 3;
const MAX_TOP_K = 10;
const MIN_SCORE = 0.0; // fake/真实后端统一：非相似（≤0 相似度）不入候选

export class MediaEmbedWorkerClient {
  readonly baseUrl: string;
  private fingerprintCache: { fp: string; at: number } | null = null;

  constructor(cfg: EmbedWorkerConfig) {
    this.baseUrl = (cfg.base_url ?? 'http://127.0.0.1:8792').replace(/\/$/, '');
  }

  async health(timeoutMs = 2500): Promise<{ ok: boolean; backend?: string; fingerprint?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false };
      return await res.json() as { ok: boolean; backend: string; fingerprint: string };
    } catch {
      return { ok: false };
    }
  }

  async embed(items: Array<{ id: string; modality: 'text' | 'image'; bytes: Buffer }>): Promise<{ fingerprint: string; vectors: Map<string, Float32Array> }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map((i) => ({ id: i.id, modality: i.modality, data_b64: i.bytes.toString('base64') })) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new Error('MEDIA_WORKER_UNAVAILABLE');
    }
    if (!res.ok) throw new Error(`MEDIA_WORKER_${res.status}`);
    const body = await res.json() as { fingerprint: string; vectors: Array<{ id: string; vector_b64: string; dims: number }> };
    if (body.fingerprint === undefined) throw new Error('MEDIA_WORKER_BAD_RESPONSE');
    const out = new Map<string, Float32Array>();
    for (const v of body.vectors) {
      if (v.dims !== DIMS) throw new Error(`MEDIA_WORKER_DIMS_${v.dims}`);
      const buf = Buffer.from(v.vector_b64, 'base64');
      out.set(v.id, new Float32Array(buf.buffer, buf.byteOffset, DIMS));
    }
    return { fingerprint: body.fingerprint, vectors: out };
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export class MediaIndexService {
  private readonly db: Db;
  private readonly media: MediaService;
  private readonly worker: MediaEmbedWorkerClient | null;

  constructor(db: Db, media: MediaService, worker: MediaEmbedWorkerClient | null) {
    this.db = db;
    this.media = media;
    this.worker = worker;
  }

  get available(): boolean {
    return this.worker !== null;
  }

  /** 图片资产入索引（幂等：同资产同 namespace 覆盖；sha 变化=重编）。 */
  async indexImage(assetId: string): Promise<{ indexed: true } | { indexed: false; reason: string }> {
    if (!this.worker) return { indexed: false, reason: 'MEDIA_WORKER_UNCONFIGURED' };
    const row = this.db.prepare('SELECT content_sha256 FROM media_assets WHERE id = ?').get(assetId) as { content_sha256: string } | undefined;
    if (!row) return { indexed: false, reason: 'ASSET_NOT_FOUND' };
    const { bytes } = this.media.readContent(assetId);
    const { fingerprint, vectors } = await this.worker.embed([{ id: assetId, modality: 'image', bytes }]);
    const vec = vectors.get(assetId);
    if (!vec) return { indexed: false, reason: 'MEDIA_WORKER_NO_VECTOR' };
    this.db.prepare(
      `INSERT INTO media_embedding_index (asset_id, modality, namespace, vector, content_sha256, created_at)
       VALUES (?, 'image', ?, ?, ?, ?)
       ON CONFLICT (asset_id, namespace) DO UPDATE SET vector = excluded.vector, content_sha256 = excluded.content_sha256, created_at = excluded.created_at`,
    ).run(assetId, fingerprint, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), row.content_sha256, new Date().toISOString());
    return { indexed: true };
  }

  /** 中文文字找图（M01）：候选=namespace 内图片索引 ×（活资产 + 本会话消息绑定）权限门。
   *  top_k 默认 3 最大 10；无足够相似= no_match 如实返回（不硬选 top1）。 */
  async searchImagesByRoom(query: string, roomId: string, topK = DEFAULT_TOP_K): Promise<MediaCandidates> {
    if (!this.worker) throw new Error('MEDIA_WORKER_UNCONFIGURED');
    const k = Math.max(1, Math.min(MAX_TOP_K, topK));
    const qBytes = Buffer.from(query, 'utf8');
    const { fingerprint, vectors } = await this.worker.embed([{ id: 'query', modality: 'text', bytes: qBytes }]);
    const qvec = vectors.get('query');
    if (!qvec) throw new Error('MEDIA_WORKER_NO_VECTOR');
    // 读路径权限门（07 删除失效）：join 活资产 + 当前会话消息绑定；tombstone/撤权立即消失
    const rows = this.db.prepare(
      `SELECT e.asset_id, e.vector FROM media_embedding_index e
       WHERE e.namespace = ? AND e.modality = 'image'
         AND EXISTS (SELECT 1 FROM media_assets a WHERE a.id = e.asset_id AND a.state = 'available')
         AND EXISTS (
           SELECT 1 FROM message_attachments ma JOIN messages m ON m.id = ma.message_id
           WHERE ma.asset_id = e.asset_id AND m.conversation_id = ?
         )`,
    ).all(fingerprint, roomId) as Array<{ asset_id: string; vector: Buffer }>;
    const scored = rows
      .map((r) => ({ asset_id: r.asset_id, score: cosine(qvec, new Float32Array(r.vector.buffer, r.vector.byteOffset, DIMS)) }))
      .filter((r) => r.score > MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    if (scored.length === 0) return { state: 'no_match', items: [] };
    return {
      state: 'candidates',
      items: scored.map((s) => ({ asset_ref: `est:${s.asset_id}`, kind: 'image' as const })),
    };
  }

  /** 孤儿索引行清理（可重试；读正确性不依赖它）。返回清理行数。 */
  purgeOrphans(): number {
    const res = this.db.prepare(
      `DELETE FROM media_embedding_index WHERE NOT EXISTS (SELECT 1 FROM media_assets a WHERE a.id = asset_id AND a.state = 'available')`,
    ).run();
    return Number(res.changes);
  }

  /** 当前 worker 指纹（health 取；不可达=null）。 */
  async workerFingerprint(): Promise<string | null> {
    if (!this.worker) return null;
    const h = await this.worker.health();
    return h.ok && h.fingerprint ? h.fingerprint : null;
  }

  /** 索引覆盖面（诊断/后台补索引用；不是检索路径）。
   *  namespace 给定时只认当前指纹缺行——异版本残留行不算"已索引"（M02）。 */
  unindexedImagesInRoom(roomId: string, namespace?: string): string[] {
    const notIndexed = namespace
      ? 'AND NOT EXISTS (SELECT 1 FROM media_embedding_index e WHERE e.asset_id = ma.asset_id AND e.namespace = ?)'
      : 'AND NOT EXISTS (SELECT 1 FROM media_embedding_index e WHERE e.asset_id = ma.asset_id)';
    return (this.db.prepare(
      `SELECT DISTINCT ma.asset_id FROM message_attachments ma
       JOIN messages m ON m.id = ma.message_id
       JOIN media_assets a ON a.id = ma.asset_id
       WHERE m.conversation_id = ? AND ma.presentation IN ('image','sticker') AND a.state = 'available'
         ${notIndexed}`,
    ).all(...(namespace ? [roomId, namespace] : [roomId])) as Array<{ asset_id: string }>).map((r) => r.asset_id);
  }
}
