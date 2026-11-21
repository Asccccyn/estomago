import type { Db } from '../db/connection.ts';
import type { ManifestEntry } from '../context/review-policy.ts';
import type { ToolExecResult } from '../capabilities/contracts.ts';
import type { OrMessage } from './or-payload.ts';
import { toolResultContent } from '../media/model-input.ts';
import { sha256Hex } from '../util/id.ts';

export type CompletionBatch = {
  tail: OrMessage[];
  inFlight: string[];
  sentMessages: OrMessage[];
};

type CompletionProof = {
  phase?: 'heartbeat_batch';
  requestId: string;
  priorTrajectory: string;
  tail: OrMessage[];
  inFlight: string[];
  manifestAdditions: ManifestEntry[];
  confirmedSeen: ManifestEntry[];
  pendingSeen: ManifestEntry[];
  heartbeatHostText?: string;
};

type ProviderInput = {
  payload_json: string;
  sent_at: string;
  outcome: string | null;
  dispatch_started_at: string;
};

export function observedCompletionInput(db: Db, scope: { requestId: string; windowId: string; turnId: string; attemptId: string }): ProviderInput | undefined {
  return db.prepare(`
    SELECT payload_json,sent_at,outcome,dispatch_started_at FROM provider_requests
     WHERE id=? AND window_id=? AND turn_id=? AND attempt_id=?
       AND sent_at IS NOT NULL AND dispatch_started_at IS NOT NULL
  `).get(scope.requestId, scope.windowId, scope.turnId, scope.attemptId) as ProviderInput | undefined;
}

export function completionInputMessages(input: ProviderInput): OrMessage[] {
  const { messages } = JSON.parse(input.payload_json) as { messages?: OrMessage[] };
  if (!Array.isArray(messages)) throw new Error('TURN_COMPLETION_RECOVERY_INPUT_INVALID');
  return messages;
}

export function currentTrajectoryHash(db: Db, windowId: string): string | null {
  const row = db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id=?').get(windowId) as { messages_json: string } | undefined;
  return row ? sha256Hex(row.messages_json) : null;
}

function toolCalls(tail: OrMessage[]): string[] {
  return tail.flatMap(message => message.role === 'assistant' && Array.isArray(message.tool_calls)
    ? (message.tool_calls as Array<{ id: string }>).map(call => call.id) : []);
}

function completionResult(id: string, receipt: ToolExecResult): OrMessage {
  return { role: 'tool', tool_call_id: id, content: toolResultContent(receipt) };
}

/** Called synchronously inside the transaction that wins the completion CAS.
 * The existing protected request ledger provides the prefix; only this round's
 * exact response tail is staged. A staged tail carries no upstream delivery claim. */
export function stageTurnCompletion(db: Db, args: {
  requestId: string; windowId: string; turnId: string; attemptId: string; callId: string;
  batch: CompletionBatch; receipt: ToolExecResult; manifestAdditions: readonly ManifestEntry[];
  confirmedSeen: ManifestEntry[]; pendingSeen: ManifestEntry[]; heartbeatHostText?: string;
}): void {
  const input = observedCompletionInput(db, args);
  const trajectoryHash = currentTrajectoryHash(db, args.windowId);
  const ids = toolCalls(args.batch.tail);
  if (!input || !trajectoryHash || !ids.includes(args.callId)
      || JSON.stringify(completionInputMessages(input)) !== JSON.stringify(args.batch.sentMessages)) {
    throw new Error('TURN_COMPLETION_RECOVERY_EVIDENCE_MISSING');
  }
  const proof: CompletionProof = {
    requestId: args.requestId, priorTrajectory: trajectoryHash,
    tail: [...args.batch.tail, completionResult(args.callId, args.receipt)],
    inFlight: args.batch.inFlight.filter(id => id !== args.callId && ids.includes(id)),
    manifestAdditions: [...args.manifestAdditions], confirmedSeen: args.confirmedSeen, pendingSeen: args.pendingSeen,
    ...(args.heartbeatHostText !== undefined ? { heartbeatHostText: args.heartbeatHostText } : {}),
  };
  db.prepare('UPDATE attempts SET completion_recovery_json=? WHERE id=? AND turn_id=?')
    .run(JSON.stringify(proof), args.attemptId, args.turnId);
}

/** The same recovery slot also protects an ordinary heartbeat tool batch
 * before the completion CAS. The confirmed request is the sole prefix;
 * only its observed assistant tool packet and unsent receipts live here. */
