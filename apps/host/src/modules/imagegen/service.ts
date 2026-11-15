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
  | { ok: true; asset_id: string; creation_id: string | null; mime: string; revised_prompt: string | null; generation_call: 'first' | 'none'; published_message_id?: string }
  | { ok: false; code: string; detail: string; retryable: boolean; saved_asset_id?: string; saved_creation_id?: string | null };

export class ImageGenService {
  private readonly deps: { db: Db; adapter: ImageGenAdapter | null; media: MediaService | null; contentClient: ContentClient | null; messages?: import('../../messages/service.ts').MessageService | null; events?: import('../../events/service.ts').EventService | null; archiveSync?: { drainOnce(): Promise<unknown> } | null };
  constructor(deps: { db: Db; adapter: ImageGenAdapter | null; media: MediaService | null; contentClient: ContentClient | null; messages?: import('../../messages/service.ts').MessageService | null; events?: import('../../events/service.ts').EventService | null; archiveSync?: { drainOnce(): Promise<unknown> } | null }) {
    this.deps = deps;
  }

  /** 状态机（imagegen_operations.state）：
   *  generated=字节已暂存（存储/M 未确认）；stored=资产+M 已确认（条目未成）；
   *  saved=全部完成（暂存清空）；unknown=供应商结果未确认（禁止自动重发）；
   *  failed_generation/failed_retryable=生成阶段终态/可重试失败。
   *  M03（包1 2026-11-15）：默认交付=send——saved 后发布到当前聊天；发布幂等靠确定性
   *  clientMessageId（同键重放/发布失败重试都只补发布，不重新生成）。 */
  async generateAndStore(o: { prompt: string; opKey: string; title?: string | null; format?: string; size?: string; frameCount?: number; frameDurationMs?: number; deliver?: 'send' | 'save_only'; roomId?: string | null; turnId?: string | null }): Promise<ImageGenOutcome> {
    const db = this.deps.db;
    const existing = db.prepare('SELECT * FROM imagegen_operations WHERE op_key = ?').get(o.opKey) as { state: string; result_b64: string | null; asset_id: string | null; creation_id: string | null; revised_prompt: string | null; error: string | null; output_format: string | null } | undefined;
    if (existing?.state === 'saved' && existing.asset_id) {
      // M03：saved 后同键重放默认补发布（幂等：clientMessageId 命中返回原消息=D06）
      const published = o.deliver === 'send' ? this.tryPublish(o.opKey, existing.asset_id, o.roomId ?? null, o.turnId ?? null) : null;
      if (published && !published.ok) {
        return { ok: false, code: 'IMAGEGEN_PUBLISH_FAILED', detail: `作品已保存，但发布到当前聊天失败（${published.detail}）——同键重试只补发布，不会重新生成`, retryable: true, saved_asset_id: existing.asset_id, saved_creation_id: existing.creation_id };
      }
      return { ok: true, asset_id: existing.asset_id, creation_id: existing.creation_id, mime: '', revised_prompt: existing.revised_prompt, generation_call: 'none', ...(published?.ok ? { published_message_id: published.messageId } : {}) };
    }
    // R8：stored 且作品条目已建（snapshot 未确认）——同键重试只补快照确认与 saved 收口
    const storedResume = existing?.state === 'stored' && existing.asset_id !== null && existing.creation_id !== null
      ? { assetId: existing.asset_id as string, creationId: existing.creation_id as string, revisedPrompt: existing.revised_prompt } : null;
    if (storedResume !== null && this.deps.media !== null) {
      const { assetId: storedAsset, creationId: storedCreation, revisedPrompt: storedPrompt } = storedResume;
      const snap = await this.readCreationSnapshot(storedCreation);
      if (snap) {
        this.deps.media.pinAssetForOperation({ assetId: storedAsset, operationKey: o.opKey });
        this.deps.media.commitContentSnapshot({ type: 'creation', id: storedCreation }, snap, o.opKey);
        db.prepare("UPDATE imagegen_operations SET state='saved', error=NULL, updated_at=? WHERE op_key=?").run(new Date().toISOString(), o.opKey);
        return { ok: true, asset_id: storedAsset, creation_id: storedCreation, mime: '', revised_prompt: storedPrompt, generation_call: 'none' };
      }
      // RR7（复审 2026-11-09）：快照仍未确认=stored 未收口——如实返回可重试，不冒充 saved
      return { ok: false, code: 'IMAGEGEN_SNAPSHOT_PENDING', detail: '作品条目已建但引用快照未确认（content 暂不可达）——同键重试只补快照确认，不会重新生成', retryable: true };
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
      // GIF（她 2026-11-09 裁定+官方文档）：生成格式随操作持久——同键重试的生成调用
      // 沿用首次请求的 output_format（不因模型续轮换格式重画成另一种结果）。
      const effectiveFormat = o.format ?? existing?.output_format ?? undefined;
      const r = await this.deps.adapter.generate(o.prompt, { format: effectiveFormat, size: o.size, frameCount: o.frameCount, frameDurationMs: o.frameDurationMs });
      if (r.outcome === 'error') {
        // M04（包1 2026-11-15）：UPSTREAM_ERROR（收到完整 5xx 应答）与网络/限流同为
        // 可重试——供应商明确失败，同键重试重新请求上游；不再落 unknown 永久卡死。
        const retryable = r.code === 'IMAGEGEN_NETWORK' || r.code === 'IMAGEGEN_RATE_LIMITED' || r.code === 'IMAGEGEN_UPSTREAM_ERROR';
        this.upsert(o.opKey, { state: retryable ? 'failed_retryable' : 'failed_generation', error: `${r.code}: ${r.detail}` });
        return { ok: false, code: r.code, detail: r.detail, retryable };
      }
      if (r.outcome === 'unknown') {
        this.upsert(o.opKey, { state: 'unknown', error: r.reason });
        return { ok: false, code: 'IMAGEGEN_RESULT_UNCONFIRMED', detail: r.reason, retryable: false };
      }
      bytes = r.bytes; mime = r.mime; revisedPrompt = r.revisedPrompt;
      this.upsert(o.opKey, { state: 'generated', resultB64: bytes.toString('base64'), revisedPrompt, error: null, outputFormat: effectiveFormat ?? null });
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
          if (res.bodyFailed) {
            // RR4-A：2xx 但正文截断——条目可能已建（幂等键在）；不冒充成功也不提前
            // 释放 pin，行留 stored 同键重试（resolve replay 取回真实条目）。
            this.upsert(o.opKey, { state: 'stored', assetId: asset.id, error: 'IMAGEGEN_ENTRY_PENDING: body truncated' });
            return { ok: false, code: 'IMAGEGEN_ENTRY_PENDING', detail: '资产已保存且 M 已确认，但作品条目响应不完整（正文传输失败）——同键重试只补条目确认', retryable: true };
          }
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
    // RR7（复审 2026-11-09）：快照未确认=作品关系未闭合——行留 stored（含
    // creation_id，storedResume 分支自此真实可达），同键重试只补快照；不冒充 saved。
    if (creationId !== null) {
      const snap = await this.readCreationSnapshot(creationId);
      if (!snap) {
        this.upsert(o.opKey, { state: 'stored', assetId: asset.id, creationId, error: 'IMAGEGEN_SNAPSHOT_PENDING: content snapshot unconfirmed' });
        return { ok: false, code: 'IMAGEGEN_SNAPSHOT_PENDING', detail: '资产已保存且作品条目已建，但引用快照未确认（content 暂不可达）——同键重试只补快照确认，不会重新生成', retryable: true };
      }
      this.deps.media.commitContentSnapshot({ type: 'creation', id: creationId }, snap, o.opKey);
    } else {
      this.deps.media.releaseOperationPins(o.opKey); // 无条目即无权威关系可确认（content 未装配边角）：pin 不悬置
    }

    db.prepare("UPDATE imagegen_operations SET state='saved', asset_id=?, creation_id=?, result_b64=NULL, error=NULL, updated_at=? WHERE op_key=?")
      .run(asset.id, creationId, new Date().toISOString(), o.opKey);
    // M03：默认交付 send——发布失败不回滚保存（行已 saved，同键重试只补发布）
    if (o.deliver === 'send') {
      const published = this.tryPublish(o.opKey, asset.id, o.roomId ?? null, o.turnId ?? null);
      if (!published.ok) {
        return { ok: false, code: 'IMAGEGEN_PUBLISH_FAILED', detail: `作品已保存，但发布到当前聊天失败（${published.detail}）——同键重试只补发布，不会重新生成`, retryable: true, saved_asset_id: asset.id, saved_creation_id: creationId };
      }
      return { ok: true, asset_id: asset.id, creation_id: creationId, mime: mime || asset.mime_type, revised_prompt: revisedPrompt, generation_call: 'first', published_message_id: published.messageId };
    }
    return { ok: true, asset_id: asset.id, creation_id: creationId, mime: mime || asset.mime_type, revised_prompt: revisedPrompt, generation_call: 'first' };
  }

  /** M03（包1 2026-11-15）：发布到当前聊天——确定性 clientMessageId 使同键重放/中断恢复
   *  幂等（消息表唯一索引命中即返回原消息，不再发第二条=验收 D06）。与
   *  chat_send_attachment 同一发布入口（publishAssistantMessage），不另建消息通道。 */
  private tryPublish(opKey: string, assetId: string, roomId: string | null, turnId: string | null): { ok: true; messageId: string } | { ok: false; detail: string } {
    if (!this.deps.messages) return { ok: false, detail: '消息服务未装配' };
    if (!roomId) return { ok: false, detail: '无当前聊天房间' };
    try {
      const msg = this.deps.messages.publishAssistantMessage({
        conversationId: roomId, turnId: turnId ?? 'tool', content: '', kind: 'text',
        clientMessageId: `tool-imagegen:${opKey}:publish`,
        attachments: [{ asset_id: assetId, presentation: 'image' }],
        events: this.deps.events ?? null,
      });
      void this.deps.archiveSync?.drainOnce().catch(() => { /* 归档走 drain 重试 */ });
      return { ok: true, messageId: msg.id };
    } catch (err) {
      return { ok: false, detail: String((err as Error).message).slice(0, 120) };
    }
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

  private upsert(opKey: string, v: { state: string; resultB64?: string | null; revisedPrompt?: string | null; assetId?: string | null; creationId?: string | null; error?: string | null; outputFormat?: string | null }): void {
    const now = new Date().toISOString();
    const db = this.deps.db;
    const row = db.prepare('SELECT op_key FROM imagegen_operations WHERE op_key = ?').get(opKey) as { op_key: string } | undefined;
    if (row) {
      db.prepare('UPDATE imagegen_operations SET state=?, result_b64=COALESCE(?, result_b64), revised_prompt=COALESCE(?, revised_prompt), asset_id=COALESCE(?, asset_id), creation_id=COALESCE(?, creation_id), output_format=COALESCE(?, output_format), error=?, updated_at=? WHERE op_key=?')
        .run(v.state, v.resultB64 ?? null, v.revisedPrompt ?? null, v.assetId ?? null, v.creationId ?? null, v.outputFormat ?? null, v.error ?? null, now, opKey);
    } else {
      db.prepare('INSERT INTO imagegen_operations(op_key, state, result_b64, revised_prompt, asset_id, creation_id, output_format, error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(opKey, v.state, v.resultB64 ?? null, v.revisedPrompt ?? null, v.assetId ?? null, v.creationId ?? null, v.outputFormat ?? null, v.error ?? null, now, now);
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
