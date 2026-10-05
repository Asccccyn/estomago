/** Contract target. Adapt names to existing code, not a new server framework. */
export type Driver = 'openrouter' | 'claude-agent-sdk';
export type Purpose = 'chat' | 'pre_rotate_review' | 'proactive_turn' | 'cache_keepalive';
export type MessageRef = Readonly<{ id:string; revision:number; seq:number; sourceRef?:string }>;
export type DialogueManifest = ReadonlyArray<MessageRef>;
export type ReviewDecision = 'no_new_hold' | 'holds_completed';
export interface ReviewReceipt {
  id:string; roomId:string; epochId:string; epochRevision:number;
  selected:DialogueManifest; status:'active'|'completed'|'failed'|'skipped_empty';
  decision?:ReviewDecision; verifiedHoldIds:readonly string[];
}
export interface NormalizedUsage {
  provider:'openrouter'|'anthropic-native'|'sdk-observed';
  inputSemantics:'total_including_cache'|'uncached_separate'|'unknown';
  inputTotal:number|null; cacheRead:number|null; cacheWrite:number|null;
  noncached:number|null; output:number|null; reasoning:number|null;
  costUsd:number|null; completeness:'complete'|'partial'|'unknown'|'anomaly';
  requestId:string; generationId:string|null; purpose:Purpose;
}
export interface SharedRequest {
  requestId:string; attemptId:string; roomId:string; epochId:string;
  epochRevision:number; purpose:Purpose; seen:DialogueManifest;
  abortController:AbortController;
}
export type DriverRequest = SharedRequest & (
  | {driver:'openrouter'; profileRef:string; trajectoryRef:string; finalPayload:Readonly<Record<string,unknown>>}
  | {driver:'claude-agent-sdk'; assembledSdkOptions:unknown; resumeSessionId:string|null; prompt:string}
);
// Credentials are resolved privately by the selected driver; no secret in these DTOs.
export interface RecordSnapshot {
  roomId:string; cursor:string|null; epochId:string|null; driver:Driver;
  exactModel:string|null;
  context:{estimatedInput:number|null; lastActualInput:number|null; effectiveSoft:number|null; hardCapacity:number|null; estimateQuality:string};
  cache:{requestedTtl:'1h'; lastRead:number|null; lastWrite:number|null; lastNoncached:number|null; lastCostUsd:number|null; observedAt:string|null; estimatedExpiresAt:string|null; keeperEnabled:false};
  review:{id:string; status:string; decision:ReviewDecision|null; holdCount:number|null}|null;
  rawSync:{state:'saved_pending_sync'|'synced'|'partial'|'failed'|'unknown'};
}
export interface RecordEvent {
  eventId:string; sequence:number; roomId:string; occurredAt:string;
  kind:'hold.created'|'source.bound'|'source.sync'|'context.warning'|'review.sent'|'review.completed'|'review.failed'|'window.rotated'|'request.usage'|'runtime.blocked';
  // Metadata only; no prompt, keys, reasoning, or raw private memory text.
  payload:Readonly<Record<string,unknown>>;
}
