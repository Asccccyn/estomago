// 宿主固定工具集（§3.3/§8.2）：开窗即固定 allowlist，不临提醒才改工具集合。
//  - memory_hold：映射 Mariposa memory.hold（宿主自动化路径必须带 operation_id，§5 生命周期契约）。
//    operation_id 由宿主从 tool_call 派生（模型不能自编）；无 Mariposa 客户端 → 能力缺口，明确拒绝。
//    契约对齐 mariposa@75378ab（她的 1005 裁定）：original_title 必填≤30字、categories 数组九分类枚举、
//    creation_mode 枚举、memory_date+date_confidence。心情已随词表终版接入（她当晚冻结 7 大类）：
//    mood_tags=大类枚举（≤3 个）+ mood_note 自由文字（可写可不写），映射 mariposa hold 的
//    mood{tags,text}。词表正本=mariposa memory.mood.vocab；此处枚举只是形状门，域校验以服务端为准。
//  - our_words=模型指认（她的裁定）：模型只给 quotes（想逐字引用的片段）；网关在"发起请求实际看见的
//    原文"里逐字核对（对不上=拒绝，不替模型圆谎），说话人按消息来源自动映射（owner=qiaosheng/
//    assistant=jiaming），引用按 mariposa 现成机制钉住（source_selections：source_message_id+内容hash，
//    句内片段带 char offset）——our_words 逐字保真，模型零复述 token。
//  - context_review_complete：宿主本地验证（review/账本/收据），不依赖模型自报成功名单。
// 工具执行串行（写操作依赖顺序；review_complete 最后验证，不并发抢先放行）。
import { sha256Hex } from '../util/id.ts';
import type { Db } from '../db/connection.ts';
import type { MariposaClient } from '../integrations/mariposa/client.ts';
import type { RotationReviewService } from '../context/rotation-review.ts';
import type { HoldCheckpointService } from '../memory/hold-checkpoint.ts';

export type HostToolSpec = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };

// mariposa 现行 hold 契约常量（正本=mariposa input_schemas；此处只做形状门，域校验仍以服务端为准）
export const HOLD_CATEGORIES = ['daily', 'milestone', 'sad', 'sweet', 'date', 'plan', 'sex', 'anniversary', 'reloplay'] as const;
export const HOLD_CREATION_MODES = ['contemporaneous', 'retrospective'] as const;
export const HOLD_DATE_CONFIDENCE = ['exact', 'inferred', 'unknown'] as const;
export const HOLD_TITLE_MAX = 30;
// mariposa 心情大类终版（2026-10-05 她指定 7 类；正本=mariposa memory.mood.vocab）
export const MOOD_CATEGORIES = ['开心', '爱', '生气', '吃醋', '悲伤', '渴望', '不安'] as const;

export const HOST_TOOLS: HostToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'memory_hold',
      description: '把一件事写入 Mariposa 正式记忆（hold）。由你自主决定是否值得记；也可以完全不调用。引用原话用 quotes：必须是这段对话里真实出现过的原文片段（一字不差），系统会核对、标注说话人并钉住出处；对不上的引用整条被拒。',
      parameters: {
        type: 'object',
        properties: {
          original_title: { type: 'string', minLength: 1, maxLength: HOLD_TITLE_MAX, description: `这条记忆的标题（1-${HOLD_TITLE_MAX}字，必填）` },
          categories: { type: 'array', items: { type: 'string', enum: [...HOLD_CATEGORIES] }, minItems: 1, description: '分类（从固定九类里选，至少一个）' },
          text: { type: 'string', description: '要记住的内容（你的表述）' },
          quotes: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 10, description: '可选：想逐字引用的原话片段。只给对话里真实出现过的连续原文；每条独立，说话人由系统标注' },
          plan_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
          creation_mode: { type: 'string', enum: [...HOLD_CREATION_MODES], description: 'contemporaneous=当下聊到随手记；retrospective=补记过去的事（须配 memory_date）' },
          memory_date: { type: 'string', description: '补记过去的事时填（ISO 日期，如 2026-09-30）' },
          date_confidence: { type: 'string', enum: [...HOLD_DATE_CONFIDENCE] },
          mood_tags: { type: 'array', items: { type: 'string', enum: [...MOOD_CATEGORIES] }, maxItems: 3, description: '当时心情大类（固定 7 类选 1-3 个；不选=不写心情）' },
          mood_note: { type: 'string', description: '当下心情随笔，自由文字可写可不写（如"开心想抱抱"）；永不参与检索' },
        },
        required: ['original_title', 'categories', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'context_review_complete',
      description: '完成当前活跃的换窗前记忆检查。decision=no_new_hold（本次没有新增 hold 且无未决写操作）或 holds_completed（本次已有核实的成功 hold）。',
      parameters: {
        type: 'object',
        properties: {
          review_id: { type: 'string', minLength: 1, maxLength: 256 },
          decision: { type: 'string', enum: ['no_new_hold', 'holds_completed'] },
        },
        required: ['review_id', 'decision'],
        additionalProperties: false,
      },
    },
  },
];

