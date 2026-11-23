// 后台回合收口、规范协议提交及现有活动计时。
import { tx, type Db } from '../db/connection.ts';
import type { HeartbeatRuntime } from '../modules/heartbeat/runtime.ts';
import type { HeartbeatMode, HeartbeatSpeechHold } from '../modules/heartbeat/service.ts';
import type { OrMessage } from './or-payload.ts';
import type { RunnerRunResult } from './runner.ts';
import { tailBoundaryOf } from './cache-plan.ts';
import type { ManifestEntry } from '../context/review-policy.ts';
import type { SupervisorDeps } from './supervisor.ts';
import { readTurnCompletion } from './turn-completion.ts';

export type BackgroundOutcomeInput = {
  db: Db;
  trajectory: SupervisorDeps['trajectory'];
  activity: SupervisorDeps['activity'];
  kind: 'autonomous' | 'keepwarm';
  runId: string;
  conversationId: string;
  windowId: string;
  turnId: string;
  attemptId: string;
  baseManifest: ManifestEntry[];
  capturedActivityRevision: number | null;
  toolCallsObserved: number;
  isCancelRequested: () => boolean;
  recoveredRequestId?: string;
  heartbeat?: { runtime: HeartbeatRuntime; mode: HeartbeatMode; hostText: string };
  /** Stop condition holding when this run would speak into the chat (null = none). */
  speechHold?: HeartbeatSpeechHold | null;
  loop: {
    result: RunnerRunResult;
    finalMessages: OrMessage[] | null;
    lastSentMessages: OrMessage[] | null;
    toolSeen: ManifestEntry[];
    pendingToolSeen: ManifestEntry[];
  };
};

