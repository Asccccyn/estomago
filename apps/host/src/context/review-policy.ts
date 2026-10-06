// ESTOMAGO_OR_SELF_HOLD §3/§4 核心策略纯函数——移植自规范包 reference/policy.mjs（2026-10-05 冻结版）。
// 纯函数：无 IO、无凭据、无生产状态；所有"已验证"都必须由真实领域适配器在调用前得出，
// 这里绝不接受模型/前端自填的 receipt.verified。
export class PolicyContractError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'PolicyContractError';
    this.code = code;
  }
}

export function requireThat(ok: boolean, code: string): void {
  if (!ok) throw new PolicyContractError(code);
}

const nonNegInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

// —— 提醒范围（§3.2）——
export type ManifestEntry = {
  id: string;
  revision: number;
  seq: number;
  origin: 'dialogue' | 'tool' | 'control' | 'retrieval' | 'protocol';
  visible: boolean;
};

export type ReviewRangeItem = { id: string; revision: number; seq: number };

export const rawKey = (m: { id: string; revision: number }): string => `${m.id}@${m.revision}`;

/**
 * 只提醒"发起 hold 的模型请求实际看见过的真实双方原话"之后的部分（§3.1/§3.2）：
 *  - lastHold 只在本 epoch 内生效；floor=书签的 seenSequence。
 *  - 已完成同消息版本提醒的范围（reviewedKeys）不重复；跨窗携带的旧尾段可用
 *    carriedBeforeBookmarkKeys 做"焦点豁免"（不标 reviewed/held，避免每次轮动强制补记早餐）。
 *  - 工具/控制/检索/协议块不是双方原话（origin!=='dialogue' 或不可见即排除）。
 */
export function selectReviewRange(input: {
  manifest: ManifestEntry[];
  epochId: string;
  lastHold: { epochId: string; seenSequence: number } | null;
  reviewedKeys?: string[];
  carriedBeforeBookmarkKeys?: string[];
}): ReviewRangeItem[] {
  const { manifest, epochId, lastHold } = input;
  const reviewedKeys = input.reviewedKeys ?? [];
  const carriedBeforeBookmarkKeys = input.carriedBeforeBookmarkKeys ?? [];
  requireThat(Array.isArray(manifest), 'MANIFEST_REQUIRED');
  const rows = manifest.filter((m) => m.origin === 'dialogue' && m.visible === true);
  requireThat(rows.every((m) => typeof m.id === 'string' && nonNegInt(m.seq) && nonNegInt(m.revision)), 'MANIFEST_INVALID');
  requireThat(new Set(rows.map(rawKey)).size === rows.length, 'MANIFEST_DUPLICATE');
  const floor = lastHold?.epochId === epochId ? lastHold.seenSequence : -1;
  requireThat(floor === -1 || nonNegInt(floor), 'BOOKMARK_INVALID');
  // F-J-02（联合审计 2026-10-06）：书签高于清单高水位不再判 BOOKMARK_OUTSIDE_MANIFEST。
  // 书签只能由已核实成功收据推进（advanceBookmark 三门），floor > max(清单 seq) 的含义是
  // "发起该 hold 的请求真实看见了 seq=floor 的输入，但其回合未成功落轨迹"（如 hold 成功后
  // 回合被停止/网络失败/轮次超限）。此时清单内全部内容都 ≤ 书签，提醒范围为空=合法
  // ——调用方按 skipped_empty 收口，不叫模型、不伪称全覆盖。清单缺失/损坏/无法重建的
  // 阻塞在调用方（supervisor 的 ROTATION_RANGE_UNKNOWN 路径）与 completeReview
  // （WRITE_UNRESOLVED）维持不变；本函数其余结构守卫（MANIFEST_INVALID/DUPLICATE）不放松。
  const exempt = new Set([...reviewedKeys, ...carriedBeforeBookmarkKeys]);
  return rows.filter((m) => m.seq > floor && !exempt.has(rawKey(m))).map((m) => ({ id: m.id, revision: m.revision, seq: m.seq }));
}

// —— 成功书签（§3.1）——
export type HoldRequest = { id: string; roomId: string; epochId: string; operationId: string; author: 'primary_model' | 'other'; seenSequence: number };
export type HoldReceipt = { id: string; roomId: string; epochId: string; operationId: string; memoryId: string; verified: true; state: 'committed' };
export type Bookmark = { epochId: string; roomId: string; seenSequence: number; requestId: string; receiptId: string; memoryId: string };

/**
 * 只有"当前房间、当前窗口、主模型实际发起、正式成功收据"的 hold 才推进书签；
 * 书签位置取发起请求实际看见的输入位置（request.seenSequence），不是收据到达时的最新消息。
 * 同收据重放不产生新书签；书签不倒退；旧窗迟到收据不推进新窗（epochId 校验）。
 */
export function advanceBookmark(existing: Bookmark | null, request: HoldRequest, receipt: HoldReceipt): Bookmark {
  requireThat(request.author === 'primary_model', 'NOT_PRIMARY_MODEL');
  requireThat(receipt.verified === true && receipt.state === 'committed', 'HOLD_NOT_CONFIRMED');
  requireThat(receipt.roomId === request.roomId && receipt.epochId === request.epochId, 'HOLD_SCOPE_MISMATCH');
  requireThat(receipt.operationId === request.operationId && Boolean(receipt.memoryId), 'HOLD_RECEIPT_MISMATCH');
  requireThat(nonNegInt(request.seenSequence), 'SEEN_SEQUENCE_INVALID');
  if (existing) {
    requireThat(existing.epochId === request.epochId, 'OLD_EPOCH_RECEIPT');
    if (existing.receiptId === receipt.id || existing.seenSequence >= request.seenSequence) return existing;
  }
  return { epochId: request.epochId, roomId: request.roomId, seenSequence: request.seenSequence, requestId: request.id, receiptId: receipt.id, memoryId: receipt.memoryId };
}

