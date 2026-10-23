import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, pollUntil } from '../helpers.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { extractHypotheses } from '../../apps/host/src/memory-surfacing/trigger.ts';
import { estimateTokens, memoryRefFor, renderAugmentation, SURFACE_HOST_NOTICE, type SurfaceItem } from '../../apps/host/src/memory-surfacing/contracts.ts';
import { executeMemoryReadFull } from '../../apps/host/src/memory-surfacing/detail-tool.ts';

const item: SurfaceItem = { event_id: 'e1', memory_id: 'm1', memory_version: '1',
 memory_date: '2026-07-09', date_confidence: 'exact',
  event_text: '合成事件一', body_hash: 'hash1', detail_ref: 'sdr_fixture1' };
const items = [item, { ...item, event_id: 'e2', memory_id: 'm2', detail_ref: 'sdr_fixture2', event_text: '合成事件二', body_hash: 'hash2' },
  { ...item, event_id: 'e3', memory_id: 'm3', detail_ref: 'sdr_fixture3', event_text: '合成事件三', body_hash: 'hash3' }];
function fixture(opts: { prepare?: () => Promise<void>; validate?: () => Promise<void>; check?: () => Promise<void>; deadlineMs?: number; budget?: number; selected?: SurfaceItem[]; checks?: Array<{ valid?: boolean; accepted?: string[] }> } = {}) {
  const { db } = makeDb();
  const calls: string[] = [];
  const selected = opts.selected ?? [item];
  // R02：.check 逐次应答队列（空=默认 valid 全接受）——模拟装配边界复核时
  // 回执已过期/接受面收缩/权限撤销
  const checkQueue = [...(opts.checks ?? [])];
  const transport: MariposaTransport = async (cap) => {
    calls.push(cap);
    if (cap.endsWith('.prepare')) { await opts.prepare?.(); return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_fixture' } }; }
    if (cap.endsWith('.validate')) { await opts.validate?.(); return { ok: true, result: { status: 'ready', validation_receipt: 'svr_fixture', items: selected } }; }
    if (cap.endsWith('.check')) {
      await opts.check?.();
      const q = checkQueue.shift();
      return { ok: true, result: q
        ? { valid: q.valid !== false, accepted_detail_refs: q.accepted ?? selected.map(x => x.detail_ref) }
        : { valid: true, accepted_detail_refs: selected.map(x => x.detail_ref) } };
    }
    if (cap === 'memory.detail.read') return { ok: true, result: { memory_id: 'm1', sections: [] } };
    throw new Error('UNEXPECTED_CAPABILITY');
  };
  const client = new MariposaClient({ transport });
  const svc = new SurfacingService(db, client, { enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v1',
    delivery_deadline_ms: opts.deadlineMs ?? 100, max_added_tokens_per_turn: opts.budget ?? 4096, max_packet_bytes: 24576, worker_concurrency: 1 }, null);
  const messages = new MessageService(db, svc); messages.ensureConversation('c1');
  const say = (id: string, content = (id === 'a' ? '你还记得那次7.9我们把记忆库做成了吗？' : '合成普通回复')) => messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: '2026-10-19T00:00:00Z' });
  const job = (id: string) => svc.repo.jobByLogicalKey('c1', id, 1, 1, 'surface_prepare_v1')!;
  const augment = (sub: ReturnType<typeof say>, attemptId = 'a2') => svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: sub.turnId, attemptId,
    message: { id: sub.message.id, revision: 1, sequence: sub.message.sequence, content: sub.message.content, hash: 'fixture' } });
  const close = async () => { await svc.stop(); await new Promise(r => setTimeout(r, 25)); db.close(); };
  return { db, svc, client, messages, calls, say, job, augment, close };
}

test('JA-S01: target_bound is validated within deadline without a scheduler-dependent sleep', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a;
    const result = await f.augment(b);
    assert.ok(result, 'the source message receives its own verified candidate');
  } finally { await f.close(); }
});

test('JA-S02: a late source result never drifts from B to C', async () => {
  let resolve!: () => void; const gate = new Promise<void>(r => { resolve = r; });
  const f = fixture({ prepare: () => gate });
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'preparing');
    const result = await f.augment(a);
    assert.equal(result, null);
    f.say('b'); resolve();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.job(a.message.id).state, 'timed_out');
    const c = f.say('c'); await new Promise(r => setTimeout(r, 30));
    assert.notEqual(f.job(a.message.id).target_message_id, c.message.id);
  } finally { resolve(); await f.close(); }
});

