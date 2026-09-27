// 真实 Claude Agent SDK Runner（TypeScript query 接口；不采用已移除的 V2 会话 API [T18]）。
//
// ⚠ 状态如实声明：本文件按官方公开文档形状编写，尚未在实机对锁定版本核对、
// 也未在 Mac 上真实调用过 —— 在能力矩阵取得证据前，selectRunner 只会返回 blocked
// 或在包缺失时明确报 sdk_package_not_installed。不把"代码存在"冒充"已验证"。
import type { Config } from '../config/schema.ts';
import type { RawStreamEvent } from '../../../../packages/contracts/src/sdk-events.ts';
import { SdkEventNormalizer } from './sdk-event-normalizer.ts';
import type { AgentRunner, RunnerRunRequest, RunnerRunResult, RunnerSelection } from './runner.ts';
import { buildSdkOptions } from './build-options.ts';

export async function tryLoadClaudeSdkRunner(config: Config): Promise<RunnerSelection> {
  const reasons: string[] = [];
  let sdk: unknown;
  try {
    // 动态 import：包未安装时不让宿主崩掉，而是诚实 blocked
    sdk = await import(/* webpackIgnore: true */ '@anthropic-ai/claude-agent-sdk');
  } catch {
    return { status: 'blocked', reasons: ['sdk_package_not_installed：未安装 @anthropic-ai/claude-agent-sdk（按锁定版本实装后再启用）'] };
  }
  if (!config.runtime.sdk_version) reasons.push('runtime.sdk_version 未锁定：先实机核实再启用真实 runner');
  if (!config.runtime.auth_and_billing_verified) reasons.push('认证/计费未确认（不得为跑通悄悄换 key 或账号）');
  if (reasons.length > 0) return { status: 'blocked', reasons };
  return { status: 'ok', runner: new ClaudeSdkRunner(sdk as SdkModule) };
}

// 我们不 import SDK 类型（未安装时无法编译校验），只声明我们实际用到的最小面。
interface SdkModule {
  query: (opts: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>;
}

class ClaudeSdkRunner implements AgentRunner {
  readonly kind = 'claude-agent-sdk' as const;
  interruptSupport = 'unknown' as const; // 待实机证据（fence 兜底由宿主管）

  private sdk: SdkModule;
  constructor(sdk: SdkModule) {
    this.sdk = sdk;
  }

  async run(req: RunnerRunRequest): Promise<RunnerRunResult> {
    const normalizer = new SdkEventNormalizer();
    const o = req.options;
    try {
      const iterable = this.sdk.query({
        model: o.options.model,
        systemPrompt: o.options.systemPrompt,
        settingSources: o.options.settingSources,
        tools: o.options.tools,
        mcpServers: o.options.mcpServers,
        strictMcpConfig: o.options.strictMcpConfig,
        includePartialMessages: o.options.includePartialMessages,
        thinking: o.options.thinking,
        options: { ...o.inlineSettings, env: o.env },
        abortController: req.signal,
        prompt: req.prompt,
        // 能力矩阵取证点：thinking_delta 是否真实出现、完整块映射是否与流块一致
      });
      let lastError: string | null = null;
      for await (const raw of iterable) {
        if (req.signal.aborted) return { outcome: 'interrupted', errorClassified: null, errorMessage: null };
        for (const ev of normalizer.normalize(raw as RawStreamEvent)) req.onEvent(ev);
      }
      if (lastError) return { outcome: 'error', errorClassified: 'unknown', errorMessage: lastError };
      return { outcome: 'completed', errorClassified: null, errorMessage: null };
    } catch (err) {
      if (req.signal.aborted) return { outcome: 'interrupted', errorClassified: null, errorMessage: null };
      const message = (err as Error).message ?? String(err);
      const cls: RunnerRunResult['errorClassified'] = /route_signal|model_switch_requested/i.test(message)
        ? 'route_signal'
        : /network|timeout|fetch/i.test(message)
          ? 'network'
          : /refus|permission/i.test(message)
            ? 'refusal'
            : 'unknown';
      return { outcome: 'error', errorClassified: cls, errorMessage: message };
    }
  }
}

export { buildSdkOptions };
