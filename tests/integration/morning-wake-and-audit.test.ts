// 晨间唤醒（08:00 基准 + 07:11:00 起真实前台聊天顺延）与在途跨界停止（审计 #1/#2）隔离验收测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { HeartbeatCards, type HeartbeatSource } from '../../apps/host/src/modules/heartbeat/service.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';
import { SirenAdapter } from '../../apps/host/src/integrations/siren/adapter.ts';

const enabledTimerContexts = new WeakSet<object>();
import { HeartbeatSources } from '../../apps/host/src/modules/heartbeat/sources.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import { keepwarmStatusText } from '../../apps/web/react/src/background-controls-model.ts';
import { readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import { installHeartbeatFixtureSources } from '../helpers/heartbeat-sources.ts';

type Step = {
  text?: string;
  timedText?: Array<{ text: string; at: string }>;
  calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  onTransport?: () => void | Promise<void>;
};

const MODEL = 'anthropic/claude-morning-fixture';
const USAGE = {
  prompt_tokens: 2000,
  completion_tokens: 8,
  prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 },
  cost: 0.001,
};
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

async function createMorningFixture(
  t: Pick<TestContext, 'after' | 'mock'>,
  initialIso: string,
  opts: { cardCount?: number; voiceTts?: boolean; listenHttp?: boolean; sleepWindowEnabled?: boolean } = {},
) {
  let nowMs = Date.parse(initialIso);
  if (!enabledTimerContexts.has(t)) {
    t.mock.timers.enable({ apis: ['Date'], now: nowMs });
    enabledTimerContexts.add(t);
  } else {
    t.mock.timers.setTime(nowMs);
  }
  const restoreSources = installHeartbeatFixtureSources();
  if (opts.cardCount !== undefined) {
    const count = opts.cardCount;
    t.mock.method(HeartbeatSources.prototype, 'choose', async (conversationId: string): Promise<HeartbeatSource[]> =>
      Array.from({ length: count }, (_, idx) => ({
        kind: 'moments',
        namespace: 'content',
        id: `fixture-card-${idx + 1}`,
        revision: 1,
        identity: `content:moments:fixture-card-${idx + 1}`,
        permissionScope: conversationId,
      })),
    );
  }
  const root = tempRoot('morning-wake-');
  writeApprovedIdentity(root);
  const steps: Step[] = [];
  const requests: Array<{ atIso: string; heartbeat: boolean; lastUser: string; messages: OrMessage[] }> = [];

  const setClock = (isoOrMs: string | number) => {
    nowMs = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
    t.mock.timers.setTime(nowMs);
    if (host?.scheduler) (host.scheduler as any).d.now = () => nowMs;
    if (host) (host.supervisor as any).d.now = () => nowMs;
  };

  let host: Host | undefined;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await host?.stop();
    restoreSources();
    fs.rmSync(root, { recursive: true, force: true });
  };
  t.after(stop);

  const runner = new OpenRouterRunner(
    { providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 },
    async (payload) => {
      const messages = payload.messages as OrMessage[];
      const lastUser = messages.findLast((m) => m.role === 'user');
      const text = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
      const step = steps.shift() ?? { text: '收到。' };
      await step.onTransport?.();
      requests.push({ atIso: new Date(nowMs).toISOString(), heartbeat: text.includes('[心跳唤醒]'), lastUser: text, messages: structuredClone(messages) });
      const calls = step.calls ?? [];
      const delta = {
        ...(step.text !== undefined ? { content: step.text } : {}),
        ...(calls.length
          ? { tool_calls: calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      };
      async function* frames() {
        if (step.timedText) {
          for (const part of step.timedText) {
            setClock(part.at);
            yield sse({ id: `morning-${requests.length}`, choices: [{ delta: { content: part.text } }] });
            await new Promise<void>(resolve => setImmediate(resolve));
          }
        } else {
          yield sse({ id: `morning-${requests.length}`, choices: [{ delta }] });
        }
        yield sse({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: USAGE });
        yield 'data: [DONE]\n\n';
      }
      return {
        status: 200,
        headers: new Headers({ 'x-generation-id': `morning-${requests.length}` }),
        body: Readable.from(frames()),
      };
    },
  );

  const ready = readyRuntimePatch();
  if (opts.voiceTts) process.env.EST_TEST_SIREN_TOKEN = 'test-siren-token';
  const config = buildConfig({
    ...ready,
    runtime: { ...(ready.runtime as object), provider: 'mock', tool_schema_mode: 'direct' },
    openrouter: { model: MODEL },
    background: { keepwarm: { sleep_window: { enabled: opts.sleepWindowEnabled ?? true, start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' } } },
    windows: { model_context_capacity: 150_000 },
    ...(opts.voiceTts ? { integrations: { siren: { base_url: 'http://127.0.0.1:18790', credential_ref: 'EST_TEST_SIREN_TOKEN', contract_version: '1.1.1' } } } : {}),
  });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0, runnerOverride: runner });
  const { residentToolNames } = await import('../../apps/host/src/runtime/tool-resident-guides.ts');
  const { makeFixtureToolsResident } = await import('../helpers.ts');
  makeFixtureToolsResident(host.db, [...residentToolNames, 'background_complete', 'chat_send_text', ...(opts.voiceTts ? ['chat_send_voice'] : [])]);
  if (opts.listenHttp) await host.start();
  else host.scheduler!.start();
  setClock(nowMs);

  const stamp = new Date(nowMs).toISOString();
  host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,?)")
    .run(JSON.stringify({ input_micro_per_token: 0.000003, output_micro_per_token: 0.000015 }), stamp);
  const bgSettings = new BackgroundSettingsService(host.db, config);
  bgSettings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 5 } });

  const chatAt = async (userIso: string, content: string, replyText = '好呀。', replyIso?: string) => {
    setClock(userIso);
    host!.messages.ensureConversation('primary');
    steps.push({
      text: replyText,
      ...(replyIso ? { onTransport: () => setClock(replyIso) } : {}),
    });
    const sub = host!.messages.submitUserMessageWithTurn({
      conversationId: 'primary',
      content,
      clientMessageId: `msg-${requests.length}-${nowMs}`,
    });
    host!.supervisor.enqueue(sub.turnId);
    await host!.supervisor.waitIdle();
    return sub;
  };

  const activity = new ConversationActivityService(host.db);
  const heartbeatRequests = () => requests.filter((r) => r.heartbeat);

  return { root, host, stop, activity, config, bgSettings, steps, requests, heartbeatRequests, setClock, chatAt, getNowMs: () => nowMs };
}

