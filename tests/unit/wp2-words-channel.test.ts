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
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';
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
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
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
  assert.equal(out.output.channel, 'event', '结果回显目标');
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
  assert.equal(out.output.channel, 'words');
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
  assert.equal(out.output.channel, 'words');
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
  assert.ok(note.includes('round2'), '指明深搜入口');
  assert.ok(!note.startsWith('续查（同一召回会话内收窄/换角度）'), '不得压扁成普通续查提示');
  db.close();
});
