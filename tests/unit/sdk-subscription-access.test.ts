import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';
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
function fixture(t: any, scripted: (round: number, input: any) => any[] | AsyncIterable<any>, options: { windows?: Record<string, unknown>; orUsage?: Record<string, unknown>; orModel?: string; responseModel?: string; provider?: string; deferred?: boolean; sdkUsage?: any; orFrames?: (round: number) => any[] } = {}) {
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
  const windows = new WindowManager(db, identity, config, selections, trajectory);
  const settings = new RuntimeSettingsService(db);
  const calls = { sdk: [] as any[], or: [] as any[], orFactories: 0 };
  let clock = 1_800_000_000_000;
  const sdk = new ClaudeSdkRunner(((input: any) => {
    calls.sdk.push(input);
    const round = calls.sdk.length;
    const iterator = (async function* () {
      const current = yield* scriptedSdkInput(input, 'synthetic-replay-session', (value, history) => { input.capturedPrompt = [...history, value]; });
      if (!current) return;
      for await (const event of scripted(round, input)) {
        if (event instanceof Error) throw event;
        yield event;
      }
    })();
    return Object.assign(iterator, { close() {}, accountInfo: async () => account,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => options.sdkUsage === undefined ? usage : options.sdkUsage });
  }) as any);
  const runner = new SubscriptionAccessRunner(config, settings, async cfg => {
    if (cfg.runtime.provider === 'claude-agent-sdk') return { status: 'ok', runner: sdk };
    calls.orFactories++;
    return { status: 'ok', runner: new OpenRouterRunner({ providerOnly: [], allowFallbacks: false, requireParameters: true, retryMax: 0 }, async payload => {
      calls.or.push(payload);
      const frames = options.orFrames?.(calls.or.length) ?? [{ id: 'or-synthetic', model: options.responseModel, provider: options.provider, choices: [{ delta: { content: 'OR 合成回复' } }] },
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
  assert.ok(JSON.stringify(f.calls.sdk[1].capturedPrompt).includes('OR 合成回复'));
  assert.ok(JSON.stringify(f.calls.sdk[1].capturedPrompt).includes('额度未重置时的下一条'));
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
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 4 } } },
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

test('approved subscription admission permits unknown usage but rejects API authentication and explicitly enabled extra usage', () => {
  assert.equal(subscriptionAdmission(account, usage), null);
  assert.equal(subscriptionAdmission({ ...account, apiKeySource: 'env' }, usage), 'SDK_SUBSCRIPTION_AUTH_REQUIRED');
  assert.equal(subscriptionAdmission(account, null), null);
  assert.equal(subscriptionAdmission({ apiProvider: 'firstParty', tokenSource: 'none' }, null), 'SDK_SUBSCRIPTION_AUTH_REQUIRED');
  assert.equal(subscriptionAdmission({ ...account, apiKeySource: 'env' }, null), 'SDK_SUBSCRIPTION_AUTH_REQUIRED');
  assert.equal(subscriptionAdmission({ apiProvider: 'firstParty', subscriptionType: 'Claude API' }, {
    ...usage, subscription_type: null, rate_limits: null,
  }), null);
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

test('SDK child accepts the official setup-token while excluding API credentials and provider overrides', () => {
  const excluded = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENROUTER_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
  const names = [...excluded, 'CLAUDE_CODE_OAUTH_TOKEN'];
  const before = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    for (const n of names) process.env[n] = 'synthetic-must-not-inherit';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-synthetic-setup-token';
    const built = subscriptionSdkOptions(buildConfig({ runtime: { model: 'claude-sonnet-4-6' } }), 'synthetic identity', '/tmp/synthetic-workspace');
    for (const n of excluded) assert.equal(built.options.env[n], undefined);
    assert.equal(built.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-synthetic-setup-token');
    assert.equal(built.options.env.CLAUDE_CODE_SIMPLE, undefined);
    assert.equal(built.options.permissionMode, 'default');
    assert.deepEqual(built.options.tools, []); assert.deepEqual(built.options.skills, []);
  } finally { for (const n of names) if (before[n] === undefined) delete process.env[n]; else process.env[n] = before[n]; }
});

function usageEvents(input: number, read: number | null, write: number | null) {
  return [
    { type: 'stream_event', event: { type: 'message_start', message: { id: randomUUID(), model: 'claude-sonnet-4-6', usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: write } } } },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 4 } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'result', subtype: 'success', session_id: randomUUID(), usage: { input_tokens: input, output_tokens: 4, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
  ];
}

test('SDK cached input calibrates capacity and records using the complete request total', async t => {
  const f = fixture(t, () => usageEvents(12, 20000, 0), { deferred: true, windows: { soft_limit_tokens: 20000, model_context_capacity: 100000 } });
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
    assert.equal(f.records().driver, 'openrouter');
    assert.equal(f.records().exactModel, responseModel ?? 'deepseek/deepseek-chat-v3.1');
    assert.equal(f.records().requestExecution?.provider, 'Synthetic Upstream');
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
  const f = fixture(t, round => round === 1 ? usageEvents(12, 20000, 0) : [limit()], { orModel: model, deferred: true, windows: { soft_limit_tokens: 20000, model_context_capacity: 100000 } });
  await f.send('建立已见历史');
  await f.send('触发容量选集');
  const window = f.windows.activeWindow('synthetic')!;
  await f.supervisor.selectionConfirm({ conversationId: 'synthetic', windowId: window.id, items: [], explicitEmpty: true, idempotencyKey: 'review-model' });
  const row = f.db.prepare("SELECT model FROM usage_observations WHERE purpose='pre_rotate_review' AND source='or_stream'").get();
  assert.equal(row?.model, model);
});

test('SDK estimates preserve session scope and pricing basis without adding request tokens or actual charges', async t => {
  const f = fixture(t, round => {
    const events: any[] = usageEvents(12, 100, 0);
    Object.assign(events.at(-1), { session_id: 'cost-session', total_cost_usd: round === 1 ? 0.02 : 0.03,
      modelUsage: { 'claude-sonnet-4-6': { inputTokens: round * 112, costUSD: round === 1 ? 0.02 : 0.03, costBasis: 'list' } } });
    return events;
  });
  await f.send('第一笔估值'); await f.send('恢复会话后的累计估值');
  const rows = f.db.prepare("SELECT scope,cost_usd,input_tokens,raw_usage_json FROM usage_observations ORDER BY rowid").all() as any[];
  assert.equal(rows.filter(r => r.scope === 'request').length, 2);
  const estimates = rows.filter(r => r.scope === 'cumulative').map(r => { assert.equal(r.cost_usd, null); assert.equal(r.input_tokens, null); return JSON.parse(r.raw_usage_json); });
  assert.deepEqual(estimates.map(e => e.total_cost_usd), [0.02, 0.03]);
  assert.equal(estimates[1].scope, 'sdk_session_cumulative'); assert.equal(estimates[1].session_id, 'cost-session');
  assert.equal(estimates[1].resumed_from_session_id, 'cost-session'); assert.equal(estimates[1].fork_session, false);
  assert.equal(estimates[1].model_usage['claude-sonnet-4-6'].costBasis, 'list');
  const last = f.db.prepare('SELECT id FROM turns ORDER BY rowid DESC LIMIT 1').get()!.id as string;
  const collector = new UsageCollector(f.db); const summary = collector.summaryForTurn(last);
  assert.equal(summary.totals.fields.input_tokens.complete_total, 112);
  assert.equal(summary.totals.cost_usd, null);
  assert.equal(summary.sdk_estimates[0].estimate.total_cost_usd, 0.03);
  assert.equal(f.records().sdkEstimates.at(-1)!.estimate.total_cost_usd, 0.03);
  assert.equal(f.records().usageByPurpose.find(p => p.purpose === 'chat')?.count, 2);
});

test('interrupted SDK input keeps observed tokens without manufacturing a result estimate', async t => {
  const f = fixture(t, () => [...usageEvents(12, 100, 0).slice(0, 2), new Error('ECONNRESET')]);
  assert.equal((await f.send('合成断流')).state, 'failed');
  const rows = f.db.prepare('SELECT scope,input_tokens,completeness,cost_usd FROM usage_observations').all();
  assert.deepEqual(rows.map(r => ({...r})), [{scope:'request',input_tokens:12,completeness:'partial',cost_usd:null}]);
  assert.equal(f.records().sdkEstimates.length, 0);
});

test('a native tool continuation keeps last request context separate from turn usage and session estimate', async t => {
  const f = fixture(t, async function* (_round, input) {
    const first = usageEvents(12, 100, 0);
    yield first[0];
    const args = {operation:'list'};
    yield {type:'assistant',message:{id:'metered-tool',content:[{type:'tool_use',id:'metered-call',name:'mcp__est__wake_manage',input:args}]}};
    yield first[1]; yield first[2];
    await input.options.hooks.PreToolUse[0].hooks[0]({hook_event_name:'PreToolUse',tool_name:'mcp__est__wake_manage',tool_input:args,tool_use_id:'metered-call'});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({name:'metering-boundary',version:'1.0.0'});
    await input.options.mcpServers.est.instance.connect(serverTransport); await client.connect(clientTransport);
    const result = await client.callTool({name:'wake_manage',arguments:args}); await client.close();
    assert.equal(result.isError,false);
    await input.options.hooks.PostToolBatch[0].hooks[0]({hook_event_name:'PostToolBatch'});
    const final: any[] = usageEvents(7,20000,0);
    Object.assign(final.at(-1),{total_cost_usd:0.03,modelUsage:{'claude-sonnet-4-6':{costUSD:0.03,costBasis:'list'}}});
    yield* final;
  });
  await f.send('合成工具计量');
  const turnId=f.db.prepare('SELECT id FROM turns').get()!.id as string;
  const total=new UsageCollector(f.db).summaryForTurn(turnId);
  assert.equal(f.records().context.lastActualInput,20007);
  assert.equal(total.totals.fields.input_tokens.complete_total,20119);
  assert.equal(total.sdk_estimates.length,1);
  assert.equal(total.totals.cost_usd,null);
  const day=f.db.prepare('SELECT budget_day FROM usage_observations LIMIT 1').get()!.budget_day as string;
  const daily=new UsageCollector(f.db).summaryByDay(day).purposes[0]!;
  assert.equal(daily.row_count,2); assert.equal(daily.known_input_total,20119);
});

test('SDK complete-only thinking is visible without a contradictory no_block marker', async t => {
  const f=fixture(t,()=>[
    {type:'assistant',session_id:'thinking-full',uuid:'thinking-packet',message:{id:'thinking-message',model:'claude-sonnet-4-6',content:[{type:'thinking',thinking:'SYNTHETIC_COMPLETE_THINKING',signature:'SYNTHETIC_SIGNATURE'}]}},
    {type:'assistant',session_id:'thinking-full',uuid:'text-packet',message:{id:'thinking-message',content:[{type:'text',text:'合成正式回答'}]}},
    {type:'result',subtype:'success',session_id:'thinking-full'},
  ]);
  assert.equal((await f.send('完整思考块')).state,'completed');
  const rows=f.db.prepare('SELECT visibility,received_text FROM reasoning_blocks ORDER BY rowid').all();
  assert.deepEqual(rows.map(r=>({...r})),[{visibility:'summary',received_text:'SYNTHETIC_COMPLETE_THINKING'}]);
});

test('SDK structured flag joins the existing route gate; absent thinking alone does not',async t=>{
  const f=fixture(t,round=>round===1?[
    {type:'stream_event',session_id:'flag-session',event:{type:'message_start',message:{id:'flag-message',model:'claude-sonnet-4-6'}}},
    {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'refusal'},usage:{output_tokens:1}}},
    {type:'result',subtype:'success',session_id:'flag-session'},
  ]:[...textEvents(),{type:'result',subtype:'success',session_id:'continued-session'}]);
  assert.equal((await f.send('合成flag')).state,'route_owner_pending');
  const routing=new RoutingService(f.db,f.events,f.messages);
  const ticket=routing.pendingForConversation('synthetic')!;
  assert.equal(ticket.source_evidence,'SDK_FLAGGED');
  assert.equal(f.calls.or.length,0);
  assert.equal((await f.send('后续合成输入')).state,'pending');
  assert.equal(f.calls.sdk.length,1);
  const resolved=routing.validateAndConsume(ticket.id,{choice:'approve'});assert.equal(resolved.ok,true);
  f.supervisor.requeueConversationQueuedTurns('synthetic');await f.supervisor.waitIdle();
  assert.equal(routing.pendingForConversation('synthetic'),null);
  assert.equal(f.db.prepare('SELECT state FROM turns WHERE id=?').get(ticket.turn_id)?.state,'completed');
  assert.equal(f.calls.or.length,0);
});

test('repeated SDK flag after approval finishes with failed status instead of reopening a pending UI state',async t=>{
  const f=fixture(t,()=>[
    {type:'stream_event',session_id:'repeat-flag',event:{type:'message_start',message:{id:'repeat-flag-message',model:'claude-sonnet-4-6'}}},
    {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'refusal'}}},
    {type:'result',subtype:'success',session_id:'repeat-flag'},
  ]);
  await f.send('合成持续flag');
  const routing=new RoutingService(f.db,f.events,f.messages);const ticket=routing.pendingForConversation('synthetic')!;
  assert.equal(routing.validateAndConsume(ticket.id,{choice:'approve'}).ok,true);
  f.supervisor.requeueConversationQueuedTurns('synthetic');await f.supervisor.waitIdle();
  assert.equal(f.db.prepare('SELECT state FROM turns WHERE id=?').get(ticket.turn_id)?.state,'failed');
  assert.equal(routing.pendingForTurn(ticket.turn_id),null);
  const event=f.db.prepare("SELECT payload_ref FROM runtime_stream_events WHERE turn_id=? AND kind='turn.status' ORDER BY sequence DESC LIMIT 1").get(ticket.turn_id)!;
  assert.equal(JSON.parse(event.payload_ref as string).state,'failed');
});

test('SDK flag preserves the existing dispatched-input edit restriction and completed tool receipt',async t=>{
  const f=fixture(t,async function*(round,input){
    if(round!==1){yield* textEvents();yield {type:'result',subtype:'success',session_id:'edited-route-session'};return;}
    const args={operation:'schedule',operation_id:'route-edit-effect',delay_seconds:600,note:'SYNTHETIC_COMMITTED_EFFECT'};
    yield {type:'stream_event',event:{type:'message_start',message:{id:'effect-before-flag',model:'claude-sonnet-4-6'}}};
    yield {type:'assistant',message:{id:'effect-before-flag',content:[{type:'tool_use',id:'route-effect',name:'mcp__est__wake_manage',input:args}]}};
    await input.options.hooks.PreToolUse[0].hooks[0]({hook_event_name:'PreToolUse',tool_name:'mcp__est__wake_manage',tool_input:args,tool_use_id:'route-effect'});
    const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'synthetic-route',version:'1.0.0'});
    await input.options.mcpServers.est.instance.connect(b);await client.connect(a);
    const result=await client.callTool({name:'wake_manage',arguments:args});await client.close();assert.equal(result.isError,false);
    await input.options.hooks.PostToolBatch[0].hooks[0]({hook_event_name:'PostToolBatch'});
    yield {type:'stream_event',event:{type:'message_start',message:{id:'flag-after-effect',model:'claude-sonnet-4-6'}}};
    yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'refusal'}}};
  });
  f.backgroundSettings.applyUpdate({expectedRevision:f.backgroundSettings.revision(),patch:{autonomous_enabled:true,autonomous_daily_cost_cap_usd:1}});
  await f.send('SYNTHETIC_SUPERSEDED_INPUT');
  const routing=new RoutingService(f.db,f.events,f.messages);const ticket=routing.pendingForConversation('synthetic')!;
  const edited=routing.validateAndConsume(ticket.id,{choice:'edit',content:'SYNTHETIC_CURRENT_INPUT'});
  assert.equal(edited.ok,false);if(!edited.ok)assert.equal(edited.code,'ROUTE_EDIT_REJECTED');
  assert.equal(routing.pendingForTurn(ticket.turn_id)?.id,ticket.id);
  assert.equal(routing.validateAndConsume(ticket.id,{choice:'cancel'}).ok,true);
  assert.equal(f.calls.sdk.length,1);
  assert.equal(f.db.prepare('SELECT state FROM turns WHERE id=?').get(ticket.turn_id)?.state,'blocked');
  assert.equal(f.db.prepare("SELECT count(*) n FROM background_tasks WHERE origin='self_schedule'").get()?.n,1);
});