test('A1：22:00 未晚安→22:50 派发；22:00 晚安→22:50 零派发；22:10 与 22:11 未晚安→23:00/23:01 零派发', { timeout: 20000 }, async (t) => {
  const cases: Array<{ label: string; chatIso: string; text: string; checkIso: string; expectedHeartbeats: number }> = [
    { label: '22:00 未晚安', chatIso: '2026-11-24T22:00:00+08:00', text: '今天先聊到这儿', checkIso: '2026-11-24T22:50:01+08:00', expectedHeartbeats: 1 },
    { label: '22:00 明确晚安', chatIso: '2026-11-24T22:00:00+08:00', text: '晚安，我睡了', checkIso: '2026-11-24T22:50:01+08:00', expectedHeartbeats: 0 },
    { label: '22:10 未晚安', chatIso: '2026-11-24T22:10:00+08:00', text: '先去洗漱', checkIso: '2026-11-24T23:00:00+08:00', expectedHeartbeats: 0 },
    { label: '22:11 未晚安', chatIso: '2026-11-24T22:11:00+08:00', text: '把灯调暗一点', checkIso: '2026-11-24T23:01:00+08:00', expectedHeartbeats: 0 },
  ];
  for (const item of cases) {
    const fx = await createMorningFixture(t, item.chatIso);
    await fx.chatAt(item.chatIso, item.text, '收到。');
    fx.steps.push({ calls: [{ id: 'hb-noop', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock(item.checkIso);
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, item.expectedHeartbeats, item.label);
    await fx.stop();
  }
});

test('A2（v2.1）：昨晚晚安两步抽牌发言、昨晚未晚安冷缓存、凌晨短间隔续聊均在 08:00 首发第 1 轮，随后按统一 50 分钟循环进入第 2 轮', { timeout: 25000 }, async (t) => {
  // 1) 昨晚晚安 + 次日 08:00 两步晨唤（抽牌 + 发言）：第 2 步不被昨晚夜休拦截，计为连续第 1 次；08:50 合法启动第 2 轮
  {
    const fx = await createMorningFixture(t, '2026-11-24T21:40:00+08:00');
    await fx.chatAt('2026-11-24T21:40:00+08:00', '晚安，我睡了', '晚安，好梦。');
    assert.equal(fx.activity.resting('primary'), true);

    fx.setClock('2026-11-25T07:59:59+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '07:59:59 零首发');

    fx.steps.push(
      { calls: [{ id: 'mw-draw-1', name: 'heartbeat_draw', args: { card_number: 2 } }] },
      { text: '早安前先悄悄看了一眼二号牌，等你睡醒再看。' },
    );
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 2, '晨间两步（首轮邀请 + 揭牌续轮）均未被昨晚休息拦截');
    assert.match(fx.heartbeatRequests()[0]!.lastUser, /这是今天的晨间活动机会/);
    const run = fx.host.db.prepare("SELECT id, turn_id, occurrence_key, state, published_message_count FROM background_runs WHERE kind='keepwarm' ORDER BY rowid DESC LIMIT 1")
      .get() as { id: string; turn_id: string; occurrence_key: string; state: string; published_message_count: number };
    assert.equal(run.occurrence_key, 'morning-wake:primary:2026-11-25');
    assert.equal(run.state, 'completed');
    assert.equal(run.published_message_count, 1, '晨间发言未被旧 resting 扣留');
    assert.equal(fx.activity.resting('primary'), false, 'v2.1：次晨 08:00 触发后正常夜休结束，进入当日自动循环');
    assert.equal(fx.activity.get('primary')!.consecutive_unanswered_count, 1, '同轮多步只计为连续第 1 次');

    fx.steps.push({ calls: [{ id: 'mw-r2-noop', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T08:50:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 3, 'v2.1：08:50 合法启动第 2 轮');
    assert.equal(fx.activity.get('primary')!.consecutive_unanswered_count, 2);
    await fx.stop();
  }

  // 2) 昨晚未晚安但隔夜缓存已冷（22:15 停聊）→ 08:00 第 1 轮，08:50 第 2 轮
  {
    const fx = await createMorningFixture(t, '2026-11-24T22:15:00+08:00');
    await fx.chatAt('2026-11-24T22:15:00+08:00', '先去忙点事', '好。');
    assert.equal(fx.activity.resting('primary'), false);
    fx.setClock('2026-11-25T07:59:59+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0);

    fx.steps.push({ text: '早上好呀，今天太阳出来了。' });
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1);
    assert.equal(fx.activity.get('primary')!.consecutive_unanswered_count, 1);

    fx.steps.push({ calls: [{ id: 'mw-r2-noop-2', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T08:50:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 2, 'v2.1：08:50 合法启动第 2 轮');
    assert.equal(fx.activity.get('primary')!.consecutive_unanswered_count, 2);
    await fx.stop();
  }

  // 3) 凌晨 00:55 / 01:00 短间隔续聊（<4h）→ 保持夜间暂停、01:50 零派发、保留 08:00 兜底
  {
    const fx = await createMorningFixture(t, '2026-11-25T00:55:00+08:00');
    await fx.chatAt('2026-11-25T00:55:00+08:00', '先喝口水', '好呀。');
    await fx.chatAt('2026-11-25T01:00:00+08:00', '半夜醒来喝口水', '快接着睡吧。', '2026-11-25T01:02:00+08:00');
    fx.setClock('2026-11-25T01:52:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '夜间间隔不足 4 小时保持暂停');
    fx.setClock('2026-11-25T07:59:59+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0);

    fx.steps.push({ calls: [{ id: 'mw-noop-3', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1);
    await fx.stop();
  }
});

test('A3（v2.1）：夜间满四小时提前恢复后 07:11→08:01、07:09/07:12→08:02、连续聊天→09:10、08:00 抢先→08:50:05', { timeout: 30000 }, async (t) => {
  const matrix: Array<{ chatIso: string; beforeIso: string; dueIso: string }> = [
    { chatIso: '2026-11-25T07:11:00+08:00', beforeIso: '2026-11-25T08:00:59+08:00', dueIso: '2026-11-25T08:01:00+08:00' },
    { chatIso: '2026-11-25T07:11:30+08:00', beforeIso: '2026-11-25T08:01:29+08:00', dueIso: '2026-11-25T08:01:30+08:00' },
    { chatIso: '2026-11-25T07:20:00+08:00', beforeIso: '2026-11-25T08:09:59+08:00', dueIso: '2026-11-25T08:10:00+08:00' },
    { chatIso: '2026-11-25T07:40:00+08:00', beforeIso: '2026-11-25T08:29:59+08:00', dueIso: '2026-11-25T08:30:00+08:00' },
    { chatIso: '2026-11-25T07:50:00+08:00', beforeIso: '2026-11-25T08:39:59+08:00', dueIso: '2026-11-25T08:40:00+08:00' },
  ];

  for (const row of matrix) {
    const fx = await createMorningFixture(t, '2026-11-24T22:30:00+08:00');
    await fx.chatAt('2026-11-24T22:30:00+08:00', '昨晚停聊', '晚安前最后一句');
    await fx.chatAt(row.chatIso, '早起说一句', '嗯嗯。');
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, `${row.chatIso} 提前恢复后不在 08:00 另外插一轮`);
    fx.setClock(row.beforeIso);
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, `${row.chatIso} 在 ${row.beforeIso} 零首发`);

    fx.steps.push({ calls: [{ id: 'mw-matrix', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock(row.dueIso);
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, `${row.chatIso} 在 ${row.dueIso} 恰好一次首发`);
    await fx.stop();
  }

  // 07:09 用户发话（满 4h 提前恢复）、07:12 前台助手正式回复 → 08:02 自动心跳；不另外插 08:00 兜底
  {
    const fx = await createMorningFixture(t, '2026-11-24T22:30:00+08:00');
    await fx.chatAt('2026-11-24T22:30:00+08:00', '昨晚停聊', '好。');
    const sub = await fx.chatAt('2026-11-25T07:09:00+08:00', '早起问个问题', '我想好了，给你答复。', '2026-11-25T07:12:00+08:00');
    const winId = fx.host.windows.activeWindow('primary')!.id;
    const sched = fx.activity.evaluateHeartbeatSchedule({
      conversationId: 'primary', windowId: winId, sleepWindow: fx.config.background.keepwarm.sleep_window,
      keepwarmEnabled: true, nowMs: Date.parse('2026-11-25T07:50:00+08:00'),
    });
    assert.equal(sched.scheduled, true);
    assert.equal(sched.dueAtMs, Date.parse('2026-11-25T08:02:00+08:00'));

    fx.setClock('2026-11-25T08:01:59+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '08:01:59 零首发');

    fx.steps.push({ calls: [{ id: 'mw-0802', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T08:02:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, '08:02:00 唯一首发');
    assert.ok(sub.message.id);
    await fx.stop();
  }

  // 07:11 → 07:40 → 08:20 连续真实聊天：先排 08:01，再排 08:30，最终仅 09:10 首发
  {
    const fx = await createMorningFixture(t, '2026-11-24T22:30:00+08:00');
    await fx.chatAt('2026-11-24T22:30:00+08:00', '昨晚聊过', '好。');
    const winId = () => fx.host.windows.activeWindow('primary')!.id;
    const sw = fx.config.background.keepwarm.sleep_window;

    await fx.chatAt('2026-11-25T07:11:00+08:00', '第一句', '回第一句');
    assert.equal(
      fx.activity.evaluateHeartbeatSchedule({ conversationId: 'primary', windowId: winId(), sleepWindow: sw, keepwarmEnabled: true, nowMs: fx.getNowMs() }).dueAtMs,
      Date.parse('2026-11-25T08:01:00+08:00'),
    );

    await fx.chatAt('2026-11-25T07:40:00+08:00', '第二句', '回第二句');
    assert.equal(
      fx.activity.evaluateHeartbeatSchedule({ conversationId: 'primary', windowId: winId(), sleepWindow: sw, keepwarmEnabled: true, nowMs: fx.getNowMs() }).dueAtMs,
      Date.parse('2026-11-25T08:30:00+08:00'),
    );

    fx.setClock('2026-11-25T08:01:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '08:01 旧目标已失效');

    await fx.chatAt('2026-11-25T08:20:00+08:00', '第三句', '回第三句');
    assert.equal(
      fx.activity.evaluateHeartbeatSchedule({ conversationId: 'primary', windowId: winId(), sleepWindow: sw, keepwarmEnabled: true, nowMs: fx.getNowMs() }).dueAtMs,
      Date.parse('2026-11-25T09:10:00+08:00'),
    );

    fx.setClock('2026-11-25T08:30:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '08:30 旧目标已失效');

    fx.steps.push({ calls: [{ id: 'mw-0910', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T09:10:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, '09:10 唯一首发');
    assert.match(fx.heartbeatRequests()[0]!.lastUser, /09:10/);
    await fx.stop();
  }

  // 08:00:00 新用户输入先于晨间首发被正式接受 → 08:00 零派发，目标顺延至 08:50:05（回复时间+50m）
  {
    const fx = await createMorningFixture(t, '2026-11-24T22:00:00+08:00');
    await fx.chatAt('2026-11-24T22:00:00+08:00', '昨晚聊过一句', '好。');

    fx.setClock('2026-11-25T08:00:00+08:00');
    const sub = fx.host.messages.submitUserMessageWithTurn({
      conversationId: 'primary',
      content: '八点整我先开口啦',
      clientMessageId: 'race-0800-user',
    });
    fx.host.scheduler!.notePendingUserChat();
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '08:00 先接受用户输入时晨间零首发');

    fx.steps.push({ text: '八点零五秒回复你。', onTransport: () => fx.setClock('2026-11-25T08:00:05+08:00') });
    fx.host.supervisor.enqueue(sub.turnId);
    await fx.host.supervisor.waitIdle();

    const sched = fx.activity.evaluateHeartbeatSchedule({
      conversationId: 'primary',
      windowId: fx.host.windows.activeWindow('primary')!.id,
      sleepWindow: fx.config.background.keepwarm.sleep_window,
      keepwarmEnabled: true,
      nowMs: fx.getNowMs(),
    });
    assert.equal(sched.scheduled, true);
    assert.equal(sched.dueAtMs, Date.parse('2026-11-25T08:50:05+08:00'));

    fx.steps.push({ calls: [{ id: 'mw-085005', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T08:50:05+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, '08:50:05 唯一首发');
    await fx.stop();
  }
});

test('A4：总开关关闭零首发、恢复休息不偷开总开关、顺延期间重启恢复、首发后插话让位不重开本日机会、次日独立晨间机会、卡源不足与十张抽满晨间自然口径', { timeout: 30000 }, async (t) => {
  // 1) 总开关关闭 + 恢复休息不偷开总开关
  {
    const fx = await createMorningFixture(t, '2026-11-24T21:40:00+08:00');
    await fx.chatAt('2026-11-24T21:40:00+08:00', '晚安，我睡了', '晚安。');
    const rev = fx.bgSettings.effective().revision;
    fx.bgSettings.applyUpdate({ expectedRevision: rev, patch: { keepwarm_enabled: false } });
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '总开关关闭时晨间零首发');

    fx.activity.resumeRest('primary', { actorId: 'qiaosheng', operationId: 'resume-while-disabled' });
    assert.equal(fx.activity.resting('primary'), false);
    assert.equal(fx.bgSettings.effective().keepwarm.enabled, false, '恢复休息不偷开总开关');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0);
    await fx.stop();
  }

  // 2) 提前恢复后重启恢复 + 首发后用户插话让位 + 下一上海业务日独立机会
  {
    const fx = await createMorningFixture(t, '2026-11-24T22:30:00+08:00');
    await fx.chatAt('2026-11-24T22:30:00+08:00', '昨晚聊过', '好。');
    await fx.chatAt('2026-11-25T07:40:00+08:00', '早起聊一句', '好呀。');
    fx.setClock('2026-11-25T08:10:00+08:00');
    fx.host.scheduler!.recoverOnStart();
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '重启后在 08:10 不提前派发');

    // 08:30 首发后，在工具步骤期间用户插话 → 让位收口
    fx.steps.push({
      calls: [{ id: 'mw-draw-yield', name: 'heartbeat_draw', args: { card_number: 1 } }],
      onTransport: () => {
        fx.host.scheduler!.notePendingUserChat();
      },
    });
    fx.setClock('2026-11-25T08:30:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, '08:30 首发一次后因用户插话让位，不再发续轮');

    fx.setClock('2026-11-25T08:40:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, '08:40 不重复重开');

    // 下一上海业务日 08:00 有独立晨间机会
    fx.steps.push({ calls: [{ id: 'mw-next-day', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-26T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 2, '次日 08:00 享有独立晨间机会');
    await fx.stop();
  }

  // 3) 卡源不足十张（仅 3 张）时：晨间仍给一次活动机会，如实说明不能抽牌，不虚构十张牌
  {
    const fx = await createMorningFixture(t, '2026-11-24T22:20:00+08:00', { cardCount: 3 });
    await fx.chatAt('2026-11-24T22:20:00+08:00', '睡前聊一句', '好。');
    fx.steps.push({ text: '今天虽然没凑齐牌，还是跟你说声早安。' });
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1);
    assert.match(fx.heartbeatRequests()[0]!.lastUser, /凑不够十张可用卡源，本轮不能抽牌/);
    assert.doesNotMatch(fx.heartbeatRequests()[0]!.lastUser, /可抽号码/);
    const published = fx.host.db.prepare("SELECT r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.speaker='assistant' ORDER BY m.sequence DESC LIMIT 1")
      .get() as { content: string };
    assert.equal(published.content, '今天虽然没凑齐牌，还是跟你说声早安。');
    await fx.stop();
  }

  // 4) 当日十张牌已在凌晨聊天抽满（exhausted_keepwarm）：晨间不要求回 1，允许正常说话或安静结束
  {
    const fx = await createMorningFixture(t, '2026-11-25T00:30:00+08:00');
    await fx.chatAt('2026-11-25T00:30:00+08:00', '先建个窗', '好。');
    const cards = new HeartbeatCards(fx.host.db);
    const sources: HeartbeatSource[] = Array.from({ length: 10 }, (_, idx) => ({
      kind: 'moments', namespace: 'content', id: `fixture-card-${idx + 1}`, revision: 1,
      identity: `content:moments:fixture-card-${idx + 1}`, permissionScope: 'primary',
    }));
    const stamp = new Date(fx.getNowMs()).toISOString();
    const winId = fx.host.windows.activeWindow('primary')!.id;
    for (let n = 1; n <= 10; n++) {
      const runId = `early-draw-${n}`;
      const reqId = `early-prq-${n}`;
      fx.host.db.prepare("INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at) VALUES(?,'early','primary','jiaming','keepwarm',1,?,'running',?,?)")
        .run(runId, runId, stamp, stamp);
      cards.begin({ runId, businessDate: '2026-11-25', candidates: sources });
      cards.claim({ runId, operationId: `op-${n}`, cardNumber: n });
      cards.recordSource({ runId, operationId: `op-${n}`, result: 'ready' });
      const payload = JSON.stringify({ messages: [{ role: 'tool', tool_call_id: `op-${n}`, content: JSON.stringify({ heartbeat_card: { operation_id: `op-${n}` } }) }] });
      fx.host.db.prepare("INSERT INTO provider_requests(id,window_id,purpose,seen_manifest_json,payload_json,background_run_id,dispatch_started_at,created_at) VALUES(?,?,'cache_keepalive','[]',?,?,?,?)")
        .run(reqId, winId, payload, runId, stamp, stamp);
      assert.equal(cards.startDispatch({ runId, operationId: `op-${n}`, providerRequestId: reqId }), true);
      fx.host.db.prepare('UPDATE provider_requests SET sent_at=? WHERE id=?').run(stamp, reqId);
      assert.equal(cards.recordDelivery({ runId, operationId: `op-${n}`, outcome: 'delivered', providerRequestId: reqId }), true);
      fx.host.db.prepare("UPDATE background_runs SET state='completed' WHERE id=?").run(runId);
    }

    fx.steps.push({ calls: [{ id: 'mw-exhausted-quiet', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1);
    assert.match(fx.heartbeatRequests()[0]!.lastUser, /今天十张牌已经全部交付，本轮不能再抽牌/);
    assert.doesNotMatch(fx.heartbeatRequests()[0]!.lastUser, /请回复 1/);
    const lastRun = fx.host.db.prepare("SELECT state, result_code FROM background_runs WHERE occurrence_key='morning-wake:primary:2026-11-25'")
      .get() as { state: string; result_code: string };
    assert.equal(lastRun.state, 'noop');
    assert.equal(lastRun.result_code, 'complete:noop');
    await fx.stop();
  }
});

test('A4（v2.1）：晨间首发前接纳聊天使机会取消并转入 50m 循环，通话让位结束后正常执行', { timeout: 20000 }, async (t) => {
  const fx = await createMorningFixture(t, '2026-11-24T22:20:00+08:00', { sleepWindowEnabled: false });
  await fx.chatAt('2026-11-24T22:20:00+08:00', '睡前说一句。', '好。');

  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const choose = HeartbeatSources.prototype.choose;
  t.mock.method(HeartbeatSources.prototype, 'choose', async function (this: HeartbeatSources, ...args: Parameters<typeof choose>) {
    started.resolve();
    await resume.promise;
    return choose.apply(this, args);
  });

  fx.setClock('2026-11-25T08:00:00+08:00');
  const tick = fx.host.scheduler!.tick();
  try {
    await started.promise;
    const sub = fx.host.messages.submitUserMessageWithTurn({
      conversationId: 'primary',
      content: '我刚醒。',
      clientMessageId: 'chat-before-morning-dispatch',
    });
    fx.host.scheduler!.notePendingUserChat();
    fx.host.supervisor.enqueue(sub.turnId);
  } finally {
    resume.resolve();
    await tick;
  }
  await fx.host.supervisor.waitIdle();
  assert.equal(fx.heartbeatRequests().length, 0);
  const oldOccurrence = fx.host.db.prepare(`SELECT r.occurrence_key,
    (SELECT COUNT(*) FROM background_dispatches d WHERE d.run_id = r.id) AS dispatches
    FROM background_runs r WHERE r.kind = 'keepwarm'`).get() as { occurrence_key: string; dispatches: number };
  assert.match(oldOccurrence.occurrence_key, /^morning-wake:primary:2026-11-25:deferred:/);
  assert.equal(oldOccurrence.dispatches, 0);

  fx.setClock('2026-11-25T08:49:59+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 0);

  // 08:50 通话进行中 → 让位零派发；08:51 挂断 → 正常启动
  const nowIso = new Date(fx.getNowMs()).toISOString();
  fx.host.db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at) VALUES ('morning-call','primary','active',?)").run(nowIso);
  fx.steps.push({ calls: [{ id: 'morning-after-chat', name: 'background_complete', args: { outcome: 'noop' } }] });
  fx.setClock('2026-11-25T08:50:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 0, '通话开始但未说话，不该在预计时间发出心跳请求');
  fx.setClock('2026-11-25T08:51:00+08:00');
  fx.host.db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id='morning-call'").run(new Date(fx.getNowMs()).toISOString());
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 1);
  assert.match(fx.heartbeatRequests()[0]!.lastUser, /08:51/);
  await fx.stop();
});

test('A4（v2.1）：真正离线错过 08:00 宽限（+09:59 可发，+10:00 错过）；助手分段发布推进统一 50 分钟目标', { timeout: 15000 }, async (t) => {
  for (const [now, canDispatch] of [['08:09:59', true], ['08:10:00', false]] as const) {
    const fx = await createMorningFixture(t, '2026-11-24T22:20:00+08:00');
    await fx.chatAt('2026-11-24T22:20:00+08:00', '晚安，我睡了', '好。');
    fx.steps.push({ calls: [{ id: 'morning-late-complete', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock(`2026-11-25T${now}+08:00`);
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, Number(canDispatch), `08:00 基准离线至 ${now}`);
    await fx.stop();
  }
  const fx = await createMorningFixture(t, '2026-11-24T22:30:00+08:00');
  await fx.chatAt('2026-11-24T22:30:00+08:00', '昨晚聊过', '好。');
  fx.setClock('2026-11-25T07:40:00+08:00');
  fx.host.messages.ensureConversation('primary');
  fx.steps.push({ timedText: [
    { text: '先给你一段。\n\n', at: '2026-11-25T08:39:59+08:00' },
    { text: '这是第二段。', at: '2026-11-25T08:40:01+08:00' },
  ] });
  const submission = fx.host.messages.submitUserMessageWithTurn({
    conversationId: 'primary', content: '早起问一句。', clientMessageId: 'two-published-revisions',
  });
  fx.host.supervisor.enqueue(submission.turnId);
  await fx.host.supervisor.waitIdle();
  const revisions = fx.host.db.prepare(`SELECT r.received_at FROM messages m JOIN message_revisions r ON r.message_id = m.id
    WHERE m.turn_id = ? AND r.source = 'assistant_publish' ORDER BY r.revision`)
    .all(submission.turnId).map(row => row.received_at);
  assert.deepEqual(revisions, ['2026-11-25T00:39:59.000Z', '2026-11-25T00:40:01.000Z']);
  const sched = fx.activity.evaluateHeartbeatSchedule({
    conversationId: 'primary', windowId: fx.host.windows.activeWindow('primary')!.id,
    sleepWindow: fx.config.background.keepwarm.sleep_window, keepwarmEnabled: true, nowMs: fx.getNowMs(),
  });
  assert.equal(sched.scheduled, true);
  assert.equal(sched.dueAtMs, Date.parse('2026-11-25T09:30:01+08:00'));
  await fx.stop();
});

test('A5：仍要求有效窗口和预算，零模型首发', { timeout: 15000 }, async (t) => {
  const fx = await createMorningFixture(t, '2026-11-25T08:00:00+08:00');
  assert.equal(fx.host.windows.activeWindow('primary'), null);
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 0);
  await fx.chatAt('2026-11-25T08:01:00+08:00', '早上好。', '早上好。');
  fx.host.db.prepare("UPDATE runtime_settings SET value=? WHERE key='or_model_price'")
    .run(JSON.stringify({ input_micro_per_token: 1, output_micro_per_token: 1 }));
  fx.bgSettings.applyUpdate({ expectedRevision: fx.bgSettings.revision(), patch: { keepwarm_daily_cost_cap_usd: 0.000001 } });
  fx.setClock('2026-11-25T08:51:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 0);
  const run = fx.host.db.prepare("SELECT result_code, model_requests_started FROM background_runs WHERE kind='keepwarm' ORDER BY rowid DESC LIMIT 1")
    .get() as { result_code: string; model_requests_started: number };
  assert.deepEqual({ ...run }, { result_code: 'BACKGROUND_BUDGET_EXHAUSTED', model_requests_started: 0 });
  await fx.stop();
});

test('A5（审计 #1 与 #2）：22:59 语音跨 23:00 合成完成保留资产与费用但不发聊天；22:59 异步读卡源跨 23:00 落 not_dispatched 且零续发零扣费', { timeout: 25000 }, async (t) => {
  // 审计 #2：卡源异步复核跨过 23:00:00 → not_dispatched + dispatch_started_at=NULL + 预占 0 结算 + 零续请求
  {
    const fx = await createMorningFixture(t, '2026-11-24T22:09:58+08:00');
    await fx.chatAt('2026-11-24T22:09:58+08:00', '聊一句', '好。');

    const origResolve = fx.host.heartbeat!.sources.resolve.bind(fx.host.heartbeat!.sources);
    let resolveCount = 0;
    fx.host.heartbeat!.sources.resolve = async (...args) => {
      resolveCount++;
      const res = await origResolve(...args);
      // 第一次是 draw() 内部（22:59:59），第二次是 beforeDispatch 异步复核（返回时已到 23:00:01）
      if (resolveCount === 2) {
        fx.setClock('2026-11-24T23:00:01+08:00');
      }
      return res;
    };

    fx.steps.push(
      { calls: [{ id: 'cross-2300-draw', name: 'heartbeat_draw', args: { card_number: 4 } }] },
      { text: '如果跨夜没拦住才会看到这句' },
    );
    fx.setClock('2026-11-24T22:59:59+08:00');
    await fx.host.scheduler!.tick();

    assert.equal(fx.heartbeatRequests().length, 1, '只发出 22:59:59 首轮请求，跨 23:00 的续轮卡面未传输');
    const op = fx.host.db.prepare("SELECT state, provider_request_id FROM heartbeat_draw_operations WHERE operation_id='cross-2300-draw'")
      .get() as { state: string; provider_request_id: string | null };
    assert.equal(op.state, 'not_dispatched', '卡面落 not_dispatched，不消费 4 号牌');
    assert.equal(op.provider_request_id, null);
    const cards = new HeartbeatCards(fx.host.db);
    assert.ok(cards.getDeck('primary', '2026-11-24')!.availableNumbers.includes(4), '4 号牌仍在可用列表');

    const unsentPrq = fx.host.db.prepare("SELECT dispatch_started_at, sent_at FROM provider_requests WHERE purpose='cache_keepalive' ORDER BY rowid DESC LIMIT 1")
      .get() as { dispatch_started_at: string | null; sent_at: string | null };
    assert.equal(unsentPrq.dispatch_started_at, null);
    assert.equal(unsentPrq.sent_at, null);
    const blockedDispatch = fx.host.db.prepare("SELECT state, actual_cost_micro_usd FROM background_dispatches WHERE logical_action_key='model:r1:a0'")
      .get() as { state: string; actual_cost_micro_usd: number };
    assert.equal(blockedDispatch.state, 'settled');
    assert.equal(blockedDispatch.actual_cost_micro_usd, 0);
    await fx.stop();
  }

  // 审计 #1：22:59:58 发起 chat_send_voice，TTS 异步合成在 23:00:01 返回 → 音频已保存、费用保留，但 published=false，零聊天消息发出
  {
    const fx = await createMorningFixture(t, '2026-11-24T22:09:57+08:00', { voiceTts: true });
    await fx.chatAt('2026-11-24T22:09:57+08:00', '聊一句', '好。');
    fx.host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('background_tool_prices',?,?)")
      .run(JSON.stringify({ chat_send_voice: { max_cost_micro_usd: 50000 } }), new Date(fx.getNowMs()).toISOString());

    const wavHeader = Buffer.alloc(44);
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36, 4);
    wavHeader.write('WAVEfmt ', 8);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(1, 22);
    wavHeader.writeUInt32LE(16000, 24);
    wavHeader.writeUInt32LE(32000, 28);
    wavHeader.writeUInt16LE(2, 32);
    wavHeader.writeUInt16LE(16, 34);
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(0, 40);

    t.mock.method(SirenAdapter.prototype, 'synthesize', async () => {
      fx.setClock('2026-11-24T23:00:01+08:00');
      return { bytes: new Uint8Array(wavHeader), mime: 'audio/wav', format: 'wav', durationMs: 1000, profileId: 'mock-voice' };
    });

    const { VoiceSendService } = await import('../../apps/host/src/modules/voice/voice-send.ts');
    const originalSend = VoiceSendService.prototype.send;
    const outcomes: Array<{ ok: boolean; error?: Record<string, unknown> }> = [];
    t.mock.method(VoiceSendService.prototype, 'send', async function (this: InstanceType<typeof VoiceSendService>, ...args: Parameters<typeof originalSend>) {
      const outcome = await originalSend.apply(this, args);
      outcomes.push(outcome as never);
      return outcome;
    });
    const msgCountBefore = (fx.host.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id='primary' AND speaker='assistant'").get() as { n: number }).n;

    fx.steps.push(
      { calls: [{ id: 'voice-cross-2300', name: 'chat_send_voice', args: { text: '睡前录一句悄悄话' } }] },
      { text: '不会继续' },
    );
    fx.setClock('2026-11-24T22:59:58+08:00');
    await fx.host.scheduler!.tick();

    const msgCountAfter = (fx.host.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id='primary' AND speaker='assistant'").get() as { n: number }).n;
    assert.equal(msgCountAfter, msgCountBefore, '23:00:01 合成完毕的在途语音不得发入正式聊天');
    const savedAsset = fx.host.db.prepare("SELECT id, state FROM media_assets WHERE creation_operation_id LIKE 'voice-say:%'")
      .get() as { id: string; state: string } | undefined;
    assert.ok(savedAsset && savedAsset.state === 'available', '已完成合成的音频资产保留在本地，不浪费重跑');
    assert.equal(outcomes.length, 1, 'chat_send_voice 实际执行一次');
    assert.equal(outcomes[0]!.ok, false);
    assert.equal(outcomes[0]!.error?.saved, true);
    assert.equal(outcomes[0]!.error?.published, false);
    assert.equal(outcomes[0]!.error?.asset_id, savedAsset!.id);
    await fx.stop();
  }
});
