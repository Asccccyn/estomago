import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import type { SdkRunRequest } from '../../apps/host/src/runtime/runner.ts';
import { runSdkHostQuery, type SdkQueryFactory, type SdkSessionAnchor } from '../../apps/host/src/runtime/sdk-host-query.ts';
import { freezeWindowTools } from '../../apps/host/src/runtime/tool-discovery.ts';
import { readTurnCompletion } from '../../apps/host/src/runtime/turn-completion.ts';
import { makeFixtureToolsResident, assembleTestTools, makeDb } from '../helpers.ts';
import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';

for (const protocol of ['direct', 'deferred'] as const) {
  test(`SDK ${protocol} completes without a provider continuation and retains its real tool tail`, async t => {
    const { db, root } = makeDb();
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const messages = new MessageService(db);
    const roomId = 'completion-room';
    const windowId = 'completion-window';
    messages.ensureConversation(roomId);
    db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE','now','now')").run(windowId, roomId);
    const started = (inputId: string) => {
      const turn = messages.submitUserMessageWithTurn({ conversationId: roomId, content: '合成输入', clientMessageId: inputId });
      db.prepare("UPDATE turns SET state='running' WHERE id=?").run(turn.turnId);
      db.prepare("UPDATE attempts SET state='running',window_id=? WHERE id=?").run(windowId, turn.attemptId);
      return turn;
    };
    const first = started('first');
    const { tools, registry } = assembleTestTools({ db, messages });
    if (protocol === 'direct') makeFixtureToolsResident(db, ['background_complete','chat_send_text']);
    const wireTools = freezeWindowTools(db, windowId, registry.currentCatalog(), protocol, registry.currentGroups());
    const sessions = new Map<string, SdkSessionAnchor>();
    const session = 'synthetic-main-session';
    const send = (name: string, args: Record<string, unknown>) => protocol === 'deferred'
      ? { name: 'tool_invoke', args: { name, arguments: args } }
      : { name, args };
    const complete = send('background_complete', { outcome: 'noop' });
    const late = send('chat_send_text', { text: '不应发出', idempotency_key: 'late-tool' });
    const calls = [complete, late].map((tool, index) => ({
      type: 'tool_use', id: `call-${index}`, name: `mcp__est__${tool.name}`, input: tool.args,
    }));
    let modelRequests = 0;
    let fakeAssertion: unknown;
    let usageEvents = 0;
    const run = (turn: typeof first, turnMessages: OrMessage[], ending: boolean) => {
      const query = ((input: any) => {
        const iterator = (async function* () {
          try {
            assert.equal(input.options.resume, ending ? undefined : session);
            if (!(yield* scriptedSdkInput(input, session, () => {}))) return;
            yield { type: 'stream_event', session_id: session,
              event: { type: 'message_start', message: { id: ending ? 'm1' : 'm2', model: 'test-model', usage: { input_tokens: 1, output_tokens: 0 } } } };
            if (ending) {
              yield { type: 'assistant', session_id: session, message: { id: 'm1', content: calls } };
              const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
              const client = new Client({ name: 'synthetic', version: '1' });
              await input.options.mcpServers.est.instance.connect(serverTransport);
              await client.connect(clientTransport);
              try {
                for (const call of calls) {
                  await input.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: call.name, tool_input: call.input, tool_use_id: call.id });
                  const result = await client.callTool({ name: call.name.replace('mcp__est__', ''), arguments: call.input });
                  assert.equal(Boolean(result.isError), call.id !== 'call-0');
                }
                const stop = await input.options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch',
                  tool_calls: calls.map(call => ({ tool_use_id: call.id, tool_name: call.name, tool_input: call.input })) });
                assert.equal(stop.continue, false);
                assert.equal(modelRequests, 1);
              } finally { await client.close(); }
            } else {
              yield { type: 'assistant', session_id: session, message: { id: 'm2', content: [{ type: 'text', text: '下一轮回复' }] } };
            }
            yield { type: 'stream_event', event: { type: 'message_stop' } };
            yield { type: 'result', subtype: 'success', session_id: session };
          } catch (error) { fakeAssertion = error; throw error; }
        })();
        return Object.assign(iterator, { close() {} });
      }) as SdkQueryFactory;
      const request: SdkRunRequest & { host: NonNullable<SdkRunRequest['host']> } = {
        prompt: '', options: { options: { systemPrompt: 'S', env: {} } } as SdkRunRequest['options'],
        resumeSessionId: null, abortController: new AbortController(),
        onEvent: event => { if (event.kind === 'usage') usageEvents++; },
        host: {
          purpose: 'chat', windowId,
          envelope: { model: 'test-model', sessionId: 'est-session', messages: turnMessages, tools: wireTools, boundaries: [], maxTokens: 64, reasoning: null },
          completionRequested: () => readTurnCompletion(db, turn.attemptId, turn.turnId) !== null,
          beforeModel: async () => { modelRequests++; },
          modelStarted: () => {},
          executeTool: (name, args, toolCallId) => tools.execute(name, args, {
            roomId, windowId, turnId: turn.turnId, attemptId: turn.attemptId, toolCallId,
            purpose: 'chat', requestId: 'synthetic-request', activeReviewId: null, seenSequence: 0, seenMessages: [],
          }),
        },
      };
      return runSdkHostQuery(query, request, sessions, async () => null, (() => ({ pid: 1 })) as never);
    };
    const submitted: OrMessage[] = [{ role: 'system', content: 'S' }, { role: 'user', content: '合成输入' }];
    const done = await run(first, submitted, true);
    assert.ifError(fakeAssertion);
    assert.equal(done.outcome, 'completed');
    assert.equal(modelRequests, 1);
    assert.equal(usageEvents, 1);
    assert.deepEqual(done.lastSentMessages, submitted);
    assert.deepEqual(done.finalMessages?.filter(m => m.role === 'tool').map(m => [m.tool_call_id, JSON.parse(m.content as string)]), [
      ['call-0', { completed: true, outcome: 'noop' }],
      ['call-1', { error_code: 'TURN_COMPLETED', executed: false }],
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_message_id='late-tool'").get()?.n, 0);
    assert.equal(sessions.get(windowId)?.messageCount, done.finalMessages?.length);
    db.prepare("UPDATE turns SET state='completed' WHERE id=?").run(first.turnId);
    db.prepare("UPDATE attempts SET state='completed' WHERE id=?").run(first.attemptId);
    const next = await run(started('next'), [...done.finalMessages!, { role: 'user', content: '下一轮输入' }], false);
    assert.ifError(fakeAssertion);
    assert.equal(modelRequests, 2);
    assert.equal(next.resumeDiagnosis?.decision, 'resume_hit');
    assert.equal(next.lastSentMessages?.filter(m => m.role === 'tool' && m.tool_call_id === 'call-0').length, 1);
  });
}
