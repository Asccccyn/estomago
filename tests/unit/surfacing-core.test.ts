// 自动记忆浮现 · 合同/仓库/服务核心（EST_MARIPOSA_AUTO_SURFACING_V1）。
// 最新合同：整包一次来源声明、日期+正文+短 ref、同步同轮同修订、幂等
// （AC025）、无次优补位（AC055 由 M 侧合同+本侧预算跳过共保）。
import { test } from 'node:test';
import { pollUntil, tempRoot } from '../helpers.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { renderAugmentation, memoryRefFor, SURFACE_HOST_NOTICE, surfaceTransportMessage } from '../../apps/host/src/memory-surfacing/contracts.ts';
import { SurfacingRepository } from '../../apps/host/src/memory-surfacing/repository.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import type { SurfaceItem } from '../../apps/host/src/memory-surfacing/contracts.ts';

const T0 = '2026-10-19T09:00:00+08:00';

function makeDb(root: string) {
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  return db;
}

const ITEM: SurfaceItem = {
  event_id: 'ev_1', memory_id: '00001', memory_version: '1',
 memory_date: '2026-07-09',
  date_confidence: 'exact', event_text: '7月9日我们把记忆库建成了',
  body_hash: 'b'.repeat(64), detail_ref: 'sdr_abc',
};

test('new surfacing data has one source/past-event notice on both chat adapters', () => {
  for (const provider of ['deepseek','openrouter']) {
    const message = surfaceTransportMessage(provider, renderAugmentation([ITEM]));
    assert.equal(message.content.filter(b => b.text === SURFACE_HOST_NOTICE).length, 1);
    assert.deepEqual(JSON.parse(message.content[1]!.text).memories[0], {
      memory_ref: memoryRefFor(ITEM.detail_ref), date:'2026-07-09', text:ITEM.event_text,
    });
  }
});

test('AC015：浮现仅 memory_ref/date/text——无 mood/words/分数/内部UUID', () => {
  const ref = memoryRefFor(ITEM.detail_ref);
  const text = renderAugmentation([ITEM], new Map([['ev_1', ref]]));
  assert.deepEqual(JSON.parse(text), { memories: [{ memory_ref: ref, date: '2026-07-09', text: ITEM.event_text }] });
  assert.ok(text.includes(ref));
  assert.ok(!text.includes(SURFACE_HOST_NOTICE), 'the one notice belongs to the transport message, not each item');
  for (const forbidden of ['mood', 'our_words', 'rrf', 'judge', '00001', ITEM.detail_ref, ITEM.body_hash]) {
    assert.ok(!text.includes(forbidden), `泄漏 ${forbidden}`);
  }
});

test('仓库：v29 迁移落表 + 逻辑作业唯一键 + CAS + missed_target + 冻结/覆盖', () => {
  const root = tempRoot('sfrepo-');
  const db = makeDb(root);
  const repo = new SurfacingRepository(db);
  const j1 = repo.registerAcceptedJob({ conversationId: 'c1', messageId: 'm1', revision: 1, sequence: 5, content: 'x', contentHash: 'h', occurredAt: null, hypotheses: [{ hypothesis_id: 'h1', start_cp: 0, end_cp: 1, inherited_date_span: null }], policyRevision: 1, promptRevision: 'surface_prepare_v1' });
  assert.ok(j1);
  // 同逻辑键幂等
  const again = repo.registerAcceptedJob({ conversationId: 'c1', messageId: 'm1', revision: 1, sequence: 5, content: 'x', contentHash: 'h', occurredAt: null, hypotheses: [{ hypothesis_id: 'h1', start_cp: 0, end_cp: 1, inherited_date_span: null }], policyRevision: 1, promptRevision: 'surface_prepare_v1' });
  assert.equal(again, j1);
  assert.equal(repo.jobById(j1!)!.state, 'pending');
  // CAS：pending→preparing→prepared
  assert.equal(repo.transition(j1!, ['pending'], 'preparing'), true);
  assert.equal(repo.transition(j1!, ['pending'], 'preparing'), false); // 旧状态不可重走
  repo.transition(j1!, ['preparing'], 'prepared');
  assert.equal(repo.jobById(j1!)!.target_message_id, 'm1');
  assert.equal(repo.bindTarget({ conversationId: 'c1', jobId: j1!, targetMessageId: 'm2', targetRevision: 1 }), false, 'cross-turn binding is retired');
  assert.equal(repo.bindTarget({ conversationId: 'c1', jobId: j1!, targetMessageId: 'm1', targetRevision: 1 }), true);
  // 冻结/复用/retain/覆盖
  repo.transition(j1!, ['target_bound'], 'validating');
  repo.transition(j1!, ['validating'], 'ready', { items_json: JSON.stringify([ITEM]), receipt_id: 'svr_1' });
  const deliveryId = repo.freezeDelivery({ jobId: j1!, attemptId: 'att1', windowId: 'w1', text: 'BLOCK', items: [ITEM], memoryRefs: [{ ref: 'sf_x', detail_ref: ITEM.detail_ref, event_id: 'ev_1' }] });
  const frozen = repo.frozenForAttempt('att1')!;
  assert.equal(frozen.payload_hash, sha256Hex('BLOCK'));
  repo.markDispatchStarted(j1!, deliveryId);
  repo.markRetained(j1!, deliveryId, [ITEM]);
  const covered = repo.coveredInWindow('c1', 'w1', [ITEM]);
  assert.equal(covered.size, 0, 'retention bookkeeping without the actual trajectory is not model visibility');
  // 换窗不拦截（coverage 是窗口投影，非永久 seen）
  assert.equal(repo.coveredInWindow('c1', 'w2', [ITEM]).size, 0);
  // ref→detail 解析
  assert.equal(repo.refToDetail('sf_x', { roomId: 'c1', windowId: 'w1', requestId: 'unsent' }), null, 'without confirmed provider payload retention is not visibility');
  assert.equal(repo.refToDetail('sf_unknown', { roomId: 'c1', windowId: 'w1', requestId: 'unsent' }), null);
  db.close();
});

