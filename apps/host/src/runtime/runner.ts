// Runner 选择（02 §6.8）：沿用 apps/host，不新造第二后端。
// - provider=claude-agent-sdk：真实 SDK 路径（包未安装/版本未锁 → blocked，不冒充可用）
// - provider=mock：只在 ESTOMAGO_TEST_MODE=1 下可用，驱动合成夹具，绝不冒充实机
import type { Config } from '../config/schema.ts';
import type { SdkNormalizedEvent, RawStreamEvent } from '../../../../packages/contracts/src/sdk-events.ts';
import type { AssembledSdkOptions } from './build-options.ts';
import { MockRunner } from './runner-mock.ts';

export type RunnerRunRequest = {
  prompt: string; // 本轮有效输入（含每轮时间上下文块，宿主构造，不伪装成用户发言）
  options: AssembledSdkOptions;
  signal: AbortSignal;
  onEvent: (ev: SdkNormalizedEvent) => void;
};

export type RunnerRunResult = {
  outcome: 'completed' | 'interrupted' | 'error';
  errorClassified: 'refusal' | 'network' | 'route_signal' | 'unknown' | null;
  errorMessage: string | null;
};

export interface AgentRunner {
  readonly kind: 'claude-agent-sdk' | 'mock';
  run(req: RunnerRunRequest): Promise<RunnerRunResult>;
  interruptSupport: 'claimed' | 'unknown'; // fence 由宿主管；这里只声明 runner 自身能力
}

export type RunnerSelection =
  | { status: 'ok'; runner: AgentRunner }
  | { status: 'blocked'; reasons: string[] };

export async function selectRunner(config: Config): Promise<RunnerSelection> {
  if (config.runtime.provider === 'mock') {
    if (process.env.ESTOMAGO_TEST_MODE !== '1') {
      return { status: 'blocked', reasons: ['provider=mock 仅在 ESTOMAGO_TEST_MODE=1 下可用（mock 不冒充实机）'] };
    }
    return { status: 'ok', runner: new MockRunner() };
  }
  if (config.runtime.provider === 'claude-agent-sdk') {
    const { tryLoadClaudeSdkRunner } = await import('./runner-claude-sdk.ts');
    return tryLoadClaudeSdkRunner(config);
  }
  return { status: 'blocked', reasons: [`未知 provider: ${config.runtime.provider}`] };
}

// 供 runner-claude-sdk / mock 复用的原始事件→归一化分发
export { type RawStreamEvent };
