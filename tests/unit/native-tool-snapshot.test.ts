import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { buildDeferredTools, buildDirectTools, definitionWasSeen, freezeWindowTools, storedToolset, taskDefinitionContext, toolsetForTask } from '../../apps/host/src/runtime/tool-discovery.ts';
import { createEstSdkMcp } from '../../apps/host/src/runtime/sdk-mcp.ts';
import { assembleTestTools, buildFullTestRegistry, makeDb } from '../helpers.ts';

test('new native tool snapshots publish ordinary definitions and attach only the requested task definition', t => {
  const { db, root } = makeDb();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = new MessageService(db);
  messages.ensureConversation('native-fixture');
  const createWindow = db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES (?,'native-fixture','ACTIVE','now','now')");
  createWindow.run('native-window');
  createWindow.run('deferred-window');
  createWindow.run('legacy-window');
  createWindow.run('before-groups');
  createWindow.run('custom-native-window');
  const { registry } = assembleTestTools({ db });
  const catalog = registry.currentCatalog();
  const groups = registry.currentGroups();
  const names = (tools: typeof catalog) => tools.map(tool => tool.function.name);
  const readRow = (id: string) => db.prepare('SELECT * FROM window_toolsets WHERE window_id=?').get(id);

  const oldWire = freezeWindowTools(db, 'deferred-window', catalog, 'deferred', groups);
  const legacyWire = freezeWindowTools(db, 'legacy-window', catalog, 'legacy', groups);
  createWindow.run('old-direct');
  const historical = [...buildDeferredTools().slice(0,2), ...catalog.filter(tool => groups[tool.function.name] !== 'T')];
  freezeWindowTools(db,'old-direct',catalog,'direct',groups);
  db.prepare("UPDATE window_toolsets SET activated_tools_json=NULL,wire_tools_json=? WHERE window_id='old-direct'").run(JSON.stringify(historical));
  assert.deepEqual(freezeWindowTools(db,'old-direct',[],'direct'),historical);
  const oldRow = readRow('deferred-window');
  const legacyRow = readRow('legacy-window');
  const mode = buildConfig().runtime.tool_schema_mode;
  assert.equal(mode, 'direct');
  const wire = freezeWindowTools(db, 'native-window', catalog, mode, groups);
  const set = storedToolset(db, 'native-window')!;
  assert.equal(set.protocol, 'direct');
  assert.equal(readRow('native-window')?.protocol, 'deferred');
  assert.deepEqual(wire, buildDirectTools(catalog, set.groups));
  assert.deepEqual(names(wire), ['tool_catalog', 'tool_define', ...names(catalog).filter(name => set.groups[name] === 'C')]);
  assert.ok(set.initialText?.includes('我可以把一件事记进记忆库 → memory_hold'));
  assert.ok(!set.initialText?.includes('tool_invoke'));
  assert.match(set.initialText ?? '', /tool_catalog/);

  const directHold = set.catalog.find(tool => tool.function.name === 'memory_hold')!;
  const deferredHold = storedToolset(db, 'deferred-window')!.catalog.find(tool => tool.function.name === 'memory_hold')!;
  assert.match(JSON.stringify(directHold.function.parameters), /中文直接填汉字/);
  assert.doesNotMatch(JSON.stringify(deferredHold.function.parameters), /中文直接填汉字/);
  const compactHold = wire.find(tool => tool.function.name === 'memory_hold')!;
  assert.deepEqual(compactHold.function.parameters.required, directHold.function.parameters.required);
  assert.ok(directHold.function.parameters.allOf);
  assert.doesNotMatch(JSON.stringify(compactHold.function.parameters), /description|maxLength|minLength|pattern|allOf/);
  assert.deepEqual(freezeWindowTools(db, 'native-window', [], 'legacy'), wire);
  assert.deepEqual(freezeWindowTools(db, 'deferred-window', [], 'direct'), oldWire);
  assert.deepEqual(freezeWindowTools(db, 'legacy-window', [], 'direct'), legacyWire);
  assert.deepEqual(oldWire, buildDeferredTools());
  assert.deepEqual(readRow('deferred-window'), oldRow);
  assert.deepEqual(readRow('legacy-window'), legacyRow);

  const beforeGroups = freezeWindowTools(db, 'before-groups', catalog, 'deferred', groups);
  db.prepare("UPDATE window_toolsets SET groups_json=NULL,initial_text=NULL WHERE window_id='before-groups'").run();
  const rowBeforeUpgrade = readRow('before-groups')!;
  assert.deepEqual(freezeWindowTools(db, 'before-groups', catalog, 'direct'), beforeGroups);
  const rowAfterUpgrade = readRow('before-groups')!;
  assert.ok(rowAfterUpgrade.groups_json);
  assert.deepEqual({ ...rowAfterUpgrade, groups_json: null }, { ...rowBeforeUpgrade });

  const task = set.catalog.find(tool => tool.function.name === 'context_review_complete')!;
  assert.ok(!names(set.tools).includes('background_complete'));
  assert.ok(!names(set.tools).includes('context_review_complete'));
  assert.deepEqual(toolsetForTask(set, task.function.name), [...set.tools, task]);
  assert.deepEqual(toolsetForTask(set, 'memory_hold'), set.tools);
  assert.match(taskDefinitionContext(set, task.function.name, 'active-run-1') ?? '', /直接调用 context_review_complete/);

  const turn = messages.submitUserMessageWithTurn({ conversationId: 'native-fixture', content: '测试普通与任务工具', clientMessageId: 'native-fixture-turn' });
  const saveRequest = db.prepare(`INSERT INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,sent_at,created_at)
    VALUES (?,'native-window',?,?,'chat','[]',?,?,'now')`);
  saveRequest.run('ordinary', turn.attemptId, turn.turnId, JSON.stringify({ tools: wire, messages: [] }), 'now');
  saveRequest.run('scoped', turn.attemptId, turn.turnId, JSON.stringify({ tools: toolsetForTask(set, task.function.name), messages: [] }), 'now');
  saveRequest.run('unsent', turn.attemptId, turn.turnId, JSON.stringify({ tools: toolsetForTask(set, task.function.name), messages: [] }), null);
  const seen = (requestId: string) => definitionWasSeen(db, { roomId: 'native-fixture', windowId: 'native-window', requestId }, task);
  assert.equal(seen('ordinary'), false);
  assert.equal(seen('scoped'), true);
  assert.equal(seen('unsent'), false);

  db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES ('tools_initial_visible',?,'now')")
    .run(JSON.stringify(['plans_read']));
  freezeWindowTools(db, 'custom-native-window', catalog, 'direct', groups);
  const customText = storedToolset(db, 'custom-native-window')!.initialText ?? '';
  const residentPart = customText.split('这些事也可以做。')[0]!;
  assert.ok(residentPart.includes('→ plans_read'));
  assert.ok(!residentPart.includes('→ memory_hold'));
});

