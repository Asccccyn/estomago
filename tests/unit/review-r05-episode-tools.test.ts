// R05（复审 2026-10-07）：episode 主模型写入口真正可达 + 列表续页可消费。
// 反例（旧码）：模型只有 episode_list/get，调用 episode_apply 吃
// TOOL_NOT_IN_ALLOWLIST；list 固定 5 条带 has_more 却丢 next_cursor——第 6
// 条未知事件无法被发现。
// 验收（复审原文）：真实主模型工具调度边界执行 start→pause/continue→close
// →correct；宿主稳定 operation_id（同调用重试同 op）；续页接通。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { HostToolExecutor, validateToolArgs } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';

const CTX = { roomId: 'room-live', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-1' } as const;

type Call = { cap: string; payload: Record<string, unknown> };

function tools(log: Call[], result: Record<string, unknown> | { ok: false; code: string }): HostToolExecutor {
  const root = tempRoot('r05-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const transport: MariposaTransport = async (cap, payload) => {
    log.push({ cap, payload: payload as Record<string, unknown> });
    if (result && (result as { ok?: boolean }).ok === false) {
      return result as { ok: false; code: string };
    }
    return { ok: true, result };
  };
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  wireOidoCapabilitiesForTest(tools, {});
  return tools;
}

test('R05：episode_apply 过白名单，宿主派生 operation_id/scope_id（模型不能自编）', async () => {
  const log: Call[] = [];
  const t = tools(log, { episode_id: 'ep_x1', state: 'OPEN', revision: 1 });
  const args = { __tool_call_id: 'call-e1', action: 'start', reason_code: 'tracking_requested', label: '装修跟踪' };
  const out = await t.execute('episode_apply', args, CTX);
  assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 200));
  assert.equal(log.length, 1);
  assert.equal(log[0]!.cap, 'episode.apply');
  const expectedOp = `es-ep-${sha256Hex('t1:call-e1').slice(0, 40)}`;
  assert.equal((log[0]!.payload as Record<string, unknown>).operation_id, expectedOp, '宿主派生稳定操作身份');
  assert.equal((log[0]!.payload as Record<string, unknown>).scope_id, 'room-live', '范围=当前房间');
  // 同 tool_call 重试：同 op（服务端按 op 幂等回放）
  await t.execute('episode_apply', args, CTX);
  assert.equal((log[1]!.payload as Record<string, unknown>).operation_id, expectedOp, '重试同 op');
  // 新调用：新 op
  await t.execute('episode_apply', { ...args, __tool_call_id: 'call-e2' }, CTX);
  assert.notEqual((log[2]!.payload as Record<string, unknown>).operation_id, expectedOp, '新调用新逻辑身份');
  // 模型自编 operation_id/scope_id：参数门直接拒（additionalProperties:false，
  // 宿主派生身份不可绕）——不出站
  const forged = await t.execute('episode_apply', { ...args, __tool_call_id: 'call-e3', operation_id: 'forged', scope_id: 'other' } as Record<string, unknown>, CTX);
  assert.equal(forged.ok, false);
  assert.equal((forged.output as Record<string, unknown>).error_code, 'TOOL_ARG_UNKNOWN');
  assert.equal(log.length, 3, '自编身份的调用不出站');
});

test('R05：episode_apply 全生命周期五动作可达（start→pause→continue→close→correct）', async () => {
  const log: Call[] = [];
  const t = tools(log, { episode_id: 'ep_x2', state: 'OPEN', revision: 2 });
  const acts: Array<Record<string, unknown>> = [
    { action: 'start', reason_code: 'tracking_requested', label: '装修' },
    { action: 'pause', reason_code: 'waiting', episode_id: 'ep_x2', expected_revision: 1 },
    { action: 'continue', reason_code: 'same_episode', episode_id: 'ep_x2', expected_revision: 2 },
    { action: 'close', reason_code: 'goal_resolved', episode_id: 'ep_x2', expected_revision: 3, terminal_source_ref: { source_message_id: 'sm_1', content_hash: 'h' }, decision_source_refs: [{ source_message_id: 'sm_1', content_hash: 'h' }] },
    { action: 'correct', reason_code: 'boundary_error', episode_id: 'ep_x2', expected_revision: 4, corrected_state: 'OPEN', note: '误关，重开', decision_source_refs: [{ source_message_id: 'sm_1', content_hash: 'h' }] },
  ];
  for (let i = 0; i < acts.length; i++) {
    const out = await t.execute('episode_apply', { __tool_call_id: `call-lc-${i}`, ...acts[i]! }, CTX);
    assert.equal(out.ok, true, `动作 ${i}（${String(acts[i]!.action)}）：${JSON.stringify(out.output).slice(0, 200)}`);
    assert.equal(log[i]!.cap, 'episode.apply');
  }
  assert.equal(log.length, 5, '五动作全部真实出站');
});

test('R05：episode_list 续页游标透传+next_cursor 可消费；错误结构化透传', async () => {
  const log: Call[] = [];
  const cursor = { updated_before: '2026-10-07T00:00:00Z', episode_id_before: 'ep_a' };
  const t = tools(log, { scope_id: 'room-live', count: 5, has_more: true, next_cursor: { updated_before: 'x', episode_id_before: 'y' }, episodes: [] });
  const out = await t.execute('episode_list', { __tool_call_id: 'c-l1', cursor }, CTX);
  assert.equal(out.ok, true);
  assert.deepEqual((log[0]!.payload as Record<string, unknown>).cursor, cursor, '续页游标原样透传');
  assert.deepEqual((out.output as Record<string, unknown>).next_cursor, { updated_before: 'x', episode_id_before: 'y' }, '第 6 条事件有可消费的续页入口');
  // 参数门：episode_apply 未知字段拒
  const bad = validateToolArgs('episode_apply', { action: 'start', reason_code: 'tracking_requested', forged_field: 1 });
  assert.ok(!bad.ok && bad.code === 'TOOL_ARG_UNKNOWN');
  // 服务端错误透传（VERSION_CONFLICT 不是 unknown）
  const log2: Call[] = [];
  const t2 = tools(log2, { ok: false, code: 'VERSION_CONFLICT' } as { ok: false; code: string });
  const err = await t2.execute('episode_apply', { __tool_call_id: 'c-e9', action: 'pause', reason_code: 'waiting', episode_id: 'ep_z', expected_revision: 9 }, CTX);
  assert.equal(err.ok, false);
  assert.equal((err.output as Record<string, unknown>).error_code, 'EPISODE_VERSION_CONFLICT');
});
