// ESTOMAGO_CHAT_EXEC_V1 · policy-defaults.json 中 adjustable=false 的策略常量正本。
// 这些值不是用户可改配置：USER_DECISION=她已裁定；V1_CONSTRAINT=第一期硬边界，
// 放宽需规范变更，不能靠改 YAML/UI 绕过。adjustable=true 的运行面键在 config/schema.ts。
//
// 映射到既有配置键的表项不在此重复定义（避免同一值两套正本）：
//   cache.anthropic.requested_ttl      → config.openrouter.cache_ttl（硬规则 '1h'）
//   windows.soft_limit_tokens          → config.windows.soft_limit_tokens（600000 兜底：她 2026-10-17 裁定，2026-10-21 默认对齐）
//   runtime.max_active_primary_runners → config.runtime.max_active_primary_runners（1 保留）
//   calendar.timezone                  → config.time.business_timezone（Asia/Shanghai 保留）

export const POLICY_CONSTANTS = {
  background: {
    keepwarm: {
      // 50 分钟：真实发布锚点 L +50 分；有效维护回执则按其 dispatch +50 分（技术续温）
      idle_after_cache_ms: 3_000_000,
      allow_cold_start: false, // 保温不以维护名义补冷写（自主预约不受此门影响）
      // 2026-10-22（WAKE_KEEPWARM_V1 她 1022 裁定）：心跳是完整回合——旧的
      // 单请求/零工具/128 输出/禁收费工具封锁已删除；心跳沿用主会话工具循环、
      // 正常输出上限、既有授权与真实预算（09：资金保护不得变相撤销行为自由）。
    },
    // 2026-10-22（WAKE_KEEPWARM_V1 她 1022 裁定 U02）：60 分钟自主冷却已删除——
    // char自己决定何时醒来，十分钟、半小时均可，无每日配额、无单任务限制。
  },
  pagination: {
    default_limit: 20,
    max_limit: 100, // 超限返回参数错误，不静默截断成"完整结果"
  },
  system_alerts: {
    read_batch_max: 100, // 按已见 sequence 单调幂等；快照之外的新事件保持未读
  },
  content: {
    bind_host: '127.0.0.1', // 本期独立 content 仅 loopback 监听
  },
} as const;
