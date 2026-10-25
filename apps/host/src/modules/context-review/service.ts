// modules/context-review/service.ts（P04.10）：context_review_complete 既有本地规则。
// 原 HostToolExecutor.reviewComplete 逐字迁移（评审收口/账本）；评审算法不在本卡改动。
import type { Db } from '../../db/connection.ts';
import type { RotationReviewService } from '../../context/rotation-review.ts';
import type { HoldCheckpointService } from '../../memory/hold-checkpoint.ts';
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';

export class ContextReviewService {
  private readonly db: Db;
  private readonly reviews: RotationReviewService;
  private readonly checkpoint: HoldCheckpointService;

  constructor(deps: { db: Db; reviews: RotationReviewService; checkpoint: HoldCheckpointService }) {
    this.db = deps.db;
    this.reviews = deps.reviews;
    this.checkpoint = deps.checkpoint;
  }

  reviewComplete(args: Record<string, unknown>, ctx: ToolExecContext): ToolExecResult {
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
  }}
