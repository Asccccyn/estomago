// 真实 Claude Agent SDK Runner（AUD-01/03 修复版）。
// 契约依据：node_modules/@anthropic-ai/claude-agent-sdk@0.3.283/sdk.d.ts
//  - query({ prompt, options })：除 prompt 外全部在 options 内
//  - options.abortController?: AbortController（真控制器，非 signal）
//  - options.cwd / resume / settings / settingSources / tools / mcpServers /
//    strictMcpConfig / includePartialMessages / thinking({type:'adaptive',display}) / env
//  - 流消息：{type:'stream_event'|'assistant'|'result', ...}，session_id 在每条消息上
// 状态如实：尚未以真实凭据运行；真实 acceptance 见 BLOCKED 记录，不因代码存在冒充已验证。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema.ts';
import type { RawStreamEvent } from '../../../../packages/contracts/src/sdk-events.ts';
import { SdkEventNormalizer } from './sdk-event-normalizer.ts';
import type { AgentRunner, RunnerRunRequest, RunnerRunResult, RunnerSelection } from './runner.ts';

const require_ = createRequire(import.meta.url);

export function installedSdkVersion(): string | null {
  try {
    const entry = require_.resolve('@anthropic-ai/claude-agent-sdk') as string;
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return null;
  }
}

export async function tryLoadClaudeSdkRunner(config: Config): Promise<RunnerSelection> {
  const reasons: string[] = [];
  const installed = installedSdkVersion();
  if (installed === null) {
    return { status: 'blocked', reasons: ['sdk_package_not_installed：未安装 @anthropic-ai/claude-agent-sdk'] };
  }
  if (!config.runtime.sdk_version) reasons.push('runtime.sdk_version 未锁定');
  else if (config.runtime.sdk_version !== installed) {
    reasons.push(`sdk_version 不匹配：配置 ${config.runtime.sdk_version} / 实装 ${installed}`);
  }
  if (!config.runtime.auth_and_billing_verified) reasons.push('认证/计费未确认（不得为跑通悄悄换 key 或账号）');
  if (reasons.length > 0) return { status: 'blocked', reasons };
  let sdk: { query: (p: unknown) => AsyncIterable<unknown> };
  try {
    sdk = (await import('@anthropic-ai/claude-agent-sdk')) as { query: (p: unknown) => AsyncIterable<unknown> };
  } catch {
    return { status: 'blocked', reasons: ['sdk_import_failed: MODULE_NOT_FOUND'] };
  }
  return { status: 'ok', runner: new ClaudeSdkRunner(sdk.query.bind(sdk)) };
}

interface RealOptionsShape {
  // 与 0.3.283 Options 字段一一对应（我们只填这些）
  model: string;
  systemPrompt: string;
  settingSources: [];
  tools: [];
  mcpServers: Record<string, never>;
  strictMcpConfig: true;
  includePartialMessages: true;
  thinking: { type: 'adaptive'; display: 'summarized' };
  effort?: string; // F07：SDK 顶层
  cwd: string;
  settings: Record<string, unknown>;
  env: Record<string, string>;
  abortController: AbortController;
  resume?: string;
}

export class ClaudeSdkRunner implements AgentRunner {
  readonly kind = 'claude-agent-sdk' as const;
  interruptSupport = 'claimed' as const; // 0.3.283 Options.abortController 官方支持

  query: (p: { prompt: string; options: RealOptionsShape }) => AsyncIterable<unknown>;
  constructor(query: (p: { prompt: string; options: RealOptionsShape }) => AsyncIterable<unknown>) {
    this.query = query;
  }

  async run(req: RunnerRunRequest): Promise<RunnerRunResult> {
    if (req.driver === 'openrouter' || req.driver === 'deepseek') {
      // 类型层防护：信封驱动请求（OR/DS）永不路由到 SDK runner（§6.3：驱动判别，不共用会话/KV）
      return { outcome: 'error', errorClassified: 'unknown', errorCode: 'SDK_UNSUPPORTED_ENVELOPE_DRIVER', errorMessage: `SDK runner 收到 ${req.driver} 请求`, sessionId: null, requestId: null };
    }
    const normalizer = new SdkEventNormalizer();
    const o = req.options!.options; // driver 守卫后必为 SDK 形状（options 必有）
    const options: RealOptionsShape = {
      model: o.model,
      systemPrompt: o.systemPrompt,
      settingSources: o.settingSources,
      tools: o.tools,
      mcpServers: o.mcpServers,
      strictMcpConfig: o.strictMcpConfig,
      includePartialMessages: o.includePartialMessages,
      thinking: o.thinking,
      ...(o.effort ? { effort: o.effort } : {}),
      cwd: o.cwd,
      settings: o.settings,
      env: o.env,
      abortController: req.abortController, // 真控制器原样传入（AUD-01）
      ...(req.resumeSessionId ? { resume: req.resumeSessionId } : {}), // 会话连续性（AUD-03）
    };
    try {
      const iterable = this.query({ prompt: req.prompt!, options }); // driver 守卫后必为 SDK 形状
      for await (const raw of iterable) {
        if (req.abortController.signal.aborted) {
          return final(normalizer, 'interrupted');
        }
        for (const ev of normalizer.normalize(raw as RawStreamEvent)) req.onEvent(ev);
      }
      // AUD-25：无 success result 的正常迭代结束不得报 completed
      if (normalizer.observedSuccess) return final(normalizer, 'completed');
      if (normalizer.lastErrorInfo) return final(normalizer, 'error', normalizer.lastErrorInfo);
      return final(normalizer, 'no_final_result');
    } catch (err) {
      if (req.abortController.signal.aborted) return final(normalizer, 'interrupted');
      const message = String((err as Error)?.message ?? err);
      const cls: RunnerRunResult['errorClassified'] = /route_signal|model_switch_requested/i.test(message)
        ? 'route_signal'
        : /network|timeout|fetch|ECONN/i.test(message)
          ? 'network'
          : /refus|permission/i.test(message)
            ? 'refusal'
            : 'unknown';
      return final(normalizer, 'error', { classified: cls, message });
    }
  }
}

function final(n: SdkEventNormalizer, outcome: RunnerRunResult['outcome'], err?: { classified: NonNullable<RunnerRunResult['errorClassified']>; message: string }): RunnerRunResult {
  return {
    outcome,
    errorClassified: err?.classified ?? null,
    errorCode: err ? stableCode(err.classified, err.message) : null,
    errorMessage: err?.message ?? null, // 只入 DB 调试字段；日志走 errorCode（AUD-28）
    sessionId: n.sessionId,
    requestId: null,
  };
}

function stableCode(cls: string, message: string): string {
  if (cls === 'route_signal') return 'SDK_ROUTE_SIGNAL';
  if (cls === 'network') return 'SDK_STREAM_ERROR';
  if (cls === 'refusal') return 'SDK_REFUSAL';
  if (/auth|401|403|api key/i.test(message)) return 'SDK_AUTH_ERROR';
  return 'SDK_ERROR';
}
