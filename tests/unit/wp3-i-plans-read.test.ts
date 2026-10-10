// I/计划只读批（2026-10-10 她排期，林石见复核序）：char主动读 I
// （当前话/条目/历史）与计划（列表/明细）——此前只有开窗摘要。
// 验收：五种 I 读法各自路由正确 M 能力；缺 item_id 拒；计划列表/明细
// 分流+状态筛选透传；M 错误（NOT_FOUND 等）如实上抛不吞。
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

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-i' } as const;

function makeTools(mariposa: MariposaTransport) {
  const root = tempRoot('wp3ip-');
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  return { tools, db };
}

test('工具面：memory_i_read 与 plans_read 已注册', () => {
  const names = hostToolNames();
  assert.ok(names.includes('memory_i_read'));
  assert.ok(names.includes('plans_read'));
});

test('I①：what=current → i.get，正文穿透+数据标记', async () => {
  const calls: string[] = [];
  const mariposa: MariposaTransport = async (cap) => { calls.push(cap); return { ok: true, result: { doc_id: 'i_main', content: '我是char', version: 3, items: [], item_count: 0 } }; };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_i_read', { __tool_call_id: 'i1' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0], 'i.get');
  assert.equal(out.output.content, '我是char');
  assert.equal(out.output.what, 'current');
  assert.ok(String(out.output.note).includes('数据'));
  db.close();
});

test('I②：what=items → i.items.list；what=item → i.item.get（缺 item_id 拒）', async () => {
  const calls: string[] = [];
  const mariposa: MariposaTransport = async (cap) => { calls.push(cap); return { ok: true, result: { items: [{ item_id: 'it1', revision: 2 }] } }; };
  const { tools, db } = makeTools(mariposa);
  const a = await tools.execute('memory_i_read', { __tool_call_id: 'i2', what: 'items' }, CTX);
  assert.equal(a.ok, true);
  assert.equal(calls[0], 'i.items.list');
  const bad = await tools.execute('memory_i_read', { __tool_call_id: 'i3', what: 'item' }, CTX);
  assert.equal(bad.ok, false);
  assert.equal(bad.output.error_code, 'TOOL_ARG_REQUIRED');
  assert.ok(String(bad.output.error).includes('item_id'));
  const c = await tools.execute('memory_i_read', { __tool_call_id: 'i4', what: 'item', item_id: 'it1' }, CTX);
  assert.equal(c.ok, true);
  assert.equal(calls[1], 'i.item.get');
  assert.equal(c.output.item_id, 'it1');
  db.close();
});

test('I③：what=item_history → i.item.history；what=doc_history → i.versions.read 且 NOT_FOUND 如实', async () => {
  const calls: string[] = [];
  const mariposa: MariposaTransport = async (cap) => {
    calls.push(cap);
    if (cap === 'i.versions.read') return { ok: false, code: 'NOT_FOUND', httpStatus: 404 };
    return { ok: true, result: { revisions: [{ revision: 1 }, { revision: 2 }] } };
  };
  const { tools, db } = makeTools(mariposa);
  const h = await tools.execute('memory_i_read', { __tool_call_id: 'h1', what: 'item_history', item_id: 'it1' }, CTX);
  assert.equal(h.ok, true);
  assert.equal(calls[0], 'i.item.history');
  const v = await tools.execute('memory_i_read', { __tool_call_id: 'h2', what: 'doc_history' }, CTX);
  assert.equal(v.ok, false);
  assert.equal(v.output.error_code, 'I_NOT_FOUND', '无版本史如实上抛，不吞成空');
  db.close();
});

test('计划①：不带 plan_id → plan.list（states 筛选透传）', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => { calls.push({ cap, payload: payload as Record<string, unknown> }); return { ok: true, result: { plans: [{ plan_id: 'p1', state: 'planned' }] } }; };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('plans_read', { __tool_call_id: 'p1' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0]!.cap, 'plan.list');
  assert.deepEqual(calls[0]!.payload, {}, '无筛选=空参');
  const out2 = await tools.execute('plans_read', { __tool_call_id: 'p2', states: ['planned', 'in_progress'] }, CTX);
  assert.equal(out2.ok, true);
  assert.deepEqual((calls[1]!.payload as { states?: string[] }).states, ['planned', 'in_progress'], '状态筛选透传');
  db.close();
});

test('计划②：带 plan_id → plan.get（薄实现入口），明细穿透', async () => {
  const calls: string[] = [];
  const mariposa: MariposaTransport = async (cap) => { calls.push(cap); return { ok: true, result: { plan_id: 'p9', state: 'in_progress', content: '十月看海' } }; };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('plans_read', { __tool_call_id: 'p3', plan_id: 'p9' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0], 'plan.get');
  assert.equal(out.output.content, '十月看海');
  db.close();
});
