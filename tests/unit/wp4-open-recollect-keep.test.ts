// 明确打开/回忆/留链批（2026-10-10 林石见序）：E 工具 memory_open。
// 验收：链路七动作各自路由正确 M 能力；confirm/recollect 无票据明确拒
// （语义铁律：召回/回读返回正文≠明确打开）；keep_wide 透传；revise/
// unkeep 的 ID 必填校验；M 错误码如实上抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';
import { HostToolExecutor, hostToolNames } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-o' } as const;

function makeTools(mariposa: MariposaTransport) {
  const root = tempRoot('wp4ok-');
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) })
  wireOidoCapabilitiesForTest(tools, {});;
  return { tools, db };
}

test('工具面：memory_open 已注册', () => {
  assert.ok(hostToolNames().includes('memory_open'));
});

test('链①：open → memory.open，票据与正文穿透；语义提示"打开≠回温"', async () => {
  const calls: string[] = [];
  const mariposa: MariposaTransport = async (cap) => { calls.push(cap); return { ok: true, result: { memory_id: 'm1', text: '记忆正文', view_receipt: 'vr_abc' } }; };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_open', { __tool_call_id: 'o1', action: 'open', memory_id: 'm1' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0], 'memory.open');
  assert.equal(out.output.view_receipt, 'vr_abc');
  assert.equal(out.output.note,undefined,'重复说明不进入模型结果；确认仍需票据');
  db.close();
});

test('链②：confirm 缺 receipt_id 明确拒；带票据 → memory.view.confirm', async () => {
  const calls: string[] = [];
  const mariposa: MariposaTransport = async (cap) => { calls.push(cap); return { ok: true, result: { memory_id: 'm1', receipt_id: 'vr_abc', explicit_open_at: '2026-10-10T00:00:00Z' } }; };
  const { tools, db } = makeTools(mariposa);
  const bad = await tools.execute('memory_open', { __tool_call_id: 'o2', action: 'confirm', memory_id: 'm1' }, CTX);
  assert.equal(bad.ok, false);
  assert.ok(String(bad.output.error).includes('receipt_id'), '缺票据指明先 open');
  const ok = await tools.execute('memory_open', { __tool_call_id: 'o3', action: 'confirm', memory_id: 'm1', receipt_id: 'vr_abc' }, CTX);
  assert.equal(ok.ok, true);
  assert.equal(calls[0], 'memory.view.confirm');
  db.close();
});

test('链③：recollect（keep_wide 透传）→ memory.recollections.append 且留标记同置', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => { calls.push({ cap, payload: payload as Record<string, unknown> }); return { ok: true, result: { recollection_id: 'rc_1', keep: { mark_id: 'mk_1' } } }; };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_open', { __tool_call_id: 'o4', action: 'recollect', memory_id: 'm1', receipt_id: 'vr_abc', text: '我后来又想起的后续', keep_wide: true }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0]!.cap, 'memory.recollections.append');
  assert.equal(calls[0]!.payload.keep_wide, true, 'keep_wide 透传（真合同——不凭空造 keep.add）');
  assert.equal(out.output.keep.mark_id, 'mk_1', '留标记随回忆返回');
  db.close();
});

test('链④：revise 缺 recollection_id 拒；recollections/keeps 列表路由', async () => {
  const calls: string[] = [];
  const mariposa: MariposaTransport = async (cap) => { calls.push(cap); return { ok: true, result: { recollections: [], marks: [] } }; };
  const { tools, db } = makeTools(mariposa);
  const bad = await tools.execute('memory_open', { __tool_call_id: 'o5', action: 'revise', text: '改' }, CTX);
  assert.equal(bad.ok, false);
  assert.ok(String(bad.output.error).includes('recollection_id'));
  const rv = await tools.execute('memory_open', { __tool_call_id: 'o6', action: 'revise', recollection_id: 'rc_1', text: '改后' }, CTX);
  assert.equal(rv.ok, true);
  assert.equal(calls[0], 'memory.recollections.revise');
  const rl = await tools.execute('memory_open', { __tool_call_id: 'o7', action: 'recollections', memory_id: 'm1', include_history: true }, CTX);
  assert.equal(rl.ok, true);
  assert.equal(calls[1], 'memory.recollections.list');
  const kl = await tools.execute('memory_open', { __tool_call_id: 'o8', action: 'keeps', memory_id: 'm1' }, CTX);
  assert.equal(kl.ok, true);
  assert.equal(calls[2], 'memory.keeps.list');
  db.close();
});

test('链⑤：unkeep → memory.keep.revoke（谁留谁撤）；票据失效如实上抛', async () => {
  const calls: string[] = [];
  const mariposa: MariposaTransport = async (cap) => {
    calls.push(cap);
    if (cap === 'memory.view.confirm') return { ok: false, code: 'RECEIPT_INVALID', httpStatus: 403 };
    return { ok: true, result: { revoked: true } };
  };
  const { tools, db } = makeTools(mariposa);
  const uk = await tools.execute('memory_open', { __tool_call_id: 'o9', action: 'unkeep', mark_id: 'mk_1' }, CTX);
  assert.equal(uk.ok, true);
  assert.equal(calls[0], 'memory.keep.revoke');
  assert.equal(uk.output.note,undefined);assert.equal(uk.output.revoked,true);
  const stale = await tools.execute('memory_open', { __tool_call_id: 'o10', action: 'confirm', memory_id: 'm1', receipt_id: 'vr_old' }, CTX);
  assert.equal(stale.ok, false);
  assert.equal(stale.output.error_code, 'OPEN_RECEIPT_INVALID', '票据失效如实上抛不吞');
  db.close();
});
