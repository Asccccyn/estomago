// ESTOMAGO_OR_SELF_HOLD §6.2/§7：OR 请求 payload 构造与前缀稳定断言。
// 移植自 docs/specs/ESTOMAGO_OR_SELF_HOLD/reference/or-payload.mjs（按本仓 TS 规范）。
//  - 关键控制字段（provider/缓存/压缩插件）由本函数固定，调用方传入的同名字段不生效。
//  - A/B/G 最多 3 个，另留一个尾点（§7.2 合计 ≤4）；Bedrock 在发送副本上显式落尾点。
//  - 只保证本适配器边界的 append-only；不声称审计了 OR 内部转换（§7.1）。
import { requireThat } from './or-contract.ts';

export type OrCacheControl = { type: 'ephemeral'; ttl: '1h' };
const oneHour = (): OrCacheControl => ({ type: 'ephemeral', ttl: '1h' });

export type OrBlock = { type: string; text?: string } & Record<string, unknown>;
export type OrMessage = { role: string; content: string | OrBlock[] } & Record<string, unknown>;
export type OrTool = Record<string, unknown>;
export type OrBoundary = { messageIndex: number; contentIndex: number };

export type BuildOrPayloadInput = {
  model: string;
  sessionId: string;
  messages: OrMessage[];
  tools?: OrTool[];
  boundaries?: OrBoundary[];
  maxTokens?: number;
  reasoning?: Record<string, unknown> | null;
  providerOnly?: string[];
  allowFallbacks?: boolean;
  requireParameters?: boolean;
};

// 只移除受支持位置的控制标记；不动 schema 属性与用户 JSON（§7.2 发送副本统一重规划）。
export function withoutCacheMarkers(payload: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(payload) as Record<string, unknown>;
  delete out.cache_control;
  for (const tool of (out.tools as OrTool[] | undefined) ?? []) delete tool.cache_control;
  for (const m of (out.messages as OrMessage[] | undefined) ?? []) {
    delete m.cache_control;
    if (Array.isArray(m.content)) for (const block of m.content) delete (block as Record<string, unknown>).cache_control;
  }
  return out;
}

// Bedrock 的真实 usage 曾只推进到 G，顶层自动尾点未覆盖当前输入/工具结果。
// 把预留的第四点显式落到尾部；工具/assistant 消息根层标记遵循 OpenRouter 官方
// ai-sdk-provider 的 convert-to-openrouter-chat-messages，不改变工具结果的 string 表示。
function markExplicitTail(messages: OrMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const hasContent = (typeof message.content === 'string' || Array.isArray(message.content)) && message.content.length > 0;
    if (hasContent && (message.role === 'tool' || (message.role === 'assistant' && typeof message.content === 'string'))) {
      message.cache_control = oneHour();
      return;
    }
    if (!Array.isArray(message.content)) continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j]!;
      const isText = block.type === 'text' && typeof block.text === 'string' && block.text.length > 0;
      const isUserMedia = message.role === 'user' && ['image', 'image_url', 'document'].includes(block.type);
      if (isText || isUserMedia) {
        block.cache_control = oneHour();
        return;
      }
    }
  }
}

