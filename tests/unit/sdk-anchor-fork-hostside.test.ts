// P5（四仓合并审计 20261106）C08-SDK 宿主侧：fork/anchor 决策与更新逻辑的本地检查。
// 真实 SDK 端到端请求与上游缓存命中按 04 验收矩阵单列外部——本文件只验证宿主侧
// 可本地判定的部分：anchor 命中/失效条件、纯维护回执 fork 且不覆盖窗口 anchor。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSdkHostQuery, type SdkQueryFactory, type SdkSessionAnchor } from '../../apps/host/src/runtime/sdk-host-query.ts';

const sys = (t: string) => ({ role: 'system', content: [{ type: 'text', text: t }] });
const user = (t: string) => ({ role: 'user', content: [{ type: 'text', text: t }] });

type Captured = { resume?: string; forkSession?: boolean };
function fakeFactory(captured: Captured[], sessionId: string): SdkQueryFactory {
  return ((input: { prompt: unknown; options: { resume?: string; forkSession?: boolean } }) => {
    const opts = input.options;
    captured.push({ resume: opts?.resume, forkSession: opts?.forkSession });
    const run = (async function* () {
      yield { type: 'assistant', session_id: sessionId, message: { id: 'm1', content: [{ type: 'text', text: 'ok' }] } } as never;
      yield { type: 'result', subtype: 'success', session_id: sessionId, is_error: false, duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {}, result: 'ok' } as never;
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

test('C08-SDK 宿主侧：anchor 命中 resume；纯维护 fork 不覆盖 anchor；前缀变化失效', async () => {
  const sessions = new Map<string, SdkSessionAnchor>();
  // ① 正常轮：无 anchor → 新会话；完成后登记 anchor
  const c1: Captured[] = [];
  const r1 = await runSdkHostQuery(fakeFactory(c1, 'sess-1'), req(), sessions, async () => null, (async () => ({ pid: 1 })) as never);
  assert.equal(c1.at(-1)!.resume, undefined, '无 anchor 不 resume');
  assert.equal(c1.at(-1)!.forkSession, undefined, '非维护轮不 fork');
  const anchor = sessions.get('w1');
  assert.ok(anchor && anchor.sessionId === 'sess-1', '轮末登记 anchor');
  const anchorSnapshot = { ...anchor! };

  // ② 维护轮（历史含上一轮回复，前缀与 anchor 一致）：resume 命中 + forkSession；
  // 完成后 anchor 不被 fork 会话覆盖
  const c2: Captured[] = [];
  const r2 = await runSdkHostQuery(fakeFactory(c2, 'sess-fork'), req({
    host: {
      purpose: 'cache_keepalive', windowId: 'w1',
      envelope: { model: 'claude-test-1', tools: [], maxTokens: 64, messages: [sys('S'), user('hi'), { role: 'assistant', content: 'ok' }] },
      beforeModel: async () => {}, executeTool: async () => ({ ok: true, output: {} }),
    },
  }), sessions, async () => null, (async () => ({ pid: 1 })) as never);
  void r2;
  assert.equal(c2.at(-1)!.resume, 'sess-1', '同前缀同历史 → anchor 命中 resume');
  assert.equal(c2.at(-1)!.forkSession, true, '纯维护回执 fork（不把 ack 写进正会话）');
  const after = sessions.get('w1')!;
  assert.equal(after.sessionId, anchorSnapshot.sessionId, 'fork 会话不覆盖窗口 anchor（宿主侧语义）');

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
