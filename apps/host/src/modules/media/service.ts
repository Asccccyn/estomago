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


  async mediaSearch(args: { query: string; limit?: number; scope?: 'chat' | 'stickers' }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.mediaIndex || !this.mediaIndex.available) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '图片语义检索未接入（能力缺口，如实拒绝）' } };
    // ALB-13/R33：stickers scope 只从 content stickers 分类的有效成员选——自拍/截图
    // 不因向量相近混入候选（集合空或未配置 content=如实无匹配/降级说明，不静默放开）。
    let allowSet: Set<string> | undefined;
    if (args.scope === 'stickers') {
      if (!this.contentClient) return { ok: false, output: { error_code: 'STICKER_SCOPE_UNAVAILABLE', detail: '表情包集合未接入（content 未配置）——本次不放开为全域搜索' } };
      try {
        const res = await contentForward(this.contentClient, { method: 'GET', actor: 'jiaming', path: '/api/v1/content/albums/stickers/entries?limit=100' });
        if (res.status !== 200) return { ok: false, output: { error_code: 'STICKER_SCOPE_UNAVAILABLE', detail: `表情包集合读取失败（${res.status}）——不放开为全域搜索` } };
        const items = (res.body as { items?: Array<{ asset_id?: string }> }).items ?? [];
        allowSet = new Set(items.map((i) => i.asset_id).filter((x): x is string => typeof x === 'string'));
      } catch {
        return { ok: false, output: { error_code: 'STICKER_SCOPE_UNAVAILABLE', detail: '表情包集合暂不可达——不放开为全域搜索' } };
      }
    }
    // Propagate host cancellation. A new short deadline would discard slow image results
    // while the non-preemptible worker still encodes them; background indexing remains open.
    const signal=ctx.signal;
    try {
      signal?.throwIfAborted();
      const fingerprint=await this.mediaIndex.workerFingerprint(signal);
      signal?.throwIfAborted();
      if(fingerprint===null)return {ok:false,output:{error_code:'MEDIA_WORKER_UNAVAILABLE',detail:'图片检索暂不可用；文字聊天不受影响'}};
      // RR6（复审 2026-11-09）：stickers scope 的未索引/失败统计按**本 scope 的真实
      // 候选集**（stickers 成员）算——旧实现沿用房间附件口径，只入集合未发聊天的资产
      // 既不会被补也不会被计入 pending，编码失败还被 catch 吞成普通 no_match。
      // 有界补齐（≤5/次，indexImage 幂等）后按同一候选集复核，失败/未索引用既有
      // coverage/pending_index 字段如实分开。chat scope 维持房间附件口径（R8′）。
      let scopePending: string[] = [];
      let indexFailed = 0;
      if (args.scope === 'stickers' && allowSet) {
        let topped = 0;
        for (const aid of allowSet) {
          if (topped >= 5 || signal?.aborted) break;
          if (!this.mediaIndex.assetIndexed(aid, fingerprint)) {
            try { await this.mediaIndex.indexImage(aid, signal); topped += 1; }
            catch { indexFailed += 1; }
          }
        }
        scopePending = [...allowSet].filter((aid) => !this.mediaIndex!.assetIndexed(aid, fingerprint));
      }
      const pending=this.mediaIndex.unindexedImagesInRoom(ctx.roomId,fingerprint);
      signal?.throwIfAborted();
      const result=await this.mediaIndex.searchImagesByRoom(args.query,ctx.roomId,args.limit??3,signal,allowSet);
      signal?.throwIfAborted();
      const out:Record<string,unknown>={...result};
      if(args.scope==='stickers'){
        out.scope='stickers';
        out.note='候选仅限表情包分类成员';
        if(scopePending.length>0){
          out.coverage='incomplete';out.pending_index=scopePending.length;
          out.note=indexFailed>0
            ? `表情包 ${scopePending.length} 张尚未建成索引（其中 ${indexFailed} 张编码失败——图片编码服务异常，文字检索不受影响）；本次结果可能不全`
            : `表情包 ${scopePending.length} 张尚未建成索引（后台补齐中）；本次结果可能不全，稍后可再查`;
        } else if (indexFailed > 0 && (out.hits as unknown[] | undefined)?.length === 0) {
          // 本轮补齐后无未索引残留、但有编码失败且零命中——如实说明，不伪装正常 no_match
          out.note = `表情包成员均已建索引，但本轮 ${indexFailed} 张编码失败后重新补齐；当前零命中可能因此不全，稍后可再查`;
        }
      } else if(pending.length>0){
        out.coverage='incomplete';out.pending_index=pending.length;out.note='部分图片索引后台进行中，本次结果可能不全；稍后可再查';
      }
      return {ok:true,output:out};
    }catch {
      return {ok:false,output:{error_code:ctx.signal?.aborted?'CANCELLED':'MEDIA_WORKER_UNAVAILABLE'}};
    }
  }

}
