// WP1 回归：OR 驱动行为（注入假 transport，零网络；不读真 key、不连真实外部服务）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import type { SdkNormalizedEvent } from '../../packages/contracts/src/sdk-events.ts';
import { OpenRouterRunner, openRouterSelection, orSessionId, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { buildOrPayload } from '../../apps/host/src/runtime/or-payload.ts';
import type { OrRunRequest, RunnerRunResult } from '../../apps/host/src/runtime/runner.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

type Call = { payload: Record<string, unknown>; signal: AbortSignal };

function fakeTransport(responses: Array<{ status?: number; headers?: Record<string, string>; body?: string; networkError?: Error }>) {
  const calls: Call[] = [];
  let i = 0;
  const transport = async (payload: Record<string, unknown>, signal: AbortSignal) => {
    calls.push({ payload, signal });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    if (r.networkError) throw r.networkError;
    // 按 SSE 帧边界分块下发——贴近真实网络（逐帧到达，驱动逐帧发布增量）
    const frames = (r.body ?? '').split('\n\n').filter((seg) => seg.length > 0).map((seg) => enc.encode(`${seg}\n\n`));
    return {
      status: r.status ?? 200,
      headers: new Map(Object.entries({ ...(r.headers ?? {}) })) as Map<string, string>,
      body: Readable.from(frames),
    };
  };
  return { transport, calls };
}

function req(over: Partial<OrRunRequest> = {}): OrRunRequest {
  return {
    driver: 'openrouter',
    purpose: 'chat',
    envelope: {
      model: MODEL,
      sessionId: 'es-fixed-session',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      tools: [],
      boundaries: [],
      maxTokens: 512,
      reasoning: null,
    },
    previousPayload: null,
    abortController: new AbortController(),
    onEvent: () => {},
    ...over,
  };
}

const okText = sse({ id: 'gen-1', choices: [{ delta: { content: '早' } }] }) + sse({ choices: [{ delta: { content: '安' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }) + DONE;

async function runOnce(transport: OrTransport, events: SdkNormalizedEvent[], over: Partial<OrRunRequest> = {}): Promise<RunnerRunResult> {
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 1 }, transport);
  const ac = new AbortController();
  return runner.run(req({ ...over, abortController: ac, onEvent: (ev) => events.push(ev) }));
}

beforeEach(() => { process.env.OPENROUTER_API_KEY = 'test-key-not-real'; });
afterEach(() => { delete process.env.OPENROUTER_API_KEY; });

test('成功文本流：事件序列完整、attempts=1、requestId=generation id', async () => {
  const { transport, calls } = fakeTransport([{ body: okText }]);
  const events: SdkNormalizedEvent[] = [];
  const result = await runOnce(transport, events);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.attempts, 1);
  assert.equal(result.requestId, 'gen-1');
  assert.equal(calls.length, 1);
  // 序列：message_start → content_block_start → text_delta×2 → usage → content_block_stop → complete_message → turn_end
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['message_start', 'content_block_start', 'text_delta', 'text_delta', 'usage', 'content_block_stop', 'complete_message', 'turn_end']);
  assert.equal(events[0]!.kind === 'message_start' && events[0].model, MODEL);
  const complete = events.find((e) => e.kind === 'complete_message')!;
  assert.ok(complete.kind === 'complete_message' && complete.matched[0]!.block_type === 'text' && complete.matched[0]!.text === '早安');
  const usage = events.find((e) => e.kind === 'usage')!;
  assert.ok(usage.kind === 'usage' && usage.source === 'or_stream' && usage.usage.input_tokens === 10 && usage.usage.cache_read_input_tokens === 4);
  // payload 控制字段（§6.2 控制片段）
  const p = calls[0]!.payload;
  assert.equal(p.model, MODEL);
  assert.equal(p.session_id, 'es-fixed-session');
  assert.deepEqual(p.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(p.plugins, [{ id: 'context-compression', enabled: false }]);
});

test('工具调用流：matched tool_use 块、parsedArguments 不在事件层重组', async () => {
  const body = sse({ id: 'gen-t', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-9', type: 'function', function: { name: 'hold', arguments: '{"k":' } }] } }] })
    + sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] })
    + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    + DONE;
  const { transport } = fakeTransport([{ body }]);
  const events: SdkNormalizedEvent[] = [];
  const result = await runOnce(transport, events);
  assert.equal(result.outcome, 'completed');
  const complete = events.find((e) => e.kind === 'complete_message')!;
  assert.ok(complete.kind === 'complete_message');
  const tool = complete.matched.find((b) => b.block_type === 'tool_use')!;
  assert.equal(tool.tool_id, 'call-9');
  assert.equal(tool.tool_name, 'hold');
  assert.equal(tool.text, '{"k":1}');
});

test('401 不重试：单次调用、稳定错误码', async () => {
  const { transport, calls } = fakeTransport([{ status: 401, body: '' }]);
  const result = await runOnce(transport, []);
  assert.equal(result.outcome, 'error');
  assert.equal(result.errorCode, 'OR_AUTH_ERROR');
  assert.equal(calls.length, 1, '401 绝不自动重试（§9.2）');
});

test('429 有界重试并遵守 Retry-After=0；预算耗尽后如实失败', async () => {
  const { transport, calls } = fakeTransport([
    { status: 429, headers: { 'retry-after': '0' }, body: '' },
    { body: okText },
  ]);
  const result = await runOnce(transport, []);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
  const { transport: t2, calls: c2 } = fakeTransport([
    { status: 429, headers: { 'retry-after': '0' }, body: '' },
    { status: 429, headers: { 'retry-after': '0' }, body: '' },
    { status: 429, headers: { 'retry-after': '0' }, body: '' },
  ]);
  const r2 = await runOnce(t2, []);
  assert.equal(r2.outcome, 'error');
  assert.equal(c2.length, 2, 'retryMax=1：初次+1次重试后停（§9.2 建议两次恢复尝试内）');
});

test('流前网络故障可重试；已开始流后网络故障不重试', async () => {
  const { transport, calls } = fakeTransport([
    { networkError: new Error('fetch failed: ECONNRESET') },
    { body: okText },
  ]);
  const r = await runOnce(transport, []);
  assert.equal(r.outcome, 'completed');
  assert.equal(calls.length, 2);
  // 已收到数据后断流 → error（无已发布输出可重试的前提已破坏）
  const brokenMid = Readable.from([enc.encode(sse({ id: 'g', choices: [{ delta: { content: '部分' } }] }))]);
  let threw = false;
  const tMid: OrTransport = async () => ({ status: 200, headers: new Map<string, string>(), body: (async function* () { yield* brokenMid; threw = true; throw new Error('socket hang up'); })() });
  const r2 = await runOnce(tMid, []);
  assert.equal(r2.outcome, 'error');
  assert.equal(r2.errorClassified, 'network');
  assert.ok(threw);
});

test('中途停止：interrupted；已发布正文由 supervisor 负责中断语义', async () => {
  const slow = (async function* () {
    yield enc.encode(sse({ id: 'g', choices: [{ delta: { content: '第一段' } }] }));
    await new Promise((r) => setTimeout(r, 60));
    yield enc.encode(sse({ choices: [{ delta: { content: '迟到' } }] }));
  })();
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 1 }, async () => ({ status: 200, headers: new Map<string, string>(), body: slow }));
  const ac = new AbortController();
  const events: SdkNormalizedEvent[] = [];
  const p = runner.run(req({ abortController: ac, onEvent: (ev) => events.push(ev) }));
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  const result = await p;
  assert.equal(result.outcome, 'interrupted');
  assert.ok(events.some((e) => e.kind === 'text_delta'), '停止前已发布的不丢');
});