export function hostToolNames(): string[] {
  return HOST_TOOLS.map((t) => t.function.name);
}

type PropSpec = { type?: string; enum?: unknown[]; items?: { type?: string; enum?: unknown[]; minLength?: number }; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number };

/** 审计 A051/F30：宿主侧最小 JSON-Schema 校验——白名单外字段拒绝（additionalProperties:false），
 *  required 缺失/类型不符/枚举外值/长度与条数越界直接拒绝，不提交给 Mariposa。schema 与 HOST_TOOLS 同源。 */
export function validateToolArgs(name: string, args: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; code: string; detail: string } {
  const spec = HOST_TOOLS.find((t) => t.function.name === name);
  if (!spec) return { ok: false, code: 'TOOL_NOT_IN_ALLOWLIST', detail: name };
  const schema = spec.function.parameters as { properties?: Record<string, PropSpec>; required?: string[] };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === '__tool_call_id') continue; // 宿主内部标识，非模型参数
    const prop = schema.properties?.[k];
    if (!prop) return { ok: false, code: 'TOOL_ARG_UNKNOWN', detail: `未知参数 ${k}（additionalProperties:false）` };
    if (prop.enum && !prop.enum.includes(v)) return { ok: false, code: 'TOOL_ARG_ENUM', detail: `${k} 必须是 ${prop.enum.join('|')} 之一` };
    if (prop.type === 'string') {
      if (typeof v !== 'string') return { ok: false, code: 'TOOL_ARG_TYPE', detail: `${k} 需要 string` };
      if (prop.minLength !== undefined && v.length < prop.minLength) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 至少 ${prop.minLength} 字` };
      if (prop.maxLength !== undefined && v.length > prop.maxLength) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 超过 ${prop.maxLength} 字` };
    } else if (prop.type === 'array') {
      if (!Array.isArray(v)) return { ok: false, code: 'TOOL_ARG_TYPE', detail: `${k} 需要 array` };
      if (prop.items?.type === 'string' && v.some((x) => typeof x !== 'string')) return { ok: false, code: 'TOOL_ARG_TYPE', detail: `${k} 需要 string[]` };
      if (prop.items?.minLength !== undefined && v.some((x) => typeof x === 'string' && x.length < prop.items!.minLength!)) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 含空串条目（每条至少 ${prop.items.minLength} 字）` };
      if (prop.items?.enum && v.some((x) => !prop.items!.enum!.includes(x))) return { ok: false, code: 'TOOL_ARG_ENUM', detail: `${k} 含枚举外值（允许：${prop.items.enum.join('|')}）` };
      if (prop.minItems !== undefined && v.length < prop.minItems) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 至少 ${prop.minItems} 条` };
      if (prop.maxItems !== undefined && v.length > prop.maxItems) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 超过 ${prop.maxItems} 条` };
    }
    out[k] = v;
  }
  for (const req of schema.required ?? []) {
    if (out[req] === undefined || (typeof out[req] === 'string' && (out[req] as string).length === 0)) return { ok: false, code: 'TOOL_ARG_REQUIRED', detail: `缺少必填 ${req}` };
  }
  return { ok: true, value: out };
}

export type ToolExecContext = {
  roomId: string;
  windowId: string;
  turnId: string | null;
  purpose: 'chat' | 'pre_rotate_review' | 'proactive_turn' | 'cache_keepalive';
  activeReviewId: string | null;
  seenSequence: number; // 本次请求实际看见的聊天输入高水位（书签与引用核对范围依据，§3.1）
  requestId: string; // 发起 hold 的模型请求标识
};

export type ToolExecResult = { ok: boolean; output: Record<string, unknown> };

const rawToolCallIdRef = { current: null as string | null };
function rawToolCallIdOf(_ctx: ToolExecContext): string | null { return rawToolCallIdRef.current; }

/** 已匹配的引用（逐字核对通过）：原文消息 + 片段在该消息内的字符区间。
 *  区间口径=**Unicode 码点**半开区间 [start,end)——与 mariposa 契约一致（source/query.py CB-029：
 *  "char offset 口径不变，仍是 code point 半开区间"）。不得直接发 JS 的 UTF-16 下标：
 *  emoji 等增补平面字符占 2 个 UTF-16 单位但只算 1 个码点，fragment 之前出现过一个就会错位。 */
type MatchedQuote = { messageId: string; revision: number; sequence: number; speaker: 'owner' | 'assistant'; content: string; fragment: string; start: number; end: number };

/** 引用核对只看最近 N 条已见消息（资源有界；更早原话的引用会如实 QUOTE_MATCH_FAILED，不扩大扫描） */
const QUOTE_CANDIDATE_LIMIT = 60;

/** UTF-16 下标 → 码点数（代理对计 1）；把 indexOf 的结果换算成 mariposa 契约口径 */
function utf16IndexToCodepoints(s: string, utf16Index: number): number {
  let cp = 0;
  let i = 0;
  while (i < utf16Index) {
    const code = s.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff && i + 1 < s.length ? 2 : 1;
    cp++;
  }
  return cp;
}

export class HostToolExecutor {
  private db: Db;
  private mariposa: MariposaClient | null;
  private reviews: RotationReviewService;
  private checkpoint: HoldCheckpointService;
  private archiveSync: { drainOnce(): Promise<unknown> } | null;

  constructor(deps: { db: Db; mariposa: MariposaClient | null; reviews: RotationReviewService; checkpoint: HoldCheckpointService; archiveSync?: { drainOnce(): Promise<unknown> } | null }) {
    this.db = deps.db;
    this.mariposa = deps.mariposa;
    this.reviews = deps.reviews;
    this.checkpoint = deps.checkpoint;
    this.archiveSync = deps.archiveSync ?? null;
  }

  async execute(name: string, rawArgs: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (name !== 'memory_hold' && name !== 'context_review_complete') return { ok: false, output: { error_code: 'TOOL_NOT_IN_ALLOWLIST' } };
    // 审计 A051：参数完整校验后才执行（§8.2）——schema 拒绝不产生副作用
    rawToolCallIdRef.current = typeof rawArgs.__tool_call_id === 'string' ? rawArgs.__tool_call_id : null;
    const checked = validateToolArgs(name, rawArgs);
    if (!checked.ok) return { ok: false, output: { error_code: checked.code, error: checked.detail } };
    if (rawToolCallIdRef.current !== null) checked.value.__tool_call_id = rawToolCallIdRef.current;
    if (name === 'memory_hold') return this.memoryHold(checked.value, ctx);
    return this.reviewComplete(checked.value, ctx);
  }

  /** 模型指认的引用核对（她的裁定 2026-10-05）：只在"发起请求实际看见的原话"里逐字匹配（按序消费候选，
   *  防重复片段误配）；任一条对不上 → 整单拒绝（不替模型圆谎、不静默丢弃）。
   *  匹配用 indexOf（UTF-16 一致，无碍）；发出的 start/end 换算成码点口径（见 MatchedQuote 注释）。 */
  private resolveQuotes(roomId: string, seenSequence: number, quotes: string[]): MatchedQuote[] | { error: string; index: number } {
    const rows = this.db.prepare(
      `SELECT m.id, m.sequence, m.speaker, m.current_revision, r.content FROM messages m
       JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       WHERE m.conversation_id = ? AND m.sequence <= ? AND m.speaker IN ('owner','assistant')
       ORDER BY m.sequence DESC LIMIT ${QUOTE_CANDIDATE_LIMIT}`,
    ).all(roomId, seenSequence) as Array<{ id: string; sequence: number; speaker: string; current_revision: number; content: string }>;
    const candidates = rows.slice().reverse(); // 时间正序，按序消费
    const matched: MatchedQuote[] = [];
    let cursor = 0;
    for (let qi = 0; qi < quotes.length; qi++) {
      const frag = quotes[qi]!;
      if (frag.length === 0) return { error: 'QUOTE_EMPTY', index: qi };
      let hit: MatchedQuote | null = null;
      for (let i = cursor; i < candidates.length; i++) {
        const row = candidates[i]!;
        if (row.speaker !== 'owner' && row.speaker !== 'assistant') continue;
        const idx = row.content.indexOf(frag);
        if (idx >= 0) {
          const startCp = utf16IndexToCodepoints(row.content, idx);
          hit = {
            messageId: row.id, revision: row.current_revision, sequence: row.sequence,
            speaker: row.speaker as 'owner' | 'assistant', content: row.content, fragment: frag,
            start: startCp, end: startCp + [...frag].length, // [...str] 按码点迭代=码点长度
          };
          cursor = i + 1;
          break;
        }
      }
      if (!hit) return { error: 'QUOTE_MATCH_FAILED', index: qi };
      matched.push(hit);
    }
    return matched;
  }

  private async memoryHold(args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.mariposa) return { ok: false, output: { error_code: 'MARIPOSA_CLIENT_UNAVAILABLE', error: '记忆服务未接线（能力缺口，如实拒绝）' } };
    const toolCallId = String((args as Record<string, unknown>).__tool_call_id ?? (rawToolCallIdOf(ctx) ?? ''));

    // —— 引用先收口（零副作用阶段）：逐字核对 → 来源收据齐备（收据缺失先补一发同步再核） ——
    let ourWords: Array<{ speaker: 'qiaosheng' | 'jiaming'; text: string; expression_kind: 'verbatim'; source_ref: string }> = [];
    let selections: Array<{ conversation_id: string; members: Array<{ source_message_id: string; content_hash: string }>; start_char_offset?: number; end_char_offset?: number }> = [];
    const rawQuotes = Array.isArray(args.quotes) ? (args.quotes as string[]) : [];
    if (rawQuotes.length > 0) {
      const resolved = this.resolveQuotes(ctx.roomId, ctx.seenSequence, rawQuotes);
      if ('error' in resolved) {
        return { ok: false, output: { error_code: resolved.error, quote_index: resolved.index, error: '引用片段在已见原文中逐字核对未通过——只允许引用这段对话里真实出现过的一字不差的原文' } };
      }
      // 每条被引消息必须有正式来源收据（estómago↔mariposa 同步回执）：没有就先 drain 一次再核
      const missing = resolved.filter((q) => !this.receiptOf(q.messageId, q.revision));
      if (missing.length > 0 && this.archiveSync) {
        await this.archiveSync.drainOnce().catch(() => {});
      }
      for (const q of resolved) {
        const receipt = this.receiptOf(q.messageId, q.revision);
        if (!receipt) {
          return { ok: false, output: { error_code: 'QUOTE_NOT_SYNCED', quote_index: resolved.indexOf(q), error: `被引消息（seq=${q.sequence}）尚未完成正式来源同步——稍后重试或去掉该引用` } };
        }
        ourWords.push({
          speaker: q.speaker === 'owner' ? 'qiaosheng' : 'jiaming',
          text: q.fragment,
          expression_kind: 'verbatim',
          source_ref: q.messageId,
        });
        const member = { source_message_id: receipt.source_message_id, content_hash: receipt.content_hash };
        // 整句引用=消息边界（不带 offset）；句内片段带字符区间（mariposa 契约：句内片段用可选 char offset）
        const wholeMessage = q.fragment === q.content;
        selections.push(wholeMessage
          ? { conversation_id: receipt.source_conversation_id, members: [member] }
          : { conversation_id: receipt.source_conversation_id, members: [member], start_char_offset: q.start, end_char_offset: q.end });
      }
    }

    const operationId = `es-hold-${sha256Hex(`${ctx.turnId ?? ctx.requestId}:${toolCallId}`).slice(0, 40)}`;
    const effectId = this.reviews.openEffect({ reviewId: ctx.activeReviewId, turnId: ctx.turnId, windowId: ctx.windowId, kind: 'hold', operationId, toolCallId, seenSequence: ctx.seenSequence });
    const holdPayload: Record<string, unknown> = { original_title: args.original_title, categories: args.categories, text: args.text };
    for (const k of ['plan_ids', 'creation_mode', 'memory_date', 'date_confidence']) {
      if (args[k] !== undefined) holdPayload[k] = args[k];
    }
    // 心情（2026-10-05 词表终版接入）：任一给了才组 mood——都不给=不带
    // mood（mariposa 侧空心情合法）；tags 只收大类，note 自由文字
    if (args.mood_tags !== undefined || args.mood_note !== undefined) {
      holdPayload.mood = { tags: Array.isArray(args.mood_tags) ? args.mood_tags : [], text: typeof args.mood_note === 'string' ? args.mood_note : null };
    }
    if (ourWords.length > 0) holdPayload.our_words = ourWords;
    let r: Awaited<ReturnType<MariposaClient['memoryHold']>>;
    try {
      r = await this.mariposa.memoryHold({ operationId, holdPayload, sourceSelections: selections.length > 0 ? selections : null });
    } catch {
      // 审计 F08：transport 抛出=结果不明（不是失败）——effect 收口为 unknown，绝不留 running
      this.reviews.settleEffect(effectId, 'unknown', false, null);
      return { ok: false, output: { error_code: 'HOLD_OUTCOME_UNKNOWN', operation_id: operationId } };
    }
    if (!r.ok) {
      // 审计 F10：结果不明（传输/5xx/429/回执形状无效）≠ 失败——标 unknown，不盲重试也不当没写（§3.3）
      const unknown = r.code.startsWith('HTTP_5') || r.code === 'HTTP_429' || r.code.startsWith('TRANSPORT') || r.code === 'RECEIPT_SHAPE_INVALID';
      this.reviews.settleEffect(effectId, unknown ? 'unknown' : 'failed_resolved', false, null);
      return { ok: false, output: { error_code: unknown ? 'HOLD_OUTCOME_UNKNOWN' : `HOLD_${r.code}`, operation_id: operationId } };
    }
    const receipt = r.receipt!;
    // 审计 F10：错操作号的收据不被信任——远端回执必须对应宿主派生的同一 operation_id
    if (receipt.operation_id !== operationId) {
      this.reviews.settleEffect(effectId, 'unknown', false, null);
      return { ok: false, output: { error_code: 'HOLD_RECEIPT_OPERATION_MISMATCH', expected: operationId, got: receipt.operation_id } };
    }
    this.reviews.settleEffect(effectId, 'committed', true, receipt.memory_id);
    // 成功书签：主模型发起 + 已核实收据 → 以"发起请求实际看见的高水位"推进（不倒退/幂等）
    try {
      this.checkpoint.advance(ctx.windowId, {
        id: ctx.requestId, roomId: ctx.roomId, epochId: ctx.windowId, operationId,
        author: 'primary_model', seenSequence: ctx.seenSequence,
      }, {
        id: `${operationId}:${receipt.memory_id}`, roomId: ctx.roomId, epochId: ctx.windowId,
        operationId, memoryId: receipt.memory_id, verified: true, state: 'committed',
      });
    } catch {
      // 书签推进被拒（旧窗收据/收据错配等）——hold 本身已成功，不因书签失败回滚写入；
      // 冲突留在 checkpoint 查询层如实呈现
    }
    return { ok: true, output: { operation_id: receipt.operation_id, memory_id: receipt.memory_id, version: receipt.version, binding_ids: receipt.binding_ids, committed_at: receipt.committed_at, quoted_messages: ourWords.length } };
  }

  private receiptOf(messageId: string, revision: number): { source_conversation_id: string; source_message_id: string; content_hash: string } | null {
    const row = this.db.prepare('SELECT source_conversation_id, source_message_id, content_hash FROM source_sync_receipts WHERE origin_message_id = ? AND revision = ?')
      .get(messageId, revision) as { source_conversation_id: string | null; source_message_id: string | null; content_hash: string | null } | undefined;
    if (!row || !row.source_conversation_id || !row.source_message_id || !row.content_hash) return null;
    return { source_conversation_id: row.source_conversation_id, source_message_id: row.source_message_id, content_hash: row.content_hash };
  }

  /** 审计 F08：换窗评审前的有界恢复探测——按原 operation_id 查 hold.status；
   *  有真实回执 → 落 committed + 迟到书签（只补原窗口记录）；completed=false（服务端明确
   *  无提交证据）→ failed_resolved（不是没发生，是可判定的未提交）；查询失败 → 保持 unknown。 */
  async recoverUnknownEffects(conversationId: string, windowId: string): Promise<{ resolved: number; stillUnknown: number }> {
    if (!this.mariposa) return { resolved: 0, stillUnknown: this.reviews.unknownEffectsForWindow(windowId).length };
    let resolved = 0;
    let stillUnknown = 0;
    for (const e of this.reviews.unknownEffectsForWindow(windowId)) {
      // 审计 F08：只认两类确定结论——真实回执（committed）或服务端显式 completed=false。
      // 查询失败/形状损坏/回执错配一律保持 unknown 并阻断换窗，绝不自动消解。
      let r: Awaited<ReturnType<MariposaClient['holdStatus']>>;
      try {
        r = await this.mariposa.holdStatus(e.operationId);
      } catch {
        stillUnknown++; // fetch throw：结果不明，不是"没写"
        continue;
      }
      if (!r.ok || !r.receipt) {
        // ok 无回执（含损坏的 200 响应被客户端判为无 receipt）≠ 未提交——§5 无记录只是"尚无提交证据"。
        // 只有服务端结构化 completed=false 才是可判定的未提交；此处保守保持 unknown。
        if (r.ok && (r.result as { completed?: unknown }).completed === false) {
          this.reviews.settleEffect(e.id, 'failed_resolved', false, null);
          resolved++;
        } else {
          stillUnknown++;
        }
        continue;
      }
      if (r.receipt.operation_id !== e.operationId) {
        stillUnknown++; // 回执错配：不可判定
        continue;
      }
      this.reviews.settleEffect(e.id, 'committed', true, r.receipt.memory_id);
      if (e.seenSequence !== null) {
        try {
          this.checkpoint.advance(windowId, {
            id: `recovery:${e.operationId}`, roomId: conversationId, epochId: windowId, operationId: e.operationId,
            author: 'primary_model', seenSequence: e.seenSequence,
          }, {
            id: `${e.operationId}:${r.receipt.memory_id}`, roomId: conversationId, epochId: windowId,
            operationId: e.operationId, memoryId: r.receipt.memory_id, verified: true, state: 'committed',
          });
        } catch { /* 迟到收据不倒退书签；冲突如实留检 */ }
      }
      resolved++;
    }
    return { resolved, stillUnknown };
  }

  private reviewComplete(args: Record<string, unknown>, ctx: ToolExecContext): ToolExecResult {
    const reviewId = typeof args.review_id === 'string' ? args.review_id : '';
    const decision = args.decision === 'no_new_hold' || args.decision === 'holds_completed' ? args.decision : null;
    if (!reviewId || !decision) return { ok: false, output: { error_code: 'REVIEW_ARGS_INVALID' } };
    if (!ctx.activeReviewId || ctx.activeReviewId !== reviewId) {
      return { ok: false, output: { error_code: 'REVIEW_NOT_ACTIVE', error: '没有活跃的换窗检查（原文仿写不生效）' } };
    }
    const r = this.reviews.complete(reviewId, { review_id: reviewId, decision }, {
      purpose: 'pre_rotate_review', roomId: ctx.roomId, epochId: ctx.windowId,
      epochRevision: this.reviews.get(reviewId)?.epochRevision ?? -1,
    });
    if (!r.ok) return { ok: false, output: { error_code: r.code, error: '宿主核验未通过（真实收据/未决写操作检查）' } };
    const effectId = this.reviews.openEffect({ reviewId, turnId: ctx.turnId, windowId: ctx.windowId, kind: 'review_complete', operationId: null, toolCallId: `${reviewId}:${decision}`, seenSequence: ctx.seenSequence });
    this.reviews.settleEffect(effectId, 'committed', true, null);
    return { ok: true, output: { review_id: reviewId, decision, memory_ids: r.review.memoryIds ?? [] } };
  }
}
