// 聊天里主动抽牌（2026-11-23 增量）：普通聊天轮与心跳共用当天同一副牌。真实 Host、真实工具循环，
// API 与 SDK 两条车道；假模型、隔离临时目录，不发真实消息。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Host } from '../../apps/host/src/app-context.ts';
import type { ToolExecContext, ToolExecResult } from '../../apps/host/src/capabilities/contracts.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { HeartbeatCards, type HeartbeatSource } from '../../apps/host/src/modules/heartbeat/service.ts';
import { HeartbeatSources } from '../../apps/host/src/modules/heartbeat/sources.ts';
import { WishstarClient } from '../../apps/host/src/integrations/wishstar/client.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';
import { lastCacheEvidence } from '../../apps/host/src/runtime/cache-observation.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import type { SdkQueryFactory } from '../../apps/host/src/runtime/sdk-host-query.ts';
import { readHeartbeatProjection } from '../../packages/contracts/src/heartbeat.ts';
import { makeFixtureToolsResident, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import { installHeartbeatFixtureSources } from '../helpers/heartbeat-sources.ts';
import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';

type Lane = 'api' | 'api-deferred' | 'sdk';
// Deferred windows reach every business tool through tool_invoke; the discovery tools themselves are called directly.
const wireCall = (lane: Lane, call: { id: string; name: string; args: Record<string, unknown> }) =>
  lane === 'api-deferred' && !['tool_catalog', 'tool_define', 'tool_invoke'].includes(call.name)
    ? { id: call.id, name: 'tool_invoke', args: { name: call.name, arguments: call.args } } : call;
type Step = { text?: string; calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> };
const model = 'anthropic/claude-chat-draw-fixture';
const usage = { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.001 };
const draw = (id: string, card_number: number): Step['calls'] => [{ id, name: 'heartbeat_draw', args: { card_number } }];
const define = (id = 'define-draw'): Step['calls'] => [{ id, name: 'tool_define', args: { name: 'heartbeat_draw' } }];
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
// Kept before any fixture replaces the source boundary, for the one case that needs the real star lookup.
const REAL_RESOLVE = HeartbeatSources.prototype.resolve;

async function fixture(t: Pick<TestContext, 'after' | 'mock'>, lane: Lane, options: { now?: number; wishstar?: boolean } = {}) {
  assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
  if (options.now !== undefined) t.mock.timers.enable({ apis: ['Date'], now: options.now });
  const restoreSources = installHeartbeatFixtureSources();
  const root = tempRoot('chat-draw-');
  // Each model request takes the next step: text, tool calls, or both.
  const steps: Step[] = [];
  const requests: Array<{ heartbeat: boolean; lastUser: string }> = [];
  const tools: Array<{ name: string; args: Record<string, unknown>; result: ToolExecResult; purpose: string }> = [];
  let host: Host | undefined;
  t.after(async () => { await host?.stop(); restoreSources(); fs.rmSync(root, { recursive: true, force: true }); });
  writeApprovedIdentity(root);
  const observe = (messages: OrMessage[]) => {
    const lastUser = messages.findLast(message => message.role === 'user');
    const content = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
    requests.push({ heartbeat: content.includes('[心跳唤醒]'), lastUser: content });
    return steps.shift() ?? { text: '合成回复' };
  };
  const runner = lane === 'sdk' ? new ClaudeSdkRunner(((input: any) => {
    const session = 'chat-draw-sdk-session';
    const output = (async function* () {
      if (!(yield* scriptedSdkInput(input, session, frame => {
        const content = JSON.stringify(frame.message?.content ?? '');
        requests.push({ heartbeat: content.includes('[心跳唤醒]'), lastUser: content });
      }))) return;
      // Like the real SDK: a tool batch is followed by the next model request in the same
      // query, unless the host's PostToolBatch hook stops the turn.
      for (;;) {
        const step = steps.shift() ?? { text: '合成回复' };
        const id = `chat-draw-sdk-${requests.length}-${Math.random().toString(36).slice(2, 8)}`;
        yield { type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, model: input.options.model,
          usage: { input_tokens: 600, output_tokens: 4, cache_read_input_tokens: 1500 } } } };
        const calls = step.calls ?? [];
        yield { type: 'assistant', session_id: session, message: { id, content: [
          ...(step.text ? [{ type: 'text', text: step.text }] : []),
          ...calls.map(call => ({ type: 'tool_use', id: call.id, name: 'mcp__est__' + call.name, input: call.args })),
        ] } };
        yield { type: 'stream_event', session_id: session, event: { type: 'message_stop' } };
        if (!calls.length) break;
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'synthetic', version: '1' });
        await input.options.mcpServers.est.instance.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          for (const call of calls) {
            await input.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__est__' + call.name, tool_input: call.args, tool_use_id: call.id });
            await client.callTool({ name: call.name, arguments: call.args });
          }
          const decision = await input.options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch',
            tool_calls: calls.map(call => ({ tool_use_id: call.id, tool_name: 'mcp__est__' + call.name, tool_input: call.args })) });
          if (decision.continue === false) break;
        } finally { await client.close(); }
      }
      yield { type: 'result', subtype: 'success', session_id: session };
    })();
    return Object.assign(output, {
      close() {}, accountInfo: async () => ({ apiProvider: 'firstParty' }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: false } } }),
    });
  }) as SdkQueryFactory) : new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 },
    async payload => {
      const step = observe(payload.messages as OrMessage[]);
      const calls = (step.calls ?? []).map(call => wireCall(lane, call));
      const delta = { ...(step.text ? { content: step.text } : {}), ...(calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) };
      return { status: 200, headers: new Headers(), body: Readable.from([
        sse({ id: `chat-draw-${requests.length}`, choices: [{ delta }] }),
        sse({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage }),
        'data: [DONE]\n\n',
      ]) };
    });
  const ready = readyRuntimePatch();
  const config = buildConfig({
    ...ready, runtime: { ...ready.runtime as object, provider: 'mock', tool_schema_mode: lane === 'api-deferred' ? 'deferred' : 'direct',
      ...(lane === 'sdk' ? { subscription_proxy_url: 'http://127.0.0.1:1' } : {}) },
    openrouter: { model }, background: { keepwarm: { sleep_window: { enabled: true } } },
    ...(options.wishstar ? { wishstar: { enabled: true } } : {}),
  });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0, runnerOverride: runner });
  if (lane !== 'api-deferred') makeFixtureToolsResident(host.db, ['heartbeat_draw', 'background_complete', ...(options.wishstar ? ['wishstar_reply_star'] : [])]);
  const executor = (host.supervisor as any).d.tools;
  const execute = executor.execute.bind(executor);
  executor.execute = async (name: string, args: Record<string, unknown>, ctx: ToolExecContext) => {
    const result: ToolExecResult = await execute(name, args, ctx);
    const effective = name === 'tool_invoke' ? String(args.name) : name;
    tools.push({ name: effective, args: effective === name ? args : args.arguments as Record<string, unknown>, result, purpose: ctx.purpose });
    return result;
  };
  await host.start();
  const cards = new HeartbeatCards(host.db);
  const activity = new ConversationActivityService(host.db);
  const chat = async (content: string, script: Step[]) => {
    host!.messages.ensureConversation('primary');
    steps.push(...script);
    const before = requests.length;
    const input = host!.messages.submitUserMessageWithTurn({ conversationId: 'primary', content, clientMessageId: `chat-${requests.length}` });
    host!.supervisor.enqueue(input.turnId);
    await host!.supervisor.waitIdle();
    assert.equal(host!.db.prepare('SELECT state FROM turns WHERE id=?').get(input.turnId)?.state, 'completed', JSON.stringify(tools.slice(-4)));
    assert.ok(requests.length > before, 'the model was asked');
    return input.turnId;
  };
  const projectionOf = (runId: string) => {
    const row = host!.db.prepare("SELECT payload_ref FROM outbox WHERE operation_key=?").get('heartbeat-moment:' + runId) as { payload_ref: string } | undefined;
    return row ? readHeartbeatProjection(JSON.parse(row.payload_ref)) : null;
  };
  const replies = (turnId: string) => (host!.db.prepare("SELECT id FROM messages WHERE turn_id=? AND speaker='assistant' ORDER BY sequence").all(turnId) as Array<{ id: string }>).map(row => row.id);
  return { host, config, cards, activity, chat, tools, requests, steps, projectionOf, replies };
}

