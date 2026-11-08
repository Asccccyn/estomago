// 相册重构 P3：图片生成用例（生成 ≠ 入库，两阶段幂等恢复——R12/04 §4.2）。
// 生成成功即把字节暂存进行（result_b64）；入库失败重试只走存储，绝不二次调用付费
// 生成（同 op_key 的生成至多一次）。入库=MediaService 落盘+M 落正（既有链），随后
// 自动进作品（content creations，v5 图片作品免桶）；供应商结果未确认（unknown）停在
// 待核实状态，不自动重发。Key 未配置=IMAGEGEN_UNCONFIGURED，如实不可用。
import type { Db } from '../../db/connection.ts';
import type { MediaService } from '../../media/assets.ts';
import type { ImageGenAdapter } from '../../integrations/imagegen/adapter.ts';
import { contentForward, type ContentClient } from '../../integrations/content/client.ts';

export type ImageGenOutcome =
  | { ok: true; asset_id: string; creation_id: string | null; mime: string; revised_prompt: string | null; generation_call: 'first' | 'none' }
  | { ok: false; code: string; detail: string; retryable: boolean };

export class ImageGenService {
  private readonly deps: { db: Db; adapter: ImageGenAdapter | null; media: MediaService | null; contentClient: ContentClient | null };
  constructor(deps: { db: Db; adapter: ImageGenAdapter | null; media: MediaService | null; contentClient: ContentClient | null }) {
    this.deps = deps;
  }

  async generateAndStore(o: { prompt: string; opKey: string; title?: string | null }): Promise<ImageGenOutcome> {
    const existing = this.deps.db.prepare('SELECT * FROM imagegen_operations WHERE op_key = ?').get(o.opKey) as { state: string; result_b64: string | null; asset_id: string | null; creation_id: string | null; revised_prompt: string | null; error: string | null } | undefined;
    if (existing?.state === 'saved' && existing.asset_id) {
      return { ok: true, asset_id: existing.asset_id, creation_id: existing.creation_id, mime: '', revised_prompt: existing.revised_prompt, generation_call: 'none' };
    }
    if (existing?.state === 'unknown') {
      return { ok: false, code: 'IMAGEGEN_RESULT_UNCONFIRMED', detail: existing.error ?? '上次生成结果未确认——不自动重发（避免重复计费）；如供应商支持查询可人工核实', retryable: false };
    }
    if (!this.deps.adapter) return { ok: false, code: 'IMAGEGEN_UNCONFIGURED', detail: '图片生成未装配（未配置）', retryable: false };
    if (!this.deps.media) return { ok: false, code: 'INTEGRATION_UNCONFIGURED', detail: '媒体服务未装配', retryable: false };

    let bytes: Buffer; let mime: string; let revisedPrompt: string | null = null;
    if (existing?.state === 'generated' && existing.result_b64) {
      // 生成已完成、入库未成：只重试存储（复用暂存字节——不再次付费生成）
      bytes = Buffer.from(existing.result_b64, 'base64');
      mime = '';
    } else {
      const r = await this.deps.adapter.generate(o.prompt);
      if (r.outcome === 'error') {
        this.upsert(o.opKey, { state: r.code === 'IMAGEGEN_NETWORK' || r.code === 'IMAGEGEN_RATE_LIMITED' ? 'failed_retryable' : 'failed_generation', error: `${r.code}: ${r.detail}` });
        return { ok: false, code: r.code, detail: r.detail, retryable: r.code === 'IMAGEGEN_NETWORK' || r.code === 'IMAGEGEN_RATE_LIMITED' };
      }
      if (r.outcome === 'unknown') {
        this.upsert(o.opKey, { state: 'unknown', error: r.reason });
        return { ok: false, code: 'IMAGEGEN_RESULT_UNCONFIRMED', detail: r.reason, retryable: false };
      }
      bytes = r.bytes; mime = r.mime; revisedPrompt = r.revisedPrompt;
      this.upsert(o.opKey, { state: 'generated', resultB64: bytes.toString('base64'), revisedPrompt, error: null });
    }

    // 入库（本地落盘+M 落正与 content 作品条目是独立两步，各自幂等）。入库失败保留
    // 暂存字节与 generated 状态——重试只走存储，不退回生成（R12：存储重试≠再次付费）
    let asset: Awaited<ReturnType<MediaService['saveBuffer']>>;
    try {
      asset = await this.deps.media.saveBuffer({ bytes, purpose: 'creation_work', operationId: o.opKey, createdBy: 'jiaming', origin: 'generated' });
    } catch (err) {
      this.upsert(o.opKey, { state: 'generated', resultB64: bytes.toString('base64'), error: `IMAGEGEN_STORAGE_FAILED: ${String((err as Error).message).slice(0, 120)}` });
      return { ok: false, code: 'IMAGEGEN_STORAGE_FAILED', detail: `保存失败（已生成未入库）：${String((err as Error).message).slice(0, 120)}——重试沿用同一操作标识，只重试保存不重新生成`, retryable: true };
    }
    let creationId: string | null = null;
    if (this.deps.contentClient) {
      try {
        const res = await contentForward(this.deps.contentClient, {
          method: 'POST', actor: 'jiaming', path: '/api/v1/content/creations',
          body: { title: o.title ?? null, work_asset_id: asset.id, work_kind: 'image' },
          headers: { 'idempotency-key': `imagegen:${o.opKey}` },
        });
        if (res.status === 201 || res.status === 200) creationId = (res.body as { id: string }).id ?? null;
      } catch { /* content 不可达：作品条目失败不撤回资产保存（下一步重试补条目） */ }
    }
    this.deps.db.prepare("UPDATE imagegen_operations SET state='saved', asset_id=?, creation_id=?, result_b64=NULL, error=NULL, updated_at=? WHERE op_key=?")
      .run(asset.id, creationId, new Date().toISOString(), o.opKey);
    return { ok: true, asset_id: asset.id, creation_id: creationId, mime: mime || asset.mime_type, revised_prompt: revisedPrompt, generation_call: 'first' };
  }

  private upsert(opKey: string, v: { state: string; resultB64?: string; revisedPrompt?: string | null; error?: string | null }): void {
    const now = new Date().toISOString();
    const row = this.deps.db.prepare('SELECT op_key FROM imagegen_operations WHERE op_key = ?').get(opKey) as { op_key: string } | undefined;
    if (row) {
      this.deps.db.prepare('UPDATE imagegen_operations SET state=?, result_b64=COALESCE(?, result_b64), revised_prompt=COALESCE(?, revised_prompt), error=?, updated_at=? WHERE op_key=?')
        .run(v.state, v.resultB64 ?? null, v.revisedPrompt ?? null, v.error ?? null, now, opKey);
    } else {
      this.deps.db.prepare('INSERT INTO imagegen_operations(op_key, state, result_b64, revised_prompt, error, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(opKey, v.state, v.resultB64 ?? null, v.revisedPrompt ?? null, v.error ?? null, now, now);
    }
  }
}

export function imageGenOpKey(toolCtx: { turnId: string | null; requestId: string; toolCallId?: string | null }, clientOperationId: string): string {
  // 幂等身份含 client_operation_id（同调用重放=同键；不同调用不同键）
  return `tool-imagegen:${toolCtx.turnId ?? 'noturn'}:${toolCtx.requestId}:${toolCtx.toolCallId ?? 'nocall'}:${clientOperationId}`;
}
