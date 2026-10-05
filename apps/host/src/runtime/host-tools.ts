// 宿主固定工具集（§3.3/§8.2）：开窗即固定 allowlist，不临提醒才改工具集合。
//  - memory_hold：映射 Mariposa memory.hold（宿主自动化路径必须带 operation_id，§5 生命周期契约）。
//    operation_id 由宿主从 tool_call 派生（模型不能自编）；无 Mariposa 客户端 → 能力缺口，明确拒绝。
//  - context_review_complete：宿主本地验证（review/账本/收据），不依赖模型自报成功名单。
// 工具执行串行（写操作依赖顺序；review_complete 最后验证，不并发抢先放行）。
import { sha256Hex } from '../util/id.ts';
import type { MariposaClient } from '../integrations/mariposa/client.ts';
import type { RotationReviewService } from '../context/rotation-review.ts';
import type { HoldCheckpointService } from '../memory/hold-checkpoint.ts';

export type HostToolSpec = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };

export const HOST_TOOLS: HostToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'memory_hold',
      description: '把一件事写入 Mariposa 正式记忆（hold）。由你自主决定是否值得记；也可以完全不调用。参数即既有 hold 业务字段。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '既有九分类之一' },
          text: { type: 'string', description: '要记住的内容（你的表述）' },
          mood_tags: { type: 'array', items: { type: 'string' } },
          our_words: { type: 'string' },
          plan_ids: { type: 'array', items: { type: 'string' } },
          creation_mode: { type: 'string' },
          backfill_date: { type: 'string' },
        },
        required: ['category', 'text'],
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

export type ToolExecContext = {
  roomId: string;
  windowId: string;
  turnId: string | null;
  purpose: 'chat' | 'pre_rotate_review' | 'proactive_turn' | 'cache_keepalive';
  activeReviewId: string | null;
  seenSequence: number; // 本次请求实际看见的聊天输入高水位（书签位置依据，§3.1）
  requestId: string; // 发起 hold 的模型请求标识
};

export type ToolExecResult = { ok: boolean; output: Record<string, unknown> };

export class HostToolExecutor {
  private mariposa: MariposaClient | null;
  private reviews: RotationReviewService;
  private checkpoint: HoldCheckpointService;

  constructor(deps: { mariposa: MariposaClient | null; reviews: RotationReviewService; checkpoint: HoldCheckpointService }) {
    this.mariposa = deps.mariposa;
    this.reviews = deps.reviews;
    this.checkpoint = deps.checkpoint;
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (name === 'memory_hold') return this.memoryHold(args, ctx);
    if (name === 'context_review_complete') return this.reviewComplete(args, ctx);
    return { ok: false, output: { error_code: 'TOOL_NOT_IN_ALLOWLIST' } };
  }

  private async memoryHold(args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.mariposa) return { ok: false, output: { error_code: 'MARICOA_CLIENT_UNAVAILABLE', error: '记忆服务未接线（能力缺口，如实拒绝）' } };
    const toolCallId = String(args.__tool_call_id ?? '');
    const operationId = `es-hold-${sha256Hex(`${ctx.turnId ?? ctx.requestId}:${toolCallId}`).slice(0, 40)}`;
    const effectId = this.reviews.openEffect({ reviewId: ctx.activeReviewId, turnId: ctx.turnId, windowId: ctx.windowId, kind: 'hold', operationId, toolCallId });
    const holdPayload: Record<string, unknown> = {};
    for (const k of ['category', 'text', 'mood_tags', 'our_words', 'plan_ids', 'creation_mode', 'backfill_date']) {
      if (args[k] !== undefined) holdPayload[k] = args[k];
    }
    const r = await this.mariposa.memoryHold({ operationId, holdPayload });
    if (!r.ok) {
      // 传输未知（结果不明）≠ 失败：标 unknown，不得盲重试也不得当没写（§3.3）
      const unknown = r.code.startsWith('HTTP_5') || r.code === 'HTTP_429' || r.code.startsWith('TRANSPORT');
      this.reviews.settleEffect(effectId, unknown ? 'unknown' : 'failed_resolved', false, null);
      return { ok: false, output: { error_code: unknown ? 'HOLD_OUTCOME_UNKNOWN' : `HOLD_${r.code}`, operation_id: operationId } };
    }
    const receipt = r.receipt!;
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
    return { ok: true, output: { operation_id: receipt.operation_id, memory_id: receipt.memory_id, version: receipt.version, binding_ids: receipt.binding_ids, committed_at: receipt.committed_at } };
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
    const effectId = this.reviews.openEffect({ reviewId, turnId: ctx.turnId, windowId: ctx.windowId, kind: 'review_complete', operationId: null, toolCallId: `${reviewId}:${decision}` });
    this.reviews.settleEffect(effectId, 'committed', true, null);
    return { ok: true, output: { review_id: reviewId, decision, memory_ids: r.review.memoryIds ?? [] } };
  }
}
