// modules/content/service.ts（P04.7）：content 域工具用例（发帖/评论/列表/小作品）。
// actor 从受控执行上下文派生为 jiaming；HTTP 与工具共用同一协调器实例（P1·F06/F07
// 20261106）：同操作回查、意图+pin、提交、权威快照确认与恢复对浏览器/模型一致。
// 创作小作品不执行代码（SVG 脚本拒绝）。
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';
import { CONTENT_POST_PREVIEW_CHARS } from '../../../../../packages/contracts/src/content.ts';
import { contentForward, resolveContentOperation } from '../../integrations/content/client.ts';
import type { StoredAsset } from '../../media/assets.ts';
import { sliceByByteBudget } from '../../media/model-input.ts';

const POST_PAGE_BYTES = 32_768;
const POST_BODY_CURSOR_PREFIX = 'post-body:';
const POST_BODY_READ_HINT = '把 body_cursor 传给 content_posts_list 的 cursor 参数，分页读该帖正文；用列表的 next_cursor 继续浏览列表。';

type PostListItem = Record<string, unknown> & { id: string; revision: number; body: string | null; body_truncated?: boolean };
type PostPage = { items: PostListItem[]; next_cursor: string | null; has_more: boolean };

export class ContentToolsService {
  private readonly contentClient: import('../../integrations/content/client.ts').ContentClient | null;
  private readonly media: import('../../media/assets.ts').MediaService | null;
  private readonly contentOps: import('../../integrations/content/coordinator.ts').ContentOperationCoordinator | null;

  constructor(deps: { contentClient?: import('../../integrations/content/client.ts').ContentClient | null; media?: import('../../media/assets.ts').MediaService | null; contentOps?: import('../../integrations/content/coordinator.ts').ContentOperationCoordinator | null }) {
    this.contentClient = deps.contentClient ?? null;
    this.media = deps.media ?? null;
    this.contentOps = deps.contentOps ?? null;
  }