for (const lane of ['api', 'api-deferred', 'sdk'] as const) {
  test(`聊天里主动抽牌与心跳共用同一副牌；一回合一涨；夜间、休息和心跳开关不拦聊天抽牌，自主预约不能借此抽牌 (${lane})`, { timeout: 20000 }, async t => {
    const DAY = '2026-11-24';
    const at = (time: string) => Date.parse(`${DAY}T${time}+08:00`);
    const ctx = await fixture(t, lane, { now: at('14:00') });
    const { host, cards, activity } = ctx;
    const deck = () => cards.getDeck('primary', DAY)!;
    await ctx.chat('先聊两句', [{ text: '好呀。' }]);
    assert.equal(deck(), null, '没有抽牌之前，今天的牌组还没有固定');

    // 读定义就能看到还剩哪些号码；牌组未固定时十个号码都可抽。
    const first = await ctx.chat('我们抽一张看看', [
      { calls: define('look-1') }, { calls: [...draw('draw-first', 7), ...draw('draw-retry', 7), ...draw('draw-again', 3)] }, { text: '抽到的是七号牌，上面写着合成心跳卡内容：fixture-card-7。' },
    ]);
    assert.equal(ctx.tools.find(entry => entry.name === 'tool_define' && JSON.stringify(entry.args).includes('heartbeat_draw'))?.purpose, 'chat');
    const look = ctx.tools.find(entry => entry.name === 'tool_define')!.result.output as { deck_state: string; available_card_numbers: number[] };
    assert.deepEqual([look.deck_state, look.available_card_numbers], ['not_built', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
    const drawn = ctx.tools.filter(entry => entry.name === 'heartbeat_draw');
    assert.deepEqual(drawn.map(entry => [entry.purpose, entry.result.ok, entry.result.output.error_code ?? entry.result.output.heartbeat_card?.card_number]), [
      ['chat', true, 7], ['chat', false, 'HEARTBEAT_DRAW_ALREADY_STARTED'], ['chat', false, 'HEARTBEAT_DRAW_ALREADY_STARTED'],
    ], '同一回合再要一个号码只拿回第一张的身份，不再揭牌');
    assert.deepEqual(drawn[1]!.result.output, drawn[2]!.result.output, '重试同一个号码和改要另一个号码，拿到的都是第一张的身份');
    assert.equal(JSON.stringify(ctx.tools.filter(entry => entry.name === 'heartbeat_draw').map(entry => entry.result)).includes('fixture-card-3'), false);
    assert.deepEqual([deck()?.deliveredNumbers, deck()?.availableNumbers], [[7], [1, 2, 3, 4, 5, 6, 8, 9, 10]]);
    assert.equal(cards.getDeliveredDraw(first)?.cardNumber, 7);
    assert.equal(cards.getDeliveredDraw(first)?.source.id, 'fixture-card-7');

    // 揭牌记录属于这个普通回合；她的聊天界面不因此把它当成心跳轮。
    const reveal = host.db.prepare("SELECT id FROM messages WHERE client_message_id=?").get(`heartbeat:${first}:card`) as { id: string } | undefined;
    assert.ok(reveal, '牌面实际送达模型后，揭牌记录进入正式聊天');
    const revealDto = host.messages.getMessage(reveal!.id)!;
    assert.deepEqual(revealDto.heartbeat_card, { run_id: first, origin: 'chat' });
    assert.equal(revealDto.heartbeat, 'progress');
    assert.equal(revealDto.revision.content, '[抽牌] 抽到了 7 号牌。');
    assert.equal(ctx.replies(first).length, 1, '回复只发一次，不会被收尾再投递');
    assert.equal(host.messages.getMessage(ctx.replies(first)[0]!)?.heartbeat, undefined);
    const projection = ctx.projectionOf(first);
    assert.equal(projection?.origin, 'chat');
    assert.equal(projection?.state, 'drawn');
    assert.equal(projection?.card?.number, 7);
    assert.deepEqual(projection?.messages.map(ref => ref.messageId), [reveal!.id, ...ctx.replies(first)], '朋友圈只带揭牌记录和揭牌之后真实发出的话');
    assert.deepEqual(projection?.actions?.map(action => [action.kind, action.cardNumber, action.status]), [
      ['selection', 7, 'committed'], ['selection', 3, 'failed'],
    ], '重试同一个号码不算第二次失败；改要另一个号码是一次被拒的二次选号');
    assert.deepEqual(projection?.terminal, { status: 'completed' });

    const second = await ctx.chat('再抽一张', [{ calls: define('look-2') }, { calls: draw('draw-second', 3) }, { text: '三号牌也给你看。' }]);
    const look2 = ctx.tools.filter(entry => entry.name === 'tool_define').at(-1)!.result.output as { deck_state: string; available_card_numbers: number[] };
    assert.deepEqual([look2.deck_state, look2.available_card_numbers], ['draw', [1, 2, 3, 4, 5, 6, 8, 9, 10]], '已抽的号码不再出现，其余号码保持原编号');
    assert.equal(ctx.projectionOf(second)?.card?.number, 3);
    assert.equal(ctx.projectionOf(first)?.card?.number, 7, '上一条朋友圈不被改写');

    // 心跳随后使用同一副牌：邀请里没有聊天已抽的号码，抽到的正是剩下的那张。
    new BackgroundSettingsService(host.db, ctx.config).applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 5 } });
    const stamp = new Date().toISOString();
    host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,?)")
      .run(JSON.stringify({ input_micro_per_token: 0.000003, output_micro_per_token: 0.000015 }), stamp);
    const window = host.windows.activeWindow('primary')!.id;
    const evidence = lastCacheEvidence(host.db, window);
    const anchor = host.db.prepare("SELECT last_real_activity_at FROM conversation_activity WHERE conversation_id='primary'").get() as { last_real_activity_at: string };
    assert.ok(evidence);
    const due = Math.max(Date.parse(evidence.startedAt), Date.parse(anchor.last_real_activity_at)) + 3_000_001;
    (host.scheduler as any).d.now = () => due;
    (host.supervisor as any).d.now = () => due;
    ctx.steps.push({ calls: draw('heartbeat-draw', 1) }, { text: '这次心跳抽到一号牌。' });
    await host.scheduler!.tick();
    const heartbeat = host.db.prepare("SELECT id,turn_id,result_code FROM background_runs WHERE kind='keepwarm' ORDER BY rowid DESC LIMIT 1").get() as { id: string; turn_id: string; result_code: string } | undefined;
    assert.ok(heartbeat, '心跳如期发生');
    assert.equal(heartbeat.result_code, 'complete:done');
    const invite = ctx.requests.find(request => request.heartbeat)!.lastUser;
    assert.match(invite, /可抽号码：1、2、4、5、6、8、9、10。/, '聊天抽过的 3、7 不再出现在心跳邀请里，其余号码保持原编号');
    assert.equal(cards.getDeliveredDraw(heartbeat.id)?.cardNumber, 1);
    assert.equal(ctx.projectionOf(heartbeat.id)?.origin, undefined, '心跳的朋友圈记录保持原样');
    assert.equal(ctx.projectionOf(heartbeat.id)?.card?.number, 1);
    assert.deepEqual(deck()?.deliveredNumbers, [1, 3, 7]);

    // 夜间、休息中和心跳总开关关闭只管自动唤醒，不管她正在进行的聊天。
    t.mock.timers.setTime(at('23:30'));
    assert.equal(activity.noteRestDecision('primary', { kind: 'rest', source: 'owner_message', messageId: 'fixture-goodnight', atIso: new Date().toISOString() }), true);
    new BackgroundSettingsService(host.db, ctx.config).applyUpdate({ expectedRevision: 1, patch: { keepwarm_enabled: false } });
    const night = await ctx.chat('夜里也想抽一张', [{ calls: define('look-night') }, { calls: draw('draw-night', 5) }, { text: '五号牌给你。' }]);
    assert.equal(cards.getDeliveredDraw(night)?.cardNumber, 5);
    assert.equal(ctx.projectionOf(night)?.card?.number, 5);
    assert.equal(activity.resting('primary'), true, '主动抽牌不解除休息');
    assert.equal(new BackgroundSettingsService(host.db, ctx.config).effective().keepwarm.enabled, false, '主动抽牌不打开心跳开关');
    const lookNight = ctx.tools.filter(entry => entry.name === 'tool_define').at(-1)!.result.output as { deck_state: string; available_card_numbers: number[] };
    assert.deepEqual([lookNight.deck_state, lookNight.available_card_numbers], ['draw', [2, 4, 5, 6, 8, 9, 10]], '夜里读到的是此刻真实的剩余号码：心跳和聊天抽过的都不在');
    assert.deepEqual(deck()?.availableNumbers, [2, 4, 6, 8, 9, 10], '抽走五号后，页面的今日牌组随之更新');

    // 后台任务不能换个名义抽牌：自主预约轮拿不到抽牌，直接到达处理函数同样被拒。
    host.db.prepare("INSERT INTO turns(id,conversation_id,trigger,state,created_at) VALUES ('wake-turn','primary','proactive_turn','running',?)").run(stamp);
    host.db.prepare("INSERT INTO attempts(id,turn_id,attempt_no,state,window_id,started_at) VALUES ('wake-attempt','wake-turn',1,'running',?,?)").run(host.windows.activeWindow('primary')!.id, stamp);
    host.db.prepare("INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at) VALUES ('wake-run','wake-task','primary','jiaming','autonomous',1,'chat-draw:wake','running',?,?)").run(stamp, stamp);
    const wakeScope = (toolCallId: string, requestId: string): ToolExecContext => ({
      roomId: 'primary', windowId: host.windows.activeWindow('primary')!.id, turnId: 'wake-turn', attemptId: 'wake-attempt', toolCallId,
      purpose: 'proactive_turn', backgroundRunId: 'wake-run', activeReviewId: null, seenSequence: 0, seenMessages: [], requestId,
      beforeBackgroundTool: () => undefined, // a background run always carries its admission callback
    });
    const bridge = (host.supervisor as any).d.tools;
    // A direct window offers the tool by name only within its scope; a deferred window reaches it through tool_invoke.
    const reach = (args: Record<string, unknown>) => lane === 'api-deferred'
      ? bridge.execute('tool_invoke', { name: 'heartbeat_draw', arguments: args }, wakeScope('wake-draw', 'wake-request'))
      : bridge.execute('heartbeat_draw', args, wakeScope('wake-draw', 'wake-request'));
    const denied: ToolExecResult = await reach({ card_number: 2 });
    assert.deepEqual(denied, { ok: false, output: { error_code: lane === 'api-deferred' ? 'HEARTBEAT_DRAW_NOT_ACTIVE' : 'TOOL_NOT_IN_WINDOW' } }, '预约轮拿不到抽牌');
    const handler = await host.heartbeat!.draw(2, wakeScope('wake-handler', 'wake-handler-request'));
    assert.deepEqual(handler, { ok: false, output: { error_code: 'HEARTBEAT_DRAW_NOT_ACTIVE' } }, '即使直接到达抽牌处理函数，后台任务同样被拒');
    assert.equal(cards.getRun('wake-turn'), null, '被拒绝的调用不会开启任何回合');
    host.db.prepare("UPDATE turns SET state='completed' WHERE id='wake-turn'").run();
    host.db.prepare("UPDATE attempts SET state='completed' WHERE id='wake-attempt'").run();
    host.db.prepare("UPDATE background_runs SET state='completed' WHERE id='wake-run'").run();
    const idleScope: ToolExecContext = { roomId: 'primary', windowId: host.windows.activeWindow('primary')!.id, turnId: null, attemptId: null, toolCallId: 'idle-draw',
      purpose: 'chat', activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: 'idle-request' };
    const idle: ToolExecResult = lane === 'api-deferred'
      ? await bridge.execute('tool_invoke', { name: 'heartbeat_draw', arguments: { card_number: 2 } }, idleScope)
      : await bridge.execute('heartbeat_draw', { card_number: 2 }, idleScope);
    assert.deepEqual(idle, { ok: false, output: { error_code: lane === 'api-deferred' ? 'HEARTBEAT_DRAW_NOT_ACTIVE' : 'TOOL_NOT_IN_WINDOW' } }, '没有正在回复的回合，就没有可抽的回合');
    assert.deepEqual(deck()?.deliveredNumbers, [1, 3, 5, 7]);
    assert.equal(host.db.prepare("SELECT count(*) n FROM outbox WHERE target='content_heartbeat_projection'").get()?.n, 4, '每次抽牌各有一条朋友圈记录，不重复建帖');
  });
}

