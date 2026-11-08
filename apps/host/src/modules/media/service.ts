// modules/media/service.ts（P04.9）：media_import/media_search 用例。
// 原 HostToolExecutor 方法逐字迁移：复用现有 assets/index/embedding worker 接口；
// 不绕过 URL 安全或收费上界；worker 故障=能力如实不可用，不拖聊天。
import { MediaError } from '../../media/assets.ts';
import { contentForward, type ContentClient } from '../../integrations/content/client.ts';
import { OidoSourceRepository } from '../oido/source-repository.ts';
import type { Db } from '../../db/connection.ts';
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';

export class MediaToolsService {
  private readonly media: import('../../media/assets.ts').MediaService | null;
  private readonly contentClient: ContentClient | null;
  private readonly sources: OidoSourceRepository | null;
  private readonly mediaIndex: import('../../media/index/service.ts').MediaIndexService | null;

  constructor(deps: { db?: Db; contentClient?: ContentClient | null; media?: import('../../media/assets.ts').MediaService | null; mediaIndex?: import('../../media/index/service.ts').MediaIndexService | null }) {
    this.media = deps.media ?? null;
    this.contentClient = deps.contentClient ?? null;
    this.sources = deps.db ? new OidoSourceRepository(deps.db) : null;
    this.mediaIndex = deps.mediaIndex ?? null;
  }

  async readImage(assetId: string, roomId: string): Promise<{ bytes: Buffer; mime: string }> {
    if (!this.media) throw new MediaError('INTEGRATION_UNCONFIGURED', 503, '媒体服务未装配');
    const asset = this.media.getAsset(assetId);
    let allowed = this.media.publishedImageInRoom(assetId, roomId);
    if (!allowed && asset.origin_service === 'oido' && asset.origin_ref && this.sources) {
      const binding = this.sources.analysisBinding(asset.origin_ref, roomId);
      allowed = Boolean(binding && this.sources.sourceAllowed(binding.asset_id, roomId, binding.content_sha256));
    }
    if (!allowed && this.contentClient) {
      const response = await contentForward(this.contentClient, { method:'GET', actor:'jiaming',
        path:`/api/v1/content/albums?asset_id=${encodeURIComponent(assetId)}` });
      const body = response.body as { albums?: unknown[] };
      allowed = response.status === 200 && Array.isArray(body.albums) && body.albums.length > 0;
    }
    if (!allowed && this.contentClient) {
      // ALB-05④：作品成员（icon/work 引用，含生图新作品）可读——模型收到生成回执后
      // media_view 能实际打开（R36：可操作真实资源）。
      const response = await contentForward(this.contentClient, { method:'GET', actor:'jiaming',
        path:`/api/v1/content/creations?asset_id=${encodeURIComponent(assetId)}&limit=1` });
      const body = response.body as { items?: unknown[] };
      allowed = response.status === 200 && Array.isArray(body.items) && body.items.length > 0;
    }
    if (!allowed) throw new MediaError('ASSET_NOT_READABLE', 403, '图片不属于当前房间已发布附件或可读相册');
    if (!['image/png','image/jpeg','image/gif','image/webp'].includes(asset.mime_type)) throw new MediaError('ASSET_TYPE_UNSUPPORTED', 422, '该资产不是可投递图片');
    // Access can be revoked between tool execution and sending/replaying history.
    // Both transports call this same resolver at their actual send boundary.
    return this.media.readContentResolvingMaster(assetId);
  }

  async mediaView(args: { asset_ref: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    const assetId = args.asset_ref.slice(4);
    try {
      const image = await this.readImage(assetId, ctx.roomId);
      return { ok:true, output:{asset_ref:args.asset_ref,mime_type:image.mime}, imageRefs:[assetId] };
    } catch (error) {
      return { ok:false, output:{error_code:(error as {code?:string}).code ?? 'IMAGE_READ_FAILED', detail:String((error as Error).message)} };
    }
  }

  async mediaImport(args: { source_url: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.media) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '媒体服务未装配' } };
    // F05（四仓联合审计 20261104）：操作身份含 toolCallId——旧键 turnId:requestId 在同一
    // 模型请求的两个 media_import 调用（不同 tool_call_id/URL）间共用，第二个直接命中
    // 第一个的幂等缓存返回第一张图（审计实测两次 asset_id 相同）。同调用重放（同
    // toolCallId）仍稳定复用；内容寻址去重由资产层另行保留。
    const operationId = `tool-media-import:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${ctx.toolCallId ?? 'nocall'}`;
    try {
      const a = await this.media.importFromUrl({ sourceUrl: args.source_url, operationId, createdBy: 'jiaming' });
      return { ok: true, output: { asset_id: a.id, mime_type: a.mime_type, byte_size: a.byte_size, imported: true } };
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'ASSET_IMPORT_FAILED';
      return { ok: false, output: { error_code: code, retryable: code === 'ASSET_IMPORT_FAILED' } };
    }
  }


  async mediaSearch(args: { query: string; limit?: number }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.mediaIndex || !this.mediaIndex.available) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '图片语义检索未接入（能力缺口，如实拒绝）' } };
    // Propagate host cancellation. A new short deadline would discard slow image results
    // while the non-preemptible worker still encodes them; background indexing remains open.
    const signal=ctx.signal;
    try {
      signal?.throwIfAborted();
      const fingerprint=await this.mediaIndex.workerFingerprint(signal);
      signal?.throwIfAborted();
      if(fingerprint===null)return {ok:false,output:{error_code:'MEDIA_WORKER_UNAVAILABLE',detail:'图片检索暂不可用；文字聊天不受影响'}};
      // R8′（2026-10-23）：检索路径不再前台补索引——此前工具内顺序 await ≤200 图，
      // 长期占住同会话串行链；补索引移至 app-context 独立循环（media/index/backfill.ts，
      // ≤5 图/跳）。检索不完整与 no_match 分开如实报：pending>0 = coverage:'incomplete'。
      const pending=this.mediaIndex.unindexedImagesInRoom(ctx.roomId,fingerprint);
      signal?.throwIfAborted();
      const result=await this.mediaIndex.searchImagesByRoom(args.query,ctx.roomId,args.limit??3,signal);
      signal?.throwIfAborted();
      const out:Record<string,unknown>={...result};
      if(pending.length>0){out.coverage='incomplete';out.pending_index=pending.length;out.note='部分图片索引后台进行中，本次结果可能不全；稍后可再查';}
      return {ok:true,output:out};
    }catch {
      return {ok:false,output:{error_code:ctx.signal?.aborted?'CANCELLED':'MEDIA_WORKER_UNAVAILABLE'}};
    }
  }

}
