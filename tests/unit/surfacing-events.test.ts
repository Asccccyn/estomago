// R05（审计 J02）：后台浮现生命周期事件合同——状态提交处发 surface.job
// 事件（job/source/target/delivery 身份+reason）；正文绝不进事件；
// 读取路径零事件；恢复/撤销/重复派发各有真实身份。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {makeDb, pollUntil } from '../helpers.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { bindMessageLifecycle as bindSurfacingForTest } from '../../apps/host/src/application/message-lifecycle.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import type { SurfaceItem } from '../../apps/host/src/memory-surfacing/contracts.ts';

const item: SurfaceItem = { event_id: 'e1', memory_id: 'm1', memory_version: '1',
 memory_date: '2026-07-09', date_confidence: 'exact',
  event_text: '合成事件一', body_hash: 'hash1', detail_ref: 'sdr_fixture1' };

type ValidateResult = { status: string; validation_receipt?: string; items?: SurfaceItem[]; reason_code?: string | null };

function fixture(opts: { validate?: () => ValidateResult; validateOk?: boolean } = {}) {
  const { db } = makeDb();
  const events = new EventService(db);
  const transport: MariposaTransport = async (cap) => {
    if (cap.endsWith('.prepare')) return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_fixture' } };
    if (cap.endsWith('.validate')) {
      if (opts.validateOk === false) return { ok: false, code: 'SURFACE_BUDGET_EXHAUSTED' };
      const v = opts.validate?.() ?? { status: 'ready', validation_receipt: 'svr_fixture', items: [item] };
      return { ok: true, result: v };
    }
    if (cap.endsWith('.check')) return { ok: true, result: { valid: true, accepted_detail_refs: [item.detail_ref] } };
    throw new Error('UNEXPECTED_CAPABILITY');
  };
  const client = new MariposaClient({ transport });
  const svc = new SurfacingService(db, client, { enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v1',
    delivery_deadline_ms: 100, max_added_tokens_per_turn: 4096, max_packet_bytes: 24576, worker_concurrency: 1 }, null, events);
  const messages = new MessageService(db, bindSurfacingForTest({ surfacing: svc, activity: null })); messages.ensureConversation('c1');
  const say = (id: string, content = (id === 'a' ? '你还记得那次7.9我们把记忆库做成了吗？' : '合成普通回复')) => messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: '2026-10-19T00:00:00Z' });
  const job = (id: string) => svc.repo.jobByLogicalKey('c1', id, 1, 1, 'surface_prepare_v1')!;
  const flush = () => new Promise<void>(r => setImmediate(r));
  const surfaceEvents = () => (db.prepare(
    "SELECT payload_ref FROM runtime_stream_events WHERE kind='surface.job' ORDER BY sequence",
  ).all() as Array<{ payload_ref: string }>).map(r => JSON.parse(r.payload_ref) as Record<string, unknown>);
  const close = async () => { await svc.stop(); await new Promise(r => setTimeout(r, 25)); db.close(); };
  return { db, svc, messages, say, job, flush, surfaceEvents, close };
}

test('R05：prepare 链路逐状态发事件，身份齐全且零正文', async () => {
  const f = fixture();
  try {
    const a = f.say('a');
    await pollUntil(() => f.job(a.message.id).state === 'prepared');
    await f.flush();
    const evs = f.surfaceEvents();
    assert.ok(evs.length >= 2, `pending→preparing→prepared 至少两跳，got ${evs.length}`);
    const path = evs.map(e => `${e.from}->${e.to}`).join(',');
    assert.ok(path.includes('preparing') && path.includes('prepared'), path);
    for (const ev of evs) {
      assert.equal(ev.job_id, f.job(a.message.id).id);
      assert.equal(ev.conversation_id, 'c1');
      assert.equal(ev.source_message_id, a.message.id);
      assert.ok('reason_code' in ev && 'target_message_id' in ev && 'delivery_id' in ev);
    }
    assert.ok(!JSON.stringify(evs).includes('合成事件'), '正文不进事件');
    assert.ok(!JSON.stringify(evs).includes('回忆浮现'), '渲染块不进事件');
  } finally { await f.close(); }
});

