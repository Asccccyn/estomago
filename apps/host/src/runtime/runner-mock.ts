// Mock Runner：仅测试模式（ESTOMAGO_TEST_MODE=1）。消费合成夹具的原始 SDK 形状事件，
// 经 SdkEventNormalizer 归一化后交给宿主回调 —— 用以在无 SDK/无网络下验证宿主流水线。
// 它的结果永远不能计入产品验收（02 §7、19 节）。
import type { RawStreamEvent, SdkNormalizedEvent } from '../../../../packages/contracts/src/sdk-events.ts';
import { SdkEventNormalizer } from './sdk-event-normalizer.ts';
import type { AgentRunner, RunnerRunRequest, RunnerRunResult } from './runner.ts';
import { fixtureScenario, type ScenarioName } from '../../../../packages/test-fixtures/src/sdk-stream.ts';

const TICK_MS = 4;

export class MockRunner implements AgentRunner {
  readonly kind = 'mock' as const;
  interruptSupport = 'claimed' as const;

  async run(req: RunnerRunRequest): Promise<RunnerRunResult> {
    const scenarioName = (process.env.ESTOMAGO_MOCK_SCENARIO as ScenarioName | undefined) ?? 'consistent';
    const script: RawStreamEvent[] = fixtureScenario(scenarioName, req.prompt);
    const normalizer = new SdkEventNormalizer();
    let finalOutcome: RunnerRunResult = { outcome: 'completed', errorClassified: null, errorMessage: null };
    for (const raw of script) {
      if (req.signal.aborted) return { outcome: 'interrupted', errorClassified: null, errorMessage: null };
      for (const ev of normalizer.normalize(raw)) {
        if (ev.kind === 'turn_end' && ev.outcome === 'error') {
          finalOutcome = { outcome: 'error', errorClassified: ev.error_classified, errorMessage: ev.error_message };
        }
        req.onEvent(ev);
      }
      await sleep(TICK_MS);
    }
    return finalOutcome;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
