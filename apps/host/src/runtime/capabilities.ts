// SDK 适配能力矩阵（02 §5）：每项 unknown/supported/unsupported/blocked + evidence_ref。
// 官网说明只是支持线索，不是实机 PASS；unknown 不在 doctor/UI 冒充 available。
import type { Config } from '../config/schema.ts';

export type CapabilityState = 'unknown' | 'supported' | 'unsupported' | 'blocked';

export type CapabilityRecord = {
  state: CapabilityState;
  evidence_ref: string | null; // reports/ 下的验收证据文件或 null
  note?: string;
};

export type CapabilityKey =
  | 'system_prompt_explicit'
  | 'settings_sources_isolated'
  | 'global_inputs_audited'
  | 'effective_identity_verified'
  | 'session_resume_semantics'
  | 'interrupt_supported'
  | 'request_usage_observed'
  | 'precompact_observed'
  | 'postcompact_observed'
  | 'route_signal_observed'
  | 'automatic_flag_switch_disabled'
  | 'route_continue_supported'
  | 'model_change_before_after_observed'
  | 'model_capacity_known'
  | 'summarized_thinking_requested'
  | 'thinking_delta_observed'
  | 'complete_block_mapping_verified'
  | 'signature_not_exposed'
  | 'tool_registry_exact'
  | 'auto_memory_disabled'
  | 'auto_connectors_disabled'
  | 'reasoning_replay_verified';

const ALL_KEYS: CapabilityKey[] = [
  'system_prompt_explicit',
  'settings_sources_isolated',
  'global_inputs_audited',
  'effective_identity_verified',
  'session_resume_semantics',
  'interrupt_supported',
  'request_usage_observed',
  'precompact_observed',
  'postcompact_observed',
  'route_signal_observed',
  'automatic_flag_switch_disabled',
  'route_continue_supported',
  'model_change_before_after_observed',
  'model_capacity_known',
  'summarized_thinking_requested',
  'thinking_delta_observed',
  'complete_block_mapping_verified',
  'signature_not_exposed',
  'tool_registry_exact',
  'auto_memory_disabled',
  'auto_connectors_disabled',
  'reasoning_replay_verified',
];

export class CapabilityMatrix {
  private records = new Map<CapabilityKey, CapabilityRecord>();

  constructor(config: Config) {
    for (const k of ALL_KEYS) this.records.set(k, { state: 'unknown', evidence_ref: null });
    // 配置意图可以预先记录为"requested"，但运行证据仍为 unknown
    if (config.reasoning.requested) {
      this.setNote('summarized_thinking_requested', '配置请求 summarized thinking；实机返回摘要能力未探测');
    }
  }

  get(key: CapabilityKey): CapabilityRecord {
    return this.records.get(key) ?? { state: 'unknown', evidence_ref: null };
  }

  set(key: CapabilityKey, state: CapabilityState, evidenceRef: string | null, note?: string): void {
    this.records.set(key, { state, evidence_ref: evidenceRef, note });
  }

  private setNote(key: CapabilityKey, note: string): void {
    const cur = this.get(key);
    this.records.set(key, { ...cur, note });
  }

  overall(): 'verified' | 'unknown' | 'blocked' {
    // 关键 P0 能力任一 unknown → unknown；出现 blocked → blocked
    const critical: CapabilityKey[] = [
      'system_prompt_explicit',
      'settings_sources_isolated',
      'interrupt_supported',
      'thinking_delta_observed',
      'complete_block_mapping_verified',
    ];
    const states = critical.map(k => this.get(k).state);
    if (states.includes('blocked')) return 'blocked';
    return states.every(s => s === 'supported') ? 'verified' : 'unknown';
  }

  describe(): Record<string, CapabilityRecord> {
    const out: Record<string, CapabilityRecord> = {};
    for (const k of ALL_KEYS) out[k] = this.get(k);
    return out;
  }
}
