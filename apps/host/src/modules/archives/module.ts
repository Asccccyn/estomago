// 相册重构 P4：conversation_archive 模型工具（唯一模型入口；人类走 HTTP 存档路由，
// 同一 ArchiveService/同一校验/同一幂等语义）。定位合同（03 §2 + 包2 DBG-04 11-16 版）
// 三选一：message_ids 集合 / latest_completed_turn / 双边界锚点（说话人+短逐字原话，
// 宿主在本次请求实际装载视野内解析为真实 (message_id,revision)，一次调用内定位+保存，
// 不先读回、不猜范围、不默认整天）。回执只含稳定引用与计数——不含消息正文（模型已
// 看过这些内容，无需回读）。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import { sha256Hex } from '../../util/id.ts';
import type { ArchiveAnchor, ArchiveResult, ArchiveService } from './service.ts';

export const CONVERSATION_ARCHIVE_DEFINITION: import('../../capabilities/contracts.ts').HostToolSpec = {
  type: 'function' as const,
  function: {
    name: 'conversation_archive',
    description: '把明确的已发布对话片段存入对话存档（争吵/甜蜜）。三种精确定位（只能选一种）：①message_ids（连续或非连续集合，按原顺序）；②latest_completed_turn=true（最近一个已完成回合，排除你当前正在进行的回合）；③anchor_start+anchor_end 双边界锚点——各给说话人（宿主用户/char）和该消息正文中一段连续的逐字原话，宿主在你本次已见的消息范围内解析，保存起止之间（含首尾）全部完整已见的消息；之间未见或只见节选的不纳入，缺口如实保留。边界引语必须来自原话本身（不是你的转述或概述）。没有精确定位时直接告诉用户需要选区，不要猜范围、不要默认整天。存档不删除、不改写任何历史；争吵存档表示话题到此为止。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string' as const, enum: ['quarrel', 'sweet'] as const, description: '存档类型：争吵或甜蜜（由当前明确操作决定，不猜）' },
        message_ids: { type: 'array', items: { type: 'string' }, description: '要存档的已发布消息 id 集合（来自你已看到的对话）' },
        latest_completed_turn: { type: 'boolean', description: 'true=存档最近一个已完成回合（排除你当前正在进行的这个回合）' },
        anchor_start: {
          type: 'object',
          properties: {
            speaker: { type: 'string' as const, enum: ['宿主用户', 'char'] as const, description: '起点消息的说话人：宿主用户（用户）或char（助手）' },
            quote: { type: 'string', description: '起点消息正文中一段连续的逐字原话（足以唯一定位该消息；完整正文已见时定位整条消息，含首尾）' },
          },
          required: ['speaker', 'quote'] as const,
          additionalProperties: false as const,
        },
        anchor_end: {
          type: 'object',
          properties: {
            speaker: { type: 'string' as const, enum: ['宿主用户', 'char'] as const, description: '终点消息的说话人：宿主用户（用户）或char（助手）' },
            quote: { type: 'string', description: '终点消息正文中一段连续的逐字原话（该条消息一并存档）' },
          },
          required: ['speaker', 'quote'] as const,
          additionalProperties: false as const,
        },
        note: { type: 'string', description: '可选说明（你的原话，原样保存）' },
        client_operation_id: { type: 'string', minLength: 1, maxLength: 128, description: '可选的操作标识。重试沿用原定位参数和同一个值。明确要为同一选区另建一份存档时，提供新的值。' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
};

export type ArchivesModuleDeps = {
  archives: ArchiveService;
  mariposa?: import('../../integrations/mariposa/client.ts').MariposaClient | null;
};

type ConversationArchiveInput = {
  kind: string;
  message_ids?: string[];
  latest_completed_turn?: boolean;
  anchor_start?: { speaker?: string; quote?: string };
  anchor_end?: { speaker?: string; quote?: string };
  note?: string;
  client_operation_id?: string;
};

export function registerArchivesCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: ArchivesModuleDeps): void {
  registry.register(toolCapability({
    owner: 'archives',
    id: 'conversation_archive', baselineOrder: 49, definition: () => CONVERSATION_ARCHIVE_DEFINITION, memoryOnlyAllowed: false, label: '存档对话',
    heartbeatAction: 'archive',
    run: (input: ConversationArchiveInput, ctx) => runConversationArchive(deps.archives, input, ctx),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    owner: 'archives',
    id: 'archives_search', baselineOrder: 53, definition: () => ARCHIVESSEARCH_DEFINITION, memoryOnlyAllowed: false, label: '搜索存档',
    run: (input: { query: string; kind?: 'quarrel' | 'sweet' }, ctx) => runArchivesSearch(deps, input, ctx),
    toModel: (value) => value,
  }));
}