export function classifyBackgroundOutcome(input: BackgroundOutcomeInput): { outcome: 'completed' | 'noop' | 'failed' | 'unknown'; result_code?: string } {
  const { db, loop, kind, runId, heartbeat } = input;
  const completed = loop.result.outcome === 'completed' && !loop.result.errorCode;
  const sleepPaused = loop.result.errorCode?.startsWith('KEEPWARM_SLEEP_') === true;
  const restPaused = loop.result.errorCode === 'KEEPWARM_RESTING';
  const yielded = loop.result.errorCode?.startsWith('KEEPWARM_YIELDED') === true;
  const observed = heartbeat ? db.prepare(`
    SELECT payload_json
    FROM provider_requests WHERE background_run_id=? AND sent_at IS NOT NULL
      AND (? IS NULL OR id=?)
    ORDER BY rowid DESC LIMIT 1
  `).get(runId,input.recoveredRequestId ?? null,input.recoveredRequestId ?? null) as
    { payload_json: string | null } | undefined : null;
  const sent = observed?.payload_json ? (JSON.parse(observed.payload_json) as { messages?: OrMessage[] }).messages : undefined;
  const finalMessages = heartbeat ? sent ? loop.finalMessages ?? sent : null : loop.finalMessages;
  const last = finalMessages?.at(-1);
  const lastText = last?.role === 'assistant' && !(Array.isArray(last.tool_calls) && last.tool_calls.length)
    ? typeof last.content === 'string' ? last.content
      : last.content.filter(block => block.type === 'text').map(block => block.text).join('')
    : null;
  const exhausted = heartbeat?.mode === 'exhausted_keepwarm';
  const exhaustedReply = exhausted && completed && Boolean(observed) && lastText?.trim() === '1';
  const missingExhaustedReply = exhausted && completed && !exhaustedReply;
  const paused = sleepPaused || restPaused;
  // Speech that a stop condition held back was never said to her. Keep the run's
  // real facts and record why nothing reached the chat, instead of a late resend.
  const speechHold = heartbeat && completed && !missingExhaustedReply ? input.speechHold ?? null : null;
  // A held-back final reply is not canonical history either: the next turn must
  // not continue from words she never saw. Sent requests and tool receipts stay.
  const heldBackReply = speechHold !== null && last?.role === 'assistant';
  const finishedState = yielded ? 'interrupted' : (completed && !missingExhaustedReply) || paused ? 'completed' : 'failed';
  const finishReason = missingExhaustedReply ? 'HEARTBEAT_EXHAUSTED_REPLY_MISSING' : loop.result.errorCode;
  // Only the current heartbeat's unobserved card payload can be withheld. Its
  // actual tool call and a protocol-valid same-ID receipt remain in the history.
  if (heartbeat) {
    heartbeat.runtime.closeProtocol(runId, heldBackReply && sent ? sent : finalMessages ?? [], sent ?? null);
  }

  const published = (conn: Db) => conn.prepare(`
    SELECT id,sequence,current_revision FROM messages
    WHERE turn_id=? AND speaker='assistant' ORDER BY sequence
  `).all(input.turnId) as Array<{ id: string; sequence: number; current_revision: number }>;
  let heartbeatEvents: ReturnType<HeartbeatRuntime['commitInTx']>['eventRows'] = [];
  const reason = (): NonNullable<Parameters<HeartbeatRuntime['commitInTx']>[0]['terminal']>['reason'] => speechHold === 'disabled' ? 'other'
    : speechHold ?? (restPaused ? 'rest' : sleepPaused ? 'sleep' : finishReason === 'BUDGET_ESTIMATE_UNAVAILABLE' ? 'quote' : /BUDGET/.test(finishReason ?? '') ? 'budget'
      : /YIELDED/.test(finishReason ?? '') ? 'yield' : finishReason === 'HEARTBEAT_CARD_DISPATCH_UNKNOWN' ? 'delivery' : 'other');
  const terminal = (): NonNullable<Parameters<HeartbeatRuntime['commitInTx']>[0]['terminal']> => ({
    status: heartbeat?.runtime.hasUnknownDelivery(runId) || finishReason === 'TOOL_EXECUTION_OUTCOME_UNKNOWN' || finishReason === 'HOST_RESTART_MID_RUN' ? 'unknown'
      : input.isCancelRequested() || /CANCELLED|STOPPED|YIELDED/.test(finishReason ?? '') || paused || speechHold ? 'cancelled'
      : completed ? 'completed' : 'failed',
    ...(speechHold || finishReason ? { reason: reason() } : {}),
  });
  const finishTurn = (conn: Db): void => {
    const now = new Date().toISOString();
    conn.prepare('UPDATE turns SET state=?,completed_at=? WHERE id=?').run(finishedState, now, input.turnId);
    conn.prepare('UPDATE attempts SET state=?,blocked_reason=?,completed_at=? WHERE id=?').run(finishedState, finishReason, now, input.attemptId);
    conn.prepare("UPDATE background_runs SET tool_calls_observed=?,published_message_count=?,retention='retained',updated_at=? WHERE id=?")
      .run(input.toolCallsObserved, published(conn).length, now, runId);
    // A recovered full tool-call batch proves this request even if its local
    // SDK stop was interrupted. Cache/usage evidence stays untouched.
    if (kind === 'keepwarm' && completed && input.activity && input.capturedActivityRevision !== null) {
      const request = db.prepare(`
        SELECT id,dispatch_started_at FROM provider_requests
        WHERE background_run_id=? AND (outcome='completed' OR id=?) AND sent_at IS NOT NULL AND dispatch_started_at IS NOT NULL
        ORDER BY dispatch_started_at DESC,rowid DESC LIMIT 1
      `).get(runId, input.recoveredRequestId ?? null) as { id: string; dispatch_started_at: string } | undefined;
      if (request) input.activity.noteMaintenanceReceipt({
        conversationId: input.conversationId, capturedActivityRevision: input.capturedActivityRevision,
        requestId: request.id, windowId: input.windowId, dispatchStartedAtIso: request.dispatch_started_at,
      });
    }
  };
  if (input.trajectory && finalMessages !== null) {
    const publishedEntries = published(db).map((message): ManifestEntry => ({
      id: message.id, revision: message.current_revision, seq: message.sequence, origin: 'dialogue', visible: true,
    }));
    const manifest = [...input.baseManifest, ...publishedEntries, ...loop.toolSeen,
      ...loop.pendingToolSeen.map(entry => ({ ...entry, visible: false, pending_dispatch: true as const }))];
    let boundary = input.trajectory.forWindow(input.windowId)?.lastBoundary ?? null;
    if (!heartbeat) boundary = tailBoundaryOf(loop.lastSentMessages ?? finalMessages);
    else if (sent) boundary = tailBoundaryOf(sent);
    const retained = heldBackReply && sent ? sent : finalMessages;
    input.trajectory.replace(input.windowId, retained, boundary, manifest, (conn) => {
      if (heartbeat) {
        const projection = heartbeat.runtime.commitInTx({
          runId, conversationId: input.conversationId, turnId: input.turnId, attemptId: input.attemptId,
          hostText: heartbeat.hostText, finalMessages: retained, mode: heartbeat.mode,
          completed, hadSent: Boolean(observed),
          responseOffset: sent?.length, terminal: terminal(), speechHold,
        });
        if (projection.manifest.length) {
          const known = new Set(manifest.map(entry => entry.id));
          const additions = projection.manifest.filter(entry => !known.has(entry.id));
          conn.prepare('UPDATE window_trajectories SET manifest_json=? WHERE window_id=?')
            .run(JSON.stringify([...manifest, ...additions]), input.windowId);
        }
        heartbeatEvents = projection.eventRows;
      }
      const at = new Date().toISOString();
      const stamped = conn.prepare('UPDATE background_runs SET trajectory_committed_at=?,updated_at=? WHERE id=? AND window_id=? AND turn_id=?')
        .run(at, at, runId, input.windowId, input.turnId);
      if (Number(stamped.changes) !== 1) throw new Error('BACKGROUND_TRAJECTORY_RUN_MISMATCH');
      finishTurn(conn);
    });
  } else {
    tx(db, () => {
      // A confirmed invitation may be visible even if the first response
      // disconnects before an assistant/tool message forms a canonical tail.
      // Record display/terminal facts now without manufacturing a trajectory.
      if (heartbeat && observed) {
        const projection = heartbeat.runtime.commitInTx({
          runId, conversationId: input.conversationId, turnId: input.turnId, attemptId: input.attemptId,
          hostText: heartbeat.hostText, finalMessages: [], mode: heartbeat.mode, completed: false, hadSent: true,
          terminal: terminal(),
        });
        heartbeatEvents = projection.eventRows;
      }
      finishTurn(db);
    });
  }
  if (heartbeatEvents.length) heartbeat?.runtime.dispatchEvents(heartbeatEvents);

  if (yielded && !heartbeat?.runtime.hasUnknownDelivery(runId)) return { outcome: 'noop', result_code: loop.result.errorCode! };
  if (speechHold) return { outcome: 'noop', result_code: speechHold === 'rest' ? 'KEEPWARM_RESTING' : speechHold === 'sleep' ? 'KEEPWARM_SLEEP_WINDOW' : 'KEEPWARM_DISABLED' };
  if (loop.result.outcome !== 'completed') {
    if (input.heartbeat?.runtime.hasUnknownDelivery(runId)) return { outcome: 'unknown', result_code: 'HEARTBEAT_CARD_DISPATCH_UNKNOWN' };
    if (loop.result.errorCode === 'TOOL_EXECUTION_OUTCOME_UNKNOWN') return { outcome: 'unknown', result_code: loop.result.errorCode };
    if (loop.result.errorCode === 'HOST_RESTART_MID_RUN') return { outcome: 'unknown', result_code: loop.result.errorCode };
    if (input.isCancelRequested()) return { outcome: 'completed', result_code: 'CANCELLED_MID_RUN' };
    if (paused) return { outcome: 'noop', result_code: loop.result.errorCode! };
    return { outcome: 'failed', result_code: loop.result.errorCode ?? (kind === 'keepwarm' ? 'KEEPWARM_FAILED' : 'AUTONOMOUS_FAILED') };
  }
  if (paused) return { outcome: 'completed', result_code: loop.result.errorCode! };
  if (missingExhaustedReply) return { outcome: 'failed', result_code: 'HEARTBEAT_EXHAUSTED_REPLY_MISSING' };
  if (exhaustedReply) return { outcome: 'completed', result_code: 'ack_only' };
  const completion = readTurnCompletion(db, input.attemptId, input.turnId);
  return completion === 'noop' ? { outcome: 'noop', result_code: 'complete:noop' }
    : { outcome: 'completed', result_code: 'complete:done' };
}
