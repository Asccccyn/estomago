// 配置 schema：类型 + 默认值 + 严格校验（05 §2.1：必要参数缺失阻止启动；未知参数不忽略）。
// estomago.example.yaml 是应用配置，不是 SDK options；映射在 runtime/build-options.ts。

// §29（AUD-40）：effort 枚举与 @anthropic-ai/claude-agent-sdk@0.3.283 EffortLevel 一致
export const THINKING_EFFORT_ENUM = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingEffort = (typeof THINKING_EFFORT_ENUM)[number];
export type ThinkingConfig = {
  mode: string;
  display: string;
  effort: ThinkingEffort | null;
  require_capability_probe: boolean;
};

export type Config = {
  project: { display_name: string; slug: string; spec_version: string };
  deployment: {
    target_os: string;
    source_root: string | null;
    state_root: string | null;
    log_root: string | null;
    bind: string;
    port: number;
    public_origin: string | null;
    public_enabled: boolean;
    supervisor: string;
  };
  runtime: {
    provider: string;
    language: string;
    node_version: string | null;
    sdk_version: string | null;
    runtime_version: string | null;
    model: string | null;
    authentication_profile_ref: string | null;
    system_prompt_mode: string;
    setting_sources: string[];
    require_identity_manifest: boolean;
    disable_auto_memory: boolean;
    strict_mcp_config: boolean;
    automatic_flag_switch: boolean;
    automatic_availability_fallbacks: string[];
    max_active_primary_runners: number;
    builtin_tools: string[];
    mcp_servers_allowlist: string[];
    skills: string[];
    plugins: string[];
    disable_claude_ai_connectors: boolean;
    include_partial_messages: boolean;
    thinking: ThinkingConfig;
    config_isolation_root: string | null;
    auth_and_billing_verified: boolean;
    capability_state: string;
  };
  identity: {
    approved_identity_ref: string | null;
    approved_identity_hash: string | null;
    i_source: string;
    allow_unverified_fallback: boolean;
    require_bootstrap_receipt: boolean;
    receipt_requires_evidence: boolean;
    unobservable_fields_are_unknown: boolean;
    expected_identity_version: string | null;
    expected_i_version: string | null;
    expected_rules_version: string | null;
  };
  windows: {
    rotate_on_business_date_change: boolean;
    soft_limit_tokens: number | null;
    output_reserve_tokens: number | null;
    handoff_reserve_tokens: number | null;
    max_tool_result_tokens: number | null;
    recent_dialogue_budget_tokens: number | null;
    model_context_capacity: number | null;
    threshold_status: string;
    normal_rotation_uses_new_session: boolean;
  };
  time: {
    business_timezone: string;
    persist_absolute_time_as: string;
    refresh_before_every_turn: boolean;
    use_device_timezone_to_rewrite_history: boolean;
    injection_channel: string;
    depend_on_system_prompt_cache_boundary: boolean;
  };
  routing: {
    require_owner_decision: boolean;
    decision_survives_restart: boolean;
    unsupported_signal_behavior: string;
    continue_capability: string | null;
  };
  archive: {
    enabled: boolean;
    continuous_grant_ref: string | null;
    source_scope: string | null;
    semantic_auto_binding_threshold: number | null;
    semantic_auto_binding_enabled: boolean;
  };
  integrations: {
    mariposa: IntegrationConfig;
    siren: IntegrationConfig;
    superposition: IntegrationConfig;
    zashidele: IntegrationConfig;
  };
  notifications: {
    remote_enabled: boolean;
    provider: string | null;
    credential_ref: string | null;
    aggregate_by_turn: boolean;
    include_sensitive_content: boolean;
    telegram_enabled: boolean;
  };
  signals: { enabled: boolean; consent_ref: string | null; share_with_model: boolean; share_with_groups: boolean };
  safety: {
    default_deny_unregistered_capabilities: boolean;
    allow_unrestricted_shell: boolean;
    production_side_effects_enabled: boolean;
    test_root_must_differ_from_production: boolean;
  };
  input: {
    multiline: boolean;
    enter_behavior: string;
    send_control: string;
    keyboard_send_shortcuts_enabled: boolean;
    ime_composition_guard: boolean;
    normalize_newlines_to: string;
    split_user_message_on_newline: boolean;
  };
  reasoning: {
    requested: boolean;
    label: string;
    label_is_design_proposal: boolean;
    default_expanded: boolean;
    capture_source: string;
    complete_block_action: string;
    store_separately_from_messages: boolean;
    persist_readable_projection: boolean;
    retention_policy: string;
    auto_delete_days: number | null;
    maximum_buffer_bytes: number | null;
    maximum_trace_bytes: number | null;
    limits_status: string;
    signature_to_ui: boolean;
    archive_to_mariposa: boolean;
    include_in_handoff: boolean;
    tts_enabled: boolean;
    push_enabled: boolean;
    auto_rewrite_with_model: boolean;
    stop_transcript_main_capture: boolean;
    capability_state: string;
  };
};

