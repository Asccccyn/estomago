// 原文归档依赖回归：严格假上游先验证前驱/旧修订，整批成功才提交；零网络、合成正文。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { ArchiveSyncService, INGEST_BATCH_MAX_MESSAGES } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';
import { MariposaClient, ingestOperationId, type IngestMessage, type IngestRequest, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import {tempRoot } from '../helpers.ts';

function strictServer() {
  const calls: IngestRequest[] = [];
  const bytes: string[] = [];
  const dependencyFailures: string[] = [];
  const committed = new Map<string, IngestMessage>();
  const operations = new Map<string, { bytes: string; ack: Record<string, unknown> }>();
  const key = (cid: string, id: string, revision: number): string => `${cid}:${id}@${revision}`;
  const transport: MariposaTransport = async (capability, payload) => {
    assert.equal(capability, 'source.ingest', '测试不允许其他远端能力');
    const req = structuredClone(payload) as unknown as IngestRequest;
    const serialized = JSON.stringify(req);
    calls.push(req);
    bytes.push(serialized);
    const existing = operations.get(req.operation_id);
    if (existing) {
      if (existing.bytes !== serialized) return { ok: false, code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 };
      return { ok: true, result: existing.ack };
    }
    const staged = new Map(committed);
    const unavailable = (dependency: string) => {
      dependencyFailures.push(dependency);
      return { ok: false as const, code: 'SOURCE_NOT_READY', httpStatus: 409 };
    };
    for (const message of req.messages) {
      if (message.conversation_sequence > 1) {
        if (!message.predecessor) return unavailable('predecessor_missing');
        const pred = staged.get(key(req.origin_conversation_id, message.predecessor.origin_message_id, message.predecessor.revision));
        if (!pred || pred.conversation_sequence !== message.conversation_sequence - 1) return unavailable('predecessor_not_staged');
      }
      if (message.previous_revision !== null && !staged.has(key(req.origin_conversation_id, message.origin_message_id, message.previous_revision))) {
        return unavailable('previous_revision_not_staged');
      }
      const existingRevision = staged.get(key(req.origin_conversation_id, message.origin_message_id, message.revision));
      if (!existingRevision) {
        const prefix = `${req.origin_conversation_id}:${message.origin_message_id}@`;
        const latest = Math.max(0, ...Array.from(staged).filter(([messageKey]) => messageKey.startsWith(prefix)).map(([, prior]) => prior.revision));
        if (message.revision !== latest + 1 || message.previous_revision !== (latest || null)) return unavailable('revision_not_latest_plus_one');
      } else if (existingRevision.content_hash !== message.content_hash) {
        return { ok: false, code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 };
      }
      staged.set(key(req.origin_conversation_id, message.origin_message_id, message.revision), message);
    }
    const ack = {
      operation_id: req.operation_id,
      committed_at: '2026-10-17T00:00:00.000Z',
      messages: req.messages.map((message) => ({
        origin_message_id: message.origin_message_id,
        revision: message.revision,
        source_conversation_id: `source-${req.origin_conversation_id}`,
        source_message_id: `source-${message.origin_message_id}-${message.revision}`,
        content_hash: message.content_hash,
      })),
    };
    for (const [messageKey, message] of staged) committed.set(messageKey, message);
    operations.set(req.operation_id, { bytes: serialized, ack });
    return { ok: true, result: ack };
  };
  return { calls, bytes, dependencyFailures, committed, operations, transport };
}

function compose(t: TestContext, transport: MariposaTransport) {
  const root = tempRoot('archive-dependency-');
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
  const config = buildConfig({
    archive: { enabled: true, source_scope: 'test-archive-dependencies' },
    integrations: { mariposa: { base_url: 'http://127.0.0.1:9', credential_ref: 'TEST_UNUSED_ARCHIVE_KEY' } },
  });
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const sync = new ArchiveSyncService({ db, events: new EventService(db), logger: new Logger(null), client: new MariposaClient({ transport }), config });
  const submit = (index: number) => messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `合成归档消息 ${index}`, clientMessageId: `fixture-${index}` }).message;
  return { db, messages, sync, submit };
}

