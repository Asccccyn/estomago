// DS 直连驱动回归（2026-10-05：DS 官方 key 独立驱动，不经 OpenRouter；身份映射隔离）。
// 全部注入假 transport，零网络零真实 key；只测驱动/payload/隔离/selection/用量口径。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import type { SdkNormalizedEvent } from '../../packages/contracts/src/sdk-events.ts';
import { DeepSeekRunner, deepSeekSelection, dsSessionId, buildDeepSeekPayload } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { orSessionId } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { normalizeDsUsage } from '../../apps/host/src/runtime/or-contract.ts';
import { contextFingerprint } from '../../apps/host/src/identity/service.ts';
import { assertAppendOnly } from '../../apps/host/src/runtime/or-payload.ts';
import type { OrRunRequest, RunnerRunResult } from '../../apps/host/src/runtime/runner.ts';

const enc = new TextEncoder();
const MODEL = 'deepseek-chat';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

function fakeTransport(responses: Array<{ status?: number; body?: string; networkError?: Error }>) {
  const calls: Array<{ payload: Record<string, unknown>; signal: AbortSignal }> = [];
  let i = 0;
  const transport: OrTransport = async (payload, signal) => {
    calls.push({ payload, signal });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    if (r.networkError) throw r.networkError;
    const frames = (r.body ?? '').split('\n\n').filter((seg) => seg.length > 0).map((seg) => enc.encode(`${seg}\n\n`));
    return { status: r.status ?? 200, headers: new Map<string, string>(), body: Readable.from(frames) };
  };
  return { transport, calls };
}

function req(over: Partial<OrRunRequest> = {}): OrRunRequest {
  return {
    driver: 'deepseek',
    purpose: 'chat',
    envelope: {
      model: MODEL,
      sessionId: dsSessionId('c1', MODEL),
      messages: [
        { role: 'system', content: [{ type: 'text', text: '系统前缀' }] },
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
      ],
      tools: [{ type: 'function', function: { name: 'memory_hold', description: 'd', parameters: {} } }],
      boundaries: [{ messageIndex: 0, contentIndex: 0 }], // supervisor 恒规划 A——DS 序列化必须忽略
      maxTokens: 256,
      reasoning: null,
    },
    previousPayload: null,
    abortController: new AbortController(),
    onEvent: () => {},
    ...over,
  };
}

async function runOnce(transport: OrTransport, events: SdkNormalizedEvent[], over: Partial<OrRunRequest> = {}): Promise<RunnerRunResult> {
  const runner = new DeepSeekRunner({ retryMax: 1 }, transport);
  const ac = new AbortController();
  return runner.run(req({ ...over, abortController: ac, onEvent: (ev) => events.push(ev) }));
}

beforeEach(() => { process.env.DEEPSEEK_API_KEY = 'test-key-not-real'; });
afterEach(() => { delete process.env.DEEPSEEK_API_KEY; });

test('payload 形状：无 OR 专属字段/无 cache_control（顶层+块级）/content 拍平/工具原样/max_tokens', () => {
  const p = buildDeepSeekPayload(req().envelope);
  assert.equal(p.session_id, undefined, '不发 session_id（身份映射只在宿主内部）');
  assert.equal(p.provider, undefined, '不发 provider.only（OR 路由概念）');
  assert.equal(p.plugins, undefined, '不发 plugins');
  assert.equal(p.cache_control, undefined, '不发顶层 cache_control');
  assert.equal(p.stream, true);
  assert.equal(p.max_tokens, 256);
  assert.equal(p.model, MODEL);
  const msgs = p.messages as Array<{ role: string; content: unknown }>;
  assert.equal(msgs[0]!.content, '系统前缀', 'system 块数组拍平为字符串');
  assert.equal(msgs[1]!.content, '你好', 'user 块数组拍平为字符串');
  assert.equal(JSON.stringify(p).includes('cache_control'), false, '整包无任何 cache_control（含消息块）');
  assert.deepEqual((p.tools as Array<{ function: { name: string } }>)[0]!.function.name, 'memory_hold');
});

