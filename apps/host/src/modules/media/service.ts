// modules/media/service.ts（P04.9）：media_import/media_search 用例。
// 原 HostToolExecutor 方法逐字迁移：复用现有 assets/index/embedding worker 接口；
// 不绕过 URL 安全或收费上界；worker 故障=能力如实不可用，不拖聊天。
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';

export class MediaToolsService {
  private readonly media: import('../../media/assets.ts').MediaService | null;
  private readonly mediaIndex: import('../../media/index/service.ts').MediaIndexService | null;

  constructor(deps: { media?: import('../../media/assets.ts').MediaService | null; mediaIndex?: import('../../media/index/service.ts').MediaIndexService | null }) {
    this.media = deps.media ?? null;
    this.mediaIndex = deps.mediaIndex ?? null;
  }

  async mediaImport(args: { source_url: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.media) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '媒体服务未装配' } };
    const operationId = `tool-media-import:${ctx.turnId ?? 'noturn'}:${ctx.requestId}`;
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
