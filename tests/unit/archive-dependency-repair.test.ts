// Recovery tests use an atomic fake source service; no network or production content.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, type Db } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { ArchiveSyncService, INGEST_BATCH_MAX_BYTES } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';
import { applyArchiveDependencyRepair, planArchiveDependencyRepair } from '../../apps/host/src/integrations/mariposa/archive-repair.ts';
import { MariposaClient, serverNormalizedBytes, type IngestMessage, type IngestRequest, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { tempRoot } from '../helpers.ts';

const keyOf = (message: Pick<IngestMessage, 'origin_message_id' | 'revision'>) => `archive:${message.origin_message_id}:${message.revision}`;
const ackAll = (req: IngestRequest) => ({
  operation_id: req.operation_id, committed_at: '2026-10-17T00:00:00.000Z',
  messages: req.messages.map((message) => ({ origin_message_id: message.origin_message_id, revision: message.revision,
    source_conversation_id: 'source-c1', source_message_id: `source-${message.origin_message_id}-${message.revision}`, content_hash: message.content_hash })),
});

function strictServer(sourceNotReadyStatus: 403 | 409 = 409) {
  const calls: Array<{ capability: string; payload: Record<string, unknown> }> = [];
  const revisions = new Map<string, IngestMessage>();
  const operations = new Map<string, { serialized: string; ack: ReturnType<typeof ackAll> }>();
  const transport: MariposaTransport = async (capability, payload) => {
    calls.push({ capability, payload: structuredClone(payload) });
    if (capability === 'source.ingest.status') {
      const committed = operations.get(String(payload.operation_id));
      return { ok: true, result: { operation_id: payload.operation_id, completed: !!committed, receipt: committed?.ack ?? null } };
    }
    assert.equal(capability, 'source.ingest');
    const req = structuredClone(payload) as unknown as IngestRequest;
    const existing = operations.get(req.operation_id);
    if (existing) return existing.serialized === JSON.stringify(req)
      ? { ok: true, result: existing.ack } : { ok: false, code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 };
    const staged = new Map(revisions);
    for (const message of req.messages) {
      if (message.conversation_sequence > 1) {
        const pred = message.predecessor && staged.get(keyOf(message.predecessor));
        if (!pred || pred.conversation_sequence !== message.conversation_sequence - 1) return { ok: false, code: 'SOURCE_NOT_READY', httpStatus: sourceNotReadyStatus };
      }
      if (message.previous_revision !== null && !staged.has(keyOf({ origin_message_id: message.origin_message_id, revision: message.previous_revision }))) {
        return { ok: false, code: 'SOURCE_NOT_READY', httpStatus: sourceNotReadyStatus };
      }
      staged.set(keyOf(message), message);
    }
    const ack = ackAll(req);
    for (const [key, message] of staged) revisions.set(key, message);
    operations.set(req.operation_id, { serialized: JSON.stringify(req), ack });
    return { ok: true, result: ack };
  };
  return { calls, revisions, operations, transport };
}

function compose(t: TestContext, options: { count?: number; text?: string; transport?: MariposaTransport; editFirst?: boolean; sourceNotReadyStatus?: 403 | 409 } = {}) {
  const root = tempRoot('archive-repair-');
  const oldHome = process.env.ESTOMAGO_HOME;
  process.env.ESTOMAGO_HOME = root;
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.ESTOMAGO_HOME;
    else process.env.ESTOMAGO_HOME = oldHome;
  });
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const ids = Array.from({ length: options.count ?? 3 }, (_, index) => messages.submitUserMessageWithTurn({
    conversationId: 'c1', content: options.text ?? `合成原文 ${index}`, clientMessageId: `fixture-${index}`,
  }).message.id);
  if (options.editFirst) messages.editUserMessage(ids[0]!, '合成修订原文');
  const frozen = (db.prepare(`SELECT m.id AS origin_id, m.sequence, m.published_at, r.* FROM messages m JOIN message_revisions r ON r.message_id = m.id
    WHERE m.conversation_id = 'c1' ORDER BY m.sequence, r.revision`).all() as Array<{
    origin_id: string; sequence: number; published_at: string | null; revision: number; supersedes_revision: number | null;
    occurred_at: string | null; received_at: string; content: string; content_hash: string;
  }>).map((row): IngestMessage => ({
    origin_message_id: row.origin_id, revision: row.revision, previous_revision: row.supersedes_revision,
    conversation_sequence: row.sequence,
    predecessor: row.sequence > 1 ? { origin_message_id: ids[row.sequence - 2]!, revision: options.editFirst && row.sequence === 2 ? 2 : 1 } : null,
    sender: 'user', published_kind: 'chat_message', occurred_at: row.occurred_at, received_at: row.received_at,
    published_at: row.published_at, text: row.content, assets: [], content_hash: row.content_hash,
  }));
  // Odd/even batches depend on each other. Original first batch stages seq1 then
  // rejects at seq3, and the atomic rollback leaves the even batch missing seq1.
  const originals = [frozen.filter((message) => message.conversation_sequence % 2 === 1), frozen.filter((message) => message.conversation_sequence % 2 === 0)]
    .map((members, index): IngestRequest => ({ operation_id: `legacy-${index}`, stream_id: 'test-archive-repair', origin_instance: 'estomago', origin_conversation_id: 'c1', messages: members }));
  for (let i = 0; i < originals.length; i++) {
    const req = originals[i]!;
    db.prepare(`INSERT INTO ingest_batches(operation_id, conversation_id, payload_json, keys_json, state, attempts, last_error, created_at, updated_at)
      VALUES (?, 'c1', ?, ?, ?, ?, ?, ?, ?)`).run(req.operation_id, JSON.stringify(req), JSON.stringify(req.messages.map(keyOf)),
        i === 0 ? 'dead' : 'in_flight', i === 0 ? 11 : 4, i === 0 ? 'TRANSIENT_EXHAUSTED' : null,
        '2026-10-17T00:00:00.000Z', '2026-10-17T00:01:00.000Z');
    for (const message of req.messages) {
      db.prepare('UPDATE outbox SET batch_id = ?, state = ?, attempt = ?, last_error = ? WHERE operation_key = ?')
        .run(req.operation_id, i === 0 ? 'failed' : 'pending', i === 0 ? 11 : 4, 'SOURCE_NOT_READY', keyOf(message));
    }
  }
  const server = strictServer(options.sourceNotReadyStatus);
  const client = new MariposaClient({ transport: options.transport ?? server.transport });
  const config = buildConfig({ archive: { enabled: true, source_scope: 'test-archive-repair' }, integrations: { mariposa: { base_url: 'http://127.0.0.1:9', credential_ref: 'TEST_UNUSED' } } });
  const sync = new ArchiveSyncService({ db, client, config, events: new EventService(db), logger: new Logger(null) });
  return { db, messages, ids, frozen, originals, client, sync, server };
}

