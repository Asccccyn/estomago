// 找话第一批（2026-10-10 她排期/林石见复核口径）：我们的话首轮、续查、翻页。
// 验收五条：①查事件旧行为不变（省略 channel→['event']）；②找话真实走 words
// 通道且结果回显；③续查不携带 channel 被明确拒绝（不静默回落 event）、携带
// 则保持 words；④words 通道禁用=如实"不可用"而非"没有找到"；⑤M 的
// round2_raw 提示不压扁成"改问题续查"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-w' } as const;

function makeTools(mariposa: MariposaTransport) {
  const root = tempRoot('wp2w-');
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) })
  wireOidoCapabilitiesForTest(tools, {});;
  return { tools, db };
}

const wordsPage = {
  recall_session_id: 'rs_w', revision: 1, search_status: 'FOUND',
  judge_mode: 'off', judge_policy_revision: 3, judgement_status: 'bypassed_by_user', judged_count: 0,
  candidates: [
    { word_id: 'w1', resource_ref: 'our_word:w1', speaker: 'qiaosheng', text: '我们去看海吧', ordinal: 1 },
    { word_id: 'w2', resource_ref: 'our_word:w2', speaker: 'jiaming', text: '好，秋天去', ordinal: 2 },
  ],
  pagination: { result_set_id: 'rps_w', returned_count: 2, candidate_total: 2, has_more: false, next_cursor: null },
};

test('找话①：省略 channel 的首轮仍走 event（旧行为不变）', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => {
    calls.push({ cap, payload: payload as Record<string, unknown> });
    return { ok: true, result: { ...wordsPage, candidates: [{ resource_ref: 'memory:1', text: '事件' }] } };
  };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall', { __tool_call_id: 'c1', query: '看海' }, CTX);
  assert.equal(out.ok, true);
  const qp = (calls[0]!.payload as { query_plan: { channels: string[] } }).query_plan;
  assert.deepEqual(qp.channels, ['event'], '缺省=查事件');
  // R1′（1023）：channel 回显属 scope echo，按模型输出合同（bd677ed）不进普通投影——
  // 模型自己的调用参数即目标；执行保真由上方 query_plan 断言承担
  assert.equal('channel' in out.output, false);
  db.close();
});

test('找话②：channel=words 首轮真实走 words 通道、原话候选穿透、目标回显', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => {
    calls.push({ cap, payload: payload as Record<string, unknown> });
    return { ok: true, result: wordsPage };
  };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall', { __tool_call_id: 'c1', query: '当时说的看海那句原话', channel: 'words' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0]!.cap, 'memory.recall.start');
  const qp = (calls[0]!.payload as { query_plan: { channels: string[] } }).query_plan;
  assert.deepEqual(qp.channels, ['words'], 'start 携带 words');
  assert.equal('channel' in out.output, false); // R1′(1023)：scope echo 不回显，见①
  assert.ok(JSON.stringify(out.output.candidates).includes('我们去看海吧'), '原话真实穿透到模型可见层');
  db.close();
});

test('找话③a：续查不带 channel 被明确拒绝（不静默回落查事件）', async () => {
  const mariposa: MariposaTransport = async () => ({ ok: true, result: wordsPage });
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall', { __tool_call_id: 'c1', query: '换角度', refine_session_id: 'rs_w', refine_continue_ref: 'cont_abc' }, CTX);
  assert.equal(out.ok, false);
  assert.equal(out.output.error_code, 'TOOL_ARG_REQUIRED');
  assert.ok(String(out.output.error).includes('channel'), '错误信息指明要带 channel');
  db.close();
});

test('找话③b：带 channel=words 的续查保持 words（关键词不丢目标）', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => {
    calls.push({ cap, payload: payload as Record<string, unknown> });
    return { ok: true, result: wordsPage };
  };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall', { __tool_call_id: 'c1', query: '看海 原话', channel: 'words', refine_session_id: 'rs_w', refine_continue_ref: 'cont_abc' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0]!.cap, 'memory.recall.refine');
  const qp = (calls[0]!.payload as { query_plan: { channels: string[] } }).query_plan;
  assert.deepEqual(qp.channels, ['words'], 'refine 保持 words');
  assert.equal('channel' in out.output, false); // R1′(1023)：scope echo 不回显，见①
  db.close();
});

test('找话④：words 通道禁用=如实"不可用"，不包装成"没有找到"', async () => {
  const mariposa: MariposaTransport = async () => ({ ok: false, code: 'WORDS_CHANNEL_DISABLED', httpStatus: 403 });
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall', { __tool_call_id: 'c1', query: '看海原话', channel: 'words' }, CTX);
  assert.equal(out.ok, false);
  assert.equal(out.output.error_code, 'RECALL_WORDS_CHANNEL_DISABLED');
  assert.ok(String(out.output.message ?? '').includes('未启用'), '明确告知通道关闭');
  assert.ok(!String(out.output.message ?? '').includes('没有找到'));
  db.close();
});

