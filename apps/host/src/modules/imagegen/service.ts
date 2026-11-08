// 相册重构 P3：图片生成用例（生成 ≠ 入库，两阶段幂等恢复——R12/04 §4.2）。
// ALB-05 整改（审计 2026-11-08）：完整成功条件 = 生成(至多一次，字节暂存) → 资产
// 落盘且 M 落正确认 → 作品条目建立且资产引用保护（pin/commit，同协调器协议）。
// 任一步未完成都如实返回可重试的未完成状态（同 opKey 重试只补缺失步骤，绝不
// 二次付费生成）；供应商结果未确认（unknown）停在待核实，不自动重发。
// Key 未配置=IMAGEGEN_UNCONFIGURED，如实不可用。
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

  /** 状态机（imagegen_operations.state）：
   *  generated=字节已暂存（存储/M 未确认）；stored=资产+M 已确认（条目未成）；
   *  saved=全部完成（暂存清空）；unknown=供应商结果未确认（禁止自动重发）；
   *  failed_generation/failed_retryable=生成阶段终态/可重试失败。 */
  async generateAndStore(o: { prompt: string; opKey: string; title?: string | null }): Promise<ImageGenOutcome> {
    const db = this.deps.db;
    const existing = db.prepare('SELECT * FROM imagegen_operations WHERE op_key = ?').get(o.opKey) as { state: string; result_b64: string | null; asset_id: string | null; creation_id: string | null; revised_prompt: string | null; error: string | null } | undefined;
    if (existing?.state === 'saved' && existing.asset_id) {
      return { ok: true, asset_id: existing.asset_id, creation_id: existing.creation_id, mime: '', revised_prompt: existing.revised_prompt, generation_call: 'none' };
    }
    if (existing?.state === 'unknown') {
      return { ok: false, code: 'IMAGEGEN_RESULT_UNCONFIRMED', detail: existing.error ?? '上次生成结果未确认——不自动重发（避免重复计费）；如供应商支持查询可人工核实', retryable: false };
    }
    if (!this.deps.adapter) return { ok: false, code: 'IMAGEGEN_UNCONFIGURED', detail: '图片生成未装配（未配置）', retryable: false };
    if (!this.deps.media) return { ok: false, code: 'INTEGRATION_UNCONFIGURED', detail: '媒体服务未装配', retryable: false };

    // —— 阶段 1：生成（同 opKey 至多一次）——
    let bytes: Buffer; let mime = ''; let revisedPrompt: string | null = null;
    let stagedAssetId = existing?.state === 'stored' ? existing.asset_id : null;
    if (existing?.state === 'generated' && existing.result_b64) {
      bytes = Buffer.from(existing.result_b64, 'base64'); // 只重试存储，不再次付费生成
      revisedPrompt = existing.revised_prompt;
    } else if (stagedAssetId) {
      // stored：资产已在（字节在 media 正本里）——跳过生成与保存，直接补 M 确认与条目
      bytes = Buffer.alloc(0);
      revisedPrompt = existing?.revised_prompt ?? null;
    } else {
      const r = await this.deps.adapter.generate(o.prompt);
      if (r.outcome === 'error') {
        const retryable = r.code === 'IMAGEGEN_NETWORK' || r.code === 'IMAGEGEN_RATE_LIMITED';
        this.upsert(o.opKey, { state: retryable ? 'failed_retryable' : 'failed_generation', error: `${r.code}: ${r.detail}` });
        return { ok: false, code: r.code, detail: r.detail, retryable };
      }
      if (r.outcome === 'unknown') {
        this.upsert(o.opKey, { state: 'unknown', error: r.reason });
        return { ok: false, code: 'IMAGEGEN_RESULT_UNCONFIRMED', detail: r.reason, retryable: false };
      }
      bytes = r.bytes; mime = r.mime; revisedPrompt = r.revisedPrompt;
      this.upsert(o.opKey, { state: 'generated', resultB64: bytes.toString('base64'), revisedPrompt, error: null });
    }

    // —— 阶段 2：资产落盘 + M 落正确认（ALB-05①：M 未确认不得报成功）——
    let asset: { id: string; mime_type: string; m_sync_state: string };
    try {
      asset = bytes.byteLength > 0 || !stagedAssetId
        ? await this.deps.media.saveBuffer({ bytes, purpose: 'creation_work', operationId: o.opKey, createdBy: 'jiaming', origin: 'generated' })
        : this.deps.media.getAsset(stagedAssetId);
    } catch (err) {
      this.upsert(o.opKey, { state: 'generated', resultB64: bytes.byteLength > 0 ? bytes.toString('base64') : (existing?.result_b64 ?? null), error: `IMAGEGEN_STORAGE_FAILED: ${String((err as Error).message).slice(0, 120)}` });
      return { ok: false, code: 'IMAGEGEN_STORAGE_FAILED', detail: `保存失败（已生成未入库）：${String((err as Error).message).slice(0, 120)}——重试沿用同一操作标识，只重试保存不重新生成`, retryable: true };
    }
    // M 落正确认：未 synced 时内联补试一次；仍失败=生成完成但正本未确认（可重试）
    if (this.deps.media.masterStoreConfigured && asset.m_sync_state !== 'synced') {
      await this.deps.media.attemptMSync(asset.id);
      asset = this.deps.media.getAsset(asset.id);
      if (asset.m_sync_state !== 'synced') {
        this.upsert(o.opKey, { state: 'generated', resultB64: bytes.byteLength > 0 ? bytes.toString('base64') : (existing?.result_b64 ?? null), error: 'IMAGEGEN_MASTER_PENDING: M 落正未确认' });
        return { ok: false, code: 'IMAGEGEN_MASTER_PENDING', detail: '生成已完成，但 M 唯一正本尚未确认落正——未建立作品条目；同键重试只补落正与条目，不会重新生成', retryable: true };
      }
    }

    // —— 阶段 3：作品条目 + 引用保护（ALB-05②③：条目未成不标 saved；pin/commit 保护）——
    this.deps.media.pinAssetForOperation({ assetId: asset.id, operationKey: o.opKey });
    let creationId: string | null = null;
    if (this.deps.contentClient) {
      try {
        const res = await contentForward(this.deps.contentClient, {
          method: 'POST', actor: 'jiaming', path: '/api/v1/content/creations',
          body: { title: o.title ?? null, work_asset_id: asset.id, work_kind: 'image' },
          headers: { 'idempotency-key': `imagegen:${o.opKey}` },
        });
        if (res.status === 201 || res.status === 200) {
          const created = res.body as { id?: string; revision?: number };
          creationId = typeof created.id === 'string' ? created.id : null;
        } else {
          this.upsert(o.opKey, { state: 'stored', assetId: asset.id, error: `IMAGEGEN_ENTRY_PENDING: content ${res.status}` });
          return { ok: false, code: 'IMAGEGEN_ENTRY_PENDING', detail: `资产已保存且 M 已确认，但作品条目被拒（${res.status}）——同键重试只补条目`, retryable: true };
        }
      } catch (err) {
        this.upsert(o.opKey, { state: 'stored', assetId: asset.id, error: `IMAGEGEN_ENTRY_PENDING: ${String((err as Error).message).slice(0, 100)}` });
        return { ok: false, code: 'IMAGEGEN_ENTRY_PENDING', detail: `资产已保存且 M 已确认，但内容服务不可达（${String((err as Error).message).slice(0, 80)}）——同键重试只补条目`, retryable: true };
      }
    }
    // 引用保护收口：按 content 权威快照把作品资产落成 committed 关系（防误删；
    // 与浏览器写协调器同一协议原语，条目幂等键保证不重复建）。
    if (creationId !== null) {
      const snap = await this.readCreationSnapshot(creationId);
      if (snap) this.deps.media.commitContentSnapshot({ type: 'creation', id: creationId }, snap, o.opKey);
    } else {
      this.deps.media.releaseOperationPins(o.opKey); // 无条目即无权威关系可确认（content 未装配边角）：pin 不悬置
    }

    db.prepare("UPDATE imagegen_operations SET state='saved', asset_id=?, creation_id=?, result_b64=NULL, error=NULL, updated_at=? WHERE op_key=?")
      .run(asset.id, creationId, new Date().toISOString(), o.opKey);
    return { ok: true, asset_id: asset.id, creation_id: creationId, mime: mime || asset.mime_type, revised_prompt: revisedPrompt, generation_call: 'first' };
  }

  /** content 权威快照读取（owner=creation；失败不阻塞收口——pin 仍在保护，恢复消费者对账）。 */
  private async readCreationSnapshot(creationId: string): Promise<{ ownerRevision: number; assetIds: string[] } | null> {
    if (!this.deps.contentClient) return null;
    try {
      const res = await contentForward(this.deps.contentClient, { method: 'GET', actor: 'jiaming', path: `/api/v1/content/references/creation/${encodeURIComponent(creationId)}` });
      if (res.status !== 200) return null;
      const b = res.body as { owner_revision?: number; deleted?: boolean; asset_ids?: string[] };
      if (typeof b.owner_revision !== 'number' || b.deleted === true) return null;
      return { ownerRevision: b.owner_revision, assetIds: Array.isArray(b.asset_ids) ? b.asset_ids : [] };
    } catch { return null; }
  }

  private upsert(opKey: string, v: { state: string; resultB64?: string | null; revisedPrompt?: string | null; assetId?: string | null; error?: string | null }): void {
    const now = new Date().toISOString();
    const db = this.deps.db;
    const row = db.prepare('SELECT op_key FROM imagegen_operations WHERE op_key = ?').get(opKey) as { op_key: string } | undefined;
    if (row) {
      db.prepare('UPDATE imagegen_operations SET state=?, result_b64=COALESCE(?, result_b64), revised_prompt=COALESCE(?, revised_prompt), asset_id=COALESCE(?, asset_id), error=?, updated_at=? WHERE op_key=?')
        .run(v.state, v.resultB64 ?? null, v.revisedPrompt ?? null, v.assetId ?? null, v.error ?? null, now, opKey);
    } else {
      db.prepare('INSERT INTO imagegen_operations(op_key, state, result_b64, revised_prompt, asset_id, error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(opKey, v.state, v.resultB64 ?? null, v.revisedPrompt ?? null, v.assetId ?? null, v.error ?? null, now, now);
    }
  }
}

export function imageGenOpKey(_toolCtx: { turnId: string | null; requestId: string; toolCallId?: string | null } | null, clientOperationId: string): string {
  // ALB-06①（审计 2026-11-08）：幂等身份=client_operation_id 本身。旧键含 requestId/
  // toolCallId——同一回合的工具续轮会换 requestId，模型按工具说明用同一
  // client_operation_id 重试时被当成新操作、二次付费生成。身份不含轮次信息：
  // 工具合同明确"重试沿用同一值"，跨轮次/跨回合的同值即同一业务操作。
  return `tool-imagegen:${clientOperationId}`;
}
