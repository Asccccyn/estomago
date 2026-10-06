// Runner 接口与选择（AUD-01/03 修复版 + ESTOMAGO_OR_SELF_HOLD §6.3 provider 判别联合）。
// - SDK 分支：按 0.3.283 契约把全部参数装入 options；支持 resume（会话连续性）。
// - OR 分支：不可变 messages/tools/profile + streaming transport（envelope）；不把 messages
//   压成 SDK 的一条 prompt，也不让 OR 样式 usage 伪装成 SDK usage（§6.3）。
// - outcome 语义（AUD-25）：'completed' 仅当观察到 success result；流结束无 result →
//   'no_final_result'；'error' / 'interrupted' 如常。
// - mock 仅在 ESTOMAGO_TEST_MODE=1 下可用，模拟 session 语义，绝不冒充实机。
import type { Config } from '../config/schema.ts';
import type { SdkNormalizedEvent, RawStreamEvent } from '../../../../packages/contracts/src/sdk-events.ts';
import type { AssembledSdkOptions } from './build-options.ts';
import type { OrBoundary, OrMessage, OrTool } from './or-payload.ts';
import { MockRunner } from './runner-mock.ts';

export type RunnerPurpose = 'chat' | 'pre_rotate_review' | 'proactive_turn' | 'cache_keepalive'; // §12：keepalive 默认禁用

// —— SDK 形状请求（driver 缺省 = SDK/mock 既有路径，调用方无需改动）——
export type SdkRunRequest = {
  driver?: 'claude-agent-sdk' | 'mock';
  prompt: string; // 本轮有效输入（含每轮时间上下文块，宿主构造，不伪装成用户发言）
  options: AssembledSdkOptions;
  resumeSessionId: string | null; // 同一 window 的后续轮恢复同一 SDK session（AUD-03）
  abortController: AbortController; // 宿主持有；runner 原样传给 SDK（真实 AbortController）
  onEvent: (ev: SdkNormalizedEvent) => void;
};

// —— OR 形状请求（ESTOMAGO_OR_SELF_HOLD §6.3；DS 直连驱动复用同一信封形状）——
export type OrRequestEnvelope = {
  model: string; // 已批准的明确型号（OR=OR model ID；DS=DS 官方型号；buildPayload 再过最后一道门）
  sessionId: string; // 房间×型号×profile 的持久匿名标识（orSessionId/dsSessionId 派生，≤256 字符；DS 仅内部关联不发送）
  messages: OrMessage[];
  tools: OrTool[];
  boundaries: OrBoundary[]; // 显式缓存断点 A/B/G（Anthropic 式缓存专用；DS 自动缓存忽略）
  maxTokens: number;
  reasoning: Record<string, unknown> | null;
};
export type OrRunRequest = {
  driver: 'openrouter' | 'deepseek';
  purpose: RunnerPurpose;
  envelope: OrRequestEnvelope;
  previousPayload: Record<string, unknown> | null; // 同窗上一请求 payload（append-only 断言；轨迹正本由调用方提供）
  abortController: AbortController;
  onEvent: (ev: SdkNormalizedEvent) => void;
};

export type RunnerRunRequest = SdkRunRequest | OrRunRequest;

export type RunnerRunResult = {
  outcome: 'completed' | 'error' | 'interrupted' | 'no_final_result';
  errorClassified: 'refusal' | 'network' | 'route_signal' | 'unknown' | null;
  errorCode: string | null; // 稳定错误码（日志/存储用；原始 message 不入日志，AUD-28）
  errorMessage: string | null; // 仅入 DB 调试字段，不入日志
  sessionId: string | null; // 本轮观察到的 SDK session id（首轮创建，后续沿用）；OR 无宿主可见 session → null
  requestId: string | null; // OR：generation id；SDK：null
  attempts?: number; // §9.2：真实发出的模型请求次数（含重试）；1=未重试
  reasoningFrames?: unknown[]; // OR §10：opaque reasoning 片段（按接收顺序；协议继续态保真用，非 UI 思考）
};

export interface AgentRunner {
  readonly kind: 'claude-agent-sdk' | 'mock' | 'openrouter' | 'deepseek';
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
  if (config.runtime.provider === 'openrouter') {
    // §2.1：OR 模式不加载 SDK、不读订阅凭据、不做 SDK 握手；反向亦然
    const { openRouterSelection } = await import('./runner-openrouter.ts');
    return openRouterSelection(config);
  }
  if (config.runtime.provider === 'deepseek') {
    // DS 官方直连（2026-10-05 她裁定）：与 OR/SDK 均互不前置——不读 OPENROUTER_API_KEY/SDK 订阅
    const { deepSeekSelection } = await import('./runner-deepseek.ts');
    return deepSeekSelection(config);
  }
  return { status: 'blocked', reasons: [`未知 provider: ${config.runtime.provider}`] };
}

export type { RawStreamEvent };
