import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { subscriptionSdkOptions, THINKING_LANGUAGE_RULE } from '../../apps/host/src/runtime/build-options.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { register } from '../../apps/host/src/runtime/sdk-prompt-context/hooks/register.mjs';
import { runSdkHostQuery } from '../../apps/host/src/runtime/sdk-host-query.ts';

test('SDK isolation and resume follow the host ledger; stale session IDs cannot override it', async () => {
  const config = buildConfig({ runtime: { model: 'claude-sonnet-4-6', subscription_proxy_url: 'http://127.0.0.1:1082', thinking: { effort: 'xhigh' } } });
  const options = subscriptionSdkOptions(config, 'synthetic identity and policy', '/tmp/est-sdk-contract');
  const captured: any[] = [];
  const runner = new ClaudeSdkRunner((input: any) => {
    captured.push(input);
    return Object.assign((async function* () {
      for await (const _ of input.prompt) break;
      yield { type: 'result', subtype: 'success', session_id: 'synthetic-session' };
    })(), { close() {}, accountInfo: async () => ({ apiProvider: 'firstParty', subscriptionType: 'max', tokenSource: 'claude.ai' }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true, subscription_type: 'max', rate_limits: { extra_usage: { is_enabled: false } } }),
    }) as any;
  });
  const messages = [{ role: 'system', content: 'synthetic identity and policy' }, { role: 'user', content: 'synthetic first message' }];
  const request = (windowId: string, history: typeof messages) => ({
    prompt: '', options, resumeSessionId: 'stale-database-session', abortController: new AbortController(), onEvent() {},
    host: { windowId, envelope: { model: config.runtime.model!, sessionId: windowId, messages: history, tools: [], boundaries: [], maxTokens: 1024, reasoning: null },
      beforeModel: async () => {}, modelStarted() {}, executeTool: async () => { throw Error('unexpected tool'); }, maxModelRequests: 2 },
  });
  assert.equal((await runner.run(request('window-a', messages))).outcome, 'completed');
  await runner.run(request('window-a', [...messages, { role: 'user', content: 'second message' }]));
  await runner.run(request('window-b', messages));
  const o = captured[0].options;
  assert.deepEqual(Object.keys(captured[0]).sort(), ['options', 'prompt']);
  for (const key of ['tools', 'skills', 'settingSources']) assert.deepEqual(o[key], []);
  assert.equal(o.plugins.length, 1); assert.equal(o.plugins[0].type, 'local');
  assert.match(o.plugins[0].path, /sdk-prompt-context\/$/);
  assert.equal(o.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, '1');
  assert.equal(o.env.CLAUDE_CODE_EXTRA_BODY, undefined, 'the final system override must not strip native subscription attribution');
  assert.equal(o.systemPrompt.at(-1), THINKING_LANGUAGE_RULE);
  assert.doesNotMatch(o.systemPrompt.join('\n'), /简体中文/);
  assert.equal(o.permissionMode, 'default'); assert.equal(o.strictMcpConfig, true);
  assert.equal(o.settings.autoMemoryEnabled, false); assert.equal(o.settings.disableClaudeAiConnectors, true);
  assert.equal(o.env.DISABLE_COMPACT, '1'); assert.equal(o.effort, 'xhigh');
  assert.equal(o.resume, undefined); assert.equal(captured[1].options.resume, 'synthetic-session');
  assert.equal(captured[2].options.resume, undefined);
  assert.equal(typeof o.spawnClaudeCodeProcess, 'function');
});

test('the removed prompt-only entry cannot bypass host subscription and network admission', async () => {
  let called = false;
  const runner = new ClaudeSdkRunner((() => { called = true; throw Error(); }) as any);
  const result = await runner.run({ prompt: 'synthetic', options: subscriptionSdkOptions(buildConfig({}), 'identity', '/tmp/test'),
    resumeSessionId: null, abortController: new AbortController(), onEvent() {} });
  assert.equal(result.errorCode, 'SDK_HOST_CONTEXT_REQUIRED'); assert.equal(called, false);
});

test('cancelling during history import releases the input stream without dispatching the new prompt', async () => {
  const controller = new AbortController();
  let dispatches = 0;
  const emitted: any[] = [];
  const query = (input: any) => Object.assign((async function* () {
    const iterator = input.prompt[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value.shouldQuery, false);
    yield { ...first.value, isReplay: true, session_id: 'synthetic-cancel-import' };
    controller.abort();
    assert.equal((await iterator.next()).done, true);
  })(), { close() {}, accountInfo: async () => ({ apiProvider: 'firstParty' }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => null });
  const config = buildConfig({ runtime: { model: 'claude-opus-4-6', subscription_proxy_url: 'http://127.0.0.1:1' } });
  const result = await runSdkHostQuery(query as any, {
    prompt: '', options: subscriptionSdkOptions(config, 'SYNTHETIC_SYSTEM', '/tmp/synthetic-cancel-import'),
    resumeSessionId: null, abortController: controller, onEvent: e => emitted.push(e),
    host: { windowId: 'synthetic-window', envelope: { model: config.runtime.model!, sessionId: 'synthetic-window',
      messages: [{ role: 'user', content: 'PAST_USER' }, { role: 'assistant', content: 'PAST_ASSISTANT' }, { role: 'user', content: 'CURRENT_MUST_NOT_SEND' }],
      tools: [], boundaries: [], maxTokens: 1024, reasoning: null }, maxModelRequests: 2,
      beforeModel: async () => { dispatches++; }, modelStarted() {}, executeTool: async () => { throw Error('unexpected tool'); } },
  }, new Map());
  assert.equal(result.outcome, 'interrupted'); assert.equal(result.attempts, 0);
  assert.equal(dispatches, 0); assert.equal(emitted.length, 0);
});

test('the SDK context hook removes only the automatic account email', () => {
  const address = 'author@example.invalid';
  const project = { name: 'claudeMd', text: 'Example contact: ' + address };
  const date = { name: 'currentDate', text: '2026-11-18' };
  const input = { blocks: [project, { name: 'userEmail', text: address }, date], instructionFiles: [] };
  let projected;
  register((event, ...registration) => {
    if (event === 'prompt.context') {
      const handler = registration.at(-1);
      projected = handler(null, input, value => value);
    }
  });
  assert.deepEqual(projected, { ...input, blocks: [project, date] });
});