test('聊天里抽完第十张：只被告知今天已抽完，不会在聊天里被要求回 1；下一次心跳才按原约定回 1', { timeout: 20000 }, async t => {
  const DAY = '2026-11-24';
  const ctx = await fixture(t, 'api', { now: Date.parse(`${DAY}T10:00:00+08:00`) });
  const { host, cards } = ctx;
  const sources: HeartbeatSource[] = Array.from({ length: 10 }, (_, index) => ({ kind: 'moments', namespace: 'content', id: `fixture-card-${index + 1}`, revision: 1,
    identity: `content:moments:fixture-card-${index + 1}`, permissionScope: 'primary' }));
  await ctx.chat('先聊两句', [{ text: '好呀。' }]);
  // 今天早些时候的九次心跳已经真实交付了 2 到 10 号。
  const stamp = new Date().toISOString();
  for (let number = 2; number <= 10; number++) {
    const runId = `earlier-heartbeat-${number}`;
    const requestId = `earlier-request-${number}`;
    host.db.prepare(`INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at)
      VALUES(?,'fixture-history','primary','jiaming','keepwarm',1,?,'running',?,?)`).run(runId, runId, stamp, stamp);
    const operation = { runId, operationId: `earlier-draw-${number}` };
    assert.equal(cards.begin({ runId, businessDate: DAY, candidates: sources })?.mode, 'draw');
    assert.equal(cards.claim({ ...operation, cardNumber: number }).status, 'claimed');
    assert.equal(cards.recordSource({ ...operation, result: 'ready' }).status, 'prepared');
    host.db.prepare(`INSERT INTO provider_requests(id,window_id,purpose,seen_manifest_json,payload_json,background_run_id,dispatch_started_at,sent_at,created_at)
      VALUES(?,?,'cache_keepalive','[]',?,?,?,?,?)`)
      .run(requestId, host.windows.activeWindow('primary')!.id, JSON.stringify({ messages: [{ role: 'tool', tool_call_id: operation.operationId,
        content: JSON.stringify({ heartbeat_card: { operation_id: operation.operationId } }) }] }), runId, stamp, stamp, stamp);
    assert.equal(cards.startDispatch({ ...operation, providerRequestId: requestId }), true);
    assert.equal(cards.recordDelivery({ ...operation, outcome: 'delivered', providerRequestId: requestId }), true);
    host.db.prepare("UPDATE background_runs SET state='completed' WHERE id=?").run(runId);
  }
  const last = await ctx.chat('把最后一张也抽了吧', [{ calls: draw('draw-last', 1) }, { text: '这是今天最后一张。' }]);
  assert.equal(cards.getDeliveredDraw(last)?.cardNumber, 1);
  assert.equal(cards.getDeck('primary', DAY)!.exhausted, true);
  const after = await ctx.chat('还有吗？再抽一张', [{ calls: define('look-done') }, { calls: draw('draw-done', 4) }, { text: '今天的牌都抽完了，明天再来。' }]);
  const look = ctx.tools.filter(entry => entry.name === 'tool_define').at(-1)!.result.output as { deck_state: string; available_card_numbers: number[] };
  assert.deepEqual([look.deck_state, look.available_card_numbers], ['exhausted', []]);
  const refused = ctx.tools.filter(entry => entry.name === 'heartbeat_draw').at(-1)!.result;
  assert.equal(refused.ok, false);
  assert.equal(refused.output.error_code, 'HEARTBEAT_DECK_EXHAUSTED');
  assert.equal(host.db.prepare("SELECT count(*) n FROM messages WHERE turn_id=? AND speaker='assistant' AND id IN (SELECT message_id FROM message_revisions WHERE revision=1 AND content='1')").get(after)?.n, 0, '聊天里不会被要求回 1');
  assert.equal(host.db.prepare("SELECT count(*) n FROM messages WHERE client_message_id LIKE 'heartbeat:%:invite' AND turn_id=?").get(after)?.n, 0);
  assert.equal(ctx.projectionOf(after), null, '没抽到牌的回合不产生朋友圈');

  // 下一次获准的心跳才进入回 1 保温。
  new BackgroundSettingsService(host.db, ctx.config).applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 5 } });
  host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,?)")
    .run(JSON.stringify({ input_micro_per_token: 0.000003, output_micro_per_token: 0.000015 }), stamp);
  const window = host.windows.activeWindow('primary')!.id;
  const evidence = lastCacheEvidence(host.db, window);
  const anchor = host.db.prepare("SELECT last_real_activity_at FROM conversation_activity WHERE conversation_id='primary'").get() as { last_real_activity_at: string };
  const due = Math.max(Date.parse(evidence!.startedAt), Date.parse(anchor.last_real_activity_at)) + 3_000_001;
  (host.scheduler as any).d.now = () => due;
  (host.supervisor as any).d.now = () => due;
  ctx.steps.push({ text: '1' });
  await host.scheduler!.tick();
  const heartbeat = host.db.prepare("SELECT id,turn_id,result_code FROM background_runs WHERE kind='keepwarm' AND task_id!='fixture-history' ORDER BY rowid DESC LIMIT 1").get() as { id: string; turn_id: string; result_code: string };
  assert.equal(heartbeat.result_code, 'ack_only');
  assert.match(ctx.requests.find(request => request.heartbeat)!.lastUser, /今天十张牌已经全部交付。请回复 1 保温。/);
  const ack = host.db.prepare("SELECT m.id, r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=1 WHERE turn_id=? AND speaker='assistant'").all(heartbeat.turn_id) as Array<{ id: string; content: string }>;
  assert.deepEqual(ack.map(row => row.content), ['1']);
  assert.equal(host.db.prepare("SELECT id FROM messages WHERE client_message_id=?").get(`heartbeat:${heartbeat.id}:ack`)?.id, ack[0]!.id);
  assert.equal(host.db.prepare("SELECT count(*) n FROM outbox WHERE operation_key=?").get(`heartbeat-moment:${heartbeat.id}`)?.n, 0, '回 1 保温不进朋友圈');
});