test('missing or ambiguous physical-deferred snapshots never turn into executable direct windows', t => {
  const { db, root } = makeDb();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = new MessageService(db);
  messages.ensureConversation('native-fixture');
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('broken','native-fixture','ACTIVE','now','now')").run();
  const { registry } = assembleTestTools({ db });
  const catalog = registry.currentCatalog();
  const groups = registry.currentGroups();
  freezeWindowTools(db, 'broken', catalog, 'deferred', groups);
  const overwriteWire = db.prepare("UPDATE window_toolsets SET wire_tools_json=? WHERE window_id='broken'");
  for (const invalid of [[], buildDeferredTools().filter(tool => tool.function.name !== 'tool_invoke')]) {
    overwriteWire.run(JSON.stringify(invalid));
    assert.throws(() => freezeWindowTools(db, 'broken', catalog, 'direct', groups), /WINDOW_TOOL_SNAPSHOT_UNAVAILABLE/);
  }

  db.prepare("DELETE FROM window_toolsets WHERE window_id='broken'").run();
  const turn = messages.submitUserMessageWithTurn({ conversationId: 'native-fixture', content: '测试丢失冻结快照', clientMessageId: 'missing-native-snapshot' });
  db.prepare(`INSERT INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,sent_at,created_at)
    VALUES ('sent','broken',?,?,'chat','[]',?,'now','now')`)
    .run(turn.attemptId, turn.turnId, JSON.stringify({ tools: buildDirectTools(catalog, groups), messages: [] }));
  assert.throws(() => freezeWindowTools(db, 'broken', catalog, 'direct', groups), /WINDOW_TOOL_SNAPSHOT_UNAVAILABLE/);
});

test('SDK lists all direct tools with typed parameters and keeps the full host validation schema', async () => {
  const registry = buildFullTestRegistry();
  const direct = buildDirectTools(registry.currentCatalog(), {memory_hold:'C',chat_send_voice:'C'});
  const hold = direct.find(tool => tool.function.name === 'memory_hold')!;
  const voice = direct.find(tool => tool.function.name === 'chat_send_voice')!;
  assert.ok(!hold.function.parameters.allOf);
  assert.doesNotMatch(JSON.stringify(voice.function.parameters), /description|maxLength/);

  const input = { original_title: '合成记录', categories: ['daily'], text: '合成正文', creation_mode: 'contemporaneous' };
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const mcp = createEstSdkMcp(direct, async (name, args) => {
    executed.push({ name, args });
    return { ok: true, output: {} };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synthetic', version: '1' });
  try {
    await mcp.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), direct.map(tool => tool.function.name));
    assert.ok(tools.every(({ inputSchema }) =>
      !['allOf', 'anyOf', 'oneOf'].some(keyword => Object.hasOwn(inputSchema, keyword))));
    const sdkHold = tools.find(tool => tool.name === 'memory_hold')!;
    assert.deepEqual(sdkHold.inputSchema.properties, hold.function.parameters.properties);
    assert.deepEqual(sdkHold.inputSchema.required, hold.function.parameters.required);
    assert.ok(registry.currentCatalog().find(tool => tool.function.name === 'memory_hold')?.function.parameters.allOf, 'full validation stays in the registry');
    assert.equal((await client.callTool({ name: 'memory_hold', arguments: input })).isError, false);
    assert.deepEqual(executed, [{ name: 'memory_hold', args: input }]);
  } finally {
    await client.close();
  }
});