export type IntegrationConfig = { base_url: string | null; credential_ref: string | null; contract_version: string | null };

// —— 默认值：与 config/estomago.example.yaml 语义一致 ——

export const CONFIG_DEFAULTS: Config = {
  project: { display_name: 'estómago', slug: 'estomago', spec_version: '0.2.1' },
  deployment: {
    target_os: 'macos',
    source_root: null,
    state_root: null,
    log_root: null,
    bind: '127.0.0.1',
    port: 18787,
    public_origin: null,
    public_enabled: false,
    supervisor: 'launchagent',
  },
  runtime: {
    provider: 'claude-agent-sdk',
    language: 'typescript',
    node_version: null,
    sdk_version: null,
    runtime_version: null,
    model: null,
    authentication_profile_ref: null,
    system_prompt_mode: 'explicit_custom',
    setting_sources: [],
    require_identity_manifest: true,
    disable_auto_memory: true,
    strict_mcp_config: true,
    automatic_flag_switch: false,
    automatic_availability_fallbacks: [],
    max_active_primary_runners: 1,
    builtin_tools: [],
    mcp_servers_allowlist: [],
    skills: [],
    plugins: [],
    disable_claude_ai_connectors: true,
    include_partial_messages: true,
    thinking: { mode: 'adaptive', display: 'summarized', effort: null, require_capability_probe: true },
    config_isolation_root: null,
    auth_and_billing_verified: false,
    capability_state: 'unknown',
  },
  identity: {
    approved_identity_ref: null,
    approved_identity_hash: null,
    i_source: 'mariposa',
    allow_unverified_fallback: false,
    require_bootstrap_receipt: true,
    receipt_requires_evidence: true,
    unobservable_fields_are_unknown: true,
    expected_identity_version: null,
    expected_i_version: null,
    expected_rules_version: null,
  },
  windows: {
    rotate_on_business_date_change: true,
    soft_limit_tokens: null,
    output_reserve_tokens: null,
    handoff_reserve_tokens: null,
    max_tool_result_tokens: null,
    recent_dialogue_budget_tokens: null,
    model_context_capacity: null,
    threshold_status: 'awaiting_measurement',
    normal_rotation_uses_new_session: true,
  },
  time: {
    business_timezone: 'Asia/Shanghai',
    persist_absolute_time_as: 'UTC',
    refresh_before_every_turn: true,
    use_device_timezone_to_rewrite_history: false,
    injection_channel: 'per_turn_context_or_verified_hook',
    depend_on_system_prompt_cache_boundary: false,
  },
  routing: {
    require_owner_decision: true,
    decision_survives_restart: true,
    unsupported_signal_behavior: 'unknown_no_claim',
    continue_capability: 'unknown',
  },
  archive: {
    enabled: false,
    continuous_grant_ref: null,
    source_scope: null,
    semantic_auto_binding_threshold: null,
    semantic_auto_binding_enabled: false,
  },
  integrations: {
    mariposa: { base_url: null, credential_ref: null, contract_version: null },
    siren: { base_url: null, credential_ref: null, contract_version: null },
    superposition: { base_url: null, credential_ref: null, contract_version: null },
    zashidele: { base_url: null, credential_ref: null, contract_version: null },
  },
  notifications: {
    remote_enabled: false,
    provider: null,
    credential_ref: null,
    aggregate_by_turn: true,
    include_sensitive_content: false,
    telegram_enabled: false,
  },
  signals: { enabled: false, consent_ref: null, share_with_model: false, share_with_groups: false },
  safety: {
    default_deny_unregistered_capabilities: true,
    allow_unrestricted_shell: false,
    production_side_effects_enabled: false,
    test_root_must_differ_from_production: true,
  },
  input: {
    multiline: true,
    enter_behavior: 'newline',
    send_control: 'dedicated_button',
    keyboard_send_shortcuts_enabled: false,
    ime_composition_guard: true,
    normalize_newlines_to: 'LF',
    split_user_message_on_newline: false,
  },
  reasoning: {
    requested: true,
    label: '思考',
    label_is_design_proposal: true,
    default_expanded: false,
    capture_source: 'sdk_partial_events',
    complete_block_action: 'reconcile_not_append',
    store_separately_from_messages: true,
    persist_readable_projection: true,
    retention_policy: 'with_conversation_local_only',
    auto_delete_days: null,
    maximum_buffer_bytes: null,
    maximum_trace_bytes: null,
    limits_status: 'awaiting_measurement',
    signature_to_ui: false,
    archive_to_mariposa: false,
    include_in_handoff: false,
    tts_enabled: false,
    push_enabled: false,
    auto_rewrite_with_model: false,
    stop_transcript_main_capture: false,
    capability_state: 'unknown',
  },
};

