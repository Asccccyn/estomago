import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { makeDb, makePaths, readyRuntimePatch, writeApprovedIdentity, assembleTestTools } from '../helpers.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { RuntimeSettingsService } from '../../apps/host/src/runtime/runtime-settings.ts';
import { SubscriptionAccessRunner } from '../../apps/host/src/runtime/subscription-access.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { subscriptionAdmission } from '../../apps/host/src/runtime/sdk-subscription.ts';
import { subscriptionSdkOptions } from '../../apps/host/src/runtime/build-options.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundTaskService } from '../../apps/host/src/runtime/background-task-service.ts';

const account = { apiProvider: 'firstParty', subscriptionType: 'Claude Max' } as const;
const usage = { subscription_type: 'max', rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: false } } } as any;

// Only the two external model transports are simulated. The host queue, input
// ledger, tool registry, fallback decision and final publication are production code.
function fixture(t: any, scripted: (round: number, input: any) => any[] | AsyncIterable<any>) {
  const { db, root } = makeDb(); writeApprovedIdentity(root);
  const paths = makePaths(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime,
    provider: 'openrouter', access_policy: 'subscription-first', model: 'claude-sonnet-4-6',
    subscription_proxy_url: 'http://127.0.0.1:1082' }, openrouter: { model: 'anthropic/claude-sonnet-4.6' } });
  const messages = new MessageService(db); messages.ensureConversation('synthetic');
  const events = new EventService(db); const identity = new IdentityService(config, paths);
  const windows = new WindowManager(db, events, identity, config);
  const trajectory = new WindowTrajectoryService(db);
  const settings = new RuntimeSettingsService(db);
  const calls = { sdk: [] as any[], or: [] as any[], orFactories: 0 };
  let clock = 1_800_000_000_000;
  const sdk = new ClaudeSdkRunner(((input: any) => {
    calls.sdk.push(input);
    const round = calls.sdk.length;
    const iterator = (async function* () {
      for await (const _ of input.prompt) break;
      for await (const event of scripted(round, input)) {
        if (event instanceof Error) throw event;
        yield event;
      }
    })();
    return Object.assign(iterator, { close() {}, accountInfo: async () => account,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => usage });
  }) as any);
  const runner = new SubscriptionAccessRunner(config, settings, async cfg => {
    if (cfg.runtime.provider === 'claude-agent-sdk') return { status: 'ok', runner: sdk };
    calls.orFactories++;
    return { status: 'ok', runner: new OpenRouterRunner({ providerOnly: [], allowFallbacks: false, requireParameters: true, retryMax: 0 }, async payload => {
      calls.or.push(payload);
      const frames = [{ id: 'or-synthetic', choices: [{ delta: { content: 'OR 合成回复' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 3 } }];
      return { status: 200, headers: new Headers(), body: Readable.from(frames.map(f => Buffer.from(`data: ${JSON.stringify(f)}\n\n`)).concat([Buffer.from('data: [DONE]\n\n')])) };
    }) };
  }, () => clock);
  const backgroundSettings = new BackgroundSettingsService(db, config);
  const taskService = new BackgroundTaskService(db, backgroundSettings);
  const { tools, registry } = assembleTestTools({ db, messages, taskService, events });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, windows, trajectory, settings, tools, toolCatalog: registry,
    runnerSelection: { status: 'ok', runner }, capabilities: new CapabilityMatrix(config), reasoning: new ReasoningService(db, events),
    routing: new RoutingService(db, events, messages), usage: new UsageCollector(db), logger: new Logger(null) });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, config, calls, runner, settings, windows, trajectory, backgroundSettings, setNow: (n: number) => { clock = n; },
    send: async (text: string) => {
      const input = messages.submitUserMessageWithTurn({ conversationId: 'synthetic', content: text, clientMessageId: randomUUID() });
      supervisor.enqueue(input.turnId); await supervisor.waitIdle();
      return db.prepare('SELECT state FROM turns WHERE id=?').get(input.turnId) as { state: string };
    } };
}

