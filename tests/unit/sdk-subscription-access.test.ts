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
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';
import { createBackgroundExecution } from '../../apps/host/src/application/background-execution.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { buildRecordSnapshot } from '../../apps/host/src/server/records.ts';

const account = { apiProvider: 'firstParty', subscriptionType: 'Claude Max' } as const;
const usage = { subscription_type: 'max', rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: false } } } as any;

// Only the two external model transports are simulated. The host queue, input
// ledger, tool registry, fallback decision and final publication are production code.
function fixture(t: any, scripted: (round: number, input: any) => any[] | AsyncIterable<any>, options: { windows?: Record<string, unknown>; orUsage?: Record<string, unknown>; orModel?: string; responseModel?: string; provider?: string; deferred?: boolean } = {}) {
  const { db, root } = makeDb(); writeApprovedIdentity(root);
  const paths = makePaths(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime,
    provider: 'openrouter', access_policy: 'subscription-first', model: 'claude-sonnet-4-6',
    subscription_proxy_url: 'http://127.0.0.1:1082', ...(options.deferred ? { tool_schema_mode: 'deferred' } : {}) }, openrouter: { model: options.orModel ?? 'anthropic/claude-sonnet-4.6' }, windows: options.windows ?? {} });
  const messages = new MessageService(db); messages.ensureConversation('synthetic');
  const events = new EventService(db); const identity = new IdentityService(config, paths);
  const trajectory = new WindowTrajectoryService(db);
  const selections = new ManualSelectionService(db);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const windows = new WindowManager(db, events, identity, config, selections, trajectory);
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
      const frames = [{ id: 'or-synthetic', model: options.responseModel, provider: options.provider, choices: [{ delta: { content: 'OR 合成回复' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: options.orUsage ?? { prompt_tokens: 30, completion_tokens: 3 } }];
      return { status: 200, headers: new Headers(), body: Readable.from(frames.map(f => Buffer.from(`data: ${JSON.stringify(f)}\n\n`)).concat([Buffer.from('data: [DONE]\n\n')])) };
    }) };
  }, () => clock);
  const backgroundSettings = new BackgroundSettingsService(db, config);
  const taskService = new BackgroundTaskService(db, backgroundSettings);
  const { tools, registry } = assembleTestTools({ db, messages, taskService, events, reviews, checkpoint });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, windows, trajectory, selections, reviews, checkpoint, settings, tools, toolCatalog: registry,
    runnerSelection: { status: 'ok', runner }, capabilities: new CapabilityMatrix(config), reasoning: new ReasoningService(db, events),
    routing: new RoutingService(db, events, messages), usage: new UsageCollector(db), logger: new Logger(null) });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, config, calls, runner, settings, windows, trajectory, selections, backgroundSettings, supervisor, messages, events, taskService,
    records: () => buildRecordSnapshot({ db, config, windows, runnerSelection: { status: 'ok', runner } }, 'synthetic', null),
    setNow: (n: number) => { clock = n; },
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