test('同毫秒入队且 outbox ID 逆序时，按原文 sequence 发送依赖链', async (t) => {
  const server = strictServer();
  const ctx = compose(t, server.transport);
  const messages = [ctx.submit(1), ctx.submit(2), ctx.submit(3)];
  for (let i = 0; i < messages.length; i++) {
    ctx.db.prepare('UPDATE outbox SET id = ?, created_at = ? WHERE operation_key = ?')
      .run(`reverse-id-${messages.length - i}`, '2026-10-17T00:00:00.000Z', `archive:${messages[i]!.id}:1`);
  }
  const result = await ctx.sync.drainOnce();
  assert.deepEqual(server.dependencyFailures, [], '无依赖的请求不得先冻结再交上游拒绝');
  assert.equal(result.acked, 3);
  assert.deepEqual(server.calls.flatMap((req) => req.messages.map((message) => message.conversation_sequence)), [1, 2, 3]);
});

test('入队时间逆序也不改变原文的前驱顺序', async (t) => {
  const server = strictServer();
  const ctx = compose(t, server.transport);
  for (let i = 1; i <= 4; i++) {
    const message = ctx.submit(i);
    ctx.db.prepare('UPDATE outbox SET created_at = ? WHERE operation_key = ?')
      .run(`2026-10-17T00:00:0${4 - i}.000Z`, `archive:${message.id}:1`);
  }
  const result = await ctx.sync.drainOnce();
  assert.deepEqual(server.dependencyFailures, []);
  assert.equal(result.acked, 4);
  assert.deepEqual(server.calls.flatMap((req) => req.messages.map((message) => message.conversation_sequence)), [1, 2, 3, 4]);
});

test('50 条批界两侧的修订先同步旧版，后续消息只引用已可达的前驱', async (t) => {
  const server = strictServer();
  const ctx = compose(t, server.transport);
  const messages = Array.from({ length: INGEST_BATCH_MAX_MESSAGES + 1 }, (_, i) => ctx.submit(i + 1));
  const predecessor = messages[INGEST_BATCH_MAX_MESSAGES - 1]!;
  ctx.messages.editUserMessage(predecessor.id, '合成前驱的第二版');
  const rows = ctx.db.prepare("SELECT o.operation_key FROM outbox o JOIN messages m ON m.id = json_extract(o.payload_ref, '$.message_id') WHERE o.target = 'mariposa.archive' ORDER BY m.sequence, o.operation_key").all() as Array<{ operation_key: string }>;
  for (let i = 0; i < rows.length; i++) {
    ctx.db.prepare('UPDATE outbox SET id = ?, created_at = ? WHERE operation_key = ?')
      .run(`reverse-batch-${String(rows.length - i).padStart(3, '0')}`, '2026-10-17T00:00:00.000Z', rows[i]!.operation_key);
  }
  const result = await ctx.sync.drainOnce();
  assert.deepEqual(server.dependencyFailures, [], '跨批 previous_revision 必须已有提交证据');
  assert.equal(result.acked, INGEST_BATCH_MAX_MESSAGES + 2);
  assert.equal(server.calls.length, 2);
  assert.ok(server.calls.every((req) => req.messages.length <= INGEST_BATCH_MAX_MESSAGES));
  assert.equal(server.calls[0]!.messages.length, INGEST_BATCH_MAX_MESSAGES);
  assert.deepEqual(server.calls[0]!.messages.at(-1)!.revision, 1);
  const secondBatch = server.calls[1]!.messages;
  assert.equal(secondBatch[0]!.origin_message_id, predecessor.id);
  assert.equal(secondBatch[0]!.revision, 2);
  assert.equal(secondBatch[0]!.previous_revision, 1);
  assert.deepEqual(secondBatch[1]!.predecessor, { origin_message_id: predecessor.id, revision: 2 });
});

