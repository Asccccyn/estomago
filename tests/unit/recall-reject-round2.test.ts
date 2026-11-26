// 执行包 P4 §8.3：交付后否定 → 同 session 原文第二轮。
// 编排层验证（真实 MemoryService 工具入口 + scripted MariposaClient 传输边界）：
//  ① reject+deep_search：先 memory.recall.reject（session_local、resource_ref 路由、
//    幂等操作键），再 memory.recall.round2，reason 缺省=EXPLICIT_REJECT_AFTER_DELIVERY；
//  ② 否定保存后 round2 失败：如实返回失败原因，已保存的否定不回滚、重试同操作键；
//  ③ 旧路径不回归：refine+reject 仍先 reject 再 refine；deep_search 无 reject 时
//    reason 仍必填。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assembleTestTools, readyRuntimePatch, tempRoot, validateToolArgs, writeApprovedIdentity } from '../helpers.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't-p4', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-p4', toolCallId: 'tc-p4' } as const;

function makeTools(mariposa: MariposaTransport) {
  const root = tempRoot('p4rej-');
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const { tools } = assembleTestTools({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  return { tools, db };
}

test('P4：reject+deep_search → 先否定后 round2，reason 缺省 EXPLICIT_REJECT_AFTER_DELIVERY', async () => {
  const calls: Array<{ capability: string; payload: Record<string, unknown> }> = [];
  const { tools } = makeTools(async (capability, payload) => {
    calls.push({ capability, payload: payload as Record<string, unknown> });
    if (capability === 'memory.recall.reject') return { ok: true, result: { rejected: { scope: 'session_local' } } };
    if (capability === 'memory.recall.round2') return { ok: true, result: { recall_session_id: 'rs_p4', revision: 2, round: 2, search_status: 'OK', judge_mode: 'on', judged_count: 1, candidates: [{ channel: 'raw', resource_ref: 'source_msg:sm_old_1', text: '真正的旧原文' }], continuation: null } };
    return { ok: true, result: {} };
  });
  const checked = validateToolArgs('memory_recall', { query: '上次考完试我们吃烧烤', refine_session_id: 'rs_p4', reject_candidate_ref: 'memory:00wrong', deep_search: true });
  assert.equal(checked.ok, true);
  const out = await tools.execute('memory_recall', checked.value as Record<string, unknown>, CTX as never);
  assert.equal(out.ok, true);
  const rejectCall = calls.find(c => c.capability === 'memory.recall.reject');
  const round2Call = calls.find(c => c.capability === 'memory.recall.round2');
  assert.ok(rejectCall, '必须先调用否定接口');
  assert.ok(round2Call, '随后进入原文第二轮');
  assert.ok(calls.indexOf(rejectCall!) < calls.indexOf(round2Call!), '顺序：先 reject 后 round2');
  assert.equal(rejectCall!.payload['resource_ref'], 'memory:00wrong');
  assert.equal(rejectCall!.payload['session_id'], 'rs_p4');
  assert.equal(typeof rejectCall!.payload['operation_id'], 'string');
  assert.equal(round2Call!.payload['reason'], 'EXPLICIT_REJECT_AFTER_DELIVERY');
  assert.equal(round2Call!.payload['session_id'], 'rs_p4');
  assert.ok(JSON.stringify(out).includes('真正的旧原文'), '交付真实旧原文');
});

test('P4：否定保存后 round2 失败——如实返回，重试沿用同一否定操作键', async () => {
  let round2Attempts = 0;
  const rejectOps: string[] = [];
  const { tools } = makeTools(async (capability, payload) => {
    if (capability === 'memory.recall.reject') { rejectOps.push(String((payload as Record<string, unknown>)['operation_id'])); return { ok: true, result: { rejected: { scope: 'session_local' } } }; }
    if (capability === 'memory.recall.round2') { round2Attempts++; return { ok: false, code: 'ROUND2_GATE_DENIED' }; }
    return { ok: true, result: {} };
  });
  const checked = validateToolArgs('memory_recall', { query: '再找', refine_session_id: 'rs_p4b', reject_candidate_ref: 'memory:00x', deep_search: true });
  assert.equal(checked.ok, true);
  const out1 = await tools.execute('memory_recall', checked.value as Record<string, unknown>, CTX as never);
  assert.equal(out1.ok, false, 'round2 失败如实返回');
  const out = out1 as { output: { error_code?: string } };
  assert.equal(out.output['error_code'], 'RECALL_ROUND2_GATE_DENIED');
  const out2 = await tools.execute('memory_recall', checked.value as Record<string, unknown>, CTX as never);
  assert.equal(out2.ok, false, '重试仍失败');
  assert.equal(rejectOps.length, 2);
  assert.equal(rejectOps[0], rejectOps[1], '同一 tool_call 重试沿用同一否定操作键（幂等）');
  assert.equal(round2Attempts, 2);
});

test('P4：deep_search 无 reject 时 reason 仍必填（旧合同不变）', async () => {
  const { tools } = makeTools(async () => ({ ok: true, result: {} }));
  const checked = validateToolArgs('memory_recall', { query: '找话', refine_session_id: 'rs_p4c', deep_search: true });
  assert.equal(checked.ok, true);
  const out = await tools.execute('memory_recall', checked.value as Record<string, unknown>, CTX as never);
  assert.equal(out.ok, false);
  const o = out as { output: { error_code?: string } };
  assert.equal(o.output['error_code'], 'TOOL_ARG_REQUIRED');
});

test('P4：refine+reject 旧路径——先否定再 refine（不回归）', async () => {
  const calls: Array<{ capability: string; payload: Record<string, unknown> }> = [];
  const { tools } = makeTools(async (capability, payload) => {
    calls.push({ capability, payload: payload as Record<string, unknown> });
    if (capability === 'memory.recall.reject') return { ok: true, result: { rejected: { scope: 'session_local' } } };
    if (capability === 'memory.recall.refine') return { ok: true, result: { recall_session_id: 'rs_p4d', revision: 2, search_status: 'OK', judge_mode: 'on', judged_count: 0, candidates: [], continuation: { continue_ref: 'r2' } } };
    return { ok: true, result: {} };
  });
  const checked = validateToolArgs('memory_recall', { query: '不是海边那次，是山里', refine_session_id: 'rs_p4d', refine_continue_ref: 'ref1', channel: 'event', reject_candidate_ref: 'memory:00wrong' });
  assert.equal(checked.ok, true);
  const out = await tools.execute('memory_recall', checked.value as Record<string, unknown>, CTX as never);
  assert.equal(out.ok, true);
  const rej = calls.find(c => c.capability === 'memory.recall.reject')!;
  const ref = calls.find(c => c.capability === 'memory.recall.refine')!;
  assert.ok(rej && ref, 'reject 与 refine 都发生');
  assert.ok(calls.indexOf(rej) < calls.indexOf(ref), '先否定后续查');
  assert.equal(rej.payload['resource_ref'], 'memory:00wrong');
});
