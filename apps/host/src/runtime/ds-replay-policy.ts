// R2（2026-10-23，E08/DS 新型号协议适配，她批方向 A 先离线）：
// DeepSeek 官方当前 tools 合同要求带 tools 的后续请求回传此前所有轮次的 reasoning_content
// （含未调用工具的最终 assistant）；仓内旧 D01 合同恰好相反（跨用户轮剥除，deepseek-chat 时代）。
// 解法：每窗冻结窄政策字段（windows.reasoning_replay_policy，schema 36）——仅官方直连且
// 精确匹配新型号的新窗启用 ds_tools_all_turns_v1；旧窗/旧型号/兼容代理一律 legacy_turn_only。
// 历史批准记录未独立核验（见 glm-root-cause-20261023/FIELD_CONSUMER_RULINGS.md）；
// 本轮施工依据=她 2026-10-23 的 DS 政策裁定（D3）+ 独立前缀复核
// （evidence/ds/independent-prefix-review.md）。

export type ReasoningReplayPolicy = 'legacy_turn_only' | 'ds_tools_all_turns_v1';

/** 当前适用 ds_tools_all_turns_v1 的官方直连精确型号闭集；未知别名/代理不推断支持。 */
export const DS_TOOLS_ALL_TURNS_MODELS: ReadonlySet<string> = new Set(['deepseek-flash', 'deepseek-v4-pro']);

const OFFICIAL_DS_HOST = 'api.deepseek.com';

export function resolveReasoningReplayPolicy(cfg: {
  provider: string;
  deepseek: { base_url: string; model: string | null };
}): ReasoningReplayPolicy {
  if (cfg.provider !== 'deepseek') return 'legacy_turn_only';
  const model = cfg.deepseek.model;
  if (!model || !DS_TOOLS_ALL_TURNS_MODELS.has(model)) return 'legacy_turn_only';
  let host: string;
  try {
    host = new URL(cfg.deepseek.base_url).host;
  } catch {
    return 'legacy_turn_only';
  }
  // 官方直连才适用新合同；自定义兼容代理行为未知，保守 legacy
  if (host !== OFFICIAL_DS_HOST) return 'legacy_turn_only';
  return 'ds_tools_all_turns_v1';
}

/** 读窗口冻结政策；缺列/缺行/旧窗 NULL 一律 legacy（不因当前配置重标旧窗）。 */
export function storedReasoningReplayPolicy(row: { reasoning_replay_policy?: string | null } | undefined): ReasoningReplayPolicy {
  return row?.reasoning_replay_policy === 'ds_tools_all_turns_v1' ? 'ds_tools_all_turns_v1' : 'legacy_turn_only';
}