test('approved unknown quota reaches the SDK host lane and never authorizes OR by itself',async t=>{
  const f=fixture(t,()=>[...textEvents(),{type:'result',subtype:'success',session_id:'unknown-usage-session'}],{sdkUsage:null});
  assert.equal((await f.send('合成未知额度准入')).state,'completed');
  assert.equal(f.calls.or.length,0);
  assert.equal(f.runner.status().actual_entry,'claude-agent-sdk');
  assert.equal(f.db.prepare('SELECT count(*) n FROM provider_requests').get()?.n,1);
});

test('explicit extra usage remains blocked before model input after enabling the new policy',async t=>{
  const f=fixture(t,()=>textEvents(),{sdkUsage:{...usage,rate_limits:{extra_usage:{is_enabled:true}}}});
  assert.equal((await f.send('合成额外付费已开启')).state,'failed');
  assert.equal(f.db.prepare('SELECT count(*) n FROM provider_requests').get()?.n,0);
  assert.equal(f.calls.or.length,0);
  assert.match(String(f.db.prepare('SELECT blocked_reason FROM attempts').get()?.blocked_reason),/^SDK_EXTRA_USAGE_ENABLED:/);
});

test('runtime overage detection still stops SDK and does not fall back to OR',async t=>{
  const f=fixture(t,()=>[{type:'rate_limit_event',rate_limit_info:{status:'allowed',rateLimitType:'five_hour',isUsingOverage:true}}],{sdkUsage:null});
  assert.equal((await f.send('合成运行时额外用量')).state,'failed');
  assert.equal(f.calls.or.length,0);
  assert.equal(f.runner.status().last_error,'SDK_EXTRA_USAGE_ACTIVE');
});

