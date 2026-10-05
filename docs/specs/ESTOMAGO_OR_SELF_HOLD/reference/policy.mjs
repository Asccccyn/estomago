/** Pure reference logic. No I/O, no network, no production state. */
export class ContractError extends Error {
  constructor(code) { super(code); this.name = 'ContractError'; this.code = code; }
}
export function requireThat(ok, code) { if (!ok) throw new ContractError(code); }
const int = x => Number.isSafeInteger(x) && x >= 0;
export const rawKey = m => `${m.id}@${m.revision}`;

/** Caller supplies only the authorized snapshot actually present in this epoch. */
export function selectReviewRange({manifest, epochId, lastHold = null,
  reviewedKeys = [], carriedBeforeBookmarkKeys = []}) {
  requireThat(Array.isArray(manifest), 'MANIFEST_REQUIRED');
  const rows = manifest.filter(m => m.origin === 'dialogue' && m.visible === true);
  requireThat(rows.every(m => typeof m.id === 'string' && int(m.seq) && int(m.revision)), 'MANIFEST_INVALID');
  requireThat(new Set(rows.map(rawKey)).size === rows.length, 'MANIFEST_DUPLICATE');
  const floor = lastHold?.epochId === epochId ? lastHold.seenSequence : -1;
  requireThat(floor === -1 || int(floor), 'BOOKMARK_INVALID');
  requireThat(rows.length===0 || floor<=Math.max(...rows.map(m=>m.seq)), 'BOOKMARK_OUTSIDE_MANIFEST');
  const exempt = new Set([...reviewedKeys, ...carriedBeforeBookmarkKeys]);
  return rows.filter(m => m.seq > floor && !exempt.has(rawKey(m)))
    .map(m => ({id:m.id, revision:m.revision, seq:m.seq}));
}

/** The receipt MUST already be verified by the real Mariposa adapter. */
export function advanceBookmark(existing, request, receipt) {
  requireThat(request.author === 'primary_model', 'NOT_PRIMARY_MODEL');
  requireThat(receipt.verified === true && receipt.state === 'committed', 'HOLD_NOT_CONFIRMED');
  requireThat(receipt.roomId === request.roomId && receipt.epochId === request.epochId, 'HOLD_SCOPE_MISMATCH');
  requireThat(receipt.operationId === request.operationId && !!receipt.memoryId, 'HOLD_RECEIPT_MISMATCH');
  requireThat(int(request.seenSequence), 'SEEN_SEQUENCE_INVALID');
  if (existing) {
    requireThat(existing.epochId === request.epochId, 'OLD_EPOCH_RECEIPT');
    if (existing.receiptId === receipt.id || existing.seenSequence >= request.seenSequence) return existing;
  }
  return {epochId:request.epochId, roomId:request.roomId, seenSequence:request.seenSequence,
    requestId:request.id, receiptId:receipt.id, memoryId:receipt.memoryId};
}

export function completeReview(review, args, invocation, ledger) {
  requireThat(review.status === 'active' || review.status === 'completed', 'REVIEW_NOT_ACTIVE');
  requireThat(args.review_id === review.id, 'REVIEW_ID_MISMATCH');
  requireThat(invocation.purpose === 'pre_rotate_review' && invocation.roomId === review.roomId &&
    invocation.epochId === review.epochId && invocation.epochRevision === review.epochRevision,
    'REVIEW_SCOPE_MISMATCH');
  requireThat(['no_new_hold', 'holds_completed'].includes(args.decision), 'REVIEW_DECISION_INVALID');
  if (review.status === 'completed') {
    requireThat(review.decision === args.decision, 'REVIEW_DECISION_CONFLICT');
    return review;
  }
  const mine = ledger.filter(x => x.reviewId === review.id);
  requireThat(mine.every(x=>['pending','running','unknown','failed_unresolved','committed','cancelled','failed_resolved'].includes(x.state)), 'LEDGER_STATE_INVALID');
  requireThat(!mine.some(x => ['pending','running','unknown','failed_unresolved'].includes(x.state)), 'WRITE_UNRESOLVED');
  const held = mine.filter(x => x.kind === 'hold' && x.state === 'committed');
  requireThat(held.every(x => x.verified && !!x.memoryId), 'HOLD_NOT_CONFIRMED');
  requireThat(args.decision === 'holds_completed' ? held.length > 0 : held.length === 0, 'REVIEW_LEDGER_MISMATCH');
  return {...review, status:'completed', decision:args.decision,
    memoryIds:[...new Set(held.map(x => x.memoryId))]};
}

export function rotationPlan({currentInput, nextInput = currentInput, capacity, maxOutput,
  toolReserve=8000, reviewReserve=8000, safety=4000, soft=64000, warning=56000,
  idleMs=0, pendingTurn=false, pendingRoute=false}) {
  const nums = [currentInput,nextInput,capacity,maxOutput,toolReserve,reviewReserve,safety,soft,warning,idleMs];
  requireThat(nums.every(int), 'TOKEN_OR_TIME_INVALID');
  const safeInput = capacity-maxOutput-toolReserve-reviewReserve-safety;
  requireThat(safeInput > 0, 'MODEL_CAPACITY_TOO_SMALL');
  const effectiveSoft = Math.min(soft,safeInput);
  const effectiveWarning = Math.max(0,Math.min(warning,effectiveSoft-8000));
  const common = {effectiveSoft,effectiveWarning,safeInput};
  if (currentInput > safeInput) return {...common,action:'blocked_hard',reason:'capacity'};
  const reason = idleMs >= 6*60*60*1000 ? 'idle' :
    Math.max(currentInput,nextInput) >= effectiveSoft ? 'capacity' : null;
  if (reason && (pendingTurn || pendingRoute)) return {...common,action:'wait_safe',reason};
  if (reason) return {...common,action:'rotate',reason};
  return {...common,action:Math.max(currentInput,nextInput) >= effectiveWarning ? 'warn' : 'continue',reason:null};
}

/** OR cache figures classify prompt_tokens. Missing never becomes zero. */
export function normalizeOrUsage(usage) {
  const n = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  if (!usage) return {inputTotal:null,cacheRead:null,cacheWrite:null,noncached:null,output:null,
    reasoning:null,cost:null,completeness:'unknown',anomalies:[]};
  const total=n(usage.prompt_tokens), read=n(usage.prompt_tokens_details?.cached_tokens);
  const write=n(usage.prompt_tokens_details?.cache_write_tokens), output=n(usage.completion_tokens);
  const reasoning=n(usage.completion_tokens_details?.reasoning_tokens), cost=n(usage.cost);
  const anomalies=[];
  let noncached = null;
  if ([total,read,write].every(x => x !== null)) {
    if (read+write > total) anomalies.push('CACHE_CATEGORIES_EXCEED_PROMPT');
    else noncached=total-read-write;
  }
  if (output !== null && reasoning !== null && reasoning>output) anomalies.push('REASONING_EXCEEDS_OUTPUT');
  return {inputTotal:total,cacheRead:read,cacheWrite:write,noncached,output,reasoning,cost,
    completeness:anomalies.length ? 'anomaly' : [total,read,write,output,cost].every(x=>x!==null) ? 'complete':'partial',
    anomalies};
}
