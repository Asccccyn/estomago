// server/routes/conversations.ts（P07.2 第四批）：会话/消息/同轮浮现视图路由组（memory/context 面）。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序（外层 est 认证+mutating Origin 门已过）/
// 响应与错误码逐字保持。HTTP 用户面与模型 tool_call 面身份语义区分不变（P07.3）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson, estimateContextFor } from '../http-leaf.ts';
import { readSnapshot } from '../../db/connection.ts';
import { MessageRetryService, MessageRetryError } from '../../messages/retry.ts';
import { shanghaiDayRange } from '../calendar-routes.ts';
import { conversationSnapshot } from '../snapshot.ts';
import { snapshotFor } from '../../usage/estimator.ts';
import { MediaError } from '../../media/assets.ts';
import type { SubmitMessageRequest, MessagePageDto } from '../../../../../packages/contracts/src/api.ts';
import type { RequestDeps } from '../http.ts';

/** 会话组：浮现详情视图（owner 只读）/会话列表/消息分页/单条/编辑/重试/发送/恢复快照。 */
export async function handleConversationRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string, url: URL): Promise<void> {
// Owner-authenticated detail view; never a model request or new retrieval.
const surfaceView = /^GET \/api\/v1\/conversations\/([^/]+)\/turns\/([^/]+)\/memories(?:\/([^/]+))?$/.exec(route);
if (surfaceView) {
  const conversationId = decodeURIComponent(surfaceView[1]!);
  const turnId = decodeURIComponent(surfaceView[2]!);
  if (!d.db.prepare('SELECT 1 FROM turns WHERE id=? AND conversation_id=?').get(turnId, conversationId))
    return json(res, 404, { error: { code: 'not_found' } });
  res.setHeader('Cache-Control', 'no-store');
  if (!surfaceView[3]) return json(res, 200, { items: d.surfacing?.visibleMemoriesForTurn(conversationId, turnId) ?? [] });
  if (!d.surfacing) return json(res, 503, { error: { code: 'SURFACE_UNAVAILABLE' } });
  const section = url.searchParams.get('section') || 'memory';
  if (!['memory','relations','source'].includes(section)) return json(res, 400, { error: { code: 'INVALID_SECTION' } });
  const result = await d.surfacing.readMemoryForTurn(conversationId, turnId,
    decodeURIComponent(surfaceView[3]), url.searchParams.get('cursor') || undefined, section as 'memory' | 'relations' | 'source');
  return result.ok ? json(res, 200, result.data) : json(res, result.code === 'DETAIL_REF_NOT_SEEN' ? 404 : 422, { error: { code: result.code, message: result.message } });
}

if (route === 'GET /api/v1/conversations') {
  const rows = d.db.prepare('SELECT id, scope, title, created_at FROM conversations ORDER BY created_at').all();
  return json(res, 200, { conversations: rows });
}

const convMsgs = /^GET \/api\/v1\/conversations\/([^/]+)\/messages$/.exec(route);
if (convMsgs) {
  const conversationId = decodeURIComponent(convMsgs[1]!);
  const limit = Number(url.searchParams.get('limit') ?? '100');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) return json(res, 400, { error: { code: 'limit_invalid', message: 'limit 必须是 1..1000 的整数' } });
  const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
  const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined;
  if ([before, after].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0))) return json(res, 400, { error: { code: 'cursor_invalid', message: 'before / after 必须是非负整数序号' } });
  const latest = url.searchParams.get('order') === 'latest';
  const date = url.searchParams.get('date');
  const range = date === null ? null : shanghaiDayRange(date);
  if (date !== null && !range) return json(res, 400, { error: { code: 'bad_date', message: 'date 必须是有效的 YYYY-MM-DD 日期（北京时间）' } });
  if (Number(before !== undefined) + Number(after !== undefined) + Number(date !== null) + Number(latest) > 1) return json(res, 400, { error: { code: 'history_query_conflict', message: 'before、after、date、order=latest 只能选一种定位方式' } });
  const snapshot = url.searchParams.get('snapshot') === '1';
  // No await/write occurs inside this transaction: message revisions, retry
  // state, active turns, route gate and event watermark are one read view.
  const page = readSnapshot(d.db, (): MessagePageDto => {
    const result = d.messages.listMessagePage({ conversationId, beforeSequence: before, afterSequence: after, limit, latest, ...(date !== null && range ? { dateRange: { date, ...range } } : {}) });
    result.messages = new MessageRetryService(d.db, d.messages, d.config.runtime.provider).decorate(result.messages);
    if (snapshot) {
      result.active_turns = d.db.prepare(`
        SELECT t.id AS turn_id, t.state,
          (SELECT a.id FROM attempts a WHERE a.turn_id=t.id ORDER BY a.attempt_no DESC LIMIT 1) AS attempt_id
        FROM turns t WHERE t.conversation_id=? AND t.state IN ('pending','running','route_owner_pending') ORDER BY t.created_at,t.id
      `).all(conversationId) as NonNullable<MessagePageDto['active_turns']>;
      const route = d.routing.pendingForConversation(conversationId);
      result.pending_route = route ? {
        decision_id: route.id, turn_id: route.turn_id, attempt_id: route.attempt_id,
        current_model: null, target_model: route.target_model, evidence_code: route.source_evidence,
        already_switched: false, affects_future_sessions: null,
      } : null;
      result.event_cursor = d.events.maxSequence();
    }
    return result;
  });
  return json(res, 200, page);
}

