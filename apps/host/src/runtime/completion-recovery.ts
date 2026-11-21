import type { Db } from '../db/connection.ts';
import type { ManifestEntry } from '../context/review-policy.ts';
import type { StreamEventRow } from '../events/service.ts';
import type { HeartbeatMode } from '../modules/heartbeat/service.ts';
import { classifyBackgroundOutcome } from './background-outcome.ts';
import { settleBackgroundRun } from './background-ledger.ts';
import { tailBoundaryOf } from './cache-plan.ts';
import type { RunnerRunResult } from './runner.ts';
import type { SupervisorDeps } from './supervisor.ts';
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