// —— 显式类型树（AUD-19 修复）：每个叶子的类型显式声明，不从默认值推导 ——
type Leaf = 'string' | 'string?' | 'number' | 'number?' | 'boolean' | 'string[]' | { section: Record<string, Leaf> };
type SectionSpec = { section: Record<string, Leaf> };

const SHAPE: SectionSpec = { section: {
  project: { section: { display_name: 'string', slug: 'string', spec_version: 'string' } },
  deployment: { section: {
    target_os: 'string?', source_root: 'string?', state_root: 'string?', log_root: 'string?',
    bind: 'string', port: 'number', public_origin: 'string?', public_enabled: 'boolean', supervisor: 'string?',
  } },
  runtime: { section: {
    provider: 'string', language: 'string?', node_version: 'string?', sdk_version: 'string?', runtime_version: 'string?',
    model: 'string?', authentication_profile_ref: 'string?', system_prompt_mode: 'string', setting_sources: 'string[]',
    require_identity_manifest: 'boolean', disable_auto_memory: 'boolean', strict_mcp_config: 'boolean',
    automatic_flag_switch: 'boolean', automatic_availability_fallbacks: 'string[]', max_active_primary_runners: 'number?',
    builtin_tools: 'string[]', mcp_servers_allowlist: 'string[]', skills: 'string[]', plugins: 'string[]',
    disable_claude_ai_connectors: 'boolean', include_partial_messages: 'boolean',
    thinking: { section: { mode: 'string', display: 'string', effort: 'string?', require_capability_probe: 'boolean' } },
    config_isolation_root: 'string?', auth_and_billing_verified: 'boolean', capability_state: 'string?',
  } },
  identity: { section: {
    approved_identity_ref: 'string?', approved_identity_hash: 'string?', i_source: 'string?',
    allow_unverified_fallback: 'boolean', require_bootstrap_receipt: 'boolean',
    receipt_requires_evidence: 'boolean', unobservable_fields_are_unknown: 'boolean',
    expected_identity_version: 'string?', expected_i_version: 'string?', expected_rules_version: 'string?',
  } },
  windows: { section: {
    rotate_on_business_date_change: 'boolean', soft_limit_tokens: 'number?', output_reserve_tokens: 'number?',
    handoff_reserve_tokens: 'number?', max_tool_result_tokens: 'number?', recent_dialogue_budget_tokens: 'number?',
    model_context_capacity: 'number?', threshold_status: 'string?', normal_rotation_uses_new_session: 'boolean',
  } },
  time: { section: {
    business_timezone: 'string', persist_absolute_time_as: 'string?', refresh_before_every_turn: 'boolean',
    use_device_timezone_to_rewrite_history: 'boolean', injection_channel: 'string?', depend_on_system_prompt_cache_boundary: 'boolean',
  } },
  routing: { section: {
    require_owner_decision: 'boolean', decision_survives_restart: 'boolean',
    unsupported_signal_behavior: 'string?', continue_capability: 'string?',
  } },
  archive: { section: {
    enabled: 'boolean', continuous_grant_ref: 'string?', source_scope: 'string?',
    semantic_auto_binding_threshold: 'number?', semantic_auto_binding_enabled: 'boolean',
  } },
  integrations: { section: {
    mariposa: { section: { base_url: 'string?', credential_ref: 'string?', contract_version: 'string?' } },
    siren: { section: { base_url: 'string?', credential_ref: 'string?', contract_version: 'string?' } },
    superposition: { section: { base_url: 'string?', credential_ref: 'string?', contract_version: 'string?' } },
    zashidele: { section: { base_url: 'string?', credential_ref: 'string?', contract_version: 'string?' } },
  } },
  notifications: { section: {
    remote_enabled: 'boolean', provider: 'string?', credential_ref: 'string?', aggregate_by_turn: 'boolean',
    include_sensitive_content: 'boolean', telegram_enabled: 'boolean',
  } },
  signals: { section: { enabled: 'boolean', consent_ref: 'string?', share_with_model: 'boolean', share_with_groups: 'boolean' } },
  safety: { section: {
    default_deny_unregistered_capabilities: 'boolean', allow_unrestricted_shell: 'boolean',
    production_side_effects_enabled: 'boolean', test_root_must_differ_from_production: 'boolean',
  } },
  input: { section: {
    multiline: 'boolean', enter_behavior: 'string', send_control: 'string', keyboard_send_shortcuts_enabled: 'boolean',
    ime_composition_guard: 'boolean', normalize_newlines_to: 'string', split_user_message_on_newline: 'boolean',
  } },
  reasoning: { section: {
    requested: 'boolean', label: 'string', label_is_design_proposal: 'boolean', default_expanded: 'boolean',
    capture_source: 'string?', complete_block_action: 'string?', store_separately_from_messages: 'boolean',
    persist_readable_projection: 'boolean', retention_policy: 'string?', auto_delete_days: 'number?',
    maximum_buffer_bytes: 'number?', maximum_trace_bytes: 'number?', limits_status: 'string?',
    signature_to_ui: 'boolean', archive_to_mariposa: 'boolean', include_in_handoff: 'boolean',
    tts_enabled: 'boolean', push_enabled: 'boolean', auto_rewrite_with_model: 'boolean',
    stop_transcript_main_capture: 'boolean', capability_state: 'string?',
  } },
} };