const dump = (db: Db) => JSON.stringify({
  batches: db.prepare('SELECT * FROM ingest_batches ORDER BY operation_id').all(),
  rows: db.prepare('SELECT * FROM outbox ORDER BY id').all(),
  receipts: db.prepare('SELECT * FROM source_sync_receipts ORDER BY id').all(),
});

test('repair plans read-only, confirms atomic rejections, preserves frozen revisions and drains corrected dependencies', async (t) => {
  const ctx = compose(t, { editFirst: true });
  // Editing the local current revision must never rewrite the earlier frozen projection.
  ctx.messages.editUserMessage(ctx.ids[0]!, '后来的本地正文，不得改写冻结记录');
  const before = dump(ctx.db);
  const oldRows = ctx.db.prepare('SELECT id, attempt, created_at FROM outbox ORDER BY id').all();
  const oldBatches = ctx.db.prepare('SELECT operation_id, payload_json, keys_json, attempts, last_error, created_at, updated_at FROM ingest_batches ORDER BY operation_id').all();
  const plan = await planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' });
  assert.equal(dump(ctx.db), before);
  assert.ok(ctx.server.calls.every((call) => call.capability === 'source.ingest.status'));
  assert.equal(plan.messageRevisions, 4);
  assert.deepEqual(plan.batches.flatMap((batch) => batch.request.messages), ctx.frozen);
  assert.deepEqual(await planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' }), plan, 'identical snapshots produce identical repair operations');
  const applied = await applyArchiveDependencyRepair({ ...ctx, plan, sendersPaused: true });
  assert.deepEqual(applied, { replacedBatches: 2, stagedBatches: 1, messageRevisions: 4 });
  assert.equal(ctx.server.operations.size, 0, 'SOURCE_NOT_READY rolled back every original replay atomically');
  assert.deepEqual(ctx.server.calls.filter((call) => call.capability === 'source.ingest').map((call) => JSON.stringify(call.payload)), ctx.originals.map((req) => JSON.stringify(req)));
  assert.deepEqual(ctx.db.prepare('SELECT id, attempt, created_at FROM outbox ORDER BY id').all(), oldRows, 'attempt history and original enqueue times retained');
  assert.deepEqual(ctx.db.prepare("SELECT operation_id, payload_json, keys_json, attempts, last_error, created_at, updated_at FROM ingest_batches WHERE operation_id LIKE 'legacy-%' ORDER BY operation_id").all(), oldBatches);
  const result = await ctx.sync.drainOnce();
  assert.equal(result.acked, 5, 'four frozen revisions plus independently queued latest local revision');
  assert.equal(ctx.server.revisions.size, 5);
  assert.deepEqual(ctx.server.revisions.get(keyOf(ctx.frozen[0]!)), ctx.frozen[0]);
});

test('repair accepts the deployed SOURCE_NOT_READY/403 atomic rejection and successfully archives repaired batches', async (t) => {
  const ctx = compose(t, { sourceNotReadyStatus: 403 });
  const before = dump(ctx.db);
  const plan = await planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' });
  assert.equal(dump(ctx.db), before, 'status-only planning remains read-only');
  const result = await applyArchiveDependencyRepair({ ...ctx, plan, sendersPaused: true });
  assert.deepEqual(result, { replacedBatches: 2, stagedBatches: 1, messageRevisions: 3 });
  assert.equal(ctx.server.operations.size, 0, 'both original requests were atomically rejected, not committed');
  assert.deepEqual(ctx.server.calls.filter((call) => call.capability === 'source.ingest').map((call) => JSON.stringify(call.payload)), ctx.originals.map((req) => JSON.stringify(req)));
  const drained = await ctx.sync.drainOnce();
  assert.equal(drained.acked, 3);
  assert.equal(drained.retry_later, 0);
  assert.deepEqual([...ctx.server.revisions.values()], ctx.frozen);
});

for (const options of [{ count: 53 }, { count: 3, text: 'x'.repeat(450_000) }]) {
  test(`repair respects ${options.count === 53 ? '50-message' : 'normalized-byte'} split and drains in source order`, async (t) => {
    const ctx = compose(t, options);
    // Reverse enqueue timestamps so frozen recovery cannot rely on MIN(outbox.created_at).
    for (const message of ctx.frozen) ctx.db.prepare('UPDATE outbox SET created_at = ? WHERE operation_key = ?')
      .run(`2026-10-17T00:${String(60 - message.conversation_sequence).padStart(2, '0')}:00.000Z`, keyOf(message));
    const plan = await planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' });
    assert.equal(plan.batches.length, 2);
    assert.ok(plan.batches.every((batch) => batch.request.messages.length <= 50 && serverNormalizedBytes(batch.request) <= INGEST_BATCH_MAX_BYTES));
    assert.deepEqual(plan.batches.flatMap((batch) => batch.request.messages), ctx.frozen);
    await applyArchiveDependencyRepair({ ...ctx, plan, sendersPaused: true });
    const result = await ctx.sync.drainOnce();
    assert.equal(result.acked, options.count);
    assert.equal(result.retry_later, 0);
  });
}

for (const [label, makeResult] of [
  ['committed', (op: string) => ({ operation_id: op, completed: true, receipt: {} })],
  ['wrong operation', (_op: string) => ({ operation_id: 'wrong', completed: false, receipt: null })],
  ['missing completed', (op: string) => ({ operation_id: op, receipt: null })],
  ['missing receipt', (op: string) => ({ operation_id: op, completed: false })],
] as const) {
  test(`repair refuses ${label} status without local mutation or ingest`, async (t) => {
    const calls: string[] = [];
    const ctx = compose(t, { transport: async (capability, payload) => { calls.push(capability); return { ok: true, result: makeResult(String(payload.operation_id)) }; } });
    const before = dump(ctx.db);
    await assert.rejects(planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' }), /REPAIR_(OPERATION_COMMITTED|STATUS_SHAPE_INVALID)/);
    assert.equal(dump(ctx.db), before);
    assert.deepEqual(calls, ['source.ingest.status']);
  });
}

test('repair refuses status network failure and authorization failure without mutation', async (t) => {
  for (const throwing of [true, false]) {
    const ctx = compose(t, { transport: async () => { if (throwing) throw new Error('synthetic'); return { ok: false, code: 'FORBIDDEN', httpStatus: 403 }; } });
    const before = dump(ctx.db);
    await assert.rejects(planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' }), /REPAIR_STATUS_UNKNOWN/);
    assert.equal(dump(ctx.db), before);
  }
});

for (const replay of ['ack', 'network', 'wrong-status', 'other-error', 'forbidden'] as const) {
  test(`repair refuses ${replay} replay result and retains original recovery bindings`, async (t) => {
    const ctx = compose(t, { transport: async (capability, payload) => {
      if (capability === 'source.ingest.status') return { ok: true, result: { operation_id: payload.operation_id, completed: false, receipt: null } };
      if (replay === 'network') throw new Error('synthetic reply lost');
      if (replay === 'ack') return { ok: true, result: ackAll(payload as unknown as IngestRequest) };
      if (replay === 'forbidden') return { ok: false, code: 'FORBIDDEN', httpStatus: 403 };
      return { ok: false, code: replay === 'other-error' ? 'IDEMPOTENCY_CONFLICT' : 'SOURCE_NOT_READY', httpStatus: replay === 'wrong-status' ? 503 : 409 };
    } });
    const plan = await planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' });
    const before = dump(ctx.db);
    await assert.rejects(applyArchiveDependencyRepair({ ...ctx, plan, sendersPaused: true }), /REPAIR_REPLAY_(UNKNOWN|NOT_REJECTED)/);
    assert.equal(dump(ctx.db), before);
  });
}

test('repair rejects frozen member mismatch, missing dependency, and unknown-outcome rows', async (t) => {
  for (const fault of ['keys', 'dependency', 'unknown']) {
    const ctx = compose(t);
    if (fault === 'keys') ctx.db.prepare("UPDATE ingest_batches SET keys_json = '[]' WHERE operation_id = 'legacy-0'").run();
    if (fault === 'unknown') ctx.db.prepare("UPDATE outbox SET state = 'unknown_outcome' WHERE batch_id = 'legacy-0'").run();
    if (fault === 'dependency') {
      const req = structuredClone(ctx.originals[0]!);
      req.messages.at(-1)!.predecessor!.revision = 9;
      ctx.db.prepare('UPDATE ingest_batches SET payload_json = ? WHERE operation_id = ?').run(JSON.stringify(req), req.operation_id);
    }
    const before = dump(ctx.db);
    await assert.rejects(planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' }), /REPAIR_(MEMBER_BIJECTION_INVALID|PREDECESSOR_MISSING|MEMBER_STATE_UNSAFE)/);
    assert.equal(dump(ctx.db), before);
    assert.equal(ctx.server.calls.length, 0);
  }
});

test('repair detects changes after planning and during rejection replay', async (t) => {
  const ctx = compose(t);
  const plan = await planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' });
  ctx.db.prepare("UPDATE outbox SET attempt = attempt + 1 WHERE batch_id = 'legacy-0'").run();
  const before = dump(ctx.db);
  await assert.rejects(applyArchiveDependencyRepair({ ...ctx, plan, sendersPaused: true }), /REPAIR_PLAN_CHANGED/);
  assert.equal(dump(ctx.db), before);
  const fresh = await planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' });
  const client = new MariposaClient({ transport: async (capability, payload) => {
    const result = await ctx.server.transport(capability, payload);
    if (capability === 'source.ingest') ctx.db.prepare("UPDATE outbox SET attempt = attempt + 1 WHERE batch_id = 'legacy-0'").run();
    return result;
  } });
  await assert.rejects(applyArchiveDependencyRepair({ ...ctx, client, plan: fresh, sendersPaused: true }), /REPAIR_SNAPSHOT_CHANGED/);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM ingest_batches').get() as { n: number }).n, 2);
  assert.equal(ctx.server.calls.filter((call) => call.capability === 'source.ingest').length, 1, 'stop before replaying another original after local state changes');
});

test('repair rechecks remote status at apply time and cannot reuse an earlier uncommitted observation', async (t) => {
  const ctx = compose(t);
  const plan = await planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' });
  const req = ctx.originals[0]!;
  ctx.server.operations.set(req.operation_id, { serialized: JSON.stringify(req), ack: ackAll(req) });
  const before = dump(ctx.db);
  await assert.rejects(applyArchiveDependencyRepair({ ...ctx, plan, sendersPaused: true }), /REPAIR_OPERATION_COMMITTED/);
  assert.equal(dump(ctx.db), before);
  assert.ok(ctx.server.calls.every((call) => call.capability === 'source.ingest.status'));
});

test('one atomic rejection does not authorize rebundling if the next original replay has an unknown outcome', async (t) => {
  let replays = 0;
  const ctx = compose(t, { transport: async (capability, payload) => {
    if (capability === 'source.ingest.status') return { ok: true, result: { operation_id: payload.operation_id, completed: false, receipt: null } };
    if (++replays === 1) return { ok: false, code: 'SOURCE_NOT_READY', httpStatus: 409 };
    throw new Error('synthetic second original response lost');
  } });
  const plan = await planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' });
  const before = dump(ctx.db);
  await assert.rejects(applyArchiveDependencyRepair({ ...ctx, plan, sendersPaused: true }), /REPAIR_REPLAY_UNKNOWN/);
  assert.equal(replays, 2);
  assert.equal(dump(ctx.db), before);
});

test('repair transaction rolls back every insertion and binding if a deterministic replacement operation already exists', async (t) => {
  const ctx = compose(t, { count: 53 });
  const plan = await planArchiveDependencyRepair({ ...ctx, conversationId: 'c1' });
  const collision = plan.batches[1]!.request;
  // An unrelated archived evidence row can collide without joining the selected bound set.
  ctx.db.prepare(`INSERT INTO ingest_batches(operation_id, conversation_id, payload_json, keys_json, state, created_at, updated_at)
    VALUES (?, 'c1', ?, '[]', 'dead', 'old', 'old')`).run(collision.operation_id, JSON.stringify(collision));
  const before = dump(ctx.db);
  await assert.rejects(applyArchiveDependencyRepair({ ...ctx, plan, sendersPaused: true }), /REPAIR_OPERATION_ALREADY_EXISTS/);
  assert.equal(dump(ctx.db), before, 'earlier batch insertion and rebinding are rolled back too');
});
