import type { Db } from '../db/connection.ts';
import type { ManifestEntry } from '../context/review-policy.ts';
import type { StreamEventRow } from '../events/service.ts';
import type { HeartbeatMode } from '../modules/heartbeat/service.ts';
import { classifyBackgroundOutcome } from './background-outcome.ts';
import { settleBackgroundRun } from './background-ledger.ts';
import { tailBoundaryOf } from './cache-plan.ts';
import type { RunnerRunResult } from './runner.ts';
import type { SupervisorDeps } from './supervisor.ts';
import type { OrMessage } from './or-payload.ts';
import type { OrRequestEnvelope } from './runner.ts';
import type { HeartbeatAction } from '../../../../packages/contracts/src/heartbeat.ts';
import type { ToolExecResult } from '../capabilities/contracts.ts';
import {
  completeRecoveredToolTail, completionInputMessages, currentTrajectoryHash, observedCompletionInput, readCompletionProof,
} from './turn-completion-checkpoint.ts';
import type { TurnCompletion } from './turn-completion.ts';

type RecoveredOutcome = ReturnType<typeof classifyBackgroundOutcome>;
type FinishBackground = (runId: string, outcome: RecoveredOutcome) => void;
type Candidate = {
  attemptId: string;
  turnId: string;
  windowId: string;
  conversationId: string;
  generation: number;
  state: string;
  blockedReason: string | null;
  outcome: TurnCompletion;
  proof: string;
  runId: string | null;
  kind: 'autonomous' | 'keepwarm' | null;
  activityRevision: number | null;
  toolCallsObserved: number | null;
  heartbeatMode: HeartbeatMode | null;
};

export function recoverAcceptedCompletions(
  deps: Pick<SupervisorDeps, 'db' | 'trajectory' | 'heartbeat' | 'activity' | 'events' | 'logger'>,
  finishBackground?: FinishBackground,
): void {
  const { db, trajectory } = deps;
  if (!trajectory) return;
  const rows = db.prepare(`
    SELECT a.id AS attemptId,a.state,a.blocked_reason AS blockedReason,t.id AS turnId,a.window_id AS windowId,
           t.conversation_id AS conversationId,t.generation,a.completion_outcome AS outcome,
           a.completion_recovery_json AS proof,b.id AS runId,b.kind,b.input_activity_revision AS activityRevision,
           b.tool_calls_observed AS toolCallsObserved,h.mode AS heartbeatMode
      FROM attempts a JOIN turns t ON t.id=a.turn_id
      LEFT JOIN background_runs b ON b.turn_id=t.id AND b.window_id=a.window_id
      LEFT JOIN heartbeat_runs h ON h.run_id=b.id
     WHERE a.completion_outcome IS NOT NULL AND a.completion_recovery_json IS NOT NULL
       AND (a.state='running' OR (a.state IN ('completed','failed') AND b.state='running' AND b.trajectory_committed_at IS NOT NULL))
     ORDER BY a.rowid
  `).all() as Candidate[];

  for (const row of rows) {
    try {
      // Another failure after the canonical commit may leave only scheduler
      // finalization pending. Its existing CAS handles the task/occurrence.
      if (row.state !== 'running' && row.runId) {
        const outcome = row.state === 'completed'
          ? { outcome: row.outcome === 'noop' ? 'noop' : 'completed', result_code: `complete:${row.outcome}` } as const
          : { outcome: 'unknown', result_code: row.blockedReason ?? 'TOOL_EXECUTION_OUTCOME_UNKNOWN' } as const;
        finishBackground?.(row.runId, outcome);
        continue;
      }
      const proof = readCompletionProof(row.proof);
      const base = trajectory.forWindow(row.windowId);
      const observed = observedCompletionInput(db, { ...row, requestId: proof.requestId });
      if (!base || !observed || currentTrajectoryHash(db, row.windowId) !== proof.priorTrajectory) {
        throw new Error('TURN_COMPLETION_RECOVERY_EVIDENCE_MISMATCH');
      }
      const sent = completionInputMessages(observed);
      const { tail, unknown } = completeRecoveredToolTail(proof);
      const finalMessages = [...sent, ...tail];
      const result: RunnerRunResult = {
        outcome: unknown ? 'error' : 'completed',
        errorClassified: unknown ? 'unknown' : null,
        errorCode: unknown ? 'TOOL_EXECUTION_OUTCOME_UNKNOWN' : null,
        errorMessage: null, sessionId: null, requestId: null,
      };

      if (row.runId && row.kind && finishBackground) {
        // Account only already observed usage. No request or external action
        // may be reissued by completion recovery.
        settleBackgroundRun(db, row.runId);
        const outcome = classifyBackgroundOutcome({
          db, trajectory, activity: deps.activity, ...row, runId: row.runId, kind: row.kind,
          baseManifest: base.manifest ?? [], capturedActivityRevision: row.activityRevision,
          toolCallsObserved: Math.max(row.toolCallsObserved ?? 0, proof.tail.filter(message => message.role === 'tool').length),
          isCancelRequested: () => false, recoveredRequestId: proof.requestId,
          loop: { result, finalMessages, lastSentMessages: sent, toolSeen: proof.confirmedSeen, pendingToolSeen: proof.pendingSeen },
          ...(deps.heartbeat && row.heartbeatMode && proof.heartbeatHostText !== undefined
            ? { heartbeat: { runtime: deps.heartbeat, mode: row.heartbeatMode, hostText: proof.heartbeatHostText } } : {}),
        });
        finishBackground(row.runId, outcome);
        continue;
      }
      if (row.runId) throw new Error('TURN_COMPLETION_RECOVERY_SCHEDULER_MISSING');

      const published = (db.prepare(`
        SELECT id,sequence,current_revision FROM messages WHERE turn_id=? AND speaker='assistant'
          AND published_at IS NOT NULL ORDER BY sequence
      `).all(row.turnId) as Array<{ id: string; sequence: number; current_revision: number }>)
        .map((message): ManifestEntry => ({ id: message.id, seq: message.sequence, revision: message.current_revision, origin: 'dialogue', visible: true }));
      const pending = proof.pendingSeen.map(entry => ({ ...entry, pending_dispatch: true as const, visible: false }));
      const manifest = [...base.manifest ?? [], ...proof.manifestAdditions, ...published, ...proof.confirmedSeen, ...pending];
      let event: StreamEventRow | undefined;
      trajectory.replace(row.windowId, finalMessages, tailBoundaryOf(sent), manifest, (conn: Db) => {
        const at = new Date().toISOString();
        const state = unknown ? 'failed' : 'completed';
        conn.prepare('UPDATE attempts SET state=?,blocked_reason=?,completed_at=?,completion_recovery_json=NULL WHERE id=?')
          .run(state, result.errorCode, at, row.attemptId);
        conn.prepare('UPDATE turns SET state=?,completed_at=? WHERE id=?').run(state, at, row.turnId);
        event = deps.events.persistInTx(unknown ? 'turn.status' : 'turn.completed', {
          conversationId: row.conversationId, turnId: row.turnId, attemptId: row.attemptId,
          payload: unknown ? { state, reason: result.errorCode } : { generation: row.generation, session_id: null },
        });
      });
      if (event) deps.events.dispatchRow(event);
    } catch {
      deps.logger.warn('turn_completion_recovery_failed', { attempt_id: row.attemptId, code: 'TURN_COMPLETION_EVIDENCE_UNAVAILABLE' });
      // Leave the ordinary orphan handling in charge of attempts with
      // missing or inconsistent evidence. Never manufacture a protocol tail.
    }
  }
}