test('身份映射隔离：dsSessionId 与 orSessionId 命名空间独立；指纹随驱动/DS 配置分域', () => {
  const ds = dsSessionId('c1', 'deepseek-chat');
  const or = orSessionId('c1', 'anthropic/claude-test-1', null);
  assert.notEqual(ds, or);
  assert.ok(ds.startsWith('es-ds-'), 'DS 派生独立前缀');
  const manifest = null;
  const base = { runtime: { provider: 'openrouter', sdk_version: null, setting_sources: [], builtin_tools: [], mcp_servers_allowlist: [] }, openrouter: { model: 'anthropic/claude-test-1', max_output_tokens: 8192, provider_only: ['anthropic'], reasoning: null } };
  const fOr = contextFingerprint(base as never, manifest);
  const fDs = contextFingerprint({ ...base, runtime: { ...base.runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat', max_output_tokens: 8192 } } as never, manifest);
  assert.notEqual(fOr, fDs, 'OR↔DS 切换改变上下文指纹（CONTEXT_STALE 强制换窗）');
  const fDs2 = contextFingerprint({ ...base, runtime: { ...base.runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-reasoner', max_output_tokens: 8192 } } as never, manifest);
  assert.notEqual(fDs, fDs2, 'DS 型号变化改变指纹');
});

test('deepSeekSelection：型号未配置/凭据缺失如实阻断；齐全则 ok', () => {
  const cfgNoModel = buildConfig({ runtime: { provider: 'deepseek' } });
  const s1 = deepSeekSelection(cfgNoModel);
  assert.equal(s1.status, 'blocked');
  assert.ok(s1.status === 'blocked' && s1.reasons.some((r) => r.startsWith('DS_MODEL_NOT_CONFIGURED')));
  delete process.env.DEEPSEEK_API_KEY;
  const cfgFull = buildConfig({ runtime: { provider: 'deepseek' }, deepseek: { model: MODEL } });
  const s2 = deepSeekSelection(cfgFull);
  assert.equal(s2.status, 'blocked');
  assert.ok(s2.status === 'blocked' && s2.reasons.some((r) => r.startsWith('DS_KEY_NOT_CONFIGURED')));
  process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
  const s3 = deepSeekSelection(cfgFull);
  assert.equal(s3.status, 'ok');
  assert.equal(s3.status === 'ok' && s3.runner.kind, 'deepseek');
});

test('配置硬规则：http base_url / 空 api_key_env / 非单段型号 / auto 拒绝', () => {
  assert.throws(() => buildConfig({ deepseek: { base_url: 'http://api.deepseek.com' } }), /base_url 必须 https/);
  assert.throws(() => buildConfig({ deepseek: { api_key_env: '' } }), /api_key_env 必须指定/);
  assert.throws(() => buildConfig({ deepseek: { model: 'deepseek/deepseek-chat' } }), /单段型号/);
  assert.throws(() => buildConfig({ deepseek: { model: 'deepseek-latest' } }), /auto\/latest/);
  const ok = buildConfig({ runtime: { provider: 'deepseek' }, deepseek: { model: 'deepseek-reasoner' } });
  assert.equal(ok.deepseek.model, 'deepseek-reasoner');
  assert.equal(ok.runtime.provider, 'deepseek');
  assert.equal(ok.deepseek.estimate_chars_per_token, 1.5, '中文场景粗估系数默认');
});

test('成功文本流：usage=ds_stream、prompt_cache_hit_tokens 归 cache_read、无费用字段仍 complete', async () => {
  const body = sse({ id: 'gen-ds-1', choices: [{ delta: { content: '早' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 24 } }) + DONE;
  const { transport, calls } = fakeTransport([{ body }]);
  const events: SdkNormalizedEvent[] = [];
  const result = await runOnce(transport, events);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.requestId, 'gen-ds-1');
  assert.equal(calls.length, 1);
  const usage = events.find((e) => e.kind === 'usage')!;
  assert.ok(usage.kind === 'usage');
  assert.equal(usage.source, 'ds_stream');
  assert.equal(usage.usage.input_tokens, 50);
  assert.equal(usage.usage.cache_read_input_tokens, 24, 'DS prompt_cache_hit_tokens → cache_read');
  assert.equal(usage.usage.cost_usd, undefined, '官方帧无费用→不编数');
  assert.equal(usage.completeness, 'complete', 'token 计量完整不因费用缺失降级');
});

test('工具调用流：tool_calls 聚合成 tool_use 块（供宿主工具循环）', async () => {
  const body = sse({ id: 'gen-ds-2', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'memory_hold', arguments: '{"category":"daily","text":"记' } }] } }] })
    + sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '一下"}' } }] } }] })
    + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
  const { transport } = fakeTransport([{ body }]);
  const events: SdkNormalizedEvent[] = [];
  const result = await runOnce(transport, events);
  assert.equal(result.outcome, 'completed');
  const complete = events.find((e) => e.kind === 'complete_message')!;
  assert.ok(complete.kind === 'complete_message');
  const tool = complete.matched.find((b) => b.block_type === 'tool_use')!;
  assert.equal(tool.tool_id, 'call-1');
  assert.equal(tool.tool_name, 'memory_hold');
  assert.equal(tool.text, '{"category":"daily","text":"记一下"}', '分片参数完整拼接');
});

