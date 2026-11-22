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
  const wishstarCalls: Array<{ method: string; path: string }> = [];
  const wishstar = {
    forward: async (method: string, path: string) => {
      wishstarCalls.push({ method, path });
      return { status: 200, body: { id: 'synthetic-session', status: 'confirmed' } };
    },
  };
  const { tools, registry } = assembleTestTools({
    db, messages, mariposa, wishstar, reviews: review, checkpoint: new HoldCheckpointService(db),
  });
  const wire = freezeWindowTools(db, windowId, registry.currentCatalog(), 'direct', registry.currentGroups());
  const ctx: ToolExecContext = {
    roomId, windowId, turnId, purpose: 'chat', activeReviewId: null,
    seenSequence: message.sequence, seenMessages: [], requestId: 'native-request',
  };
  return { db, review, calls, wishstarCalls, tools, wire, ctx };
}

test('新窗直调走冻结业务 schema 和唯一写入入口，拒绝未发布的通用入口', async t => {
  const f = fixture(t);
  const holdArgs = { original_title: '标题', categories: ['daily'], text: '中文正文', creation_mode: 'contemporaneous' };
  const frozen = storedToolset(f.db, f.ctx.windowId);
  assert.ok(frozen);
  assert.equal(frozen.protocol, 'direct');
  const fullHold = frozen.catalog.find(tool => tool.function.name === 'memory_hold')!;
  const wireHold = f.wire.find(tool => tool.function.name === 'memory_hold')!;
  assert.deepEqual(wireHold.function.parameters.required, fullHold.function.parameters.required);
  assert.equal(wireHold.function.parameters.allOf, undefined);
  const details = await f.tools.execute('tool_define', {name:'memory_hold'}, f.ctx);
  assert.deepEqual(details.output.parameters, fullHold.function.parameters);
  const needsDate = await f.tools.execute('memory_hold', { ...holdArgs, creation_mode:'retrospective' }, f.ctx);
  assert.equal(needsDate.ok, false);
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

test('浏览和搜索只给用途，按名称查完整参数才在本窗启用', async t => {
  const f = fixture(t);
  const current = () => storedToolset(f.db, f.ctx.windowId)!.tools.map(tool => tool.function.name);
  const initial = current();
  const snapshot = storedToolset(f.db, f.ctx.windowId)!;
  assert.deepEqual(initial, ['tool_catalog','tool_define',
    ...snapshot.catalog.filter(tool => snapshot.groups[tool.function.name] === 'C').map(tool => tool.function.name)]);
  const lookup = (query: string) => f.tools.execute('tool_catalog', {query}, f.ctx);
  assert.equal((await f.tools.execute('tool_catalog', {}, f.ctx)).ok, true);
  assert.equal((await lookup('一把不在目录的合成工具')).output.state, 'no_match');
  const ambiguous = await lookup('plans_read chat_send_text');
  for (const item of ambiguous.output.tools as Array<Record<string,unknown>>) {
    assert.deepEqual(Object.keys(item), ['name','description']);
  }
  const exact = await lookup('chat_send_text');
  assert.deepEqual(exact.output.tools, [{name:'chat_send_text',description:snapshot.summaries!.chat_send_text}]);
  assert.deepEqual(current(), initial);
  assert.equal((await f.tools.execute('chat_send_text', {text:'尚未查参数'}, f.ctx)).output.error_code, 'TOOL_NOT_IN_WINDOW');
  const defined = await f.tools.execute('tool_define', {name:'chat_send_text'}, f.ctx);
  assert.equal(defined.activatedTool?.function.name, 'chat_send_text');
  assert.deepEqual(defined.output.parameters, snapshot.catalog.find(t => t.function.name === 'chat_send_text')!.function.parameters);
  const repeated = await f.tools.execute('tool_define', {name:'chat_send_text'}, f.ctx);
  assert.equal(repeated.activatedTool, undefined);
  assert.deepEqual(current(), [...initial,'chat_send_text']);
  const otherWindow = 'other-map-window';
  f.db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE','now','now')").run(otherWindow,f.ctx.roomId);
  const registry = f.tools.getCapabilityRegistry()!;
  const nextWindow = freezeWindowTools(f.db, otherWindow, registry.currentCatalog(), 'direct', registry.currentGroups());
  assert.deepEqual(nextWindow.map(tool => tool.function.name), initial);
});

test('旧按需窗口保留精确搜索直接启用的协议',async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE window_toolsets SET tool_summaries_json=NULL WHERE window_id=?').run(f.ctx.windowId);
  const found = await f.tools.execute('tool_catalog',{query:'chat_send_text'},f.ctx);
  assert.equal(found.output.state,'ready');
  assert.equal(found.activatedTool?.function.name,'chat_send_text');
  assert.match(JSON.stringify(found.activatedTool?.function.parameters),/中文直接填汉字/);
});

test('新窗可按当前目录展示的原用途回查，并由 define 单独启用', async t => {
  const f = fixture(t);
  const { tools, ctx, db } = f;
  const snapshot = storedToolset(db, ctx.windowId)!;
  const name = 'wishstar_confirm_session';
  // The opened window can carry wording from an earlier release.
  const summaries = { ...snapshot.summaries, plans_read: '我可以打开这扇窗保存的计划目录' };
  db.prepare('UPDATE window_toolsets SET tool_summaries_json = ? WHERE window_id = ?')
    .run(JSON.stringify(summaries), ctx.windowId);
  const frozen = storedToolset(db, ctx.windowId)!;
  const listing = await tools.execute('tool_catalog', {}, ctx);
  assert.equal(listing.ok, true);
  const entries = listing.output.tools as Array<{ name: string; description: string }>;
  for (const toolName of ['memory_hold', 'conversation_read', name, 'plans_read']) {
    const item = entries.find(entry => entry.name === toolName)!;
    assert.ok(item, toolName);
    const match = await tools.execute('tool_catalog', { query: item.description }, ctx);
    assert.deepEqual(match.output.tools, [item], item.description);
    assert.equal(match.activatedTool, undefined);
  }
  const hidden = await tools.execute('tool_catalog', { query: frozen.summaries!.context_review_complete }, ctx);
  assert.equal(hidden.output.state, 'no_match');
  assert.deepEqual(storedToolset(db, ctx.windowId), frozen);
  assert.deepEqual(f.wishstarCalls, []);

  const args = { session_id: 'synthetic-session' };
  assert.equal((await tools.execute(name, args, ctx)).output.error_code, 'TOOL_NOT_IN_WINDOW');
  const defined = await tools.execute('tool_define', { name }, ctx);
  assert.equal(defined.activatedTool?.function.name, name);
  assert.equal((await tools.execute(name, args, ctx)).ok, true);
  assert.deepEqual(f.wishstarCalls, [{ method: 'POST', path: '/api/sessions/synthetic-session/confirm' }]);
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

test('原生完成只接收当前真实回合，结束后按回合重传同一回执', async t => {
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
  db.prepare("INSERT INTO attempts(id,turn_id,attempt_no,state,window_id) VALUES ('bg-attempt','bg-turn',1,'running',?)").run(ctx.windowId);
  const scoped: ToolExecContext = { ...ctx, backgroundRunId: 'bg-run', turnId: 'bg-turn', attemptId: 'bg-attempt',
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
  db.prepare("INSERT INTO attempts(id,turn_id,attempt_no,state,window_id) VALUES ('warm-attempt','warm-turn',1,'running',?)").run(ctx.windowId);
  const warm = { ...scoped, purpose: 'cache_keepalive' as const, turnId: 'warm-turn', backgroundRunId: 'warm-run', attemptId: 'warm-attempt' };
  assert.equal((await f.tools.execute('tool_define', { name: 'background_complete' }, warm)).ok, true);
  assert.equal((await f.tools.execute('background_complete', args, warm)).ok, true);

  const definition = await f.tools.execute('tool_define', { name: 'background_complete' }, scoped);
  assert.equal(definition.ok, true, JSON.stringify(definition.output));
  const completed = await f.tools.execute('background_complete', args, scoped);
  assert.equal(completed.ok, true, JSON.stringify(completed.output));
  db.prepare("UPDATE background_runs SET state='completed' WHERE id='bg-run'").run();
  db.prepare("UPDATE attempts SET state='completed' WHERE id='bg-attempt'").run();
  db.prepare("UPDATE turns SET state='completed' WHERE id='bg-turn'").run();
  const closed = { ...scoped, toolCallId: 'new-wire-id', beforeBackgroundTool: () => assert.fail('replay must not reserve') };
  assert.deepEqual(await f.tools.execute('background_complete', args, closed), completed);
  assert.equal((await f.tools.execute('background_complete', { outcome: 'noop' }, closed)).output.error_code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.tools.execute('tool_catalog', {}, closed)).output.error_code, 'TURN_COMPLETED');
});
