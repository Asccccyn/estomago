// WP2 回归：原文归档同步（假 transport，零网络）+ Mariposa 客户端收据形状。
// 契约：docs/specs/MARIPOSA_LIFECYCLE_v1.0/contracts/。端到端联调在 Mariposa 侧接口落地前保持 BLOCKED，
// 本文件只证明 estómago 侧消费者语义：幂等 op、崩溃重放、有序不跳过、冲突 dead、批量切分、编辑链。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { ArchiveSyncService } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';
import { MariposaClient, ingestOperationId, type IngestMessage, type IngestRequest, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { tempRoot } from '../helpers.ts';

type ServerState = {
  committed: Map<string, { payload: IngestRequest; ack: Record<string, unknown> }>;
};

// 假 Mariposa：按契约语义实现——同 op 同 payload 重放同 ACK；同 op 不同 payload 冲突。
function fakeServer(onCall?: (cap: string, payload: Record<string, unknown>) => void) {
  const state: ServerState = { committed: new Map() };
  const transport: MariposaTransport = async (capability, payload) => {
    onCall?.(capability, payload);
    if (capability === 'source.ingest') {
      const req = payload as unknown as IngestRequest;
      const canonical = JSON.stringify(req.messages);
      const prev = state.committed.get(req.operation_id);
      if (prev) {
        if (JSON.stringify(prev.payload.messages) !== canonical) return { ok: false, code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 };
        return { ok: true, result: prev.ack };
      }
      const ack = {
        operation_id: req.operation_id,
        committed_at: new Date().toISOString(),
        messages: req.messages.map((m) => ({
          origin_message_id: m.origin_message_id, revision: m.revision,
          source_conversation_id: `mconv-${req.origin_conversation_id}`,
          source_message_id: `msrc-${m.origin_message_id}-r${m.revision}`,
          content_hash: m.content_hash,
        })),
        batch_ref: `batch-${state.committed.size + 1}`,
        integrity: 'complete',
      };
      state.committed.set(req.operation_id, { payload: req, ack });
      return { ok: true, result: ack };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  return { state, transport };
}

function compose(root: string, transport: MariposaTransport) {
  const config = buildConfig({
    archive: { enabled: true, source_scope: 'estomago-primary-live' },
    integrations: { mariposa: { base_url: 'http://mariposa.test', credential_ref: 'MARIPOSA_TEST_TOKEN' } },
  });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const client = new MariposaClient({ transport });
  const sync = new ArchiveSyncService({ db, events, logger, client, config });
  return { db, config, paths, messages, events, client, sync };
}

const ackAll = (req: IngestRequest): Record<string, unknown> => ({
  operation_id: req.operation_id, committed_at: new Date().toISOString(),
  messages: req.messages.map((m) => ({ origin_message_id: m.origin_message_id, revision: m.revision, source_conversation_id: 'mc', source_message_id: `msrc-${m.origin_message_id}-r${m.revision}`, content_hash: m.content_hash })),
});

test('正常链：用户消息+助手发布 → 同批 ACK、收据落表、outbox acked；重复 drain 不重发', async () => {
  const root = tempRoot('msync-');
  const { state, transport } = fakeServer();
  const ctx = compose(root, transport);
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一句', clientMessageId: 'k1' });
  ctx.messages.publishAssistantMessage({ conversationId: 'c1', turnId: 't_fake', content: '回应一' });
  const s1 = await ctx.sync.drainOnce();
  assert.equal(s1.batches, 1);
  assert.equal(s1.acked, 2);
  const rows = ctx.db.prepare("SELECT state FROM outbox WHERE target='mariposa.archive'").all() as Array<{ state: string }>;
  assert.ok(rows.every((r) => r.state === 'acked'));
  // 收据：origin→source 身份映射
  const receipts = ctx.db.prepare('SELECT origin_message_id, revision, source_message_id FROM source_sync_receipts ORDER BY revision').all() as Array<{ origin_message_id: string; revision: number; source_message_id: string }>;
  assert.equal(receipts.length, 2);
  assert.ok(receipts[0]!.source_message_id.startsWith('msrc-'));
  // 再次 drain：无新内容，不重发
  const s2 = await ctx.sync.drainOnce();
  assert.equal(s2.batches, 0);
  assert.equal(state.committed.size, 1);
  // 只读状态快照
  const snap = ctx.sync.rawSyncState('c1');
  assert.deepEqual(snap, { pending: 0, unknown_outcome: 0, failed: 0, acked: 2, enabled: true });
  ctx.db.close();
});

test('崩溃窗口：发送后崩溃 → unknown_outcome → 同 op 重发 → 服务端重放同 ACK（不换 op 盲建）', async () => {
  const root = tempRoot('mcrash-');
  const { state, transport } = fakeServer();
  let failOnce = true;
  const wrapping: MariposaTransport = async (cap, payload) => {
    if (cap === 'source.ingest' && failOnce) {
      // 模拟"服务端已提交、响应丢失"：先让假服务端落 committed，再抛网络错误
      await transport(cap, payload);
      failOnce = false;
      throw new Error('fetch failed: socket hang up');
    }
    return transport(cap, payload);
  };
  const ctx = compose(root, wrapping);
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '崩溃前的消息', clientMessageId: 'k1' });
  const s1 = await ctx.sync.drainOnce();
  assert.equal(s1.retry_later, 1);
  let st = ctx.db.prepare("SELECT state FROM outbox WHERE target='mariposa.archive'").get() as { state: string };
  assert.equal(st.state, 'unknown_outcome');
  assert.equal(state.committed.size, 1, '假服务端已收到并提交（模拟响应丢失）');
  const s2 = await ctx.sync.drainOnce();
  assert.equal(s2.acked, 1);
  st = ctx.db.prepare("SELECT state FROM outbox WHERE target='mariposa.archive'").get() as { state: string };
  assert.equal(st.state, 'acked');
  assert.equal(state.committed.size, 1, '重放同 op——服务端没有第二份提交');
  ctx.db.close();
});

test('SOURCE_NOT_READY：停流不跳过；依赖就绪后同批续传', async () => {
  const root = tempRoot('mready-');
  let rejectNext = true;
  const calls: string[] = [];
  const { transport } = fakeServer((_cap, payload) => {
    const req = payload as unknown as IngestRequest;
    calls.push(req.messages.map((m) => `${m.origin_message_id}@${m.revision}`).join(','));
  });
  const wrapping: MariposaTransport = async (cap, payload) => {
    const r = await transport(cap, payload);
    if (r.ok && rejectNext) {
      rejectNext = false;
      return { ok: false, code: 'SOURCE_NOT_READY', httpStatus: 409 };
    }
    return r;
  };
  const ctx = compose(root, wrapping);
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'A', clientMessageId: 'a' });
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'B', clientMessageId: 'b' });
  const s1 = await ctx.sync.drainOnce();
  assert.equal(s1.retry_later, 2, '同流整批回退 pending');
  const st1 = ctx.db.prepare("SELECT COUNT(*) n FROM outbox WHERE state='pending'").get() as { n: number };
  assert.equal(st1.n, 2, '不标 dead，等待重试');
  const s2 = await ctx.sync.drainOnce();
  assert.equal(s2.acked, 2);
  assert.equal(calls.length, 2, '两次发送，内容一致');
  ctx.db.close();
});

