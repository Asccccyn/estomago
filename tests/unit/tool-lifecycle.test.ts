// R07（审计 FE-12）：工具生命周期事件合同——统一身份贯穿 start/result/error
// 三阶段；真实回执（ok/error_code 如实）；SILENT_TOOLS 不发声；重复执行
// 逐次真实回执，0 假成功。
import { test } from 'node:test';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const HOLD_ARGS = { original_title: '生命周期回归', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' };

function setup(transport: MariposaTransport) {
  const root = tempRoot('tool-life-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(new Date().toISOString());
  const events = new EventService(db);
  const { tools: tools } = assembleTestTools({ db: db, mariposa: new MariposaClient({ transport }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), events: events });
  const toolEvents = () => (db.prepare(
    "SELECT kind, payload_ref FROM runtime_stream_events WHERE kind='turn.tool' ORDER BY sequence",
  ).all() as Array<{ kind: string; payload_ref: string }>)
    .map(r => JSON.parse(r.payload_ref) as Record<string, unknown>);
  return { db, tools, toolEvents };
}

const okMariposa: MariposaTransport = async (_cap, payload) => ({ ok: true, result: { operation_id: (payload as { operation_id: string }).operation_id, memory_id: 'mem-x', version: 1, binding_ids: [], committed_at: new Date().toISOString() } });

test('R07：同一身份贯穿 start→result；身份字段完整', async () => {
  const { db, tools, toolEvents } = setup(okMariposa);
  try {
    const out = await tools.execute('memory_hold', { ...HOLD_ARGS }, {
      roomId: 'c1', windowId: 'w1', turnId: 'turn-9', purpose: 'chat', activeReviewId: null,
      seenSequence: 1, seenMessages: [], requestId: 'req-9',
      toolCallId: 'call-life-1', attemptId: 'att-9', round: 1, generationId: 'gen-9',
    });
    assert.equal(out.ok, true);
    const evs = toolEvents();
    assert.equal(evs.length, 2, 'start + result 两阶段');
    const [start, result] = evs as Array<Record<string, unknown>>;
    assert.equal(start.phase, 'start');
    assert.equal(result.phase, 'result');
    for (const key of ['tool_call_id', 'turn_id', 'attempt_id', 'request_id', 'generation_id', 'round', 'tool', 'label']) {
      assert.equal(start[key], result[key], `身份字段 ${key} 两阶段一致`);
    }
    assert.equal(start.tool_call_id, 'call-life-1');
    assert.equal(start.attempt_id, 'att-9');
    assert.equal(start.request_id, 'req-9');
    assert.equal(start.generation_id, 'gen-9');
    assert.equal(start.round, 1);
    assert.equal((result as { ok: boolean }).ok, true);
    assert.equal('ok' in start, false, 'start 阶段不带结果（不预支成功）');
  } finally { db.close(); }
});

test('R07：执行失败=result ok:false+error_code 如实（0 假成功）', async () => {
  const { db, tools, toolEvents } = setup(okMariposa);
  try {
    const out = await tools.execute('memory_hold', { bad: 1 }, {
      roomId: 'c1', windowId: 'w1', turnId: 'turn-b', purpose: 'chat', activeReviewId: null,
      seenSequence: 1, seenMessages: [], requestId: 'req-b', toolCallId: 'call-bad', attemptId: 'att-b', round: 0, generationId: null,
    });
    assert.equal(out.ok, false);
    const evs = toolEvents() as Array<{ phase: string; ok?: boolean; error_code?: string | null }>;
    assert.equal(evs.length, 2);
    assert.equal(evs[1]!.phase, 'result');
    assert.equal(evs[1]!.ok, false);
    assert.ok(evs[1]!.error_code, '失败带 error_code');
  } finally { db.close(); }
});

test('R07：执行器抛错=error 阶段+原样上抛（不吞不改）', async () => {
  const { db, tools, toolEvents } = setup(okMariposa);
  try {
    // P04：handler 已归 memory 域条目——抛错注入改经 registry 条目 run 包装（意图不变：handler 抛错=error 阶段+原样上抛）
    const reg = (tools as unknown as { getCapabilityRegistry(): { get(id: string): { run: unknown } | null } }).getCapabilityRegistry()!;
    const holdDescriptor = reg.get('memory_hold')! as { run: (i: unknown, c: unknown) => Promise<never> };
    const origRun = holdDescriptor.run;
    holdDescriptor.run = async () => { throw new Error('boom-生命周期'); };
    void origRun;
    await assert.rejects(
      tools.execute('memory_hold', { ...HOLD_ARGS }, {
        roomId: 'c1', windowId: 'w1', turnId: 'turn-x', purpose: 'chat', activeReviewId: null,
        seenSequence: 1, seenMessages: [], requestId: 'req-x', toolCallId: 'call-x', attemptId: null, round: null, generationId: null,
      }),
      /boom-生命周期/,
    );
    const evs = toolEvents() as Array<{ phase: string; error?: string }>;
    assert.deepEqual(evs.map(e => e.phase), ['start', 'error']);
    assert.ok(evs[1]!.error!.includes('boom-生命周期'));
  } finally { db.close(); }
});

test('R07：SILENT_TOOLS 零事件；重复执行逐次真实回执', async () => {
  const { db, tools, toolEvents } = setup(okMariposa);
  try {
    await tools.execute('context_review_complete', { }, {
      roomId: 'c1', windowId: 'w1', turnId: 'turn-q', purpose: 'chat', activeReviewId: null,
      seenSequence: 1, seenMessages: [], requestId: 'req-q', toolCallId: 'quiet-1',
    });
    assert.equal(toolEvents().length, 0, 'SILENT_TOOLS 不发声');
    const ctx = {
      roomId: 'c1', windowId: 'w1', turnId: 'turn-r', purpose: 'chat', activeReviewId: null,
      seenSequence: 1, seenMessages: [], requestId: 'req-r', toolCallId: 'call-repeat', attemptId: 'att-r', round: 2, generationId: 'gen-r',
    };
    await tools.execute('memory_hold', { ...HOLD_ARGS }, ctx);
    await tools.execute('memory_hold', { ...HOLD_ARGS }, ctx);
    const evs = toolEvents() as Array<{ phase: string; tool_call_id?: string }>;
    assert.equal(evs.length, 4, '两次执行各一对 start/result（迟到/重复不吞回执）');
    assert.ok(evs.every(e => e.tool_call_id === 'call-repeat'));
  } finally { db.close(); }
});