type FakeM = { calls: Array<{ cap: string; payload: Record<string, unknown> }> };

function fakeMariposa(script: {
  prepare?: (p: Record<string, unknown>) => Record<string, unknown>;
  validate?: (p: Record<string, unknown>) => Record<string, unknown>;
  check?: (p: Record<string, unknown>) => Record<string, unknown>;
}): { client: MariposaClient; log: FakeM } {
  const log: FakeM = { calls: [] };
  const transport: MariposaTransport = async (cap, payload) => {
    log.calls.push({ cap, payload: payload as Record<string, unknown> });
    if (cap === 'memory.surfacing.prepare') return { ok: true, result: script.prepare ? script.prepare(payload as Record<string, unknown>) : { status: 'prepared', candidate_snapshot_ref: 'sfr_1', selected_count: 1, reason_code: null } };
    if (cap === 'memory.surfacing.validate') return { ok: true, result: script.validate ? script.validate(payload as Record<string, unknown>) : { status: 'ready', validation_receipt: 'svr_1', items: [ITEM], reason_code: null } };
    if (cap === 'memory.surfacing.check') return { ok: true, result: script.check ? script.check(payload as Record<string, unknown>) : { valid: true, accepted_detail_refs: [ITEM.detail_ref] } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  return { client: new MariposaClient({ transport }), log };
}

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeService(root: string, enabled = true) {
  const db = makeDb(root);
  const { client, log } = fakeMariposa({});
  const svc = new SurfacingService(db, client, {
    enabled, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v1',
    delivery_deadline_ms: 2000, max_added_tokens_per_turn: 4096,
    max_packet_bytes: 24576, worker_concurrency: 2,
  }, null);
  const messages = new MessageService(db, enabled ? svc : null);
  messages.ensureConversation('c1');
  return { db, svc, messages, log };
}

test('P3：接受即同轮绑定；装配抢占 prepare 与后台单飞；后轮不得借用', async () => {
  const { db, svc, messages, log } = makeService(tempRoot('sfservice-'));
  try {
    const content = '还记得7.9那天我们把记忆库做成的事吗';
    const u1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: 'u1', occurredAt: T0 });
    const input = { conversationId: 'c1', windowId: 'w1', turnId: u1.turnId, attemptId: 'a1',
      message: { id: u1.message.id, revision: 1, sequence: u1.message.sequence, content, hash: 'h1' } };
    const aug = await svc.augmentFor(input);
    assert.ok(aug);
    const job = svc.repo.jobById(aug.jobId)!;
    assert.equal(job.source_message_id, job.target_message_id);
    assert.equal(job.source_revision, job.target_revision);
    assert.equal(Date.parse(job.expires_at!) - Date.parse(job.created_at), 2000);
    assert.equal(log.calls.filter(c => c.cap.endsWith('.prepare')).length, 1);
    const preparation = log.calls.find(c => c.cap.endsWith('.prepare'))!.payload;
    assert.equal(preparation.deadline_at, job.expires_at, 'M retrieval inherits the acceptance deadline too');
    const validation = log.calls.find(c => c.cap.endsWith('.validate'))!.payload;
    assert.equal(validation.deadline_at, job.expires_at);
    assert.equal((validation.source_input_ref as { message_id: string }).message_id,
      (validation.target_input as { message_id: string }).message_id);
    assert.ok(await svc.finalAdmit(aug, { conversationId: 'c1', windowId: 'w1', messageId: u1.message.id, revision: 1 }));
    svc.markDispatched('a1'); svc.markRetained(aug);
    assert.equal(svc.reuseFrozen('a1')?.text, aug.text);
    const u2 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '普通聊天', clientMessageId: 'u2', occurredAt: T0 });
    assert.equal(await svc.augmentFor({ ...input, attemptId: 'a2', message: { ...input.message, id: u2.message.id } }), null);
  } finally { await svc.stop(); await new Promise(r => setImmediate(r)); db.close(); }
});