const limit = (status = 'rejected', rateLimitType = 'five_hour') => ({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType, resetsAt: 1_800_000_100 }, uuid: randomUUID(), session_id: randomUUID() });
const textEvents = () => [
  { type: 'stream_event', session_id: randomUUID(), event: { type: 'message_start', message: { id: 'native-message', model: 'claude-sonnet-4-6' } } },
  { type: 'assistant', message: { id: 'native-message', content: [{ type: 'text', text: 'SDK 合成回复' }] } },
];

test('only a rejected subscription bucket can start OR; next safe round after reset rebuilds from current est history', async t => {
  const f = fixture(t, round => round === 1 ? [limit()] : [...textEvents(), { type: 'result', subtype: 'success', session_id: randomUUID() }]);
  assert.equal((await f.send('第一条合成消息')).state, 'completed');
  assert.equal(f.calls.sdk.length, 1); assert.equal(f.calls.or.length, 1);
  assert.equal(f.calls.orFactories, 1);
  assert.equal((await f.send('额度未重置时的下一条')).state, 'completed');
  assert.equal(f.calls.sdk.length, 1); assert.equal(f.calls.or.length, 2);
  f.setNow(1_800_000_101_000);
  assert.equal((await f.send('重置后的下一条')).state, 'completed');
  assert.equal(f.calls.sdk.length, 2); assert.equal(f.calls.sdk[1].options.resume, undefined);
  const window = f.windows.activeWindow('synthetic')!;
  const history = JSON.stringify(f.trajectory.forWindow(window.id)!.messages);
  assert.ok(history.includes('第一条合成消息') && history.includes('额度未重置时的下一条') && history.includes('OR 合成回复'));
});

test('partial SDK output is retained; subscription rejection never replays that turn through OR', async t => {
  const f = fixture(t, () => [...textEvents(), limit()]);
  assert.equal((await f.send('部分回复场景')).state, 'failed');
  assert.equal(f.calls.or.length, 0); assert.equal(f.calls.orFactories, 0);
  const transcript = f.trajectory.forWindow(f.windows.activeWindow('synthetic')!.id)!.messages;
  assert.ok(JSON.stringify(transcript).includes('SDK 合成回复'));
});

test('SDK request usage is counted once and nullable cache counters remain unknown', async t => {
  const f = fixture(t, () => [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'usage-request', model: 'claude-sonnet-4-6', usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: null } } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 4 } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'result', subtype: 'success', usage: { input_tokens: 12, output_tokens: 4 }, session_id: randomUUID() },
  ]);
  assert.equal((await f.send('合成用量')).state, 'completed');
  const rows = f.db.prepare('SELECT scope,source,input_tokens,output_tokens,cache_read_input_tokens FROM usage_observations').all();
  assert.deepEqual(rows.map(r => ({ ...r })), [{ scope: 'request', source: 'sdk_stream', input_tokens: 12, output_tokens: 4, cache_read_input_tokens: null }]);
});

test('a stream broken before the complete assistant packet retains its visible partial text exactly once', async t => {
  const f = fixture(t, () => [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'partial-stream', model: 'claude-sonnet-4-6' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '合成部分正文' } } },
    new Error('ECONNRESET'),
  ]);
  assert.equal((await f.send('合成断流')).state, 'failed');
  assert.equal(f.calls.or.length, 0);
  const messages = f.trajectory.forWindow(f.windows.activeWindow('synthetic')!.id)!.messages;
  assert.equal(messages.filter(m => m.role === 'assistant' && m.content === '合成部分正文').length, 1);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='assistant'").get() as { n: number }).n, 1);
});

