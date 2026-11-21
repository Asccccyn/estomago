// P5（四仓合并审计 20261106）C08-SDK 宿主侧 + RB02/RB03（复审 20261106）：
// 真实 SDK 端到端请求与上游缓存命中按 04 验收矩阵单列外部——本文件验证宿主侧
// 可本地判定的部分，且必须消费 prompt/触发 beforeModel（复审对 3325b25 的方法纠正）：
// - anchor 命中/失效条件；维护轮不再 fork（纯1协议保留后 fork 前提失效——RB03）
// - 维护成功后锚随真实最终会话前进；前缀变化失效删锚
// - background_complete 后的合法停发归一为 completed（不再 failed turn——RB02）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runSdkHostQuery, type SdkQueryFactory, type SdkSessionAnchor } from '../../apps/host/src/runtime/sdk-host-query.ts';
import { ContractError } from '../../apps/host/src/runtime/or-contract.ts';

const sys = (t: string) => ({ role: 'system', content: [{ type: 'text', text: t }] });
const user = (t: string) => ({ role: 'user', content: [{ type: 'text', text: t }] });

type Captured = { resume?: string; forkSession?: boolean };
/** 消费 prompt（驱动 replay/输入流与 beforeModel）+可编程事件脚本的 fake query。 */
function fakeFactory(captured: Captured[], sessionId: string, script: { callPostToolBatchHook?: (hook: (input: unknown) => Promise<unknown>) => Promise<void>; emitResult?: boolean } = {}): SdkQueryFactory {
  return ((input: { prompt: AsyncIterable<unknown>; options: { resume?: string; forkSession?: boolean; hooks?: { PostToolBatch?: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> } } }) => {
    const opts = input.options;
    captured.push({ resume: opts?.resume, forkSession: opts?.forkSession });
    const run = (async function* () {
      // 真实 SDK 消费输入流：驱动 admitted→replay→beforeModel(round0)→输入。
      // 先让输入流真实走完 round0 beforeModel（真实 SDK 先消费输入再产出事件），
      // 避免测试内事件与输入消费的人为竞态。
      const drain = (async () => { try { for await (const _ of input.prompt) { void _; } } catch { /* 输入流关闭 */ } })();
      await new Promise((r) => setTimeout(r, 20));
      yield { type: 'assistant', session_id: sessionId, message: { id: 'm1', content: [{ type: 'text', text: 'ok' }] } } as never;
      const hook = opts?.hooks?.PostToolBatch?.[0]?.hooks?.[0];
      if (hook && script.callPostToolBatchHook) await script.callPostToolBatchHook(hook);
      if (script.emitResult !== false) {
        yield { type: 'result', subtype: 'success', session_id: sessionId, is_error: false, duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {}, result: 'ok' } as never;
      }
      // emitResult=false：无 result 事件即收口（RB02 的严苛形态：hook continue:false 停发）
      void drain;
    })();
    return Object.assign(run, { close() {} }) as never;
  });
}

function req(over: Record<string, unknown> = {}) {
  return {
    prompt: '',
    options: { options: { systemPrompt: 'S', env: {} } },
    abortController: new AbortController(),
    onEvent: () => {},
    host: {
      purpose: 'chat', windowId: 'w1', envelope: { model: 'claude-test-1', tools: [], maxTokens: 64, messages: [sys('S'), user('hi')] },
      beforeModel: async () => {}, executeTool: async () => ({ ok: true, output: {} }),
    },
    ...over,
  } as never;
}