export type ValidationIssue = { path: string; message: string };

function checkType(v: unknown, t: Leaf, path: string, issues: ValidationIssue[]): void {
  if (typeof t === 'string') {
    const optional = t.endsWith('?');
    const base = optional ? t.slice(0, -1) : t;
    if (optional && (v === null || v === undefined)) return;
    switch (base) {
      case 'string':
        if (typeof v !== 'string') issues.push({ path, message: `需要字符串，得到 ${typeof v}` });
        return;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) issues.push({ path, message: `需要数字，得到 ${String(v)}` });
        return;
      case 'boolean':
        if (typeof v !== 'boolean') issues.push({ path, message: `需要布尔，得到 ${typeof v}` });
        return;
      case 'string[]':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) issues.push({ path, message: '需要字符串数组' });
        return;
      default:
        issues.push({ path, message: `内部错误：未知类型 ${t}` });
    }
    return;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    issues.push({ path, message: '需要对象' });
    return;
  }
  const known = t.section;
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    const childPath = path === '' ? k : `${path}.${k}`;
    if (!(k in known)) issues.push({ path: childPath, message: '未知配置键（不忽略）' });
    else checkType(child, known[k]!, childPath, issues);
  }
}

// 产品硬规则（v0.2.1 固定，配置不得放宽；01 §6.2/§11.1、05 §2.1）
function checkHardRules(c: Config, issues: ValidationIssue[]): void {
  const fixed: Array<[boolean, string]> = [
    [c.input.multiline === true, 'input.multiline 必须为 true（v0.2.1 产品规则）'],
    [c.input.enter_behavior === 'newline', 'input.enter_behavior 必须为 newline：回车只换行'],
    [c.input.send_control === 'dedicated_button', 'input.send_control 必须为 dedicated_button：独立发送键'],
    [c.input.keyboard_send_shortcuts_enabled === false, 'input.keyboard_send_shortcuts_enabled 必须为 false（首版无组合键发送）'],
    [c.input.normalize_newlines_to === 'LF', 'input.normalize_newlines_to 必须为 LF'],
    [c.input.split_user_message_on_newline === false, 'input.split_user_message_on_newline 必须为 false：多行正文是一条消息'],
    [c.runtime.system_prompt_mode === 'explicit_custom', 'runtime.system_prompt_mode 必须为 explicit_custom（不使用 preset 冒充身份）'],
    [Array.isArray(c.runtime.setting_sources) && c.runtime.setting_sources.length === 0, 'runtime.setting_sources 必须为 []（隔离文件来源）'],
    [c.runtime.disable_auto_memory === true, 'runtime.disable_auto_memory 必须为 true（不建旁路记忆）'],
    [c.runtime.disable_claude_ai_connectors === true, 'runtime.disable_claude_ai_connectors 必须为 true'],
    [c.runtime.strict_mcp_config === true, 'runtime.strict_mcp_config 必须为 true'],
    [c.runtime.automatic_flag_switch === false, 'runtime.automatic_flag_switch 必须为 false（路由先决定）'],
    [c.runtime.thinking.mode === 'adaptive' && c.runtime.thinking.display === 'summarized', 'runtime.thinking 必须为 adaptive/summarized（可读摘要）'],
    [c.reasoning.signature_to_ui === false, 'reasoning.signature_to_ui 必须为 false（签名不展示）'],
    [c.reasoning.archive_to_mariposa === false, 'reasoning.archive_to_mariposa 必须为 false（摘要不入正式原文）'],
    [c.reasoning.include_in_handoff === false, 'reasoning.include_in_handoff 必须为 false'],
    [c.reasoning.tts_enabled === false, 'reasoning.tts_enabled 必须为 false'],
    [c.reasoning.push_enabled === false, 'reasoning.push_enabled 必须为 false'],
    [c.reasoning.auto_rewrite_with_model === false, 'reasoning.auto_rewrite_with_model 必须为 false（不代写思考）'],
    [c.reasoning.stop_transcript_main_capture === false, 'reasoning.stop_transcript_main_capture 必须为 false（主采集走 SDK 实时流）'],
    [c.safety.allow_unrestricted_shell === false, 'safety.allow_unrestricted_shell 必须为 false'],
    [c.identity.allow_unverified_fallback === false, 'identity.allow_unverified_fallback 必须为 false（缺身份即阻断）'],
  ];
  for (const [ok, msg] of fixed) if (!ok) issues.push({ path: msg.slice(0, msg.indexOf('必须')), message: msg });
}