test('JA-S03: packet budget is counted once and all three independent winners fit', async () => {
  const refs = new Map(items.map(x => [x.event_id, memoryRefFor(x.detail_ref)]));
  const budget = estimateTokens(SURFACE_HOST_NOTICE + renderAugmentation(items, refs));
  const f = fixture({ selected: items, budget });
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a;
    const result = await f.augment(b);
    assert.equal(result?.items.length, 3);
    assert.equal(estimateTokens(SURFACE_HOST_NOTICE + result!.text), budget);
  } finally { await f.close(); }
});

test('JA-S04: concurrent augmentation reserves a job only once', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a;
    const result = await Promise.all([f.augment(b, 'a2'), f.augment(b, 'a3')]);
    assert.equal(result.filter(Boolean).length, 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM surfacing_deliveries').get()?.n, 1);
  } finally { await f.close(); }
});

test('JA-S05: memory refs are scoped to the actual room and window', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a;
    const result = await f.augment(b); assert.ok(result); f.svc.markDispatched('a2'); f.svc.markRetained(result);
    const ref = result.memoryRefs[0].ref;
    const denied = await executeMemoryReadFull(f.svc.repo, f.client, { memory_ref: ref },
      { roomId: 'other-room', windowId: 'other-window', requestId: 'not-seen' });
    assert.equal(denied.ok, false);
    assert.equal(f.calls.filter(x => x === 'memory.detail.read').length, 0);
  } finally { await f.close(); }
});

test('JA-S06: hypotheses use Unicode code points, including supplementary characters', () => {
  const text = '🦋7.9记忆库完成。8.19结婚。';
  const cp = [...text];
  const spans = extractHypotheses(text);
  assert.equal(spans[0].end_cp, [...'🦋7.9记忆库完成。'].length);
  assert.equal(spans.map(s => cp.slice(s.start_cp, s.end_cp).join('')).join(''), text);
});

test('JA-S07: comma-separated three-event input supplies three hypotheses without guessed year', () => {
  const text = '7.9我们记忆库做成了，也是我们的结婚纪念日，8.19我们结婚。';
  const spans = extractHypotheses(text);
  assert.equal(spans.length, 3);
  assert.equal(spans.map(s => [...text].slice(s.start_cp, s.end_cp).join('')).join(''), text);
});

test('JA-S09: same-body new version updates the coverage identity instead of repeating forever', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a; const first = await f.augment(b); assert.ok(first);
    f.svc.markDispatched('a2'); f.svc.markRetained(first);
    const revised = { ...item, memory_version: '2', detail_ref: 'sdr_revision2' };
    assert.equal(f.svc.repo.coveredInWindow('c1', 'w1', [revised]).size, 0);
    f.svc.repo.markRetained(first.jobId, first.deliveryId, [revised]);
    assert.equal(f.db.prepare('SELECT memory_version FROM surfacing_coverage WHERE memory_id=?').get(item.memory_id)?.memory_version, '2');
    assert.equal(f.svc.repo.coveredInWindow('c1', 'w1', [revised]).size, 0, 'without retained trajectory no coverage is claimed');
    assert.equal(f.svc.repo.coveredInWindow('c1', 'w2', [revised]).size, 0);
  } finally { await f.close(); }
});

test('JA-S10: source route edit invalidates frozen delivery before transport admission', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a; const result = await f.augment(b); assert.ok(result);
    f.db.exec('BEGIN IMMEDIATE');
    try { f.messages.editMessageInTx(a.message.id, '合成已修改原话', { notifySurfacing: true }); f.db.exec('COMMIT'); }
    catch (err) { f.db.exec('ROLLBACK'); throw err; }
    assert.equal(f.job(a.message.id).state, 'cancelled');
    assert.throws(() => f.svc.markDispatched('a2'), /SURFACE_TARGET_CHANGED/);
    f.svc.markRetained(result);
    assert.equal(f.db.prepare('SELECT count(*) n FROM surfacing_coverage').get()?.n, 0);
  } finally { await f.close(); }
});

// —— R02（审计 J01）：最终准入——同一 check 门在最终装配边界复核 ——

test('JA-S11: happy path — finalAdmit passes through and the same gate is checked exactly twice', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a; const result = await f.augment(b); assert.ok(result);
    const admitted = await f.svc.finalAdmit(result, {
      conversationId: 'c1', windowId: 'w1', messageId: b.message.id, revision: 1,
    });
    assert.ok(admitted, 'fresh receipt passes the final gate');
    assert.equal(admitted!.deliveryId, result.deliveryId, 'the frozen package passes through unchanged');
    assert.equal(f.calls.filter(c => c.endsWith('.check')).length, 2, 'augmentFor once + finalAdmit once: single gate, same contract');
    assert.equal(f.job(a.message.id).state, 'reserved', 'pass leaves the reservation intact for dispatch');
  } finally { await f.close(); }
});

