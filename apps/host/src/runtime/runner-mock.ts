// Mock Runner（仅 ESTOMAGO_TEST_MODE=1）：R2（2026-11-07）起消费信封请求——测试替身与
// OR/DS 走同一工具循环管线（准入/账本/容量门/wire 留证），不再存在独立的 prompt 单请求形态。
// 场景正文取信封尾部用户消息的文本块；会话语义（AUD-03 测试断言）：宿主经可选字段
// resumeSessionId 传入同窗既有 session，首轮生成 sess_<n> 并随 result 返回。
// 不冒充 OR/DS 的 wire 行为（重试/SSE 解析等）——需要真实驱动行为时注入假 transport 的对应 Runner。
import type { RawStreamEvent } from '../../../../packages/contracts/src/sdk-events.ts';
import { SdkEventNormalizer } from './sdk-event-normalizer.ts';
import { randomBytes } from 'node:crypto';
import type { AgentRunner, RunnerRunRequest, RunnerRunResult } from './runner.ts';
import type { OrMessage } from './or-payload.ts';
import { fixtureScenario, type ScenarioName } from '../../../../packages/test-fixtures/src/sdk-stream.ts';

const TICK_MS = 2;

function tailUserText(messages: OrMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role: string; content: unknown };
    if (m.role !== 'user') continue;
    const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string }>) : [{ type: 'text', text: String(m.content) }];
    const text = blocks.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n\n');
    if (text.length > 0) return text;
  }
  return '';
}

export class MockRunner implements AgentRunner {
  readonly kind = 'mock' as const;
  interruptSupport = 'claimed' as const;
  // 测试观测口：最近的 resume 请求（供会话连续性断言）
  lastResumeRequest: string | null = null;
  sessionsCreated: string[] = [];

  async run(req: RunnerRunRequest): Promise<RunnerRunResult> {
    if (req.driver === 'openrouter' || req.driver === 'deepseek') {
      // mock 不实现 OR/DS 的 wire 行为：测试若需要 OR/DS 行为应注入假 transport 的对应 Runner，不改 mock 冒充
      return { outcome: 'error', errorClassified: 'unknown', errorCode: 'MOCK_UNSUPPORTED_ENVELOPE_DRIVER', errorMessage: `mock runner 不处理 ${req.driver} 请求`, sessionId: null, requestId: null };
    }
    if (req.driver !== 'mock' || !('envelope' in req)) {
      // 旧 prompt 形状请求已随 R2 退役——mock 只消费信封请求
      return { outcome: 'error', errorClassified: 'unknown', errorCode: 'MOCK_EXPECTS_ENVELOPE', errorMessage: 'mock runner 只处理 driver=mock 的信封请求', sessionId: null, requestId: null };
    }
    // driver === 'mock'（信封请求）：夹具场景驱动本轮合成回复
    const scenarioName = (process.env.ESTOMAGO_MOCK_SCENARIO as ScenarioName | undefined) ?? 'consistent';
    const script: RawStreamEvent[] = fixtureScenario(scenarioName, tailUserText(req.envelope.messages));
    // 会话语义：宿主传入 resume → 沿用；否则按窗口创建新 session
    let sessionId = req.resumeSessionId ?? null;
    if (!sessionId) {
      sessionId = `sess_mock_${randomBytes(6).toString('hex')}`; // 唯一命名；同窗后续轮靠 resume 沿用
      this.sessionsCreated.push(sessionId);
    }
    this.lastResumeRequest = req.resumeSessionId ?? null;
    const decorated: RawStreamEvent[] = script.map((raw) =>
      raw.type === 'result' ? { ...raw, session_id: raw.session_id ?? sessionId! } : raw,
    );
    const normalizer = new SdkEventNormalizer();
    await req.onBeforeDispatch?.({ attemptIndex: 0, payloadWireJson: JSON.stringify({ model: req.envelope.model, sessionId: req.envelope.sessionId, messages: req.envelope.messages, tools: req.envelope.tools, max_tokens: req.envelope.maxTokens }) });
    for (const raw of decorated) {
      if (req.abortController.signal.aborted) return mockFinal(normalizer, sessionId, 'interrupted');
      for (const ev of normalizer.normalize(raw)) req.onEvent(ev);
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
    if (normalizer.observedSuccess) return mockFinal(normalizer, sessionId, 'completed');
    if (normalizer.lastErrorInfo) return mockFinal(normalizer, sessionId, 'error', normalizer.lastErrorInfo);
    return mockFinal(normalizer, sessionId, 'no_final_result');
  }
}

function mockFinal(n: SdkEventNormalizer, sessionId: string, outcome: RunnerRunResult['outcome'], err?: { classified: NonNullable<RunnerRunResult['errorClassified']>; message: string }): RunnerRunResult {
  return {
    outcome,
    errorClassified: err?.classified ?? null,
    errorCode: err ? (err.classified === 'route_signal' ? 'SDK_ROUTE_SIGNAL' : 'MOCK_ERROR') : null,
    errorMessage: err?.message ?? null,
    sessionId,
    requestId: null,
  };
}