test('manual SDK/API and model selections retain the same window and all prior conversation', async t => {
 const f=fixture(t,()=>[...textEvents(),{type:'result',subtype:'success',session_id:randomUUID()}]);
 assert.equal((await f.send('FIRST_SDK_HISTORY')).state,'completed');
 const window=f.windows.activeWindow('synthetic')!.id;
 f.settings.set('access_policy','configured');
 assert.equal((await f.send('API_INTERVAL_HISTORY')).state,'completed');
 assert.ok(JSON.stringify(f.calls.or.at(-1).messages).includes('FIRST_SDK_HISTORY'));
 f.settings.set('or_model','anthropic/claude-opus-5.5');
 assert.equal((await f.send('API_MODEL_CHANGE')).state,'completed');
 f.settings.setMany([['access_policy','subscription-first'],['sdk_model','claude-opus-5-5']]);
 assert.equal((await f.send('RETURN_TO_SDK')).state,'completed');
 const latest=f.calls.sdk.at(-1);
 assert.equal(latest.options.model,'claude-opus-5-5');assert.equal(latest.options.resume,undefined);
 assert.ok(JSON.stringify(latest.capturedPrompt).includes('FIRST_SDK_HISTORY'));
 assert.ok(JSON.stringify(latest.capturedPrompt).includes('API_INTERVAL_HISTORY'));
 assert.ok(JSON.stringify(latest.capturedPrompt).includes('API_MODEL_CHANGE'));
 assert.equal(f.windows.activeWindow('synthetic')!.id,window);
 assert.equal(f.db.prepare('SELECT count(*) n FROM context_selections').get()?.n,0);
});