test('找话⑤：M 的 round2_raw 提示不被压扁成"改问题续查"', async () => {
  const mariposa: MariposaTransport = async () => ({
    ok: true,
    result: { ...wordsPage, continuation: { available: true, action: 'round2_raw', via: 'memory.recall.round2', continue_request_ref: 'cont_r2' } },
  });
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall', { __tool_call_id: 'c1', query: '看海原话', channel: 'words' }, CTX);
  assert.equal(out.ok, true);
  const note = String(out.output.continuation_note ?? '');
  assert.ok(note.includes('原话证据不足'), '如实传达 M 的证据不足提示');
  // 找话二批后：提示指向 E 层真实入口（deep_search 参数），不再引 M 能力名
  assert.ok(note.includes('deep_search=true'), '指明深搜的真实调用参数');
  assert.ok(!note.startsWith('续查（同一召回会话内收窄/换角度）'), '不得压扁成普通续查提示');
  db.close();
});

// ------------ 找话第二批：Round2 原文深搜 ------------
const round2Page = {
  recall_session_id: 'rs_w', revision: 2, search_status: 'FOUND',
  judge_mode: 'off', judge_policy_revision: 3, judgement_status: 'bypassed_by_user', judged_count: 0,
  candidates: [{ resource_ref: 'source_msg:sm1', channel: 'raw', excerpt: '……我们去看海吧……', evidence: [{ evidence_kind: 'raw_verbatim', snippet: '我们去看海吧' }] }],
  pagination: { result_set_id: 'rps_r2', returned_count: 1, candidate_total: 1, has_more: false, next_cursor: null },
};

test('深搜①：deep_search 走 memory.recall.round2 独立入口（session+reason 闭集+幂等 op）', async () => {
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const mariposa: MariposaTransport = async (cap, payload) => {
    calls.push({ cap, payload: payload as Record<string, unknown> });
    return { ok: true, result: round2Page };
  };
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall', { __tool_call_id: 'd1', query: '看海原话', channel: 'words', refine_session_id: 'rs_w', deep_search: true, deep_reason: 'EVIDENCE_INSUFFICIENT' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[0]!.cap, 'memory.recall.round2', '独立入口（不经 channels 绕）');
  const p = calls[0]!.payload as Record<string, unknown>;
  assert.equal(p.session_id, 'rs_w');
  assert.equal(p.reason, 'EVIDENCE_INSUFFICIENT');
  assert.ok(String(p.operation_id).startsWith('es-r2-'), '宿主派生幂等 op');
  // R1′（1023）：channel/deep_search 回显属 scope echo，按模型输出合同（bd677ed）不进
  // 普通投影——执行保真由上方 round2 入口/session/reason/op 断言承担
  assert.equal('channel' in out.output, false);
  assert.equal('deep_search' in out.output, false);
  assert.ok(JSON.stringify(out.output.candidates).includes('我们去看海吧'), '原文证据穿透');
  db.close();
});

test('深搜②：缺 session / 缺 reason 明确拒绝', async () => {
  const mariposa: MariposaTransport = async () => ({ ok: true, result: round2Page });
  const { tools, db } = makeTools(mariposa);
  const a = await tools.execute('memory_recall', { __tool_call_id: 'd1', query: 'x', deep_search: true, deep_reason: 'EVIDENCE_INSUFFICIENT' }, CTX);
  assert.equal(a.ok, false);
  assert.ok(String(a.output.error).includes('refine_session_id'), '缺会话指明');
  const b = await tools.execute('memory_recall', { __tool_call_id: 'd2', query: 'x', deep_search: true, refine_session_id: 'rs_w' }, CTX);
  assert.equal(b.ok, false);
  assert.ok(String(b.output.error).includes('deep_reason'), '缺理由指明');
  db.close();
});

test('深搜③：S13 门拒绝如实上抛（含指引），不冒充空结果', async () => {
  const mariposa: MariposaTransport = async () => ({ ok: false, code: 'ROUND2_GATE_DENIED', httpStatus: 403 });
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall', { __tool_call_id: 'd1', query: 'x', deep_search: true, refine_session_id: 'rs_w', deep_reason: 'EVIDENCE_INSUFFICIENT' }, CTX);
  assert.equal(out.ok, false);
  assert.equal(out.output.error_code, 'RECALL_ROUND2_GATE_DENIED');
  assert.ok(String(out.output.message ?? '').includes('门未满足'), '如实告知门核验失败');
  db.close();
});

test('深搜④：round2_raw 提示现在指向真实入口（deep_search 参数）', async () => {
  const mariposa: MariposaTransport = async () => ({
    ok: true,
    result: { ...wordsPage, continuation: { available: true, action: 'round2_raw', via: 'memory.recall.round2', continue_request_ref: 'cont_r2' } },
  });
  const { tools, db } = makeTools(mariposa);
  const out = await tools.execute('memory_recall', { __tool_call_id: 'c1', query: '看海原话', channel: 'words' }, CTX);
  assert.equal(out.ok, true);
  const note = String(out.output.continuation_note ?? '');
  assert.ok(note.includes('deep_search=true'), '指引真实参数');
  assert.ok(note.includes('EVIDENCE_INSUFFICIENT'));
  assert.ok(!note.includes('暂未接入'), '不再是暂未接入');
  db.close();
});