const ARCHIVESSEARCH_DEFINITION: import('../../capabilities/contracts.ts').HostToolSpec = {
  type: 'function' as const,
  function: {
    name: 'archives_search',
    description: '按关键词搜索争吵或甜蜜存档，查看匹配的条目和摘录。要读存档时保存的原话，把这次拿到的 archive_id 交给 conversation_read。没有合格匹配时返回 no_match，服务不可用时会说明。',
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: '关键词或短语' },
        kind: { type: 'string' as const, enum: ['quarrel', 'sweet'] as const, description: '可选：只搜争吵或甜蜜存档；缺省搜全部' },
      },
      required: ['query'] as const,
      additionalProperties: false as const,
    },
  },
};

async function runArchivesSearch(deps: ArchivesModuleDeps, input: { query: string; kind?: 'quarrel' | 'sweet' }, ctx: { roomId: string; signal?: AbortSignal }): Promise<{ ok: boolean; output: Record<string, unknown> }> {
  if (!deps.mariposa) return { ok: false, output: { error_code: 'ARCHIVE_SEARCH_UNAVAILABLE', detail: 'M 检索客户端未装配' } };
  if (typeof input.query !== 'string' || !input.query.trim()) return { ok: false, output: { error_code: 'TOOL_ARG_INVALID', detail: 'query 必填' } };
  // RR4-F4：调用方取消贯穿 content 分页与 M 检索（每页/每批发起前检查）
  const r = await deps.archives.searchArchives({ conversationId: ctx.roomId, query: input.query, kind: input.kind, signal: ctx.signal, mariposa: deps.mariposa as never });
  if (r.state === 'unavailable') return { ok: false, output: { error_code: 'ARCHIVE_SEARCH_UNAVAILABLE', detail: r.detail } };
  if (r.state === 'no_match') return { ok: true, output: { state: 'no_match' } };
  return { ok: true, output: { state: 'matches', items: r.items.map((i) => ({ archive_id: i.archive_id, kind: i.kind, note: i.note, snippet: i.snippet })) } };
}

function archiveToolReceipt(result: ArchiveResult, note: string | null): { ok: boolean; output: Record<string, unknown> } {
  if (!result.ok) {
    const detail = result.retryable
      ? `${result.detail}。请在同一回合用原参数重试，原来未填 client_operation_id 就继续省略，已填则沿用原值。`
      : result.detail;
    return { ok: false, output: { error_code: result.code, detail } };
  }
  return { ok: true, output: {
    archived: true, archive_id: result.archive.id, kind: result.archive.kind, message_count: result.archive.count,
    note: note !== null ? '已保存你的说明原话' : null,
  } };
}

