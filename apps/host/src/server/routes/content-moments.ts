import type { IncomingMessage } from 'node:http';
import { readHeartbeatProjection, type HeartbeatAction, type HeartbeatProjection, type HeartbeatSource } from '../../../../../packages/contracts/src/heartbeat.ts';
import { contentForward, resolveContentOperation, type ContentClient } from '../../integrations/content/client.ts';
import type { ContentWriteResult } from '../../integrations/content/coordinator.ts';
import { associateMomentEdit } from '../../integrations/content/moment-edit-outbox.ts';
import type { HeartbeatRuntime } from '../../modules/heartbeat/runtime.ts';
import type { SourceStatus } from '../../modules/heartbeat/sources.ts';
import { PRIMARY_CONVERSATION } from '../../messages/constants.ts';
import { sha256Hex } from '../../util/id.ts';
import { readJson } from '../http-leaf.ts';
import type { RequestDeps } from '../http.ts';

const ACTOR = 'qiaosheng' as const;

type ContentRow = {
  id: string;
  revision: number;
  author?: string | null;
  body?: string | null;
  asset_ids?: string[];
  kind?: string;
  deleted?: boolean;
  reference?: unknown;
  display_edits?: Record<string, { revision: number; editor: string }>;
};

type ResolvedBlock = {
  id: string;
  source_label: string;
  author?: string | null;
  status: SourceStatus | 'available';
  text?: string | null;
  asset_ids?: string[];
  observed_revision?: number;
  display_revision?: number;
  current_revision?: number;
  editor?: string;
  management_href?: string;
  editable: boolean;
};

type Deps = Pick<RequestDeps, 'contentClient' | 'contentOps' | 'messages' | 'db'> & {
  heartbeat?: Pick<HeartbeatRuntime, 'sources'> & {
    noteStatus?(id: string, conversationId: string, sourceDeleted?: boolean): ReturnType<HeartbeatRuntime['noteStatus']>;
  };
};

const sourceLabels: Partial<Record<HeartbeatSource['kind'], string>> = {
  wishstar: '许愿星', memory: '记忆', archive: '存档对话', album: '相册',
  moments: '日常', reserved_note: '预留留言',
};

const actionLabels: Record<HeartbeatAction['kind'], string> = {
  selection: '选号', star_reply: '回应原星', star_write: '写星', memory_hold: '写记忆', memory_update: '修订记忆', post: '发日常',
  comment: '发表评论', album: '收藏图片', creation: '保存作品', image: '生成图片', archive: '保存对话存档',
  wake: '设置自主唤醒', chat: '发送聊天消息',
};

function actionBlock(action: HeartbeatAction, index: number): ResolvedBlock {
  const label = action.kind === 'wake' && action.wakeOperation ? {
    schedule: '设置自主预约', update: '修改自主预约', cancel: '取消自主预约',
  }[action.wakeOperation] : actionLabels[action.kind];
  const verb = action.kind === 'selection' && action.cardNumber ? `选择 ${action.cardNumber} 号牌` : label;
  const phrase = {
    committed: action.kind === 'selection' ? '已选中' : '已完成',
    partial: '部分完成，仍有步骤待确认', failed: '未成功', cancelled: '已取消或未派发', unknown: '结果待核，暂不能确认成功',
  }[action.status];
  const revision = action.kind === 'memory_update' && action.status === 'committed' ? action.source?.revision : undefined;
  return { id: `action:${index}`, source_label: label, status: 'available', editable: false,
    text: `${verb} · ${phrase}${revision === undefined ? '' : `（v${revision}）`}。` };
}

const fail = (status: number, code: string, message: string, details: Record<string, unknown> = {}): ContentWriteResult =>
  ({ status, body: { error: { code, message }, ...details } });
