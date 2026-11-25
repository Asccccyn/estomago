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
import { keepwarmStatusText } from '../../apps/web/react/src/background-controls-model.ts';
import { EstomagoClient } from '../../apps/web/react/src/chat-client.ts';
import { makeFixtureToolsResident, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import { installHeartbeatFixtureSources } from '../helpers/heartbeat-sources.ts';
import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';

type Step = {
  text?: string;
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
    await fx.sendHttpMessage('2026-11-25T14:00:00+08:00', '我去午睡了', 'b4-nap', '好');
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
  await fx.sendHttpMessage('2026-11-26T10:20:00+08:00', '我去午睡了', 'f-nap', '好');
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