async function runConversationArchive(archives: ArchiveService, input: ConversationArchiveInput, ctx: { roomId: string; turnId: string | null; seenMessages?: ReadonlyArray<{ id: string; revision: number; char_start?: number; char_end?: number }> }): Promise<{ ok: boolean; output: Record<string, unknown> }> {
  const kind = input.kind === 'quarrel' || input.kind === 'sweet' ? input.kind : null;
  if (!kind) return { ok: false, output: { error_code: 'ARCHIVE_KIND_INVALID', detail: 'kind 必须是 quarrel|sweet' } };
  const messageIds = Array.isArray(input.message_ids) ? input.message_ids.filter((x) => typeof x === 'string') : null;
  const latestTurn = input.latest_completed_turn === true;
  const hasAnchors = input.anchor_start !== undefined || input.anchor_end !== undefined;
  if (!messageIds && !latestTurn && !hasAnchors) {
    return { ok: false, output: { error_code: 'ARCHIVE_POSITION_REQUIRED', detail: '缺少精确定位：给 message_ids 集合，或 latest_completed_turn=true，或 anchor_start+anchor_end 双边界锚点；不可凭描述猜范围' } };
  }
  const ways = [messageIds !== null, latestTurn, hasAnchors].filter(Boolean).length;
  if (ways > 1) {
    return { ok: false, output: { error_code: 'ARCHIVE_POSITION_AMBIGUOUS', detail: 'message_ids / latest_completed_turn / 双边界锚点只能三选一' } };
  }
  if (hasAnchors && (input.anchor_start === undefined || input.anchor_end === undefined)) {
    return { ok: false, output: { error_code: 'ARCHIVE_ANCHOR_PAIR_REQUIRED', detail: '锚点定位必须同时给 anchor_start 与 anchor_end' } };
  }
  const note = typeof input.note === 'string' && input.note.trim().length > 0 ? input.note.slice(0, 2000) : null;
  const selector = messageIds ? [...new Set(messageIds)].sort()
    : latestTurn ? 'latest_completed_turn'
    : [input.anchor_start, input.anchor_end].map(anchor => [anchor?.speaker, anchor?.quote?.trim()]);
  // 旧冻结工具没有显式操作标识。相同回合与定位即同一次写入，供应商请求 ID 和工具调用 ID 不参与。
  const scope = input.client_operation_id ? ['explicit', input.client_operation_id] : ['turn', ctx.turnId];
  const idem = `tool-archive-v2:${sha256Hex(JSON.stringify([ctx.roomId, scope, kind, selector, note]))}`;
  const accepted = await archives.recoverModelArchive(ctx.roomId, idem);
  if (accepted) return archiveToolReceipt(accepted, note);

  let rawRefs: Array<{ message_id: string; revision?: number }>;
  let anchorSummary: { segments: number; skipped_unseen: number; excluded_excerpt_only: number; boundary_excerpts: { start: string; end: string } } | null = null;
  if (hasAnchors) {
    const norm = (a: { speaker?: string; quote?: string }, label: string): ArchiveAnchor | { err: { ok: false; output: Record<string, unknown> } } => {
      const speaker = a.speaker === '宿主用户' || a.speaker === 'char' ? a.speaker : null;
      const quote = typeof a.quote === 'string' ? a.quote.trim() : '';
      if (!speaker || quote.length === 0 || quote.length > 300) {
        return { err: { ok: false, output: { error_code: 'TOOL_ARG_INVALID', detail: `${label}锚点需要 speaker（宿主用户|char）与 1-300 字的逐字原话` } } };
      }
      return { speaker, quote };
    };
    const s = norm(input.anchor_start!, '起点');
    if ('err' in s) return s.err;
    const e = norm(input.anchor_end!, '终点');
    if ('err' in e) return e.err;
    const resolution = archives.resolveAnchorRange(ctx.roomId, ctx.seenMessages ?? [], s, e);
    if (!resolution.ok) {
      return { ok: false, output: { error_code: resolution.code, detail: resolution.detail, ...(resolution.boundary !== undefined ? { boundary: resolution.boundary } : {}), ...(resolution.candidates !== undefined ? { candidates: resolution.candidates } : {}), ...(resolution.conflicts !== undefined ? { conflicts: resolution.conflicts } : {}) } };
    }
    rawRefs = resolution.refs;
    anchorSummary = resolution;
  } else if (latestTurn) {
    const refs = archives.latestCompletedTurnRefs(ctx.roomId, ctx.turnId);
    if (!refs) return { ok: false, output: { error_code: 'ARCHIVE_TURN_NOT_FOUND', detail: '当前没有可确定的已完成回合（排除你正在进行的这个回合）' } };
    rawRefs = refs;
  } else {
    rawRefs = messageIds!.map((id) => ({ message_id: id }));
  }
  const r = await archives.createArchive({
    conversationId: ctx.roomId, kind, rawRefs, note, actor: 'jiaming', idempotencyKey: idem,
  });
  const receipt = archiveToolReceipt(r, note);
  // 工具回执即通知（单通道，03 §4.2）：本回执就是char收到的通知，不再另发事件。
  // 锚点路径回执带范围摘要（少量边界文字/段数/缺口计数——不回显整段，D14/D18）。
  if (receipt.ok && anchorSummary !== null) {
    Object.assign(receipt.output, {
      segments: anchorSummary.segments, skipped_unseen: anchorSummary.skipped_unseen, excluded_excerpt_only: anchorSummary.excluded_excerpt_only,
      range_summary: { start: anchorSummary.boundary_excerpts.start, end: anchorSummary.boundary_excerpts.end },
    });
  }
  return receipt;
}
