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
    const { contentForward } = await import('../../integrations/content/client.ts');
    const r = await contentForward(this.contentClient, {
      method: 'POST', path: '/api/v1/content/posts', actor: 'jiaming',
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
