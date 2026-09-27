// Mock Runner（仅 ESTOMAGO_TEST_MODE=1）：消费合成夹具的真实形状事件，经归一化后交给宿主。
// 会话语义（AUD-03 测试用）：首轮生成 sess_<n> 并在 result 返回；resume 请求时沿用请求的
// session id；同 host 内每个"window 首轮"获得独立 session。结果不计入产品验收。
import type { RawStreamEvent } from '../../../../packages/contracts/src/sdk-events.ts';
import { SdkEventNormalizer } from './sdk-event-normalizer.ts';
import { randomBytes } from 'node:crypto';
import type { AgentRunner, RunnerRunRequest, RunnerRunResult } from './runner.ts';
import { fixtureScenario, type ScenarioName } from '../../../../packages/test-fixtures/src/sdk-stream.ts';

const TICK_MS = 2;

export class MockRunner implements AgentRunner {
  readonly kind = 'mock' as const;
  interruptSupport = 'claimed' as const;
  // 测试观测口：最近的 resume 请求（供会话连续性断言）
  lastResumeRequest: string | null = null;
  sessionsCreated: string[] = [];

  async run(req: RunnerRunRequest): Promise<RunnerRunResult> {
    const scenarioName = (process.env.ESTOMAGO_MOCK_SCENARIO as ScenarioName | undefined) ?? 'consistent';
    const script: RawStreamEvent[] = fixtureScenario(scenarioName, req.prompt);
    // 会话语义：有 resume → 沿用；否则按窗口创建新 session
    let sessionId = req.resumeSessionId;
    if (!sessionId) {
      sessionId = `sess_mock_${randomBytes(6).toString('hex')}`; // 唯一命名；同窗后续轮靠 resume 沿用
      this.sessionsCreated.push(sessionId);
    }
    this.lastResumeRequest = req.resumeSessionId;
    const decorated: RawStreamEvent[] = script.map((raw) =>
      raw.type === 'result' ? { ...raw, session_id: raw.session_id ?? sessionId! } : raw,
    );
    const normalizer = new SdkEventNormalizer();
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
