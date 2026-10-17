// Explicit maintenance path for dependency cycles in legacy frozen archive batches.
// Run with ALL archive senders stopped and the same client/actor as the original sender.
// A status miss alone is insufficient: each original request must also be replayed
// unchanged and receive an atomic SOURCE_NOT_READY rejection before rebundling.
import { tx, type Db } from '../../db/connection.ts';
import { sha256Hex } from '../../util/id.ts';
import { INGEST_BATCH_MAX_BYTES, INGEST_BATCH_MAX_MESSAGES } from './archive-sync.ts';
import { serverNormalizedBytes, type IngestMessage, type IngestRequest, type MariposaClient } from './client.ts';

type Batch = {
  operation_id: string; conversation_id: string; payload_json: string; keys_json: string;
  state: string; attempts: number; last_error: string | null; created_at: string; updated_at: string;
};
type Row = {
  id: string; operation_key: string; target: string; payload_ref: string; batch_id: string;
  state: string; attempt: number; last_error: string | null; created_at: string; updated_at: string;
};
type Member = { row: Row; message: IngestMessage };
type RepairBatch = { request: IngestRequest; memberKeys: string[] };

export type ArchiveDependencyRepairPlan = {
  conversationId: string;
  snapshotHash: string;
  originalOperations: string[];
  messageRevisions: number;
  batches: RepairBatch[];
};

export class ArchiveDependencyRepairError extends Error {
  readonly code: string;
  readonly operationId?: string;
  constructor(code: string, operationId?: string) {
    super(code);
    this.name = 'ArchiveDependencyRepairError';
    this.code = code;
    this.operationId = operationId;
  }
}

const fail = (code: string, operationId?: string): never => { throw new ArchiveDependencyRepairError(code, operationId); };
const memberKey = (message: Pick<IngestMessage, 'origin_message_id' | 'revision'>): string =>
  `archive:${message.origin_message_id}:${message.revision}`;
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const parse = (value: string): unknown => {
  try { return JSON.parse(value); } catch { return fail('REPAIR_FROZEN_JSON_INVALID'); }
};

function validMessage(value: unknown): value is IngestMessage {
  if (!object(value)) return false;
  return typeof value.origin_message_id === 'string' && value.origin_message_id.length > 0
    && positiveInteger(value.revision) && positiveInteger(value.conversation_sequence)
    && (value.previous_revision === null || (positiveInteger(value.previous_revision) && value.previous_revision < value.revision))
    && (value.predecessor === null || (object(value.predecessor)
      && typeof value.predecessor.origin_message_id === 'string' && positiveInteger(value.predecessor.revision)))
    && typeof value.text === 'string' && typeof value.content_hash === 'string'
    && Array.isArray(value.assets) && value.assets.every((asset) => typeof asset === 'string')
    && (value.sender === 'user' || value.sender === 'assistant') && typeof value.published_kind === 'string'
    && ['occurred_at', 'received_at', 'published_at'].every((key) => value[key] === null || typeof value[key] === 'string');
}