test('AC031：编辑撤销旧修订作业；AC038：enabled=false 零作业零网络', async () => {
  const root = tempRoot('sfedit-');
  const { db, svc, messages, log } = makeService(root);
  const u1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '还记得8.19我们结婚那天吗', clientMessageId: 'e1', occurredAt: T0 });
  await waitUntil(() => svc.repo.jobByLogicalKey('c1', u1.message.id, 1, 1, 'surface_prepare_v1')!.state === 'prepared');
  messages.editUserMessage(u1.message.id, '还记得8.19我们结婚那天吗？');
  const job = svc.repo.jobByLogicalKey('c1', u1.message.id, 1, 1, 'surface_prepare_v1')!;
  assert.equal(job.state, 'cancelled');
  await svc.stop();
  await new Promise((r) => setTimeout(r, 20));
  db.close();

  const root2 = tempRoot('sfdisabled-');
  const { db: db2, messages: m2, log: log2 } = makeService(root2, false);
  m2.submitUserMessageWithTurn({ conversationId: 'c1', content: 'x', clientMessageId: 'd1', occurredAt: T0 });
  assert.equal(log2.calls.length, 0, 'disabled=零网络');
  const repo2 = new SurfacingRepository(db2);
  assert.equal(repo2.pendingJobs(10).length, 0, 'disabled=零作业');
  db2.close();
});

test('R33：预算不足整条跳过（不截断/不摘要）——超大事件零注入', async () => {
  const root = tempRoot('sfbudget-');
  const db = makeDb(root);
  const big: SurfaceItem = { ...ITEM, event_text: '超'.repeat(30000) };
  const { client } = fakeMariposa({ validate: () => ({ status: 'ready', validation_receipt: 'svr_9', items: [big], reason_code: null }) });
  const svc = new SurfacingService(db, client, { enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v1', delivery_deadline_ms: 2000, max_added_tokens_per_turn: 4096, max_packet_bytes: 24576, worker_concurrency: 2 }, null);
  const messages = new MessageService(db, svc);
  messages.ensureConversation('c1');
  const u1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '还记得那件大事吗', clientMessageId: 'b1', occurredAt: T0 });
  // 手动推进到 ready（绕过 prepare 脚本）：
  const jobId = svc.repo.jobByLogicalKey('c1', u1.message.id, 1, 1, 'surface_prepare_v1')!.id;
  svc.repo.transition(jobId, ['pending'], 'preparing');
  svc.repo.transition(jobId, ['preparing'], 'prepared');
  const aug = await svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: 't', attemptId: 'a', message: { id: u1.message.id, revision: 1, sequence: 1, content: u1.message.content, hash: 'h' } });
  assert.equal(aug, null, '超大事件零注入，不截断');
  await svc.stop();
  await new Promise((r) => setTimeout(r, 20));
  db.close();
});

// ===== 她 2026-10-21 执行稿：编辑生命周期修订失效一致性（验收矩阵）=====


