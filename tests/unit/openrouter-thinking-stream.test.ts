// OpenRouter 可读思考流回归：只使用合成 SSE；不发真实请求，不读取凭据。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { OrStreamAccumulator } from '../../apps/host/src/runtime/or-sse.ts';
import type { OrRunRequest } from '../../apps/host/src/runtime/runner.ts';
import type { SdkNormalizedEvent } from '../../packages/contracts/src/sdk-events.ts';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';

const enc = new TextEncoder();
const frame = (delta: Record<string, unknown>): string => `data: ${JSON.stringify({ id: 'gen-thinking-fixture', choices: [{ delta }] })}\n\n`;
const done = (finishReason = 'stop', reasoningTokens = 12): string => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }], usage: {
  prompt_tokens: 4096, completion_tokens: 30, cost: 0.001, prompt_tokens_details: { cached_tokens: 4090, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: reasoningTokens },
} })}\n\ndata: [DONE]\n\n`;

function temporaryHome(t: TestContext): string {
  const root = tempRoot('or-thinking-');
  const previousHome = process.env.ESTOMAGO_HOME;
  process.env.ESTOMAGO_HOME = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.ESTOMAGO_HOME;
    else process.env.ESTOMAGO_HOME = previousHome;
  });
  return root;
}

async function run(t: TestContext, chunks: string[] | AsyncIterable<Uint8Array>, opts: { onEvent?: (ev: SdkNormalizedEvent, controller: AbortController) => void } = {}) {
  temporaryHome(t);
  const events: SdkNormalizedEvent[] = [];
  let calls = 0;
  const transport: OrTransport = async () => {
    calls++;
    return { status: 200, headers: new Map<string, string>(), body: Array.isArray(chunks) ? Readable.from(chunks.map((chunk) => enc.encode(chunk))) : chunks };
  };
  const controller = new AbortController();
  const request: OrRunRequest = {
    driver: 'openrouter', purpose: 'chat', previousPayload: null, abortController: controller,
    envelope: { model: 'anthropic/claude-opus-4.6', sessionId: 'synthetic-thinking-session', messages: [{ role: 'user', content: '合成测试输入' }], tools: [], boundaries: [], maxTokens: 512, reasoning: { effort: 'medium' } },
    onEvent: (ev) => { events.push(ev); opts.onEvent?.(ev, controller); },
  };
  const runner = new OpenRouterRunner({ providerOnly: ['amazon-bedrock'], allowFallbacks: false, requireParameters: true, retryMax: 2 }, transport);
  const result = await runner.run(request);
  return { result, events, calls };
}

const thinkingText = (events: SdkNormalizedEvent[]): string => events.flatMap((event) => event.kind === 'thinking_delta' ? [event.text] : []).join('');
const completeMessage = (events: SdkNormalizedEvent[]) => events.find((event) => event.kind === 'complete_message');

test('delta.reasoning 分块追加为可读思考事件，完整块与正文分别核对', async (t) => {
  const { result, events } = await run(t, [frame({ reasoning: '合成思考' }), frame({ reasoning: '的后半段。' }), frame({ content: '合成回答。' }), done()]);
  assert.equal(result.outcome, 'completed');
  assert.equal(thinkingText(events), '合成思考的后半段。');
  assert.ok(events.findIndex((event) => event.kind === 'thinking_delta') < events.findIndex((event) => event.kind === 'text_delta'));
  const complete = completeMessage(events)!;
  assert.equal(complete.kind, 'complete_message');
  assert.deepEqual(complete.matched.map((block) => [block.block_type, block.text]), [['thinking', '合成思考的后半段。'], ['text', '合成回答。']]);
  assert.equal(new Set(complete.matched.map((block) => block.block_index)).size, 2, '思考和正文不共用块索引');
  for (const block of complete.matched) {
    assert.ok(events.some((event) => event.kind === 'content_block_stop' && event.block_index === block.block_index));
  }
});

test('结构化 text/summary 与 reasoning 别名只显示一次，签名密文仅留在原样继续态', async (t) => {
  const detailFrames = [
    [{ type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text: '合成甲' }],
    [{ type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text: '乙' }],
    [{ type: 'reasoning.summary', index: 1, summary: '合成摘要' }],
    [{ type: 'reasoning.text', index: 0, signature: 'SYNTHETIC_SIGNATURE_PRIVATE' }],
    [{ type: 'reasoning.encrypted', index: 2, data: 'SYNTHETIC_CIPHERTEXT_PRIVATE' }],
  ];
  const { result, events } = await run(t, [
    frame({ reasoning: '合成甲', reasoning_details: detailFrames[0] }),
    frame({ reasoning: '乙', reasoning_details: detailFrames[1] }),
    frame({ reasoning: '合成摘要', reasoning_details: detailFrames[2] }),
    frame({ reasoning_details: detailFrames[3] }), frame({ reasoning_details: detailFrames[4] }),
    frame({ content: '合成工具前正文', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'fixture_lookup', arguments: '{}' } }] }), done('tool_calls'),
  ]);
  assert.equal(result.outcome, 'completed');
  assert.equal(thinkingText(events), '合成甲乙合成摘要', '不会重复追加 reasoning 别名');
  assert.deepEqual(result.reasoningFrames, detailFrames, '协议继续态仍完整保留原始分片和签名');
  const complete = completeMessage(events)!;
  assert.equal(complete.kind, 'complete_message');
  assert.deepEqual(complete.matched.filter((block) => block.block_type === 'thinking').map((block) => block.text), ['合成甲乙', '合成摘要']);
  assert.equal(complete.matched.filter((block) => block.block_type === 'redacted_thinking').length, 1);
  assert.equal(complete.matched.find((block) => block.block_type === 'redacted_thinking')!.text, null);
  assert.equal(complete.matched.find((block) => block.block_type === 'text')!.text, '合成工具前正文');
  assert.equal(complete.matched.find((block) => block.block_type === 'tool_use')!.tool_id, 'fixture-call');
  assert.equal(new Set(complete.matched.map((block) => block.block_index)).size, complete.matched.length);
  assert.ok(!JSON.stringify(events).includes('SYNTHETIC_SIGNATURE_PRIVATE'));
  assert.ok(!JSON.stringify(events).includes('SYNTHETIC_CIPHERTEXT_PRIVATE'));
});

test('只报告思考用量或只返回签名时不造可读思考块，保留 supervisor 的 no_block 语义', async (t) => {
  const { result, events } = await run(t, [frame({ reasoning_details: [{ type: 'reasoning.text', index: 0, signature: 'SYNTHETIC_SIGNATURE_ONLY' }] }), frame({ content: '仅有合成回答' }), done('stop', 19)]);
  assert.equal(result.outcome, 'completed');
  assert.equal(thinkingText(events), '');
  assert.ok(!events.some((event) => event.kind === 'content_block_start' && ['thinking', 'redacted_thinking'].includes(event.block_type)));
  const complete = completeMessage(events)!;
  assert.equal(complete.kind, 'complete_message');
  assert.deepEqual(complete.matched.map((block) => block.block_type), ['text']);
  const usage = events.find((event) => event.kind === 'usage')!;
  assert.equal(usage.kind, 'usage');
  assert.equal(usage.usage.reasoning_tokens, 19, '有计费用量不等于有可读摘要');
});

test('思考 UTF-8 字节跨网络块仍完整恢复，空 reasoning 不遮蔽非空 reasoning_content', async (t) => {
  const bytes = enc.encode(frame({ reasoning: '', reasoning_content: '合成中文摘要🌿' }) + frame({ content: '完整正文' }) + done());
  async function* splitBytes() { for (const byte of bytes) yield Uint8Array.of(byte); }
  const { result, events } = await run(t, splitBytes());
  assert.equal(result.outcome, 'completed');
  assert.equal(thinkingText(events), '合成中文摘要🌿');
  const complete = completeMessage(events)!;
  assert.equal(complete.kind, 'complete_message');
  assert.equal(complete.matched.find((block) => block.block_type === 'text')!.text, '完整正文');
});

test('思考已发布后断流不重试，不发布伪造完整块', async (t) => {
  async function* brokenStream() {
    yield enc.encode(frame({ reasoning_details: [{ type: 'reasoning.summary', index: 0, summary: '合成已到达片段' }] }));
    throw new Error('synthetic socket hang up');
  }
  const { result, events, calls } = await run(t, brokenStream());
  assert.equal(result.outcome, 'error');
  assert.equal(calls, 1);
  assert.equal(thinkingText(events), '合成已到达片段');
  assert.equal(completeMessage(events), undefined, '现有 supervisor 会把已存流式块标 failed');
});

test('取消后迟到的思考不发布，但已返回的用量仍可抢救', async (t) => {
  const { result, events } = await run(t, [frame({ reasoning: '取消前合成片段', content: '同块取消后不可发布的正文' }), frame({ reasoning: '取消后不可发布' }), done()], {
    onEvent: (event, controller) => { if (event.kind === 'thinking_delta') controller.abort(); },
  });
  assert.equal(result.outcome, 'interrupted');
  assert.equal(thinkingText(events), '取消前合成片段');
  assert.ok(!events.some((event) => event.kind === 'text_delta'), '同一个网络块内后续正文也受取消 fence 保护');
  assert.ok(events.some((event) => event.kind === 'usage'));
  assert.equal(completeMessage(events), undefined);
});

test('length 终态保留已收到的思考，但不把截断流标记为完整思考', async (t) => {
  const { result, events } = await run(t, [frame({ reasoning: '合成尚未结束的摘要' }), done('length')]);
  assert.equal(result.outcome, 'no_final_result');
  assert.equal(thinkingText(events), '合成尚未结束的摘要');
  const thinkingStart = events.find((event) => event.kind === 'content_block_start' && event.block_type === 'thinking')!;
  assert.equal(thinkingStart.kind, 'content_block_start');
  assert.ok(!events.some((event) => event.kind === 'content_block_stop' && event.block_index === thinkingStart.block_index));
  const complete = completeMessage(events)!;
  assert.equal(complete.kind, 'complete_message');
  assert.ok(!complete.matched.some((block) => block.block_type === 'thinking'));
});

test('reasoning 文本遵守终态后禁止追加的协议门', () => {
  const acc = new OrStreamAccumulator();
  acc.feed(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  assert.throws(() => acc.feed(frame({ reasoning: '终态后合成片段' })), /CONTENT_AFTER_TERMINAL/);
});

test('真实 supervisor 保存可读思考及前端投影，区分密文、无可读内容和截断失败', async (t) => {
  const root = temporaryHome(t);
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' },
    openrouter: { model: 'anthropic/claude-opus-4.6', provider_only: ['amazon-bedrock'], reasoning: { effort: 'medium' } },
  });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const reasoning = new ReasoningService(db, events);
  const bodies = [
    [frame({ reasoning_details: [{ type: 'reasoning.text', index: 0, text: '合成持久化' }] }), frame({ reasoning_details: [{ type: 'reasoning.text', index: 0, text: '摘要' }] }), frame({ content: '合成正式回答' }), done()],
    [frame({ reasoning_details: [{ type: 'reasoning.encrypted', index: 0, data: 'SYNTHETIC_OPAQUE_SUPERVISOR' }] }), done()],
    [frame({ content: '没有可读思考的合成回答' }), done('stop', 18)],
    [frame({ reasoning: '合成截断思考片段' }), done('length')],
  ];
  let calls = 0;
  let streamingPersisted = false;
  const transport: OrTransport = async () => {
    const thisCall = calls++;
    const chunks = bodies[thisCall]!;
    const body = (async function* () {
      for (let i = 0; i < chunks.length; i++) {
        yield enc.encode(chunks[i]!.replaceAll('gen-thinking-fixture', `gen-supervisor-thinking-${thisCall}`));
        if (thisCall === 0 && i === 0) {
          const block = db.prepare("SELECT visibility, state, received_text FROM reasoning_blocks WHERE visibility = 'summary'").get() as { visibility: string; state: string; received_text: string } | undefined;
          assert.equal(block?.state, 'streaming', '模型尚未结束时思考增量已经到达持久化服务');
          assert.equal(block?.received_text, '合成持久化');
          streamingPersisted = true;
        }
      }
    })();
    return { status: 200, headers: new Map<string, string>(), body };
  };
  const supervisor = new TurnSupervisor({
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner: new OpenRouterRunner({ providerOnly: ['amazon-bedrock'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport) },
    reasoning, usage: new UsageCollector(db), routing: new RoutingService(db, events, messages),
    windows: new WindowManager(db, events, identity, paths.handoffsDir, config), logger: new Logger(null),
  });
  messages.ensureConversation('c1');
  try {
    for (let i = 0; i < bodies.length; i++) {
      const submitted = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `合成用户输入 ${i}`, clientMessageId: `supervisor-thinking-${i}` });
      supervisor.enqueue(submitted.turnId);
      await supervisor.waitIdle();
      const turn = db.prepare('SELECT state FROM turns WHERE id = ?').get(submitted.turnId) as { state: string };
      assert.equal(turn.state, i === 3 ? 'failed' : 'completed');
      const stored = db.prepare('SELECT visibility, state, received_text, final_text, completeness FROM reasoning_blocks WHERE attempt_id = ?').all(submitted.attemptId) as Array<{ visibility: string; state: string; received_text: string; final_text: string | null; completeness: string }>;
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.visibility, ['summary', 'redacted', 'no_block', 'summary'][i]);
      assert.equal(stored[0]!.state, i === 3 ? 'failed' : 'complete');
      const projection = reasoning.listForTurn(submitted.turnId, submitted.attemptId);
      assert.equal(projection.length, 1, '使用 HTTP reasoning 路由同源的公开 DTO 投影');
      assert.equal(projection[0]!.text, i === 0 ? '合成持久化摘要' : i === 3 ? '合成截断思考片段' : '');
      assert.equal(projection[0]!.visibility, ['summary', 'redacted', 'no_block', 'summary'][i]);
      assert.equal(projection[0]!.state, i === 3 ? 'failed' : 'complete');
      if (i === 0) {
        assert.equal(stored[0]!.received_text, '合成持久化摘要');
        assert.equal(stored[0]!.final_text, '合成持久化摘要');
        assert.equal(stored[0]!.completeness, 'complete');
      }
      if (i === 3) assert.equal(stored[0]!.final_text, null, '截断内容没有冒充完整定稿');
      const assistantMessages = messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 20 }).filter((message) => message.turn_id === submitted.turnId && message.speaker === 'assistant');
      assert.equal(assistantMessages.length, i === 1 || i === 3 ? 0 : 1, '密文或纯思考元数据不伪造正文气泡');
      if (i === 0) assert.equal(assistantMessages[0]!.revision.content, '合成正式回答', '思考不混入正式回答');
    }
    assert.equal(streamingPersisted, true);
    assert.equal(calls, 4);
    const leaked = db.prepare("SELECT COUNT(*) AS n FROM reasoning_blocks WHERE received_text LIKE '%SYNTHETIC_OPAQUE_SUPERVISOR%' OR final_text LIKE '%SYNTHETIC_OPAQUE_SUPERVISOR%'").get() as { n: number };
    assert.equal(leaked.n, 0);
  } finally {
    await supervisor.waitIdle();
    db.close();
  }
});
