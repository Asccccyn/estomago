// estómago 心跳规则重构 v2.1（2026-11-24）完整隔离验收（A、B1-B4、C、D、E、F、G 与 R1-R6）。
// 使用独立临时库、上海假时钟、模拟 Sol / 模型（API 与 SDK 车道），全链路走真实消息受理、
// 调度、发布、通话、HTTP 路由与前端 EstomagoClient；零真实网络、零外部付费调用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import type { SolTransport } from '../../apps/host/src/memory-surfacing/sol-provider.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { HeartbeatSources } from '../../apps/host/src/modules/heartbeat/sources.ts';
import type { HeartbeatSource } from '../../apps/host/src/modules/heartbeat/service.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import type { SdkQueryFactory } from '../../apps/host/src/runtime/sdk-host-query.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';
import { provesMainChatOneHourCacheProtection } from '../../apps/host/src/runtime/cache-observation.ts';
import { ConversationRestJudge, RestDecisionCoordinator } from '../../apps/host/src/runtime/conversation-rest-sol.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { keepwarmStatusText } from '../../apps/web/react/src/background-controls-model.ts';
import { EstomagoClient } from '../../apps/web/react/src/chat-client.ts';
import { makeFixtureToolsResident, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import { installHeartbeatFixtureSources } from '../helpers/heartbeat-sources.ts';
import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';

type Step = {
  text?: string;
  thinking?: string;
  calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  onTransport?: () => void | Promise<void>;
  failTransport?: Error;
};

const MODEL = 'anthropic/claude-v21-fixture';
const USAGE = {
  prompt_tokens: 2000,
  completion_tokens: 8,
  prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 },
  cost: 0.001,
};
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const shFmt = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

const enabledTimerContexts = new WeakSet<object>();

/** In-process HTTP dispatch straight through Host's real http.Server request listener (auth, readJson, routes). */
async function httpDispatch(
  host: Host,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string | Buffer | Uint8Array,
): Promise<{ status: number; headers: Record<string, string>; text: string; json: () => any }> {
  const reqStream = new PassThrough();
  const req = Object.assign(reqStream, {
    method,
    url: urlPath,
    headers: { host: '127.0.0.1', ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status = 200;
  const outHeaders: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let finished = false;
  let resolveDone!: () => void;
  const done = new Promise<void>(r => { resolveDone = r; });

  const res = {
    get headersSent() { return finished; },
    setHeader(name: string, value: string | number | string[]) {
      outHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    },
    getHeader(name: string) { return outHeaders[name.toLowerCase()]; },
    writeHead(code: number, hdrs?: Record<string, string | number | string[]>) {
      status = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        }
      }
      return this;
    },
    write(chunk: string | Buffer | Uint8Array) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer | Uint8Array) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      finished = true;
      resolveDone();
      return this;
    },
    on() { return this; },
    once() { return this; },
    removeListener() { return this; },
  };

  host.server.emit('request', req as any, res as any);
  if (body !== undefined) {
    reqStream.end(Buffer.isBuffer(body) ? body : Buffer.from(body));
  } else {
    reqStream.end();
  }
  await done;
  const text = Buffer.concat(chunks).toString('utf8');
  return {
    status,
    headers: outHeaders,
    text,
    json: () => JSON.parse(text),
  };
}

function solResponse(decision: 'rest' | 'not_rest' | 'uncertain', restKind: 'sleep' | 'nap_or_wait' | null, basis = 'synthetic') {
  return {
    status: 200,
    json: {
      id: `resp_${Math.random().toString(36).slice(2, 8)}`,
      status: 'completed',
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({ decision, rest_kind: restKind, basis }),
        }],
      }],
    },
  };
}