test('subscription admission ignores plan labels but rejects API authentication and unverified or enabled extra usage', () => {
  assert.equal(subscriptionAdmission(account, usage), null);
  assert.equal(subscriptionAdmission({ ...account, apiKeySource: 'env' }, usage), 'SDK_SUBSCRIPTION_AUTH_REQUIRED');
  assert.equal(subscriptionAdmission(account, null), 'SDK_EXTRA_USAGE_UNVERIFIED');
  assert.equal(subscriptionAdmission({ apiProvider: 'firstParty', subscriptionType: 'Claude API' }, {
    ...usage, subscription_type: null, rate_limits: null,
  }), 'SDK_EXTRA_USAGE_UNVERIFIED');
  assert.equal(subscriptionAdmission({ apiProvider: 'firstParty', subscriptionType: 'Claude API' }, {
    ...usage, subscription_type: null,
  }), null);
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

function usageEvents(input: number, read: number | null, write: number | null) {
  return [
    { type: 'stream_event', event: { type: 'message_start', message: { id: randomUUID(), model: 'claude-sonnet-4-6', usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: write } } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 4 } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'result', subtype: 'success', session_id: randomUUID(), usage: { input_tokens: input, output_tokens: 4, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
  ];
}

test('SDK cached input calibrates capacity and records using the complete request total', async t => {
  const f = fixture(t, () => usageEvents(12, 20000, 0), { deferred: true, windows: { soft_limit_tokens: 12000, model_context_capacity: 100000 } });
  assert.equal((await f.send('合成缓存请求')).state, 'completed');
  const records = f.records();
  assert.deepEqual([records.context.lastActualInput, records.cache.lastRead, records.cache.lastWrite, records.cache.lastNoncached], [20012, 20000, 0, 12]);
  assert.equal((await f.send('短续聊')).state, 'blocked');
  assert.equal(f.selections.awaitingFor('synthetic')?.rotation_cause, 'capacity');
  assert.equal(f.calls.sdk.length, 1);
});

test('SDK unknown cache partition keeps total unknown but preserves known partitions', async t => {
  const f = fixture(t, () => usageEvents(12, 20000, null));
  await f.send('合成部分计量');
  const records = f.records();
  assert.deepEqual([records.context.lastActualInput, records.cache.lastRead, records.cache.lastWrite, records.cache.lastNoncached], [null, 20000, null, 12]);
});

test('OR total input is not counted twice and does not require cache partitions', async t => {
  for (const details of [{ cached_tokens: 20000, cache_write_tokens: 0 }, undefined]) {
    const f = fixture(t, () => [limit()], { orUsage: { prompt_tokens: 20012, completion_tokens: 4, ...(details ? { prompt_tokens_details: details } : {}) } });
    await f.send('合成 OR 总量');
    const records = f.records();
    assert.equal(records.context.lastActualInput, 20012);
    if (details) assert.equal(records.cache.lastNoncached, 12);
  }
});

test('SDK turn aggregates cannot replace the last measured request context', async t => {
  const f = fixture(t, round => round === 2
    ? [{ type: 'result', subtype: 'success', session_id: randomUUID(), usage: { input_tokens: 90000, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }]
    : usageEvents(12, 20000, 0), { windows: { soft_limit_tokens: 40000, model_context_capacity: 100000 } });
  await f.send('单请求观测');
  await f.send('只有整轮累计的观测');
  assert.equal(f.records().context.lastActualInput, 20012);
  assert.equal((await f.send('继续聊天')).state, 'completed');
});

test('OR fallback attributes each request to its envelope and observed response, independent of SDK policy', async t => {
  for (const responseModel of [undefined, 'deepseek/synthetic-resolved']) {
    const f = fixture(t, () => [limit()], { orModel: 'deepseek/deepseek-chat-v3.1', responseModel, provider: 'Synthetic Upstream' });
    assert.equal((await f.send('跨模型家族回退')).state, 'completed');
    assert.equal(f.runner.kind, 'claude-agent-sdk');
    const rows = f.db.prepare("SELECT u.model,p.payload_json FROM usage_observations u JOIN provider_requests p ON p.id=u.request_id WHERE u.source='or_stream'").all() as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, responseModel ?? 'deepseek/deepseek-chat-v3.1');
    assert.deepEqual(JSON.parse(rows[0].payload_json).execution, {
      entry: 'openrouter', requestedModel: 'deepseek/deepseek-chat-v3.1', responseModel: responseModel ?? null, provider: 'Synthetic Upstream',
    });
  }
});

test('background fallback records the actual request model in usage and the existing run', async t => {
  const model = 'deepseek/deepseek-chat-v3.1';
  const f = fixture(t, round => round === 1 ? usageEvents(12, 0, 0) : [limit()], { orModel: model });
  await f.send('先建立会话');
  f.backgroundSettings.applyUpdate({ expectedRevision: f.backgroundSettings.revision(), patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
  f.settings.set('or_model_price', JSON.stringify({ input_micro_per_token: 1, output_micro_per_token: 1 }));
  assert.equal(f.taskService.schedule({ actorId: 'jiaming', createdBy: 'jiaming', conversationId: 'synthetic', operationId: 'fallback-wake', note: '合成自醒', delaySeconds: 1 }).ok, true);
  let scheduler: BackgroundScheduler;
  const executor = createBackgroundExecution({ messages: f.messages, events: f.events, bgSettings: f.backgroundSettings, supervisor: f.supervisor, scheduler: { recordDispatchStart: input => scheduler.recordDispatchStart(input) } });
  scheduler = new BackgroundScheduler({ db: f.db, config: f.config, settings: f.backgroundSettings, alerts: new SystemAlertService(f.db, f.events), executor, now: () => Date.now() + 2000 });
  scheduler.start();
  try { await scheduler.tick(); await f.supervisor.waitIdle(); } finally { scheduler.stop(); }
  const run = f.db.prepare('SELECT driver,model,state FROM background_runs').get();
  assert.equal(run?.state, 'completed'); assert.equal(run?.driver, 'openrouter'); assert.equal(run?.model, model);
  const usage = f.db.prepare("SELECT model FROM usage_observations WHERE purpose='proactive_turn' AND source='or_stream'").get();
  assert.equal(usage?.model, model);
});

test('capacity review fallback uses the actual OR model in quiet usage', async t => {
  const model = 'deepseek/deepseek-chat-v3.1';
  const f = fixture(t, round => round === 1 ? usageEvents(12, 20000, 0) : [limit()], { orModel: model, deferred: true, windows: { soft_limit_tokens: 12000, model_context_capacity: 100000 } });
  await f.send('建立已见历史');
  await f.send('触发容量选集');
  const window = f.windows.activeWindow('synthetic')!;
  await f.supervisor.selectionConfirm({ conversationId: 'synthetic', windowId: window.id, items: [], explicitEmpty: true, idempotencyKey: 'review-model' });
  const row = f.db.prepare("SELECT model FROM usage_observations WHERE purpose='pre_rotate_review' AND source='or_stream'").get();
  assert.equal(row?.model, model);
});