function editFixture() {
  const root = tempRoot('sfedit-');
  const db = makeDb(root);
  let mariposaCalls = 0;
  const transport: MariposaTransport = async (cap) => {
    mariposaCalls += 1;
    if (cap.endsWith('.prepare')) return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_e' } };
    if (cap.endsWith('.validate')) return { ok: true, result: { status: 'ready', validation_receipt: 'svr_e', items: [ITEM] } };
    if (cap.endsWith('.check')) return { ok: true, result: { valid: true, accepted_detail_refs: [ITEM.detail_ref] } };
    throw new Error('UNEXPECTED_CAPABILITY');
  };
  const svc = new SurfacingService(db, new MariposaClient({ transport }), {
    enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v1',
    delivery_deadline_ms: 200, max_added_tokens_per_turn: 4096, max_packet_bytes: 24576, worker_concurrency: 1,
  }, null);
  const messages = new MessageService(db, svc);
  messages.ensureConversation('c1');
  const RECALL = '你还记得那次7.9我们把记忆库做成了吗？';
  const say = (id: string, content = RECALL) =>
    messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: T0 });
  const jobOf = (id: string) => svc.repo.jobByLogicalKey('c1', id, 1, 1, 'surface_prepare_v1');
  const jobs = () => (db.prepare('SELECT id, state FROM surfacing_jobs').all() as Array<{ id: string; state: string }>);
  const deliveries = () => (db.prepare('SELECT id, job_id, state FROM surfacing_deliveries').all() as Array<{ id: string; job_id: string; state: string }>);
  const close = async () => { await svc.stop(); await new Promise(r => setTimeout(r, 20)); db.close(); };
  return { db, svc, messages, say, jobOf, jobs, deliveries, mariposa: () => mariposaCalls, close, RECALL };
}

test('E-LC1 HTTP 编辑：旧修订作业失效、不登记新作业、零外发', async () => {
  const f = editFixture();
  try {
    const a = f.say('a');
    await pollUntil(() => f.jobOf(a.message.id)!.state === 'prepared');
    const calls0 = f.mariposa();
    const edited = f.messages.editUserMessage(a.message.id, '改口：换个说法');
    assert.ok(edited.current_revision >= 2);
    const j = f.jobOf(a.message.id);
    assert.equal(j!.state, 'cancelled', '旧修订作业失效');
    assert.equal(f.jobs().length, 1, '编辑不登记新作业');
    assert.equal(f.mariposa() - calls0, 0, '普通编辑零 Mariposa 调用');
  } finally { await f.close(); }
});

test('E-LC2 路由 edit 合同：notifySurfacing 失效旧修订（同一路径）', async () => {
  const f = editFixture();
  try {
    const a = f.say('a');
    await pollUntil(() => f.jobOf(a.message.id)!.state === 'prepared');
    // routing/service.ts 现走 editMessageInTx(..., { notifySurfacing: true })——同合同直测
    f.db.exec('BEGIN IMMEDIATE');
    try { f.messages.editMessageInTx(a.message.id, '路由改写正文', { notifySurfacing: true }); f.db.exec('COMMIT'); }
    catch (err) { f.db.exec('ROLLBACK'); throw err; }
    assert.equal(f.jobOf(a.message.id)!.state, 'cancelled');
  } finally { await f.close(); }
});

test('E-LC3 编辑重试/连续编辑：无重复作业，旧修订全失效', async () => {
  const f = editFixture();
  try {
    const a = f.say('a');
    await pollUntil(() => f.jobOf(a.message.id)!.state === 'prepared');
    f.messages.editMessageInTx(a.message.id, '第一次改', { notifySurfacing: true });
    f.messages.editMessageInTx(a.message.id, '第二次改', { notifySurfacing: true });
    assert.equal(f.jobOf(a.message.id)!.state, 'cancelled');
    assert.equal(f.jobs().length, 1, '两次编辑零新作业');
  } finally { await f.close(); }
});

test('E-LC4 事务回滚一致性：编辑回滚则作业恢复有效', async () => {
  const f = editFixture();
  try {
    const a = f.say('a');
    await pollUntil(() => f.jobOf(a.message.id)!.state === 'prepared');
    f.db.exec('BEGIN IMMEDIATE');
    f.messages.editMessageInTx(a.message.id, '会失败的编辑', { notifySurfacing: true });
    f.db.exec('ROLLBACK');
    assert.equal(f.jobOf(a.message.id)!.state, 'prepared', '回滚后作业与库一致');
    assert.equal(f.messages.getMessage(a.message.id)!.current_revision, 1, '消息修订一并回滚');
  } finally { await f.close(); }
});

test('E-LC5 迟到旧结果不得进入新修订输入（augmentFor 修订守卫）', async () => {
  const f = editFixture();
  try {
    const a = f.say('a');
    await pollUntil(() => f.jobOf(a.message.id)!.state === 'prepared');
    const b = a;
    // 源消息编辑（HTTP）→ 旧修订作业失效
    f.messages.editUserMessage(a.message.id, '改掉源文本');
    const out = await f.svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: b.turnId, attemptId: 'a9',
      message: { id: b.message.id, revision: 1, sequence: b.message.sequence, content: b.message.content, hash: 'h' } });
    assert.equal(out, null, '已失效旧作业不交付');
  } finally { await f.close(); }
});