test('RB03：anchor 命中 resume；维护轮不 fork、成功后锚前进；前缀变化失效', async () => {
  const sessions = new Map<string, SdkSessionAnchor>();
  // ① 正常轮：无 anchor → 新会话；完成后登记 anchor
  const c1: Captured[] = [];
  await runSdkHostQuery(fakeFactory(c1, 'sess-1'), req(), sessions, async () => null, (async () => ({ pid: 1 })) as never);
  assert.equal(c1.at(-1)!.resume, undefined, '无 anchor 不 resume');
  assert.equal(c1.at(-1)!.forkSession, undefined, '普通轮不 fork');
  const anchor = sessions.get('w1');
  assert.ok(anchor && anchor.sessionId === 'sess-1', '轮末登记 anchor');

  // ② 维护轮（前缀与 anchor 一致）：resume 命中、不 fork；成功后锚随真实最终会话前进
  // （RB03：纯1协议保留后维护记录属于当前会话；旧 fork 策略与保留合同冲突已废除）
  const c2: Captured[] = [];
  await runSdkHostQuery(fakeFactory(c2, 'sess-main'), req({
    host: {
      purpose: 'cache_keepalive', windowId: 'w1',
      envelope: { model: 'claude-test-1', tools: [], maxTokens: 64, messages: [sys('S'), user('hi'), { role: 'assistant', content: 'ok' }] },
      beforeModel: async () => {}, executeTool: async () => ({ ok: true, output: {} }),
    },
  }), sessions, async () => null, (async () => ({ pid: 1 })) as never);
  assert.equal(c2.at(-1)!.resume, 'sess-1', '同前缀同历史 → anchor 命中 resume');
  assert.notEqual(c2.at(-1)!.forkSession, true, 'RB03：维护轮不再 fork（协议保留）');
  const after = sessions.get('w1')!;
  assert.equal(after.sessionId, 'sess-main', '维护成功后锚前进到真实最终会话（下次请求不再重放维护记录）');

  // ③ 前缀变化（换型号）→ 不 resume 不 fork，anchor 删除（失败/失效轮不保留旧锚）
  const c3: Captured[] = [];
  await runSdkHostQuery(fakeFactory(c3, 'sess-new'), req({
    host: {
      purpose: 'chat', windowId: 'w1', envelope: { model: 'claude-DIFFERENT', tools: [], maxTokens: 64, messages: [sys('S'), user('hi')] },
      beforeModel: async () => {}, executeTool: async () => ({ ok: true, output: {} }), onEvent: () => {},
    },
  }), sessions, async () => null, (async () => ({ pid: 1 })) as never);
  assert.equal(c3.at(-1)!.resume, undefined, '前缀变化 → 不 resume（prefix_changed）');
  assert.equal(c3.at(-1)!.forkSession, undefined, '失效不 fork');
});

test('RB02：background_complete 后的合法停发归一为 completed（不再 failed turn / 晚补字段）', async () => {
  const sessions = new Map<string, SdkSessionAnchor>();
  const stopReason: { value?: unknown } = {};
  // beforeModel 在 round>0 抛业务完成（与 supervisor complete 门同一 ContractError）
  const r = await runSdkHostQuery(fakeFactory([], 'sess-bc', {
    emitResult: false,
    callPostToolBatchHook: async (hook) => { stopReason.value = await hook({}); },
  }), req({
    host: {
      purpose: 'cache_keepalive', windowId: 'w1',
      envelope: { model: 'claude-test-1', tools: [], maxTokens: 64, messages: [sys('S'), user('维护心跳')] },
      beforeModel: async (_m, round) => { if (round > 0) throw new ContractError('BACKGROUND_COMPLETED_STOP'); },
      executeTool: async () => ({ ok: true, output: { completed: true, outcome: 'noop' } }),
    },
  }), sessions, async () => null, (async () => ({ pid: 1 })) as never);
  assert.deepEqual(stopReason.value, { continue: false, stopReason: 'EST_BACKGROUND_COMPLETED' }, 'PostToolBatch 合法停发与异常分开');
  assert.equal(r.outcome, 'completed', 'RB02：合法业务完成=completed（旧实现 error/BACKGROUND_COMPLETED_STOP→failed turn）');
  assert.equal(r.errorCode, null, '不携带失败错误码');
  assert.ok(sessions.get('w1'), '成功收尾保留 SDK 锚（旧实现 error 分支删锚）');
});

// Codex P1-10（2026-11-16）：失败 result 的具体原因（error/errors 数组，如 Overloaded）
// 在归一化层已提取——最终 RunnerRunResult.errorMessage 必须携带，不再只剩 SDK_* 稳定码。
test('P1-10: 失败 result 的具体原因进入最终回执 errorMessage', async () => {
  const factory: SdkQueryFactory = ((input: { prompt: AsyncIterable<unknown> }) => {
    const run = (async function* () {
      void (async () => { try { for await (const _ of input.prompt) void _; } catch { /* closed */ } })();
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, error: 'unknown', errors: ['Overloaded: upstream busy'], session_id: 'sess-p10', usage: {} } as never;
    })();
    return Object.assign(run, { close() {} }) as never;
  });
  const r = await runSdkHostQuery(factory, req(), new Map(), async () => null, (async () => ({ pid: 1 })) as never);
  assert.equal(r.outcome, 'error');
  assert.match(String(r.errorMessage ?? ''), /Overloaded/, '具体原因不再丢失');
  assert.ok(r.errorCode === null || /^SDK_/.test(r.errorCode), '稳定码语义保留');
});

