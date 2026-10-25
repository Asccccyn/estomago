// 复审整改批次 B 回归（F08 收紧/F10 完整回执/F15 500+上限/F16 信封字节）。
import { test } from 'node:test';
import { assembleTestTools, tempRoot, writeApprovedIdentity } from '../helpers.ts';
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
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { ArchiveSyncService } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';

const T0 = '2026-10-01T08:00:00+08:00';
type EffectRow = { id: string; state: string; operation_id: string | null; seen_sequence: number | null };

function effectsOf(db: ReturnType<typeof openDatabase>): EffectRow[] {
  return db.prepare('SELECT id, state, operation_id, seen_sequence FROM tool_side_effects ORDER BY rowid').all() as EffectRow[];
}

test('F08：损坏的 status 响应（200 无回执无 completed）保持 unknown 并阻断换窗；显式 completed=false 才判未提交；fetch throw 收口 unknown', async () => {
  // 子场景逐个用独立 root：corrupt → unknown；completed=false → failed_resolved；throw → unknown
  const run = async (mode: 'corrupt' | 'definitive' | 'throw') => {
    const root = tempRoot(`r6-${mode}-`);
    writeApprovedIdentity(root);
    const config = buildConfig({ runtime: { provider: 'openrouter' }, openrouter: { model: 'anthropic/claude-test-1' } });
    const db = openDatabase(path.join(root, 'data'));
    migrate(db, sha256Hex);
    const events = new EventService(db);
    const messages = new MessageService(db);
    messages.ensureConversation('c1');
    const m: MariposaTransport = async (cap) => {
      if (cap === 'memory.hold.status') {
        if (mode === 'corrupt') return { ok: true, result: { operation_id: 'op-1' } }; // 200 垃圾体：无 receipt 无 completed
        if (mode === 'definitive') return { ok: true, result: { operation_id: 'op-1', completed: false } };
        throw new Error('fetch failed: socket hang up');
      }
      return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    };
    const reviews = new RotationReviewService(db);
    const checkpoint = new HoldCheckpointService(db);
    const { tools: tools } = assembleTestTools({ db: db, mariposa: new MariposaClient({ transport: m }), reviews: reviews, checkpoint: checkpoint });
    // 直接落一个 unknown hold 效果（模拟聊天中 503）
    const effId = reviews.openEffect({ reviewId: null, turnId: null, windowId: 'win_x', kind: 'hold', operationId: 'op-1', toolCallId: 'tc', seenSequence: 3 });
    reviews.settleEffect(effId, 'unknown', false, null);
    const r = await tools.recoverUnknownEffects('c1', 'win_x');
    return { r, state: (db.prepare('SELECT state FROM tool_side_effects WHERE id = ?').get(effId) as { state: string }).state, db };
  };
  const corrupt = await run('corrupt');
  assert.equal(corrupt.r.stillUnknown, 1);
  assert.equal(corrupt.state, 'unknown', '损坏回执不自动消解（F08）');
  corrupt.db.close();
  const def = await run('definitive');
  assert.equal(def.r.resolved, 1);
  assert.equal(def.state, 'failed_resolved', '结构化 completed=false=可判定未提交');
  def.db.close();
  const thr = await run('throw');
  assert.equal(thr.r.stillUnknown, 1);
  assert.equal(thr.state, 'unknown', 'fetch throw=unknown（不是失败、更不留 running）');
  thr.db.close();
});

test('F10：骨架 ACK（origin/revision 有、来源证据全 null）不再整批 acked', async () => {
  const root = tempRoot('r6-f10-');
  writeApprovedIdentity(root);
  const config = buildConfig({ archive: { enabled: true, source_scope: 's' }, integrations: { mariposa: { base_url: 'http://127.0.0.1:9', credential_ref: null } } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const logger = new Logger(path.join(root, 'logs'));
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const m: MariposaTransport = async (cap, payload) => {
    if (cap !== 'source.ingest') return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    const req = payload as unknown as { operation_id: string; messages: Array<{ origin_message_id: string; revision: number }> };
    return { ok: true, result: { operation_id: req.operation_id, committed_at: new Date().toISOString(), messages: req.messages.map((x) => ({ origin_message_id: x.origin_message_id, revision: x.revision, source_conversation_id: null, source_message_id: null, content_hash: null })) } };
  };
  const sync = new ArchiveSyncService({ db, events, logger, client: new MariposaClient({ transport: m }), config });
  messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'X', clientMessageId: 'x1', occurredAt: T0 });
  await sync.drainOnce();
  const row = db.prepare("SELECT state, last_error FROM outbox WHERE target='mariposa.archive'").get() as { state: string; last_error: string };
  assert.equal(row.state, 'unknown_outcome', '证据字段不完整=结果不明，不冒充已同步');
  assert.equal(row.last_error, 'ACK_FIELDS_INCOMPLETE');
  db.close();
});