test('E-LC6 冻结未派发+编辑：最终准入丢弃，主消息路径不阻断', async () => {
  const f = editFixture();
  try {
    const a = f.say('a');
    await pollUntil(() => f.jobOf(a.message.id)!.state === 'prepared');
    const b = a;
    const frozen = await f.svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: b.turnId, attemptId: 'a9',
      message: { id: b.message.id, revision: 1, sequence: b.message.sequence, content: b.message.content, hash: 'h' } });
    assert.ok(frozen, '冻结成功');
    // 目标消息编辑 → 修订变化；旧冻结包在最终准入被丢弃
    f.messages.editUserMessage(b.message.id, '目标消息改写');
    const admitted = await f.svc.finalAdmit(frozen, {
      conversationId: 'c1', windowId: 'w1', messageId: b.message.id, revision: 2 });
    assert.equal(admitted, null, '修订变化→冻结块丢弃');
    const j = f.jobOf(a.message.id)!;
    assert.equal(j.state, 'cancelled', '编辑先失效（SOURCE_OR_TARGET_REVISED），最终准入为第二道网');
    assert.equal(j.reason_code, 'SOURCE_OR_TARGET_REVISED');
    assert.equal(f.deliveries().find(d => d.id === frozen!.deliveryId)!.state, 'dropped', '未派发冻结包收回');
    f.svc.markDispatched('a9'); // 不抛：主消息派发路径不受影响
  } finally { await f.close(); }
});

test('E-LC7 已派发事实不被事后改写：cancel 只动 jobs 表', async () => {
  const f = editFixture();
  try {
    const a = f.say('a');
    await pollUntil(() => f.jobOf(a.message.id)!.state === 'prepared');
    const b = a;
    const frozen = await f.svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: b.turnId, attemptId: 'a9',
      message: { id: b.message.id, revision: 1, sequence: b.message.sequence, content: b.message.content, hash: 'h' } });
    f.svc.markDispatched('a9'); // 首发已过门
    const d0 = f.deliveries().find(d => d.id === frozen!.deliveryId)!;
    assert.equal(d0.state, 'dispatch_started');
    // 编辑（同修订失效路径）→ 交付事实/账单不改写
    f.messages.editUserMessage(b.message.id, '事后编辑');
    const d1 = f.deliveries().find(d => d.id === frozen!.deliveryId)!;
    assert.equal(d1.state, 'dispatch_started', '已派发交付行不被静默改写');
  } finally { await f.close(); }
});

test('E-LC8 幂等重放：同 client_message_id 重复提交只有一份作业', async () => {
  const f = editFixture();
  try {
    const a1 = f.say('dup');
    const a2 = f.say('dup');
    assert.equal(a2.duplicate, true);
    await pollUntil(() => f.jobOf(a1.message.id)!.state === 'prepared');
    assert.equal(f.jobs().length, 1);
  } finally { await f.close(); }
});

test('E-LC9 开关关闭/重启不复活已失效作业', async () => {
  const f = editFixture();
  try {
    const a = f.say('a');
    await pollUntil(() => f.jobOf(a.message.id)!.state === 'prepared');
    f.messages.editUserMessage(a.message.id, '关闭前编辑');
    await f.svc.stop();
    const svc2 = new SurfacingService(f.db, new MariposaClient({ transport: async () => { throw new Error('不应外发'); } }), {
      enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v1',
      delivery_deadline_ms: 200, max_added_tokens_per_turn: 4096, max_packet_bytes: 24576, worker_concurrency: 1,
    }, null);
    await svc2.start(); // 崩溃恢复：cancelled 不在恢复集
    assert.equal(svc2.repo.jobById(f.jobOf(a.message.id)!.id)!.state, 'cancelled', '重启不复活');
    await svc2.stop();
  } finally { await f.close(); }
});


test('三个独立事件保留三份完整原文，只输出必要引用/date/text',()=>{
  const items=[0,1,2].map(n=>({...ITEM,event_id:'event-'+n,detail_ref:'detail-'+n,event_text:`  事件${n}\n第二行🦋\n` }));
  const out=JSON.parse(renderAugmentation(items));
  assert.equal(out.memories.length,3);
  out.memories.forEach((m:any,n:number)=>{assert.deepEqual(Object.keys(m),['memory_ref','date','text']);assert.equal(m.text,items[n].event_text)});
});
