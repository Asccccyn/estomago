// modules/content/service.ts（P04.7）：content 域工具用例（发帖/评论/列表/小作品）。
// 原 HostToolExecutor 方法逐字迁移：actor 从受控执行上下文派生为 jiaming；HTTP 与工具共用
// 原 contentForward 领域面；创作小作品不执行代码（SVG 脚本拒绝）。
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';

export class ContentToolsService {
  private readonly contentClient: import('../../integrations/content/client.ts').ContentClient | null;
  private readonly media: import('../../media/assets.ts').MediaService | null;

  constructor(deps: { contentClient?: import('../../integrations/content/client.ts').ContentClient | null; media?: import('../../media/assets.ts').MediaService | null }) {
    this.contentClient = deps.contentClient ?? null;
    this.media = deps.media ?? null;
  }

  async contentPostCreate(args: { presentation?: string; title?: string; body: string; asset_ids?: string[]; idempotency_key: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '内容服务未启用' } };
    // F06（四仓审计 20261104）：模型发帖改走资产代理面——与浏览器入口同一验证+引用登记
    // （旧实现直连 contentForward，帖子引用的资产不进删除守卫，仍被使用的图可被标删）。
    const { contentProxyWithAssets } = await import('../../integrations/content/client.ts');
    const r = await contentProxyWithAssets({ client: this.contentClient, media: this.media, db: null as never, method: 'POST', path: '/api/v1/content/posts', actor: 'jiaming',
      body: { presentation: args.presentation ?? 'post', title: args.title, body: args.body, asset_ids: args.asset_ids ?? [] },
      headers: { 'Idempotency-Key': `tool:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${args.idempotency_key}` },
    });
    if (r.status === 201 || r.status === 200) return { ok: true, output: r.body as Record<string, unknown> };
    return { ok: false, output: { error_code: 'CONTENT_POST_FAILED', detail: JSON.stringify(r.body).slice(0, 300) } };
  }


  async contentCommentCreate(args: { post_id: string; body: string; idempotency_key: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    const { contentForward } = await import('../../integrations/content/client.ts');
    const r = await contentForward(this.contentClient, {
      method: 'POST', path: `/api/v1/content/posts/${encodeURIComponent(args.post_id)}/comments`, actor: 'jiaming',
      body: { body: args.body },
      headers: { 'Idempotency-Key': `tool:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${args.idempotency_key}` },
    });
    if (r.status === 201 || r.status === 200) return { ok: true, output: r.body as Record<string, unknown> };
    return { ok: false, output: { error_code: 'CONTENT_COMMENT_FAILED', detail: JSON.stringify(r.body).slice(0, 300) } };
  }


  async contentPostsList(args: { cursor?: string; limit?: number; presentation?: string }, _ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    const { contentForward } = await import('../../integrations/content/client.ts');
    const params = new URLSearchParams();
    if (args.cursor) params.set('cursor', args.cursor);
    if (args.limit && args.limit > 0 && args.limit <= 100) params.set('limit', String(args.limit));
    if (args.presentation) params.set('presentation', args.presentation);
    const r = await contentForward(this.contentClient, { method: 'GET', path: `/api/v1/content/posts?${params}`, actor: 'jiaming' });
    return { ok: r.status === 200, output: r.body as Record<string, unknown> };
  }


  async contentAlbumsRead(args: Record<string, unknown>, _ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient) return {ok:false,output:{error_code:'INTEGRATION_UNCONFIGURED',detail:'相册服务未装配'}};
    const { contentForward } = await import('../../integrations/content/client.ts');
    const params = new URLSearchParams();
    for (const key of ['cursor','limit','q','source_service','source_kind','source_id']) if (args[key] !== undefined) params.set(key,String(args[key]));
    const endpoint = args.album ? `/albums/${encodeURIComponent(String(args.album))}/entries?${params}` : '/albums';
    const response = await contentForward(this.contentClient,{method:'GET',actor:'jiaming',path:'/api/v1/content'+endpoint});
    if (response.status !== 200) return {ok:false,output:{error_code:'ALBUM_READ_FAILED',detail:JSON.stringify(response.body)}};
    const body = response.body as {albums?: unknown[];items?: Array<Record<string,unknown>>;next_cursor?:string|null;has_more?:boolean};
    if (!args.album) return {ok:true,output:{albums:body.albums ?? []}};
    return {ok:true,output:{items:(body.items ?? []).map(item=>({id:item.id,asset_ref:`est:${item.asset_id}`,caption:item.caption,meaning:item.meaning,created_at:item.created_at})),next_cursor:body.next_cursor,has_more:body.has_more}};
  }

  async creationSaveArtifact(args: { format: 'svg' | 'html'; content: string; client_operation_id: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.media) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    const mime = args.format === 'svg' ? 'image/svg+xml' : 'text/html';
    // 内容安全检查：SVG 不允许 <script>；HTML 允许内联脚本（在沙箱 iframe 内执行——宿主不执行）
    if (args.format === 'svg' && /<script/i.test(args.content)) {
      return { ok: false, output: { error_code: 'SVG_SCRIPT_FORBIDDEN', detail: 'SVG 图标不允许内嵌脚本（HTML 作品请用 format=html 走沙箱预览）' } };
    }
    const opKey = `tool-creation:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${args.client_operation_id}`;
    try {
      const a = await this.media.saveBuffer({ bytes: Buffer.from(args.content, 'utf8'), purpose: args.format === 'svg' ? 'creation_icon' : 'creation_work', operationId: opKey, createdBy: 'jiaming', origin: 'generated' });
      return { ok: true, output: { asset_id: a.id, mime_type: mime, byte_size: a.byte_size, saved: true } };
    } catch (err) {
      return { ok: false, output: { error_code: (err as { code?: string }).code ?? 'ASSET_TYPE_UNSUPPORTED', detail: String((err as Error).message).slice(0, 200) } };
    }
  }

}