test('model switch projects prior signed thinking out of API requests while preserving canonical tool receipts',async t=>{
 const f=fixture(t,()=>[],{orFrames:round=>round===1?[
  {id:'signed-tool',choices:[{delta:{reasoning_details:[{type:'reasoning.encrypted',data:'SYNTHETIC_OPAQUE'}],tool_calls:[{index:0,id:'signed-call',type:'function',function:{name:'wake_manage',arguments:'{"operation":"list"}'}}]}}]},
  {choices:[{delta:{},finish_reason:'tool_calls'}]},
 ]:[{id:'reply-'+round,choices:[{delta:{content:'SYNTHETIC_API_REPLY'}}]},{choices:[{delta:{},finish_reason:'stop'}]}]});
 f.settings.set('access_policy','configured');
 assert.equal((await f.send('TOOL_BEFORE_MODEL_SWITCH')).state,'completed');
 const id=f.windows.activeWindow('synthetic')!.id;
 const old=f.trajectory.forWindow(id)!.messages;
 assert.ok(old.some(m=>m.reasoning_details));
 f.settings.set('or_model','anthropic/claude-opus-5.5');
 assert.equal((await f.send('AFTER_MODEL_SWITCH')).state,'completed');
 const sent=f.calls.or.at(-1).messages;
 assert.ok(sent.some((m:any)=>m.tool_call_id==='signed-call'));
 assert.ok(!sent.some((m:any)=>m.reasoning_details));
 assert.deepEqual(f.trajectory.forWindow(id)!.messages.slice(0,old.length),old);
});