test('length 终态：不发布伪完整（DS_FINISH_LENGTH / no_final_result）', async () => {
  const body = sse({ id: 'gen-ds-3', choices: [{ delta: { content: '截断的前半' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 256 } }) + DONE;
  const { transport } = fakeTransport([{ body }]);
  const events: SdkNormalizedEvent[] = [];
  const result = await runOnce(transport, events);
  assert.equal(result.outcome, 'no_final_result');
  assert.equal(result.errorCode, 'DS_FINISH_LENGTH');
  assert.ok(events.some((e) => e.kind === 'turn_end' && e.outcome === 'error'));
});

test('401 不自动重试；429 有界重试后成功', async () => {
  const { transport, calls } = fakeTransport([{ status: 401, body: sse({ error: { message: 'bad key' } }) }]);
  const r401 = await runOnce(transport, []);
  assert.equal(r401.outcome, 'error');
  assert.equal(r401.errorCode, 'DS_AUTH_ERROR');
  assert.equal(calls.length, 1, '401 零重试');

  const okBody = sse({ id: 'gen-ds-4', choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1 } }) + DONE;
  const { transport: t429, calls: c429 } = fakeTransport([{ status: 429, body: '' }, { body: okBody }]);
  const r429 = await runOnce(t429, []);
  assert.equal(r429.outcome, 'completed');
  assert.equal(c429.length, 2, '429 重试一次后成功');
});

test('中止：中断收口且已到计量帧照记（F20 同款抢救）', async () => {
  // 帧发完后挂住；abort 时以错误终止流（模拟真实 fetch 在 signal abort 上的行为）
  const framesBody = sse({ id: 'gen-ds-5', choices: [{ delta: { content: '部分' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 2 } });
  const frames = framesBody.split('\n\n').filter(Boolean).map((s) => enc.encode(`${s}\n\n`));
  let sawAbort = false;
  const transport: OrTransport = (_payload, signal) => new Promise((resolve) => {
    let i = 0;
    const stream = new Readable({
      read() {
        if (i < frames.length) { this.push(frames[i]!); i++; return; }
        const t = setInterval(() => {
          if (signal.aborted) {
            sawAbort = true;
            clearInterval(t);
            this.destroy(new Error('The operation was aborted'));
          }
        }, 5);
      },
    });
    resolve({ status: 200, headers: new Map<string, string>(), body: stream });
  });
  const events: SdkNormalizedEvent[] = [];
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const ac = new AbortController();
  const p = runner.run(req({ abortController: ac, onEvent: (ev) => events.push(ev) }));
  setTimeout(() => ac.abort(), 30);
  const result = await p;
  assert.equal(result.outcome, 'interrupted');
  assert.ok(sawAbort, 'transport 观察到 abort');
  const usage = events.find((e) => e.kind === 'usage');
  assert.ok(usage, '迟到 usage 仍入账（无 DONE/终态也抢救已到帧）');
});

test('append-only 断言：DS payload 前缀被改写 → 确定性错误不发', async () => {
  const prev = buildDeepSeekPayload(req().envelope);
  const tamperedReq = req({ previousPayload: prev });
  // 篡改当前消息（历史前缀之外的尾部不同不影响；这里改 model 触发 profile 变化类错误）
  const tampered = { ...tamperedReq, envelope: { ...tamperedReq.envelope, model: 'deepseek-reasoner' } } as OrRunRequest;
  const body = sse({ id: 'g', choices: [{ delta: { content: 'x' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + DONE;
  const { transport, calls } = fakeTransport([{ body }]);
  const result = await runOnce(transport, [], tampered);
  assert.equal(result.outcome, 'error');
  assert.ok(String(result.errorCode).includes('PREFIX_PROFILE_CHANGED'), `profile 变化拦截（得到 ${result.errorCode}）`);
  assert.equal(calls.length, 0, '断言失败不发送');
  // 前缀一致 + 尾部追加 → 断言通过
  const okEnvelope = { ...req().envelope, messages: [...req().envelope.messages, { role: 'assistant', content: '上一轮回复' }] };
  assert.equal(assertAppendOnly(prev, buildDeepSeekPayload(okEnvelope)), true, 'append-only 通过');
});

test('normalizeDsUsage：分类冲突标 anomaly 不 clamp；缺帧 unknown', () => {
  const a = normalizeDsUsage({ prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 60 });
  assert.equal(a.completeness, 'anomaly');
  assert.ok(a.anomalies.includes('CACHE_CATEGORIES_EXCEED_PROMPT'));
  assert.equal(normalizeDsUsage(null).completeness, 'unknown');
  const c = normalizeDsUsage({ prompt_tokens: 50, completion_tokens: 5, total_cost: 0.01 });
  assert.equal(c.cost, 0.01, 'total_cost 字段可读');
  assert.equal(c.completeness, 'complete');
});
