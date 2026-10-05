// ESTOMAGO_OR_SELF_HOLD §9.3：OR 用量归一 + 契约错误。
// 移植自 docs/specs/ESTOMAGO_OR_SELF_HOLD/reference/policy.mjs（按本仓 TS 规范）。
// 纯函数：无网络、无凭据、无生产状态。缺失字段永远是 null/anomaly，不补零隐藏问题。
export class ContractError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ContractError';
    this.code = code;
  }
}

export function requireThat(ok: boolean, code: string): void {
  if (!ok) throw new ContractError(code);
}

// OR 最终 usage 帧（记账帧）。字段全部可选：缺失=未知，不是 0。
export type OrUsageFrame = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | Record<string, unknown>;
  completion_tokens_details?: { reasoning_tokens?: number } | Record<string, unknown>;
};

export type NormalizedOrUsage = {
  // OR 口径：inputTotal=prompt_tokens（总输入，含缓存分类）；cacheRead/cacheWrite 是其内部分类，
  // 不得再与 inputTotal 相加（§9.3）。noncached 仅在 total/read/write 全已知且相容时推导。
  inputTotal: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  noncached: number | null;
  output: number | null;
  reasoning: number | null;
  cost: number | null; // OR 已报告总额；不与 upstream_inference_cost 重复相加
  completeness: 'complete' | 'partial' | 'unknown' | 'anomaly';
  anomalies: string[];
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function normalizeOrUsage(usage: OrUsageFrame | null | undefined): NormalizedOrUsage {
  if (!usage) {
    return { inputTotal: null, cacheRead: null, cacheWrite: null, noncached: null, output: null, reasoning: null, cost: null, completeness: 'unknown', anomalies: [] };
  }
  const total = num(usage.prompt_tokens);
  const details = (usage.prompt_tokens_details ?? {}) as { cached_tokens?: unknown; cache_write_tokens?: unknown };
  const outDetails = (usage.completion_tokens_details ?? {}) as { reasoning_tokens?: unknown };
  const read = num(details.cached_tokens);
  const write = num(details.cache_write_tokens);
  const output = num(usage.completion_tokens);
  const reasoning = num(outDetails.reasoning_tokens);
  const cost = num(usage.cost);
  const anomalies: string[] = [];
  let noncached: number | null = null;
  if (total !== null && read !== null && write !== null) {
    if (read + write > total) anomalies.push('CACHE_CATEGORIES_EXCEED_PROMPT');
    else noncached = total - read - write;
  }
  if (output !== null && reasoning !== null && reasoning > output) anomalies.push('REASONING_EXCEEDS_OUTPUT');
  const completeness: NormalizedOrUsage['completeness'] = anomalies.length > 0
    ? 'anomaly'
    : [total, read, write, output, cost].every((x) => x !== null)
      ? 'complete'
      : 'partial';
  return { inputTotal: total, cacheRead: read, cacheWrite: write, noncached, output, reasoning, cost, completeness, anomalies };
}

// §9.3 映射到宿主 RawUsage 列（SDK 事件口径的存储形状）。input_tokens 携带 OR 总输入语义，
// 由 usage 观测行的 source='or_stream' 区分口径；不得对同一请求再按 SDK 分类重复累计。
export function toRawUsageColumns(u: NormalizedOrUsage): { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } {
  return {
    ...(u.inputTotal !== null ? { input_tokens: u.inputTotal } : {}),
    ...(u.output !== null ? { output_tokens: u.output } : {}),
    ...(u.cacheRead !== null ? { cache_read_input_tokens: u.cacheRead } : {}),
    ...(u.cacheWrite !== null ? { cache_creation_input_tokens: u.cacheWrite } : {}),
  };
}
