// modules/media/service.ts（P04.9）：media_import/media_search 用例。
// 原 HostToolExecutor 方法逐字迁移：复用现有 assets/index/embedding worker 接口；
// 不绕过 URL 安全或收费上界；worker 故障=能力如实不可用，不拖聊天。
import { MediaError } from '../../media/assets.ts';
import { contentForward, readAllContentPages, type ContentClient } from '../../integrations/content/client.ts';
import { OidoSourceRepository } from '../oido/source-repository.ts';
import type { Db } from '../../db/connection.ts';
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';
import { CONTENT_ALBUMS } from '../../../../../packages/contracts/src/content.ts';

export class MediaToolsService {
  private readonly media: import('../../media/assets.ts').MediaService | null;
  private readonly contentClient: ContentClient | null;
  private readonly sources: OidoSourceRepository | null;
  private readonly mediaIndex: import('../../media/index/service.ts').MediaIndexService | null;
  private readonly db: Db | null;

  constructor(deps: { db?: Db; contentClient?: ContentClient | null; media?: import('../../media/assets.ts').MediaService | null; mediaIndex?: import('../../media/index/service.ts').MediaIndexService | null }) {
    this.media = deps.media ?? null;
    this.contentClient = deps.contentClient ?? null;
    this.db = deps.db ?? null;
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
    // M06（审计 2026-11-15）：media_import 的合法导入回执给出可看引用——刚导入、尚未
    // 发布/入册/入作品的资产按"导入操作所属回合的房间"授权（操作身份含 turnId，turn
    // 属本房间=可看），不是放开任意 asset_id。
    if (!allowed && asset.origin === 'import' && asset.creation_operation_id?.startsWith('tool-media-import:')) {
      const turnId = asset.creation_operation_id.split(':')[1] ?? '';
      if (turnId && turnId !== 'noturn' && this.db) {
        const t = this.db.prepare('SELECT conversation_id FROM turns WHERE id = ?').get(turnId) as { conversation_id: string } | undefined;
        allowed = t?.conversation_id === roomId;
      }
    }
    if (!allowed && this.contentClient) {
      // RR4-A：授权反查的两种传输故障 flavor 都不得误判为"无权读"——如实 503
      let response: Awaited<ReturnType<typeof contentForward>>;
      try {
        response = await contentForward(this.contentClient, { method:'GET', actor:'jiaming',
          path:`/api/v1/content/albums?asset_id=${encodeURIComponent(assetId)}` });
      } catch { throw new MediaError('CONTENT_UNREACHABLE', 503, '内容服务暂不可达（正文传输失败）——不能据此判不可读'); }
      if (response.bodyFailed) throw new MediaError('CONTENT_UNREACHABLE', 503, '内容服务响应不完整（正文传输失败）——不能据此判不可读');
      const body = response.body as { albums?: unknown[] };
      allowed = response.status === 200 && Array.isArray(body.albums) && body.albums.length > 0;
    }
    if (!allowed && this.contentClient) {
      // ALB-05④：作品成员（icon/work 引用，含生图新作品）可读——模型收到生成回执后
      // media_view 能实际打开（R36：可操作真实资源）。传输故障同上——503 不误判。
      let response: Awaited<ReturnType<typeof contentForward>>;
      try {
        response = await contentForward(this.contentClient, { method:'GET', actor:'jiaming',
          path:`/api/v1/content/creations?asset_id=${encodeURIComponent(assetId)}&limit=1` });
      } catch { throw new MediaError('CONTENT_UNREACHABLE', 503, '内容服务暂不可达（正文传输失败）——不能据此判不可读'); }
      if (response.bodyFailed) throw new MediaError('CONTENT_UNREACHABLE', 503, '内容服务响应不完整（正文传输失败）——不能据此判不可读');
      const body = response.body as { items?: unknown[] };
      allowed = response.status === 200 && Array.isArray(body.items) && body.items.length > 0;
    }
    if (!allowed) throw new MediaError('ASSET_NOT_READABLE', 403, '图片不属于当前房间已发布附件或可读相册');
    if (asset.mime_type === 'text/html' || (asset.mime_type === 'image/svg+xml' && !this.media.canProvideImage(asset))) {
      // M06/E06（包1 2026-11-15）：SVG/HTML 是隔离预览交付的代码作品——模型视觉通道
      // 只收位图，如实报限制+可用入口，不冒充已看到图片。
      throw new MediaError('ASSET_TYPE_UNSUPPORTED', 422, `这是 ${asset.mime_type} 代码作品，不能作为图片直接查看；沙箱预览入口 /api/v1/assets/${assetId}/preview，聊天交付用 chat_send_attachment（presentation=work）`);
    }
    if (!['image/png','image/jpeg','image/gif','image/webp','image/svg+xml'].includes(asset.mime_type)) throw new MediaError('ASSET_TYPE_UNSUPPORTED', 422, '该资产不是可投递图片');
    // Access can be revoked between tool execution and sending/replaying history.
    // Both transports call this same resolver at their actual send boundary.
    return this.media.readContentResolvingMaster(assetId, { modelImage: true });
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
      // M06（审计 2026-11-15）：回执给 media_view 要求原样传回的 asset_ref（导入后即可看）
      return { ok: true, output: { asset_id: a.id, asset_ref: `est:${a.id}`, mime_type: a.mime_type, byte_size: a.byte_size, imported: true, view_hint: '查看用 media_view 传回 asset_ref' } };
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'ASSET_IMPORT_FAILED';
      return { ok: false, output: { error_code: code, retryable: code === 'ASSET_IMPORT_FAILED' } };
    }
  }


  async mediaSearch(args: { query: string; limit?: number; scope?: 'chat' | 'stickers' | 'photos' | 'creations' }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.mediaIndex || !this.mediaIndex.available) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '图片语义检索未接入（能力缺口，如实拒绝）' } };
    // ALB-13/R33 + RR4-W2b（林石见 2026-11-10 修正稿"全量覆盖"）：集合 scope
    // （stickers/photos/creations）只从对应分类的**全部有效成员**选——分页以
    // next_cursor=null 为唯一结束条件（批次大小控制每次工作量，不限制业务范围；
    // 旧实现只取前 100 条）。分类语义保留（表情不混自拍）。集合空或未配置
    // content=如实无匹配/降级说明，不静默放开为全域搜索。
    const scopeLabel = args.scope === 'stickers' ? '表情包' : args.scope === 'photos' ? '相册' : '作品';
    let allowSet: Set<string> | undefined;
    if (args.scope !== undefined && args.scope !== 'chat') {
      if (!this.contentClient) return { ok: false, output: { error_code: 'ALBUM_SCOPE_UNAVAILABLE', detail: `${scopeLabel}集合未接入（content 未配置）——本次不放开为全域搜索` } };
      // RR4-F4：集合分页改用共享读取器 readAllContentPages——取消（ctx.signal）贯穿
      // 每页请求（第一页期间取消即停，不再读后页）；游标停滞/非 200=失败不装全量。
      const scopeFail = (reason: 'cancelled' | 'failed') => ({ ok: false as const, output: { error_code: 'ALBUM_SCOPE_UNAVAILABLE', detail: reason === 'cancelled' ? `已取消${scopeLabel}集合读取` : `${scopeLabel}集合分页读取失败——不放开为全域搜索` } });
      let collected: string[];
      if (args.scope === 'creations') {
        const r = await readAllContentPages<{ work_asset_id?: string | null; work_kind?: string | null; icon_asset_id?: string | null }>(this.contentClient, {
          buildPath: (cursor) => `/api/v1/content/creations?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          signal: ctx.signal,
        });
        if (!r.ok) return scopeFail(r.reason);
        collected = r.items.flatMap((it) => {
          const out: string[] = [];
          if (it.work_kind === 'image' && typeof it.work_asset_id === 'string') out.push(it.work_asset_id);
          if (typeof it.icon_asset_id === 'string' && it.icon_asset_id !== it.work_asset_id) out.push(it.icon_asset_id);
          return out;
        });
      } else {
        const albums = CONTENT_ALBUMS.filter(({ album }) => (album === 'stickers') === (args.scope === 'stickers'));
        collected = [];
        for (const { album } of albums) {
          const r = await readAllContentPages<{ asset_id?: string }>(this.contentClient, {
            buildPath: (cursor) => `/api/v1/content/albums/${album}/entries?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
            signal: ctx.signal,
          });
          if (!r.ok) return scopeFail(r.reason);
          for (const item of r.items) if (typeof item.asset_id === 'string') collected.push(item.asset_id);
        }
      }
      allowSet = new Set(collected);
    }
    // Propagate host cancellation. A new short deadline would discard slow image results
    // while the non-preemptible worker still encodes them; background indexing remains open.
    const signal=ctx.signal;
    try {
      signal?.throwIfAborted();
      const fingerprint=await this.mediaIndex.workerFingerprint(signal);
      signal?.throwIfAborted();
      if(fingerprint===null)return {ok:false,output:{error_code:'MEDIA_WORKER_UNAVAILABLE',detail:'图片检索暂不可用；文字聊天不受影响'}};
      // RR6（复审 2026-11-09）+RR4-W2a/W2b：集合 scope 的未索引/失败统计按**本 scope 的
      // 全量候选集**算——只入集合未发聊天的资产由后台补索引 tick 从相册/作品枚举持续
      // 补齐（见 app-context），检索时仍有界补 ≤5 次/次（indexImage 幂等）；**每次尝试
      // 都消耗额度（失败也计数）**——候选放开后不能让连续失败图变相放大尝试量。失败/
      // 未索引用既有 coverage/pending_index 字段如实分开。chat scope 维持房间附件口径（R8′）。
      let scopePending: string[] = [];
      let indexFailed = 0;
      if (allowSet) {
        let topped = 0;
        for (const aid of allowSet) {
          if (topped >= 5 || signal?.aborted) break;
          if (!this.mediaIndex.assetIndexed(aid, fingerprint)) {
            try { await this.mediaIndex.indexImage(aid, signal); }
            catch { indexFailed += 1; }
            topped += 1; // 尝试即计数（含失败）——额度约束的是尝试量
          }
        }
        scopePending = [...allowSet].filter((aid) => !this.mediaIndex!.assetIndexed(aid, fingerprint));
      }
      const pending = args.scope === undefined || args.scope === 'chat' ? this.mediaIndex.unindexedImagesInRoom(ctx.roomId,fingerprint) : [];
      signal?.throwIfAborted();
      const result=await this.mediaIndex.searchImagesByRoom(args.query,ctx.roomId,args.limit??3,signal,allowSet);
      signal?.throwIfAborted();
      const out:Record<string,unknown>={...result};
      if(allowSet){
        out.scope=args.scope;
        out.note=`候选仅限${scopeLabel}分类成员（全部成员）`;
        if(scopePending.length>0){
          out.coverage='incomplete';out.pending_index=scopePending.length;
          out.note=indexFailed>0
            ? `${scopeLabel} ${scopePending.length} 张尚未建成索引（其中 ${indexFailed} 张编码失败——图片编码服务异常，文字检索不受影响）；本次结果可能不全`
            : `${scopeLabel} ${scopePending.length} 张尚未建成索引（后台补齐中）；本次结果可能不全，稍后可再查`;
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
