// I/计划写入批（2026-10-10 她排期"继续"）：char维护自己的 I 与计划。
// 验收：三 I 写动作+四计划写动作各自路由正确 M 能力；CAS/必填缺失明确
// 拒；M 冲突码如实上抛不吞；create/update 带宿主派生幂等 operation_id。
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

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-w' } as const;

function makeTools(mariposa: MariposaTransport) {
  const root = tempRoot('wp3iw-');
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) })
  wireOidoCapabilitiesForTest(tools, {  });;
  return { tools, db };
}

test('工具面：memory_i_write 与 plans_write 已注册', () => {
  const names = hostToolNames();
  assert.ok(names.includes('memory_i_write'));
  assert.ok(names.includes('plans_write'));
});

test('I写①：create → i.item.create（change_reason 透传）', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => { calls.push({ cap, payload: payload as Record<string, unknown> }); return { ok: true, result: { item_id: 'it9', revision: 1 } }; };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_i_write', { __tool_call_id: 'w1', action: 'create', content: '新的一条', change_reason: '补充自我认知' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0]!.cap, 'i.item.create');
  assert.equal(calls[0]!.payload.content, '新的一条');
  assert.equal(calls[0]!.payload.change_reason, '补充自我认知');
  assert.equal(out.output.item_id, 'it9');
  db.close();
});

test('I写②：revise 缺 item_id/expected_revision/content 明确拒', async () => {
  const mariposa: MariposaTransport = async () => ({ ok: true, result: {} });
  const { tools, db } = makeTools(mariposa);
  const a = await tools.execute('memory_i_write', { __tool_call_id: 'w2', action: 'revise', content: 'x' }, CTX);
  assert.equal(a.ok, false);
  assert.equal(a.output.error_code, 'TOOL_ARG_REQUIRED');
  assert.ok(String(a.output.error).includes('item_id'));
  const b = await tools.execute('memory_i_write', { __tool_call_id: 'w3', action: 'revise', item_id: 'it1', expected_revision: 2 }, CTX);
  assert.equal(b.ok, false);
  assert.ok(String(b.output.error).includes('content'));
  db.close();
});

test('I写③：revise 全参 → i.item.revise（CAS+informed_by 透传）；restore → i.item.restore（缺 restore_revision 拒）', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => { calls.push({ cap, payload: payload as Record<string, unknown> }); return { ok: true, result: { item_id: 'it1', revision: 3 } }; };
  const { tools, db } = makeTools(mariposa);
  const rv = await tools.execute('memory_i_write', { __tool_call_id: 'w4', action: 'revise', item_id: 'it1', content: '改后', expected_revision: 2, informed_by_revision: 1 }, CTX);
  assert.equal(rv.ok, true);
  assert.equal(calls[0]!.cap, 'i.item.revise');
  assert.equal(calls[0]!.payload.expected_revision, 2);
  assert.equal(calls[0]!.payload.informed_by_revision, 1);
  const bad = await tools.execute('memory_i_write', { __tool_call_id: 'w5', action: 'restore', item_id: 'it1', expected_revision: 3 }, CTX);
  assert.equal(bad.ok, false);
  assert.ok(String(bad.output.error).includes('restore_revision'));
  const ok = await tools.execute('memory_i_write', { __tool_call_id: 'w6', action: 'restore', item_id: 'it1', expected_revision: 3, restore_revision: 1 }, CTX);
  assert.equal(ok.ok, true);
  assert.equal(calls[1]!.cap, 'i.item.restore');
  assert.equal(calls[1]!.payload.restore_revision, 1);
  db.close();
});

test('计划写①：create → plan.create（宿主幂等 op）；缺 title 拒', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => { calls.push({ cap, payload: payload as Record<string, unknown> }); return { ok: true, result: { plan_id: 'p1', version: 1 } }; };
  const { tools, db } = makeTools(mariposa);
  const bad = await tools.execute('plans_write', { __tool_call_id: 'pw0', action: 'create' }, CTX);
  assert.equal(bad.ok, false);
  assert.ok(String(bad.output.error).includes('title'));
  const out = await tools.execute('plans_write', { __tool_call_id: 'pw1', action: 'create', title: '十月看海', content: '秋天去', due_at: '2026-10-30' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0]!.cap, 'plan.create');
  assert.equal(calls[0]!.payload.title, '十月看海');
  assert.equal(calls[0]!.payload.due_at, '2026-10-30');
  assert.ok(String(calls[0]!.payload.operation_id).startsWith('es-pw-'), '宿主派生幂等 op');
  db.close();
});

test('计划写②：update → plan.update（CAS+字段透传）；冲突码如实上抛', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => {
    calls.push({ cap, payload: payload as Record<string, unknown> });
    if (calls.length === 1) return { ok: false, code: 'REVISION_CONFLICT', httpStatus: 409 };
    return { ok: true, result: { plan_id: 'p1', version: 3 } };
  };
  const { tools, db } = makeTools(mariposa);
  const conflict = await tools.execute('plans_write', { __tool_call_id: 'pw2', action: 'update', plan_id: 'p1', expected_version: 1, state: 'active' }, CTX);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.output.error_code, 'PLANS_REVISION_CONFLICT', 'CAS 冲突如实上抛（提示模型重读）');
  const ok = await tools.execute('plans_write', { __tool_call_id: 'pw3', action: 'update', plan_id: 'p1', expected_version: 2, state: 'active' }, CTX);
  assert.equal(ok.ok, true);
  assert.equal(calls[1]!.cap, 'plan.update');
  assert.equal(calls[1]!.payload.state, 'active');
  db.close();
});

test('计划写③：complete/cancel → 薄实现入口（plan_id+expected_version）', async () => {
  const calls: string[] = [];
  const mariposa: MariposaTransport = async (cap) => { calls.push(cap); return { ok: true, result: { plan_id: 'p1', state: 'done' } }; };
  const { tools, db } = makeTools(mariposa);
  const a = await tools.execute('plans_write', { __tool_call_id: 'pw4', action: 'complete', plan_id: 'p1', expected_version: 3 }, CTX);
  assert.equal(a.ok, true);
  assert.equal(calls[0], 'plan.complete');
  const b = await tools.execute('plans_write', { __tool_call_id: 'pw5', action: 'cancel', plan_id: 'p2', expected_version: 1 }, CTX);
  assert.equal(b.ok, true);
  assert.equal(calls[1], 'plan.cancel');
  const noCas = await tools.execute('plans_write', { __tool_call_id: 'pw6', action: 'complete', plan_id: 'p1' }, CTX);
  assert.equal(noCas.ok, false);
  assert.ok(String(noCas.output.error).includes('expected_version'));
  db.close();
});