function capture(db: Db, conversationId: string) {
  const batches = db.prepare(`SELECT b.* FROM ingest_batches b WHERE b.conversation_id = ? AND b.state != 'acked'
    AND EXISTS (SELECT 1 FROM outbox o WHERE o.batch_id = b.operation_id AND o.state != 'acked') ORDER BY b.operation_id`)
    .all(conversationId) as Batch[];
  const rows: Row[] = [];
  const originals: IngestRequest[] = [];
  const members: Member[] = [];
  const allKeys = new Set<string>();
  let envelope: Omit<IngestRequest, 'messages' | 'operation_id'> | undefined;
  for (const batch of batches) {
    if (!['dead', 'in_flight'].includes(batch.state)) fail('REPAIR_BATCH_STATE_UNSAFE', batch.operation_id);
    const bound = db.prepare('SELECT * FROM outbox WHERE batch_id = ? ORDER BY operation_key, id').all(batch.operation_id) as Row[];
    if (bound.some((row) => row.target !== 'mariposa.archive' || !['failed', 'pending'].includes(row.state))) {
      fail('REPAIR_MEMBER_STATE_UNSAFE', batch.operation_id);
    }
    const request = parse(batch.payload_json);
    const keys = parse(batch.keys_json);
    if (!object(request) || request.operation_id !== batch.operation_id || request.origin_conversation_id !== conversationId
      || request.origin_instance !== 'estomago' || typeof request.stream_id !== 'string' || request.stream_id.length === 0
      || !Array.isArray(request.messages) || request.messages.length === 0 || !request.messages.every(validMessage)
      || !Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) fail('REPAIR_FROZEN_SHAPE_INVALID', batch.operation_id);
    const req = request as unknown as IngestRequest;
    if (JSON.stringify(req) !== batch.payload_json) fail('REPAIR_FROZEN_SERIALIZATION_MISMATCH', batch.operation_id);
    const { operation_id: _op, messages: _messages, ...currentEnvelope } = req;
    if (envelope && JSON.stringify(envelope) !== JSON.stringify(currentEnvelope)) fail('REPAIR_ENVELOPE_MISMATCH', batch.operation_id);
    envelope = currentEnvelope;
    const payloadKeys = req.messages.map(memberKey);
    const equalKeys = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    if (new Set(payloadKeys).size !== payloadKeys.length || !equalKeys(keys as string[], payloadKeys)
      || !equalKeys(bound.map((row) => row.operation_key), payloadKeys)) fail('REPAIR_MEMBER_BIJECTION_INVALID', batch.operation_id);
    for (const message of req.messages) {
      const key = memberKey(message);
      if (allKeys.has(key)) fail('REPAIR_DUPLICATE_MEMBER', batch.operation_id);
      allKeys.add(key);
      const row = bound.find((item) => item.operation_key === key)!;
      const ref = parse(row.payload_ref);
      if (!object(ref) || ref.message_id !== message.origin_message_id) fail('REPAIR_MEMBER_REF_INVALID', batch.operation_id);
      members.push({ row, message });
    }
    rows.push(...bound);
    originals.push(req);
  }
  const identities = db.prepare('SELECT id, sequence FROM messages WHERE conversation_id = ? ORDER BY sequence').all(conversationId) as Array<{ id: string; sequence: number }>;
  const identityMap = new Map(identities.map((message) => [message.id, message.sequence]));
  const receipts = db.prepare(`SELECT r.* FROM source_sync_receipts r JOIN messages m ON m.id = r.origin_message_id
    WHERE m.conversation_id = ? ORDER BY r.origin_message_id, r.revision`).all(conversationId) as Array<{
      origin_message_id: string; revision: number; source_conversation_id: string | null; source_message_id: string | null; content_hash: string | null;
    }>;
  const available = new Map<string, number>();
  for (const receipt of receipts) {
    if (receipt.source_conversation_id && receipt.source_message_id && receipt.content_hash) {
      available.set(memberKey(receipt), identityMap.get(receipt.origin_message_id)!);
    }
  }
  members.sort((a, b) => a.message.conversation_sequence - b.message.conversation_sequence || a.message.revision - b.message.revision);
  for (const { message } of members) {
    const key = memberKey(message);
    if (identityMap.get(message.origin_message_id) !== message.conversation_sequence) fail('REPAIR_MESSAGE_IDENTITY_MISMATCH');
    if (receipts.some((receipt) => memberKey(receipt) === key)) fail('REPAIR_MEMBER_ALREADY_RECEIPTED');
    if (message.previous_revision !== null && !available.has(memberKey({ origin_message_id: message.origin_message_id, revision: message.previous_revision }))) {
      fail('REPAIR_PREVIOUS_REVISION_MISSING');
    }
    if (message.conversation_sequence > 1) {
      if (!message.predecessor || available.get(memberKey(message.predecessor)) !== message.conversation_sequence - 1) fail('REPAIR_PREDECESSOR_MISSING');
    } else if (message.predecessor !== null) fail('REPAIR_PREDECESSOR_INVALID');
    available.set(key, message.conversation_sequence);
  }
  const repairBatches: RepairBatch[] = [];
  const makeRequest = (items: Member[]): IngestRequest => {
    const body = { ...envelope!, messages: items.map((item) => item.message) };
    return { operation_id: `es-repair-${sha256Hex(JSON.stringify(body)).slice(0, 40)}`, ...body };
  };
  let chunk: Member[] = [];
  const flush = () => {
    if (chunk.length) repairBatches.push({ request: makeRequest(chunk), memberKeys: chunk.map((item) => item.row.operation_key) });
    chunk = [];
  };
  for (const member of members) {
    if (chunk.length && (chunk.length >= INGEST_BATCH_MAX_MESSAGES
      || serverNormalizedBytes(makeRequest([...chunk, member])) > INGEST_BATCH_MAX_BYTES)) flush();
    if (serverNormalizedBytes(makeRequest([member])) > INGEST_BATCH_MAX_BYTES) fail('REPAIR_MESSAGE_OVERSIZED');
    chunk.push(member);
  }
  flush();
  const plan: ArchiveDependencyRepairPlan = {
    conversationId, snapshotHash: sha256Hex(JSON.stringify({ batches, rows, identities, receipts })),
    originalOperations: batches.map((batch) => batch.operation_id), messageRevisions: members.length, batches: repairBatches,
  };
  return { plan, batches, rows, originals };
}

