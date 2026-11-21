import type { HeartbeatAction, HeartbeatActionKind } from '../../../../../packages/contracts/src/heartbeat.ts';
import type { CapabilityOutcome, ToolExecContext } from '../../capabilities/contracts.ts';
import type { Db } from '../../db/connection.ts';
import { canDrawHeartbeat, HeartbeatCards } from './service.ts';
import { starReplyOperationId, starWriteOperationId } from '../wishstar/operation-ids.ts';
import { memoryHoldOperationId } from '../memory/hold-operation-id.ts';
import { wakeOperationIdentity, type WakeMutation } from '../wake/operation-id.ts';
import { readHeartbeatProjection } from '../../../../../packages/contracts/src/heartbeat.ts';

// Invoked only after schema, cancellation, terminal and budget admission. The
// owner of a business tool opts in and returns its authoritative outcome.
// Persist a pre-handler unknown so a process stop doesn't claim no side effect.
export function startHeartbeatAction(db: Db, ctx: ToolExecContext, kind: HeartbeatActionKind | undefined,
  input: unknown): ((outcome: CapabilityOutcome<unknown>) => void) | undefined {
  if (!kind || !ctx.backgroundRunId || !ctx.toolCallId || !canDrawHeartbeat(db, ctx)) return;
  const run = ctx.backgroundRunId, call = ctx.toolCallId;
  const args = input as Record<string, unknown>;
  if (kind === 'wake' && !['schedule','update','cancel'].includes(String(args.operation))) return;
  const after = db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM messages WHERE turn_id=?')
    .get(ctx.turnId) as { n: number };
  const action: HeartbeatAction = { operationId: call, kind, afterSequence: after.n, status: 'unknown',
    ...(kind === 'selection' && Number.isInteger(args.card_number) && Number(args.card_number) >= 1 && Number(args.card_number) <= 10
      ? { cardNumber: Number(args.card_number) } : {}) };
  if (kind === 'star_write') action.operationId = starWriteOperationId(args.idempotency_key);
  if (kind === 'star_reply') {
    const delivered = new HeartbeatCards(db).getDeliveredDraw(run);
    if (delivered?.source.kind === 'wishstar' && delivered.operationId === args.reply_ref) {
      action.operationId = starReplyOperationId(delivered.source.id, args.idempotency_key);
    }
  }
  if (kind === 'memory_hold') action.operationId = memoryHoldOperationId(ctx.turnId ?? ctx.requestId, call);
  if (kind === 'wake') {
    action.wakeOperation = args.operation as WakeMutation;
    action.operationId = wakeOperationIdentity(ctx.roomId, action.wakeOperation, String(args.operation_id ?? ''));
  }
  db.prepare('INSERT OR IGNORE INTO heartbeat_actions(run_id,call_id,action_json) VALUES(?,?,?)')
    .run(run, call, JSON.stringify(action));
  return outcome => {
    const current = db.prepare('SELECT action_json FROM heartbeat_actions WHERE run_id=? AND call_id=?')
      .get(run, call) as { action_json: string };
    const fact = JSON.parse(current.action_json) as HeartbeatAction;
    const result = (outcome.ok ? outcome.value : outcome.error) as Record<string, unknown>;
    if (outcome.heartbeatReceipt) {
      const receipt = outcome.heartbeatReceipt;
      if (fact.status === 'committed' && receipt.status !== 'committed') return;
      db.prepare('UPDATE heartbeat_actions SET action_json=? WHERE run_id=? AND call_id=?')
        .run(JSON.stringify({ ...fact, ...receipt }), run, call);
      return;
    }
    if (typeof result.operation_id === 'string') fact.operationId = result.operation_id;
    if (outcome.ok) fact.status = 'committed';
    else if (result.commit_status === 'committed' || result.saved === true) fact.status = 'partial';
    else if (result.commit_status === 'unknown' || /UNKNOWN|UNCONFIRMED|RECEIPT_OPERATION_MISMATCH/.test(String(result.error_code))) fact.status = 'unknown';
    else if (/CANCELLED/.test(String(result.error_code))) fact.status = 'cancelled';
    else fact.status = 'failed';
    const ref = (namespace: string, id: unknown, revision?: unknown, parentId?: unknown): void => {
      if (typeof id !== 'string' || !id) return;
      fact.source = { namespace, id,
        ...(typeof revision === 'string' || typeof revision === 'number' ? { revision } : {}),
        ...(typeof parentId === 'string' && parentId ? { parentId } : {}) };
    };
    if (fact.status === 'committed' || fact.status === 'partial') {
      switch (kind) {
        case 'star_reply': ref('superposition:response', result.id, result.created_at, result.star_id); break;
        case 'star_write': ref('superposition:star', result.id, result.written_at ?? result.created_at); break;
        case 'memory_hold': ref('mariposa:memory', result.memory_id, result.version); break;
        case 'post': ref('content:post', result.id, result.revision); break;
        case 'comment': ref('content:comment', result.id, result.revision, result.post_id); break;
        case 'album': ref('content:album', result.id ?? result.album_entry_id, result.revision); break;
        case 'image':
        case 'creation':
          if (result.album_entry_id) ref('content:album', result.album_entry_id, result.revision);
          else if (result.creation_id) ref('content:creation', result.creation_id, result.revision);
          else ref('host:asset', result.asset_id);
          break;
        case 'archive': ref('content:archive', result.archive_id ?? result.id, result.revision); break;
        case 'wake': ref('host:task', result.task_id ?? result.id, result.revision); break;
        case 'chat': ref('host:message', result.message_id, 1); break;
      }
    }
    // Never downgrade known success on replay of the same provider call.
    if ((JSON.parse(current.action_json) as HeartbeatAction).status === 'committed' && fact.status !== 'committed') return;
    db.prepare('UPDATE heartbeat_actions SET action_json=? WHERE run_id=? AND call_id=?')
      .run(JSON.stringify(fact), run, call);
  };
}

