import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { SubscriptionAccessRunner } from '../../apps/host/src/runtime/subscription-access.ts';
import { RuntimeSettingsService } from '../../apps/host/src/runtime/runtime-settings.ts';
import { storedToolset } from '../../apps/host/src/runtime/tool-discovery.ts';
import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';

test('新窗口从实际 Claude SDK MCP 发布各自的参数，以原生 text 写入中文', async t => {
  const root = tempRoot('native-mcp-direct-');
  writeApprovedIdentity(root);
  const ready = readyRuntimePatch();
  const { tool_schema_mode: _explicitFixtureMode, ...runtime } = ready.runtime as Record<string, unknown>;
  const config = buildConfig({ ...ready, runtime: { ...runtime, provider: 'claude-agent-sdk',
    model: 'claude-sonnet-4-6', subscription_proxy_url: 'http://127.0.0.1:1' }, deployment: { port: 0 } });
  assert.equal(config.runtime.tool_schema_mode, 'direct');
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  t.after(async () => { try { await host.stop(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });

  const text = '合成中文消息，保留「原样」。';
  let testError: unknown;
  let discovered: string[] = [];
  const query = ((input: any) => {
    const session = randomUUID();
    const iterator = (async function* () {
      try {
        if (!(yield* scriptedSdkInput(input, session, () => {}))) return;
        yield { type: 'stream_event', session_id: session,
          event: { type: 'message_start', message: { id: 'native-msg', model: input.options.model, usage: { input_tokens: 1, output_tokens: 0 } } } };
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'synthetic', version: '1' });
        await input.options.mcpServers.est.instance.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          const tools = (await client.listTools()).tools;
          discovered = tools.map(tool => tool.name);
          assert.ok(!discovered.includes('tool_invoke'));
          assert.equal(discovered.length, 18);
          for (const name of ['conversation_archive','image_generate']) {
            assert.equal(discovered.filter(tool => tool === name).length, 1);
          }
          assert.ok(!discovered.includes('chat_send_text'));
          assert.ok(!discovered.includes('context_review_complete'));
          const humanText = tools.find(tool => tool.name === 'memory_hold')?.inputSchema.properties?.text as { type?: string; description?: string };
          assert.equal(humanText.type, 'string');
          assert.equal(humanText.description, undefined);
          const lookup = { query: 'chat_send_text' };
          const mapName = 'mcp__est__tool_catalog';
          yield { type: 'assistant', session_id: session, message: { id: 'map-msg', content: [{ type: 'tool_use', id: 'map-id', name: mapName, input: lookup }] } };
          await input.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: mapName, tool_input: lookup, tool_use_id: 'map-id' });
          const found = await client.callTool({ name: 'tool_catalog', arguments: lookup });
          assert.equal(found.isError, false, JSON.stringify(found.content));
          await input.options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch', tool_calls: [] });
          assert.deepEqual((await client.listTools()).tools.map(t => t.name), discovered);
          assert.match(JSON.stringify(found.content), /我可以主动发一条文字消息/);
          assert.doesNotMatch(JSON.stringify(found.content), /parameters/);
          const defineName = 'mcp__est__tool_define';
          const defineArgs = { name: 'chat_send_text' };
          yield { type: 'assistant', session_id: session, message: { id: 'define-msg', content: [{ type: 'tool_use', id: 'define-id', name: defineName, input: defineArgs }] } };
          await input.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: defineName, tool_input: defineArgs, tool_use_id: 'define-id' });
          const definition = await client.callTool({ name: 'tool_define', arguments: defineArgs });
          assert.match(JSON.stringify(definition.content), /中文直接填汉字/);
          await input.options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name:'PostToolBatch',tool_calls:[] });
          const expanded = (await client.listTools()).tools;
          assert.deepEqual(expanded.map(t => t.name), [...discovered, 'chat_send_text']);
          const schema = expanded.at(-1)!.inputSchema.properties?.text as {description?: string};
          assert.equal(schema?.description, undefined);
          const args = { text, idempotency_key: 'synthetic-write' };
          const name = 'mcp__est__chat_send_text';
          const callId = 'native-call-1';
          yield { type: 'assistant', session_id: session, message: { id: 'native-msg', content: [{ type: 'tool_use', id: callId, name, input: args }] } };
          await input.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: args, tool_use_id: callId });
          const result = await client.callTool({ name: 'chat_send_text', arguments: args });
          assert.ok(Array.isArray(result.content));
          assert.equal(result.isError, false, JSON.stringify(result.content));
        } finally { await client.close(); }
        yield { type: 'assistant', session_id: session, message: { id: 'native-done', content: [{ type: 'text', text: '合成结束' }] } };
        yield { type: 'stream_event', event: { type: 'message_stop' } };
        yield { type: 'result', subtype: 'success', session_id: session };
      } catch (error) { testError = error; throw error; }
    })();
    return Object.assign(iterator, { close() {}, accountInfo: async () => ({ apiProvider: 'firstParty' }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: false } },
      }) });
  }) as any;
  assert.equal(host.runnerSelection.status, 'ok');
  if (host.runnerSelection.status === 'ok') host.runnerSelection.runner = new SubscriptionAccessRunner(config,
    new RuntimeSettingsService(host.db), async () => ({ status: 'ok', runner: new ClaudeSdkRunner(query) }));

  host.messages.ensureConversation('primary');
  const { turnId } = host.messages.submitUserMessageWithTurn({
    conversationId: 'primary', content: '合成触发', clientMessageId: 'synthetic-owner',
  });
  host.supervisor.enqueue(turnId);
  await host.supervisor.waitIdle();
  assert.equal(testError, undefined, String(testError));
  assert.equal(host.db.prepare('SELECT state FROM turns WHERE id=?').get(turnId)?.state, 'completed');
  const window = host.windows.activeWindow('primary')!;
  const snapshot = storedToolset(host.db, window.id)!;
  assert.equal(snapshot.protocol, 'direct');
  assert.deepEqual([...discovered, 'chat_send_text'], snapshot.tools.map(spec => spec.function.name));
  const requests = host.db.prepare("SELECT payload_json FROM provider_requests WHERE turn_id=? AND purpose='chat' ORDER BY rowid").all(turnId);
  assert.deepEqual(requests.map(r => JSON.parse(String(r.payload_json)).tools.length), [18, 18, 19]);
  assert.deepEqual(discovered.filter(name => !['tool_catalog', 'tool_define'].includes(name)),
    snapshot.catalog.filter(spec => snapshot.groups[spec.function.name] === 'C').map(spec => spec.function.name));
  assert.equal(host.db.prepare("SELECT count(*) AS n FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.speaker='assistant' AND r.content=?").get(text)?.n, 1);
});
