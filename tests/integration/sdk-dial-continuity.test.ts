import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { freezeWindowTools, storedToolset } from '../../apps/host/src/runtime/tool-discovery.ts';
import { CALL_CONTROL_DEFINITION, CHAT_SEND_VOICE_DEFINITION, TRANSCRIPT_READ_DEFINITION } from '../../apps/host/src/modules/voice/module.ts';
import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch, fullToolCatalog } from '../helpers.ts';

// The live window predates voice registration. Exercise that supported old-window
// state and the owner's scoped catalog repair through real HTTP, MCP and handlers.
test('SDK dial in an old deferred window can accept after voice tools are explicitly enabled without rotating history', async () => {
  const root = tempRoot('sdk-dial-continuity-');
  const oldHome = process.env.ESTOMAGO_HOME;
  const credentialName = 'ESTOMAGO_TEST_SIREN_TOKEN';
  const oldCredential = process.env[credentialName];
  process.env.ESTOMAGO_HOME = root;
  process.env[credentialName] = 'synthetic-siren-credential';
  writeApprovedIdentity(root);
  let creates = 0;
  const siren = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/calls') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      assert.deepEqual(JSON.parse(raw), { conversation_id: 'primary' });
      assert.equal(req.headers.authorization, 'Bearer synthetic-siren-credential');
      creates++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ call_id: 'synthetic-call', ws_url: 'ws://127.0.0.1:1/synthetic', token: 'synthetic-call-token' }));
    } else { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); }
  });
  await new Promise<void>(resolve => siren.listen(0, '127.0.0.1', resolve));
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime,
    provider: 'claude-agent-sdk', model: 'claude-opus-4-6', tool_schema_mode: 'deferred', subscription_proxy_url: 'http://127.0.0.1:1' },
    integrations: { siren: { base_url: `http://127.0.0.1:${(siren.address() as any).port}`, credential_ref: credentialName, contract_version: '1.1.1' } }, deployment: { port: 0 } });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  let mode: 'seed' | 'missing' | 'enabled' = 'seed';
  const toolResults: Array<{ mode: string; name: string; value: any }> = [];
  const query = (input: any) => {
    const session = input.options.resume ?? randomUUID();
    const iterator = (async function* () {
      if (!(yield* scriptedSdkInput(input, session, () => {}))) return;
      if (mode !== 'seed') {
        const client = new Client({ name: 'synthetic-sdk', version: '1' });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await input.options.mcpServers.est.instance.connect(b); await client.connect(a);
        const tool = async function* (name: string, args: Record<string, unknown>): AsyncGenerator<any, any> {
          const id = randomUUID(); const sdkName = `mcp__est__${name}`;
          yield { type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, model: input.options.model } } };
          yield { type: 'assistant', session_id: session, message: { id, content: [{ type: 'tool_use', id, name: sdkName, input: args }] } };
          await input.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: sdkName, tool_input: args, tool_use_id: id });
          const permission = await input.options.canUseTool(sdkName, args, { mcpServer: { source: 'sdk', name: 'est' } });
          assert.equal(permission.behavior, 'allow');
          const result: any = await client.callTool({ name, arguments: args });
          const value = JSON.parse(result.content[0].text);
          toolResults.push({ mode, name, value });
          await input.options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch' });
          return value;
        };
        try {
          const definition = yield* tool('tool_define', { name: 'call_control' });
          if (mode === 'missing') assert.equal(definition.error_code, 'TOOL_NOT_IN_ALLOWLIST');
          else {
            assert.equal(definition.name, 'call_control');
            const result = yield* tool('tool_invoke', { name: 'call_control', definition_id: definition.definition_id, arguments: { action: 'accept_call' } });
            assert.equal(result.state, 'accepted');
          }
        } finally { await client.close(); }
      }
      const id = randomUUID();
      yield { type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, model: input.options.model } } };
      yield { type: 'assistant', session_id: session, message: { id, content: [{ type: 'text', text: 'SYNTHETIC_REPLY' }] } };
      yield { type: 'result', subtype: 'success', session_id: session };
    })();
    return Object.assign(iterator, { close() {}, accountInfo: async () => ({ apiProvider: 'firstParty' }), usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => null });
  };
  try {
    assert.equal(host.runnerSelection.status, 'ok');
    if (host.runnerSelection.status === 'ok') host.runnerSelection.runner = new ClaudeSdkRunner(query as any);
    const window = host.windows.createWindow({ conversationId: 'primary', gate: host.identity.evaluateGate(host.db) }).window!;
    const voice = [CALL_CONTROL_DEFINITION, CHAT_SEND_VOICE_DEFINITION, TRANSCRIPT_READ_DEFINITION];
    freezeWindowTools(host.db, window.id, fullToolCatalog().filter(t => !voice.some(v => v.function.name === t.function.name)), 'deferred');
    await host.start(); const base = `http://127.0.0.1:${host.port}`;
    const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const seed = await fetch(base + '/api/v1/conversations/primary/messages', { method: 'POST', headers, body: JSON.stringify({ content: 'SYNTHETIC_PRIOR_HISTORY', client_message_id: randomUUID() }) });
    assert.equal(seed.status, 201); await host.supervisor.waitIdle();
    const dial = async () => {
      const r = await fetch(base + '/api/v1/calls/dial', { method: 'POST', headers, body: '{}' });
      assert.equal(r.status, 200); const d: any = await r.json(); await host.supervisor.waitIdle(); return d;
    };
    mode = 'missing'; const first = await dial();
    assert.equal(creates, 0);
    assert.equal(host.db.prepare('SELECT state FROM dial_requests WHERE id=?').get(first.request_id)?.state, 'pending');
    await fetch(base + '/api/v1/calls/dial/' + first.request_id, { method: 'DELETE', headers });
    const set = storedToolset(host.db, window.id)!;
    const history = host.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id=?').get(window.id)!.messages_json;
    host.db.prepare('UPDATE window_toolsets SET catalog_json=? WHERE window_id=?').run(JSON.stringify([...set.catalog, ...voice]), window.id);
    assert.equal(host.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id=?').get(window.id)!.messages_json, history);
    assert.deepEqual(storedToolset(host.db, window.id)!.tools, set.tools);
    mode = 'enabled'; const second = await dial();
    assert.equal(creates, 1);
    assert.equal(host.db.prepare('SELECT state FROM dial_requests WHERE id=?').get(second.request_id)?.state, 'accepted');
    assert.equal(host.db.prepare('SELECT state FROM voice_calls WHERE call_id=?').get('synthetic-call')?.state, 'active');
    assert.equal(host.windows.activeWindow('primary')!.id, window.id);
    assert.equal(host.db.prepare('SELECT count(*) n FROM context_selections').get()?.n, 0);
    assert.equal(host.db.prepare("SELECT count(*) n FROM messages WHERE speaker='owner'").get()?.n, 1);
    assert.equal(toolResults.filter(r => r.name === 'tool_invoke').length, 1);
    await fetch(base + '/api/v1/calls/synthetic-call', { method: 'DELETE', headers });
  } finally {
    await host.stop(); await new Promise<void>(resolve => siren.close(() => resolve()));
    if (oldHome === undefined) delete process.env.ESTOMAGO_HOME; else process.env.ESTOMAGO_HOME = oldHome;
    if (oldCredential === undefined) delete process.env[credentialName]; else process.env[credentialName] = oldCredential;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