test('a subscription rejection after an actual host tool effect does not start OR or execute the tool twice', async t => {
  const f = fixture(t, async function* (_round, input) {
    const args = { operation: 'schedule', operation_id: 'synthetic-once', delay_seconds: 600, note: '合成预约' };
    yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'tool-generation', model: 'claude-sonnet-4-6' } } };
    yield { type: 'assistant', message: { id: 'tool-generation', content: [{ type: 'tool_use', id: 'sdk-tool-once', name: 'mcp__est__wake_manage', input: args }] } };
    // Simulate the external runtime's MCP dispatch using the real MCP protocol
    // and real host executor. Neither the business handler nor its ledger is mocked.
    await input.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__est__wake_manage', tool_input: args, tool_use_id: 'sdk-tool-once' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'synthetic-runtime', version: '1.0.0' });
    await input.options.mcpServers.est.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'wake_manage', arguments: args });
    await client.close();
    assert.equal(result.isError, false);
    yield limit();
    yield { type: 'result', subtype: 'error_during_execution', is_error: true };
  });
  f.backgroundSettings.applyUpdate({ expectedRevision: f.backgroundSettings.revision(), patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 1 } });
  assert.equal((await f.send('合成副作用后额度拒绝')).state, 'failed');
  assert.equal(f.calls.orFactories, 0);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM background_tasks WHERE origin='self_schedule'").get() as any).n, 1);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM runtime_stream_events WHERE kind='turn.tool' AND json_extract(payload_ref,'$.tool')='wake_manage' AND json_extract(payload_ref,'$.phase')='start'").get() as any).n, 1);
  const history = f.trajectory.forWindow(f.windows.activeWindow('synthetic')!.id)!.messages;
  assert.equal(history.filter(m => m.role === 'tool' && m.tool_call_id === 'sdk-tool-once').length, 1);
});

for (const [name, event] of [
  ['allowed', limit('allowed')], ['allowed_warning', limit('allowed_warning')],
  ['overage bucket', limit('rejected', 'overage')], ['missing bucket', { ...limit(), rate_limit_info: { status: 'rejected' } }],
  ['network', new Error('ECONNRESET')], ['ordinary 429', new Error('HTTP 429 Too Many Requests')],
  ['service failure', { type: 'assistant', error: 'server_error', message: { id: 'error', content: [{ type: 'text', text: 'service unavailable' }] } }],
] as const) test(`${name} does not authorize OR`, async t => {
  const f = fixture(t, () => [event, { type: 'result', subtype: 'error_during_execution', is_error: true }]);
  await f.send(`合成 ${name}`);
  assert.equal(f.calls.or.length, 0); assert.equal(f.calls.orFactories, 0);
});

test('subscription admission rejects API authentication, missing overage evidence and enabled extra usage', () => {
  assert.equal(subscriptionAdmission(account, usage), null);
  assert.equal(subscriptionAdmission({ ...account, apiKeySource: 'env' }, usage), 'SDK_SUBSCRIPTION_AUTH_REQUIRED');
  assert.equal(subscriptionAdmission(account, null), 'SDK_EXTRA_USAGE_UNVERIFIED');
  assert.equal(subscriptionAdmission({ apiProvider: 'firstParty', subscriptionType: 'Claude API' }, {
    ...usage, subscription_type: null, rate_limits: null,
  }), 'SDK_EXTRA_USAGE_UNVERIFIED');
  assert.equal(subscriptionAdmission(account, { ...usage, subscription_type: 'unrecognized-plan' }), 'SDK_EXTRA_USAGE_UNVERIFIED');
  assert.equal(subscriptionAdmission(account, { ...usage, rate_limits: { extra_usage: { is_enabled: true } } }), 'SDK_EXTRA_USAGE_ENABLED');
});

test('policy changes are deferred until the next serialized host operation', async t => {
  const f = fixture(t, () => []);
  await f.runner.atSafeTurn(async () => {
    f.settings.set('access_policy', 'configured');
    assert.equal(f.runner.policy(), 'subscription-first');
  });
  assert.equal(f.runner.policy(), 'configured');
});

test('SDK child assembly excludes all API credentials and provider endpoints', () => {
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENROUTER_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const before = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    for (const n of names) process.env[n] = 'synthetic-must-not-inherit';
    const built = subscriptionSdkOptions(buildConfig({ runtime: { model: 'claude-sonnet-4-6' } }), 'synthetic identity', '/tmp/synthetic-workspace');
    for (const n of names) assert.equal(built.options.env[n], undefined);
    assert.equal(built.options.permissionMode, 'default');
    assert.deepEqual(built.options.tools, []); assert.deepEqual(built.options.skills, []);
  } finally { for (const n of names) if (before[n] === undefined) delete process.env[n]; else process.env[n] = before[n]; }
});