type InterruptedHeartbeat = {
  runId: string; attemptId: string; turnId: string; windowId: string; conversationId: string;
  proof: string; mode: HeartbeatMode; toolCallsObserved: number; activityRevision: number | null;
};

/** Recover the confirmed request prefix of an ordinary interrupted heartbeat.
 * Never reschedule its model or source writes. The accepted-completion path
 * remains the first and stronger checkpoint; both paths use the same
 * trajectory/outbox transaction and run CAS. */
export function recoverInterruptedHeartbeats(
  deps: Pick<SupervisorDeps, 'db' | 'trajectory' | 'heartbeat' | 'activity' | 'logger'>,
  finishBackground: FinishBackground | undefined,
  compact?: (messages: OrMessage[], sentCount: number, tools: OrRequestEnvelope['tools'], maxTokens: number) => Set<string>,
): void {
  const { db, trajectory, heartbeat } = deps;
  if (!trajectory || !heartbeat || !finishBackground) return;
  const rows = db.prepare(`SELECT b.id AS runId,a.id AS attemptId,t.id AS turnId,a.window_id AS windowId,
      t.conversation_id AS conversationId,a.completion_recovery_json AS proof,h.mode AS mode,
      b.tool_calls_observed AS toolCallsObserved,b.input_activity_revision AS activityRevision
    FROM background_runs b JOIN heartbeat_runs h ON h.run_id=b.id
    JOIN turns t ON t.id=b.turn_id AND t.conversation_id=b.conversation_id
    JOIN attempts a ON a.turn_id=t.id AND a.window_id=b.window_id
    WHERE b.kind='keepwarm' AND b.state IN ('running','cancelling') AND b.trajectory_committed_at IS NULL
      AND a.state='running' AND a.completion_outcome IS NULL AND a.completion_recovery_json IS NOT NULL
    ORDER BY a.rowid`).all() as InterruptedHeartbeat[];
  for (const row of rows) {
    try {
      const proof = readCompletionProof(row.proof);
      if (proof.phase !== 'heartbeat_batch' || proof.heartbeatHostText === undefined) continue;
      const base = trajectory.forWindow(row.windowId);
      const earlier = observedCompletionInput(db, { ...row, requestId: proof.requestId });
      if (!base || !earlier || currentTrajectoryHash(db, row.windowId) !== proof.priorTrajectory) {
        throw new Error('HEARTBEAT_RECOVERY_EVIDENCE_MISMATCH');
      }
      const latest = db.prepare(`SELECT id,payload_json,seen_manifest_json FROM provider_requests
        WHERE background_run_id=? AND window_id=? AND turn_id=? AND attempt_id=? AND purpose='cache_keepalive'
          AND sent_at IS NOT NULL AND dispatch_started_at IS NOT NULL
        ORDER BY rowid DESC LIMIT 1`).get(row.runId,row.windowId,row.turnId,row.attemptId) as
        { id: string; payload_json: string; seen_manifest_json: string } | undefined;
      if (!latest) throw new Error('HEARTBEAT_RECOVERY_INPUT_MISSING');
      const envelope = JSON.parse(latest.payload_json) as OrRequestEnvelope;
      const sent = completionInputMessages({ ...earlier, payload_json: latest.payload_json });
      const earlierSent = completionInputMessages(earlier);
      if (JSON.stringify(sent.slice(0,earlierSent.length)) !== JSON.stringify(earlierSent)) {
        throw new Error('HEARTBEAT_RECOVERY_PREFIX_MISMATCH');
      }
      const pending = latest.id === proof.requestId;
      const knownOwnerReceipt = (callId: string): ToolExecResult | undefined => {
        if (!proof.inFlight.includes(callId)) return;
        const fact = db.prepare('SELECT action_json FROM heartbeat_actions WHERE run_id=? AND call_id=?')
          .get(row.runId,callId) as { action_json: string } | undefined;
        if (!fact) return;
        const action = JSON.parse(fact.action_json) as HeartbeatAction;
        if (action.kind === 'selection' || (action.status !== 'committed' && action.status !== 'partial')) return;
        // A source transaction may already have provided a trusted action fact
        // even though its full model receipt was interrupted. Don't invent
        // the missing response or imply that the operation should be repeated.
        return { ok: false, output: { error_code: 'TOOL_RECEIPT_INTERRUPTED',
          commit_status: action.status, ...(action.source ? { source: action.source } : {}),
          detail: '原业务已有可信提交事实；完整工具回执在宿主重启时中断，不要重复执行。' } };
      };
      const tail = pending ? completeRecoveredToolTail(proof,knownOwnerReceipt).tail : [];
      const finalMessages = [...sent,...tail];
      // sent_at is authoritative even if the process stopped just before
      // its consumption/publication callback completed.
      heartbeat.observeDelivery(row.runId,latest.id,sent,proof.heartbeatHostText);
      // Withhold an unconfirmed card before optional capacity compaction
      // could replace its recognizable delivery receipt.
      heartbeat.closeProtocol(row.runId,finalMessages,sent);
      if (JSON.stringify(finalMessages.slice(0,sent.length)) !== JSON.stringify(sent)) {
        throw new Error('HEARTBEAT_RECOVERY_CONFIRMED_PREFIX_CHANGED');
      }
      let pendingSeen = pending ? proof.pendingSeen : [];
      let confirmedSeen = proof.confirmedSeen;
      if (!pending) {
        const seen = JSON.parse(latest.seen_manifest_json) as Array<Partial<ManifestEntry>>;
        confirmedSeen = [...confirmedSeen,...proof.pendingSeen.filter(entry => seen.some(ref =>
          ref.id===entry.id && ref.revision===entry.revision && ref.char_start===entry.char_start && ref.char_end===entry.char_end))];
      }
      if (compact?.(finalMessages,sent.length,envelope.tools,envelope.maxTokens).size) pendingSeen = [];
      const observedToolCalls = sent.slice(base.messages.length).filter(m=>m.role==='tool').length
        + (pending ? new Set([...proof.inFlight,...proof.tail.filter(m=>m.role==='tool').map(m=>m.tool_call_id)]).size : 0);
      settleBackgroundRun(db,row.runId);
      const outcome = classifyBackgroundOutcome({
        db, trajectory, activity: deps.activity, ...row, kind: 'keepwarm',
        baseManifest: base.manifest ?? [], capturedActivityRevision: row.activityRevision,
        isCancelRequested: () => false, recoveredRequestId: latest.id,
        toolCallsObserved: Math.max(row.toolCallsObserved ?? 0, observedToolCalls),
        loop: { result: { outcome:'error',errorClassified:'unknown',errorCode:'HOST_RESTART_MID_RUN',
          errorMessage:null,sessionId:null,requestId:null },
          finalMessages,lastSentMessages:sent,toolSeen:confirmedSeen,pendingToolSeen:pendingSeen },
        heartbeat: { runtime:heartbeat,mode:row.mode,hostText:proof.heartbeatHostText },
      });
      finishBackground(row.runId,outcome);
    } catch {
      deps.logger.warn('heartbeat_protocol_recovery_failed',{ attempt_id:row.attemptId, code:'HEARTBEAT_RECOVERY_EVIDENCE_UNAVAILABLE' });
    }
  }
}
