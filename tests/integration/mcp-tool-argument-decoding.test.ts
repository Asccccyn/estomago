import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { createEstSdkMcp } from '../../apps/host/src/runtime/sdk-mcp.ts';
import { freezeWindowTools } from '../../apps/host/src/runtime/tool-discovery.ts';
import { assembleTestTools, makeDb } from '../helpers.ts';

test('MCP 恢复完整的参数对象，正文仅按 JSON 解码且破损正文不提交', async t => {
  const { db, root } = makeDb();
  const messages = new MessageService(db);
  const roomId = 'argument-room';
  const windowId = 'argument-window';
  messages.ensureConversation(roomId);
  const submitted = messages.submitUserMessageWithTurn({ conversationId: roomId, content: '合成消息', clientMessageId: 'owner-1' });
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES(?,?,'ACTIVE','now','now')").run(windowId, roomId);

  const heldTexts: unknown[] = [];
  const recalledQueries: unknown[] = [];
  const mariposa = new MariposaClient({ transport: async (capability, payload) => {
    if (capability === 'memory.hold') {
      heldTexts.push(payload.text);
      return { ok: true, result: { operation_id: payload.operation_id, memory_id: 'synthetic-memory', version: 1,
        binding_ids: [], committed_at: '2026-11-20T00:00:00Z' } };
    }
    assert.equal(capability, 'memory.recall.start');
    recalledQueries.push((payload.query_plan as Record<string, unknown>).original_request);
    return { ok: true, result: { recall_session_id: 'synthetic-recall', search_status: 'NO_MATCH',
      judge_mode: 'on', candidates: [] } };
  } });
  const { tools, registry } = assembleTestTools({ db, messages, mariposa,
    reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const specs = freezeWindowTools(db, windowId, registry.currentCatalog(), 'deferred', registry.currentGroups());
  const ctx: ToolExecContext = { roomId, windowId, turnId: submitted.turnId, requestId: 'synthetic-request',
    purpose: 'chat', seenMessages: [], seenSequence: 0, activeReviewId: null };
  let callNo = 0;
  const mcp = createEstSdkMcp(specs, (name, args) =>
    tools.execute(name, args, { ...ctx, toolCallId: String(++callNo) }));
  const [sdkTransport, mcpTransport] = InMemoryTransport.createLinkedPair();
  const sdk = new Client({ name: 'synthetic', version: '1' });
  t.after(async () => {
    try { await sdk.close(); }
    finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  await mcp.instance.connect(mcpTransport);
  await sdk.connect(sdkTransport);

  const call = async (name: string, args: string) => {
    const result = await sdk.callTool({ name: 'tool_invoke', arguments: { name, arguments: args } });
    assert.ok(Array.isArray(result.content));
    const block = result.content[0];
    assert.equal(block?.type, 'text');
    return { isError: result.isError, output: JSON.parse(block.text) };
  };
  const serializedHold = '{"original_title":"合成","categories":["daily"],"creation_mode":"contemporaneous","text":"\\u4e2d\\ud83d\\ude00 /u4e2d \\\\u4e2d \\"原话\\""}';
  const hold = await call('memory_hold', serializedHold);
  assert.equal(hold.isError, false, JSON.stringify(hold.output));
  assert.equal(hold.output.saved, true);
  assert.deepEqual(heldTexts, ['中😀 /u4e2d \\u4e2d "原话"']);

  const bad = await call('memory_hold', serializedHold.replace('\\"原话\\"', '"原话"'));
  assert.equal(bad.isError, true);
  assert.equal(bad.output.error_code, 'TOOL_ARG_TYPE');
  assert.equal(bad.output.field, 'arguments');
  assert.equal(heldTexts.length, 1);

  const serializedRecall = '{"query":"\\u4e2d </invoke>"}';
  const recalled = await call('memory_recall', serializedRecall + ' </invoke>');
  assert.equal(recalled.isError, false, JSON.stringify(recalled.output));
  assert.deepEqual(recalledQueries, ['中 </invoke>']);
  assert.equal((await call('memory_recall', serializedRecall + ' trailing text')).output.error_code, 'TOOL_ARG_TYPE');
  assert.equal(recalledQueries.length, 1);
});
