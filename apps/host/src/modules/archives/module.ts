// 相册重构 P4：conversation_archive 模型工具（唯一模型入口；人类走 HTTP 存档路由，
// 同一 ArchiveService/同一校验/同一幂等语义）。定位合同（03 §2）：message_ids 集合或
// latest_completed_turn 二选一；无定位如实拒绝（不猜范围、不全文回读、不默认整天）。
// 回执只含稳定引用与计数——不含消息正文（模型已看过这些内容，无需回读）。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { ArchiveService } from './service.ts';

export const CONVERSATION_ARCHIVE_DEFINITION: import('../../capabilities/contracts.ts').HostToolSpec = {
  type: 'function' as const,
  function: {
    name: 'conversation_archive',
    description: '把明确的已发布对话片段存入对话存档（争吵/甜蜜）。只接受精确定位：message_ids（连续或非连续集合，按原顺序）或 latest_completed_turn（最近一个已完成回合）。没有精确定位时直接告诉用户需要选区，不要猜范围、不要默认整天。存档不删除、不改写任何历史；争吵存档表示话题到此为止。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string' as const, enum: ['quarrel', 'sweet'] as const, description: '存档类型：争吵或甜蜜（由当前明确操作决定，不猜）' },
        message_ids: { type: 'array', items: { type: 'string' }, description: '要存档的已发布消息 id 集合（来自你已看到的对话）' },
        latest_completed_turn: { type: 'boolean', description: 'true=存档最近一个已完成回合（排除你当前正在进行的这个回合）' },
        note: { type: 'string', description: '可选说明（你的原话，原样保存）' },
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

export function registerArchivesCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: ArchivesModuleDeps): void {
  registry.register(toolCapability({
    owner: 'archives',
    id: 'conversation_archive', baselineOrder: 49, definition: () => CONVERSATION_ARCHIVE_DEFINITION, memoryOnlyAllowed: false, label: '存档对话',
    run: (input: { kind: string; message_ids?: string[]; latest_completed_turn?: boolean; note?: string }, ctx) => runConversationArchive(deps.archives, input, ctx),
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
    description: '按关键词搜索对话存档（争吵/甜蜜）。返回匹配的存档条目与有限摘录；要看完整片段用既有原文读取工具，本工具不回读全文。没有合格匹配会如实返回 no_match；服务忙/不可用单独区分。',
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

async function runArchivesSearch(deps: ArchivesModuleDeps, input: { query: string; kind?: 'quarrel' | 'sweet' }, ctx: { roomId: string }): Promise<{ ok: boolean; output: Record<string, unknown> }> {
  if (!deps.mariposa) return { ok: false, output: { error_code: 'ARCHIVE_SEARCH_UNAVAILABLE', detail: 'M 检索客户端未装配' } };
  if (typeof input.query !== 'string' || !input.query.trim()) return { ok: false, output: { error_code: 'TOOL_ARG_INVALID', detail: 'query 必填' } };
  const r = await deps.archives.searchArchives({ conversationId: ctx.roomId, query: input.query, kind: input.kind, mariposa: deps.mariposa as never });
  if (r.state === 'unavailable') return { ok: false, output: { error_code: 'ARCHIVE_SEARCH_UNAVAILABLE', detail: r.detail } };
  if (r.state === 'no_match') return { ok: true, output: { state: 'no_match' } };
  return { ok: true, output: { state: 'matches', items: r.items.map((i) => ({ archive_id: i.archive_id, kind: i.kind, note: i.note, snippet: i.snippet })) } };
}

async function runConversationArchive(archives: ArchiveService, input: { kind: string; message_ids?: string[]; latest_completed_turn?: boolean; note?: string }, ctx: { roomId: string; turnId: string | null; requestId: string; toolCallId?: string | null }): Promise<{ ok: boolean; output: Record<string, unknown> }> {
  const kind = input.kind === 'quarrel' || input.kind === 'sweet' ? input.kind : null;
  if (!kind) return { ok: false, output: { error_code: 'ARCHIVE_KIND_INVALID', detail: 'kind 必须是 quarrel|sweet' } };
  const messageIds = Array.isArray(input.message_ids) ? input.message_ids.filter((x) => typeof x === 'string') : null;
  const latestTurn = input.latest_completed_turn === true;
  if (!messageIds && !latestTurn) {
    return { ok: false, output: { error_code: 'ARCHIVE_POSITION_REQUIRED', detail: '缺少精确定位：给 message_ids 集合，或 latest_completed_turn=true；不可凭描述猜范围' } };
  }
  if (messageIds && latestTurn) {
    return { ok: false, output: { error_code: 'ARCHIVE_POSITION_AMBIGUOUS', detail: 'message_ids 与 latest_completed_turn 只能二选一' } };
  }
  let rawRefs: Array<{ message_id: string }>;
  if (latestTurn) {
    const refs = archives.latestCompletedTurnRefs(ctx.roomId, ctx.turnId);
    if (!refs) return { ok: false, output: { error_code: 'ARCHIVE_TURN_NOT_FOUND', detail: '当前没有可确定的已完成回合（排除你正在进行的这个回合）' } };
    rawRefs = refs.map((r) => ({ message_id: r.message_id }));
  } else {
    rawRefs = messageIds!.map((id) => ({ message_id: id }));
  }
  const note = typeof input.note === 'string' && input.note.trim().length > 0 ? input.note.slice(0, 2000) : null;
  const idem = `tool-archive:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${ctx.toolCallId ?? 'nocall'}`;
  const r = await archives.createArchive({
    conversationId: ctx.roomId, kind, rawRefs, note, actor: 'jiaming', notifyModel: 'none', idempotencyKey: idem,
  });
  if (!r.ok) return { ok: false, output: { error_code: r.code, detail: r.detail } };
  // 工具回执即通知（单通道，03 §4.2）：本回执就是char收到的通知，不再另发事件
  return { ok: true, output: { archived: true, archive_id: r.archive.id, kind: r.archive.kind, message_count: r.archive.count, note: note !== null ? '已保存你的说明原话' : null } };
}