export function heartbeatActions(db: Db, runId: string): HeartbeatAction[] {
  const rows = db.prepare('SELECT call_id,action_json FROM heartbeat_actions WHERE run_id=? ORDER BY rowid')
    .all(runId) as Array<{ call_id: string; action_json: string }>;
  const actions: HeartbeatAction[] = [];
  for (const row of rows) {
    const action = JSON.parse(row.action_json) as HeartbeatAction;
    if (action.kind === 'selection') {
      const draw = db.prepare('SELECT state FROM heartbeat_draw_operations WHERE run_id=? AND operation_id=?')
        .get(runId, row.call_id) as { state: string } | undefined;
      action.status = draw?.state === 'delivered' ? 'committed' : draw?.state === 'unknown' || draw?.state === 'dispatching' ? 'unknown'
        : draw?.state === 'not_dispatched' ? 'cancelled' : draw?.state === 'rejected' ? 'failed' : action.status;
    }
    if (action.kind === 'chat' && action.status === 'committed') continue; // represented by the actual published message
    const previous = actions.findIndex(other => other.kind === action.kind && other.operationId === action.operationId
      && other.status !== 'failed' && other.status !== 'cancelled');
    if (previous >= 0 && (action.status === 'committed' || action.status === 'partial' || action.status === 'unknown')) {
      if (actions[previous]!.status !== 'committed' && action.status !== 'unknown') {
        actions[previous] = { ...action, afterSequence: actions[previous]!.afterSequence };
      }
    } else actions.push(action);
  }
  return actions;
}

/** Refresh only an already-created run projection; Content keeps its own
 * display edits and tombstone on the stable event ID. The raw payload CAS also
 * prevents a completed older delivery from overwriting a queued new version. */
function refreshExistingProjection(db: Db, runId: string): void {
  const prior = db.prepare('SELECT id,payload_ref FROM outbox WHERE operation_key=? AND target=?')
    .get('heartbeat-moment:' + runId, 'content_heartbeat_projection') as { id: string; payload_ref: string } | undefined;
  if (!prior) return;
  const projection = readHeartbeatProjection(JSON.parse(prior.payload_ref));
  if (!projection?.actions) return;
  const actions = heartbeatActions(db, runId);
  if (JSON.stringify(actions) === JSON.stringify(projection.actions)) return;
  db.prepare("UPDATE outbox SET payload_ref=?,state='pending',attempt=0,updated_at=? WHERE id=? AND payload_ref=?")
    .run(JSON.stringify({ ...projection, version: projection.version + 1, actions }), new Date().toISOString(), prior.id, prior.payload_ref);
}

