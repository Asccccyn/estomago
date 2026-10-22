// 纠错+删除审批批（2026-10-10 她排期"继续"）：memory_correct 六动作 +
// deletion_review 三动作。验收：路由正确 M 能力；纠错闭集动作/replacement/
// CAS 缺参明确拒；删除审批 reject 必带理由、approve/reject 幂等 op；
// M 错误码如实上抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';
import { HostToolExecutor, hostToolNames } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-c' } as const;

function makeTools(mariposa: MariposaTransport) {
  const root = tempRoot('wp5cd-');
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  return { tools, db };
}

test('工具面：memory_correct + deletion_review 已注册（13→15）', () => {
  const names = hostToolNames();
  assert.ok(names.includes('memory_correct'));
  assert.ok(names.includes('deletion_review'));
});

test('纠错①：relation 撤错误关联（闭集动作+宿主幂等 op）', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => { calls.push({ cap, payload: payload as Record<string, unknown> }); return { ok: true, result: { corrected: true } }; };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_correct', { __tool_call_id: 'c1', action: 'relation', relation_id: 'rel_1', correction_action: 'remove_wrong_binding' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0]!.cap, 'memory.relations.correct');
  assert.equal(calls[0]!.payload.correction_action, 'remove_wrong_binding');
  assert.ok(String(calls[0]!.payload.operation_id).startsWith('es-cor-'));
  db.close();
});

test('纠错②：缺 correction_action / replace 缺 replacement 明确拒', async () => {
  const mariposa: MariposaTransport = async () => ({ ok: true, result: {} });
  const { tools, db } = makeTools(mariposa);
  const a = await tools.execute('memory_correct', { __tool_call_id: 'c2', action: 'relation', relation_id: 'rel_1' }, CTX);
  assert.equal(a.ok, false);
  assert.ok(String(a.output.error).includes('correction_action'));
  const b = await tools.execute('memory_correct', { __tool_call_id: 'c3', action: 'relation', relation_id: 'rel_1', correction_action: 'replace_wrong_binding' }, CTX);
  assert.equal(b.ok, false);
  assert.ok(String(b.output.error).includes('replacement'));
  db.close();
});

test('纠错③：word_source 带 CAS（expected_source_version）→ M 真合同；缺 CAS 拒', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => { calls.push({ cap, payload: payload as Record<string, unknown> }); return { ok: true, result: { corrected: true } }; };
  const { tools, db } = makeTools(mariposa);
  const bad = await tools.execute('memory_correct', { __tool_call_id: 'c4', action: 'word_source', word_id: 'w1', correction_action: 'remove_wrong_binding' }, CTX);
  assert.equal(bad.ok, false);
  assert.ok(String(bad.output.error).includes('expected_source_version'));
  const ok = await tools.execute('memory_correct', { __tool_call_id: 'c5', action: 'word_source', word_id: 'w1', correction_action: 'remove_wrong_binding', expected_source_version: 2 }, CTX);
  assert.equal(ok.ok, true);
  assert.equal(calls[0]!.cap, 'memory.our_words.source.correct');
  assert.equal(calls[0]!.payload.expected_source_version, 2);
  db.close();
});

test('纠错④：link 建关联 → memory.relations.link；relations 列表路由', async () => {
  const calls: string[] = [];
  const mariposa: MariposaTransport = async (cap) => { calls.push(cap); return { ok: true, result: { relation_id: 'rel_9' } }; };
  const { tools, db } = makeTools(mariposa);
  const lk = await tools.execute('memory_correct', { __tool_call_id: 'c6', action: 'link', from_memory: 'm1', to_memory: 'm2', relation_type: 'related_to' }, CTX);
  assert.equal(lk.ok, true);
  assert.equal(calls[0], 'memory.relations.link');
  const rl = await tools.execute('memory_correct', { __tool_call_id: 'c7', action: 'relations', memory_id: 'm1' }, CTX);
  assert.equal(rl.ok, true);
  assert.equal(calls[1], 'memory.relations.list');
  db.close();
});

test('审批①：requests/get 路由；status 筛选透传', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => { calls.push({ cap, payload: payload as Record<string, unknown> }); return { ok: true, result: { requests: [{ request_id: 'del_1', reason: '不想留了' }] } }; };
  const { tools, db } = makeTools(mariposa);
  const rl = await tools.execute('deletion_review', { __tool_call_id: 'd1', action: 'requests', status: 'pending' }, CTX);
  assert.equal(rl.ok, true);
  assert.equal(calls[0]!.cap, 'memory.deletion.list');
  assert.equal(calls[0]!.payload.status, 'pending');
  const gt = await tools.execute('deletion_review', { __tool_call_id: 'd2', action: 'get', request_id: 'del_1' }, CTX);
  assert.equal(gt.ok, true);
  assert.equal(calls[1]!.cap, 'memory.deletion.get');
  db.close();
});

test('审批②：reject 必带理由；decide 走 memory.deletion.decide（幂等 op）；approve/reject 结果语义', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => { calls.push({ cap, payload: payload as Record<string, unknown> }); return { ok: true, result: { request_id: 'del_1', status: 'rejected' } }; };
  const { tools, db } = makeTools(mariposa);
  const bad = await tools.execute('deletion_review', { __tool_call_id: 'd3', action: 'decide', request_id: 'del_1', decision: 'reject' }, CTX);
  assert.equal(bad.ok, false);
  assert.ok(String(bad.output.error).includes('rejection_reason'), '拒绝必带理由（她会看到）');
  const rj = await tools.execute('deletion_review', { __tool_call_id: 'd4', action: 'decide', request_id: 'del_1', decision: 'reject', rejection_reason: '这条对我们还有意义' }, CTX);
  assert.equal(rj.ok, true);
  assert.equal(calls[0]!.cap, 'memory.deletion.decide');
  assert.equal(calls[0]!.payload.rejection_reason, '这条对我们还有意义');
  assert.ok(String(calls[0]!.payload.operation_id).startsWith('es-del-'));
  assert.equal(rj.output.status, 'rejected', '结果语义如实');
  db.close();
});