const ok = (result: ContentWriteResult) => result.status >= 200 && result.status < 300;
const postPath = (id: string) => `/api/v1/content/posts/${encodeURIComponent(id)}`;
const projectionPath = (id: string) => `/internal/heartbeat-posts/${encodeURIComponent(id)}`;
const projectionInScope = (projection: HeartbeatProjection | null): projection is HeartbeatProjection =>
  projection?.conversationId === PRIMARY_CONVERSATION;
const writeKey = (key: string, stage: 'source' | 'projection') => `moment-ref-v1:${stage}:${sha256Hex(key)}`;
const referenceRoute = /^\/api\/v1\/content\/moment-references\/([a-zA-Z0-9_-]+)(?:\/blocks\/([^/]+))?$/;
const postRoute = /^\/api\/v1\/content\/posts(?:\/[a-zA-Z0-9_-]+)?$/;
const noteRoute = /^\/api\/v1\/content\/future-notes(?:\/[a-zA-Z0-9_-]+)?$/;

function sourcePath(source: HeartbeatSource): string | null {
  if (source.namespace !== 'content' || source.permissionScope !== PRIMARY_CONVERSATION || source.replay) return null;
  if (source.kind === 'moments') return postPath(source.id);
  if (source.kind === 'reserved_note') return `/api/v1/content/future-notes/${encodeURIComponent(source.id)}`;
  return null;
}

function contentStatus(result: Awaited<ReturnType<typeof contentForward>>): ResolvedBlock['status'] {
  if (result.status === 401 || result.status === 403) return 'forbidden';
  if (result.status === 410) return 'deleted';
  if (result.status === 404 && !result.bodyFailed) {
    const code = String((result.body as { error?: { code?: string } })?.error?.code ?? '').toLowerCase();
    return code === 'revision_unavailable' ? 'revision_unavailable' : 'deleted';
  }
  if (result.status !== 200 || result.bodyFailed) return 'unavailable';
  return (result.body as ContentRow)?.deleted ? 'deleted' : 'available';
}

async function readSource(client: ContentClient, path: string, signal: AbortSignal): Promise<
  { status: 'available'; row: ContentRow } | { status: SourceStatus }
> {
  try {
    const result = await contentForward(client, { method: 'GET', path, actor: ACTOR, signal });
    const status = contentStatus(result);
    if (status !== 'available') return { status };
    const row = result.body as ContentRow | null;
    if (!row || typeof row.id !== 'string' || !Number.isSafeInteger(row.revision)) return { status: 'unavailable' };
    return { status, row };
  } catch { return { status: 'unavailable' }; }
}

function canEditSource(row: ContentRow): boolean {
  return row.author === ACTOR && row.kind !== 'reference' && !row.deleted;
}

function noteResponse(value: unknown, deps: Deps): unknown {
  if (!value || typeof value !== 'object') return value;
  const row = value as Partial<ContentRow>;
  const status = typeof row.id === 'string'
    ? deps.heartbeat?.noteStatus?.(row.id, PRIMARY_CONVERSATION, row.deleted === true) : undefined;
  return status ? { ...row, ...status } : value;
}

export function decorateFutureNoteResponse(path: string, payload: unknown, deps: Deps): unknown {
  if (!noteRoute.test(path)) return payload;
  const page = payload as { items?: unknown[] } | null;
  return Array.isArray(page?.items)
    ? { ...page, items: page.items.map(item => noteResponse(item, deps)) }
    : noteResponse(payload, deps);
}