test('前驱 current_revision 尚未入队时，引用本批实际包含的版本，不虚构当前版可达', async (t) => {
  const server = strictServer();
  const ctx = compose(t, server.transport);
  const predecessor = ctx.submit(1);
  const successor = ctx.submit(2);
  ctx.messages.editUserMessage(predecessor.id, '合成前驱尚未排入同步的新版');
  ctx.db.prepare('DELETE FROM outbox WHERE operation_key = ?').run(`archive:${predecessor.id}:2`);
  ctx.db.prepare('UPDATE outbox SET created_at = ? WHERE operation_key = ?').run('2026-10-17T00:00:00.000Z', `archive:${predecessor.id}:1`);
  ctx.db.prepare('UPDATE outbox SET created_at = ? WHERE operation_key = ?').run('2026-10-17T00:00:01.000Z', `archive:${successor.id}:1`);
  const result = await ctx.sync.drainOnce();
  assert.deepEqual(server.dependencyFailures, []);
  assert.equal(result.acked, 2);
  const sentSuccessor = server.calls.flatMap((req) => req.messages).find((message) => message.origin_message_id === successor.id)!;
  assert.deepEqual(sentSuccessor.predecessor, { origin_message_id: predecessor.id, revision: 1 });
  const current = ctx.db.prepare('SELECT current_revision FROM messages WHERE id = ?').get(predecessor.id) as { current_revision: number };
  assert.equal(current.current_revision, 2, '同步不回退本地当前正文');
});

test('前驱无可同步版本时阻断下游，不把无效依赖永久冻结；依赖恢复后继续', async (t) => {
  const server = strictServer();
  const ctx = compose(t, server.transport);
  const predecessor = ctx.submit(1);
  ctx.submit(2);
  ctx.submit(3);
  ctx.db.prepare("UPDATE outbox SET state = 'failed', last_error = 'FIXTURE_UNAVAILABLE' WHERE operation_key = ?").run(`archive:${predecessor.id}:1`);
  await ctx.sync.drainOnce();
  assert.equal(server.calls.length, 0, '依赖未就绪不得派发下游');
  const pending = ctx.db.prepare("SELECT state, batch_id FROM outbox WHERE target = 'mariposa.archive' AND operation_key != ?").all(`archive:${predecessor.id}:1`) as Array<{ state: string; batch_id: string | null }>;
  assert.ok(pending.every((row) => row.batch_id === null && row.state === 'pending'), '待同步原文保留且没有绑定不可修复的批次');
  const frozen = ctx.db.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get() as { n: number };
  assert.equal(frozen.n, 0);
  ctx.db.prepare("UPDATE outbox SET state = 'pending', last_error = NULL WHERE operation_key = ?").run(`archive:${predecessor.id}:1`);
  const recovered = await ctx.sync.drainOnce();
  assert.equal(recovered.acked, 3);
  assert.deepEqual(server.dependencyFailures, []);
});

test('依赖排序不重建结果未知的冻结批次，后来编辑仍按原字节重放旧批次', async (t) => {
  const server = strictServer();
  let loseAck = true;
  const transport: MariposaTransport = async (capability, payload, signal) => {
    const result = await server.transport(capability, payload, signal);
    if (loseAck && result.ok) {
      loseAck = false;
      throw new Error('synthetic response lost after commit');
    }
    return result;
  };
  const ctx = compose(t, transport);
  const predecessor = ctx.submit(1);
  const successor = ctx.submit(2);
  ctx.db.prepare('UPDATE outbox SET created_at = ? WHERE operation_key = ?').run('2026-10-17T00:00:00.000Z', `archive:${predecessor.id}:1`);
  ctx.db.prepare('UPDATE outbox SET created_at = ? WHERE operation_key = ?').run('2026-10-17T00:00:01.000Z', `archive:${successor.id}:1`);
  const first = await ctx.sync.drainOnce();
  assert.equal(first.retry_later, 2);
  assert.equal(server.operations.size, 1, '模拟上游已提交而 ACK 丢失');
  ctx.messages.editUserMessage(predecessor.id, '合成前驱在未知窗口后编辑');
  ctx.submit(3);
  const next = await ctx.sync.drainOnce();
  assert.equal(next.acked, 4);
  assert.equal(server.bytes[1], server.bytes[0], '原 op 的整个请求必须字节一致');
  assert.equal(server.calls[1]!.messages[1]!.predecessor?.revision, 1);
  assert.deepEqual(server.dependencyFailures, []);
  assert.equal(server.operations.size, 2, '后续原文进入新批，重放不重复提交');
});

