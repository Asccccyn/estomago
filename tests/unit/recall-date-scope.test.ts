// 2026-10-17 她报障修复：memory_recall 支持明确日期段（date_from/date_to）
// → query_plan.explicit_constraints.event_date → M 侧桶池 memory_date 硬收窄。
// 背景：他查"9.25-9.27 的记忆"0 命中——语义近邻对日期主导查询不可靠，
// 而桶实际存在（00433/00434，已另批补齐 369 条缺失向量）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';
import { HostToolExecutor, validateToolArgs } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-1' } as const;

function makeTools(mariposa: MariposaTransport) {
  const root = tempRoot('rcdate-');
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) })
  wireOidoCapabilitiesForTest(tools, {});;
  return { tools, db };
}

const okPacket = {
  recall_session_id: 'rs_d1', revision: 1, search_status: 'AMBIGUOUS',
  judge_mode: 'on', judgement_status: 'ok', judged_count: 2,
  candidates: [{ resource_ref: 'memory:00433', text: '九月底那三天' }],
  continuation: { continue_ref: 'ref_d1' },
};

test('带 date_from/date_to → query_plan 携带 event_date 收窄', async () => {
  let seenPlan: Record<string, unknown> | null = null;
  const { tools, db } = makeTools(async (capability, payload) => {
    if (capability === 'memory.recall.start') {
      seenPlan = payload.query_plan as Record<string, unknown>;
      return { ok: true, result: okPacket };
    }
    return { ok: true, result: {} };
  });
  try {
    const checked = validateToolArgs('memory_recall', { query: '9月25到27日那几天', date_from: '2026-09-25', date_to: '2026-09-27', __tool_call_id: 'c1' });
    assert.equal(checked.ok, true);
    const out = await tools.execute('memory_recall', checked.value as Record<string, unknown>, CTX as never);
    assert.equal(out.ok, true);
    const plan = seenPlan as { explicit_constraints?: { event_date?: { from: string; to: string } } };
    assert.deepEqual(plan.explicit_constraints?.event_date, { from: '2026-09-25', to: '2026-09-27' }, '日期段必须进 explicit_constraints.event_date');
  } finally { db.close(); }
});

test('不带日期 → query_plan 无 explicit_constraints（旧行为不变）', async () => {
  let seenPlan: Record<string, unknown> | null = null;
  const { tools, db } = makeTools(async (capability, payload) => {
    if (capability === 'memory.recall.start') { seenPlan = payload.query_plan as Record<string, unknown>; return { ok: true, result: okPacket }; }
    return { ok: true, result: {} };
  });
  try {
    await tools.execute('memory_recall', { query: '随便聊聊', __tool_call_id: 'c2' }, CTX as never);
    const plan = seenPlan as { explicit_constraints?: unknown };
    assert.equal(plan.explicit_constraints, undefined, '无日期时不得注入空约束');
  } finally { db.close(); }
});

test('半区间（只有 date_from）→ 参数拒绝，不产生副作用', async () => {
  const { tools, db } = makeTools(async () => ({ ok: true, result: okPacket }));
  try {
    const bad = validateToolArgs('memory_recall', { query: 'x', date_from: '2026-09-25', __tool_call_id: 'c3' });
    assert.equal(bad.ok, true, 'schema 层两键各自可选');
    const out = await tools.execute('memory_recall', { query: 'x', date_from: '2026-09-25', __tool_call_id: 'c3' }, CTX as never);
    assert.equal(out.ok, false);
    assert.equal((out.output as { error_code: string }).error_code, 'TOOL_ARG_REQUIRED');
  } finally { db.close(); }
});

test('refine 续查也携带 event_date', async () => {
  let seenPlan: Record<string, unknown> | null = null;
  const { tools, db } = makeTools(async (capability, payload) => {
    if (capability === 'memory.recall.refine') { seenPlan = payload.query_plan as Record<string, unknown>; return { ok: true, result: okPacket }; }
    return { ok: true, result: {} };
  });
  try {
    await tools.execute('memory_recall', { query: '还是那三天', channel: 'event', refine_session_id: 'rs_d1', refine_continue_ref: 'ref_d1', date_from: '2026-09-25', date_to: '2026-09-27', __tool_call_id: 'c4' }, CTX as never);
    const plan = seenPlan as { explicit_constraints?: { event_date?: { from: string; to: string } } };
    assert.deepEqual(plan.explicit_constraints?.event_date, { from: '2026-09-25', to: '2026-09-27' });
  } finally { db.close(); }
});