test('JA-S12: receipt stale at the assembly boundary — only the surfacing block is dropped, the main-message path survives', async () => {
  const f = fixture({ checks: [{ valid: true }, { valid: false }] });
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a; const result = await f.augment(b); assert.ok(result);
    const admitted = await f.svc.finalAdmit(result, {
      conversationId: 'c1', windowId: 'w1', messageId: b.message.id, revision: 1,
    });
    assert.equal(admitted, null, 'an expired receipt drops the surfacing block');
    const job = f.job(a.message.id);
    assert.equal(job.state, 'cancelled');
    assert.equal(job.reason_code, 'FINAL_ADMISSION_DROPPED');
    assert.equal(f.db.prepare("SELECT state FROM surfacing_deliveries WHERE id=?").get(result.deliveryId)?.state, 'dropped');
    assert.equal(f.svc.reuseFrozen('a2'), null, 'a dropped package is never reused');
    f.svc.markDispatched('a2'); // 不抛：主消息派发路径不受丢弃影响
    f.svc.markRetained(result); // 不落覆盖账
    assert.equal(f.db.prepare('SELECT count(*) n FROM surfacing_coverage').get()?.n, 0);
  } finally { await f.close(); }
});

test('JA-S13: the accepted face shrinks at the boundary — the whole block is dropped, not partially injected', async () => {
  const f = fixture({ checks: [{ valid: true }, { valid: true, accepted: [] }] });
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a; const result = await f.augment(b); assert.ok(result);
    const admitted = await f.svc.finalAdmit(result, {
      conversationId: 'c1', windowId: 'w1', messageId: b.message.id, revision: 1,
    });
    assert.equal(admitted, null, 'a shrunken accepted set drops the whole block — no partial injection');
    assert.equal(f.job(a.message.id).reason_code, 'FINAL_ADMISSION_DROPPED');
  } finally { await f.close(); }
});

test('JA-S14: target edited between freeze and assembly — final admission drops without a second chance', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a; const result = await f.augment(b); assert.ok(result);
    f.svc.repo.cancelJobsForRevision('c1', b.message.id, 1);
    const admitted = await f.svc.finalAdmit(result, {
      conversationId: 'c1', windowId: 'w1', messageId: b.message.id, revision: 1,
    });
    assert.equal(admitted, null);
    assert.equal(f.db.prepare("SELECT state FROM surfacing_deliveries WHERE id=?").get(result.deliveryId)?.state, 'dropped');
    assert.equal(f.calls.filter(c => c.endsWith('.check')).length, 1, 'local state collapse needs no extra paid-side call');
  } finally { await f.close(); }
});

test('JA-S15: a package already on the wire is reused verbatim — final admission does not rewrite mid-attempt', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); await pollUntil(() => f.job(a.message.id).state === 'prepared');
    const b = a; const result = await f.augment(b); assert.ok(result);
    f.svc.markDispatched('a2'); // 首发已过门（onBeforeDispatch）
    const admitted = await f.svc.finalAdmit(result, {
      conversationId: 'c1', windowId: 'w1', messageId: b.message.id, revision: 1,
    });
    assert.ok(admitted, 'an already-dispatched frozen package is reused as-is (docs/04)');
    assert.equal(admitted!.deliveryId, result.deliveryId);
    assert.equal(f.calls.filter(c => c.endsWith('.check')).length, 1, 'no re-check rewrites a package already on the wire');
  } finally { await f.close(); }
});


test('P3: prepare and validate spend one absolute acceptance deadline, late results never carry', async () => {
  let release!: () => void;
  const late = new Promise<void>(r => { release = r; });
  const f = fixture({ deadlineMs: 200,
    prepare: () => new Promise(r => setTimeout(r, 110)), validate: () => late });
  try {
    const a = f.say('a');
    const expires = f.job(a.message.id).expires_at;
    const result = await f.augment(a);
    assert.equal(result, null);
    assert.equal(f.job(a.message.id).state, 'timed_out');
    assert.equal(f.job(a.message.id).expires_at, expires);
    assert.equal(f.calls.filter(c => c.endsWith('.check')).length, 0);
    release(); await new Promise(r => setImmediate(r));
    assert.equal(f.job(a.message.id).state, 'timed_out');
    const b = f.say('b');
    assert.equal(await f.augment(b), null);
    assert.equal(f.db.prepare('SELECT count(*) n FROM surfacing_deliveries').get()?.n, 0);
  } finally { release(); await f.close(); }
});