test('MCP uses only verified source from its own main stream tool block', async () => {
  const wireName = 'mcp__est__probe_tool';
  const args = { text: '中' };
  const escaped = '{"text":"\\u4e2d"}';
  const literal = '{"text":"中"}';
  const calls = ['escaped', 'literal', 'mismatched', 'oversized', 'no-stream'];
  const observed: Array<[string, string | undefined]> = [];
  const stream = (event: Record<string, unknown>, parent_tool_use_id: string | null = null) =>
    ({ type: 'stream_event', event, parent_tool_use_id }) as never;
  const blockStart = (index: number, id: string) =>
    ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: wireName, input: {} } });
  const delta = (index: number, partial_json: string) =>
    ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
  const blockStop = (index: number) => ({ type: 'content_block_stop', index });

  const factory: SdkQueryFactory = ({ prompt, options }) => {
    const run = (async function* () {
      assert.notEqual(typeof prompt, 'string');
      const promptInput = (prompt as Exclude<typeof prompt, string>)[Symbol.asyncIterator]();
      await promptInput.next();
      const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
      const server = options?.mcpServers?.est;
      assert.ok(hook && server?.type === 'sdk');
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'synthetic-sdk', version: '1' });
      try {
        await server.instance.connect(serverTransport);
        await client.connect(clientTransport);
        yield stream({ type: 'message_start', message: { id: 'main', model: 'claude-test-1' } });
        yield stream(blockStart(0, calls[0]!));
        yield stream(delta(0, escaped.slice(0, 11)));
        yield stream(delta(0, escaped.slice(11)));
        yield stream(blockStart(1, calls[1]!));
        yield stream(delta(1, literal));
        yield stream(blockStart(0, 'subagent-collision'), 'parent-block');
        yield stream(delta(0, '{"text":"subagent"}'), 'parent-block');
        yield stream(blockStop(0), 'parent-block');
        yield stream(blockStop(1));
        yield stream(blockStart(2, calls[2]!));
        yield stream(delta(2, '{"text":"different"}'));
        yield stream(blockStop(2));
        yield stream(blockStart(3, calls[3]!));
        yield stream(delta(3, literal + ' '.repeat(1024 * 1024)));
        yield stream(blockStop(3));
        yield { type: 'assistant', message: { id: 'main', content: calls.map(id => ({ type: 'tool_use', id, name: wireName, input: args })) } } as never;
        for (const [index, tool_use_id] of calls.entries()) {
          await hook({ hook_event_name: 'PreToolUse', tool_name: wireName, tool_input: args, tool_use_id,
            session_id: 'synthetic', transcript_path: '', cwd: '' }, tool_use_id, { signal: new AbortController().signal });
          const result = await client.callTool({ name: 'probe_tool', arguments: args });
          assert.equal(result.isError, false);
          // A complete matching object is already usable before the iterator delivers block stop.
          if (index === 0) yield stream(blockStop(0));
        }
        yield { type: 'result', subtype: 'success', session_id: 'synthetic' } as never;
      } finally {
        await client.close();
        await promptInput.return?.();
      }
    })();
    return Object.assign(run, { close() {} }) as never;
  };
  const result = await runSdkHostQuery(factory, req({
    host: {
      purpose: 'chat', windowId: 'argument-source', envelope: {
        model: 'claude-test-1', maxTokens: 64, messages: [sys('S'), user('hi')],
        tools: [{ type: 'function', function: { name: 'probe_tool', description: 'synthetic', parameters: { type: 'object' } } }],
      },
      beforeModel: async () => {},
      modelStarted: () => {},
      executeTool: async (_name: string, _args: Record<string, unknown>, id: string, _round: number, messages: unknown, source?: string) => {
        assert.ok(Array.isArray(messages));
        observed.push([id, source]);
        return { ok: true, output: {} };
      },
    },
  }), new Map(), async () => null, (() => ({ pid: 1 })) as never);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(observed, [
    ['escaped', escaped], ['literal', literal], ['mismatched', undefined],
    ['oversized', undefined], ['no-stream', undefined],
  ]);
});
