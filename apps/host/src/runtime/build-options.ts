// SDK 装配（AUD-01 修复版）—— 严格对齐 @anthropic-ai/claude-agent-sdk@0.3.283 的
// Options 契约（sdk.d.ts）：query({prompt, options}) 之外只有 prompt；全部参数在 options 内。
// abortController 是真正的 AbortController（由 runner 持有并映射）；cwd 必传；
// inline settings 走 options.settings（真实键名）；env 走 options.env 白名单。
import type { Config } from '../config/schema.ts';
import { sha256Hex } from '../util/id.ts';
import type { GateResult } from '../identity/service.ts';

// 我们自己的装配契约：字段与 0.3.283 Options 一一对应（可对照 sdk.d.ts 的 export declare type Options）
export type AssembledSdkOptions = {
  options: {
    model: string;
    systemPrompt: string;
    settingSources: [];
    tools: [];
    mcpServers: Record<string, never>;
    strictMcpConfig: true;
    includePartialMessages: true;
    thinking: { type: 'adaptive'; display: 'summarized' };
    cwd: string; // SDK 子进程工作目录（隔离 workspaces，绝不指向源码仓库）
    settings: {
      autoMemoryEnabled: false;
      disableClaudeAiConnectors: true;
      switchModelsOnFlag: false;
    };
    env: Record<string, string>; // 白名单；绝不整环境复制
  };
};

export type BuildOptionsResult =
  | { status: 'ok'; assembled: AssembledSdkOptions }
  | { status: 'blocked'; reasons: string[] };

export function buildSdkOptions(opts: {
  config: Config;
  gate: GateResult;
  identityText: string | null;
  cwd: string;
}): BuildOptionsResult {
  const reasons: string[] = [];
  if (opts.gate.state !== 'READY') reasons.push(...opts.gate.reasons.map((r) => `identity: ${r}`));
  if (!opts.config.runtime.model) reasons.push('runtime.model 未配置');
  if (!opts.identityText) reasons.push('无经批准身份正文（不提供默认人格）');
  if (opts.config.runtime.mcp_servers_allowlist.length > 0) {
    reasons.push('mcp_servers_allowlist 非空但映射器未实装：获准 MCP 需逐项映射后装配');
  }
  if (reasons.length > 0) return { status: 'blocked', reasons };

  const runtimeRules = [
    '运行规则（宿主注入）：',
    '- 当前时间由每轮时间上下文提供，不要自行猜测日期时间。',
    '- 思考摘要是独立展示通道；不是你说过的正式发言。',
    '- 需要外部动作时使用已注册的业务工具；不要假设拥有 shell/文件等工程能力。',
  ].join('\n');

  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR']) {
    const v = process.env[key];
    if (typeof v === 'string' && v.length > 0) env[key] = v;
  }

  return {
    status: 'ok',
    assembled: {
      options: {
        model: opts.config.runtime.model!,
        systemPrompt: `${opts.identityText}\n\n${runtimeRules}`,
        settingSources: [],
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        includePartialMessages: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        cwd: opts.cwd,
        settings: {
          autoMemoryEnabled: false,
          disableClaudeAiConnectors: true,
          switchModelsOnFlag: false,
        },
        env,
      },
    },
  };
}

export function optionsHash(a: AssembledSdkOptions): string {
  return sha256Hex(JSON.stringify(a));
}