test('冻结批次恢复按来源顺序和修订依赖排序，逆序时间戳不改变请求字节', async (t) => {
  const server = strictServer();
  const ctx = compose(t, server.transport);
  const predecessor = ctx.submit(1);
  const successor = ctx.submit(2);
  ctx.messages.editUserMessage(predecessor.id, '合成冻结批次前驱第二版');
  const ingestMessage = (id: string, revision: number, pred: IngestMessage['predecessor']): IngestMessage => {
    const row = ctx.db.prepare('SELECT m.sequence, m.published_at, r.supersedes_revision, r.occurred_at, r.received_at, r.content, r.content_hash FROM messages m JOIN message_revisions r ON r.message_id = m.id WHERE m.id = ? AND r.revision = ?')
      .get(id, revision) as { sequence: number; published_at: string | null; supersedes_revision: number | null; occurred_at: string | null; received_at: string; content: string; content_hash: string };
    return {
      origin_message_id: id, revision, previous_revision: row.supersedes_revision,
      conversation_sequence: row.sequence, predecessor: pred, sender: 'user', published_kind: 'chat_message',
      occurred_at: row.occurred_at, received_at: row.received_at, published_at: row.published_at,
      text: row.content, assets: [], content_hash: row.content_hash,
    };
  };
  const request = (messages: IngestMessage[]): IngestRequest => ({
    operation_id: ingestOperationId('c1', messages.map((message) => ({ messageId: message.origin_message_id, revision: message.revision }))),
    stream_id: 'test-archive-dependencies', origin_instance: 'estomago', origin_conversation_id: 'c1', messages,
  });
  const first = request([ingestMessage(predecessor.id, 1, null)]);
  const second = request([
    ingestMessage(predecessor.id, 2, null),
    ingestMessage(successor.id, 1, { origin_message_id: predecessor.id, revision: 2 }),
  ]);
  const freeze = (payload: IngestRequest, timestamp: string): void => {
    const operationKeys = payload.messages.map((message) => `archive:${message.origin_message_id}:${message.revision}`);
    ctx.db.prepare("INSERT INTO ingest_batches(operation_id, conversation_id, payload_json, keys_json, state, created_at, updated_at) VALUES (?, 'c1', ?, ?, 'in_flight', ?, ?)")
      .run(payload.operation_id, JSON.stringify(payload), JSON.stringify(operationKeys), timestamp, timestamp);
    for (const operationKey of operationKeys) {
      ctx.db.prepare("UPDATE outbox SET batch_id = ?, state = 'pending', created_at = ? WHERE operation_key = ?")
        .run(payload.operation_id, timestamp, operationKey);
    }
  };
  freeze(second, '2026-10-17T00:00:00.000Z');
  freeze(first, '2026-10-17T00:00:01.000Z');
  const result = await ctx.sync.drainOnce();
  assert.deepEqual(server.dependencyFailures, [], '恢复时必须先提交前一修订的冻结批次');
  assert.equal(result.acked, 3);
  assert.equal(result.batches, 2);
  assert.deepEqual(server.bytes, [JSON.stringify(first), JSON.stringify(second)], '只调整恢复发送顺序，不重建冻结请求');
  const persisted = ctx.db.prepare('SELECT operation_id, payload_json, state FROM ingest_batches').all() as Array<{ operation_id: string; payload_json: string; state: string }>;
  assert.ok(persisted.every((batch) => batch.state === 'acked'));
  assert.equal(persisted.find((batch) => batch.operation_id === first.operation_id)!.payload_json, JSON.stringify(first));
  assert.equal(persisted.find((batch) => batch.operation_id === second.operation_id)!.payload_json, JSON.stringify(second));
});