const getMsg = /^GET \/api\/v1\/conversations\/([^/]+)\/messages\/([^/]+)$/.exec(route);
if (getMsg) {
  const message = d.messages.getMessage(decodeURIComponent(getMsg[2]!));
  if (!message || message.conversation_id !== decodeURIComponent(getMsg[1]!)) return json(res, 404, { error: { code: 'not_found', message: '消息不存在或不属于该房间' } });
  return json(res, 200, { message: new MessageRetryService(d.db, d.messages, d.config.runtime.provider).decorate([message])[0] });
}

const retryMsg = /^POST \/api\/v1\/conversations\/([^/]+)\/messages\/([^/]+)\/retry$/.exec(route);
if (retryMsg) {
  const conversationId = decodeURIComponent(retryMsg[1]!);
  const messageId = decodeURIComponent(retryMsg[2]!);
  const body = await readJson(req, d) as { content?: unknown } | null;
  if (!body || typeof body.content !== 'string') return json(res, 400, { error: { code: 'bad_content', message: 'content 必须是字符串' } });
  const operationKey = String(req.headers['idempotency-key'] ?? '');
  if (!operationKey || operationKey.length > 200) return json(res, 400, { error: { code: 'missing_idempotency', message: '重试必须带有效的 Idempotency-Key' } });
  const ifMatch = /^(?:"([1-9]\d*)"|([1-9]\d*))$/.exec(String(req.headers['if-match'] ?? ''));
  const expectedRevision = Number(ifMatch?.[1] ?? ifMatch?.[2]);
  if (!ifMatch || !Number.isSafeInteger(expectedRevision)) return json(res, 428, { error: { code: 'precondition_required', message: '重试必须带 If-Match: "<revision>"，请刷新后重新编辑' } });
  try {
    const ec = estimateContextFor(d);
    const snapJson = JSON.stringify(snapshotFor({ model: ec.model, charsPerToken: ec.charsPerToken, content: body.content, attachments: [], outputCapTokens: ec.outputCap }, new Date().toISOString()));
    const result = new MessageRetryService(d.db, d.messages, d.config.runtime.provider).retry({ conversationId, messageId, content: body.content, expectedRevision, operationKey, tokenEstimateJson: snapJson });
    // Replaying a lost HTTP response may repair the commit→event/enqueue gap,
    // but never creates another attempt or re-executes a terminal attempt.
    const retryAttempt = d.db.prepare('SELECT state FROM attempts WHERE id=?').get(result.attempt_id) as { state: string };
    for (const kind of ['message.edited', 'turn.started']) {
      if (kind === 'turn.started' && !['pending', 'running'].includes(retryAttempt.state)) continue;
      if (!d.db.prepare('SELECT 1 FROM runtime_stream_events WHERE kind=? AND attempt_id=?').get(kind, result.attempt_id)) {
        d.events.publish(kind, { conversationId, turnId: result.turn_id, attemptId: result.attempt_id, entityRef: messageId, entityRevision: result.message.current_revision, scope: 'private', payload: kind === 'message.edited' ? { message: result.message } : {} });
      }
    }
    if (retryAttempt.state === 'pending') { d.scheduler?.notePendingUserChat(); d.supervisor.enqueue(result.turn_id); }
    void d.archiveSync?.drainOnce().catch(() => {});
    return json(res, result.duplicate ? 200 : 202, result);
  } catch (error) {
    if (error instanceof MessageRetryError) return json(res, error.status, { error: { code: error.code, message: error.message } });
    throw error;
  }
}