test('finish_reason=length：不得发布完整成功（no_final_result）', async () => {
  const body = sse({ id: 'g', choices: [{ delta: { content: '被截断的' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'length' }] }) + DONE;
  const { transport } = fakeTransport([{ body }]);
  const result = await runOnce(transport, []);
  assert.equal(result.outcome, 'no_final_result');
  assert.equal(result.errorCode, 'OR_FINISH_LENGTH');
});

test('X-Generation-Id 与正文 id 冲突：报告 system_notice，不吞掉', async () => {
  const body = sse({ id: 'gen-body-1', choices: [{ delta: { content: 'x' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + DONE;
  const { transport } = fakeTransport([{ body, headers: { 'x-generation-id': 'gen-hdr' } }]);
  const events: SdkNormalizedEvent[] = [];
  await runOnce(transport, events);
  assert.ok(events.some((e) => e.kind === 'system_notice' && e.subtype === 'or_generation_id_conflict'), '冲突要报告（§9.1）');
});

test('previousPayload：前缀改写被 P2 断言拦截', async () => {
  const { transport } = fakeTransport([{ body: okText }]);
  const prev = buildOrPayload({ model: MODEL, sessionId: 'es-fixed-session', messages: [{ role: 'user', content: [{ type: 'text', text: '旧正文' }] }] });
  const result = await runOnce(transport, [], { previousPayload: prev });
  assert.equal(result.outcome, 'error');
  assert.equal(result.errorCode, 'HISTORY_CHANGED:0');
});

test('选择门：型号/凭据缺失如实 blocked；不猜默认型号', () => {
  const cfgNoModel = buildConfig({ runtime: { provider: 'openrouter' } });
  const s1 = openRouterSelection(cfgNoModel);
  assert.equal(s1.status, 'blocked');
  assert.ok(s1.status === 'blocked' && s1.reasons.some((r) => r.startsWith('OR_MODEL_NOT_CONFIGURED')));
  const cfgModel = buildConfig({ runtime: { provider: 'openrouter' }, openrouter: { model: MODEL } });
  delete process.env.OPENROUTER_API_KEY;
  const s2 = openRouterSelection(cfgModel);
  assert.ok(s2.status === 'blocked' && s2.reasons.some((r) => r.startsWith('OR_KEY_NOT_CONFIGURED')));
  process.env.OPENROUTER_API_KEY = 'test-key-not-real';
  const s3 = openRouterSelection(cfgModel);
  assert.ok(s3.status === 'ok' && s3.runner.kind === 'openrouter');
  // OR 选择门不依赖 SDK 专属前提（sdk_version 不匹配不影响 OR 分支）
  const cfgSdkMismatch = buildConfig({ runtime: { provider: 'openrouter', sdk_version: '9.9.9-mismatch' }, openrouter: { model: MODEL } });
  const s4 = openRouterSelection(cfgSdkMismatch);
  assert.equal(s4.status, 'ok');
});

test('session_id：房间×型号派生、稳定且匿名（≤256）', () => {
  const a = orSessionId('primary', MODEL, null);
  const b = orSessionId('primary', MODEL, null);
  const c = orSessionId('primary', 'anthropic/claude-test-2', null);
  assert.equal(a, b, '同房间同型号稳定（不每次随机）');
  assert.notEqual(a, c, '型号变更单独命名空间（§6.2）');
  assert.ok(a.length <= 256 && !/zhou|jiaming|qiaosheng/i.test(a), '长度合规且不含真实姓名');
});