test('揭牌前已经发出的那句话不算对牌的回应；没有回应时只留卡面；中断留下的回合在恢复时补记一次', { timeout: 20000 }, async t => {
  const ctx = await fixture(t, 'api', { now: Date.parse('2026-11-24T11:00:00+08:00') });
  const { host, cards } = ctx;
  await ctx.chat('先聊两句', [{ text: '好呀。' }]);
  // 模型在要牌的同一句里先说了别的，抽完又接着回应，两段落在同一条气泡：这条气泡不是单纯对牌的回应。
  const mixed = await ctx.chat('顺手抽一张', [{ text: '我先把刚才那个 bug 修完。', calls: draw('draw-mixed', 6) }, { text: '修好了，顺便这张是六号牌。' }]);
  assert.equal(cards.getDeliveredDraw(mixed)?.cardNumber, 6);
  const said = (host.db.prepare("SELECT m.id, r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE turn_id=? AND speaker='assistant' ORDER BY sequence").all(mixed) as Array<{ id: string; content: string }>);
  assert.equal(said.length, 1, '聊天本身照常发出，只是一条气泡');
  assert.ok(said[0]!.content.startsWith('我先把刚才那个 bug 修完。') && said[0]!.content.endsWith('修好了，顺便这张是六号牌。'), said[0]!.content);
  const projection = ctx.projectionOf(mixed);
  assert.equal(projection?.state, 'drawn_no_comment', '关联不清楚时只留卡面');
  assert.equal(projection?.card?.number, 6);
  assert.deepEqual(projection?.messages.map(ref => ref.messageId), [
    (host.db.prepare("SELECT id FROM messages WHERE client_message_id=?").get(`heartbeat:${mixed}:card`) as { id: string }).id,
  ], '朋友圈不带这条夹着别的话题的气泡');
  // 抽牌之后另起的一句才是对牌的回应。
  const clean = await ctx.chat('也抽一张', [{ calls: draw('draw-clean', 4) }, { text: '四号牌给你看。' }]);
  assert.equal(ctx.projectionOf(clean)?.state, 'drawn');
  assert.deepEqual(ctx.projectionOf(clean)?.messages.map(ref => ref.messageId), [
    (host.db.prepare("SELECT id FROM messages WHERE client_message_id=?").get(`heartbeat:${clean}:card`) as { id: string }).id, ctx.replies(clean)[0]!,
  ]);
  // 抽完什么都没说：只留卡面，不编造回复。
  const quiet = await ctx.chat('再来一张', [{ calls: draw('draw-quiet', 3) }, { calls: [{ id: 'quiet-done', name: 'background_complete', args: { outcome: 'noop' } }] }]);
  assert.equal(cards.getDeliveredDraw(quiet)?.cardNumber, 3);
  assert.equal(ctx.projectionOf(quiet)?.state, 'drawn_no_comment');
  assert.equal(ctx.projectionOf(quiet)?.messages.length, 1);
  assert.equal(host.db.prepare("SELECT count(*) n FROM messages WHERE turn_id=? AND speaker='assistant'").get(quiet)?.n, 0);

  // 进程若在回合收口前中断，重启时按已落库的事实补记，且只补一次。
  const plain = await ctx.chat('再抽一张', [{ calls: draw('draw-plain', 9) }, { text: '九号牌。' }]);
  host.db.prepare("DELETE FROM outbox WHERE operation_key=?").run(`heartbeat-moment:${plain}`);
  (host.heartbeat as unknown as { recoverClosedRuns(): void }).recoverClosedRuns();
  (host.heartbeat as unknown as { recoverClosedRuns(): void }).recoverClosedRuns();
  const rows = host.db.prepare("SELECT payload_ref FROM outbox WHERE operation_key=?").all(`heartbeat-moment:${plain}`) as Array<{ payload_ref: string }>;
  assert.equal(rows.length, 1);
  assert.equal(readHeartbeatProjection(JSON.parse(rows[0]!.payload_ref))?.state, 'drawn');
  assert.deepEqual(cards.getDeck('primary', '2026-11-24')!.deliveredNumbers, [3, 4, 6, 9], '恢复不重新抽牌');
});