test('IDEMPOTENCY_CONFLICT（同 op 不同 payload）→ dead + 事件披露，不盲重试', async () => {
  const root = tempRoot('mconf-');
  const { transport } = fakeServer();
  let flip = false;
  const wrapping: MariposaTransport = async (cap, payload) => {
    if (cap === 'source.ingest' && flip) {
      // 第二次同 op 但服务端视角 payload 不同（模拟派生不稳定或服务端碰撞）
      flip = false;
      return { ok: false, code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 };
    }
    flip = true;
    return transport(cap, payload);
  };
  const ctx = compose(root, wrapping);
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'X', clientMessageId: 'x' });
  const s1 = await ctx.sync.drainOnce();
  assert.equal(s1.acked, 1);
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'Y', clientMessageId: 'y' });
  const s2 = await ctx.sync.drainOnce();
  assert.equal(s2.dead >= 1, true, '冲突行标 dead');
  const failed = ctx.db.prepare("SELECT last_error FROM outbox WHERE state='failed'").all() as Array<{ last_error: string }>;
  assert.equal(failed[0]!.last_error, 'IDEMPOTENCY_CONFLICT');
  // 事件披露（元数据，无正文）
  const ev = ctx.db.prepare("SELECT COUNT(*) n FROM runtime_stream_events WHERE kind='archive.sync'").get() as { n: number };
  assert.ok((ev.n ?? 0) >= 1);
  ctx.db.close();
});

test('编辑链：新修订带 previous_revision；旧修订行独立同步（不可变证据，不覆盖）', async () => {
  const root = tempRoot('medit-');
  const seen: IngestMessage[] = [];
  const { transport } = fakeServer((_c, p) => {
    for (const m of (p as unknown as IngestRequest).messages) seen.push(m);
  });
  const ctx = compose(root, transport);
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '原始话', clientMessageId: 'e1' });
  await ctx.sync.drainOnce();
  ctx.messages.editUserMessage(sub.message.id, '改后的完整正文');
  await ctx.sync.drainOnce();
  const r1 = seen.find((m) => m.revision === 1)!;
  const r2 = seen.find((m) => m.revision === 2)!;
  assert.equal(r1.text, '原始话');
  assert.equal(r2.text, '改后的完整正文');
  assert.equal(r2.previous_revision, 1);
  assert.equal(r2.origin_message_id, r1.origin_message_id);
  assert.equal(r2.conversation_sequence, r1.conversation_sequence);
  // 两版收据各自落库（版本正文可读回，不静默覆盖首版）
  const receipts = ctx.db.prepare('SELECT revision FROM source_sync_receipts ORDER BY revision').all() as Array<{ revision: number }>;
  assert.deepEqual(receipts.map((r) => r.revision), [1, 2]);
  ctx.db.close();
});

