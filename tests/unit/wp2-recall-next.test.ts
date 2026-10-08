// WP2（MANUAL_HANDOFF_JUDGE_SWITCH_V1，2026-10-08）M 侧分页的宿主消费面：
//  - memory_recall：去 slice(0,20)——页合同字段（pagination/judge_mode/
//    judgement_status/retrieval_coverage）穿透到模型可见层；翻页入口如实提示
//  - memory_recall_next：只消费冻结结果集（不修改查询、不发 refine）；
//    形状门（缺 pagination/judge_mode = RECALL_ENVELOPE_INVALID）；
//    RECALL_POLICY_CHANGED 如实上抛不自动重查
// 对应验收：P10（next 仅消费原 result_set；refine 是独立动作）、
// P12（宿主不代读全页——has_more 只是提示）、J08（政策切换上抛）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';
import { HostToolExecutor, validateToolArgs } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-1' } as const;

function makeTools(mariposa: MariposaTransport) {
  const root = tempRoot('wp2-');
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  return { tools, db };
}

const offFirstPage = {
  recall_session_id: 'rs_wp2', revision: 1, search_status: 'AMBIGUOUS',
  judge_mode: 'off', judge_policy_revision: 3, judgement_status: 'bypassed_by_user', judged_count: 0,
  retrieval_coverage: { retrieval_scope_exhaustive: false, event: 'complete_within_scope' },
  candidates: Array.from({ length: 10 }, (_, i) => ({ memory_id: `0000${i}`, resource_ref: `memory:0000${i}`, text: `候选${i}` })),
  pagination: { result_set_id: 'rps_wp2', returned_count: 10, candidate_total: 53, has_more: true, next_cursor: 'pgc_next1' },
};

const offSecondPage = {
  recall_session_id: 'rs_wp2', revision: 1,
  judge_mode: 'off', judge_policy_revision: 3, judgement_status: 'bypassed_by_user',
  candidates: [{ resource_ref: 'memory:0010', text: '候选10' }],
  pagination: { result_set_id: 'rps_wp2', returned_count: 1, candidate_total: 53, has_more: false, next_cursor: null },
  invalidated: [],
};

test('WP2：memory_recall 关闭模式首页——pagination/judge 字段穿透、无 slice 截断、翻页入口提示', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => {
    calls.push({ cap, payload: payload as Record<string, unknown> });
    if (cap === 'memory.recall.start') return { ok: true, result: offFirstPage };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall', { __tool_call_id: 'call-1', query: '找搬家' }, CTX);
  assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 300));
  const o = out.output as Record<string, unknown>;
  // P01 穿透：10 条全部到达模型可见层（不再 slice(0,20) 之外还有二次裁剪，
  // 且未来 >20 的页也原样透传——服务端负责字节预算）
  assert.equal((o.candidates as unknown[]).length, 10);
  assert.equal((o.pagination as Record<string, unknown>).candidate_total, 53);
  assert.equal(o.judge_mode, 'off');
  assert.equal(o.judgement_status, 'bypassed_by_user');
  assert.ok(String(o.pagination_note).includes('memory_recall_next'), '翻页入口如实提示');
  assert.ok(String(o.pagination_note).includes('pgc_next1'), '下一页游标进入提示');
  // 开启请求携带 room scope（页面请求与 session 绑定一致）
  assert.equal(calls[0]!.payload.conversation_scope, 'c1');
  db.close();
});

test('WP2：memory_recall_next 只消费冻结结果集——参数原样到达 memory.recall.page，不发 start/refine', async () => {
  const caps: string[] = [];
  let pagePayload: Record<string, unknown> = {};
  const mariposa: MariposaTransport = async (cap, payload) => {
    caps.push(cap);
    if (cap === 'memory.recall.page') {
      pagePayload = payload as Record<string, unknown>;
      return { ok: true, result: offSecondPage };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall_next', { __tool_call_id: 'call-2', result_set_id: 'rps_wp2', cursor: 'pgc_next1', session_id: 'rs_wp2' }, CTX);
  assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 300));
  // P10：只消费原 result_set——没有 start/refine
  assert.deepEqual(caps, ['memory.recall.page']);
  assert.equal(pagePayload.result_set_id, 'rps_wp2');
  assert.equal(pagePayload.cursor, 'pgc_next1');
  assert.equal(pagePayload.session_id, 'rs_wp2');
  assert.equal(pagePayload.conversation_scope, 'c1', 'room scope 随页携带（session 归属门）');
  const o = out.output as Record<string, unknown>;
  assert.equal(o.judge_mode, 'off');
  assert.equal((o.pagination as Record<string, unknown>).has_more, false);
  assert.ok(!(o as Record<string, unknown>).pagination_note, '翻尽无续页提示');
  db.close();
});

test('WP2：形状门——缺 pagination/judge_mode = RECALL_ENVELOPE_INVALID，不默认成功', async () => {
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'memory.recall.page') {
      return { ok: true, result: { recall_session_id: 'rs_wp2', candidates: [], judge_mode: 'off' } }; // 缺 pagination
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall_next', { __tool_call_id: 'c', result_set_id: 'rps_wp2' }, CTX);
  assert.equal(out.ok, false);
  assert.equal(out.output.error_code, 'RECALL_ENVELOPE_INVALID');
  assert.ok((out.output.missing_fields as string[]).includes('pagination'));
  db.close();
});

test('WP2：RECALL_POLICY_CHANGED 如实上抛（不自动重查、不混模式）', async () => {
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'memory.recall.page') {
      return { ok: false, code: 'RECALL_POLICY_CHANGED', httpStatus: 403, detail: { current_mode: 'on' } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall_next', { __tool_call_id: 'c', result_set_id: 'rps_wp2', cursor: 'x' }, CTX);
  assert.equal(out.ok, false);
  assert.equal(out.output.error_code, 'RECALL_POLICY_CHANGED');
  db.close();
});

test('WP2：参数门与白名单——缺 result_set_id 拒；游标/续查引用分槽不互换', async () => {
  const caps: string[] = [];
  const mariposa: MariposaTransport = async (cap) => { caps.push(cap); return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 }; };
  const { tools, db } = makeTools(mariposa);
  const bad = validateToolArgs('memory_recall_next', {});
  assert.ok(!bad.ok, '缺 result_set_id 拒');
  // refine 引用塞给 next：不是本工具参数（additionalProperties:false 拒）
  const mixed = validateToolArgs('memory_recall_next', { result_set_id: 'rps', refine_continue_ref: 'cont_x' });
  assert.ok(!mixed.ok, 'refine 引用与分页游标分槽——next 不接受 refine 参数');
  db.close();
});