// —— 评审完成（§3.3）——
export type RotationReview = {
  id: string;
  roomId: string;
  epochId: string;
  epochRevision: number;
  selected: ReviewRangeItem[];
  status: 'active' | 'completed' | 'failed' | 'skipped_empty';
  decision?: 'no_new_hold' | 'holds_completed';
  memoryIds?: string[];
};

export type SideEffectLedgerEntry = {
  reviewId: string | null;
  kind: 'hold' | 'source_bind' | 'review_complete';
  state: 'pending' | 'running' | 'unknown' | 'failed_unresolved' | 'committed' | 'cancelled' | 'failed_resolved';
  verified: boolean;
  memoryId: string | null;
};

export type ReviewCompleteArgs = { review_id: string; decision: 'no_new_hold' | 'holds_completed' };
export type ToolInvocation = { purpose: string; roomId: string; epochId: string; epochRevision: number };

/**
 * 宿主验证的完成：scope/epoch/revision 匹配、真实副作用账本无未决项、
 * holds_completed 必须真的有已核实成功 hold；同 review 同决定重试幂等。
 */
export function completeReview(review: RotationReview, args: ReviewCompleteArgs, invocation: ToolInvocation, ledger: SideEffectLedgerEntry[]): RotationReview {
  requireThat(review.status === 'active' || review.status === 'completed', 'REVIEW_NOT_ACTIVE');
  requireThat(args.review_id === review.id, 'REVIEW_ID_MISMATCH');
  requireThat(
    invocation.purpose === 'pre_rotate_review' && invocation.roomId === review.roomId && invocation.epochId === review.epochId && invocation.epochRevision === review.epochRevision,
    'REVIEW_SCOPE_MISMATCH',
  );
  requireThat(args.decision === 'no_new_hold' || args.decision === 'holds_completed', 'REVIEW_DECISION_INVALID');
  if (review.status === 'completed') {
    requireThat(review.decision === args.decision, 'REVIEW_DECISION_CONFLICT');
    return review;
  }
  const mine = ledger.filter((x) => x.reviewId === review.id);
  requireThat(mine.every((x) => ['pending', 'running', 'unknown', 'failed_unresolved', 'committed', 'cancelled', 'failed_resolved'].includes(x.state)), 'LEDGER_STATE_INVALID');
  requireThat(!mine.some((x) => ['pending', 'running', 'unknown', 'failed_unresolved'].includes(x.state)), 'WRITE_UNRESOLVED');
  const held = mine.filter((x) => x.kind === 'hold' && x.state === 'committed');
  requireThat(held.every((x) => x.verified && Boolean(x.memoryId)), 'HOLD_NOT_CONFIRMED');
  requireThat(args.decision === 'holds_completed' ? held.length > 0 : held.length === 0, 'REVIEW_LEDGER_MISMATCH');
  return { ...review, status: 'completed', decision: args.decision, memoryIds: [...new Set(held.map((x) => x.memoryId as string))] };
}

// —— 换窗调度（§4.1/§4.2）——
export type RotationPlanResult = {
  effectiveSoft: number;
  effectiveWarning: number;
  safeInput: number;
  action: 'blocked_hard' | 'wait_safe' | 'rotate' | 'warn' | 'continue';
  reason: 'capacity' | 'idle' | null;
};

/**
 * 64k 是一次输入的工作集软线（不是累计计费 token）；有效软线=min(soft, C-O-T-R-S)。
 * idle 比较由调用方传入已算好的间隔（§4.1：入站消息之前的 last_real_user_at，不先更新再相减）。
 */
export function rotationPlan(input: {
  currentInput: number;
  nextInput?: number;
  capacity: number;
  maxOutput: number;
  toolReserve?: number;
  reviewReserve?: number;
  safety?: number;
  soft?: number;
  warning?: number;
  idleMs?: number;
  pendingTurn?: boolean;
  pendingRoute?: boolean;
}): RotationPlanResult {
  const nextInput = input.nextInput ?? input.currentInput;
  const toolReserve = input.toolReserve ?? 8000;
  const reviewReserve = input.reviewReserve ?? 8000;
  const safety = input.safety ?? 4000;
  const soft = input.soft ?? 64000;
  const warning = input.warning ?? 56000;
  const idleMs = input.idleMs ?? 0;
  const nums = [input.currentInput, nextInput, input.capacity, input.maxOutput, toolReserve, reviewReserve, safety, soft, warning, idleMs];
  requireThat(nums.every(nonNegInt), 'TOKEN_OR_TIME_INVALID');
  const safeInput = input.capacity - input.maxOutput - toolReserve - reviewReserve - safety;
  requireThat(safeInput > 0, 'MODEL_CAPACITY_TOO_SMALL');
  const effectiveSoft = Math.min(soft, safeInput);
  const effectiveWarning = Math.max(0, Math.min(warning, effectiveSoft - 8000));
  const common = { effectiveSoft, effectiveWarning, safeInput };
  if (input.currentInput > safeInput) return { ...common, action: 'blocked_hard', reason: 'capacity' };
  const reason = idleMs >= 6 * 60 * 60 * 1000 ? 'idle' : Math.max(input.currentInput, nextInput) >= effectiveSoft ? 'capacity' : null;
  if (reason && ((input.pendingTurn ?? false) || (input.pendingRoute ?? false))) return { ...common, action: 'wait_safe', reason };
  if (reason) return { ...common, action: 'rotate', reason };
  return { ...common, action: Math.max(input.currentInput, nextInput) >= effectiveWarning ? 'warn' : 'continue', reason: null };
}