test('批量上限：>50 条切批（两个稳定 op）；单条超 1MiB 标死不截断', async () => {
  const root = tempRoot('mbatch-');
  const ops: string[] = [];
  const { transport } = fakeServer((_c, p) => { ops.push((p as unknown as IngestRequest).operation_id); });
  const ctx = compose(root, transport);
  for (let i = 0; i < 120; i++) {
    ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `消息 ${i}`, clientMessageId: `b${i}` });
  }
  const s = await ctx.sync.drainOnce();
  assert.equal(s.batches, 3, '120 条 → 50+50+20');
  assert.equal(new Set(ops).size, 3, '每批独立稳定 op');
  assert.equal(s.acked, 120);
  // 单条超限
  const huge = '大'.repeat(600 * 1024); // JSON 序列化后 >1MiB
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: huge, clientMessageId: 'huge' });
  const s2 = await ctx.sync.drainOnce();
  assert.equal(s2.dead, 1);
  const dead = ctx.db.prepare("SELECT last_error FROM outbox WHERE state='failed' AND last_error='OVERSIZED_MESSAGE'").all();
  assert.equal(dead.length, 1, '明确报错，不静默截断（大对象路径不在本任务）');
  ctx.db.close();
});

test('未启用（archive.enabled=false）→ drain no-op、outbox 保持 pending（待同步语义）', async () => {
  const root = tempRoot('mdis-');
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const config = buildConfig({}); // archive.enabled 默认 false
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '先存本地', clientMessageId: 'd1' });
  const sync = new ArchiveSyncService({ db, events: new EventService(db), logger: new Logger(null), client: new MariposaClient({ transport: async () => ({ ok: true, result: {} }) }), config });
  const s = await sync.drainOnce();
  assert.equal(s.skipped_disabled, true);
  const st = db.prepare("SELECT state FROM outbox").get() as { state: string };
  assert.equal(st.state, 'pending', '不发送也不删除——本地已保存，远端未同步，如实展示');
  db.close();
});

test('operation_id 派生稳定：同集合同序无关（排序规范化）', () => {
  const a = ingestOperationId('c1', [{ messageId: 'm1', revision: 1 }, { messageId: 'm2', revision: 1 }]);
  const b = ingestOperationId('c1', [{ messageId: 'm2', revision: 1 }, { messageId: 'm1', revision: 1 }]);
  const c = ingestOperationId('c1', [{ messageId: 'm1', revision: 2 }]);
  const d = ingestOperationId('c2', [{ messageId: 'm1', revision: 1 }]);
  assert.equal(a, b, '集合相同 → 同 op（崩溃重发安全）');
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test('memory.hold 客户端：operation_id 必带、回执形状校验、holdStatus 无记录≠没写过', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const transport: MariposaTransport = async (capability, payload) => {
    calls.push({ cap: capability, payload });
    if (capability === 'memory.hold') {
      return { ok: true, result: { operation_id: payload.operation_id, memory_id: 'mem-1', version: 3, binding_ids: ['bd-1'], committed_at: '2026-10-05T00:00:00Z' } };
    }
    if (capability === 'memory.hold.status') {
      return { ok: true, result: payload.operation_id === 'op-known' ? { operation_id: 'op-known', memory_id: 'mem-1', version: 3, binding_ids: [], committed_at: '2026-10-05T00:00:00Z' } : { found: false } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const client = new MariposaClient({ transport });
  const hold = await client.memoryHold({ operationId: 'op-h1', holdPayload: { category: 'daily', text: '合成内容', creation_mode: 'live' }, sourceSelections: [{ conversation_id: 'mc', members: [{ source_message_id: 'msrc-1', content_hash: 'a'.repeat(64) }] }] });
  assert.ok(hold.ok && hold.receipt?.memory_id === 'mem-1' && hold.receipt.version === 3 && hold.receipt.binding_ids[0] === 'bd-1');
  assert.equal(calls[0]!.payload.operation_id, 'op-h1', '宿主自动化路径必须带 operation_id（§5）');
  assert.deepEqual((calls[0]!.payload.source_selections as Array<{ conversation_id: string }>)[0]!.conversation_id, 'mc');
  // 坏回执形状 → 明确错误，不吞成成功
  const badTransport: MariposaTransport = async () => ({ ok: true, result: { foo: 1 } });
  const bad = await new MariposaClient({ transport: badTransport }).memoryHold({ operationId: 'op-x', holdPayload: {} });
  assert.ok(!bad.ok && !bad.ok && (bad as { code: string }).code === 'RECEIPT_SHAPE_INVALID');
  // status：无记录 = 尚无提交证据
  const known = await client.holdStatus('op-known');
  assert.ok(known.ok && known.receipt?.memory_id === 'mem-1');
  const unknown = await client.holdStatus('op-none');
  assert.ok(unknown.ok && unknown.receipt === undefined, '无记录只代表尚无提交证据，不当成失败也不当没写过');
});