  async contentPostCreate(args: { presentation?: string; title?: string; body: string; asset_ids?: string[]; idempotency_key: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient || !this.contentOps) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '内容服务未启用' } };
    const r = await this.contentOps.writeForModel({
      roomId: ctx.roomId, turnId: ctx.turnId, path: '/api/v1/content/posts', idempotencyKey: args.idempotency_key,
      body: { presentation: args.presentation ?? 'post', title: args.title, body: args.body, asset_ids: args.asset_ids ?? [] },
    });
    if (r.status === 201 || r.status === 200) {
      const { id, revision, author, presentation, asset_ids, published_at } = r.body as PostListItem;
      return { ok: true, output: { state: 'committed', id, revision, author, presentation, asset_ids, published_at,
        body_cursor: postBodyCursor(id, revision, 0), body_read_hint: POST_BODY_READ_HINT } };
    }
    return modelWriteFailure(r, args.idempotency_key, 'CONTENT_POST');
  }


  async contentCommentCreate(args: { post_id: string; body: string; idempotency_key: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient || !this.contentOps) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    const r = await this.contentOps.writeForModel({
      roomId: ctx.roomId, turnId: ctx.turnId, path: `/api/v1/content/posts/${encodeURIComponent(args.post_id)}/comments`,
      body: { body: args.body }, idempotencyKey: args.idempotency_key,
    });
    if (r.status === 201 || r.status === 200) {
      const { id, post_id, author, revision, created_at } = r.body as Record<string, unknown>;
      return { ok: true, output: { state: 'committed', id, post_id, author, revision, created_at } };
    }
    return modelWriteFailure(r, args.idempotency_key, 'CONTENT_COMMENT');
  }


  async contentPostsList(args: { cursor?: string; limit?: number; presentation?: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    const budget = Math.min(ctx.remainingResultBytes?.() ?? POST_PAGE_BYTES, POST_PAGE_BYTES);
    try {
      if (args.cursor?.startsWith(POST_BODY_CURSOR_PREFIX)) {
        const cursor = decodePostBodyCursor(args.cursor);
        if (!cursor) return postsReadFailed('帖子正文游标无效；请从帖子列表重新取得正文游标。');
        const r = await contentForward(this.contentClient, {
          method: 'GET', path: `/api/v1/content/posts/${encodeURIComponent(cursor.id)}`, actor: 'jiaming', signal: ctx.signal,
        });
        if (r.bodyFailed) return postsReadFailed('内容服务响应不完整（正文传输失败）。');
        if (r.status !== 200) return postsReadFailed(`读取帖子失败（HTTP ${r.status}）。`);
        const post = r.body as Partial<PostListItem> | null;
        if (post?.id !== cursor.id || post.revision !== cursor.revision || typeof post.body !== 'string') {
          return postsReadFailed('帖子已修改、删除或正文不可用；请重新读取帖子列表。');
        }
        const { pageText, nextOffset, done } = sliceByByteBudget(post.body, cursor.offset, Math.floor(budget / 2), 512);
        const output = {
          post_id: post.id, revision: post.revision, body: pageText, body_offset: cursor.offset,
          next_cursor: done ? null : postBodyCursor(post.id, post.revision, nextOffset), has_more: !done,
        };
        return (done || nextOffset > cursor.offset) && postResultBytes(output) <= budget
          ? { ok: true, output } : postsBudgetLimited(args.cursor);
      }

      const params = new URLSearchParams({ body_preview: '1' });
      if (args.cursor) params.set('cursor', args.cursor);
      if (args.presentation) params.set('presentation', args.presentation);
      let limit = args.limit !== undefined && args.limit >= 1 && args.limit <= 100 ? Math.floor(args.limit) : 20;
      for (;;) {
        params.set('limit', String(limit));
        const r = await contentForward(this.contentClient, {
          method: 'GET', path: `/api/v1/content/posts?${params}`, actor: 'jiaming', signal: ctx.signal,
        });
        if (r.bodyFailed) return postsReadFailed('内容服务响应不完整（正文传输失败）。');
        if (r.status !== 200) return postsReadFailed(`读取帖子列表失败（HTTP ${r.status}）。`);
        const page = r.body as PostPage | null;
        if (!Array.isArray(page?.items) || typeof page.has_more !== 'boolean'
            || (page.has_more && typeof page.next_cursor !== 'string')) {
          return postsReadFailed('内容服务的帖子列表响应格式不完整。');
        }
        const items = page.items.map(projectPostPreview);
        const output = { items, next_cursor: page.next_cursor ?? null, has_more: page.has_more,
          ...(items.some(item => item.body_truncated) ? { body_read_hint: POST_BODY_READ_HINT } : {}) };
        if (postResultBytes(output) <= budget) return { ok: true, output };
        if (items.length <= 1) return postsBudgetLimited(args.cursor);
        // Fetch the shorter page at the same boundary so the issuing service
        // supplies the cursor immediately after the last delivered post.
        limit = Math.floor(items.length / 2);
      }
    } catch {
      return postsReadFailed('内容服务暂不可达（正文传输失败）。');
    }
  }


  async contentAlbumsRead(args: Record<string, unknown>, _ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient) return {ok:false,output:{error_code:'INTEGRATION_UNCONFIGURED',detail:'相册服务未装配'}};
    const params = new URLSearchParams();
    for (const key of ['cursor','limit','q','source_service','source_kind','source_id']) if (args[key] !== undefined) params.set(key,String(args[key]));
    const endpoint = args.album ? `/albums/${encodeURIComponent(String(args.album))}/entries?${params}` : '/albums';
    // RR4-A：截断正文≠空相册——两种传输故障 flavor（fetch reject / 2xx 半包 JSON 失败）
    // 都如实报读失败，模型可重试（旧实现会把传输故障当空列表）
    let response: Awaited<ReturnType<typeof contentForward>>;
    try {
      response = await contentForward(this.contentClient,{method:'GET',actor:'jiaming',path:'/api/v1/content'+endpoint});
    } catch {
      return {ok:false,output:{error_code:'ALBUM_READ_FAILED',detail:'内容服务暂不可达（正文传输失败）'}};
    }
    if (response.status !== 200 || response.bodyFailed) return {ok:false,output:{error_code:'ALBUM_READ_FAILED',detail:response.bodyFailed?'内容服务响应不完整（正文传输失败）':JSON.stringify(response.body)}};
    const body = response.body as {albums?: unknown[];items?: Array<Record<string,unknown>>;next_cursor?:string|null;has_more?:boolean};
    if (!args.album) return {ok:true,output:{albums:body.albums ?? []}};
    return {ok:true,output:{items:(body.items ?? []).map(item=>({id:item.id,asset_ref:`est:${item.asset_id}`,caption:item.caption,meaning:item.meaning,created_at:item.created_at})),next_cursor:body.next_cursor,has_more:body.has_more}};
  }

  /** M06（包1 2026-11-15）：作品集读取入口——content creations 全量分页。图片作品给
   *  asset_ref（media_view 看图/发送用）；SVG/HTML 给 preview_ref 沙箱入口（模型不直接
   *  看图）。复用 content 正本 API，不另建检索；截断两 flavor 同 RR4-A 口径如实报失败。 */
  async contentCreationsRead(args: { cursor?: string; limit?: number }, _ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '内容服务未启用' } };
    const params = new URLSearchParams();
    if (args.limit && args.limit > 0 && args.limit <= 100) params.set('limit', String(Math.floor(args.limit)));
    if (args.cursor) params.set('cursor', args.cursor);
    let r: Awaited<ReturnType<typeof contentForward>>;
    try {
      r = await contentForward(this.contentClient, { method: 'GET', actor: 'jiaming', path: `/api/v1/content/creations?${params}` });
    } catch {
      return { ok: false, output: { error_code: 'CREATIONS_READ_FAILED', detail: '内容服务暂不可达（正文传输失败）' } };
    }
    if (r.bodyFailed) return { ok: false, output: { error_code: 'CREATIONS_READ_FAILED', detail: '内容服务响应不完整（正文传输失败）' } };
    if (r.status !== 200) return { ok: false, output: { error_code: 'CREATIONS_READ_FAILED', detail: `content ${r.status}` } };
    const b = r.body as { items?: Array<Record<string, unknown>>; next_cursor?: string | null; has_more?: boolean };
    const items = (b.items ?? []).map((it) => {
      const workKind = typeof it.work_kind === 'string' ? it.work_kind : null;
      const workAssetId = typeof it.work_asset_id === 'string' ? it.work_asset_id : null;
      return {
        creation_id: it.id ?? null,
        title: it.title ?? null,
        work_kind: workKind,
        created_at: it.created_at ?? null,
        // 图片作品：位图引用（可看可发）；SVG/HTML：沙箱预览引用（E06 限制如实标注）；
        // 其余类型（如 video——/preview 端点只收 SVG/HTML，审计 2026-11-15）：给 asset_id
        // 与真实限制，不把不支持预览的类型投影成预览入口。
        ...(workKind === 'image' && workAssetId
          ? { asset_ref: `est:${workAssetId}`, asset_id: workAssetId }
          : (workKind === 'svg' || workKind === 'html') && workAssetId
            ? { asset_id: workAssetId, preview_ref: `/api/v1/assets/${workAssetId}/preview`, note: 'SVG/HTML 代码作品：模型不直接看图，发送用 chat_send_attachment（presentation=work）' }
            : workAssetId
              ? { asset_id: workAssetId, note: `work_kind=${workKind ?? 'unknown'} 不支持沙箱预览端点（/preview 仅收 SVG/HTML）——引用真实，预览能力待该类型接入` }
              : {}),
        ...(typeof it.icon_asset_id === 'string' && it.icon_asset_id ? { icon_asset_ref: `est:${it.icon_asset_id}` } : {}),
      };
    });
    return { ok: true, output: { items, next_cursor: b.next_cursor ?? null, has_more: b.has_more ?? false } };
  }

  /** 相册追加和修改沿同一协调面，恢复时复用首次受理的资产引用和请求。 */
  async contentAlbumEntryWrite(args: { kind: string; asset_id: string; caption?: string; meaning?: string; carry_mode?: string; idempotency_key: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient || !this.contentOps) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '内容服务未启用' } };
    // RR2：补注 M 对象身份（同字节别名在 content 限额/携带集按原图归并）；资产缺席如实不带
    let sha256: string | null = null;
    try { sha256 = this.media?.getAsset(args.asset_id).content_sha256 ?? null; } catch { sha256 = null; }
    const r = await this.contentOps.writeForModel({
      roomId: ctx.roomId, turnId: ctx.turnId, path: `/api/v1/content/albums/${encodeURIComponent(args.kind)}/entries`,
      body: { asset_id: args.asset_id, caption: args.caption, meaning: args.meaning, ...(sha256 ? { content_sha256: sha256 } : {}), ...(args.carry_mode ? { carry_mode: args.carry_mode } : {}) },
      idempotencyKey: args.idempotency_key,
    });
    if (r.status === 201 || r.status === 200) return { ok: true, output: { ...(r.body as Record<string, unknown>), state: 'committed' } };
    return modelWriteFailure(r, args.idempotency_key, 'ALBUM_ENTRY', 'ALBUM_ENTRY_WRITE_FAILED');
  }

  async creationSaveArtifact(args: { format: 'svg' | 'html'; content: string; client_operation_id: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.media) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    const mime = args.format === 'svg' ? 'image/svg+xml' : 'text/html';
    // 内容安全检查：SVG 不允许 <script>；HTML 允许内联脚本（在沙箱 iframe 内执行——宿主不执行）
    if (args.format === 'svg' && /<script/i.test(args.content)) {
      return { ok: false, output: { error_code: 'SVG_SCRIPT_FORBIDDEN', detail: 'SVG 图标不允许内嵌脚本（HTML 作品请用 format=html 走沙箱预览）' } };
    }
    // ALB-06① 同款（审计 20261108 对 imagegen 的裁定，此处同口径）：幂等身份=
    // client_operation_id 本身。旧键含 turnId/requestId——工具续轮重试会换 requestId
    // 而重复建资产；R5 加入"条目失败→同键重试"路径后该缺陷会实际触发，随本批对齐。
    const opKey = `tool-creation:${args.client_operation_id}`;
    let asset: { id: string; byte_size: number };
    try {
      const input = { bytes: Buffer.from(args.content, 'utf8'), operationId: opKey, createdBy: 'jiaming', origin: 'generated' as const };
      const staticSvg = args.format === 'svg' ? await this.media.saveStaticSvg(input) : null;
      if (staticSvg) {
        const photo = await this.saveStaticSvgPhoto(staticSvg, args.client_operation_id, ctx);
        if (photo) return photo;
      }
      asset = staticSvg ?? await this.media.saveBuffer({ ...input, purpose: args.format === 'svg' ? 'creation_icon' : 'creation_work' });
    } catch (err) {
      return { ok: false, output: { error_code: (err as { code?: string }).code ?? 'ASSET_TYPE_UNSUPPORTED', detail: String((err as Error).message).slice(0, 200) } };
    }
    // R5（复审 2026-11-08）：保存即入作品——作品面板/工作台读 creations 条目，
    // 只存资产不入条目的作品用户不可见。条目未成=如实可重试（同键只补条目），
    // 不冒充 saved；引用保护沿用 imagegen 协议（pin→建条目→按权威快照 commit）。
    if (!this.contentClient) {
      return { ok: true, output: { asset_id: asset.id, mime_type: mime, byte_size: asset.byte_size, creation_id: null, saved: true, preview_ref: `/api/v1/assets/${asset.id}/preview`, deliver_hint: '发送到当前聊天用 chat_send_attachment（presentation=work，隔离预览交付）' } };
    }
    // RR4（复审 2026-11-09）：成功条件与 imagegen 同一根因口径——M 唯一正本未落正
    // 不得报 saved（落正由后台退避推进；同键重试只补落正与条目，不重复保存字节）。
    const synced = () => this.media!.getAsset(asset.id).m_sync_state === 'synced';
    if (this.media.masterStoreConfigured && !synced()) {
      await this.media.attemptMSync(asset.id);
      if (!synced()) {
        return { ok: false, output: { error_code: 'CREATION_MASTER_PENDING', detail: 'SVG/HTML 已生成并保存为资产，但 M 唯一正本尚未落正——未建作品条目；用同一 client_operation_id 重试只补落正与条目，不会重复保存' } };
      }
    }
    this.media.pinAssetForOperation({ assetId: asset.id, operationKey: opKey });
    try {
      const res = await contentForward(this.contentClient, {
        method: 'POST', actor: 'jiaming', path: '/api/v1/content/creations',
        body: { work_asset_id: asset.id, work_kind: args.format },
        headers: { 'idempotency-key': `tool-creation-entry:${args.client_operation_id}` },
      });
      if (res.status !== 201 && res.status !== 200) {
        this.media.releaseOperationPins(opKey);
        return { ok: false, output: { error_code: 'CREATION_ENTRY_PENDING', detail: `资产已保存，但作品条目被拒（${res.status}）——用同一 client_operation_id 重试只补条目，不会重复保存`, raw_status: res.status } };
      }
      if (res.bodyFailed) {
        // RR4-A：2xx 但正文截断——条目可能已建（幂等键在），不能当失败释放 pin 也不能
        // 冒充 saved：如实 PENDING（同键重试经 resolve replay 取回真实条目），pin 保留。
        return { ok: false, output: { error_code: 'CREATION_ENTRY_PENDING', detail: '资产已保存，但作品条目响应不完整（正文传输失败）——用同一 client_operation_id 重试只补条目确认', raw_status: 503 } };
      }
      const creation = res.body as { id?: string };
      const creationId = typeof creation.id === 'string' ? creation.id : null;
      if (creationId !== null) {
        let snapConfirmed = false;
        try {
          const snap = await contentForward(this.contentClient, { method: 'GET', actor: 'jiaming', path: `/api/v1/content/references/creation/${encodeURIComponent(creationId)}` });
          const b = snap.body as { owner_revision?: number; deleted?: boolean; asset_ids?: string[] };
          if (snap.status === 200 && typeof b.owner_revision === 'number' && b.deleted !== true) {
            this.media.commitContentSnapshot({ type: 'creation', id: creationId }, { ownerRevision: b.owner_revision, assetIds: Array.isArray(b.asset_ids) ? b.asset_ids : [] }, opKey);
            snapConfirmed = true;
          }
        } catch { /* 快照读取失败按未确认处理（下方如实返回） */ }
        if (!snapConfirmed) {
          return { ok: false, output: { error_code: 'CREATION_SNAPSHOT_PENDING', detail: '资产与作品条目已建，但引用快照未确认（content 暂不可达）——同键重试只补确认，不会重复保存或重复建条目', raw_status: 503 } };
        }
      } else {
        this.media.releaseOperationPins(opKey); // 回执无 id=无权威关系可确认
      }
      return { ok: true, output: { asset_id: asset.id, mime_type: mime, byte_size: asset.byte_size, creation_id: creationId, saved: true, preview_ref: `/api/v1/assets/${asset.id}/preview`, deliver_hint: '发送到当前聊天用 chat_send_attachment（presentation=work，隔离预览交付）' } };
    } catch (err) {
      this.media.releaseOperationPins(opKey);
      return { ok: false, output: { error_code: 'CREATION_ENTRY_PENDING', detail: `资产已保存，但内容服务不可达（${String((err as Error).message).slice(0, 80)}）——用同一 client_operation_id 重试只补条目` } };
    }
  }

  private async saveStaticSvgPhoto(asset: StoredAsset, operationId: string, ctx: ToolExecContext): Promise<ToolExecResult | null> {
    const output = { asset_id: asset.id, asset_ref: `est:${asset.id}`, mime_type: asset.mime_type, byte_size: asset.byte_size };
    if (!this.contentClient) return { ok: true, output: { ...output, saved: true, note: '内容服务未配置，原 SVG 已作为资产保存，尚未入册。' } };
    if (this.media!.masterStoreConfigured && (asset.m_sync_state !== 'synced' || !this.media!.canProvideImage(asset))) {
      return { ok: false, output: { ...output, error_code: 'CREATION_MASTER_PENDING', detail: 'SVG 原件或 PNG 视图仍待落正，尚未建立相册关系。请用原操作标识重试。' } };
    }
    try {
      // An already committed legacy work stays reachable by its original relationship.
      const old = await resolveContentOperation(this.contentClient, {
        method: 'POST', actor: 'jiaming', path: '/api/v1/content/creations',
        body: { work_asset_id: asset.id, work_kind: 'svg' }, idempotencyKey: `tool-creation-entry:${operationId}`,
      });
      if (old.outcome === 'replay' && (old.status === 200 || old.status === 201)) return null;
      if (old.outcome !== 'new') return { ok: false, output: { ...output, error_code: 'CREATION_ENTRY_PENDING', detail: '未能按原标识确认旧作品关系。' } };
      if (!this.contentOps) return { ok: false, output: { ...output, error_code: 'INTEGRATION_UNCONFIGURED', detail: '相册协调器未装配，原件已保存。' } };
      const result = await this.contentOps.writeForModel({
        roomId: ctx.roomId, turnId: ctx.turnId, path: '/api/v1/content/albums/important_photos/entries',
        body: { asset_id: asset.id, content_sha256: asset.content_sha256, refs: [{ service: 'est', kind: 'generated_image', source_id: asset.id }] },
        idempotencyKey: `static-svg:${operationId}`,
      });
      if (result.status !== 200 && result.status !== 201) return modelWriteFailure(result, operationId, 'CREATION_ENTRY');
      const id = (result.body as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !id) return { ok: false, output: { ...output, error_code: 'CREATION_ENTRY_PENDING', detail: '相册关系回执待确认。请用原操作标识重试。' } };
      return { ok: true, output: { ...output, saved: true, album_entry_id: id, deliver_hint: '查看用 media_view；发送用 chat_send_attachment，presentation=image。' } };
    } catch {
      return { ok: false, output: { ...output, error_code: 'CREATION_ENTRY_PENDING', detail: '相册关系待确认。请用原操作标识重试。' } };
    }
  }
}