export function validateConfig(raw: unknown): { config: Config; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  checkType(raw, SHAPE, '', issues);
  // §29：effort 非法枚举直接拒绝（SDK 不认识的值不得静默通过）
  const effort = (raw as { runtime?: { thinking?: { effort?: unknown } } })?.runtime?.thinking?.effort;
  if (effort !== undefined && effort !== null && !(typeof effort === 'string' && (THINKING_EFFORT_ENUM as readonly string[]).includes(effort))) {
    issues.push({ path: 'runtime.thinking.effort', message: `必须是 ${THINKING_EFFORT_ENUM.join('|')} 或 null（SDK EffortLevel 契约）` });
  }
  if (issues.length > 0) return { config: structuredClone(CONFIG_DEFAULTS), issues };
  const config = deepMergeConfig(raw as Record<string, unknown>);
  checkHardRules(config, issues);
  return { config, issues };
}

function deepMergeConfig(over: Record<string, unknown>): Config {
  const merge = (base: unknown, patch: unknown): unknown => {
    if (patch === null || patch === undefined) return patch === undefined ? base : null;
    if (typeof base === 'object' && base !== null && !Array.isArray(base) && typeof patch === 'object' && !Array.isArray(patch)) {
      const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = merge(out[k], v);
      return out;
    }
    return patch;
  };
  return merge(structuredClone(CONFIG_DEFAULTS), over) as Config;
}

// 测试/程序化构造：在默认值上打补丁
export function buildConfig(patch: Record<string, unknown>): Config {
  const { config, issues } = validateConfig(patch);
  if (issues.length > 0) {
    throw new Error(`配置补丁非法: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
  }
  return config;
}
