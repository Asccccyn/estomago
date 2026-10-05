// ESTOMAGO_OR_SELF_HOLD §6.2/§7：OR 请求 payload 构造与前缀稳定断言。
// 移植自 docs/specs/ESTOMAGO_OR_SELF_HOLD/reference/or-payload.mjs（按本仓 TS 规范）。
//  - 关键控制字段（provider/缓存/压缩插件）由本函数固定，调用方传入的同名字段不生效。
//  - 显式缓存断点最多 3 个（A/B/G），顶层 cache_control 另占自动尾点（§7.2 合计 ≤4）。
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

export function buildOrPayload(input: BuildOrPayloadInput): Record<string, unknown> {
  const { model, sessionId, messages, tools = [], boundaries = [], maxTokens = 8192, reasoning = null } = input;
  const providerOnly = input.providerOnly ?? ['anthropic'];
  const allowFallbacks = input.allowFallbacks ?? false;
  const requireParameters = input.requireParameters ?? true;
  // 当前任务 provider.only 固定 anthropic 上游（§6.2 控制片段）；型号必须是明确的 Claude 型号，
  // 禁 auto/latest/别名。这是发送前最后一道门；配置层形状门在 config/schema.ts orModelIdIssue。
  requireThat(
    typeof model === 'string' && /^anthropic\/claude-[a-zA-Z0-9.-]+$/.test(model) && !/latest|auto/.test(model),
    'EXACT_CLAUDE_MODEL_REQUIRED',
  );
  requireThat(typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 256, 'SESSION_ID_INVALID');
  requireThat(Number.isSafeInteger(maxTokens) && maxTokens > 0, 'MAX_TOKENS_INVALID');
  requireThat(Array.isArray(messages) && messages.length > 0, 'MESSAGES_REQUIRED');
  const base = withoutCacheMarkers({ messages, tools } as Record<string, unknown>);
  const baseMessages = base.messages as OrMessage[];
  const seen = new Set<string>();
  for (const b of boundaries) {
    requireThat(
      Number.isInteger(b.messageIndex) && b.messageIndex >= 0 && Number.isInteger(b.contentIndex) && b.contentIndex >= 0,
      'BOUNDARY_INVALID',
    );
    const key = `${b.messageIndex}:${b.contentIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requireThat(seen.size <= 3, 'TOO_MANY_EXPLICIT_BREAKPOINTS');
    const content = baseMessages[b.messageIndex]?.content;
    requireThat(Array.isArray(content), 'BOUNDARY_CONTENT_NOT_BLOCKS');
    const block = content[b.contentIndex] as OrBlock | undefined;
    requireThat(block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0, 'BOUNDARY_NOT_TEXT');
    (block as Record<string, unknown>).cache_control = oneHour();
  }
  // 关键控制字段固定在展开 base 之后——调用方/配置不能覆盖（§6.2：不隐藏 fallback/压缩/降级）。
  const out: Record<string, unknown> = {
    model,
    session_id: sessionId,
    stream: true,
    max_tokens: maxTokens,
    provider: { only: providerOnly, allow_fallbacks: allowFallbacks, require_parameters: requireParameters },
    cache_control: oneHour(),
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
  for (const key of ['model', 'session_id', 'provider', 'tools', 'reasoning'] as const) {
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