async function displayReference(row: ContentRow, deps: Deps, signal: AbortSignal): Promise<unknown> {
  // Only resolved, authorized blocks cross the browser boundary. The durable
  // projection remains a list of source identities and revisions.
  const { reference: raw, display_edits: edits, ...entry } = row;
  const projection = readHeartbeatProjection(raw);
  if (!projectionInScope(projection)) return null;
  const blocks: ResolvedBlock[] = [];
  let cardBlock: ResolvedBlock | undefined;
  if (projection.card) {
    const source = projection.card.source;
    const edit = edits?.card;
    const observed = typeof source.revision === 'number' ? source.revision : undefined;
    const editPath = sourcePath(source);
    const reserved = source.kind === 'reserved_note';
    const current = editPath && deps.contentClient ? await readSource(deps.contentClient, editPath, signal) : undefined;
    // A note's author manages it only on the heartbeat page. Read back that
    // source's current revision without changing the card's observed revision.
    const managed = reserved && current?.status === 'available' && current.row.id === source.id && canEditSource(current.row);
    const display = managed ? current.row.revision : Number.isSafeInteger(edit?.revision) ? edit!.revision : undefined;
    const base: ResolvedBlock = {
      id: 'card', source_label: `${projection.card.number} 号 · ${sourceLabels[source.kind] ?? '扩展来源'}`,
      status: 'unavailable', editable: false, observed_revision: observed,
      ...(display !== undefined ? { display_revision: display, editor: managed ? ACTOR : edit?.editor } : {}),
      ...(managed ? { management_href: `/home/heartbeat?note=${encodeURIComponent(source.id)}` } : {}),
    };
    const payload = await deps.heartbeat?.sources.resolve(display === undefined ? source : { ...source, revision: display },
      projection.conversationId, signal, ACTOR, 'history');
    const editable = !reserved && payload?.status === 'available' && current?.status === 'available' && canEditSource(current.row);
    const block: ResolvedBlock = {
      ...base, status: payload?.status ?? 'unavailable', editable,
      ...(current?.status === 'available' ? { author: current.row.author, current_revision: current.row.revision } : {}),
    };
    if (payload?.status === 'available') {
      block.text = payload.text;
      block.asset_ids = payload.assetIds;
    }
    cardBlock = block;
    if (!projection.actions) blocks.push(block);
  }
  const actions = projection.actions?.map((action, index) => ({ action, index })) ?? [];
  let nextAction = 0;
  const flushActions = (before: number) => {
    while (nextAction < actions.length && actions[nextAction]!.action.afterSequence < before) {
      const { action, index } = actions[nextAction++]!;
      blocks.push(actionBlock(action, index));
    }
  };
  let publishedDecline = false;
  for (const ref of projection.messages) {
    flushActions(ref.sequence);
    const message = deps.messages.getMessageAtRevision(projection.conversationId, ref.messageId, ref.revision);
    if (message?.speaker === 'system' && message.revision.content === '[心跳唤醒] 本轮未抽卡') publishedDecline = true;
    blocks.push({
      id: `message:${ref.messageId}`, source_label: message?.speaker === 'system' ? '心跳状态' : '本轮聊天', observed_revision: ref.revision,
      ...(message ? {
        status: 'available', author: message.speaker === 'assistant' ? 'jiaming' : message.speaker === 'owner' ? ACTOR : null,
        text: message.revision.content, asset_ids: message.revision.attachments.map(attachment => attachment.asset_id),
      } : { status: 'revision_unavailable' }),
      editable: false,
    });
    if (projection.actions && cardBlock && message?.heartbeat_card) {
      blocks.push(cardBlock);
      cardBlock = undefined;
    }
  }
  if (projection.actions && cardBlock) blocks.push(cardBlock);
  flushActions(Infinity);
  if (projection.terminal) {
    const terminal = projection.terminal;
    const end = terminal.status === 'declined' ? '本轮拒抽。' : terminal.status === 'unknown' ? '本轮结果有待核对。'
      : terminal.reason === 'budget' ? '本轮已达预算上限，未继续。'
      : terminal.reason === 'quote' ? '缺少可核实的工具报价，本轮未继续。'
      : terminal.reason === 'sleep' ? '本轮因睡眠时段结束。'
      : terminal.reason === 'yield' ? '本轮为新聊天让位。'
      : terminal.status === 'cancelled' ? '本轮已取消，已经发生的动作保留。'
      : terminal.status === 'failed' ? '本轮未能正常完成。'
      : projection.state === 'drawn_no_comment' ? '本轮结束，没有另发聊天留言。' : '本轮结束。';
    blocks.push({ id: 'outcome', source_label: '结束状态', status: 'available', editable: false, text: end });
  } else if ((projection.state === 'declined' && !publishedDecline) || projection.state === 'drawn_no_comment') {
    blocks.push({
      id: 'outcome', source_label: '[心跳唤醒]', status: 'available', editable: false,
      text: projection.state === 'declined' ? '本轮未抽卡。' : '本轮没有留言。',
    });
  }
  return { ...entry, blocks };
}