// R06（审计 FE-11）：权威恢复快照——同一读事务边界返回消息页+活动
// turn（attempts+generations）+活动窗+事件游标；SSE 史被裁剪/重启后
// 的恢复不依赖完整事件保留。GET 严格只读（零模型调用/零派发）。
const convSnap = /^GET \/api\/v1\/conversations\/([^/]+)\/snapshot$/.exec(route);
if (convSnap) {
  const conversationId = decodeURIComponent(convSnap[1]!);
  const limit = Math.min(500, Number(url.searchParams.get('limit') ?? '100') || 100);
  return json(res, 200, conversationSnapshot(d, conversationId, limit));
}

// F-J-08（联合审计 2026-10-06）：用户消息编辑修订——服务端能力（editUserMessage：
// 修订+supersedes+outbox 同事务）此前无 HTTP 入口，正常聊天内编辑不可达
const putMsg = /^PUT \/api\/v1\/conversations\/([^/]+)\/messages\/([^/]+)$/.exec(route);
if (putMsg) {
  const conversationId = decodeURIComponent(putMsg[1]!);
  const messageId = decodeURIComponent(putMsg[2]!);
  const body = (await readJson(req, d)) as Partial<{ content: string }>;
  if (typeof body.content !== 'string') return json(res, 400, { error: { code: 'bad_content', message: 'content 必须是字符串（多行正文整体提交）' } });
  const existing = d.messages.getMessage(messageId);
  if (!existing || existing.conversation_id !== conversationId) return json(res, 404, { error: { code: 'not_found', message: '消息不存在或不属于该房间' } });
  // EXEC_V1 §03.5.2（07 §5）：编辑加并发前置条件——缺 If-Match 返回 428 提示刷新（不自动套最新覆盖）
  const ifMatch = String(req.headers['if-match'] ?? '').replace(/"/g, '');
  if (!ifMatch || !/^\d+$/.test(ifMatch)) return json(res, 428, { error: { code: 'precondition_required', message: '编辑必须带 If-Match: "<revision>"（页面已更新，请刷新后重新编辑）' } });
  if (Number(ifMatch) !== existing.current_revision) return json(res, 409, { error: { code: 'revision_conflict', message: `修订不匹配：当前 ${existing.current_revision}，请求基于 ${ifMatch}` } });
  try {
    // EXEC_V1 §05.7.2：编辑=新 revision+新发送前快照（旧修订旧快照不动）
    const ec = estimateContextFor(d);
    const snapJson = JSON.stringify(snapshotFor({ model: ec.model, charsPerToken: ec.charsPerToken, content: body.content, attachments: [], outputCapTokens: ec.outputCap }, new Date().toISOString()));
    const message = new MessageRetryService(d.db, d.messages, d.config.runtime.provider).decorate([d.messages.editUserMessage(messageId, body.content, snapJson)])[0]!;
    // R16（复审 2026-10-07）：编辑有自己的接线——发布修订事件（SSE 可见，
    // 客户端按 ID/修订吸收）并触发现有归档（编辑已在同事务写 outbox；
    // 归档失败不撤销本地编辑，drain 自带重试/死信路径）
    d.events.publish('message.edited', { conversationId, entityRef: messageId, entityRevision: message.current_revision, scope: 'private', payload: { message } });
    d.archiveSync?.drainOnce().catch(() => { /* 归档失败走 drain 重试/死信；编辑不回滚 */ });
    return json(res, 200, { message, revision_of: messageId });
  } catch (err) {
    const msg = String((err as Error).message ?? '');
    if ((err as { code?: string }).code === 'MESSAGE_ALREADY_DISPATCHED') return json(res, 409, { error: { code: 'MESSAGE_ALREADY_DISPATCHED', message: msg } });
    if (msg.includes('仅空白')) return json(res, 422, { error: { code: 'blank_content', message: msg } });
    if (msg.includes('只有用户消息可编辑')) return json(res, 403, { error: { code: 'not_editable', message: msg } });
    if (msg.includes('message not found')) return json(res, 404, { error: { code: 'not_found', message: '消息不存在' } });
    throw err;
  }
}

const postMsgs = /^POST \/api\/v1\/conversations\/([^/]+)\/messages$/.exec(route);
if (postMsgs) {
  const conversationId = decodeURIComponent(postMsgs[1]!);
  const idempotencyKey = String(req.headers['idempotency-key'] ?? '');
  const body = (await readJson(req, d)) as Partial<SubmitMessageRequest>;
  const clientMessageId = body.client_message_id ?? idempotencyKey;
  if (!clientMessageId) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 client_message_id / Idempotency-Key' } });
  if (typeof body.content !== 'string') return json(res, 400, { error: { code: 'bad_content', message: 'content 必须是字符串（多行正文整体提交，不拆分）' } });
  // EXEC_V1 §03.5.2：附件先全量校验（存在/available/格式匹配 presentation），全过才进消息事务；
  // 不接受 URL/磁盘路径/Base64——必须先经 /api/v1/assets 建立资产
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  // AUD-33 P2：附件数量上限
  if (attachments.length > d.config.media.max_attachments_per_message) {
    return json(res, 422, { error: { code: 'too_many_attachments', message: `附件数量超过上限 ${d.config.media.max_attachments_per_message}` } });
  }
  const parsedAttachments: Array<{ asset_id: string; presentation: 'image' | 'sticker' | 'voice'; caption?: string | null }> = [];
  for (const a of attachments as Array<Record<string, unknown>>) {
    if (typeof a?.asset_id !== 'string' || !a.asset_id) return json(res, 400, { error: { code: 'bad_attachment', message: 'attachments[].asset_id 必填（先经资产创建/导入）' } });
    if (a.presentation !== 'image' && a.presentation !== 'sticker' && a.presentation !== 'voice') return json(res, 400, { error: { code: 'bad_attachment', message: 'attachments[].presentation 必须是 image|sticker|voice' } });
    parsedAttachments.push({ asset_id: a.asset_id, presentation: a.presentation, caption: typeof a.caption === 'string' ? a.caption : null });
  }
  if (d.media && parsedAttachments.length > 0) {
    try { d.media.validateForSend(parsedAttachments); }
    catch (err) {
      if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
      throw err;
    }
  }
  // D3（她批 2026-10-06）：首版单批准房间——凭空建房防护（房间必须
  // 已存在；归档 grant 也按 primary 钉死，第二房间同步本就会拒）
  const exists = d.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId);
  if (!exists) return json(res, 404, { error: { code: 'conversation_not_found', message: '房间不存在（首版仅批准房间）' } });
  let submitted;
  try {
    // EXEC_V1 §05.7.2：随 revision 保存发送前估计快照（估计刷新不影响 content_hash/修订号）
    const ec = estimateContextFor(d);
    const snapJson = JSON.stringify(snapshotFor({ model: ec.model, charsPerToken: ec.charsPerToken, content: body.content, attachments: [], outputCapTokens: ec.outputCap }, new Date().toISOString()));
    submitted = d.messages.submitUserMessageWithTurn({ conversationId, content: body.content, clientMessageId, occurredAt: body.occurred_at ?? null, attachments: parsedAttachments, tokenEstimateJson: snapJson });
  } catch (err) {
    if ((err as Error).message.includes('仅空白')) return json(res, 422, { error: { code: 'blank_content', message: (err as Error).message } });
    if ((err as Error).message.includes('INVALID_OCCURRED_AT')) return json(res, 422, { error: { code: 'invalid_occurred_at', message: (err as Error).message } });
    throw err;
  }
  // F12：无论 duplicate 与否，都确保事件已发 + 入队（duplicate 的 turn 可能因事件失败而 pending）
  const message = d.messages.getMessage(submitted.message.id)!;
  const eventExists = d.db.prepare('SELECT COUNT(*) n FROM runtime_stream_events WHERE kind = ? AND turn_id = ?').get('message.persisted', submitted.turnId) as { n: number };
  if (eventExists.n === 0) {
    d.events.publish('message.persisted', { conversationId, turnId: submitted.turnId, entityRef: message.id, entityRevision: message.sequence, payload: { message } });
  }
  // EXEC_V1 §04.7.1（WP4）：用户消息入库即请求取消可取消背景步骤（聊天优先——不排在用户前面）
  d.scheduler?.notePendingUserChat();
  const startedExists = d.db.prepare('SELECT COUNT(*) n FROM runtime_stream_events WHERE kind = ? AND turn_id = ?').get('turn.started', submitted.turnId) as { n: number };
  if (startedExists.n === 0) {
    d.events.publish('turn.started', { conversationId, turnId: submitted.turnId, attemptId: submitted.attemptId, payload: {} });
  }
  // F12：duplicate 但任一事件缺失（提交后事件写入失败）→ 补事件并重新入队，turn 不得滞留 pending
  if (!submitted.duplicate || submitted.repaired || eventExists.n === 0 || startedExists.n === 0) {
    d.supervisor.enqueue(submitted.turnId);
  }
  // 原文线独立于模型线：提交即触发同步 drain（未启用时 no-op；失败不阻塞提交）
  void d.archiveSync?.drainOnce().catch(() => {});
  return json(res, submitted.duplicate ? 200 : 201, { message: submitted.message, duplicate: submitted.duplicate, turn_id: submitted.turnId, repaired: submitted.repaired });
}
}
