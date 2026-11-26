// 包4 §6.2（03_PROJECTION_MIGRATION，2026-11-16 版）：模型可见的宿主生成
// 说话人标签统一取现身份配置的双方真实姓名（宿主用户/char）。映射域只限
// 双方内部枚举值（E 侧 owner/assistant，M 侧 qiaosheng/jiaming）；协议 role、
// 原话正文、第三方署名与未核实身份不在映射域，原值逐字保留。
export type SpeakerLabels = { owner: string; assistant: string };

/** 兜底默认（与 config 默认一致）；运行时以身份配置为准。 */
export const DEFAULT_SPEAKER_LABELS: SpeakerLabels = { owner: '宿主用户', assistant: 'char' };

/** 从宿主身份配置取姓名（sol 段缺席时用默认，不静默改成别的称呼）。 */
export function speakerLabelsFromConfig(
  cfg: { memory_surfacing?: { sol?: { user_display_name?: string; assistant_display_name?: string } } } | null | undefined,
): SpeakerLabels {
  return {
    owner: cfg?.memory_surfacing?.sol?.user_display_name || DEFAULT_SPEAKER_LABELS.owner,
    assistant: cfg?.memory_surfacing?.sol?.assistant_display_name || DEFAULT_SPEAKER_LABELS.assistant,
  };
}

/** 双方内部枚举 → 真实姓名；其余值（第三方/未知/空）原样返回。 */
export function speakerLabelFor(value: unknown, labels: SpeakerLabels): unknown {
  if (typeof value !== 'string') return value;
  if (value === 'owner' || value === 'qiaosheng') return labels.owner;
  if (value === 'assistant' || value === 'jiaming') return labels.assistant;
  return value;
}