export function buildOrPayload(input: BuildOrPayloadInput): Record<string, unknown> {
  const { model, sessionId, messages, tools = [], boundaries = [], maxTokens = 8192, reasoning = null } = input;
  const providerOnly = input.providerOnly ?? ['anthropic'];
  const allowFallbacks = input.allowFallbacks ?? false;
  const requireParameters = input.requireParameters ?? true;
  // 模型族由 model 命名空间决定；Bedrock/Vertex 也提供 Claude，不能用供应商名称
  // 判断是否发送 Claude 缓存参数。Anthropic 直供仍保留只接受明确 Claude 型号的校验。
  const isAnthropicFamily = typeof model === 'string' && model.startsWith('anthropic/');
  const explicitTail = isAnthropicFamily && providerOnly.some((provider) => provider === 'amazon-bedrock' || provider.startsWith('amazon-bedrock/'));
  const requiresClaudeModel = isAnthropicFamily || providerOnly.includes('anthropic');
  requireThat(
    requiresClaudeModel
      ? typeof model === 'string' && /^anthropic\/claude-[a-zA-Z0-9.-]+$/.test(model) && !/latest|auto/.test(model)
      : typeof model === 'string' && /^[a-z0-9][a-z0-9._\-]*\/[a-z0-9][a-z0-9._\-]*$/i.test(model) && !/latest|auto/.test(model),
    requiresClaudeModel ? 'EXACT_CLAUDE_MODEL_REQUIRED' : 'EXACT_MODEL_REQUIRED',
  );
  requireThat(typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 256, 'SESSION_ID_INVALID');
  requireThat(Number.isSafeInteger(maxTokens) && maxTokens > 0, 'MAX_TOKENS_INVALID');
  requireThat(Array.isArray(messages) && messages.length > 0, 'MESSAGES_REQUIRED');
  const base = withoutCacheMarkers({ messages, tools } as Record<string, unknown>);
  const baseMessages = base.messages as OrMessage[];
  if (explicitTail) {
    // user 的缓存字段放在文本块上；每次统一规范化全部 string user，避免尾点前移时
    // 历史消息在 string/blocks 间来回变化，触发 append-only 拒发或破坏缓存前缀。
    for (const message of baseMessages) {
      if (message.role === 'user' && typeof message.content === 'string' && message.content.length > 0) {
        message.content = [{ type: 'text', text: message.content }];
      }
    }
  }
  const seen = new Set<string>();
  for (const b of boundaries) {
    requireThat(
      Number.isInteger(b.messageIndex) && b.messageIndex >= 0 && Number.isInteger(b.contentIndex) && b.contentIndex >= 0,
      'BOUNDARY_INVALID',
    );
    const key = `${b.messageIndex}:${b.contentIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 审计 P1-1（2026-10-05）：块级 cache_control 是 Anthropic 式参数，只对 anthropic 族注入——
    // 非 anthropic 族（含经 OR 的 DS 等自动缓存上游）多余块参数可能被端点拒绝，此前此处无条件注入与
    // 顶层族判断不一致（断点仍规划、合法性仍校验，仅不落标记）。
    if (!isAnthropicFamily) continue;
    requireThat(seen.size <= 3, 'TOO_MANY_EXPLICIT_BREAKPOINTS');
    const content = baseMessages[b.messageIndex]?.content;
    requireThat(Array.isArray(content), 'BOUNDARY_CONTENT_NOT_BLOCKS');
    const block = content[b.contentIndex] as OrBlock | undefined;
    requireThat(block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0, 'BOUNDARY_NOT_TEXT');
    (block as Record<string, unknown>).cache_control = oneHour();
  }
  if (explicitTail) markExplicitTail(baseMessages); // 同一块赋值自然去重，A/B/G + 尾点最多 4 个。
  // 关键控制字段固定在展开 base 之后——调用方/配置不能覆盖（§6.2：不隐藏 fallback/压缩/降级）。
  // cache_control(ephemeral 1h) 仅 Claude 注入；Bedrock 尾点已显式落下，其他供应商使用顶层自动点。
  // 非 anthropic 族自动缓存上游（DS 等经 OR 的型号）一律省略——多余参数可能被端点拒绝。
  const out: Record<string, unknown> = {
    model,
    session_id: sessionId,
    stream: true,
    max_tokens: maxTokens,
    provider: { only: providerOnly, allow_fallbacks: allowFallbacks, require_parameters: requireParameters },
    ...(isAnthropicFamily && !explicitTail ? { cache_control: oneHour() } : {}),
    plugins: [{ id: 'context-compression', enabled: false }],
    ...base,
  };
  if (reasoning !== null) out.reasoning = structuredClone(reasoning); // 能力门仍在调用方（§10：不照搬 SDK effort）
  return out;
}

// 仅在本适配器边界断言（§7.1）：同窗内 profile 段不变、历史只追加不改写。
export function assertAppendOnly(previous: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const p = withoutCacheMarkers(previous);
  const c = withoutCacheMarkers(current);
  // RRA-017（2026-10-09 复审）：reasoning 退出稳定前缀比较键——
  // effort 是逐请求生成参数（她裁定 2026-10-08：换思考深度不换窗、
  // reasoning 已退出 contextFingerprint），把每次请求可合法变化的
  // 参数钉进 append-only 比较会把合法换档请求整轮拒发（0 派发）
  for (const key of ['model', 'session_id', 'provider', 'tools'] as const) {
    requireThat(JSON.stringify(p[key] ?? null) === JSON.stringify(c[key] ?? null), `PREFIX_PROFILE_CHANGED:${key}`);
  }
  const pm = p.messages as OrMessage[];
  const cm = c.messages as OrMessage[];
  requireThat(cm.length >= pm.length, 'HISTORY_SHORTENED');
  for (let i = 0; i < pm.length; i++) {
    requireThat(JSON.stringify(pm[i]) === JSON.stringify(cm[i]), `HISTORY_CHANGED:${i}`);
  }
  return true;
}