export async function decorateMomentResponse(url: URL, payload: unknown, deps: Deps): Promise<unknown> {
  if (!postRoute.test(url.pathname)) return payload;
  if (url.pathname === '/api/v1/content/posts' && url.searchParams.get('include_references') !== '1') return payload;
  const signal = AbortSignal.timeout(3000);
  const page = payload as { items?: ContentRow[] } | null;
  if (Array.isArray(page?.items)) {
    // Bound concurrent lookups for the expanded feed, including per-card owner
    // checks. Cursor remains the source list's cursor even if a row disappears.
    const items: unknown[] = [];
    for (let offset = 0; offset < page.items.length; offset += 6) {
      const batch = await Promise.all(page.items.slice(offset, offset + 6).map(row =>
        row?.kind === 'reference' ? displayReference(row, deps, signal) : row));
      items.push(...batch.filter(row => row != null));
    }
    return { ...page, items };
  }
  const row = payload as ContentRow | null;
  if (row?.kind !== 'reference') return payload;
  if (row.deleted) return row;
  return await displayReference(row, deps, signal);
}

function sourceUnavailable(status: SourceStatus): ContentWriteResult {
  const states = {
    deleted: [410, 'source_deleted', '对应来源已删除。'],
    forbidden: [403, 'source_forbidden', '当前没有访问这处来源的权限。'],
    revision_unavailable: [404, 'source_revision_unavailable', '对应来源修订不可读。'],
    unavailable: [503, 'source_unavailable', '对应来源暂时不可用。'],
  } as const;
  const [code, key, message] = states[status];
  return fail(code, key, message);
}

async function readProjection(client: ContentClient, id: string, signal: AbortSignal): Promise<
  { active: true; row: ContentRow; projection: HeartbeatProjection } | { active: false; result: ContentWriteResult }
> {
  const result = await readSource(client, postPath(id), signal);
  if (result.status !== 'available') return { active: false, result: sourceUnavailable(result.status) };
  const projection = readHeartbeatProjection(result.row.reference);
  if (result.row.kind !== 'reference' || !projectionInScope(projection)) {
    return { active: false, result: fail(404, 'reference_not_found', '没有找到这条朋友圈映射。') };
  }
  return { active: true, row: result.row, projection };
}

