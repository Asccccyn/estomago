// SDK 装配（05 §2）：应用 YAML 意图 → SDK options / inline settings / 受控 env 三层。
// 这不是把 YAML 原样发给 SDK；必要参数缺失 → blocked（返回原因，不 partial 装配）。
// 装配产物是 estómago 自己的选项契约；与锁定 SDK 版本类型的核对在实装后进行。
import type { Config } from '../config/schema.ts';
import { sha256Hex } from '../util/id.ts';
import type { GateResult } from '../identity/service.ts';

export type AssembledSdkOptions = {
  options: {
    model: string;
    systemPrompt: string; // 经批准身份 + 关系说明 + 运行/工具规则（显式自定义；不启用 preset）
    settingSources: []; // 显式空：user/project/local 全关（01 §6.2）
    tools: []; // 内置工具清空；业务能力走 mcpServers（6.4）
    mcpServers: Record<string, unknown>; // 由获准 allowlist 映射；v0 无已批准项 → {}
    strictMcpConfig: true;
    includePartialMessages: true; // 思考/正文增量的前提（11.5）
    abortController: { external: true }; // 宿主持有中断权（5.3）
    thinking: { type: 'adaptive'; display: 'summarized' };
  };
  inlineSettings: {
    autoMemoryEnabled: false; // 不建旁路长期记忆
    disableClaudeAiConnectors: true; // 未选连接器不自动接
    switchModelsOnFlag: false; // 路由先决定（10.1）
  };
  env: Record<string, string>; // 白名单传递：PATH/HOME 等必要项；绝不整环境复制
};

export type BuildOptionsResult =
  | { status: 'ok'; assembled: AssembledSdkOptions }
  | { status: 'blocked'; reasons: string[] };

export function buildSdkOptions(opts: {
  config: Config;
  gate: GateResult;
  identityText: string | null;
}): BuildOptionsResult {
  const reasons: string[] = [];
  if (opts.gate.state !== 'READY') reasons.push(...opts.gate.reasons.map((r) => `identity: ${r}`));
  if (!opts.config.runtime.model) reasons.push('runtime.model 未配置');
  if (!opts.identityText) reasons.push('无经批准身份正文（不提供默认人格）');
  if (opts.config.runtime.mcp_servers_allowlist.length > 0) {
    reasons.push('mcp_servers_allowlist 非空但映射器未实装：获准 MCP 需逐项映射后装配（不假装已注册）');
  }
  if (reasons.length > 0) return { status: 'blocked', reasons };

  // systemPrompt 组成：批准身份 + 必要运行规则（关系说明随身份材料；此处不加任何人格）
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
  // 认证相关环境变量不自动继承：现场核实后经 authentication_profile_ref 白名单加入

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
        abortController: { external: true },
        thinking: { type: 'adaptive', display: 'summarized' },
      },
      inlineSettings: {
        autoMemoryEnabled: false,
        disableClaudeAiConnectors: true,
        switchModelsOnFlag: false,
      },
      env,
    },
  };
}

export function optionsHash(a: AssembledSdkOptions): string {
  return sha256Hex(JSON.stringify(a));
}