test('F15：500 可重试不一次死；transport throw 超过 attempts 上限后 TRANSIENT_EXHAUSTED', async () => {
  const root = tempRoot('r6-f15-');
  writeApprovedIdentity(root);
  const config = buildConfig({ archive: { enabled: true, source_scope: 's' }, integrations: { mariposa: { base_url: 'http://127.0.0.1:9', credential_ref: null } } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const logger = new Logger(path.join(root, 'logs'));
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  let calls = 0;
  let succeedAt = 2;
  const m: MariposaTransport = async (cap) => {
    if (cap !== 'source.ingest') return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    calls++;
    if (calls < succeedAt) return { ok: false, code: 'HTTP_500', httpStatus: 500 };
    const req = { operation_id: `op-${calls}`, messages: [] as Array<{ origin_message_id: string; revision: number; content_hash: string }> };
    void req;
    return { ok: false, code: 'HTTP_500', httpStatus: 500 }; // 简化：500 路径断言用，成功路径由既有套件覆盖
  };
  const sync = new ArchiveSyncService({ db, events, logger, client: new MariposaClient({ transport: m }), config });
  messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'R', clientMessageId: 'r1', occurredAt: T0 });
  await sync.drainOnce();
  let row = db.prepare("SELECT state, last_error FROM outbox WHERE target='mariposa.archive'").get() as { state: string; last_error: string };
  assert.equal(row.state, 'pending', '500=瞬时，回 pending 不一次 dead');
  // 耗尽路径：throw 型一直失败 12 次
  const root2 = tempRoot('r6-f15b-');
  writeApprovedIdentity(root2);
  const db2 = openDatabase(path.join(root2, 'data'));
  migrate(db2, sha256Hex);
  const events2 = new EventService(db2);
  const logger2 = new Logger(path.join(root2, 'logs'));
  const messages2 = new MessageService(db2);
  messages2.ensureConversation('c1');
  const m2: MariposaTransport = async (cap) => {
    if (cap !== 'source.ingest') return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    throw new Error('fetch failed: ECONNRESET');
  };
  const sync2 = new ArchiveSyncService({ db: db2, events: events2, logger: logger2, client: new MariposaClient({ transport: m2 }), config });
  messages2.submitUserMessageWithTurn({ conversationId: 'c1', content: 'T', clientMessageId: 't1', occurredAt: T0 });
  for (let i = 0; i < 12; i++) await sync2.drainOnce();
  row = db2.prepare("SELECT state, last_error FROM outbox WHERE target='mariposa.archive'").get() as { state: string; last_error: string };
  assert.equal(row.state, 'failed');
  assert.equal(row.last_error, 'TRANSIENT_EXHAUSTED', 'throw 路径也吃 attempts 上限（原来 12 次仍 in_flight）');
  db.close();
  db2.close();
});

test('F16：审计临界消息（信封化后 >1MiB）被拒——信封开销计入', async () => {
  const root = tempRoot('r6-f16-');
  writeApprovedIdentity(root);
  const config = buildConfig({ archive: { enabled: true, source_scope: 's' }, integrations: { mariposa: { base_url: 'http://127.0.0.1:9', credential_ref: null } } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const logger = new Logger(path.join(root, 'logs'));
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const m: MariposaTransport = async (cap) => (cap === 'source.ingest' ? { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 } : { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 });
  const sync = new ArchiveSyncService({ db, events, logger, client: new MariposaClient({ transport: m }), config });
  // 审计临界：单条消息 JSON 1048526B（裸正文略小于 1MiB，信封化后 1048692B > 1048576）
  const filler = 'x'.repeat(1048526 - 60);
  messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `{"k":"${filler}"}`.slice(0, 1048526 - 40), clientMessageId: 'q1', occurredAt: T0 });
  const summary = await sync.drainOnce();
  assert.ok(summary.dead >= 1 || summary.batches === 0, '信封化超限被拒（不再只按裸正文判界）');
  const row = db.prepare("SELECT state, last_error FROM outbox WHERE target='mariposa.archive'").get() as { state: string; last_error: string | null };
  assert.equal(row.state, 'failed');
  assert.equal(row.last_error, 'OVERSIZED_MESSAGE');
  db.close();
});