test('R05：绑定+冻结+派发带 delivery/attempt/window 身份；重复派发不重复发声', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a;
    const result = await f.svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: b.turnId, attemptId: 'a2',
      message: { id: b.message.id, revision: 1, sequence: b.message.sequence, content: b.message.content, hash: 'fixture' } });
    assert.ok(result);
    await f.flush();
    const bound = f.surfaceEvents().find(e => e.to === 'target_bound');
    assert.ok(bound, 'target_bound 事件存在');
    assert.equal(bound!.target_message_id, b.message.id);

    f.svc.markDispatched('a2');
    f.svc.markDispatched('a2'); // 重复派发：第二次 CAS 落空=零事件
    await f.flush();
    const evs = f.surfaceEvents();
    const frozen = evs.find(e => e.to === 'reserved');
    assert.ok(frozen, '冻结事件存在');
    assert.equal(frozen!.delivery_id, result!.deliveryId);
    assert.equal(frozen!.attempt_id, 'a2');
    assert.equal(frozen!.window_id, 'w1');
    const dispatched = evs.filter(e => e.to === 'dispatch_started');
    assert.equal(dispatched.length, 1, '重复派发不重复发声');
    assert.equal(dispatched[0]!.delivery_id, result!.deliveryId);
  } finally { await f.close(); }
});

test('R05：装配期 validate 拒绝→rejected 带原因；预算拒绝→blocked 带原因码', async () => {
  const f = fixture({ validate: () => ({ status: 'rejected', reason_code: 'SURFACE_NOT_RELEVANT_NOW' }) });
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a;
    const result = await f.svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: b.turnId, attemptId: 'a2',
      message: { id: b.message.id, revision: 1, sequence: b.message.sequence, content: b.message.content, hash: 'fixture' } });
    assert.equal(result, null);
    await pollUntil(() => f.job(a.message.id).state === 'rejected');
    await f.flush();
    const ev = f.surfaceEvents().find(e => e.to === 'rejected');
    assert.ok(ev, 'rejected 事件');
    assert.equal(ev!.reason_code, 'SURFACE_NOT_RELEVANT_NOW');
  } finally { await f.close(); }

  const f2 = fixture({ validateOk: false });
  try {
    const a = f2.say('a'); await pollUntil(() => f2.job(a.message.id).state === 'prepared');
    const b = a;
    const result = await f2.svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: b.turnId, attemptId: 'a2',
      message: { id: b.message.id, revision: 1, sequence: b.message.sequence, content: b.message.content, hash: 'fixture' } });
    assert.equal(result, null);
    await pollUntil(() => f2.job(a.message.id).state === 'blocked');
    await f2.flush();
    const ev = f2.surfaceEvents().find(e => e.to === 'blocked');
    assert.ok(ev, 'blocked 事件（预算/上游拒绝）');
    assert.equal(ev!.reason_code, 'SURFACE_BUDGET_EXHAUSTED');
  } finally { await f2.close(); }
});

test('R05：编辑撤销→cancelled（SOURCE_OR_TARGET_REVISED）；恢复→expired 各有身份', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    f.db.exec('BEGIN IMMEDIATE');
    try { f.messages.editMessageInTx(a.message.id, '合成已修改', { notifySurfacing: true }); f.db.exec('COMMIT'); }
    catch (err) { f.db.exec('ROLLBACK'); throw err; }
    await f.flush();
    const ev = f.surfaceEvents().find(e => e.to === 'cancelled');
    assert.ok(ev, 'cancelled 事件');
    assert.equal(ev!.reason_code, 'SOURCE_OR_TARGET_REVISED');
    assert.equal(ev!.job_id, f.job(a.message.id).id);
  } finally { await f.close(); }

  const f2 = fixture();
  try {
    const a = f2.say('a'); await pollUntil(() => f2.job(a.message.id).state === 'preparing' || f2.job(a.message.id).state === 'prepared');
    f2.db.prepare("UPDATE surfacing_jobs SET state='preparing' WHERE id=?").run(f2.job(a.message.id).id);
    await f2.svc.start(); // 崩溃恢复：中断态收口
    await f2.flush();
    const ev = f2.surfaceEvents().find(e => e.to === 'expired');
    assert.ok(ev, '恢复收口事件');
    assert.equal(ev!.job_id, f2.job(a.message.id).id);
  } finally { await f2.close(); }
});

test('R05：读取路径零事件（刷新不触发任何 surface.job，也不唤醒 recall）', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    await f.flush();
    const before = f.surfaceEvents().length;
    f.svc.repo.jobById(f.job(a.message.id).id);
    f.svc.repo.pendingJobs();
    f.svc.repo.recoverableJobs();
    f.svc.reuseFrozen('nonexistent');
    await f.flush();
    assert.equal(f.surfaceEvents().length, before, '纯读取零事件');
  } finally { await f.close(); }
});