async function requireUncommitted(client: MariposaClient, operationId: string): Promise<void> {
  let status;
  try { status = await client.sourceIngestStatus(operationId); } catch { return fail('REPAIR_STATUS_UNKNOWN', operationId); }
  if (!status.ok) return fail('REPAIR_STATUS_UNKNOWN', operationId);
  const result = status.result;
  if (result.operation_id !== operationId || result.completed !== false || result.receipt !== null || status.ack !== undefined) {
    fail(result.completed === true ? 'REPAIR_OPERATION_COMMITTED' : 'REPAIR_STATUS_SHAPE_INVALID', operationId);
  }
}

/** Read-only local plan plus remote status queries. Does not submit source.ingest. */
export async function planArchiveDependencyRepair(args: { db: Db; client: MariposaClient; conversationId: string }): Promise<ArchiveDependencyRepairPlan> {
  const snapshot = capture(args.db, args.conversationId);
  for (const operationId of snapshot.plan.originalOperations) await requireUncommitted(args.client, operationId);
  if (capture(args.db, args.conversationId).plan.snapshotHash !== snapshot.plan.snapshotHash) fail('REPAIR_SNAPSHOT_CHANGED');
  return snapshot.plan;
}

/** Only stages repaired frozen batches. Normal ArchiveSyncService drain verifies and records ACKs.
 * sendersPaused is a caller assertion, not a lock: stop the host and any other writers first.
 * Pass the SAME authenticated archive client/actor used for the original operations.
 * Any uncertain replay leaves all local rows untouched so the original operation remains recoverable.
 */
export async function applyArchiveDependencyRepair(args: {
  db: Db; client: MariposaClient; plan: ArchiveDependencyRepairPlan; sendersPaused: true;
}): Promise<{ replacedBatches: number; stagedBatches: number; messageRevisions: number }> {
  if (args.sendersPaused !== true) fail('REPAIR_SENDERS_NOT_PAUSED');
  const snapshot = capture(args.db, args.plan.conversationId);
  if (JSON.stringify(snapshot.plan) !== JSON.stringify(args.plan)) fail('REPAIR_PLAN_CHANGED');
  const assertUnchanged = () => {
    if (capture(args.db, args.plan.conversationId).plan.snapshotHash !== snapshot.plan.snapshotHash) fail('REPAIR_SNAPSHOT_CHANGED');
  };
  for (const operationId of snapshot.plan.originalOperations) {
    assertUnchanged();
    await requireUncommitted(args.client, operationId);
  }
  for (const original of snapshot.originals) {
    assertUnchanged();
    let result;
    try { result = await args.client.sourceIngest(original); } catch { return fail('REPAIR_REPLAY_UNKNOWN', original.operation_id); }
    // Current Mariposa raises Forbidden/403 for this dependency error; older
    // contracts used 409. Both are explicit domain rejections; 5xx remains unknown.
    if (result.ok || result.code !== 'SOURCE_NOT_READY' || ![403, 409].includes(result.httpStatus)) fail('REPAIR_REPLAY_NOT_REJECTED', original.operation_id);
  }
  assertUnchanged();
  tx(args.db, () => {
    assertUnchanged();
    const now = new Date().toISOString();
    for (const batch of snapshot.plan.batches) {
      if (args.db.prepare('SELECT 1 FROM ingest_batches WHERE operation_id = ?').get(batch.request.operation_id)) fail('REPAIR_OPERATION_ALREADY_EXISTS');
      args.db.prepare(`INSERT INTO ingest_batches(operation_id, conversation_id, payload_json, keys_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(batch.request.operation_id, args.plan.conversationId, JSON.stringify(batch.request), JSON.stringify(batch.memberKeys), now, now);
      for (const key of batch.memberKeys) {
        const row = snapshot.rows.find((item) => item.operation_key === key)!;
        args.db.prepare("UPDATE outbox SET batch_id = ?, state = 'pending', last_error = NULL, updated_at = ? WHERE id = ?")
          .run(batch.request.operation_id, now, row.id);
      }
    }
    // Keep the original payload, member list, attempts, error and timestamps as audit evidence.
    // Only in_flight -> dead is needed to prevent any future accidental original replay.
    for (const batch of snapshot.batches) args.db.prepare("UPDATE ingest_batches SET state = 'dead' WHERE operation_id = ?").run(batch.operation_id);
  });
  return { replacedBatches: snapshot.batches.length, stagedBatches: snapshot.plan.batches.length, messageRevisions: snapshot.rows.length };
}
