// 相册重构 P4（GLM_ALBUM_REFACTOR_EXECUTION 20261108，03 §2.1/§3.1）：人类存档入口。
// 提交真实选区（message_id 集合，服务端校验已发布/版本/会话归属，不收正文）；kind 由
// 明确操作确定。争吵存档先停当前回合（复用 supervisor.stop 链——输出与随路播放随停），
// 停止与建档是两个独立结果，分别如实返回：停止成功+建档失败≠存档成功（03 §3.1）。
// 模型侧同能力走 conversation_archive 工具（同一 ArchiveService），不经本路由。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { contentForward } from '../../integrations/content/client.ts';
import type { RequestDeps } from '../http.ts';
import type { ArchiveService, ArchiveKind } from '../../modules/archives/service.ts';

export async function handleArchivesRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string, url: URL): Promise<void> {
  if (!d.archives || !d.contentClient) return json(res, 503, { error: { code: 'archives_unavailable', message: '存档服务未启用（内容服务未装配）' } });
  const conversationId = String(url.searchParams.get('conversation_id') ?? 'primary');

  const createRoute = route === 'POST /api/v1/archives';
  if (createRoute && req.method === 'POST') {
    let body: Record<string, unknown>;
    try { body = (await readJson(req, d)) as Record<string, unknown>; } catch { body = {}; }
    const kind: ArchiveKind | null = body.kind === 'quarrel' || body.kind === 'sweet' ? body.kind : null;
    if (!kind) return json(res, 422, { error: { code: 'kind_invalid', message: 'kind 必须是 quarrel|sweet' } });
    const rawIds = Array.isArray(body.message_ids) ? (body.message_ids as unknown[]).filter((x): x is string => typeof x === 'string') : null;
    if (!rawIds || rawIds.length === 0) return json(res, 422, { error: { code: 'selection_required', message: '必须给出要存档的消息集合（前端提交真实选区，不接受整段默认）' } });
    const note = typeof body.note === 'string' && body.note.trim().length > 0 ? body.note.slice(0, 2000) : null;
    // 争吵：停止意图在点击时生效（03 §3.1）——先停当前输出/排队回合（不挂通话、不动其他会话），
    // 停止结果与建档结果分开返回；已发布部分留存，未发布草稿不补造。
    let stopped: { stoppedTurnId: string } | null = null;
    if (kind === 'quarrel' && d.supervisor) stopped = d.supervisor.stopActiveForConversation(conversationId);
    const idem = typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'] ? req.headers['idempotency-key'] : `http-archive:${conversationId}:${Date.now()}`;
    const r = await d.archives.createArchive({
      conversationId, kind, rawRefs: rawIds.map((id) => ({ message_id: id })), note,
      actor: 'qiaosheng', notifyModel: 'event', idempotencyKey: idem,
    });
    if (!r.ok) {
      // 停止成功但建档失败：双状态如实（输出已停，存档未完成；原键可重试，停止不重复执行）
      return json(res, r.code === 'CONTENT_UNREACHABLE' ? 503 : 422, {
        error: { code: r.code.toLowerCase(), message: r.detail },
        ...(stopped ? { stopped: true, stopped_turn_id: stopped.stoppedTurnId, stopped_message: '输出已停止，存档未完成——可原键重试存档' } : {}),
      });
    }
    return json(res, 201, { archived: true, archive_id: r.archive.id, kind: r.archive.kind, message_count: r.archive.count, stopped: stopped !== null, ...(stopped ? { stopped_turn_id: stopped.stoppedTurnId } : {}) });
  }

  const listRoute = route === 'GET /api/v1/archives';
  if (listRoute) {
    const kind = url.searchParams.get('kind');
    const fwd = await contentForward(d.contentClient, { method: 'GET', actor: 'qiaosheng', path: `/api/v1/content/archives?${kind ? `kind=${encodeURIComponent(kind)}&` : ''}conversation_id=${encodeURIComponent(conversationId)}&limit=50` });
    return json(res, fwd.status, fwd.body);
  }
  const detail = /^GET \/api\/v1\/archives\/([^/]+)$/.exec(route);
  if (detail) {
    const fwd = await contentForward(d.contentClient, { method: 'GET', actor: 'qiaosheng', path: `/api/v1/content/archives/${encodeURIComponent(detail[1]!)}` });
    return json(res, fwd.status, fwd.body);
  }
  // R6 存档打开链（R35）：存档卡片展开选中的原文（固定版本正文，只读）。
  const originals = /^GET \/api\/v1\/archives\/([^/]+)\/messages$/.exec(route);
  if (originals) {
    const r = await d.archives.archiveOriginals(conversationId, decodeURIComponent(originals[1]!));
    if (!r.ok) return json(res, r.code === 'CONTENT_UNREACHABLE' ? 503 : 404, { error: { code: r.code.toLowerCase(), message: r.detail } });
    return json(res, 200, r);
  }
  const remove = /^DELETE \/api\/v1\/archives\/([^/]+)$/.exec(route);
  if (remove && req.method === 'DELETE') {
    // 删除走宿主派生 actor + 统一回执；If-Match 透传
    const ifMatch = typeof req.headers['if-match'] === 'string' ? req.headers['if-match'] : undefined;
    const fwd = await contentForward(d.contentClient, { method: 'DELETE', actor: 'qiaosheng', path: `/api/v1/content/archives/${encodeURIComponent(remove[1]!)}`, headers: { 'idempotency-key': `http-archive-del:${remove[1]}`, ...(ifMatch ? { 'if-match': ifMatch } : {}) } });
    // RR3：删除成功→撤销 M 侧存档标记投影（尽力而为，幂等 op 键；latest-wins）
    if (fwd.status === 200) void d.archives.revokeArchiveObservations(conversationId, remove[1]!).catch(() => undefined);
    return json(res, fwd.status, fwd.body);
  }
  return json(res, 404, { error: { code: 'not_found', message: `未知路由：${route}` } });
}
