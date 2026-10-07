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

// ESTOMAGO_OR_SELF_HOLD §6.1/§6.2：明确 OR 型号约束（anthropic 上游、禁 auto/latest/别名）。
// 注意这是宿主门，不是把任意 OR 型号都放行的通用校验；当前任务 provider.only 固定 ['anthropic']。
export const RUNTIME_PROVIDER_ENUM = ['claude-agent-sdk', 'openrouter', 'mock', 'deepseek'] as const;
export type RuntimeProvider = (typeof RUNTIME_PROVIDER_ENUM)[number];

export type OrModelId = string; // 形状校验见 orModelIdIssue()；null=未配置（selectRunner 阻断，不猜默认型号）

export type OpenRouterConfig = {
  base_url: string;
  model: string | null;
  api_key_env: string; // 凭据环境变量名（值只在后端 transport 读取，不进日志/DB/前端）
  max_output_tokens: number; // 无既有批准值时的透明初值；设置页可改
  provider_only: string[];
  allow_fallbacks: boolean; // 硬规则 false（§6.2）
  require_parameters: boolean; // 硬规则 true（§6.2）
  cache_ttl: string; // 硬规则 '1h'（§7）
  disable_context_compression: boolean; // 硬规则 true（§6.2 plugins）
  retry_max_attempts_after_initial: number; // §9.2 建议初值 2
  reasoning: Record<string, unknown> | null; // 未批准推理覆盖=null（§10：不照搬 SDK effort）
  estimate_chars_per_token: number; // §11.1 粗估系数（拉丁文本≈2.5；中文场景偏低，靠真实 usage 校准兜底）
};

