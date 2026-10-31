// SDK 装配（AUD-01 修复版）—— 严格对齐 @anthropic-ai/claude-agent-sdk@0.3.283 的
// Options 契约（sdk.d.ts）：query({prompt, options}) 之外只有 prompt；全部参数在 options 内。
// abortController 是真正的 AbortController（由 runner 持有并映射）；cwd 必传；
// inline settings 走 options.settings（真实键名）；env 走 options.env 白名单。
import type { Config } from '../config/schema.ts';
import { sha256Hex } from '../util/id.ts';
import type { GateResult } from '../identity/service.ts';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { HOST_BOUNDARY_RULES, FIXED_RUNTIME_FRAGMENT } from '../context/fixed-runtime.ts';
import { fileURLToPath } from 'node:url';

export const THINKING_LANGUAGE_RULE = '语言要求：思考摘要请使用简体中文；工具标识、代码和原文引用保持原样。思考摘要只进入独立的思考通道，不要在正式回复中复述。';

// 我们自己的装配契约：字段与 0.3.283 Options 一一对应（可对照 sdk.d.ts 的 export declare type Options）
export type AssembledSdkOptions = {
  options: {
    model: string;
    systemPrompt: string | string[];
    settingSources: [];
    tools: [];
    skills: [];
    plugins: Array<{ type: 'local'; path: string }>;
    permissionMode: 'default';
    mcpServers: Record<string, never>;
    strictMcpConfig: true;
    includePartialMessages: true;
    thinking: { type: 'adaptive'; display: 'summarized' };
    effort?: import('../config/schema.ts').ThinkingEffort; // F07：SDK 契约是 options.effort 顶层
    cwd: string; // SDK 子进程工作目录（隔离 workspaces，绝不指向源码仓库）
    settings: {
      autoMemoryEnabled: false;
      disableClaudeAiConnectors: true;
      switchModelsOnFlag: false;
      includeGitInstructions: false;
      attribution: { commit: ''; pr: '' };
      fallbackModel: [];
      promptCacheTtl: '1h';
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
  approvedRulesText: string | null; // F04：manifest 引用并经 hash 校验的运行规则正文（不再是硬编码替身）
  cwd: string;
}): BuildOptionsResult {
  const reasons: string[] = [];
  if (opts.gate.state !== 'READY') reasons.push(...opts.gate.reasons.map((r) => `identity: ${r}`));
  if (!opts.config.runtime.model) reasons.push('runtime.model 未配置');
  if (!opts.identityText) reasons.push('无经批准身份正文（不提供默认人格）');
  if (!opts.approvedRulesText) reasons.push('无经批准运行规则正文（校验过的 rules 材料必须实际进入 systemPrompt）');
  if (opts.config.runtime.mcp_servers_allowlist.length > 0) {
    reasons.push('mcp_servers_allowlist 非空但映射器未实装：获准 MCP 需逐项映射后装配');
  }
  if (reasons.length > 0) return { status: 'blocked', reasons };

  return { status: 'ok', assembled: subscriptionSdkOptions(opts.config,
    `${opts.identityText}\n\n${opts.approvedRulesText}\n\n${FIXED_RUNTIME_FRAGMENT}\n\n${HOST_BOUNDARY_RULES}`, opts.cwd) };
}

export function subscriptionSdkOptions(config: Config, systemPrompt: string | string[], cwd: string): AssembledSdkOptions {
  // Options.env replaces the child environment in 0.3.283. The official
  // setup-token credential takes precedence over local login; API/OR keys,
  // cloud-provider switches and routing overrides stay out.
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const v = process.env[key];
    if (typeof v === 'string' && v.length > 0) env[key] = v;
  }
  Object.assign(env, {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_CRON: '1',
    CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    DISABLE_COMPACT: '1', DISABLE_AUTO_COMPACT: '1',
    ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '1',
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
  });
  // Custom systemPrompt replaces the coding preset. Keep the SDK's generated
  // attribution prefix: stripping it from OAuth requests can produce a generic
  // 429. Ambient model/environment/date attachments are filtered by our plugin.
  if (config.runtime.subscription_proxy_url) {
    env.HTTPS_PROXY = config.runtime.subscription_proxy_url;
    env.HTTP_PROXY = config.runtime.subscription_proxy_url;
    env.NO_PROXY = '';
  }

  return {
      options: {
        model: config.runtime.model!,
        systemPrompt: [...(typeof systemPrompt === 'string' ? [systemPrompt] : systemPrompt), THINKING_LANGUAGE_RULE],
        settingSources: [],
        tools: [],
        skills: [],
        plugins: [{ type: 'local', path: fileURLToPath(new URL('./sdk-prompt-context/', import.meta.url)) }],
        permissionMode: 'default',
        mcpServers: {},
        strictMcpConfig: true,
        includePartialMessages: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        cwd,
        settings: {
          autoMemoryEnabled: false,
          disableClaudeAiConnectors: true,
          switchModelsOnFlag: false,
          includeGitInstructions: false,
          attribution: { commit: '', pr: '' },
          fallbackModel: [],
          promptCacheTtl: '1h',
        },
        ...(config.runtime.thinking.effort ? { effort: config.runtime.thinking.effort } : {}),
        env,
      } satisfies AssembledSdkOptions['options'] & Options,
  };
}

export function optionsHash(a: AssembledSdkOptions): string {
  return sha256Hex(JSON.stringify(a));
}
