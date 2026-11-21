import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, type TestContext } from 'node:test';
import type { ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { freezeWindowTools, storedToolset } from '../../apps/host/src/runtime/tool-discovery.ts';
import { assembleTestTools, makeDb } from '../helpers.ts';

function fixture(t: TestContext) {
  const { db, root } = makeDb();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const roomId = 'direct-room';
  const windowId = 'direct-window';
  const messages = new MessageService(db);
  messages.ensureConversation(roomId);
  const { turnId, message } = messages.submitUserMessageWithTurn({
    conversationId: roomId, content: '合成输入', clientMessageId: 'direct-input',
  });
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE','now','now')").run(windowId, roomId);
  const review = new RotationReviewService(db);
  const calls: Array<Record<string, unknown>> = [];
  const mariposa = new MariposaClient({
    transport: async (capability, payload) => {
      assert.equal(capability, 'memory.hold');
      calls.push(payload);
      return { ok: true, result: {
        operation_id: payload.operation_id, memory_id: 'synthetic-memory', version: 1,
        binding_ids: [], committed_at: '2026-11-20T00:00:00Z',
      } };
    },
  });
  const { tools, registry } = assembleTestTools({
    db, messages, mariposa, reviews: review, checkpoint: new HoldCheckpointService(db),
  });
  const wire = freezeWindowTools(db, windowId, registry.currentCatalog(), 'direct', registry.currentGroups());
  const ctx: ToolExecContext = {
    roomId, windowId, turnId, purpose: 'chat', activeReviewId: null,
    seenSequence: message.sequence, seenMessages: [], requestId: 'native-request',
  };
  return { db, review, calls, tools, wire, ctx };
}

test('新窗直调走冻结业务 schema 和唯一写入入口，拒绝未发布的通用入口', async t => {
  const f = fixture(t);
  const holdArgs = { original_title: '标题', categories: ['daily'], text: '中文正文', creation_mode: 'contemporaneous' };
  const frozen = storedToolset(f.db, f.ctx.windowId);
  assert.ok(frozen);
  assert.equal(frozen.protocol, 'direct');
  assert.deepEqual(f.wire.find(tool => tool.function.name === 'memory_hold')?.function.parameters,
    frozen.catalog.find(tool => tool.function.name === 'memory_hold')?.function.parameters);
  const wrapped = await f.tools.execute('tool_invoke', { name: 'memory_hold', arguments: holdArgs }, f.ctx);
  assert.equal(wrapped.output.error_code, 'TOOL_PROTOCOL_NOT_ACTIVE');
  const invalid = await f.tools.execute('memory_hold', { ...holdArgs, text: 3 }, f.ctx);
  assert.equal(invalid.output.error_code, 'TOOL_ARG_TYPE');
  assert.equal(f.calls.length, 0);
  const saved = await f.tools.execute('memory_hold', holdArgs, f.ctx);
  assert.equal(saved.ok, true, JSON.stringify(saved.output));
  assert.equal(saved.output.version, 1);
  assert.equal(f.calls[0]?.text, holdArgs.text);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(storedToolset(f.db, f.ctx.windowId), frozen);
});

test('新窗评审工具只对可信、实际活跃的换窗评审可发现及执行', async t => {
  const f = fixture(t);
  assert.ok(!f.wire.some(tool => tool.function.name === 'context_review_complete'));
  const review = f.review.create(f.ctx.windowId, f.ctx.roomId, 1, []);
  const args = { review_id: review.id, decision: 'no_new_hold' };
  const spoofed = { ...f.ctx, activeReviewId: review.id };
  const chat = await f.tools.execute('tool_catalog', {}, spoofed);
  assert.ok(chat.ok);
  assert.ok((chat.output.tools as Array<{ name: string }>).some(tool => tool.name === 'memory_hold'));
  assert.ok(!(chat.output.tools as Array<{ name: string }>).some(tool => tool.name === 'context_review_complete'));
  const hidden = await f.tools.execute('tool_define', { name: 'context_review_complete' }, spoofed);
  assert.equal(hidden.output.error_code, 'TOOL_NOT_IN_ALLOWLIST');
  assert.equal((await f.tools.execute('context_review_complete', args, spoofed)).ok, false);
  assert.equal(f.review.get(review.id)?.status, 'active');

  const scoped = { ...spoofed, purpose: 'pre_rotate_review' as const, turnId: null };
  const definition = await f.tools.execute('tool_define', { name: 'context_review_complete' }, scoped);
  assert.equal(definition.ok, true, JSON.stringify(definition.output));
  const completed = await f.tools.execute('context_review_complete', args, scoped);
  assert.equal(completed.ok, true, JSON.stringify(completed.output));
  assert.equal(f.review.get(review.id)?.status, 'completed');
  const repeated = await f.tools.execute('context_review_complete', args, scoped);
  assert.equal(repeated.ok, true, JSON.stringify(repeated.output));
  const conflicting = await f.tools.execute('context_review_complete', { ...args, decision: 'holds_completed' }, scoped);
  assert.equal(conflicting.output.error_code, 'REVIEW_DECISION_CONFLICT');
  const completedDefinition = await f.tools.execute('tool_define', { name: 'context_review_complete' }, scoped);
  assert.equal(completedDefinition.output.error_code, 'TOOL_NOT_IN_ALLOWLIST');
});

test('新窗后台工具只允许完成当前同窗同轮的真实运行', async t => {
  const f = fixture(t);
  assert.ok(!f.wire.some(tool => tool.function.name === 'background_complete'));
  const { db, ctx } = f;
  db.prepare("INSERT INTO turns(id,conversation_id,trigger,state,created_at) VALUES ('bg-turn',?,'proactive_turn','running','now')").run(ctx.roomId);
  db.prepare(
    "INSERT INTO background_tasks(id,conversation_id,actor_id,kind,schedule_kind,created_by_actor_id,created_at,updated_at) VALUES ('bg-task',?,'jiaming','autonomous','once','jiaming','now','now')",
  ).run(ctx.roomId);
  db.prepare(
    "INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,window_id,turn_id,created_at,updated_at) VALUES ('bg-run','bg-task',?,'jiaming','autonomous',1,'occurrence','running',?,'bg-turn','now','now')",
  ).run(ctx.roomId, ctx.windowId);
  const scoped: ToolExecContext = { ...ctx, backgroundRunId: 'bg-run', turnId: 'bg-turn',
    purpose: 'proactive_turn', beforeBackgroundTool: () => {} };
  const args = { outcome: 'done' };
  assert.equal((await f.tools.execute('background_complete', args, { ...scoped, turnId: ctx.turnId })).ok, false);

  db.prepare("INSERT INTO turns(id,conversation_id,trigger,state,created_at) VALUES ('warm-turn',?,'cache_keepalive','running','now')").run(ctx.roomId);
  db.prepare(
    "INSERT INTO background_tasks(id,conversation_id,actor_id,kind,schedule_kind,created_by_actor_id,created_at,updated_at) VALUES ('warm-task',?,'jiaming','keepwarm','cache_idle','jiaming','now','now')",
  ).run(ctx.roomId);
  db.prepare(
    "INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,window_id,turn_id,created_at,updated_at) VALUES ('warm-run','warm-task',?,'jiaming','keepwarm',1,'warm-occurrence','running',?,'warm-turn','now','now')",
  ).run(ctx.roomId, ctx.windowId);
  const warm = { ...scoped, purpose: 'cache_keepalive' as const, turnId: 'warm-turn', backgroundRunId: 'warm-run' };
  assert.equal((await f.tools.execute('tool_define', { name: 'background_complete' }, warm)).output.error_code, 'TOOL_NOT_IN_ALLOWLIST');
  assert.equal((await f.tools.execute('background_complete', args, warm)).ok, false);

  const definition = await f.tools.execute('tool_define', { name: 'background_complete' }, scoped);
  assert.equal(definition.ok, true, JSON.stringify(definition.output));
  const completed = await f.tools.execute('background_complete', args, scoped);
  assert.equal(completed.ok, true, JSON.stringify(completed.output));
  const run = db.prepare("SELECT result_code FROM background_runs WHERE id='bg-run'").get() as { result_code: string };
  assert.equal(run.result_code, 'complete:done');
  assert.equal((await f.tools.execute('background_complete', args, scoped)).ok, false);
});