export function stageHeartbeatBatch(db: Db, args: {
  requestId: string; windowId: string; turnId: string; attemptId: string;
  batch: CompletionBatch; confirmedSeen: ManifestEntry[]; heartbeatHostText?: string;
}): void {
  const existing = db.prepare('SELECT completion_outcome,completion_recovery_json FROM attempts WHERE id=? AND turn_id=?')
    .get(args.attemptId, args.turnId) as { completion_outcome: string | null; completion_recovery_json: string | null } | undefined;
  if (existing?.completion_outcome) return;
  const prior = existing?.completion_recovery_json ? readCompletionProof(existing.completion_recovery_json) : null;
  if (prior?.phase === 'heartbeat_batch' && prior.requestId === args.requestId) return;
  const input = observedCompletionInput(db, args);
  const trajectoryHash = currentTrajectoryHash(db, args.windowId);
  if (!input || !trajectoryHash || toolCalls(args.batch.tail).length === 0
    || JSON.stringify(completionInputMessages(input)) !== JSON.stringify(args.batch.sentMessages)) {
    throw new Error('HEARTBEAT_BATCH_RECOVERY_EVIDENCE_MISSING');
  }
  const proof: CompletionProof = {
    phase: 'heartbeat_batch', requestId: args.requestId, priorTrajectory: trajectoryHash, tail: structuredClone(args.batch.tail),
    inFlight: [], manifestAdditions: [], confirmedSeen: [...args.confirmedSeen], pendingSeen: [],
    heartbeatHostText: args.heartbeatHostText,
  };
  db.prepare('UPDATE attempts SET completion_recovery_json=? WHERE id=? AND turn_id=? AND completion_outcome IS NULL')
    .run(JSON.stringify(proof), args.attemptId, args.turnId);
}

export function markHeartbeatToolStarted(db: Db, attemptId: string, requestId: string, callId: string): void {
  const row = db.prepare('SELECT completion_recovery_json FROM attempts WHERE id=? AND completion_outcome IS NULL').get(attemptId) as
    { completion_recovery_json: string | null } | undefined;
  if (!row?.completion_recovery_json) return;
  const proof = readCompletionProof(row.completion_recovery_json);
  if (proof.phase !== 'heartbeat_batch' || proof.requestId !== requestId || !toolCalls(proof.tail).includes(callId)) return;
  if (!proof.inFlight.includes(callId)) proof.inFlight.push(callId);
  db.prepare('UPDATE attempts SET completion_recovery_json=? WHERE id=?').run(JSON.stringify(proof), attemptId);
}

export function appendCompletionToolReceipt(db: Db, attemptId: string, callId: string, receipt: ToolExecResult, pendingSeen: ManifestEntry[]): void {
  const row = db.prepare('SELECT completion_recovery_json FROM attempts WHERE id=? AND completion_recovery_json IS NOT NULL')
    .get(attemptId) as { completion_recovery_json: string } | undefined;
  if (!row) return;
  const proof = JSON.parse(row.completion_recovery_json) as CompletionProof;
  if (!toolCalls(proof.tail).includes(callId) || proof.tail.some(message => message.role === 'tool' && message.tool_call_id === callId)) return;
  proof.tail.push(completionResult(callId, receipt));
  if (receipt.ok) proof.pendingSeen.push(...pendingSeen);
  db.prepare('UPDATE attempts SET completion_recovery_json=? WHERE id=?')
    .run(JSON.stringify(proof), attemptId);
}

export function readCompletionProof(raw: string): CompletionProof {
  return JSON.parse(raw) as CompletionProof;
}

export function completeRecoveredToolTail(proof: CompletionProof,
  resolveMissing?: (callId: string) => ToolExecResult | undefined): { tail: OrMessage[]; unknown: boolean } {
  const answered = new Map(proof.tail.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message]));
  let unknown = false;
  const tail = proof.tail.filter(message => message.role !== 'tool').flatMap(message => [
    message,
    ...toolCalls([message]).map(id => {
      const observed = answered.get(id);
      if (observed) return observed;
      const receipt = resolveMissing?.(id);
      if (receipt) return completionResult(id, receipt);
      const inFlight = proof.inFlight.includes(id);
      unknown ||= inFlight;
      return completionResult(id, { ok: false, output: inFlight
        ? { error_code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN', outcome: 'unknown' }
        : { error_code: proof.phase === 'heartbeat_batch' ? 'EXECUTION_NOT_STARTED' : 'TURN_COMPLETED', executed: false } });
    }),
  ]);
  return { tail, unknown };
}
