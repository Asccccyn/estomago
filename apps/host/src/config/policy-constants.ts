// ESTOMAGO_CHAT_EXEC_V1 · policy-defaults.json 中 adjustable=false 的策略常量正本。
// 这些值不是用户可改配置：USER_DECISION=她已裁定；V1_CONSTRAINT=第一期硬边界，
// 放宽需规范变更，不能靠改 YAML/UI 绕过。adjustable=true 的运行面键在 config/schema.ts。
//
// 映射到既有配置键的表项不在此重复定义（避免同一值两套正本）：
//   cache.anthropic.requested_ttl      → config.openrouter.cache_ttl（硬规则 '1h'）
//   windows.soft_limit_tokens          → config.windows.soft_limit_tokens（64000 保留）
//   runtime.max_active_primary_runners → config.runtime.max_active_primary_runners（1 保留）
//   calendar.timezone                  → config.time.business_timezone（Asia/Shanghai 保留）

export const POLICY_CONSTANTS = {
  background: {
    keepwarm: {
      // 50 分钟：从经实际缓存读写证据确认的那次 dispatch 开始计时；普通聊天成功刷新则顺延
      idle_after_cache_ms: 3_000_000,
      max_model_requests_per_run: 1, // V1：保温只允许一次维护请求，不能 UI 调大绕过
      max_tool_calls_per_run: 0, // V1：工具定义保持稳定，但宿主不执行维护请求的任何工具
      paid_tools_enabled: false, // V1：维护不允许外部收费工具
      allow_cold_start: false, // V1：不以保温名义补冷写
    },
    autonomous: {
      // 60 分钟滚动：同一主体最多一次首次实际派发（跨房间任务）；不是整点 cron
      min_interval_ms: 3_600_000,
    },
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
