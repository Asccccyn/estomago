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
    // RF02（复审 20261106）：业务幂等键绑定稳定主体（turn+模型显式 key），不含
    // provider requestId/attempt——模型续轮重试复用原操作，不因换请求换身份重复发帖。
    const r = await this.contentOps.write({ method: 'POST', path: '/api/v1/content/posts', actor: 'jiaming',
      body: { presentation: args.presentation ?? 'post', title: args.title, body: args.body, asset_ids: args.asset_ids ?? [] },
      headers: { 'idempotency-key': `tool:${ctx.turnId ?? 'noturn'}:${args.idempotency_key}` },
    });
    if (r.status === 201 || r.status === 200) return { ok: true, output: r.body as Record<string, unknown> };
    if (isUnknownOutcome(r)) return unknownToolResult('CONTENT_POST_UNKNOWN', r);
    return { ok: false, output: { error_code: 'CONTENT_POST_FAILED', detail: JSON.stringify(r.body).slice(0, 300) } };
  }


  async contentCommentCreate(args: { post_id: string; body: string; idempotency_key: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient || !this.contentOps) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    // 评论无资产（无伪 pin），但操作身份/回放与浏览器写一致——不绕过回执规则。
    // RF02：业务键不含 provider requestId（见 contentPostCreate）。
    const r = await this.contentOps.write({ method: 'POST', path: `/api/v1/content/posts/${encodeURIComponent(args.post_id)}/comments`, actor: 'jiaming',
      body: { body: args.body },
      headers: { 'idempotency-key': `tool:${ctx.turnId ?? 'noturn'}:${args.idempotency_key}` },
    });
    if (r.status === 201 || r.status === 200) return { ok: true, output: r.body as Record<string, unknown> };
    if (isUnknownOutcome(r)) return unknownToolResult('CONTENT_COMMENT_UNKNOWN', r);
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
    const { contentForward } = await import('../../integrations/content/client.ts');
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

  /** R5（复审 2026-11-08）：相册写工具——与浏览器写同一协调面（回执/回放/未知收口）。
   *  幂等键绑定 turn+模型显式 key（RF02 同款，不含 provider requestId）。 */
  async contentAlbumEntryWrite(args: { kind: string; asset_id: string; caption?: string; meaning?: string; carry_mode?: string; idempotency_key: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient || !this.contentOps) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '内容服务未启用' } };
    // RR2：补注 M 对象身份（同字节别名在 content 限额/携带集按原图归并）；资产缺席如实不带
    let sha256: string | null = null;
    try { sha256 = this.media?.getAsset(args.asset_id).content_sha256 ?? null; } catch { sha256 = null; }
    const r = await this.contentOps.write({ method: 'POST', path: `/api/v1/content/albums/${encodeURIComponent(args.kind)}/entries`, actor: 'jiaming',
      body: { asset_id: args.asset_id, caption: args.caption, meaning: args.meaning, ...(sha256 ? { content_sha256: sha256 } : {}), ...(args.carry_mode ? { carry_mode: args.carry_mode } : {}) },
      headers: { 'idempotency-key': `tool:${ctx.turnId ?? 'noturn'}:${args.idempotency_key}` },
    });
    if (r.status === 201 || r.status === 200) return { ok: true, output: r.body as Record<string, unknown> };
    if (isUnknownOutcome(r)) return unknownToolResult('ALBUM_ENTRY_UNKNOWN', r);
    return { ok: false, output: { error_code: 'ALBUM_ENTRY_WRITE_FAILED', detail: JSON.stringify(r.body).slice(0, 300) } };
  }

  async creationSaveArtifact(args: { format: 'svg' | 'html'; content: string; client_operation_id: string }, _ctx: ToolExecContext): Promise<ToolExecResult> {
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
      asset = await this.media.saveBuffer({ bytes: Buffer.from(args.content, 'utf8'), purpose: args.format === 'svg' ? 'creation_icon' : 'creation_work', operationId: opKey, createdBy: 'jiaming', origin: 'generated' });
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
    const { contentForward } = await import('../../integrations/content/client.ts');
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
}


/** RF02（复审 20261106）：未知结果 ≠ 确定失败——协调器已持久意图，将以原身份收口。
 *  以普通失败文案回给模型会诱导换新身份重做（实际已提交→重复发帖）。 */
function isUnknownOutcome(r: { status: number; body: unknown }): boolean {
  const code = (r.body as { error?: { code?: string } } | null)?.error?.code;
  return r.status === 504 && code === 'content_write_unknown';
}
function unknownToolResult(errorCode: string, r: { status: number; body: unknown }): ToolExecResult {
  return { ok: false, output: { error_code: errorCode, detail: '提交结果未知：操作已持久，将以原身份恢复收口；用同一 idempotency_key 重试安全，勿换新键重做。', raw_status: r.status } };
}