function postBodyCursor(id: string, revision: number, offset: number): string {
  return POST_BODY_CURSOR_PREFIX + Buffer.from(JSON.stringify([id, revision, offset])).toString('base64url');
}

function decodePostBodyCursor(cursor: string): { id: string; revision: number; offset: number } | null {
  if (cursor.length > 1024) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor.slice(POST_BODY_CURSOR_PREFIX.length), 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 3) return null;
    const [id, revision, offset] = decoded;
    if (typeof id !== 'string' || !id || id.length > 128
        || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(offset) || offset < 0) return null;
    return { id, revision, offset };
  } catch { return null; }
}

function projectPostPreview(post: PostListItem): PostListItem {
  // Also cap the response from a Content process that predates body_preview.
  const body = typeof post.body === 'string' ? [...post.body].slice(0, CONTENT_POST_PREVIEW_CHARS).join('') : post.body;
  if (post.body_truncated || body !== post.body) {
    return { ...post, body, body_truncated: true, body_cursor: postBodyCursor(post.id, post.revision, 0) };
  }
  return post;
}

function postResultBytes(output: Record<string, unknown>): number {
  // The provider request carries compact tool JSON as a JSON-encoded string.
  return Buffer.byteLength(JSON.stringify(JSON.stringify(output)));
}

