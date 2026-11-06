// modules/content/service.ts（P04.7）：content 域工具用例（发帖/评论/列表/小作品）。
// actor 从受控执行上下文派生为 jiaming；HTTP 与工具共用同一协调器实例（P1·F06/F07
// 20261106）：同操作回查、意图+pin、提交、权威快照确认与恢复对浏览器/模型一致。
// 创作小作品不执行代码（SVG 脚本拒绝）。
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';

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
    // 模型发帖与浏览器入口同一协调面：资产前置保护、意图持久、回放与确认一致。
    const r = await this.contentOps.write({ method: 'POST', path: '/api/v1/content/posts', actor: 'jiaming',
      body: { presentation: args.presentation ?? 'post', title: args.title, body: args.body, asset_ids: args.asset_ids ?? [] },
      headers: { 'idempotency-key': `tool:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${args.idempotency_key}` },
    });
    if (r.status === 201 || r.status === 200) return { ok: true, output: r.body as Record<string, unknown> };
    return { ok: false, output: { error_code: 'CONTENT_POST_FAILED', detail: JSON.stringify(r.body).slice(0, 300) } };
  }


  async contentCommentCreate(args: { post_id: string; body: string; idempotency_key: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient || !this.contentOps) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    // 评论无资产（无伪 pin），但操作身份/回放与浏览器写一致——不绕过回执规则。
    const r = await this.contentOps.write({ method: 'POST', path: `/api/v1/content/posts/${encodeURIComponent(args.post_id)}/comments`, actor: 'jiaming',
      body: { body: args.body },
      headers: { 'idempotency-key': `tool:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${args.idempotency_key}` },
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