// DeepSeek 官方直连配置段（2026-10-05 她裁定：DS 官方 key 不经 OpenRouter）。
// 与 openrouter 段完全分离：无 provider/cache/plugin 概念（DS 自动上下文缓存，无参数）；
// 身份映射（session 派生、上下文指纹）按驱动隔离，切换驱动强制换窗（identity/service）。
export type DeepSeekConfig = {
  base_url: string; // 默认 https://api.deepseek.com（https 硬规则）
  model: string | null; // DS 官方型号（如 deepseek-chat / deepseek-reasoner）；null=未配置阻断
  api_key_env: string; // 默认 DEEPSEEK_API_KEY（值只在后端 transport 读取）
  max_output_tokens: number;
  retry_max_attempts_after_initial: number; // §9.2 同款有界重试
  estimate_chars_per_token: number; // 中文场景默认 1.5（DS 主用途为中文对话；粗估+真实 usage 校准）
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
  // ESTOMAGO_OR_SELF_HOLD：OR 专用配置段——与 SDK 的 settingSources/systemPrompt 装配/
  // resume/订阅认证完全分离（§2.1/§6.1）。共用业务授权（身份/主体权限），不共用供应商会话与 KV。
  openrouter: OpenRouterConfig;
  // DS 官方直连段（身份映射隔离：与 OR 各自独立配置/凭据/型号门）
  deepseek: DeepSeekConfig;
  // 她裁定 2026-10-07：换窗 hold 提醒与昨天日结共用一个开关；日结模型
  // 暂定 DS（零新增外发面），千问本地接口预留不安装
  reminders: { enabled: boolean };
  digest: { provider: 'deepseek' | 'qwen-local'; max_messages: number };
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
    // F04：能力探针证据有效期（天）——明确策略声明，过期观测按 stale 阻断；null=不按时间过期
    probe_evidence_max_age_days: number | null;
  };
  windows: {
    rotate_on_business_date_change: boolean; // 现行规范 §4.1：零点不触发换窗（默认 false）
    soft_limit_tokens: number; // 输入工作集软线（§4.1 初值 64000；有效软线=min(此值, C-O-T-R-S)）
    warning_tokens: number; // 前台预警线（初值 56000；不高于软线-8k）
    idle_before_next_user_ms: number; // 距上一条真实用户消息≥6h → 下一条真实交互到达时换窗
    tool_input_reserve_tokens: number; // T（§4.2 初值 8k）
    review_reserve_tokens: number; // R：换窗提醒及必要 hold 往返预留（8k）
    safety_reserve_tokens: number; // S（4k）
    recent_dialogue_budget_tokens: number; // 近期原话目标约 12k（§5.5）
    bootstrap_target_tokens: number; // 新窗启动总目标约 32k（§5.5）
    model_context_capacity: number | null; // C：实际所选模型/端点容量；null=未测量（不假定）
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

export type IntegrationConfig = {
  base_url: string | null;
  credential_ref: string | null; // 主模型能力凭据（memory.hold 等；环境变量名）
  // 审计 F11（LC-050）：归档 worker 用独立的受限 stream 凭据（环境变量名）。
  // null=回退共用 credential_ref（仅限开发/联调；生产必须配置受限 token——联合契约 §8）
  archive_credential_ref: string | null;
  contract_version: string | null;
};

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
  // OR 默认：model=null（未配置即阻断，不默选示例型号）；key 只经环境变量名引用。
  // 控制字段（fallbacks/require_parameters/ttl/压缩）为硬规则固定值，配置不得放宽。
  openrouter: {
    base_url: 'https://openrouter.ai/api/v1',
    model: null,
    api_key_env: 'OPENROUTER_API_KEY',
    max_output_tokens: 8192,
    provider_only: ['anthropic'], // 规范默认（§6.2）；非 anthropic 族可配置，型号门随上游族放宽
    allow_fallbacks: false,
    require_parameters: true,
    cache_ttl: '1h',
    disable_context_compression: true,
    retry_max_attempts_after_initial: 2,
    reasoning: null,
    estimate_chars_per_token: 2.5,
  },
  // DS 官方直连默认：model=null（未配置即阻断）；key 只经环境变量名引用；
  // 无缓存/路由参数（DS 自动上下文缓存）；中文对话为主 → 粗估系数 1.5（§11.1 估计带精度，usage 校准兜底）。
  reminders: { enabled: true },
  digest: { provider: 'deepseek', max_messages: 400 },
  deepseek: {
    base_url: 'https://api.deepseek.com',
    model: null,
    api_key_env: 'DEEPSEEK_API_KEY',
    max_output_tokens: 8192,
    retry_max_attempts_after_initial: 2,
    estimate_chars_per_token: 1.5,
  },
  identity: {
    approved_identity_ref: null,
    approved_identity_hash: null,
    i_source: 'mariposa', // F-J-56 如实：I 正文当前读本地批准 manifest；Mariposa bootstrap（B 点/开窗资料）已接通，I 的远端读取属 D2 后续
    allow_unverified_fallback: false,
    require_bootstrap_receipt: true,
    receipt_requires_evidence: true,
    unobservable_fields_are_unknown: true,
    expected_identity_version: null,
    expected_i_version: null,
    expected_rules_version: null,
    probe_evidence_max_age_days: 30,
  },
  // ESTOMAGO_OR_SELF_HOLD §4.1/§6.1 工程初值（config/implementation-target.json）：
  // 56k 预警 / 64k 软线 / 6h 静默 / 12k 近期原话 / 32k 启动目标 / T8k R8k S4k。
  // 这些是配置初值，不是上游极限或最优成本结论；C=null 必须由实际端点能力补齐。
  windows: {
    rotate_on_business_date_change: false,
    soft_limit_tokens: 64000,
    warning_tokens: 56000,
    idle_before_next_user_ms: 21600000,
    tool_input_reserve_tokens: 8000,
    review_reserve_tokens: 8000,
    safety_reserve_tokens: 4000,
    recent_dialogue_budget_tokens: 12000,
    bootstrap_target_tokens: 32000,
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
    mariposa: { base_url: null, credential_ref: null, archive_credential_ref: null, contract_version: null },
    siren: { base_url: null, credential_ref: null, archive_credential_ref: null, contract_version: null },
    superposition: { base_url: null, credential_ref: null, archive_credential_ref: null, contract_version: null },
    zashidele: { base_url: null, credential_ref: null, archive_credential_ref: null, contract_version: null },
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
// 'json?' = 可选任意 JSON 值（openrouter.reasoning：未批准覆盖=null；不假装理解其内部结构）
type Leaf = 'string' | 'string?' | 'number' | 'number?' | 'boolean' | 'string[]' | 'json?' | { section: Record<string, Leaf> };
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
  openrouter: { section: {
    base_url: 'string', model: 'string?', api_key_env: 'string', max_output_tokens: 'number',
    provider_only: 'string[]', allow_fallbacks: 'boolean', require_parameters: 'boolean',
    cache_ttl: 'string', disable_context_compression: 'boolean',
    retry_max_attempts_after_initial: 'number',
    reasoning: 'json?',
    estimate_chars_per_token: 'number',
  } },
  reminders: { section: { enabled: 'boolean' } },
  digest: { section: { provider: 'string', max_messages: 'number' } },
  deepseek: { section: {
    base_url: 'string', model: 'string?', api_key_env: 'string', max_output_tokens: 'number',
    retry_max_attempts_after_initial: 'number', estimate_chars_per_token: 'number',
  } },
  identity: { section: {
    approved_identity_ref: 'string?', approved_identity_hash: 'string?', i_source: 'string?',
    allow_unverified_fallback: 'boolean', require_bootstrap_receipt: 'boolean',
    receipt_requires_evidence: 'boolean', unobservable_fields_are_unknown: 'boolean',
    expected_identity_version: 'string?', expected_i_version: 'string?', expected_rules_version: 'string?',
    probe_evidence_max_age_days: 'number?',
  } },
  windows: { section: {
    rotate_on_business_date_change: 'boolean', soft_limit_tokens: 'number', warning_tokens: 'number',
    idle_before_next_user_ms: 'number', tool_input_reserve_tokens: 'number', review_reserve_tokens: 'number',
    safety_reserve_tokens: 'number', recent_dialogue_budget_tokens: 'number', bootstrap_target_tokens: 'number',
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
    mariposa: { section: { base_url: 'string?', credential_ref: 'string?', archive_credential_ref: 'string?', contract_version: 'string?' } },
    siren: { section: { base_url: 'string?', credential_ref: 'string?', archive_credential_ref: 'string?', contract_version: 'string?' } },
    superposition: { section: { base_url: 'string?', credential_ref: 'string?', archive_credential_ref: 'string?', contract_version: 'string?' } },
    zashidele: { section: { base_url: 'string?', credential_ref: 'string?', archive_credential_ref: 'string?', contract_version: 'string?' } },
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
      case 'json':
        if (typeof v !== 'object' || Array.isArray(v)) issues.push({ path, message: '需要 JSON 对象或 null' });
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

// OR 型号门（§6.1）：必须是明确的 vendor/model ID；禁止 auto/latest/fallback 数组形态。
// 只做形状门——型号真实可用性由 OR 元数据/能力快照另验（§6.2），此处不冒充。
export function orModelIdIssue(model: string): string | null {
  if (/\bauto\b|\blatest\b/i.test(model)) return '禁止 auto/latest 别名（必须是明确 OR model ID）';
  if (model.includes(',') || /^\[.*\]$/.test(model.trim())) return '禁止 fallback 型号数组';
  if (!/^[a-z0-9][a-z0-9._\-]*\/[a-z0-9][a-z0-9._\-]*$/i.test(model)) return '必须是 vendor/model 形式的明确型号 ID';
  return null;
}

// DS 官方型号门（直连驱动）：DS 型号是单段名（deepseek-chat / deepseek-reasoner），非 vendor/model；
// 禁 auto/latest/数组。只做形状门——真实可用性由端点实测（冒烟）另验，不冒充。
export function dsModelIdIssue(model: string): string | null {
  if (/\bauto\b|\blatest\b/i.test(model)) return '禁止 auto/latest 别名（必须是明确 DS 官方型号）';
  if (model.includes(',') || /^\[.*\]$/.test(model.trim())) return '禁止 fallback 型号数组';
  if (!/^[a-z0-9][a-z0-9._\-]*$/i.test(model)) return '必须是 DS 官方单段型号名（如 deepseek-chat）';
  return null;
}

// 产品硬规则（v0.2.1 固定，配置不得放宽；01 §6.2/§11.1、05 §2.1 + ESTOMAGO_OR_SELF_HOLD §6/§7）
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
    // ESTOMAGO_OR_SELF_HOLD §6.2/§7：OR 控制字段硬规则（缓存 1h、禁 fallback、禁隐藏压缩）
    [c.openrouter.cache_ttl === '1h', 'openrouter.cache_ttl 必须为 1h（一小时显式缓存是产品合同，不降 5m）'],
    [c.openrouter.allow_fallbacks === false, 'openrouter.allow_fallbacks 必须为 false'],
    [c.openrouter.require_parameters === true, 'openrouter.require_parameters 必须为 true'],
    [c.openrouter.disable_context_compression === true, 'openrouter.disable_context_compression 必须为 true（供应商压缩显式关闭）'],
    [Array.isArray(c.openrouter.provider_only) && c.openrouter.provider_only.length > 0, 'openrouter.provider_only 必须非空（限定上游集合）'],
    [c.openrouter.base_url.startsWith('https://'), 'openrouter.base_url 必须 https（不降级明文）'],
    [c.openrouter.api_key_env.length > 0, 'openrouter.api_key_env 必须指定（凭据只经环境变量名引用）'],
    // DS 直连段硬规则（§6.1 同款纪律：https、凭据只经环境变量名、有界重试、粗估系数合理区间）
    [c.deepseek.base_url.startsWith('https://'), 'deepseek.base_url 必须 https（不降级明文）'],
    [c.deepseek.api_key_env.length > 0, 'deepseek.api_key_env 必须指定（凭据只经环境变量名引用）'],
    [Number.isSafeInteger(c.deepseek.retry_max_attempts_after_initial) && c.deepseek.retry_max_attempts_after_initial >= 0, 'deepseek.retry_max_attempts_after_initial 必须是非负整数'],
    [c.deepseek.estimate_chars_per_token > 0 && c.deepseek.estimate_chars_per_token <= 10, 'deepseek.estimate_chars_per_token 必须在 (0,10]（§11.1 粗估系数带精度）'],
    [c.openrouter.estimate_chars_per_token > 0 && c.openrouter.estimate_chars_per_token <= 10, 'openrouter.estimate_chars_per_token 必须在 (0,10]（§11.1 粗估系数带精度）'],
    [c.windows.rotate_on_business_date_change === false, 'windows.rotate_on_business_date_change 必须为 false（现行规范：零点不触发换窗）'],
  ];
  for (const [ok, msg] of fixed) if (!ok) issues.push({ path: msg.slice(0, msg.indexOf('必须')), message: msg });
  // §6.1：型号已配置时必须是明确 ID（未配置不在此报错——selectRunner 会以 *_MODEL_NOT_CONFIGURED 阻断并显示）
  if (c.openrouter.model !== null) {
    const m = orModelIdIssue(c.openrouter.model);
    if (m) issues.push({ path: 'openrouter.model', message: m });
  }
  if (c.deepseek.model !== null) {
    const m = dsModelIdIssue(c.deepseek.model);
    if (m) issues.push({ path: 'deepseek.model', message: m });
  }
}

export function validateConfig(raw: unknown): { config: Config; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  checkType(raw, SHAPE, '', issues);
  // §29：effort 非法枚举直接拒绝（SDK 不认识的值不得静默通过）
  const effort = (raw as { runtime?: { thinking?: { effort?: unknown } } })?.runtime?.thinking?.effort;
  if (effort !== undefined && effort !== null && !(typeof effort === 'string' && (THINKING_EFFORT_ENUM as readonly string[]).includes(effort))) {
    issues.push({ path: 'runtime.thinking.effort', message: `必须是 ${THINKING_EFFORT_ENUM.join('|')} 或 null（SDK EffortLevel 契约）` });
  }
  // ESTOMAGO_OR_SELF_HOLD §1.1：provider 枚举（新增 openrouter 驱动；未知值不得静默落到 SDK）
  const provider = (raw as { runtime?: { provider?: unknown } })?.runtime?.provider;
  if (provider !== undefined && !(typeof provider === 'string' && (RUNTIME_PROVIDER_ENUM as readonly string[]).includes(provider))) {
    issues.push({ path: 'runtime.provider', message: `必须是 ${RUNTIME_PROVIDER_ENUM.join('|')}（新增驱动走显式枚举，不猜默认）` });
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
