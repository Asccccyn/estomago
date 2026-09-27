// Runner 接口与选择（AUD-01/03 修复版）。
// - 真实 SDK runner 按 0.3.283 契约把全部参数装入 options；支持 resume（会话连续性）。
// - outcome 语义（AUD-25）：'completed' 仅当观察到 success result；流结束无 result →
//   'no_final_result'；'error' / 'interrupted' 如常。
// - mock 仅在 ESTOMAGO_TEST_MODE=1 下可用，模拟 session 语义，绝不冒充实机。
import type { Config } from '../config/schema.ts';
import type { SdkNormalizedEvent, RawStreamEvent } from '../../../../packages/contracts/src/sdk-events.ts';
import type { AssembledSdkOptions } from './build-options.ts';
import { MockRunner } from './runner-mock.ts';

export type RunnerRunRequest = {
  prompt: string; // 本轮有效输入（含每轮时间上下文块，宿主构造，不伪装成用户发言）
  options: AssembledSdkOptions;
  resumeSessionId: string | null; // 同一 window 的后续轮恢复同一 SDK session（AUD-03）
  abortController: AbortController; // 宿主持有；runner 原样传给 SDK（真实 AbortController）
  onEvent: (ev: SdkNormalizedEvent) => void;
};

export type RunnerRunResult = {
  outcome: 'completed' | 'error' | 'interrupted' | 'no_final_result';
  errorClassified: 'refusal' | 'network' | 'route_signal' | 'unknown' | null;
  errorCode: string | null; // 稳定错误码（日志/存储用；原始 message 不入日志，AUD-28）
  errorMessage: string | null; // 仅入 DB 调试字段，不入日志
  sessionId: string | null; // 本轮观察到的 SDK session id（首轮创建，后续沿用）
  requestId: string | null;
};

export interface AgentRunner {
  readonly kind: 'claude-agent-sdk' | 'mock';
  run(req: RunnerRunRequest): Promise<RunnerRunResult>;
  interruptSupport: 'claimed' | 'unknown';
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

export type { RawStreamEvent };
