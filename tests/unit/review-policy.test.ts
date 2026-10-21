// WP3 回归：核心策略纯函数（移植自规范参考实现的场景语义；合成数据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReviewRange, advanceBookmark, completeReview, rotationPlan, rawKey, type ManifestEntry, type RotationReview, type SideEffectLedgerEntry } from '../../apps/host/src/context/review-policy.ts';

const m = (id: string, seq: number, revision = 1, origin: ManifestEntry['origin'] = 'dialogue'): ManifestEntry => ({ id, revision, seq, origin, visible: true });
const breakfast = [m('m1', 1), m('m2', 2), m('m3', 3), m('m4', 4)]; // 起床/早餐
const xx = [m('m5', 5), m('m6', 6), m('m7', 7), m('m8', 8)]; // XX 事
const late = [m('m9', 9), m('m10', 10), m('m11', 11), m('m12', 12), m('m13', 13), m('m14', 14), m('m15', 15)];

test('§1.3 早餐例子：成功 hold m8 后仅提醒 m9..m15，早餐不自动补桶', () => {
  const manifest = [...breakfast, ...xx, ...late];
  const range = selectReviewRange({ manifest, epochId: 'w1', lastHold: { epochId: 'w1', seenSequence: 8 } });
  assert.deepEqual(range.map((r) => r.seq), [9, 10, 11, 12, 13, 14, 15], '书签之后到高水位');
  assert.ok(!range.some((r) => r.seq <= 8), '早餐（m1–m8 之前的部分）不进范围');
});

test('没有书签：范围=本窗实际原话，不扩大到全库；工具/控制块不是双方原话', () => {
  const manifest = [...breakfast, m('t1', 5, 1, 'tool'), m('c1', 6, 1, 'control'), { ...m('r1', 7, 1, 'retrieval'), visible: true }];
  const range = selectReviewRange({ manifest, epochId: 'w1', lastHold: null });
  assert.deepEqual(range.map((r) => r.id), ['m1', 'm2', 'm3', 'm4'], '只有 dialogue 原话进范围');
  assert.throws(() => selectReviewRange({ manifest: [...manifest, m('m2', 2)], epochId: 'w1', lastHold: null }), /MANIFEST_DUPLICATE/);
});

test('零新增完成范围不重复提醒；修订变化使同消息旧凭证失效', () => {
  const manifest = [...breakfast, ...xx];
  const reviewed = selectReviewRange({ manifest, epochId: 'w1', lastHold: null }).map(rawKey);
  const again = selectReviewRange({ manifest, epochId: 'w1', lastHold: null, reviewedKeys: reviewed });
  assert.equal(again.length, 0, '已完成的同消息版本不重复');
  const edited = manifest.map((e) => (e.id === 'm5' ? { ...e, revision: 2 } : e));
  const afterEdit = selectReviewRange({ manifest: edited, epochId: 'w1', lastHold: null, reviewedKeys: reviewed });
  assert.deepEqual(afterEdit.map((x) => `${x.id}@${x.revision}`), ['m5@2'], '修订过的消息不能套用旧回执');
});

test('跨窗携带旧尾段：焦点豁免不冒充 reviewed/held', () => {
  const carried = breakfast.map(rawKey); // 新窗携带的旧尾段（书签之前）
  const range = selectReviewRange({ manifest: [...breakfast, ...xx], epochId: 'w2', lastHold: null, carriedBackgroundKeys: carried });
  assert.deepEqual(range.map((r) => r.id), xx.map((x) => x.id), '旧尾段豁免，不强制补记早餐');
});

test('书签规则：发起请求视野、旧窗收据拒绝、重放不推进、不倒退、失败不产生', () => {
  const req = (id: string, seenSequence: number, operationId = 'op1', epochId = 'w1') => ({ id, roomId: 'r1', epochId, operationId, author: 'primary_model' as const, seenSequence });
  const receipt = (operationId = 'op1', over: Partial<Parameters<typeof advanceBookmark>[2]> = {}) => ({ id: `rec-${operationId}`, roomId: 'r1', epochId: 'w1', operationId, memoryId: `mem-${operationId}`, verified: true as const, state: 'committed' as const, ...over });
  const b1 = advanceBookmark(null, req('req1', 8), receipt());
  assert.equal(b1.seenSequence, 8, '书签=发起请求实际看见的位置，不是收据到达时最新');
  const replay = advanceBookmark(b1, req('req1', 8), receipt());
  assert.equal(replay, b1, '同收据重放不产生新书签');
  const older = advanceBookmark(b1, req('req2', 3, 'op2'), receipt('op2'));
  assert.equal(older, b1, '书签不倒退');
  assert.throws(() => advanceBookmark(b1, req('req3', 9, 'op3'), receipt('op3', { epochId: 'w2' })), /HOLD_SCOPE_MISMATCH|OLD_EPOCH_RECEIPT/, '旧窗迟到收据不推进新窗');
  assert.throws(() => advanceBookmark(null, req('req4', 8), receipt('op1', { state: 'unknown' as never })), /HOLD_NOT_CONFIRMED/, '未核实不产生书签');
  assert.throws(() => advanceBookmark(null, { ...req('req5', 8), author: 'other' }, receipt()), /NOT_PRIMARY_MODEL/, '另一客户端的 hold 不推进');
});