export type HeartbeatContentBinding = { runId: string; callId: string };
function contentActionKind(ownerType: string): 'post' | 'comment' | 'album' | null {
  return ownerType === 'post' || ownerType === 'comment' ? ownerType : ownerType === 'album_entry' ? 'album' : null;
}

/** Called by Content only after the exact current command is accepted, inside
 * the durable intent transaction for a new operation. An unaccepted conflict
 * must not bind to a different command's later receipt under the same key. */
export function bindHeartbeatContentOperation(db: Db, binding: HeartbeatContentBinding | undefined, operationId: string, ownerType: string): void {
  const kind = contentActionKind(ownerType);
  if (!binding || !kind) return;
  db.prepare(`UPDATE heartbeat_actions SET action_json=json_set(action_json,'$.operationId',?)
    WHERE run_id=? AND call_id=? AND json_extract(action_json,'$.kind')=?
      AND json_extract(action_json,'$.operationId')=? AND json_extract(action_json,'$.status')='unknown'`)
    .run(operationId, binding.runId, binding.callId, kind, binding.callId);
}

/** Same operation, same owner, matched authoritative source receipt. We may
 * settle an earlier unknown/partial attempt, but never turn a conflicting or
 * explicitly failed model call into a success. Called in owner's transaction. */
export function settleHeartbeatContentReceipt(db: Db, operationId: string, ownerType: string,
  status: 'committed' | 'partial' | 'failed', body?: unknown): void {
  const kind = contentActionKind(ownerType);
  if (!kind) return;
  const receipt = body as { id?: unknown; revision?: unknown; post_id?: unknown } | null | undefined;
  if (status === 'committed' && (typeof receipt?.id !== 'string' || !receipt.id)) return;
  const rows = db.prepare(`SELECT run_id,call_id,action_json FROM heartbeat_actions
    WHERE json_extract(action_json,'$.kind')=? AND json_extract(action_json,'$.operationId')=?
      AND json_extract(action_json,'$.status') IN ('unknown','partial')`).all(kind, operationId) as Array<{ run_id: string; call_id: string; action_json: string }>;
  const changed = new Set<string>();
  for (const row of rows) {
    const action = JSON.parse(row.action_json) as HeartbeatAction;
    // A partial fact already proves commitment, while a later unbound failure
    // must not clear that prior authority.
    if (action.status === status || action.status === 'partial' && status === 'failed') continue;
    action.status = status;
    if (status === 'committed') action.source = { namespace: `content:${kind}`, id: receipt!.id as string,
      ...(typeof receipt!.revision === 'number' ? { revision: receipt!.revision } : {}),
      ...(kind === 'comment' && typeof receipt!.post_id === 'string' ? { parentId: receipt!.post_id } : {}) };
    db.prepare('UPDATE heartbeat_actions SET action_json=? WHERE run_id=? AND call_id=?')
      .run(JSON.stringify(action), row.run_id, row.call_id);
    changed.add(row.run_id);
  }
  for (const runId of changed) refreshExistingProjection(db, runId);
}

/** Invoked inside the existing memory effect settlement transaction, with a
 * receipt already matched to the original operation. A late receipt updates
 * only that run's projection and never dispatches another model or write. */
export function settleHeartbeatMemoryReceipt(db: Db, operationId: string,
  receipt: { memoryId: string; version: number } | null): void {
  const rows = db.prepare(`SELECT run_id,call_id,action_json FROM heartbeat_actions
    WHERE json_extract(action_json,'$.kind')='memory_hold' AND json_extract(action_json,'$.operationId')=?`)
    .all(operationId) as Array<{ run_id: string; call_id: string; action_json: string }>;
  for (const row of rows) {
    const action = JSON.parse(row.action_json) as HeartbeatAction;
    if (action.status === 'committed') continue;
    action.status = receipt ? 'committed' : 'failed';
    if (receipt) action.source = { namespace: 'mariposa:memory', id: receipt.memoryId, revision: receipt.version };
    db.prepare('UPDATE heartbeat_actions SET action_json=? WHERE run_id=? AND call_id=?')
      .run(JSON.stringify(action), row.run_id, row.call_id);
    refreshExistingProjection(db, row.run_id);
  }
}
