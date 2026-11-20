import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import type { ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { freezeWindowTools, storedToolset } from '../../apps/host/src/runtime/tool-discovery.ts';
import { assembleTestTools, makeDb, tempRoot } from '../helpers.ts';

test('D08：后台任务仅在宿主当前运行范围发现，完成后收回定义', async t => {
  const { db, root } = makeDb(tempRoot('tool-task-discovery-'), { seed: false });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const roomId = 'task-room';
  const windowId = 'task-win';
  const turnId = 'bg-turn';
  const runId = 'bg-run';
  const messages = new MessageService(db);
  messages.ensureConversation(roomId);
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE','now','now')").run(windowId, roomId);
  db.prepare("INSERT INTO turns(id,conversation_id,trigger,state,created_at) VALUES (?,?,'proactive_turn','running','now')").run(turnId, roomId);
  db.prepare(`
    INSERT INTO background_tasks(id,conversation_id,actor_id,kind,schedule_kind,created_by_actor_id,created_at,updated_at)
    VALUES ('bg-task',?,'jiaming','autonomous','once','jiaming','now','now')
  `).run(roomId);
  db.prepare(`
    INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,window_id,turn_id,created_at,updated_at)
    VALUES (?,'bg-task',?,'jiaming','autonomous',1,'occurrence','running',?,?,'now','now')
  `).run(runId, roomId, windowId, turnId);
  const { tools, registry } = assembleTestTools({ db, messages });
  freezeWindowTools(db, windowId, registry.currentCatalog(), 'deferred', registry.currentGroups());
  const frozen = storedToolset(db, windowId);
  const context: ToolExecContext = {
    roomId, windowId, turnId, backgroundRunId: runId, purpose: 'proactive_turn', activeReviewId: null,
    seenSequence: 0, seenMessages: [], requestId: 'bg-request', beforeBackgroundTool: () => {},
  };

  const definition = await tools.execute('tool_define', { name: 'background_complete' }, context);
  assert.equal(definition.ok, true);
  assert.ok(definition.output.parameters);
  const catalog = await tools.execute('tool_catalog', {}, context);
  assert.ok((catalog.output.tools as Array<{ name: string }>).some(item => item.name === 'background_complete'));
  assert.ok(!(catalog.output.tools as Array<{ name: string }>).some(item => item.name === 'context_review_complete'));

  const noScope = { ...context, backgroundRunId: null };
  const undiscovered = await tools.execute('tool_catalog', { query: 'background_complete' }, noScope);
  assert.equal(undiscovered.output.state, 'no_match');
  const otherTurn = await tools.execute('tool_define', { name: 'background_complete' }, { ...context, turnId: 'other-turn' });
  assert.equal(otherTurn.output.error_code, 'TOOL_NOT_IN_ALLOWLIST');

  const completion = { name: 'background_complete', arguments: { outcome: 'done' } };
  const outside = await tools.execute('tool_invoke', completion, { ...noScope, purpose: 'chat' });
  assert.equal(outside.output.error_code, 'TOOL_PURPOSE_INVALID');
  assert.equal((await tools.execute('tool_invoke', completion, context)).ok, true);
  assert.equal((await tools.execute('tool_define', { name: 'background_complete' }, context)).output.error_code, 'TOOL_NOT_IN_ALLOWLIST');
  assert.deepEqual(storedToolset(db, windowId), frozen);
});