test('旧窗口的冻结定义早于聊天抽牌：定义原文不改写，读取时补一句说明并带出剩余号码；旧窗口里聊天和心跳都照常抽牌', { timeout: 20000 }, async t => {
  const ctx = await fixture(t, 'api', { now: Date.parse('2026-11-24T13:00:00+08:00') });
  const { host, cards } = ctx;
  await ctx.chat('先聊两句', [{ text: '好呀。' }]);
  const OLD_DEFINITION = '仅在本轮收到心跳抽卡邀请时选择一个可用号码。1 号揭 1 号牌。普通发言的数字不选号。';
  const window = host.windows.activeWindow('primary')!.id;
  const rewriteFrozenDescription = (description: string) => {
    const row = host.db.prepare('SELECT catalog_json FROM window_toolsets WHERE window_id=?').get(window) as { catalog_json: string };
    const catalog = JSON.parse(row.catalog_json) as Array<{ function: { name: string; description: string } }>;
    for (const tool of catalog) if (tool.function.name === 'heartbeat_draw') tool.function.description = description;
    host.db.prepare('UPDATE window_toolsets SET catalog_json=? WHERE window_id=?').run(JSON.stringify(catalog), window);
  };
  rewriteFrozenDescription(OLD_DEFINITION);
  const turn = await ctx.chat('我们抽一张看看', [{ calls: define('look-old') }, { calls: draw('draw-old', 8) }, { text: '八号牌。' }]);
  const look = ctx.tools.find(entry => entry.name === 'tool_define')!.result.output as { description: string; note?: string; deck_state: string; available_card_numbers: number[] };
  assert.equal(look.description, OLD_DEFINITION, '升级前冻结的定义原文保持不变');
  assert.match(String(look.note), /普通聊天里也可以直接调用/);
  assert.deepEqual([look.deck_state, look.available_card_numbers], ['not_built', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
  assert.equal(cards.getDeliveredDraw(turn)?.cardNumber, 8, '旧窗口里的聊天抽牌照常交付');

  // 同一个旧窗口里，心跳仍按原路径抽牌。
  new BackgroundSettingsService(host.db, ctx.config).applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 5 } });
  const stamp = new Date().toISOString();
  host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,?)")
    .run(JSON.stringify({ input_micro_per_token: 0.000003, output_micro_per_token: 0.000015 }), stamp);
  const evidence = lastCacheEvidence(host.db, window);
  const anchor = host.db.prepare("SELECT last_real_activity_at FROM conversation_activity WHERE conversation_id='primary'").get() as { last_real_activity_at: string };
  const due = Math.max(Date.parse(evidence!.startedAt), Date.parse(anchor.last_real_activity_at)) + 3_000_001;
  (host.scheduler as any).d.now = () => due;
  (host.supervisor as any).d.now = () => due;
  ctx.steps.push({ calls: draw('heartbeat-old-window', 2) }, { text: '心跳抽到二号牌。' });
  await host.scheduler!.tick();
  const heartbeat = host.db.prepare("SELECT id,result_code FROM background_runs WHERE kind='keepwarm' ORDER BY rowid DESC LIMIT 1").get() as { id: string; result_code: string };
  assert.equal(heartbeat.result_code, 'complete:done');
  assert.equal(cards.getDeliveredDraw(heartbeat.id)?.cardNumber, 2);
  assert.match(ctx.requests.find(request => request.heartbeat)!.lastUser, /可抽号码：1、2、3、4、5、6、7、9、10。/, '旧窗口的心跳邀请里没有聊天抽走的八号');

  // 定义已说明聊天可抽的新窗口不再需要这句补充。
  rewriteFrozenDescription('从今天的牌里抽一张。平时聊天里也可以直接调用。');
  await ctx.chat('再看一次号码', [{ calls: define('look-new') }, { text: '还剩这些。' }]);
  const fresh = ctx.tools.filter(entry => entry.name === 'tool_define').at(-1)!.result.output as { note?: string; available_card_numbers: number[] };
  assert.equal(fresh.note, undefined);
  assert.deepEqual(fresh.available_card_numbers, [1, 3, 4, 5, 6, 7, 9, 10]);
});

