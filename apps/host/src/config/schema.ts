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
  model_options: string[]; // 2026-10-08：聊天窗换模型下拉的可选项（空=自由输入；档位正本=OR reasoning.effort）
  vision_supported_models: string[]; // 2026-10-18：人工确认支持图片输入的型号（声明=已核实，媒体门直接放行、零目录查询）；
  // 未声明的型号仍走运行时目录核实（§6.1 未核实=阻断不猜——10-17 生产曾因目录查询在发消息关键路径上
  // 失败（进程内证据又随重启清零）连续阻断发图，静态声明是人工确认的权威来源，优先于网络发现）
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
  // 她裁定 2026-10-07：换窗 hold 提醒开关。
  // MANUAL_HANDOFF_JUDGE_SWITCH_V1（2026-10-08 WP5）：DS 昨天日结整链退役——
  // digest 配置段与 recent_dialogue_budget_tokens 已删除；旧配置出现这些键
  // 由 RETIRED_CONFIG_KEYS 结构化披露（不再接受、也不再静默忽略）
  reminders: { enabled: boolean };
  /** WP5（D02）：旧配置退役键的只读披露（读取处负责告警，不进运行时） */
  retiredKeys: string[];
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
    soft_limit_tokens: number; // 输入工作集软线（§4.1 初值 64000；有效软线=min(此值, C-O-T-R-S)）
    // 换窗策略分层（她 2026-10-19 裁定）：soft_limit=自动换窗的最高上限兜底；
    // 手动换窗随时可换、任意用量（/rotate 无大小门槛）；ui_reference_tokens=
    // 前台容量圈的视觉参考线——非硬规定，超出仅标红提示不阻断。
    ui_reference_tokens: number;
    tool_input_reserve_tokens: number; // T（§4.2 初值 8k）
    review_reserve_tokens: number; // R：换窗提醒及必要 hold 往返预留（8k）
    safety_reserve_tokens: number; // S（4k）
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
  // ESTOMAGO_CHAT_EXEC_V1（policy-defaults.json 是默认值唯一机器正本）：
  // 这里只接入 adjustable=true 的运行面键；adjustable=false 的策略常量在
  // config/policy-constants.ts，不盲目展开成可改配置。旧配置升级后
  // autonomous/keepwarm 默认关闭（enabled=false 是交付状态，不是缺陷）。
  background: {
    autonomous: {
      enabled: boolean; // 三开关之一：自主活动（模型生成类后台）
      max_model_requests_per_run: number;
      max_output_tokens_per_run: number;
      max_tool_calls_per_run: number;
      max_run_ms: number;
      paid_tools_enabled: boolean; // 只限外部收费工具；开启仍需 cap+价格+凭据核验（422 门在运行面）
      daily_cost_cap_usd: number | null; // null=未配置→该用途后台付费禁止；不是无限
    };
    keepwarm: {
      enabled: boolean; // 三开关之一：缓存保温（与自主独立）
      max_output_tokens_per_run: number;
      max_run_ms: number;
      daily_cost_cap_usd: number | null; // 与自主日预算独立
    };
    reminders: {
      enabled: boolean; // 三开关之一：普通定时投递（不生成内容，不控制系统红点）
      delivery_grace_ms: number; // 超过只显示错过，不批量补推
      default_local_time: string; // 仅前端时间选择初值；任务 API 必须带完整 scheduled_at
    };
  };
  content: {
    enabled: boolean; // 代码完整交付后本地联调可开；服务未运行时如实显示状态
    port: number; // 同机工程初值；bind_host 固定 loopback（policy-constants）
  };
  wishstar: {
    enabled: boolean; // 许愿星（superposition）接入：开窗临近纪念日提醒 + char工具面
    base_url: string; // 同机 loopback
    readonly_token_env: string; // 只读服务凭据（仅 /special-dates/upcoming）
    jiaming_token_env: string; // char身份凭据（HTTP Bearer，服务端按 token 反推 actor）
    upcoming_days: number; // 临近提醒窗口天数（含当天；她裁定：快到了才提醒）
  };
  system_alerts: {
    usage_settlement_grace_ms: number; // 已结束且应有 usage 的请求宽限
    summary_refresh_debounce_ms: number; // SSE 触发的合并刷新
  };
  token_estimates: {
    debounce_ms: number; // 输入预览本地纯计算节流
    max_body_bytes: number; // JSON 草稿+资产 ID 上限；无图像 base64/旧历史全文
  };
  memory_surfacing: {
    enabled: boolean; // EST_MARIPOSA_AUTO_SURFACING_V1：默认关闭（零作业/零网络/零凭据读取）
    surfacing_credential_ref: string | null; // 专用受限 service binding（环境变量名；不回退聊天/归档凭据）
    delivery_deadline_ms: number; // 本轮复核+check 总预算（工程初值 2000；docs/01 §4）
    max_added_tokens_per_turn: number; // 本轮自动新增上限（estimated）
    max_retained_tokens_per_window: number; // 同窗自动保留上限
    max_packet_bytes: number; // 注入块字节上限
    worker_concurrency: number; // 全局 worker 并发上限（每房间恒串行）
  };
  media: {
    max_image_bytes: number; // 存储上限≠供应商请求上限
    max_audio_bytes: number;
    max_video_bytes: number;
    max_code_artifact_bytes: number; // SVG/HTML 文本，仅保存与隔离查看
    max_attachments_per_message: number;
    import_timeout_ms: number;
    max_redirects: number; // 每跳重校验目的地；禁私网/本地元数据地址
    auto_physical_gc_enabled: boolean; // 首版保守保留
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
    model_options: [],
    vision_supported_models: [],
  },
  // DS 官方直连默认：model=null（未配置即阻断）；key 只经环境变量名引用；
  // 无缓存/路由参数（DS 自动上下文缓存）；中文对话为主 → 粗估系数 1.5（§11.1 估计带精度，usage 校准兜底）。
  reminders: { enabled: true },
  retiredKeys: [],
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
  // ESTOMAGO_OR_SELF_HOLD §4.1/§6.1 工程初值：64k 软线 / T8k R8k S4k。
  // WP5（2026-10-08）：56k 预警与 12k 近期原话已退役（spec §4.1 修订）；
  // WP-03（2026-10-09，JFA-005）：6h 静默（idle_before_next_user_ms）、零点
  // 换窗（rotate_on_business_date_change）、bootstrap_target_tokens 三键
  // 一并退役——唯一自动换窗基线=64k 软线，新窗历史只经人工选集。
  // 这些是配置初值，不是上游极限或最优成本结论；C=null 必须由实际端点能力补齐。
  windows: {
    soft_limit_tokens: 64000,
    ui_reference_tokens: 128000, // 前台容量圈参考线（她 2026-10-19：128k 起，可调；超出标红不阻断）
    tool_input_reserve_tokens: 8000,
    review_reserve_tokens: 8000,
    safety_reserve_tokens: 4000,
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
  // ESTOMAGO_CHAT_EXEC_V1 policy-defaults：新增段默认值（adjustable 面）。
  // autonomous/keepwarm enabled=false 是首版交付状态；费用上限 null=未配置。
  background: {
    autonomous: {
      enabled: false,
      max_model_requests_per_run: 4,
      max_output_tokens_per_run: 4096,
      max_tool_calls_per_run: 8,
      max_run_ms: 120000,
      paid_tools_enabled: false,
      daily_cost_cap_usd: null,
    },
    keepwarm: { enabled: false, max_output_tokens_per_run: 128, max_run_ms: 30000, daily_cost_cap_usd: null },
    reminders: { enabled: true, delivery_grace_ms: 300000, default_local_time: '09:00' },
  },
  content: { enabled: false, port: 18788 },
  wishstar: {
    enabled: false,
    base_url: 'http://127.0.0.1:8321',
    readonly_token_env: 'WISHSTAR_READONLY_TOKEN',
    jiaming_token_env: 'WISHSTAR_JIAMING_TOKEN',
    upcoming_days: 3,
  },
  system_alerts: { usage_settlement_grace_ms: 60000, summary_refresh_debounce_ms: 1000 },
  token_estimates: { debounce_ms: 250, max_body_bytes: 524288 },
  memory_surfacing: {
    enabled: false,
    surfacing_credential_ref: null,
    delivery_deadline_ms: 2000,
    max_added_tokens_per_turn: 4096,
    max_retained_tokens_per_window: 8192,
    max_packet_bytes: 24576,
    worker_concurrency: 2,
  },
  media: {
    max_image_bytes: 20971520,
    max_audio_bytes: 33554432,
    max_video_bytes: 67108864,
    max_code_artifact_bytes: 262144,
    max_attachments_per_message: 8,
    import_timeout_ms: 30000,
    max_redirects: 3,
    auto_physical_gc_enabled: false,
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
    model_options: 'string[]',
    vision_supported_models: 'string[]',
  } },
  reminders: { section: { enabled: 'boolean' } },
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
    soft_limit_tokens: 'number',
    ui_reference_tokens: 'number',
    tool_input_reserve_tokens: 'number', review_reserve_tokens: 'number',
    safety_reserve_tokens: 'number',
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
  background: { section: {
    autonomous: { section: {
      enabled: 'boolean', max_model_requests_per_run: 'number', max_output_tokens_per_run: 'number',
      max_tool_calls_per_run: 'number', max_run_ms: 'number', paid_tools_enabled: 'boolean',
      daily_cost_cap_usd: 'number?',
    } },
    keepwarm: { section: {
      enabled: 'boolean', max_output_tokens_per_run: 'number', max_run_ms: 'number',
      daily_cost_cap_usd: 'number?',
    } },
    reminders: { section: {
      enabled: 'boolean', delivery_grace_ms: 'number', default_local_time: 'string',
    } },
  } },
  content: { section: { enabled: 'boolean', port: 'number' } },
  wishstar: { section: {
    enabled: 'boolean', base_url: 'string',
    readonly_token_env: 'string', jiaming_token_env: 'string',
    upcoming_days: 'number',
  } },
  system_alerts: { section: { usage_settlement_grace_ms: 'number', summary_refresh_debounce_ms: 'number' } },
  token_estimates: { section: { debounce_ms: 'number', max_body_bytes: 'number' } },
  memory_surfacing: { section: {
    enabled: 'boolean', surfacing_credential_ref: 'string?',
    delivery_deadline_ms: 'number', max_added_tokens_per_turn: 'number',
    max_retained_tokens_per_window: 'number', max_packet_bytes: 'number',
    worker_concurrency: 'number',
  } },
  media: { section: {
    max_image_bytes: 'number', max_audio_bytes: 'number', max_video_bytes: 'number',
    max_code_artifact_bytes: 'number', max_attachments_per_message: 'number',
    import_timeout_ms: 'number', max_redirects: 'number', auto_physical_gc_enabled: 'boolean',
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
    // WP-04（JFA-C09）：mariposa base_url 纪律——loopback 允许 http（本机
    // 联调），非 loopback 强制 https（对齐 OR/DS 门，凭据不落明文链路）
    [(() => { const u = c.integrations.mariposa.base_url; return u == null || u === '' || u.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/.test(u); })(), 'integrations.mariposa.base_url 必须 https（loopback 除外）'],
    [c.openrouter.api_key_env.length > 0, 'openrouter.api_key_env 必须指定（凭据只经环境变量名引用）'],
    // DS 直连段硬规则（§6.1 同款纪律：https、凭据只经环境变量名、有界重试、粗估系数合理区间）
    [c.deepseek.base_url.startsWith('https://'), 'deepseek.base_url 必须 https（不降级明文）'],
    [c.deepseek.api_key_env.length > 0, 'deepseek.api_key_env 必须指定（凭据只经环境变量名引用）'],
    [Number.isSafeInteger(c.deepseek.retry_max_attempts_after_initial) && c.deepseek.retry_max_attempts_after_initial >= 0, 'deepseek.retry_max_attempts_after_initial 必须是非负整数'],
    [c.deepseek.estimate_chars_per_token > 0 && c.deepseek.estimate_chars_per_token <= 10, 'deepseek.estimate_chars_per_token 必须在 (0,10]（§11.1 粗估系数带精度）'],
    [c.openrouter.estimate_chars_per_token > 0 && c.openrouter.estimate_chars_per_token <= 10, 'openrouter.estimate_chars_per_token 必须在 (0,10]（§11.1 粗估系数带精度）'],
    // ESTOMAGO_CHAT_EXEC_V1 policy-defaults validation_rules：
    // 后台限额有限正数；费用上限 null=未配置（禁止该用途付费）或有限正数；
    // 时间初值只做形状校验——完整 scheduled_at 由任务 API 层强制，host 不暗补当前时间。
    ...(() => {
      const posInt = (v: number) => Number.isSafeInteger(v) && v >= 1;
      const posMs = (v: number) => Number.isFinite(v) && v > 0;
      const capOk = (v: number | null) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);
      const a = c.background.autonomous, k = c.background.keepwarm, r = c.background.reminders;
      const checks: Array<[boolean, string]> = [
        [posInt(a.max_model_requests_per_run), 'background.autonomous.max_model_requests_per_run 必须是 ≥1 的整数'],
        [posInt(a.max_output_tokens_per_run), 'background.autonomous.max_output_tokens_per_run 必须是 ≥1 的整数'],
        [Number.isSafeInteger(a.max_tool_calls_per_run) && a.max_tool_calls_per_run >= 0, 'background.autonomous.max_tool_calls_per_run 必须是 ≥0 的整数'],
        [posMs(a.max_run_ms), 'background.autonomous.max_run_ms 必须为正数'],
        [capOk(a.daily_cost_cap_usd), 'background.autonomous.daily_cost_cap_usd 必须为有限正数或 null（null=未配置即禁止该用途后台付费，不是无限）'],
        [posInt(k.max_output_tokens_per_run), 'background.keepwarm.max_output_tokens_per_run 必须是 ≥1 的整数'],
        [posMs(k.max_run_ms), 'background.keepwarm.max_run_ms 必须为正数'],
        [capOk(k.daily_cost_cap_usd), 'background.keepwarm.daily_cost_cap_usd 必须为有限正数或 null（null=未配置即禁止保温付费，不是无限）'],
        [posMs(r.delivery_grace_ms), 'background.reminders.delivery_grace_ms 必须为正数'],
        [/^([01]\d|2[0-3]):[0-5]\d$/.test(r.default_local_time), 'background.reminders.default_local_time 必须是 HH:MM（仅前端初值，API 仍须带完整 scheduled_at）'],
        [Number.isSafeInteger(c.content.port) && c.content.port >= 1 && c.content.port <= 65535, 'content.port 必须在 1..65535'],
        [posMs(c.system_alerts.usage_settlement_grace_ms), 'system_alerts.usage_settlement_grace_ms 必须为正数'],
        [posMs(c.system_alerts.summary_refresh_debounce_ms), 'system_alerts.summary_refresh_debounce_ms 必须为正数'],
        [posMs(c.token_estimates.debounce_ms), 'token_estimates.debounce_ms 必须为正数'],
        [posInt(c.token_estimates.max_body_bytes), 'token_estimates.max_body_bytes 必须是 ≥1 的整数'],
        [posInt(c.media.max_image_bytes), 'media.max_image_bytes 必须是 ≥1 的整数'],
        [posInt(c.media.max_audio_bytes), 'media.max_audio_bytes 必须是 ≥1 的整数'],
        [posInt(c.media.max_video_bytes), 'media.max_video_bytes 必须是 ≥1 的整数'],
        [posInt(c.media.max_code_artifact_bytes), 'media.max_code_artifact_bytes 必须是 ≥1 的整数'],
        [posInt(c.media.max_attachments_per_message), 'media.max_attachments_per_message 必须是 ≥1 的整数'],
        [posMs(c.media.import_timeout_ms), 'media.import_timeout_ms 必须为正数'],
        [Number.isSafeInteger(c.media.max_redirects) && c.media.max_redirects >= 0, 'media.max_redirects 必须是 ≥0 的整数'],
      ];
      return checks;
    })(),
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

/** WP5（D02，MANUAL_HANDOFF_JUDGE_SWITCH_V1）：已退役配置键——出现即从补丁
 *  剥离并在 config.retiredKeys 披露（不进运行时、不静默忽略、不阻断启动；
 *  读取处负责把披露写进日志/启动报告）。
 *  WP-03（2026-10-09，JFA-005）：6h 静默/零点换窗/bootstrap_target_tokens
 *  三键并入退役——唯一自动换窗基线=64k 软线（红线 E-18） */
export const RETIRED_CONFIG_KEYS = ['digest', 'windows.recent_dialogue_budget_tokens', 'windows.warning_tokens', 'windows.idle_before_next_user_ms', 'windows.rotate_on_business_date_change', 'windows.bootstrap_target_tokens'] as const;

export function validateConfig(raw: unknown): { config: Config; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const retiredKeys: string[] = [];
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // retiredKeys 是代码写入字段：输入面带它（Config 回灌当补丁的场景）先剥离，
  // 输出永远按实际检测重算——配置文件不能自填披露
  delete input.retiredKeys;
  for (const key of RETIRED_CONFIG_KEYS) {
    const parts = key.split('.');
    let node: Record<string, unknown> | undefined = input;
    for (let i = 0; i < parts.length - 1 && node; i++) {
      const nxt: unknown = node[parts[i]!];
      node = nxt && typeof nxt === 'object' && !Array.isArray(nxt) ? nxt as Record<string, unknown> : undefined;
    }
    const leaf = parts[parts.length - 1]!;
    if (node && node[leaf] !== undefined) {
      retiredKeys.push(key);
      delete node[leaf];
    }
  }
  // retiredKeys 是代码写入的只读披露字段——不进 SHAPE 校验面（输入面无此键）
  const patched = input;
  checkType(patched, SHAPE, '', issues);
  // §29：effort 非法枚举直接拒绝（SDK 不认识的值不得静默通过）
  const effort = (patched as { runtime?: { thinking?: { effort?: unknown } } })?.runtime?.thinking?.effort;
  if (effort !== undefined && effort !== null && !(typeof effort === 'string' && (THINKING_EFFORT_ENUM as readonly string[]).includes(effort))) {
    issues.push({ path: 'runtime.thinking.effort', message: `必须是 ${THINKING_EFFORT_ENUM.join('|')} 或 null（SDK EffortLevel 契约）` });
  }
  // ESTOMAGO_OR_SELF_HOLD §1.1：provider 枚举（新增 openrouter 驱动；未知值不得静默落到 SDK）
  const provider = (patched as { runtime?: { provider?: unknown } })?.runtime?.provider;
  if (provider !== undefined && !(typeof provider === 'string' && (RUNTIME_PROVIDER_ENUM as readonly string[]).includes(provider))) {
    issues.push({ path: 'runtime.provider', message: `必须是 ${RUNTIME_PROVIDER_ENUM.join('|')}（新增驱动走显式枚举，不猜默认）` });
  }
  if (issues.length > 0) return { config: structuredClone(CONFIG_DEFAULTS), issues };
  const config = deepMergeConfig(patched);
  config.retiredKeys = retiredKeys;
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