test('P3: final admission does not reset an expired or malformed deadline', async () => {
  for (const expires of ['2000-01-01T00:00:00Z', 'invalid']) {
    const f = fixture();
    try {
      const a = f.say('a'); const aug = await f.augment(a); assert.ok(aug);
      f.db.prepare('UPDATE surfacing_jobs SET expires_at=? WHERE id=?').run(expires, aug.jobId);
      assert.equal(await f.svc.finalAdmit(aug, { conversationId: 'c1', windowId: 'w1', messageId: a.message.id, revision: 1 }), null);
      assert.equal(f.calls.filter(c => c.endsWith('.check')).length, 1);
      assert.equal(f.svc.reuseFrozen('a2'), null);
    } finally { await f.close(); }
  }
});

test('P3: revision revoked while final check is in flight cannot admit a frozen block', async () => {
  let checkCount = 0; let began!: () => void; let release!: () => void;
  const checking = new Promise<void>(r => { began = r; });
  const gate = new Promise<void>(r => { release = r; });
  const f = fixture({ deadlineMs: 1000, check: async () => { if (++checkCount === 2) { began(); await gate; } } });
  try {
    const a = f.say('a'); const aug = await f.augment(a); assert.ok(aug);
    const admitting = f.svc.finalAdmit(aug, { conversationId: 'c1', windowId: 'w1', messageId: a.message.id, revision: 1 });
    await checking;
    f.messages.editUserMessage(a.message.id, '改写后的有效修订');
    release();
    assert.equal(await admitting, null);
    assert.equal(f.svc.reuseFrozen('a2'), null);
    assert.equal(f.job(a.message.id).state, 'cancelled');
  } finally { release(); await f.close(); }
});

test('P3: retained same-turn recall preserves P1 follow-up intent without reusing its delivery', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); const aug = await f.augment(a); assert.ok(aug);
    f.svc.markDispatched('a2'); f.svc.markRetained(aug);
    const b = f.say('b', '后来呢');
    const next = f.job(b.message.id); assert.ok(next);
    assert.notEqual(next.id, aug.jobId);
    assert.equal(next.source_message_id, b.message.id);
    assert.equal(next.target_message_id, b.message.id);
    assert.equal(f.job(a.message.id).state, 'retained');
  } finally { await f.close(); }
});

test('P3: concurrent assembly before worker wake calls prepare only once', async () => {
  const f = fixture({ prepare: () => new Promise(r => setTimeout(r, 10)) });
  try {
    const a = f.say('a');
    const results = await Promise.all([f.augment(a, 'one'), f.augment(a, 'two')]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(f.calls.filter(c => c.endsWith('.prepare')).length, 1);
    assert.equal(f.calls.filter(c => c.endsWith('.validate')).length, 1);
  } finally { await f.close(); }
});


test('P3: an edited retained source cannot supply follow-up intent from its stale revision', async () => {
  const f = fixture();
  try {
    const a = f.say('a'); const aug = await f.augment(a); assert.ok(aug);
    f.svc.markDispatched('a2'); f.svc.markRetained(aug);
    f.messages.editUserMessage(a.message.id, '切换成普通聊天');
    const b = f.say('b', '后来呢');
    assert.equal(f.job(b.message.id), null);
    assert.equal(f.job(a.message.id).state, 'retained', 'historical delivery remains factual');
  } finally { await f.close(); }
});

test('校准预算容纳超过旧2秒的准备，仍只允许原消息同轮交付', async () => {
  for (const deadlineMs of [2000, 15000]) {
    const realNow = Date.now;
    const f = fixture({ deadlineMs, prepare: async () => { Date.now = () => realNow() + 2500; } });
    try {
      const input = f.say('budget-' + deadlineMs, '还记得我们第一次去海边看日出吗？');
      const result = await f.augment(input);
      assert.equal(result !== null, deadlineMs === 15000);
      const job = f.db.prepare('SELECT source_message_id,target_message_id,source_revision,target_revision FROM surfacing_jobs').get() as any;
      assert.equal(job.source_message_id, input.message.id);
      assert.equal(job.target_message_id, input.message.id);
      assert.equal(job.source_revision, job.target_revision);
    } finally { Date.now = realNow; await f.close(); }
  }
});