function postsReadFailed(detail: string): ToolExecResult {
  return { ok: false, output: { error_code: 'CONTENT_POSTS_READ_FAILED', detail } };
}

function postsBudgetLimited(cursor?: string): ToolExecResult {
  return { ok: false, output: { error_code: 'CONTENT_POSTS_RESULT_BUDGET', retry_cursor: cursor ?? null,
    detail: '当前请求余量不足以交付这一页。请在有更多上下文余量的回合沿用原游标读取。' } };
}

function modelWriteFailure(
  result: { status: number; body: unknown },
  operationKey: string,
  codePrefix: string,
  failureCode = `${codePrefix}_FAILED`,
): ToolExecResult {
  const code = (result.body as { error?: { code?: string } } | null)?.error?.code;
  if (code === 'content_write_confirmation_pending') {
    return { ok: false, output: {
      error_code: `${codePrefix}_CONFIRMATION_PENDING`, commit_status: 'committed',
      idempotency_key: operationKey, retryable: true,
      detail: '提交已成功，回执待核。可以在下一回合用回执中的 idempotency_key 和原参数核回。',
    } };
  }
  if (code === 'content_write_unknown') {
    return { ok: false, output: {
      error_code: `${codePrefix}_UNKNOWN`, commit_status: 'unknown',
      idempotency_key: operationKey, retryable: true,
      detail: '操作已受理，结果待核。可以在下一回合用回执中的 idempotency_key 和原参数核回。',
    } };
  }
  if (code === 'idempotency_conflict' || code === 'content_operation_conflict') {
    return { ok: false, output: {
      error_code: 'IDEMPOTENCY_CONFLICT', idempotency_key: operationKey,
      detail: '同一幂等键已对应另一组参数。使用原参数可核回，独立的新操作使用新键。',
    } };
  }
  if (code === 'content_legacy_key_ambiguous' || code === 'legacy_receipt_unresolved') {
    return { ok: false, output: {
      error_code: 'CONTENT_OPERATION_IDENTITY_UNCONFIRMED', idempotency_key: operationKey,
      detail: '无法唯一确认该业务键对应的历史操作。请先核对已有对象。',
    } };
  }
  return { ok: false, output: { error_code: failureCode, detail: JSON.stringify(result.body).slice(0, 300) } };
}