async function createV21Fixture(
  t: Pick<TestContext, 'after' | 'mock'>,
  initialIso: string,
  opts: {
    lane?: 'api' | 'sdk';
    solTransport?: SolTransport;
    sleepWindowEnabled?: boolean;
  } = {},
) {
  let nowMs = Date.parse(initialIso);
  if (!enabledTimerContexts.has(t)) {
    t.mock.timers.enable({ apis: ['Date'], now: nowMs });
    enabledTimerContexts.add(t);
  } else {
    t.mock.timers.setTime(nowMs);
  }
  const restoreSources = installHeartbeatFixtureSources();
  const root = tempRoot('hb-v21-');
  writeApprovedIdentity(root);
  const steps: Step[] = [];
  const requests: Array<{ atIso: string; heartbeat: boolean; lastUser: string }> = [];
  let host: Host | undefined;
  let stopped = false;

  const setClock = (isoOrMs: string | number) => {
    nowMs = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
    t.mock.timers.setTime(nowMs);
    if (host?.scheduler) (host.scheduler as any).d.now = () => nowMs;
    if (host) (host.supervisor as any).d.now = () => nowMs;
  };

  const lane = opts.lane ?? 'api';
  const makeRunner = () => lane === 'sdk'
    ? new ClaudeSdkRunner(((input: any) => {
        const session = 'v21-sdk-session';
        const output = (async function* () {
          if (!(yield* scriptedSdkInput(input, session, frame => {
            const content = JSON.stringify(frame.message?.content ?? '');
            requests.push({ atIso: new Date(nowMs).toISOString(), heartbeat: content.includes('[心跳唤醒]'), lastUser: content });
          }))) return;
          for (;;) {
            const step = steps.shift() ?? { text: '收到。' };
            await step.onTransport?.();
            if (step.failTransport) throw step.failTransport;
            const id = `v21-sdk-${requests.length}-${Math.random().toString(36).slice(2, 8)}`;
            yield { type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, model: input.options.model,
              usage: { input_tokens: 600, output_tokens: 4, cache_read_input_tokens: 1500 } } } };
            const calls = step.calls ?? [];
            yield { type: 'assistant', session_id: session, message: { id, content: [
              ...(step.thinking ? [{ type: 'thinking', thinking: step.thinking }] : []),
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
      }) as SdkQueryFactory)
    : new OpenRouterRunner(
        { providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 },
        async (payload) => {
          const messages = payload.messages as OrMessage[];
          const lastUser = messages.findLast((m) => m.role === 'user');
          const text = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
          const step = steps.shift() ?? { text: '收到。' };
          await step.onTransport?.();
          if (step.failTransport) throw step.failTransport;
          requests.push({ atIso: new Date(nowMs).toISOString(), heartbeat: text.includes('[心跳唤醒]'), lastUser: text });
          const calls = step.calls ?? [];
          const delta = {
            ...(step.text !== undefined ? { content: step.text } : {}),
            ...(calls.length
              ? { tool_calls: calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
              : {}),
          };
          return {
            status: 200,
            headers: new Headers({ 'x-generation-id': `v21-${requests.length}` }),
            body: Readable.from([
              sse({ id: `v21-${requests.length}`, choices: [{ delta }] }),
              sse({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: USAGE }),
              'data: [DONE]\n\n',
            ]),
          };
        },
      );

  const ready = readyRuntimePatch();
  const config = buildConfig({
    ...ready,
    runtime: {
      ...(ready.runtime as object),
      provider: 'mock',
      tool_schema_mode: 'direct',
      ...(lane === 'sdk' ? { subscription_proxy_url: 'http://127.0.0.1:1' } : {}),
    },
    openrouter: { model: MODEL },
    background: { keepwarm: { sleep_window: { enabled: opts.sleepWindowEnabled ?? true, start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' } } },
    windows: { model_context_capacity: 150_000 },
  });

  const bootHost = async (isRestart = false) => {
    const h = await Host.create({
      stateRoot: root,
      config,
      logDir: null,
      bind: '127.0.0.1',
      port: 0,
      runnerOverride: makeRunner(),
      ...(opts.solTransport ? { restJudgeTransportForTest: opts.solTransport } : {}),
    });
    if (!isRestart) {
      const { residentToolNames } = await import('../../apps/host/src/runtime/tool-resident-guides.ts');
      makeFixtureToolsResident(h.db, [...residentToolNames, 'background_complete', 'chat_send_text']);
      const stamp = new Date(nowMs).toISOString();
      h.db.prepare("INSERT OR REPLACE INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,?)")
        .run(JSON.stringify({ input_micro_per_token: 0.000003, output_micro_per_token: 0.000015 }), stamp);
      const bg = new BackgroundSettingsService(h.db, config);
      bg.applyUpdate({ expectedRevision: bg.revision(), patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 5 } });
    }
    (h.scheduler as any).d.now = () => nowMs;
    (h.supervisor as any).d.now = () => nowMs;
    h.scheduler!.start();
    host = h;
    return h;
  };

  await bootHost(false);
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await host?.stop();
    restoreSources();
    fs.rmSync(root, { recursive: true, force: true });
  };
  t.after(stop);

  const token = () => fs.readFileSync(`${root}/config/auth.token`, 'utf8').trim();
  const authHeaders = () => ({ Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' });

  const sendHttpMessage = async (iso: string, content: string, clientMessageId: string, replyText = '收到。', replyIso?: string) => {
    setClock(iso);
    steps.push({ text: replyText, ...(replyIso ? { onTransport: () => setClock(replyIso) } : {}) });
    const res = await httpDispatch(host!, 'POST', '/api/v1/conversations/primary/messages', authHeaders(), JSON.stringify({
      client_message_id: clientMessageId,
      content,
    }));
    assert.ok(res.status === 201 || res.status === 200, `POST messages failed: ${res.status} ${res.text}`);
    await host!.supervisor.waitIdle();
    await host!.restCoordinator?.waitIdle();
    return res;
  };

  const readSettings = async () => {
    const res = await httpDispatch(host!, 'GET', '/api/v1/background/settings', { Authorization: `Bearer ${token()}` });
    assert.equal(res.status, 200);
    const body = res.json();
    const render = keepwarmStatusText(body.keepwarm_status, body.keepwarm.sleep_window, shFmt);
    return { body, status: body.keepwarm_status, render };
  };

  const setKeepwarmEnabled = async (enabled: boolean, opKey: string) => {
    const cur = await readSettings();
    const res = await httpDispatch(
      host!, 'PUT', '/api/v1/background/settings',
      { ...authHeaders(), 'If-Match': `"${cur.body.revision}"`, 'Idempotency-Key': opKey },
      JSON.stringify({ keepwarm: { enabled } }),
    );
    assert.equal(res.status, 200, res.text);
    return res.json();
  };

  const restartHost = async () => {
    await host!.stop();
    host = undefined;
    return bootHost(true);
  };

  const activity = () => new ConversationActivityService(host!.db);
  const heartbeatRequests = () => requests.filter(r => r.heartbeat);

  return {
    root, get host() { return host!; }, stop, restartHost, config, steps, requests,
    heartbeatRequests, setClock, getNowMs: () => nowMs, sendHttpMessage, readSettings,
    setKeepwarmEnabled, activity, token, authHeaders,
  };
}

// ==================== 验收 A：02:00 分界、新决定覆盖旧决定、补觉跨日、页面预告 ====================
test('验收 A（含 R1/R5）：01:59:59/22:30 正常夜休留 08:00；02:00/04:00/07:30/08:15 取消 08:00 且跨日仍等用户；新决定覆盖旧决定', { timeout: 30000 }, async (t) => {
  const cases: Array<{ label: string; at: string; expectMorning0800: boolean; target0800: string }> = [
    { label: '22:30 正常夜休', at: '2026-11-24T22:30:00+08:00', expectMorning0800: true, target0800: '2026-11-25T08:00:00+08:00' },
    { label: '01:59:59 凌晨正常夜休', at: '2026-11-25T01:59:59+08:00', expectMorning0800: true, target0800: '2026-11-25T08:00:00+08:00' },
    { label: '02:00:00 整点起通宵补觉', at: '2026-11-25T02:00:00+08:00', expectMorning0800: false, target0800: '2026-11-25T08:00:00+08:00' },
    { label: '04:00 通宵补觉', at: '2026-11-25T04:00:00+08:00', expectMorning0800: false, target0800: '2026-11-25T08:00:00+08:00' },
    { label: '07:30 通宵补觉', at: '2026-11-25T07:30:00+08:00', expectMorning0800: false, target0800: '2026-11-25T08:00:00+08:00' },
  ];

  for (const c of cases) {
    const fx = await createV21Fixture(t, c.at);
    await fx.sendHttpMessage(c.at, '晚安，我睡了', `gn-${c.at}`, '好，睡吧');
    const st = await fx.readSettings();
    assert.equal(st.status.resting, true, c.label);
    if (c.expectMorning0800) {
      assert.equal(st.status.rest_recovery_mode, 'morning_0800', c.label);
      assert.equal(st.status.morning_wake.scheduled, true, `${c.label} 应预告次晨 08:00 (R5)`);
      assert.match(st.render, /08:00/, c.label);
    } else {
      assert.equal(st.status.rest_recovery_mode, 'next_user_message', c.label);
      assert.equal(st.status.morning_wake.scheduled, false, `${c.label} 不可预告 08:00`);
      assert.match(st.render, /正在补觉，等你下条消息/, c.label);
    }

    fx.steps.push({ calls: [{ id: 'a-noop', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock(c.target0800);
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, c.expectMorning0800 ? 1 : 0, `${c.label} 08:00 实际首发`);

    if (!c.expectMorning0800) {
      // 补觉跨午夜、跨次日 08:00 仍等用户
      fx.setClock('2026-11-26T00:05:00+08:00');
      await fx.host.scheduler!.tick();
      fx.setClock('2026-11-26T08:00:00+08:00');
      await fx.host.scheduler!.tick();
      assert.equal(fx.heartbeatRequests().length, 0, `${c.label} 跨次日 08:00 仍零派发`);
    }
    await fx.stop();
  }

  // 串联：01:00 道晚安 -> 续聊 -> 07:30 明确去睡覆盖旧决定 (R1) -> 08:00 零派发 -> 22:30 正常夜休恢复明晨 ->
  // 次日 08:00 晨间发生 -> 08:15 再去睡立即停止后续自动活动并保留已发生的晨间事实
  {
    const fx = await createV21Fixture(t, '2026-11-25T01:00:00+08:00');
    await fx.sendHttpMessage('2026-11-25T01:00:00+08:00', '晚安，我睡了', 'chain-1', '晚安');
    assert.equal(fx.activity().get('primary')!.rest_recovery_mode, 'morning_0800');
    await fx.sendHttpMessage('2026-11-25T01:20:00+08:00', '忘了说一件事', 'chain-2', '说吧');
    await fx.sendHttpMessage('2026-11-25T07:30:00+08:00', '现在真的去睡了', 'chain-3', '好，睡吧');
    assert.equal(fx.activity().get('primary')!.rest_recovery_mode, 'next_user_message', 'R1：07:30 覆盖 01:00 决定');
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '07:30 去睡取消当天 08:00');

    // 再次发“我去睡了”继续休息
    await fx.sendHttpMessage('2026-11-25T15:00:00+08:00', '我去睡了', 'chain-4', '好');
    assert.equal(fx.activity().get('primary')!.rest_recovery_mode, 'next_user_message');

    // 当晚 22:30 进入新一轮正常夜休 → 对应明天 08:00
    await fx.sendHttpMessage('2026-11-25T22:30:00+08:00', '晚安，我睡了', 'chain-5', '晚安');
    assert.equal(fx.activity().get('primary')!.rest_recovery_mode, 'morning_0800');
    assert.equal(fx.activity().get('primary')!.rest_morning_date, '2026-11-26');

    fx.steps.push({ text: '早安呀！' });
    fx.setClock('2026-11-26T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, '次日 08:00 晨间正常发生');

    // 08:15 结束通宵去睡：立即停止后续（08:50/09:05 零派发），保留已发生的 08:00 事实
    await fx.sendHttpMessage('2026-11-26T08:15:00+08:00', '我去睡了', 'chain-6', '好，睡吧');
    assert.equal(fx.activity().get('primary')!.rest_recovery_mode, 'next_user_message');
    fx.setClock('2026-11-26T09:05:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, '08:15 去睡后零后续自动心跳');
    const morningRun = fx.host.db.prepare("SELECT state FROM background_runs WHERE occurrence_key='morning-wake:primary:2026-11-26'").get() as { state: string };
    assert.equal(morningRun.state, 'completed', '已发生的晨间回合保留事实');
    await fx.stop();
  }
});

// ==================== 验收 B1 / B2 / B3 / B4：夜间四小时判定、时间边界与实发 ====================
test('验收 B1/B2/B3/B4：夜间四小时精准判定（A/B/C 三例、02:29:59 vs 02:30:00、对比助手晚回复、22:09/22:10/22:30、白天短间隔）', { timeout: 35000 }, async (t) => {
  // B1-A：00:55 上一条 -> 01:00 乔乔 -> 01:02 回复 → 01:52 零派发，08:00 首发
  {
    const fx = await createV21Fixture(t, '2026-11-25T00:55:00+08:00');
    await fx.sendHttpMessage('2026-11-25T00:55:00+08:00', '准备关灯', 'b1a-1', '嗯');
    await fx.sendHttpMessage('2026-11-25T01:00:00+08:00', '喝口水', 'b1a-2', '慢点喝', '2026-11-25T01:02:00+08:00');
    fx.setClock('2026-11-25T01:52:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, 'B1-A：01:52 零派发');
    fx.steps.push({ calls: [{ id: 'b1a-0800', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, 'B1-A：08:00 首发');
    await fx.stop();
  }

  // B1-B：昨晚 22:30 -> 04:00 乔乔 -> 04:02 回复 → 04:52 首发，08:00 零额外兜底
  {
    const fx = await createV21Fixture(t, '2026-11-24T22:30:00+08:00');
    await fx.sendHttpMessage('2026-11-24T22:30:00+08:00', '晚安，我睡了', 'b1b-1', '晚安');
    await fx.sendHttpMessage('2026-11-25T04:00:00+08:00', '睡不着起来看看窗外', 'b1b-2', '我陪你', '2026-11-25T04:02:00+08:00');
    fx.setClock('2026-11-25T04:51:59+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0);
    fx.steps.push({ calls: [{ id: 'b1b-0452', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T04:52:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, 'B1-B：04:52 首发');
    // 08:00 无额外晨间兜底（注意 05:42/06:32 未运行故缓存已冷，08:00 也不应另插 morning-wake）
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, 'B1-B：08:00 无额外兜底');
    await fx.stop();
  }

  // B1-C：昨晚 22:30 -> 06:00 乔乔 -> 06:02 回复 → 06:52 首发，08:00 零额外兜底
  {
    const fx = await createV21Fixture(t, '2026-11-24T22:30:00+08:00');
    await fx.sendHttpMessage('2026-11-24T22:30:00+08:00', '晚安', 'b1c-1', '晚安');
    await fx.sendHttpMessage('2026-11-25T06:00:00+08:00', '天快亮了', 'b1c-2', '早呀', '2026-11-25T06:02:00+08:00');
    const st = await fx.readSettings();
    assert.equal(st.render, '已开启 · 下次心跳 06:52', '页面显示实际下一有效时间 06:52');
    fx.steps.push({ calls: [{ id: 'b1c-0652', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T06:52:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, 'B1-C：06:52 首发');
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, 'B1-C：08:00 无额外兜底');
    await fx.stop();
  }

  // B2：精确 14,400 秒边界对照（22:30:00 -> 02:29:59 暂停 vs 02:30:00 恢复 -> 03:22 vs 02:30:00 “我去睡了”）
  {
    const fx1 = await createV21Fixture(t, '2026-11-24T22:30:00+08:00');
    await fx1.sendHttpMessage('2026-11-24T22:30:00+08:00', '先停一下', 'b2-1a', '好');
    await fx1.sendHttpMessage('2026-11-25T02:29:59+08:00', '起来倒杯水', 'b2-1b', '好', '2026-11-25T02:31:59+08:00');
    fx1.setClock('2026-11-25T03:21:59+08:00');
    await fx1.host.scheduler!.tick();
    assert.equal(fx1.heartbeatRequests().length, 0, 'B2：3:59:59 保持夜间暂停');
    await fx1.stop();

    const fx2 = await createV21Fixture(t, '2026-11-24T22:30:00+08:00');
    await fx2.sendHttpMessage('2026-11-24T22:30:00+08:00', '先停一下', 'b2-2a', '好');
    await fx2.sendHttpMessage('2026-11-25T02:30:00+08:00', '起来倒杯水', 'b2-2b', '好', '2026-11-25T02:32:00+08:00');
    fx2.steps.push({ calls: [{ id: 'b2-0322', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx2.setClock('2026-11-25T03:22:00+08:00');
    await fx2.host.scheduler!.tick();
    assert.equal(fx2.heartbeatRequests().length, 1, 'B2：恰好 4:00:00 恢复并在 03:22 首发');
    await fx2.stop();

    const fx3 = await createV21Fixture(t, '2026-11-24T22:30:00+08:00');
    await fx3.sendHttpMessage('2026-11-24T22:30:00+08:00', '先停一下', 'b2-3a', '好');
    await fx3.sendHttpMessage('2026-11-25T02:30:00+08:00', '我去睡了', 'b2-3b', '好', '2026-11-25T02:32:00+08:00');
    assert.equal(fx3.activity().get('primary')!.rest_recovery_mode, 'next_user_message');
    fx3.setClock('2026-11-25T03:22:00+08:00');
    await fx3.host.scheduler!.tick();
    fx3.setClock('2026-11-25T08:00:00+08:00');
    await fx3.host.scheduler!.tick();
    assert.equal(fx3.heartbeatRequests().length, 0, 'B2：02:30:00 “我去睡了”走休息、不排 03:22 且取消当天 08:00');
    await fx3.stop();
  }

  // B3：22:10 乔乔、22:40 char回复 -> 02:30 乔乔（对比 22:40 = 3h50m < 4h 继续暂停）；非新消息不触发；手动关优先
  {
    const fx = await createV21Fixture(t, '2026-11-24T22:10:00+08:00');
    await fx.sendHttpMessage('2026-11-24T22:10:00+08:00', '问个事', 'b3-1', '慢慢回复你', '2026-11-24T22:40:00+08:00');
    // 02:30 重放旧消息、只读页面、char单方面发话、时钟跨过 4 小时均不提前恢复
    fx.setClock('2026-11-25T02:50:00+08:00');
    const dup = await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages', fx.authHeaders(), JSON.stringify({
      client_message_id: 'b3-1', content: '问个事',
    }));
    assert.equal(dup.status, 200);
    assert.equal(dup.json().duplicate, true);
    await fx.readSettings();
    await fx.host.scheduler!.tick();
    assert.equal(fx.activity().get('primary')!.early_resumed_date, null, '重放/读页/跨四小时均不提前恢复');

    // 真实新消息在 02:30（距离 22:40 仅 3h50m）→ 继续暂停
    await fx.sendHttpMessage('2026-11-25T02:30:00+08:00', '再说一句', 'b3-2', '收到', '2026-11-25T02:31:00+08:00');
    assert.equal(fx.activity().get('primary')!.early_resumed_date, null, 'B3：比较char 22:40 末句，3h50m 继续暂停');
    fx.setClock('2026-11-25T03:21:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0);

    // 手动关期间即使间隔 > 4 小时也零自动派发
    await fx.setKeepwarmEnabled(false, 'b3-off');
    await fx.sendHttpMessage('2026-11-25T06:40:00+08:00', '早起喝茶', 'b3-3', '早');
    fx.setClock('2026-11-25T07:30:00+08:00');
    await fx.host.scheduler!.tick();
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, 'B3：手动关期间满四小时零派发');
    await fx.stop();
  }

  // B4：白天仅隔几分钟即恢复；22:09→22:59 可发、22:10→23:00 停、22:30→23:20 停；跨午夜零启动；重启无重复
  {
    const fx = await createV21Fixture(t, '2026-11-25T14:00:00+08:00');
    await fx.sendHttpMessage('2026-11-25T14:00:00+08:00', '我现在去睡觉了', 'b4-nap', '好');
    assert.equal(fx.activity().resting('primary'), true);
    await fx.sendHttpMessage('2026-11-25T14:05:00+08:00', '睡不着还是聊会', 'b4-back', '来吧');
    assert.equal(fx.activity().resting('primary'), false, 'B4：白天 5 分钟新普通消息即可恢复');
    fx.steps.push({ calls: [{ id: 'b4-1455', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T14:55:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1);

    // 22:09 → 22:59 可发
    await fx.sendHttpMessage('2026-11-25T22:09:00+08:00', '晚间聊一句', 'b4-2209', '嗯');
    fx.steps.push({ calls: [{ id: 'b4-2259', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T22:59:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 2, 'B4：22:09→22:59 可发');

    // 跨午夜零启动 + 重启不重发
    fx.setClock('2026-11-26T00:00:01+08:00');
    await fx.restartHost();
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 2, 'B4：跨午夜与重启零意外启动');
    await fx.stop();
  }
});

// ==================== 验收 C：连续三次未出现（API 与 SDK 双车道） ====================
for (const lane of ['api', 'sdk'] as const) {
  test(`验收 C（${lane}）：08:00/08:50/09:40 计 1/2/3 后 10:30 零新启动；发言重计 09:44；09:00 回来清零排 09:53；当日下午回来重启；次日 08:00 重启新串`, { timeout: 35000 }, async (t) => {
    const fx = await createV21Fixture(t, '2026-11-24T22:30:00+08:00', { lane });
    // 提供 15 张测试卡源，保证跨两天抽卡后次日仍能组成完整 10 张牌组
    const deckCards: HeartbeatSource[] = Array.from({ length: 15 }, (_, idx) => ({
      kind: 'moments', namespace: 'content', id: `v21-card-${idx + 1}`, revision: 1,
      identity: `content:moments:v21-card-${idx + 1}`, permissionScope: 'primary',
    }));
    t.mock.method(HeartbeatSources.prototype, 'choose', async (conversationId: string, eligible: (s: HeartbeatSource) => boolean): Promise<HeartbeatSource[]> =>
      deckCards.filter(card => card.permissionScope === conversationId && eligible(card)).slice(0, 10),
    );
    t.mock.method(HeartbeatSources.prototype, 'resolve', async (source: HeartbeatSource, conversationId: string) =>
      deckCards.some(c => c.id === source.id && c.permissionScope === conversationId)
        ? { status: 'available' as const, text: `合成心跳卡内容：${source.id}`, imageIds: [], assetIds: [] }
        : { status: 'revision_unavailable' as const },
    );
    await fx.sendHttpMessage('2026-11-24T22:30:00+08:00', '晚安，我睡了', 'c-gn', '晚安');

    // 第 1 轮：08:00 迅速安静结束
    fx.steps.push({ calls: [{ id: 'c-r1', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 1, `${lane} 第 1 次`);
    const runsAfter1 = () => (fx.host.db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind='keepwarm' AND streak_counted_at IS NOT NULL").get() as { n: number }).n;
    assert.equal(runsAfter1(), 1);

    // 第 2 轮：08:50 正式发言于 08:54（char单方面说话不清零次数，下次推到 09:44）
    fx.steps.push({
      calls: [{ id: 'c-r2-draw', name: 'heartbeat_draw', args: { card_number: 2 } }],
    }, {
      text: '刚抽了二号牌，分享给你。',
      onTransport: () => fx.setClock('2026-11-25T08:54:00+08:00'),
    });
    fx.setClock('2026-11-25T08:50:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 2, `${lane} 同轮多步+发言仍只计为第 2 次且不清零`);

    // 09:40 未到（因 08:54 正式发言推到 09:44）
    fx.setClock('2026-11-25T09:40:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(runsAfter1(), 2, `${lane} 09:40 零派发，按 08:54 正式发言排 09:44`);

    // 第 3 轮：09:44 完整工具链后安静结束
    fx.steps.push(
      { calls: [{ id: 'c-r3-draw', name: 'heartbeat_draw', args: { card_number: 3 } }] },
      { calls: [{ id: 'c-r3-noop', name: 'background_complete', args: { outcome: 'noop' } }] },
    );
    fx.setClock('2026-11-25T09:44:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 3, `${lane} 第 3 次`);
    assert.equal(runsAfter1(), 3);

    const pausedSettings = await fx.readSettings();
    assert.equal(pausedSettings.status.blocked_reason, 'KEEPWARM_CONSECUTIVE_LIMIT');
    assert.match(pausedSettings.render, /连续三次未出现，今日暂停/);

    // 10:34 / 10:40 零新启动（且重启不重计、不重启）
    await fx.restartHost();
    fx.setClock('2026-11-25T10:34:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(runsAfter1(), 3, `${lane} 第三轮后 10:34 零新启动`);
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 3, `${lane} 重启不重复计数`);

    // 若她一直没出现：午夜零启动，次日 08:00 开始新一串（计为 1）
    fx.setClock('2026-11-26T00:05:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(runsAfter1(), 3, `${lane} 午夜零启动`);

    fx.steps.push({ calls: [{ id: 'c-day2-r1', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-26T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(runsAfter1(), 4, `${lane} 次日 08:00 开始新一串`);
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 1, `${lane} 新一串计为第 1 次`);

    // 09:00 乔乔回来、09:03 回复 → 立刻清零，09:40/08:50 旧安排取消，排 09:53
    await fx.sendHttpMessage('2026-11-26T09:00:00+08:00', '我回来啦', 'c-back', '欢迎回来', '2026-11-26T09:03:00+08:00');
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 0, `${lane} 用户回来立即清零`);
    fx.setClock('2026-11-26T09:52:59+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(runsAfter1(), 4);
    fx.steps.push({ calls: [{ id: 'c-new-r1', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-26T09:53:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(runsAfter1(), 5, `${lane} 09:53 新一串第 1 次`);
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 1);

    // 同一天再跑满第 2、3 轮后暂停，当天下午 15:00 乔乔回来仍能开启新一串
    fx.steps.push({ calls: [{ id: 'c-new-r2', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-26T10:43:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 2);
    fx.steps.push({ calls: [{ id: 'c-new-r3', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-26T11:33:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 3);
    fx.setClock('2026-11-26T12:23:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(runsAfter1(), 7, `${lane} 第三次后 12:23 零派发`);

    await fx.sendHttpMessage('2026-11-26T15:00:00+08:00', '下午忙完了', 'c-pm-back', '辛苦啦');
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 0);
    fx.steps.push({ calls: [{ id: 'c-pm-r1', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-26T15:50:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(runsAfter1(), 8, `${lane} 当天下午回来可重新开启新一串`);
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 1);
    await fx.stop();
  });
}

// ==================== 验收 D：R2 长通话让位、抢先、R3 旧回执不中断抽卡、未知发送与迟到结算不写回 ====================
test('验收 D（含 R2/R3）：长通话 07:59→08:12→09:02 让位；旧消息重取不中断晨间抽卡；未知发送不假记且迟到结算不覆盖用户清零', { timeout: 30000 }, async (t) => {
  // 1) R2 长通话在线让位：07:59:59 接通 -> 08:00..08:11 逐分钟 tick -> 08:12 语音发言 -> 挂断 -> 09:02 首发；若 09:02 仍在通话继续让位
  {
    process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'v21-voice-token';
    t.after(() => delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN);
    const fx = await createV21Fixture(t, '2026-11-24T22:00:00+08:00');
    await fx.sendHttpMessage('2026-11-24T22:00:00+08:00', '晚安，我睡了', 'd-gn', '晚安');
    const voiceHeaders = { Authorization: 'Bearer v21-voice-token', 'Content-Type': 'application/json' };
    fx.setClock('2026-11-25T07:59:59+08:00');
    const callRes = await httpDispatch(fx.host, 'POST', '/v1/calls', voiceHeaders, JSON.stringify({ call_id: 'd-call-1', conversation_id: 'primary' }));
    assert.equal(callRes.status, 200);
    for (let min = 0; min <= 11; min++) {
      fx.setClock(`2026-11-25T08:${String(min).padStart(2, '0')}:00+08:00`);
      await fx.host.scheduler!.tick();
    }
    assert.equal(fx.heartbeatRequests().length, 0, '通话期间 08:00-08:11 全部让位');

    fx.setClock('2026-11-25T08:12:00+08:00');
    fx.steps.push({ text: '通话里回复你。' });
    const streamRes = await httpDispatch(fx.host, 'POST', '/v1/chat/stream', voiceHeaders, JSON.stringify({
      conversation_id: 'primary', call_id: 'd-call-1', turn_id: 'word-1', modality: 'voice', text: '我还想问你一个问题',
    }));
    assert.equal(streamRes.status, 200);
    await fx.host.supervisor.waitIdle();
    const endRes = await httpDispatch(fx.host, 'DELETE', '/v1/calls/d-call-1', voiceHeaders);
    assert.equal(endRes.status, 200);

    // 若 09:02 仍在另一通通话中，继续让位不消耗次数
    fx.setClock('2026-11-25T09:01:59+08:00');
    await httpDispatch(fx.host, 'POST', '/v1/calls', voiceHeaders, JSON.stringify({ call_id: 'd-call-2', conversation_id: 'primary' }));
    fx.setClock('2026-11-25T09:02:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '09:02 仍在通话继续让位');
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 0);

    // 挂断后立即执行
    fx.setClock('2026-11-25T09:03:00+08:00');
    await httpDispatch(fx.host, 'DELETE', '/v1/calls/d-call-2', voiceHeaders);
    fx.steps.push({ calls: [{ id: 'd-0903', name: 'background_complete', args: { outcome: 'noop' } }] });
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, 'R2：长通话挂断后正常首发');
    await fx.stop();
  }

  // 2) R3：旧消息原键重取回执 returning duplicate=true，不中断正在执行的晨间抽卡，不清零计数
  {
    const fx = await createV21Fixture(t, '2026-11-24T22:30:00+08:00');
    await fx.sendHttpMessage('2026-11-24T22:30:00+08:00', '晚安', 'd-r3-gn', '晚安');
    await fx.sendHttpMessage('2026-11-25T07:11:00+08:00', '合成前台消息', 'review-same-receipt', '好');
    const beforeAct = fx.activity().get('primary')!;
    let replayStatus = 0;
    let replayDup = false;
    fx.steps.push(
      {
        calls: [{ id: 'draw-before-receipt', name: 'heartbeat_draw', args: { card_number: 2 } }],
        onTransport: async () => {
          const replay = await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages', fx.authHeaders(), JSON.stringify({
            client_message_id: 'review-same-receipt', content: '合成前台消息',
          }));
          replayStatus = replay.status;
          replayDup = replay.json().duplicate === true;
        },
      },
      { text: '看过二号牌啦。' },
    );
    fx.setClock('2026-11-25T08:01:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(replayStatus, 200);
    assert.equal(replayDup, true);
    const drawOp = fx.host.db.prepare("SELECT state FROM heartbeat_draw_operations WHERE operation_id='draw-before-receipt'").get() as { state: string } | undefined;
    assert.equal(drawOp?.state, 'delivered', 'R3：旧消息回执查询不得中断正在执行的晨间抽卡');
    assert.equal(fx.activity().get('primary')!.user_appearance_revision, beforeAct.user_appearance_revision, '旧回执不推进出现版本');
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 1, '旧回执不清零连续计数');
    await fx.stop();
  }

  // 3) 未知发送保持未知不假记且不开第二轮补试；迟到结算发生在用户清零后不能写回旧串次数
  {
    const fx = await createV21Fixture(t, '2026-11-24T22:30:00+08:00');
    await fx.sendHttpMessage('2026-11-24T22:30:00+08:00', '晚安', 'd-unk-gn', '晚安');
    fx.steps.push({ failTransport: new Error('ECONNRESET_SYNTHETIC') });
    fx.setClock('2026-11-25T08:00:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 0, '发送结果未知不假记成功');
    const unkRun = fx.host.db.prepare("SELECT id, occurrence_key, streak_counted_at FROM background_runs WHERE occurrence_key='morning-wake:primary:2026-11-25'")
      .get() as { id: string; occurrence_key: string; streak_counted_at: string | null };
    assert.equal(unkRun.streak_counted_at, null);
    // 再次 tick 不再开第二轮补试同一机会
    fx.setClock('2026-11-25T08:01:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '未知机会不开补试轮');

    // 用户 08:05 发来新消息（推进 user_appearance_revision 并清零），之后旧 run 迟到确认送达 → 不得把旧串次数写回
    await fx.sendHttpMessage('2026-11-25T08:05:00+08:00', '我来了', 'd-unk-back', '好');
    const applied = fx.activity().noteEffectiveHeartbeat({
      conversationId: 'primary',
      runId: unkRun.id,
      windowId: fx.host.windows.activeWindow('primary')!.id,
      startedAtIso: '2026-11-25T00:00:00.000Z',
      isMorningWake: true,
      morningBusinessDate: '2026-11-25',
    });
    assert.equal(applied, false, '迟到结算发生在用户清零之后，必须被 CAS 拒绝');
    assert.equal(fx.activity().get('primary')!.consecutive_unanswered_count, 0, '旧串次数未写回');
    await fx.stop();
  }
});

// ==================== 验收 E：手动开关栅栏、重启保关、Sol 迟到丢弃、01:59→02:01 原时刻归类 ====================
test('验收 E：待判 Sol 遇手动关丢弃旧结果并跨重启/08:00 仍关闭；新消息抵达丢弃旧 Sol；01:59 消息 02:01 返回仍按 01:59 归类', { timeout: 30000 }, async (t) => {
  const pendingCalls: Array<{ text: string; resolve: (r: ReturnType<typeof solResponse>) => void }> = [];
  const solTransport: SolTransport = async (_url, _headers, body) => {
    const payload = JSON.parse(((body as any).input[1].content as string)) as { current_user_message: string };
    return new Promise(resolve => {
      pendingCalls.push({ text: payload.current_user_message, resolve });
    });
  };

  const fx = await createV21Fixture(t, '2026-11-24T22:00:00+08:00', { solTransport });
  await fx.sendHttpMessage('2026-11-24T22:00:00+08:00', '先聊着', 'e-init', '嗯');

  // 1) 发一条需要 Sol 判断的消息，在 Sol 未返回前先手动关
  fx.setClock('2026-11-24T22:10:00+08:00');
  fx.steps.push({ text: '好' });
  const r1 = await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages', fx.authHeaders(), JSON.stringify({
    client_message_id: 'e-pending-1', content: '今天撑不住了，先到这，明天说',
  }));
  assert.equal(r1.status, 201);
  await fx.host.supervisor.waitIdle();
  assert.equal(pendingCalls.length, 1);

  // 手动关总开关，然后让旧 Sol 返回 not_rest
  await fx.setKeepwarmEnabled(false, 'e-manual-off');
  pendingCalls.shift()!.resolve(solResponse('not_rest', null));
  await fx.host.restCoordinator!.waitIdle();

  // 重启并走到次日 08:00：仍关闭、零请求
  await fx.restartHost();
  fx.setClock('2026-11-25T08:00:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 0, '手动关跨旧 Sol、重启和 08:00 保持关闭');
  assert.equal((await fx.readSettings()).body.keepwarm.enabled, false);

  // 手动开：不立即补发已错过的 08:00（在 09:00 开启）
  fx.setClock('2026-11-25T09:00:00+08:00');
  await fx.setKeepwarmEnabled(true, 'e-manual-on');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 0, '手动开不立即补发关闭期间错过的 08:00');

  // 2) 旧休息判断晚于更新的前台消息返回 → 丢弃旧 rest 结果
  fx.setClock('2026-11-25T10:00:00+08:00');
  fx.steps.push({ text: '嗯' });
  await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages', fx.authHeaders(), JSON.stringify({
    client_message_id: 'e-m1', content: '今天撑不住了，先到这，明天说',
  }));
  await fx.host.supervisor.waitIdle();
  assert.equal(pendingCalls.length, 1);
  // M2 到达（明确非休息普通消息；直接走正式 HTTP 入口，不等待 M1 尚未返回的旧 Sol）
  fx.setClock('2026-11-25T10:01:00+08:00');
  fx.steps.push({ text: '好呀' });
  const rM2 = await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages', fx.authHeaders(), JSON.stringify({
    client_message_id: 'e-m2', content: '哈哈开玩笑的，继续玩',
  }));
  assert.equal(rM2.status, 201);
  await fx.host.supervisor.waitIdle();
  // M1 的旧 Sol 结果此时才迟到返回 rest
  pendingCalls.shift()!.resolve(solResponse('rest', 'sleep'));
  await fx.host.restCoordinator!.waitIdle();
  assert.equal(fx.activity().resting('primary'), false, '晚于更新消息返回的旧休息判断必须被丢弃');

  // 3) 01:59 消息的 Sol 判断在 02:01 才返回 → 仍按原消息时间 01:59 归类为 normal morning_0800
  fx.setClock('2026-11-26T01:59:00+08:00');
  fx.steps.push({ text: '晚安' });
  await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages', fx.authHeaders(), JSON.stringify({
    client_message_id: 'e-0159', content: '今天撑不住了，先到这，明天说',
  }));
  await fx.host.supervisor.waitIdle();
  assert.equal(pendingCalls.length, 1);
  fx.setClock('2026-11-26T02:01:00+08:00');
  pendingCalls.shift()!.resolve(solResponse('rest', 'sleep'));
  await fx.host.restCoordinator!.waitIdle();
  assert.equal(fx.activity().resting('primary'), true);
  assert.equal(fx.activity().get('primary')!.rest_recovery_mode, 'morning_0800', '01:59 消息 02:01 返回仍按 01:59 归类为正常夜休');
  assert.equal(fx.activity().get('primary')!.rest_morning_date, '2026-11-26');
  await fx.stop();
});

// ==================== 验收 F：Sol 对照矩阵 + 同时间重复 tick 零冗余写库 ====================
test('验收 F：Sol 八组正反/不确定/失败对照 + 同时间多次 tick 不重复写未变化状态', { timeout: 30000 }, async (t) => {
  const solCalls: string[] = [];
  const solTransport: SolTransport = async (_url, _headers, body) => {
    const payload = JSON.parse(((body as any).input[1].content as string)) as { current_user_message: string };
    const text = payload.current_user_message;
    solCalls.push(text);
    if (text === '晚安，明天再继续聊' || text === '今天撑不住了，先到这，明天说') return solResponse('rest', 'sleep');
    if (text === '我没说我睡了，我还醒着呢' || text === '宝宝睡了，我们轻声聊' || text === '我去修一下服务器' || text === '我说的是“晚安”这个词') {
      return solResponse('not_rest', null);
    }
    if (text.includes('模棱两可')) return solResponse('uncertain', null);
    if (text.includes('模拟失败')) return { status: 503, json: { error: 'unavailable' } };
    return solResponse('not_rest', null);
  };

  const fx = await createV21Fixture(t, '2026-11-24T21:00:00+08:00', { solTransport });
  await fx.sendHttpMessage('2026-11-24T21:00:00+08:00', '开始聊天', 'f-0', '嗯');
  assert.equal(solCalls.length, 0, '无休息线索的普通聊天走本地快速路径，零 Sol 调用');

  const matrix: Array<{ text: string; expectResting: boolean; clock: string }> = [
    { text: '晚安，明天再继续聊', expectResting: true, clock: '2026-11-24T21:05:00+08:00' },
    { text: '我没说我睡了，我还醒着呢', expectResting: false, clock: '2026-11-25T10:00:00+08:00' },
    { text: '宝宝睡了，我们轻声聊', expectResting: false, clock: '2026-11-25T10:05:00+08:00' },
    { text: '今天撑不住了，先到这，明天说', expectResting: true, clock: '2026-11-25T21:10:00+08:00' },
    { text: '我去修一下服务器', expectResting: false, clock: '2026-11-26T10:00:00+08:00' },
    { text: '我说的是“晚安”这个词', expectResting: false, clock: '2026-11-26T10:05:00+08:00' },
    // 不确定与调用失败：清醒态不冒充已睡
    { text: '有点困但说不好算不算休息模棱两可', expectResting: false, clock: '2026-11-26T10:10:00+08:00' },
    { text: '有点困但这里模拟失败', expectResting: false, clock: '2026-11-26T10:15:00+08:00' },
  ];

  for (const [idx, item] of matrix.entries()) {
    await fx.sendHttpMessage(item.clock, item.text, `f-${idx + 1}`, '收到');
    assert.equal(fx.activity().resting('primary'), item.expectResting, `Sol 对照：${item.text}`);
  }
  assert.equal(solCalls.length, matrix.length, '八组语义对照均经 Sol 判断');

  // 休息态下遇不确定与失败：也不冒充已醒
  await fx.sendHttpMessage('2026-11-26T10:20:00+08:00', '我现在去睡觉了', 'f-nap', '好');
  assert.equal(fx.activity().resting('primary'), true);
  await fx.sendHttpMessage('2026-11-26T10:25:00+08:00', '嗯睡不着模棱两可', 'f-nap-unc', '好');
  assert.equal(fx.activity().resting('primary'), true, '休息态下 Sol 不确定不能冒充已醒');
  await fx.sendHttpMessage('2026-11-26T10:30:00+08:00', '嗯睡不着模拟失败', 'f-nap-fail', '好');
  assert.equal(fx.activity().resting('primary'), true, '休息态下 Sol 失败不能冒充已醒');

  // 同时间连续 tick 多次：不新增计算流水、不重复写未变化的当前状态
  await fx.sendHttpMessage('2026-11-26T10:35:00+08:00', '起来继续聊', 'f-awake', '好');
  fx.setClock('2026-11-26T10:40:00+08:00');
  await fx.host.scheduler!.tick();
  const taskBefore = fx.host.db.prepare("SELECT next_due_at, updated_at FROM background_tasks WHERE kind='keepwarm'").get() as { next_due_at: string; updated_at: string };
  const actBefore = fx.host.db.prepare("SELECT updated_at FROM conversation_activity WHERE conversation_id='primary'").get() as { updated_at: string };
  const runsBefore = (fx.host.db.prepare('SELECT COUNT(*) n FROM background_runs').get() as { n: number }).n;

  // 推进 5 秒仍在未到期内，连 tick 5 次，验证 task 与 activity 均未被重写
  fx.setClock('2026-11-26T10:40:05+08:00');
  for (let i = 0; i < 5; i++) await fx.host.scheduler!.tick();
  const taskAfter = fx.host.db.prepare("SELECT next_due_at, updated_at FROM background_tasks WHERE kind='keepwarm'").get() as { next_due_at: string; updated_at: string };
  const actAfter = fx.host.db.prepare("SELECT updated_at FROM conversation_activity WHERE conversation_id='primary'").get() as { updated_at: string };
  const runsAfter = (fx.host.db.prepare('SELECT COUNT(*) n FROM background_runs').get() as { n: number }).n;

  assert.deepEqual(taskAfter, taskBefore, '预计时间未变化时不重写 background_tasks');
  assert.deepEqual(actAfter, actBefore, '状态未变化时不重写 conversation_activity');
  assert.equal(runsAfter, runsBefore, '不新增无意义运行流水');
  await fx.stop();
});

// ==================== 验收 R6：带图 413 payload_too_large 解锁改稿，网络未知保持原键锁定 ====================
test('验收 R6：带图收到 413 payload_too_large 后解锁改稿并发出新请求；网络未知继续锁定原键重试', { timeout: 20000 }, async (t) => {
  const fx = await createV21Fixture(t, '2026-11-25T14:00:00+08:00');
  const attempts: Array<{ status: number; code?: string; bytes: number; key: string | null }> = [];
  let dropNextSend = false;

  const client = new EstomagoClient({
    eventSource: () => ({ close() {} } as any),
    redirect: () => {},
    fetch: (async (u: any, opts?: RequestInit) => {
      const url = String(u);
      const method = opts?.method ?? 'GET';
      const hdrs: Record<string, string> = { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1' };
      if (opts?.headers) {
        new Headers(opts.headers).forEach((v, k) => { hdrs[k] = v; });
      }
      if ((url.endsWith('/messages') || url.includes('/assets?')) && method === 'POST') {
        if (url.endsWith('/messages') && dropNextSend) {
          dropNextSend = false;
          throw new Error('network dropped after send');
        }
        const rawBody = opts?.body instanceof Blob
          ? Buffer.from(await opts.body.arrayBuffer())
          : typeof opts?.body === 'string' ? opts.body : Buffer.from(opts?.body as any);
        const r = await httpDispatch(fx.host, method, url, hdrs, rawBody);
        if (url.endsWith('/messages')) {
          const parsed = r.json();
          attempts.push({
            status: r.status,
            code: parsed.error?.code,
            bytes: Buffer.byteLength(String(rawBody)),
            key: hdrs['idempotency-key'] ?? null,
          });
        }
        return new Response(r.text, { status: r.status, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/messages?')) return Response.json({ messages: [] });
      return Response.json({});
    }) as typeof fetch,
  });

  try {
    await client.start();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+JT1gAAAAASUVORK5CYII=', 'base64');
    await client.queue(new Blob([png]), 'test.png');
    const attId = client.snapshot.attachments[0]!.id;
    client.setDraft('a'.repeat(5 * 1024 * 1024));
    await client.send();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, 413);
    assert.equal(attempts[0]!.code, 'payload_too_large');
    assert.equal(client.isAttachmentLocked(attId), false, 'R6：413 受理前确定失败应解锁附件');

    // 用户缩短草稿后重发 → 必须用新键与短正文发出并 201 落库
    client.setDraft('已缩短');
    fx.steps.push({ text: '收到短图文。' });
    await client.send();
    await fx.host.supervisor.waitIdle();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]!.status, 201, '缩短后重发应成功 201');
    assert.notEqual(attempts[1]!.key, attempts[0]!.key, '改稿后使用新操作键');
    assert.ok(attempts[1]!.bytes < 1024, '发送的是缩短后的正文而非旧 5MB 载荷');
    assert.equal((fx.host.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='owner'").get() as { n: number }).n, 1);

    // 对照：网络未知失败必须继续锁定附件并按原键原载荷重试
    await client.queue(new Blob([png]), 'test2.png');
    const attId2 = client.snapshot.attachments[0]!.id;
    client.setDraft('原话');
    dropNextSend = true;
    await client.send();
    assert.equal(client.isAttachmentLocked(attId2), true, '网络未知保持锁定');
    client.setDraft('试图改稿');
    fx.steps.push({ text: '收到原话。' });
    await client.send();
    await fx.host.supervisor.waitIdle();
    assert.equal(attempts.length, 3);
    assert.equal(attempts[2]!.status, 201);
    const saved2 = fx.host.db.prepare("SELECT r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=1 WHERE m.speaker='owner' ORDER BY m.sequence DESC LIMIT 1").get() as { content: string };
    assert.equal(saved2.content, '原话', '网络未知重试沿用原载荷');
  } finally {
    client.stop();
  }
});

// ============================================================================
// 独立复审 c0422cd 返修回归（问题 1–7 全部反例，含 API 与 SDK 双车道）
// ============================================================================

for (const lane of ['api', 'sdk'] as const) {
  test(`复审 #1（${lane}）：18:00 睡→22:11 回来不得豁免 23:01；00:30 提前恢复→01:20 心跳→01:30 再睡须恢复 08:00`, async t => {
    // 1a：18:00 说去睡，22:11 回来且双方末句在 22:11 → 目标 23:01 落入 23:00 截止，绝不在 23:01 误唤
    {
      const fx = await createV21Fixture(t, '2026-11-24T18:00:00+08:00', { lane });
      await fx.sendHttpMessage('2026-11-24T18:00:00+08:00', '我睡了', 'rev1a-1', '晚安。');
      await fx.sendHttpMessage('2026-11-24T22:11:00+08:00', '醒啦，聊聊今天的事', 'rev1a-2', '好呀，我在。');
      const act = new ConversationActivityService(fx.host.db).get('primary')!;
      assert.equal(act.resting, 0, '22:11 间隔满 4 小时可解除 18:00 的休息');
      assert.equal(act.early_resumed_date, null, '23:00 尚未开始，不得提前授予未来静默窗豁免');
      const st2211 = await fx.readSettings();
      assert.equal(st2211.body.keepwarm_status.next_keepwarm_at, undefined, '23:01 落入截止时段，页面不预告 23:01');
      assert.equal(st2211.body.keepwarm_status.morning_wake?.scheduled, true, '保留次晨 08:00 条件兜底');
      fx.setClock('2026-11-24T23:01:00+08:00');
      await fx.host.scheduler!.tick();
      assert.equal(fx.heartbeatRequests().length, 0, `${lane}：23:01 零派发`);
      await fx.stop();
    }

    // 1b：前晚 19:30 停聊，次日 00:30 满 4 小时提前回来，01:20 心跳后，01:30 再次明确去睡 → 保留当天 08:00
    {
      const fx = await createV21Fixture(t, '2026-11-24T19:30:00+08:00', { lane });
      await fx.sendHttpMessage('2026-11-24T19:30:00+08:00', '先忙去了', 'rev1b-1', '好。');
      await fx.sendHttpMessage('2026-11-25T00:30:00+08:00', '半夜醒了来看看你', 'rev1b-2', '我在呢。');
      fx.steps.push({ calls: [{ id: 'rev1b-0120', name: 'background_complete', args: { outcome: 'noop' } }] });
      fx.setClock('2026-11-25T01:20:00+08:00');
      await fx.host.scheduler!.tick();
      assert.equal(fx.heartbeatRequests().length, 1, `${lane}：01:20 提前恢复后心跳执行`);
      // 01:30 再次明确去睡（< 02:00 正常夜休），必须清除先前 00:30 的提前恢复/取代标记
      await fx.sendHttpMessage('2026-11-25T01:30:00+08:00', '晚安，我睡了', 'rev1b-3', '好梦。');
      const act = new ConversationActivityService(fx.host.db).get('primary')!;
      assert.equal(act.resting, 1);
      assert.equal(act.rest_recovery_mode, 'morning_0800');
      assert.equal(act.rest_morning_date, '2026-11-25');
      assert.equal(act.early_resumed_date, null, '新正常夜休清除旧 early_resumed_date');
      assert.equal(act.morning_fallback_superseded_date, null, '新正常夜休清除旧 morning_fallback_superseded_date');
      const st0130 = await fx.readSettings();
      assert.equal(st0130.body.keepwarm_status.morning_wake?.scheduled, true, '页面恢复预告今日 08:00');
      assert.equal(st0130.body.keepwarm_status.morning_wake?.target_at, new Date('2026-11-25T08:00:00+08:00').toISOString());
      fx.steps.push({ calls: [{ id: 'rev1b-0800', name: 'background_complete', args: { outcome: 'noop' } }] });
      fx.setClock('2026-11-25T08:00:00+08:00');
      await fx.host.scheduler!.tick();
      assert.equal(fx.heartbeatRequests().length, 2, `${lane}：08:00 晨间兜底正常唤醒`);
      await fx.stop();
    }
  });
}

for (const lane of ['api', 'sdk'] as const) {
  test(`复审 #2（${lane}）：手动关闭期间错过的 08:00 与白天 12:50，手动重开后均不补发；未到期机会仍按原锚点执行`, async t => {
    // 2a：08:00 期间开关关闭，08:05 打开 → 不补发 08:00，次日 08:00 正常
    {
      const fx = await createV21Fixture(t, '2026-11-24T22:00:00+08:00', { lane });
      await fx.sendHttpMessage('2026-11-24T22:00:00+08:00', '晚安，我睡了', 'rev2a-1', '晚安。');
      const bg = new BackgroundSettingsService(fx.host.db, fx.config);
      fx.setClock('2026-11-25T07:50:00+08:00');
      bg.applyUpdate({ expectedRevision: bg.revision(), patch: { keepwarm_enabled: false } });
      fx.setClock('2026-11-25T08:00:00+08:00');
      await fx.host.scheduler!.tick();
      assert.equal(fx.heartbeatRequests().length, 0);
      fx.setClock('2026-11-25T08:05:00+08:00');
      bg.applyUpdate({ expectedRevision: bg.revision(), patch: { keepwarm_enabled: true } });
      const st0805 = await fx.readSettings();
      assert.equal(st0805.body.keepwarm_status.next_keepwarm_at, undefined, '08:05 重开后页面不再预告已过的 08:00');
      assert.notEqual(st0805.body.keepwarm_status.morning_wake?.target_at, new Date('2026-11-25T08:00:00+08:00').toISOString());
      fx.setClock('2026-11-25T08:05:01+08:00');
      await fx.host.scheduler!.tick();
      assert.equal(fx.heartbeatRequests().length, 0, `${lane}：08:05:01 不补发关闭期间错过的 08:00`);
      await fx.stop();
    }

    // 2b：白天 12:00 停聊，12:48 关、12:50 零派发、12:52 开 → 12:52:01 不补发，不伪造 L；新消息后照常；未到期重开照常
    {
      const fx = await createV21Fixture(t, '2026-11-25T12:00:00+08:00', { lane });
      await fx.sendHttpMessage('2026-11-25T12:00:00+08:00', '午饭吃了面', 'rev2b-1', '听起来不错。');
      const originalL = new ConversationActivityService(fx.host.db).get('primary')!.last_real_activity_at;
      const bg = new BackgroundSettingsService(fx.host.db, fx.config);
      // 未到期切换对照：12:10 关 → 12:20 开 → 12:50 仍保留
      fx.setClock('2026-11-25T12:10:00+08:00');
      bg.applyUpdate({ expectedRevision: bg.revision(), patch: { keepwarm_enabled: false } });
      fx.setClock('2026-11-25T12:20:00+08:00');
      bg.applyUpdate({ expectedRevision: bg.revision(), patch: { keepwarm_enabled: true } });
      assert.equal((await fx.readSettings()).render, '已开启 · 下次心跳 12:50', '未到期的 12:50 在 12:20 重开后保留');
      // 跨到期关闭：12:48 关 → 12:50 零派发 → 12:52 开 → 12:52:01 不补发
      fx.setClock('2026-11-25T12:48:00+08:00');
      bg.applyUpdate({ expectedRevision: bg.revision(), patch: { keepwarm_enabled: false } });
      fx.setClock('2026-11-25T12:50:00+08:00');
      await fx.host.scheduler!.tick();
      assert.equal(fx.heartbeatRequests().length, 0);
      fx.setClock('2026-11-25T12:52:00+08:00');
      bg.applyUpdate({ expectedRevision: bg.revision(), patch: { keepwarm_enabled: true } });
      assert.equal(new ConversationActivityService(fx.host.db).get('primary')!.last_real_activity_at, originalL, '点击开启不伪造双方末句时间');
      fx.setClock('2026-11-25T12:52:01+08:00');
      await fx.host.scheduler!.tick();
      assert.equal(fx.heartbeatRequests().length, 0, `${lane}：12:52:01 不补发 12:50 心跳`);
      // 新消息到来后按新锚点恢复
      await fx.sendHttpMessage('2026-11-25T12:55:00+08:00', '刚开完会', 'rev2b-2', '辛苦啦。');
      assert.equal((await fx.readSettings()).render, '已开启 · 下次心跳 13:45');
      fx.steps.push({ calls: [{ id: 'rev2b-1345', name: 'background_complete', args: { outcome: 'noop' } }] });
      fx.setClock('2026-11-25T13:45:00+08:00');
      await fx.host.scheduler!.tick();
      assert.equal(fx.heartbeatRequests().length, 1, `${lane}：新消息后的 13:45 正常执行`);
      await fx.stop();
    }
  });
}

test('复审 #3：两次保温之间穿插安静自主预约，13:40 顺延到 14:10 后使用独立锚点领取键，14:10 正常执行第 2 轮不卡死', async t => {
  const fx = await createV21Fixture(t, '2026-11-25T12:00:00+08:00');
  const bg = new BackgroundSettingsService(fx.host.db, fx.config);
  bg.applyUpdate({ expectedRevision: bg.revision(), patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
  await fx.sendHttpMessage('2026-11-25T12:00:00+08:00', '中午好', 'rev3-1', '中午好呀。');
  // 预置 13:20 的安静自主预约任务
  const due1320 = new Date('2026-11-25T13:20:00+08:00').toISOString();
  const created1200 = new Date('2026-11-25T12:00:00+08:00').toISOString();
  fx.host.db.prepare(`
    INSERT INTO background_tasks(id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,scheduled_at,next_due_at,timezone,payload_json,created_by_actor_id,origin,created_at,updated_at)
    VALUES ('rev3-wake','primary','jiaming','autonomous',1,1,'once',?,?,'Asia/Shanghai',?,'jiaming','self_schedule',?,?)
  `).run(due1320, due1320, JSON.stringify({ note: '静默检查' }), created1200, created1200);

  // 12:50 第 1 轮普通心跳安静结束（计 1）
  fx.steps.push({ calls: [{ id: 'rev3-hb1', name: 'background_complete', args: { outcome: 'noop' } }] });
  fx.setClock('2026-11-25T12:50:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 1);
  assert.equal(new ConversationActivityService(fx.host.db).get('primary')!.consecutive_unanswered_count, 1);

  // 13:20 自主预约安静完成（无聊天正文）
  fx.steps.push({ calls: [{ id: 'rev3-auto1', name: 'background_complete', args: { outcome: 'noop' } }] });
  fx.setClock('2026-11-25T13:20:00+08:00');
  await fx.host.scheduler!.tick();
  const autoRun = fx.host.db.prepare("SELECT state FROM background_runs WHERE task_id='rev3-wake'").get() as { state: string };
  assert.equal(autoRun.state, 'noop', '13:20 自主预约安静完成');

  // 13:40 保温检测到 13:20 刚刷新缓存 → satisfied_by_request 不重复付费，目标推到 14:10
  fx.setClock('2026-11-25T13:40:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 1, '13:40 不重复付费');
  assert.equal((await fx.readSettings()).render, '已开启 · 下次心跳 14:10');

  // 14:10 必须用维护回执锚点生成新唯一领取键并真正启动第 2 轮心跳（不卡死在 14:10）
  fx.steps.push({ calls: [{ id: 'rev3-hb2', name: 'background_complete', args: { outcome: 'noop' } }] });
  fx.setClock('2026-11-25T14:10:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 2, '14:10 成功启动第 2 轮心跳，未因旧 occurrence_key 卡死');
  assert.equal(new ConversationActivityService(fx.host.db).get('primary')!.consecutive_unanswered_count, 2);
  assert.equal((await fx.readSettings()).render, '已开启 · 下次心跳 15:00', '14:10 完成后排程推进到 15:00');
});

test('复审 #4：前晚仅有 2 次无人回应即达 23:00 停止，次日 08:00 晨间机会作为新一串第 1 次，随后 08:50(2)、09:40(3)、10:30 停', async t => {
  const fx = await createV21Fixture(t, '2026-11-24T21:00:00+08:00');
  await fx.sendHttpMessage('2026-11-24T21:00:00+08:00', '晚上好', 'rev4-1', '晚上好。');
  fx.steps.push({ calls: [{ id: 'rev4-2150', name: 'background_complete', args: { outcome: 'noop' } }] });
  fx.setClock('2026-11-24T21:50:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(new ConversationActivityService(fx.host.db).get('primary')!.consecutive_unanswered_count, 1);

  fx.steps.push({ calls: [{ id: 'rev4-2240', name: 'background_complete', args: { outcome: 'noop' } }] });
  fx.setClock('2026-11-24T22:40:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(new ConversationActivityService(fx.host.db).get('primary')!.consecutive_unanswered_count, 2);

  // 23:00 停止
  fx.setClock('2026-11-24T23:30:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 2);

  // 次日 08:00 必须计为第 1 次（不是 2+1=3！）
  for (const [iso, id, expectedCount] of [
    ['2026-11-25T08:00:00+08:00', 'rev4-0800', 1],
    ['2026-11-25T08:50:00+08:00', 'rev4-0850', 2],
    ['2026-11-25T09:40:00+08:00', 'rev4-0940', 3],
  ] as const) {
    fx.steps.push({ calls: [{ id, name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock(iso);
    await fx.host.scheduler!.tick();
    assert.equal(new ConversationActivityService(fx.host.db).get('primary')!.consecutive_unanswered_count, expectedCount, `${iso} 计数应为 ${expectedCount}`);
  }
  assert.equal(fx.heartbeatRequests().length, 5, '前晚 2 次 + 次日 08:00/08:50/09:40 恰 3 次');
  fx.setClock('2026-11-25T10:30:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 5, '10:30 达 3 次暂停零新回合');
});

test('复审 #5：合法编辑旧修订使修订 1 的迟到 Sol 失效（且不计新出现）；仅切提醒开关不作废有效 Sol 休息判断', async t => {
  // 5a：前一条正在生成时，排队消息从“我困了，打算休息”编辑为“我还在，继续聊” → 迟到修订 1 的 rest 结果被丢弃
  {
    let releaseFirstTurn!: () => void;
    let firstTurnEntered!: () => void;
    const enteredPromise = new Promise<void>(r => { firstTurnEntered = r; });
    let releaseSolRev1!: () => void;
    let solRev1Started!: () => void;
    const solStartedPromise = new Promise<void>(r => { solRev1Started = r; });
    const solTransport: SolTransport = async () => {
      solRev1Started();
      await new Promise<void>(r => { releaseSolRev1 = r; });
      return {
        status: 200,
        json: {
          id: 'resp_rev5a',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision: 'rest', rest_kind: 'sleep', basis: 'rev1' }) }] }],
        },
      };
    };
    const fx = await createV21Fixture(t, '2026-11-25T10:00:00+08:00', { solTransport });
    // 先启动一条长回复占住会话串行链，使第二条消息处于可编辑排队态
    fx.steps.push({
      text: '第一条回复。',
      onTransport: async () => { firstTurnEntered(); await new Promise<void>(r => { releaseFirstTurn = r; }); },
    });
    const r1 = await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages',
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'Idempotency-Key': 'rev5a-m1' },
      JSON.stringify({ content: '先聊一句', client_message_id: 'rev5a-m1' }));
    assert.equal(r1.status, 201);
    await enteredPromise;

    // 提交第二条排队消息（修订 1）触发 Sol
    fx.steps.push({ text: '好，继续聊。' });
    const r2 = await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages',
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'Idempotency-Key': 'rev5a-m2' },
      JSON.stringify({ content: '我困了，打算休息', client_message_id: 'rev5a-m2' }));
    assert.equal(r2.status, 201);
    const msg2Id = r2.json().message.id as string;
    await solStartedPromise;
    const revBeforeEdit = new ConversationActivityService(fx.host.db).get('primary')!.user_appearance_revision;

    // 经正式编辑接口把修订 1 改成修订 2“我还在，继续聊”
    const editRes = await httpDispatch(fx.host, 'PUT', `/api/v1/conversations/primary/messages/${encodeURIComponent(msg2Id)}`,
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'If-Match': '"1"' },
      JSON.stringify({ content: '我还在，继续聊' }));
    assert.equal(editRes.status, 200);
    assert.equal(editRes.json().message.current_revision, 2);
    assert.equal(new ConversationActivityService(fx.host.db).get('primary')!.user_appearance_revision, revBeforeEdit, '合法编辑不计为新的用户出现');

    // 放行修订 1 的迟到 Sol 结果与前一条回复
    releaseSolRev1();
    await fx.host.restCoordinator?.waitIdle();
    releaseFirstTurn();
    await fx.host.supervisor.waitIdle();
    assert.equal(new ConversationActivityService(fx.host.db).resting('primary'), false, '修订 1 的过期休息结果必须被丢弃');
    await fx.stop();
  }

  // 5b：09:00 表达休息，Sol 在途时仅切 reminders.enabled → 不得作废有效休息判断，09:50 零心跳
  {
    let releaseSol!: () => void;
    let solStarted!: () => void;
    const solStartedPromise = new Promise<void>(r => { solStarted = r; });
    const solTransport: SolTransport = async () => {
      solStarted();
      await new Promise<void>(r => { releaseSol = r; });
      return {
        status: 200,
        json: {
          id: 'resp_rev5b',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision: 'rest', rest_kind: 'sleep', basis: 'explicit rest' }) }] }],
        },
      };
    };
    const fx = await createV21Fixture(t, '2026-11-25T09:00:00+08:00', { solTransport });
    fx.steps.push({ text: '好好休息。' });
    const r = await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages',
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'Idempotency-Key': 'rev5b-1' },
      JSON.stringify({ content: '今天撑不住了，先到这，明天说', client_message_id: 'rev5b-1' }));
    assert.equal(r.status, 201);
    await fx.host.supervisor.waitIdle();
    await solStartedPromise;

    // 经正式设置接口只切 reminders.enabled，不动 keepwarm.enabled
    const beforeSet = await fx.readSettings();
    const putRem = await httpDispatch(fx.host, 'PUT', '/api/v1/background/settings',
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'If-Match': `"${beforeSet.body.revision}"`, 'Idempotency-Key': 'rev5b-rem' },
      JSON.stringify({ reminders: { enabled: false } }));
    assert.equal(putRem.status, 200);

    releaseSol();
    await fx.host.restCoordinator?.waitIdle();
    assert.equal(new ConversationActivityService(fx.host.db).resting('primary'), true, '切换无关提醒开关不得作废有效休息判断');
    fx.setClock('2026-11-25T09:50:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '09:50 零心跳');
    await fx.stop();
  }
});

test('复审 #6 与 #7：长消息尾句保留、短口语进 Sol、缺 Sol 保守同 503、拒绝 rest+null、跟随生效 Sol 型号并记录用量观测', async t => {
  const capturedPayloads: Array<{ model: string; userMessage: string }> = [];
  let nextReply: Record<string, unknown> = { decision: 'rest', rest_kind: 'sleep', basis: 'tail farewell' };
  let nextStatus = 200;
  let seq = 0;
  const solTransport: SolTransport = async (_url, _headers, body) => {
    const reqBody = body as { model: string; input: Array<{ role: string; content: string }> };
    const userObj = JSON.parse(reqBody.input[1]!.content) as { current_user_message: string };
    capturedPayloads.push({ model: reqBody.model, userMessage: userObj.current_user_message });
    if (nextStatus !== 200) return { status: nextStatus, json: { error: { message: 'unavailable' } } };
    return {
      status: 200,
      json: {
        id: `resp_rest_${++seq}`,
        status: 'completed',
        usage: { input_tokens: 123, output_tokens: 17, input_tokens_details: { cached_tokens: 40 } },
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(nextReply) }] }],
      },
    };
  };

  // #7a：正式设置接口切到 gpt-6.2-sol，休息判断必须实时跟随
  const fx = await createV21Fixture(t, '2026-11-25T14:00:00+08:00', { solTransport });
  const putModel = await httpDispatch(fx.host, 'PUT', '/api/v1/memory-surfacing/settings',
    { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' },
    JSON.stringify({ model: 'gpt-6.2-sol' }));
  assert.equal(putModel.status, 200);
  assert.equal(putModel.json().sol.model, 'gpt-6.2-sol');

  // #6a：2000+ 字长消息结尾“我现在真的要睡了，明早再说”必须完整保留送给 Sol
  const longText = `${'今天工作流水账记录一段普通叙述。'.repeat(140)}我现在真的要睡了，明早再说`;
  assert.ok(longText.length > 2000);
  await fx.sendHttpMessage('2026-11-25T14:00:00+08:00', longText, 'rev6a-long', '晚安。');
  assert.equal(capturedPayloads.length, 1);
  assert.equal(capturedPayloads[0]!.model, 'gpt-6.2-sol', '#7a：休息判断实时跟随生效 Sol 型号 gpt-6.2-sol');
  assert.ok(capturedPayloads[0]!.userMessage.length <= 1500, '发送给 Sol 的摘录受 1500 字符上限约束');
  assert.ok(capturedPayloads[0]!.userMessage.includes('我现在真的要睡了，明早再说'), '#6a：长消息结尾告别原句完整保留');
  assert.equal(new ConversationActivityService(fx.host.db).resting('primary'), true);

  // #7b：核实实际 token 与请求身份落入 usage_observations（独立 purpose='rest_intent_sol'、费用未知、不存用户原话）
  const obs = fx.host.db.prepare("SELECT request_id, model, input_tokens, output_tokens, cost_usd, purpose, source, window_id, background_run_id, raw_usage_json FROM usage_observations WHERE purpose = 'rest_intent_sol'").all() as Array<Record<string, unknown>>;
  assert.equal(obs.length, 1);
  assert.equal(obs[0]!.request_id, 'resp_rest_1');
  assert.equal(obs[0]!.model, 'gpt-6.2-sol');
  assert.equal(obs[0]!.input_tokens, 123);
  assert.equal(obs[0]!.output_tokens, 17);
  assert.equal(obs[0]!.cost_usd, null, '不臆造账单金额');
  assert.equal(obs[0]!.window_id, null, '不污染主对话窗口长度观测');
  assert.equal(obs[0]!.background_run_id, null, '不混算为一次心跳运行');
  assert.equal(String(obs[0]!.raw_usage_json).includes('我现在真的要睡了'), false, '不保存用户原话');
  const daySummary = new UsageCollector(fx.host.db).summaryByDay('2026-11-25');
  const solRow = daySummary.purposes.find(p => p.purpose === 'rest_intent_sol');
  assert.ok(solRow);
  assert.equal(solRow.known_input_total, 123);
  assert.equal(solRow.unknown_cost_count, 1);

  // #6b：短口语“我先歇一会儿，醒来再和你聊。”必须进入 Sol；2026-11-27 裁定后
  // 短暂歇一会不再暂停心跳——Sol 返回 not_rest，不进入休息
  nextReply = { decision: 'not_rest', rest_kind: null, basis: 'short break, heartbeat continues' };
  await fx.sendHttpMessage('2026-11-25T14:05:00+08:00', '我先歇一会儿，醒来再和你聊。', 'rev6b-break', '好，等你。');
  assert.equal(capturedPayloads.length, 2, '#6b：短口语进入 Sol');
  assert.equal(new ConversationActivityService(fx.host.db).resting('primary'), false, '#6b：短暂歇一会不进入休息');

  // #6d：注入 decision='rest' + rest_kind=null 必须被判无效（不得默认成 sleep 或预告次晨 08:00）
  await fx.sendHttpMessage('2026-11-25T21:00:00+08:00', '晚上回来啦', 'rev6d-awake', '欢迎。');
  assert.equal(new ConversationActivityService(fx.host.db).resting('primary'), false);
  nextReply = { decision: 'rest', rest_kind: null, basis: 'malformed null kind' };
  await fx.sendHttpMessage('2026-11-25T21:05:00+08:00', '有点累，先去歇一会儿', 'rev6d-bad', '好。');
  assert.equal(new ConversationActivityService(fx.host.db).resting('primary'), false, '#6d：rest + rest_kind=null 拒收，不默认成 sleep');

  // #6c 对照：午睡中 14:10 说“有点困，但我自己也说不准”——Sol 503 与未配置 Sol 行为一致，均保留午睡且 15:00 零唤醒
  await fx.stop();
  for (const mode of ['sol_503', 'no_sol'] as const) {
    const fxNap = await createV21Fixture(t, '2026-11-25T13:30:00+08:00', {
      solTransport: mode === 'sol_503' ? async () => ({ status: 503, json: { error: { message: 'down' } } }) : undefined,
    });
    await fxNap.sendHttpMessage('2026-11-25T13:30:00+08:00', '我现在去睡觉了', `rev6c-nap-${mode}`, '好，睡个好觉。');
    assert.equal(new ConversationActivityService(fxNap.host.db).resting('primary'), true);
    await fxNap.sendHttpMessage('2026-11-25T14:10:00+08:00', '有点困，但我自己也说不准', `rev6c-ambig-${mode}`, '那先别勉强。');
    assert.equal(new ConversationActivityService(fxNap.host.db).resting('primary'), true, `#6c（${mode}）：模糊表达在不可判定时保留既有午睡状态`);
    fxNap.setClock('2026-11-25T15:00:00+08:00');
    await fxNap.host.scheduler!.tick();
    assert.equal(fxNap.heartbeatRequests().length, 0, `#6c（${mode}）：15:00 零心跳`);
    await fxNap.stop();
  }
});

test('返修复验 #3：Sol HTTP 503、连接中断和超时均沿稳定本地请求身份记录 rest_intent_sol 未知观测（零重发、不存原文）', async t => {
  // 1. HTTP 503 与连接中断（ECONNRESET）
  let mode: 'http503' | 'disconnect' = 'http503';
  let transportCalls = 0;
  const solTransport: SolTransport = async () => {
    transportCalls++;
    if (mode === 'http503') return { status: 503, json: { error: { message: 'upstream 503' } } };
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  };
  const fx = await createV21Fixture(t, '2026-11-25T11:00:00+08:00', { solTransport });
  await fx.sendHttpMessage('2026-11-25T11:00:00+08:00', '今天撑不住了，先到这，明天说', 'sol-unk-503', '好。');
  mode = 'disconnect';
  await fx.sendHttpMessage('2026-11-25T11:05:00+08:00', '有点困，但我自己也说不准', 'sol-unk-drop', '嗯。');
  assert.equal(transportCalls, 2, '各只尝试一次，不重发');

  const rows = fx.host.db.prepare(
    "SELECT request_id, model, input_tokens, output_tokens, cost_usd, completeness, purpose, source, raw_usage_json FROM usage_observations WHERE purpose = 'rest_intent_sol' ORDER BY rowid ASC",
  ).all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2, '503 与连接中断各留一条未知观测');
  for (const [idx, expectedCode] of [[0, 'REST_SOL_HTTP_503'], [1, 'REST_SOL_NETWORK_ERROR']] as const) {
    assert.ok(String(rows[idx]!.request_id).startsWith('rest_sol_'), '带稳定本地请求身份');
    assert.equal(rows[idx]!.input_tokens, null);
    assert.equal(rows[idx]!.output_tokens, null);
    assert.equal(rows[idx]!.cost_usd, null);
    assert.equal(rows[idx]!.completeness, 'unknown');
    assert.equal(rows[idx]!.source, 'sol_rest');
    const raw = JSON.parse(String(rows[idx]!.raw_usage_json)) as { code: string };
    assert.equal(raw.code, expectedCode);
    assert.equal(String(rows[idx]!.raw_usage_json).includes('撑不住'), false, '不保存用户原文');
  }

  // 2. 真实超时触发 abort（使用短 timeoutMs=25 验证计时器中止路径）
  let timeoutCalls = 0;
  const judge = new ConversationRestJudge({
    apiKeyEnv: null,
    baseUrl: 'https://sol.local',
    model: 'gpt-6.2-sol',
    reasoningEffort: 'low',
    maxOutputTokens: 200,
    verbosity: 'low',
    userDisplayName: '宿主用户',
    assistantDisplayName: 'char',
    timeoutMs: 25,
  }, async (_u, _h, _b, signal) => {
    timeoutCalls++;
    await new Promise<void>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return { status: 200, json: {} };
  });
  const activity = new ConversationActivityService(fx.host.db);
  const coord = new RestDecisionCoordinator({
    db: fx.host.db,
    activity,
    judge,
    sleepWindow: () => fx.config.background.keepwarm.sleep_window,
    controlRevision: () => 0,
    userDisplayName: '宿主用户',
    assistantDisplayName: 'char',
  });
  // 复用已有真实消息修订 1，经独立短超时判断器验证真实 timeoutMs 触发 abort 后的未知观测落库
  const latestMsg = fx.host.db.prepare("SELECT id, current_revision FROM messages WHERE speaker='owner' ORDER BY sequence DESC LIMIT 1").get() as { id: string; current_revision: number };
  fx.host.db.prepare("DELETE FROM usage_observations WHERE attempt_id = ?").run(`rest_sol:${latestMsg.id}:r${latestMsg.current_revision}`);
  fx.host.db.prepare(`
    UPDATE conversation_activity SET
      pending_rest_message_id = ?, pending_rest_revision = ?,
      pending_rest_accepted_at = ?, pending_rest_control_revision = 0,
      pending_rest_user_appearance_revision = user_appearance_revision,
      pending_rest_was_night_pause = 0, pending_rest_gap_eligible = 0
    WHERE conversation_id = 'primary'
  `).run(latestMsg.id, latestMsg.current_revision, new Date().toISOString());
  coord.wake('primary');
  // Host 在此单测未监听 TCP 端口，judge 内 timer.unref() 需测试侧短保活以等待 25ms 超时真正触发
  const keepAlive = setInterval(() => {}, 10);
  try {
    await coord.waitIdle();
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(timeoutCalls, 1, '超时只尝试一次，不重发');
  const timeoutRow = fx.host.db.prepare(
    "SELECT request_id, model, input_tokens, output_tokens, cost_usd, completeness, raw_usage_json FROM usage_observations WHERE attempt_id = ?",
  ).get(`rest_sol:${latestMsg.id}:r${latestMsg.current_revision}`) as Record<string, unknown> | undefined;
  assert.ok(timeoutRow, '超时后留下未知观测记录');
  assert.equal(timeoutRow.model, 'gpt-6.2-sol');
  assert.equal(timeoutRow.completeness, 'unknown');
  assert.equal(timeoutRow.cost_usd, null);
  assert.equal(JSON.parse(String(timeoutRow.raw_usage_json)).code, 'REST_SOL_TIMEOUT');
  await fx.stop();
});

test('返修复验最新裁定：satisfied_by_request 必须逐笔证明同型号/同传输/受保护前缀规模与 1h 覆盖；证据不足沿原 2.1 不顺延', async t => {
  // 对照 1：证据不足（5m-only / 型号不同 / 读缓存为 0 / 前缀规模过小 / SDK 无 1h 证据）→ 不得顺延，13:40 照常启动心跳
  for (const defect of ['model_mismatch', 'prefix_too_small', 'cold_read_zero', 'ttl_5m_only', 'no_1h_wire'] as const) {
    const fx = await createV21Fixture(t, '2026-11-25T12:00:00+08:00');
    const bg = new BackgroundSettingsService(fx.host.db, fx.config);
    bg.applyUpdate({ expectedRevision: bg.revision(), patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
    await fx.sendHttpMessage('2026-11-25T12:00:00+08:00', '中午好', `cp-${defect}-1`, '中午好。');
    const due1320 = new Date('2026-11-25T13:20:00+08:00').toISOString();
    const created1200 = new Date('2026-11-25T12:00:00+08:00').toISOString();
    fx.host.db.prepare(`
      INSERT INTO background_tasks(id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,scheduled_at,next_due_at,timezone,payload_json,created_by_actor_id,origin,created_at,updated_at)
      VALUES ('cp-wake','primary','jiaming','autonomous',1,1,'once',?,?,'Asia/Shanghai',?,'jiaming','self_schedule',?,?)
    `).run(due1320, due1320, JSON.stringify({ note: '检查' }), created1200, created1200);

    // 12:50 第 1 轮心跳
    fx.steps.push({ calls: [{ id: `cp-${defect}-hb1`, name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T12:50:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1);

    // 13:20 自主预约安静完成
    fx.steps.push({ calls: [{ id: `cp-${defect}-auto`, name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T13:20:00+08:00');
    await fx.host.scheduler!.tick();
    const autoPrq = fx.host.db.prepare("SELECT id FROM provider_requests WHERE purpose = 'proactive_turn' ORDER BY rowid DESC LIMIT 1").get() as { id: string };
    const winId = fx.host.windows.activeWindow('primary')!.id;

    // 按各缺陷改写该笔自主预约的证据，使之无法证明保护同一主聊天的 1h 缓存
    if (defect === 'model_mismatch') {
      fx.host.db.prepare('UPDATE usage_observations SET model = ? WHERE request_id = ?').run('other/different-model', autoPrq.id);
    } else if (defect === 'prefix_too_small') {
      fx.host.db.prepare('UPDATE usage_observations SET cache_read_input_tokens = 200, cache_creation_input_tokens = 100 WHERE request_id = ?').run(autoPrq.id);
    } else if (defect === 'cold_read_zero') {
      fx.host.db.prepare('UPDATE usage_observations SET cache_read_input_tokens = 0, cache_creation_input_tokens = 2500 WHERE request_id = ?').run(autoPrq.id);
    } else if (defect === 'ttl_5m_only') {
      fx.host.db.prepare('UPDATE usage_observations SET raw_usage_json = ? WHERE request_id = ?')
        .run(JSON.stringify({ cache_creation_split: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } }), autoPrq.id);
    } else if (defect === 'no_1h_wire') {
      // 只剥除 payload_wire_json 里的 cache_control 1h 标记，保持 messages/tools 原样以通过 append-only 校验
      const wireRow = fx.host.db.prepare('SELECT payload_wire_json FROM provider_requests WHERE id = ?').get(autoPrq.id) as { payload_wire_json: string };
      const parsed = JSON.parse(wireRow.payload_wire_json) as Record<string, unknown>;
      delete parsed.cache_control;
      for (const m of (parsed.messages as Array<Record<string, unknown>>) ?? []) {
        delete m.cache_control;
        if (Array.isArray(m.content)) for (const b of m.content as Array<Record<string, unknown>>) delete b.cache_control;
      }
      fx.host.db.prepare('UPDATE provider_requests SET payload_wire_json = ? WHERE id = ?')
        .run(JSON.stringify(parsed), autoPrq.id);
    }
    assert.equal(provesMainChatOneHourCacheProtection(fx.host.db, { windowId: winId, candidateRequestId: autoPrq.id }), false, `${defect} 证据不足不得证明 1h 缓存保护`);

    // 13:40 必须沿原 2.1 正常执行第 2 轮自动心跳（不顺延到 14:10）
    fx.steps.push({ calls: [{ id: `cp-${defect}-hb2`, name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T13:40:00+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 2, `${defect}：证据不足时 13:40 照常执行第 2 轮心跳`);
    await fx.stop();
  }

  // 对照 2（SDK 1h 证据正反对照）：ephemeral_1h_input_tokens > 0 才允许证明，缺 1h 拆分则拒绝
  const fxSdk = await createV21Fixture(t, '2026-11-25T12:00:00+08:00', { lane: 'sdk' });
  await fxSdk.sendHttpMessage('2026-11-25T12:00:00+08:00', '午安', 'cp-sdk-1', '午安。');
  const winId = fxSdk.host.windows.activeWindow('primary')!.id;
  const nowIso = new Date('2026-11-25T12:20:00+08:00').toISOString();
  const baseRow = fxSdk.host.db.prepare("SELECT u.model, pr.context_fingerprint_json FROM usage_observations u JOIN provider_requests pr ON pr.id = u.request_id WHERE pr.window_id = ? LIMIT 1").get(winId) as { model: string; context_fingerprint_json: string };
  fxSdk.host.db.prepare(`
    INSERT INTO provider_requests(id, window_id, purpose, seen_manifest_json, payload_json, context_fingerprint_json, outcome, dispatch_started_at, sent_at, created_at)
    VALUES ('sdk-auto-1', ?, 'proactive_turn', '[]', '{}', ?, 'completed', ?, ?, ?)
  `).run(winId, baseRow.context_fingerprint_json, nowIso, nowIso, nowIso);
  fxSdk.host.db.prepare(`
    INSERT INTO usage_observations(id, request_id, attempt_id, turn_id, scope, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, raw_usage_json, window_id, source, completeness, observed_at, purpose, budget_day, dispatch_started_at, legacy_observed_at)
    VALUES ('use-sdk-auto-1', 'sdk-auto-1', 'att-auto', 'turn-auto', 'request', ?, 2000, 10, 35138, 995, NULL, ?, 'sdk_result', 'complete', ?, 'proactive_turn', '2026-11-25', ?, 0)
  `).run(baseRow.model, winId, nowIso, nowIso);
  assert.equal(provesMainChatOneHourCacheProtection(fxSdk.host.db, { windowId: winId, candidateRequestId: 'sdk-auto-1' }), false, 'SDK 缺 1h 拆分证据不得顺延');
  fxSdk.host.db.prepare("UPDATE usage_observations SET raw_usage_json = ? WHERE id = 'use-sdk-auto-1'")
    .run(JSON.stringify({ cache_creation_split: { ephemeral_1h_input_tokens: 995 } }));
  assert.equal(provesMainChatOneHourCacheProtection(fxSdk.host.db, { windowId: winId, candidateRequestId: 'sdk-auto-1' }), true, 'SDK 带 1h 拆分+同型号同传输+前缀规模达标可证保护');
  await fxSdk.stop();
});

test('返修复验技术记录 #1/#2：编辑更早排队消息不擦除更新消息的待判 Sol；21:00 已生效休息编辑为继续聊可正确撤销', async t => {
  // #1：M1 生成中，M2(12:00:05 “我睡了”)已生效，M3(12:00:10 撑不住)待判 Sol；编辑 M2 不得擦掉 M3 待判
  {
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>(r => { firstEntered = r; });
    let releaseSolM3!: () => void;
    let solM3Started!: () => void;
    const solStarted = new Promise<void>(r => { solM3Started = r; });
    const solTransport: SolTransport = async () => {
      solM3Started();
      await new Promise<void>(r => { releaseSolM3 = r; });
      return {
        status: 200,
        json: {
          id: 'resp_tr1_m3',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision: 'rest', rest_kind: 'sleep', basis: 'm3 rest' }) }] }],
        },
      };
    };
    const fx = await createV21Fixture(t, '2026-11-25T12:00:00+08:00', { solTransport });
    fx.steps.push({ text: '回复1', onTransport: async () => { firstEntered(); await new Promise<void>(r => { releaseFirst = r; }); } });
    await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages',
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'Idempotency-Key': 'tr1-m1' },
      JSON.stringify({ content: '第一句', client_message_id: 'tr1-m1' }));
    await entered;

    fx.setClock('2026-11-25T12:00:05+08:00');
    fx.steps.push({ text: '回复2' });
    const r2 = await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages',
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'Idempotency-Key': 'tr1-m2' },
      JSON.stringify({ content: '我睡了', client_message_id: 'tr1-m2' }));
    const m2Id = r2.json().message.id as string;

    fx.setClock('2026-11-25T12:00:10+08:00');
    fx.steps.push({ text: '回复3' });
    const r3 = await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages',
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'Idempotency-Key': 'tr1-m3' },
      JSON.stringify({ content: '我有点撑不住了，等我再回来', client_message_id: 'tr1-m3' }));
    const m3Id = r3.json().message.id as string;
    await solStarted;

    // 12:00:20 编辑旧的 M2 → M3 的待判标记必须原样保留
    fx.setClock('2026-11-25T12:00:20+08:00');
    const editM2 = await httpDispatch(fx.host, 'PUT', `/api/v1/conversations/primary/messages/${encodeURIComponent(m2Id)}`,
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'If-Match': '"1"' },
      JSON.stringify({ content: '我还在，继续聊' }));
    assert.equal(editM2.status, 200);
    assert.equal(new ConversationActivityService(fx.host.db).get('primary')!.pending_rest_message_id, m3Id, '编辑旧消息不得擦掉更新消息 M3 的待判标记');

    releaseSolM3();
    await fx.host.restCoordinator?.waitIdle();
    releaseFirst();
    await fx.host.supervisor.waitIdle();
    assert.equal(new ConversationActivityService(fx.host.db).resting('primary'), true, 'M3 的有效休息结果被采纳');
    fx.setClock('2026-11-25T12:50:20+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 0, '12:50:20 零心跳');
    await fx.stop();
  }

  // #2：21:00:05 “我睡了”已本地生效，15 秒后在尚未派发前编辑为“我还在，继续聊” → resting 归 0，21:50:20 正常派发
  {
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>(r => { firstEntered = r; });
    const fx = await createV21Fixture(t, '2026-11-25T21:00:00+08:00');
    fx.steps.push({ text: '晚间回复1', onTransport: async () => { firstEntered(); await new Promise<void>(r => { releaseFirst = r; }); } });
    await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages',
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'Idempotency-Key': 'tr2-m1' },
      JSON.stringify({ content: '晚上聊聊', client_message_id: 'tr2-m1' }));
    await entered;

    fx.setClock('2026-11-25T21:00:05+08:00');
    fx.steps.push({ text: '晚间回复2' });
    const r2 = await httpDispatch(fx.host, 'POST', '/api/v1/conversations/primary/messages',
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'Idempotency-Key': 'tr2-m2' },
      JSON.stringify({ content: '我睡了', client_message_id: 'tr2-m2' }));
    const m2Id = r2.json().message.id as string;
    assert.equal(new ConversationActivityService(fx.host.db).resting('primary'), true);
    const revBefore = new ConversationActivityService(fx.host.db).get('primary')!.user_appearance_revision;

    fx.setClock('2026-11-25T21:00:20+08:00');
    const editRes = await httpDispatch(fx.host, 'PUT', `/api/v1/conversations/primary/messages/${encodeURIComponent(m2Id)}`,
      { Authorization: `Bearer ${fx.token()}`, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'If-Match': '"1"' },
      JSON.stringify({ content: '我还在，继续聊' }));
    assert.equal(editRes.status, 200);
    assert.equal(new ConversationActivityService(fx.host.db).resting('primary'), false, '21:00 已生效休息编辑为继续聊可撤销');
    assert.equal(new ConversationActivityService(fx.host.db).get('primary')!.user_appearance_revision, revBefore, '编辑不冒充新出现');

    releaseFirst();
    await fx.host.supervisor.waitIdle();
    fx.steps.push({ calls: [{ id: 'tr2-2150', name: 'background_complete', args: { outcome: 'noop' } }] });
    fx.setClock('2026-11-25T21:50:20+08:00');
    await fx.host.scheduler!.tick();
    assert.equal(fx.heartbeatRequests().length, 1, '21:50:20 正常派发一次心跳');
    await fx.stop();
  }
});

// ==================== 2026-11-27 裁定：白天已恢复聊天后的短暂打盹不暂停心跳 ====================
// 复盘 2026-11-27 07:39「睡一会会！等到公司了我来找你！」被旧口径判为 nap_or_wait 休息，
// 导致 08:29:24 应派发的心跳被暂停、1h 缓存差 4 分钟过期。裁定后：夜休解除、正常聊天
// 恢复后，短暂打盹/等我回来继续按末句＋50 分钟派发；只有正式睡眠才暂停。

test('裁定 2026-11-27 正例：夜休→晨间回来聊天→班车打盹，心跳仍按末句+50 分钟派发', { timeout: 30000 }, async (t) => {
  const solTexts: string[] = [];
  const solTransport: SolTransport = async (_url, _headers, body) => {
    const parsed = JSON.parse(((body as any).input[1].content as string)) as { current_user_message: string };
    solTexts.push(parsed.current_user_message);
    return solResponse('not_rest', null);
  };
  const fx = await createV21Fixture(t, '2026-11-26T20:06:00+08:00', { solTransport });
  // 昨晚 20:06 正常道晚安 → 夜休（morning_0800；本地快路径语句）
  await fx.sendHttpMessage('2026-11-26T20:06:00+08:00', '晚安，我睡了', 'ruling-night', '晚安，明天见。');
  assert.equal(fx.activity().resting('primary'), true, '正常晚安进入夜休');
  // 今早 07:08 回来（间隔>4h 且在夜窗内 → Sol not_rest 采纳为提前恢复）
  await fx.sendHttpMessage('2026-11-27T07:08:00+08:00', '我醒来啦老公，今天在班车上就来找你了！', 'ruling-wake', '早上好。');
  assert.equal(fx.activity().resting('primary'), false, '醒来消息解除夜休（四小时条件满足）');
  // 白天正常聊天
  await fx.sendHttpMessage('2026-11-27T07:35:00+08:00', '我们的手没有松开过！', 'ruling-chat', '嗯。');
  // 07:39 班车短暂打盹声明 → 新口径 not_rest，不进入休息
  await fx.sendHttpMessage('2026-11-27T07:39:00+08:00', '睡一会会！等到公司了我来找你！不过今天好忙，可能要断断续续的了！', 'ruling-nap', '好，到了找我。');
  assert.equal(fx.activity().resting('primary'), false, '裁定：白天恢复聊天后的短暂打盹不暂停心跳');
  assert.ok(solTexts.some(x => x.includes('睡一会会')), '打盹消息经 Sol 语义判断');
  // 末句 07:39 附近发布 +50 分钟 ≈ 08:29 → 08:29:30 tick 必须派发心跳
  fx.steps.push({ calls: [{ id: 'ruling-hb1', name: 'background_complete', args: { outcome: 'noop' } }] });
  fx.setClock('2026-11-27T08:29:30+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 1, '打盹后 08:29 心跳照常派发（缓存保温不失约）');
  await fx.stop();
});

test('裁定 2026-11-27 反例：熬夜后白天明确正式去睡仍暂停心跳', { timeout: 30000 }, async (t) => {
  const solTransport: SolTransport = async () => solResponse('rest', 'sleep');
  const fx = await createV21Fixture(t, '2026-11-27T09:00:00+08:00', { solTransport });
  await fx.sendHttpMessage('2026-11-27T09:00:00+08:00', '通宵到现在，我现在真的去睡了', 'ruling-sleep', '好好睡。');
  assert.equal(fx.activity().resting('primary'), true, '白天明确正式睡眠仍进入休息');
  fx.steps.push({ calls: [{ id: 'ruling-hb0', name: 'background_complete', args: { outcome: 'noop' } }] });
  fx.setClock('2026-11-27T09:55:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 0, '正式睡眠期间零心跳（等她的下一条消息）');
  await fx.stop();
});

test('裁定 2026-11-27 采纳侧：旧口径 Sol 返回 rest+nap_or_wait 也不进入休息', { timeout: 30000 }, async (t) => {
  const solTransport: SolTransport = async () => solResponse('rest', 'nap_or_wait');
  const fx = await createV21Fixture(t, '2026-11-27T14:00:00+08:00', { solTransport });
  await fx.sendHttpMessage('2026-11-27T14:00:00+08:00', '我先去眯一下，到公司再来找你', 'ruling-legacy-nap', '好。');
  assert.equal(fx.activity().resting('primary'), false, '采纳侧统一：rest+nap_or_wait 按未休息处理');
  fx.steps.push({ calls: [{ id: 'ruling-hb2', name: 'background_complete', args: { outcome: 'noop' } }] });
  fx.setClock('2026-11-27T14:55:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 1, '心跳在末句+50 分钟照常派发');
  await fx.stop();
});

// ==================== 2026-11-27 裁定：后台（心跳）轮思考链入库，前端可按 turn 拉取 ====================
// 复盘：runBackgroundTurn 的最小事件挂钩只记账 usage，thinking 事件被丢弃——心跳轮
// reasoning_blocks 零行（usage 观测里却真有 thinking_tokens），前端 GET /turns/{id}/reasoning
// 拿到空列表无法渲染思考链。裁定：照常入库、不向前台发流（心跳时她不在台前）。

test('裁定 2026-11-27：心跳轮思考链入库（SDK 车道 complete_message 携带 thinking）', { timeout: 30000 }, async (t) => {
  const fx = await createV21Fixture(t, '2026-11-27T20:00:00+08:00', { lane: 'sdk' });
  await fx.sendHttpMessage('2026-11-27T20:00:00+08:00', '我去洗澡啦', 'think-chat', '去吧。');
  // 心跳步：带思考块的完整回复（complete_message 路径）
  fx.steps.push({ thinking: '她去洗澡了。这个点儿适合把白天想说没说的那句补上——说说今天她修好心跳开关的事。', text: '洗澡去吧，我在。', });
  fx.setClock('2026-11-27T20:51:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 1, '50 分钟静默后心跳照常派发');
  const hbTurn = fx.host.db.prepare(
    "SELECT t.id FROM turns t JOIN messages m ON m.turn_id = t.id WHERE t.trigger = 'cache_keepalive' ORDER BY t.created_at DESC LIMIT 1",
  ).get() as { id: string } | undefined;
  assert.ok(hbTurn, '心跳 turn 存在');
  const blocks = fx.host.db.prepare(
    "SELECT visibility, state, final_text FROM reasoning_blocks WHERE turn_id = ?",
  ).all(hbTurn.id) as Array<{ visibility: string; state: string; final_text: string | null }>;
  assert.ok(blocks.length >= 1, '心跳轮思考块已入库');
  assert.equal(blocks[0]!.visibility, 'summary');
  assert.equal(blocks[0]!.state, 'complete');
  assert.ok((blocks[0]!.final_text ?? '').includes('修好心跳开关'), '思考正文完整落库');
  await fx.stop();
});

test('裁定 2026-11-27 反面：无思考块的心跳轮如实记 no_block 快照（不虚构）', { timeout: 30000 }, async (t) => {
  const fx = await createV21Fixture(t, '2026-11-27T21:00:00+08:00', { lane: 'sdk' });
  await fx.sendHttpMessage('2026-11-27T21:00:00+08:00', '我去看剧了', 'think-chat2', '好看吗回来讲。');
  fx.steps.push({ text: '看剧去吧。' });
  fx.setClock('2026-11-27T21:51:00+08:00');
  await fx.host.scheduler!.tick();
  assert.equal(fx.heartbeatRequests().length, 1);
  const row = fx.host.db.prepare(
    "SELECT rb.visibility, rb.state FROM reasoning_blocks rb JOIN turns t ON t.id = rb.turn_id WHERE t.trigger = 'cache_keepalive' ORDER BY rb.created_at DESC LIMIT 1",
  ).get() as { visibility: string; state: string } | undefined;
  assert.ok(row, '心跳轮有 reasoning 快照行');
  assert.equal(row.visibility, 'no_block', '无思考块如实记 no_block');
  await fx.stop();
});