test('聊天里抽到许愿星：可以直接回应这颗星，再继续聊天；星回应和聊天各记各的', { timeout: 20000 }, async t => {
  const ctx = await fixture(t, 'api', { now: Date.parse('2026-11-24T15:00:00+08:00'), wishstar: true });
  const { host, cards } = ctx;
  const star = { id: 'star-shared-1', content: '合成共享星正文', author_name: '宿主用户', state: 'SHARED' };
  const forwarded: string[] = [];
  t.mock.method(WishstarClient.prototype, 'forward', async (method: string, path: string) => {
    forwarded.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/stars/shared') return { status: 200, body: { items: [star] } };
    if (method === 'POST' && path === '/api/stars/star-shared-1/responses') {
      return { status: 200, body: { id: 'resp-1', star_id: 'star-shared-1', type: 'text', responder_id: 'jiaming',
        created_at: '2026-11-24T07:00:01.000Z', text: '回应这张星。' } };
    }
    return { status: 404, body: {} };
  });
  const shared: HeartbeatSource = { kind: 'wishstar', namespace: 'superposition', id: star.id, revision: sha256Hex(JSON.stringify([star.content, star.author_name, star.note])),
    identity: `superposition:star:${star.id}`, permissionScope: 'primary' };
  t.mock.method(HeartbeatSources.prototype, 'choose', async (conversationId: string) => [
    shared, ...Array.from({ length: 9 }, (_, index): HeartbeatSource => ({ kind: 'moments', namespace: 'content', id: `fixture-card-${index + 2}`, revision: 1,
      identity: `content:moments:fixture-card-${index + 2}`, permissionScope: conversationId })),
  ]);
  // The fixture reads card text from its own list; the star goes through the real lookup and the mocked source service.
  const fixtureResolve = HeartbeatSources.prototype.resolve;
  t.mock.method(HeartbeatSources.prototype, 'resolve', function (this: HeartbeatSources, ...args: Parameters<typeof REAL_RESOLVE>) {
    return args[0].kind === 'wishstar' ? REAL_RESOLVE.apply(this, args) : fixtureResolve.apply(this, args);
  });
  await ctx.chat('先聊两句', [{ text: '好呀。' }]);
  const turn = await ctx.chat('抽一张看看', [
    { calls: draw('draw-star', 1) },
    { calls: [{ id: 'reply-star', name: 'wishstar_reply_star', args: { reply_ref: 'draw-star', text: '回应这张星。', idempotency_key: 'star-reply-once' } }] },
    { text: '我把想说的写到那颗星上了，这里也跟你说一句。' },
  ]);
  assert.equal(cards.getDeliveredDraw(turn)?.source.kind, 'wishstar');
  const drawn = ctx.tools.find(entry => entry.name === 'heartbeat_draw')!.result.output.heartbeat_card as { reply_ref?: string; card_number: number };
  assert.deepEqual([drawn.card_number, drawn.reply_ref], [1, 'draw-star'], '星牌的揭牌回执带上回应用的 reply_ref');
  const replied = ctx.tools.find(entry => entry.name === 'wishstar_reply_star')!.result;
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.ok(forwarded.includes('POST /api/stars/star-shared-1/responses'));
  assert.deepEqual(ctx.replies(turn).map(id => host.messages.getMessage(id)!.revision.content), ['我把想说的写到那颗星上了，这里也跟你说一句。'], '回应星不是聊天发言；聊天正文另发一条');
  const projection = ctx.projectionOf(turn);
  assert.equal(projection?.state, 'drawn');
  assert.deepEqual(projection?.actions?.map(action => [action.kind, action.status, action.source?.namespace]), [
    ['selection', 'committed', undefined], ['star_reply', 'committed', 'superposition:response'],
  ]);
  assert.equal(projection?.messages.length, 2, '揭牌记录和那句聊天；星的回应是动作记录，不是聊天消息');
});