test('completeReview：零 hold 放行、holds_completed 须真有成功写、unknown 不可抹掉、幂等', () => {
  const review: RotationReview = { id: 'rev1', roomId: 'r1', epochId: 'w1', epochRevision: 3, selected: [], status: 'active' };
  const inv = { purpose: 'pre_rotate_review', roomId: 'r1', epochId: 'w1', epochRevision: 3 };
  const done = completeReview(review, { review_id: 'rev1', decision: 'no_new_hold' }, inv, []);
  assert.equal(done.status, 'completed');
  const again = completeReview(done, { review_id: 'rev1', decision: 'no_new_hold' }, inv, []);
  assert.equal(again.status, 'completed', '成功 review 重试幂等');
  assert.throws(() => completeReview(done, { review_id: 'rev1', decision: 'holds_completed' }, inv, []), /REVIEW_DECISION_CONFLICT/);
  assert.throws(() => completeReview(review, { review_id: 'rev1', decision: 'holds_completed' }, inv, []), /REVIEW_LEDGER_MISMATCH/, '没有成功 hold 不能 holds_completed');
  const unknownLedger: SideEffectLedgerEntry[] = [{ reviewId: 'rev1', kind: 'hold', state: 'unknown', verified: false, memoryId: null }];
  assert.throws(() => completeReview(review, { review_id: 'rev1', decision: 'no_new_hold' }, inv, unknownLedger), /WRITE_UNRESOLVED/, 'unknown 写结果不能被 no_new_hold 抹掉');
  const held: SideEffectLedgerEntry[] = [
    { reviewId: 'rev1', kind: 'hold', state: 'committed', verified: true, memoryId: 'mem9' },
    { reviewId: 'rev1', kind: 'hold', state: 'failed_resolved', verified: false, memoryId: null },
  ];
  const done2 = completeReview(review, { review_id: 'rev1', decision: 'holds_completed' }, inv, held);
  assert.deepEqual(done2.memoryIds, ['mem9']);
  assert.throws(() => completeReview(review, { review_id: 'revX', decision: 'no_new_hold' }, inv, []), /REVIEW_ID_MISMATCH/);
  assert.throws(() => completeReview(review, { review_id: 'rev1', decision: 'no_new_hold' }, { ...inv, epochRevision: 4 }, []), /REVIEW_SCOPE_MISMATCH/, '普通聊天伪造 review 文字不能完成');
});

test('rotationPlan：默认软线 600k 进 rotate、容量不足 blocked、pending 只等安全点、静默不换窗（2026-10-08 晚间她裁定；软线 2026-10-17 起 600k 兜底）', () => {
  // 模型容量 1M（她 2026-10-17：64k→600k 的前提）→ 安全输入 971808；有效软线=min(600000, 971808)=600000
  const base = { capacity: 1_000_000, maxOutput: 8192 };
  const warn = rotationPlan({ ...base, currentInput: 570000 });
  assert.equal(warn.action, 'continue', 'WP5：预警动作退役——原 warn 区间不换窗不叫模型（行为等价）');
  const rotate = rotationPlan({ ...base, currentInput: 605000 });
  assert.equal(rotate.action, 'rotate');
  assert.equal(rotate.reason, 'capacity');
  const wait = rotationPlan({ ...base, currentInput: 605000, pendingTurn: true });
  assert.equal(wait.action, 'wait_safe', '工具回合未结束只等安全边界');
  const blocked = rotationPlan({ ...base, currentInput: 980000 });
  assert.equal(blocked.action, 'blocked_hard');
  const small = rotationPlan({ capacity: 80000, maxOutput: 8192, currentInput: 45000, soft: 40000 });
  assert.equal(small.action, 'rotate', 'C-O-T-R-S 压低有效软线（soft=40000<安全输入≈51808）：远小于 600k 也触发');
  // 6h 静默触发已删除：idleMs 不再是输入，隔多久回来都不因时间换窗
  const afterLongIdle = rotationPlan({ ...base, currentInput: 100 });
  assert.equal(afterLongIdle.action, 'continue', '累计收费大但当前输入小 → 不误换（静默同样不换）');
  assert.equal(afterLongIdle.reason, null);
});