export async function handleMomentReference(
  req: IncomingMessage, url: URL, deps: Deps, headers: Record<string, string>,
): Promise<ContentWriteResult | null> {
  const route = referenceRoute.exec(url.pathname);
  if (!route) return null;
  const client = deps.contentClient;
  if (!client) return fail(503, 'content_unavailable', '内容服务暂不可用。');
  const id = route[1]!;
  let blockId: string | undefined;
  try { blockId = route[2] ? decodeURIComponent(route[2]) : undefined; }
  catch { return fail(400, 'source_block_invalid', '来源块地址无效。'); }
  const method = req.method;
  const key = headers['idempotency-key'];
  const expected = /^"?(\d+)"?$/.exec(headers['if-match'] ?? '')?.[1];
  const projectionRevision = expected === undefined ? null : Number(expected);
  const signal = AbortSignal.timeout(3500);
  if (method !== 'GET' && (!key || !Number.isSafeInteger(projectionRevision) || !projectionRevision)) {
    return fail(400, 'reference_precondition_required', '需要附上映射的 If-Match 和本次操作的 Idempotency-Key。');
  }
  if (method === 'DELETE' && !blockId) {
    const target = projectionPath(id);
    const projectedKey = writeKey(key!, 'projection');
    try {
      // Replays do not require the deleted relationship to become visible.
      const resolved = await resolveContentOperation(client, { actor: ACTOR, method, path: target, idempotencyKey: projectedKey, ifMatch: headers['if-match'] });
      if (resolved.outcome !== 'new') return { status: resolved.status, body: resolved.body };
      const ref = await readProjection(client, id, signal);
      if (!ref.active) return ref.result;
      const deleted = await contentForward(client, { method, actor: ACTOR, path: target,
        headers: { ...headers, 'idempotency-key': projectedKey }, signal });
      return deleted.bodyFailed ? fail(502, 'reference_delete_result_unknown', '移除结果待核。请用同一操作重试。')
        : { status: deleted.status, body: deleted.body };
    } catch { return fail(502, 'reference_delete_result_unknown', '移除结果待核。请用同一操作重试。'); }
  }

  const reference = await readProjection(client, id, signal);
  if (!reference.active) return reference.result;
  if (method === 'GET' && !blockId) return { status: 200, body: await displayReference(reference.row, deps, signal) };
  if (method === 'PUT' && !blockId) {
    const body = await readJson(req) as { title?: unknown } | null;
    if (typeof body?.title !== 'string' || body.title.length > 200) return fail(422, 'reference_title_invalid', '展示标题最多 200 字符。');
    try {
      const saved = await contentForward(client, { method, actor: ACTOR, path: projectionPath(id),
        headers: { ...headers, 'idempotency-key': writeKey(key!, 'projection') }, body: { title: body.title }, signal });
      return saved.bodyFailed ? fail(502, 'reference_edit_result_unknown', '标题保存结果待核。请用同一操作重试。')
        : { status: saved.status, body: saved.body };
    } catch { return fail(502, 'reference_edit_result_unknown', '标题保存结果待核。请用同一操作重试。'); }
  }

  const card = reference.projection.card?.source;
  if (blockId !== 'card' || !card) return fail(403, 'source_block_read_only', '这处来源没有可用的编辑入口。');
  const editPath = sourcePath(card);
  if (!editPath) return fail(403, 'source_block_read_only', '这处来源由原服务管理。');
  if (method === 'GET') {
    const observed = url.searchParams.get('revision');
    if (observed !== null && observed !== String(card.revision)) return fail(404, 'source_revision_unavailable', '对应来源修订不可读。');
    const source = await readSource(client, editPath + (observed === null ? '' : `?revision=${encodeURIComponent(observed)}`), signal);
    if (source.status !== 'available') return sourceUnavailable(source.status);
    if (source.row.id !== card.id || observed !== null && String(source.row.revision) !== observed) return sourceUnavailable('revision_unavailable');
    const body: ResolvedBlock = {
      id: 'card', source_label: sourceLabels[card.kind] ?? '扩展来源', status: 'available',
      text: source.row.body, asset_ids: source.row.asset_ids ?? [], author: source.row.author,
      current_revision: source.row.revision, editable: card.kind !== 'reserved_note' && observed === null && canEditSource(source.row),
      ...(card.kind === 'reserved_note' && canEditSource(source.row) ? { management_href: `/home/heartbeat?note=${encodeURIComponent(card.id)}` } : {}),
    };
    return { status: 200, body };
  }
  if (method !== 'PUT') return fail(405, 'reference_method_invalid', '该操作不可用。');
  if (card.kind === 'reserved_note') return fail(403, 'reserved_note_managed_in_heartbeat', '预留留言只在心跳页面管理。', { management_href: `/home/heartbeat?note=${encodeURIComponent(card.id)}` });
  if (!deps.contentOps) return fail(503, 'content_unavailable', '内容写入暂不可用。');
  const raw = await readJson(req) as { body?: unknown; asset_ids?: unknown; expected_source_revision?: unknown } | null;
  if (!raw || typeof raw.body !== 'string' || !Number.isSafeInteger(raw.expected_source_revision)
      || typeof raw.expected_source_revision !== 'number' || raw.expected_source_revision <= 0
      || (raw.asset_ids !== undefined && (!Array.isArray(raw.asset_ids) || !raw.asset_ids.every(value => typeof value === 'string' && value.length > 0)))) {
    return fail(422, 'invalid_source_edit', '需要正文、有效的源修订号，以及合法的附件列表。');
  }

  const current = await readSource(client, editPath, signal);
  if (current.status !== 'available') return sourceUnavailable(current.status);
  if (current.row.id !== card.id || !canEditSource(current.row)) return fail(403, 'source_block_read_only', '只能编辑自己的来源原文。');
  const expectedSource = raw.expected_source_revision;
  const updatedSource = expectedSource + 1; // Both supported Content owners increment this CAS by one.
  const sourceIfMatch = `"${expectedSource}"`;
  const target = projectionPath(id) + '/blocks/card';
  const sourceKey = writeKey(key!, 'source');
  const projectedKey = writeKey(key!, 'projection');
  const payload = {
    body: raw.body,
    ...(raw.asset_ids === undefined ? {} : { asset_ids: raw.asset_ids }),
    _moment_ref: { post_id: id, projection_revision: projectionRevision, block_id: 'card' },
  };
  const displayPayload = { display_revision: updatedSource };
  let state: Awaited<ReturnType<typeof resolveContentOperation>>;
  try {
    state = await resolveContentOperation(client, { actor: ACTOR, method, path: editPath, body: payload, idempotencyKey: sourceKey, ifMatch: sourceIfMatch });
    if (state.outcome !== 'new' && state.outcome !== 'replay') return { status: state.status, body: state.body };
  } catch { return fail(503, 'source_edit_receipt_unavailable', '暂时无法核对原操作。请用同一操作重试。'); }

  const partial = (status: number, code: string, message: string) =>
    fail(status, code, message, { source_committed: true, source_id: card.id, source_revision: updatedSource, display_updated: false });
  if (state.outcome === 'new') {
    try {
      const existing = await resolveContentOperation(client, { actor: ACTOR, method, path: target, body: displayPayload, idempotencyKey: projectedKey, ifMatch: headers['if-match'] });
      if (existing.outcome === 'replay') return fail(502, 'source_edit_receipt_unavailable', '映射回执存在，来源回执仍待确认。');
      if (existing.outcome !== 'new') return { status: existing.status, body: existing.body };
    } catch { return fail(503, 'reference_edit_receipt_unavailable', '暂时无法核对映射操作。请用同一操作重试。'); }
    if (reference.row.revision !== projectionRevision || current.row.revision !== expectedSource) {
      return fail(409, 'reference_revision_conflict', '映射或来源已更新。请核对当前修订。');
    }
  }
  const written = state.outcome === 'replay' ? state : await deps.contentOps.write({
    actor: ACTOR, method, path: editPath, body: payload,
    headers: { 'if-match': sourceIfMatch, 'idempotency-key': sourceKey },
  });
  if (!ok(written)) return written;
  const sourceReceipt = written.body as ContentRow | null;
  if (sourceReceipt?.id !== card.id || sourceReceipt.revision !== updatedSource) {
    return fail(502, 'source_edit_result_unknown', '来源编辑回执不完整。请用同一操作核对。');
  }

  try {
    const display = await associateMomentEdit(deps.db, client, projectedKey, {
      postId: id, ifMatch: headers['if-match']!, sourceRevision: updatedSource,
    });
    if (display && ok(display) && !display.bodyFailed) return { status: display.status, body: display.body };
    if (display && display.status >= 400 && display.status < 500) {
      return partial(display.status, 'reference_display_conflict', '来源已经修改；映射、来源或权限已有后续变化，本次未更新显示。');
    }
  } catch { /* Only retry the association after an observed source receipt. */ }
  return partial(502, 'reference_update_pending', '来源已经修改，映射显示仍待确认。请用原操作重试。');
}
