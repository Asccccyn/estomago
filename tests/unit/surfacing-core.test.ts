// 自动记忆浮现 · 合同/仓库/服务核心（EST_MARIPOSA_AUTO_SURFACING_V1）。
// 红线对照：notice 字节锁定（AC016）、渲染只含日期+正文+短 ref（AC015）、
// 源轮不注入（AC002/AC051）、目标绑定真实下一用户（AC003）、幂等
// （AC025）、无次优补位（AC055 由 M 侧合同+本侧预算跳过共保）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { tempRoot } from '../helpers.ts';
import { verifyNoticeBytes, renderAugmentation, memoryRefFor, PRIMARY_MEMORY_NOTICE } from '../../apps/host/src/memory-surfacing/contracts.ts';
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

test('AC016：冻结 notice 逐字节等于用户原句（60 字节，无 BOM 无尾换行）', () => {
  const v = verifyNoticeBytes();
  assert.ok(v.ok, `sha256=${v.sha256} bytes=${v.bytes}`);
  assert.equal(Buffer.byteLength(PRIMARY_MEMORY_NOTICE, 'utf8'), 60);
});

test('AC015：渲染块只含 标题/说明/时间/事件正文/短引用——无 mood/words/分数/UUID', () => {
  const ref = memoryRefFor(ITEM.detail_ref);
  const text = renderAugmentation([ITEM], new Map([['ev_1', ref]]));
  assert.ok(text.startsWith('[回忆浮现]\n' + PRIMARY_MEMORY_NOTICE));
  assert.ok(text.includes(`[记忆引用 ${ref}]`));
  assert.ok(text.includes('时间：2026-07-09'));
  assert.ok(text.includes(`事件：${ITEM.event_text}`));
  assert.ok(text.trimEnd().endsWith('[/回忆浮现]'));
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
  // 目标绑定 + 更早 prepared 作业 missed
  const j2 = repo.registerAcceptedJob({ conversationId: 'c1', messageId: 'm2', revision: 1, sequence: 7, content: 'y', contentHash: 'h2', occurredAt: null, hypotheses: [{ hypothesis_id: 'h1', start_cp: 0, end_cp: 1, inherited_date_span: null }], policyRevision: 1, promptRevision: 'surface_prepare_v1' });
  repo.transition(j2!, ['pending'], 'preparing');
  repo.transition(j2!, ['preparing'], 'prepared');
  repo.bindTarget({ conversationId: 'c1', jobId: j1!, targetMessageId: 'm2', targetRevision: 1 });
  // j2 现在成了更早的未绑定 prepared（target NULL）——被 markMissedTargets 清
  repo.markMissedTargets('c1', 9);
  assert.equal(repo.jobById(j2!)!.state, 'missed_target');
  assert.equal(repo.jobById(j1!)!.state, 'target_bound');
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

test('AC002/AC003/AC004：U1 后台准备不进当轮；U2 到达绑定+复核；注入块产出', async () => {
  const root = tempRoot('sfservice-');
  const { db, svc, messages, log } = makeService(root);
  // P1 门（她 1020）：只有明确回忆才登记作业——U1 改为回忆问句；U2 保持
  // 普通追问以见证"目标绑定与本条是否检索无关"
  const U1 = '还记得7.9那天我们把记忆库做成的事吗';
  const u1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: U1, clientMessageId: 'u1', occurredAt: T0 });
  // 源轮（U1 自己）请求注入：无 target 作业 → null（Uₙ 不进 Uₙ）
  const same = await svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: 't1', attemptId: 'a1', message: { id: u1.message.id, revision: 1, sequence: 1, content: U1, hash: 'h1' } });
  assert.equal(same, null);
  await waitUntil(() => svc.repo.pendingJobs(5).length === 0 && (svc.repo.jobById(svc.repo.jobByLogicalKey('c1', u1.message.id, 1, 1, 'surface_prepare_v1')!.id)!.state === 'prepared'));
  // prepare 恰一次（幂等不重跑）
  assert.equal(log.calls.filter((c) => c.cap === 'memory.surfacing.prepare').length, 1);
  const u2 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '7.9那天怎么样', clientMessageId: 'u2', occurredAt: T0 });
  await waitUntil(() => {
    const j = svc.repo.nextPreparedForTarget('c1', u2.message.id);
    return j !== null && j.state === 'target_bound';
  });
  const aug = await svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: 't2', attemptId: 'a2', message: { id: u2.message.id, revision: 1, sequence: 2, content: '7.9那天怎么样', hash: 'h2' } });
  assert.ok(aug, 'U2 轮拿到冻结注入块');
  assert.ok(aug.text.startsWith('[回忆浮现]'));
  assert.ok(aug.text.includes('时间：2026-07-09'));
  // 成功 retain → 覆盖登记；下一轮同事件不重复追加（AC028）
  svc.markDispatched('a2');
  svc.markRetained(aug);
  const again = await svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: 't3', attemptId: 'a3', message: { id: u2.message.id, revision: 1, sequence: 2, content: '7.9那天怎么样', hash: 'h2' } });
  assert.equal(again, null, '同窗已覆盖不重复注入');
  // 冻结复用：同 attempt 重试取同一冻结包
  const reused = svc.reuseFrozen('a2');
  assert.ok(reused && reused.text === aug.text);
  await svc.stop();
  await new Promise((r) => setTimeout(r, 20));
  db.close();
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
  const u2 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '继续', clientMessageId: 'b2', occurredAt: T0 });
  await waitUntil(() => svc.repo.nextPreparedForTarget('c1', u2.message.id)?.state === 'target_bound');
  const aug = await svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: 't', attemptId: 'a', message: { id: u2.message.id, revision: 1, sequence: 2, content: '继续', hash: 'h' } });
  assert.equal(aug, null, '超大事件零注入，不截断');
  await svc.stop();
  await new Promise((r) => setTimeout(r, 20));
  db.close();
});
