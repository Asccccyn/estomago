// ESTOMAGO_CHAT_EXEC_V1 §04（WP4）：后台策略纯函数——时间计算、滚动冷却、预算验证、准入判定、
// 状态转换。无 IO、无时钟依赖（now 由调用方注入）——虚拟时钟可测（§9.2 测试要求）。
// 数字唯一正本=policy-defaults.json（经 config schema + POLICY_CONSTANTS）。
import { POLICY_CONSTANTS } from '../config/policy-constants.ts';
import { shanghaiDayOf } from '../usage/attribution.ts';
import type { Config } from '../config/schema.ts';

export type BackgroundKind = 'autonomous' | 'keepwarm' | 'reminder';
export type RunState = 'claimed' | 'running' | 'cancelling' | 'completed' | 'noop' | 'skipped' | 'cancelled' | 'failed' | 'unknown';

export type EffectiveSettings = {
  revision: number;
  autonomous: { enabled: boolean; max_model_requests_per_run: number; max_output_tokens_per_run: number; max_tool_calls_per_run: number; max_run_ms: number; paid_tools_enabled: boolean; daily_cost_cap_usd: number | null };
  keepwarm: { enabled: boolean; max_output_tokens_per_run: number; max_run_ms: number; daily_cost_cap_usd: number | null };
  reminders: { enabled: boolean; delivery_grace_ms: number; default_local_time: string };
};

/** §4.2/§4.1：生效视图——页面/调度器/派发前检查读同一份（不得用启动时缓存的旧 enabled）。 */
export function effectiveSettings(config: Config, storedRevision: number, stored: Partial<{ autonomous_enabled: boolean | null; keepwarm_enabled: boolean | null; reminders_enabled: boolean | null }> | null): EffectiveSettings {
  return {
    revision: storedRevision,
    autonomous: {
      enabled: stored?.autonomous_enabled ?? config.background.autonomous.enabled,
      max_model_requests_per_run: config.background.autonomous.max_model_requests_per_run,
      max_output_tokens_per_run: config.background.autonomous.max_output_tokens_per_run,
      max_tool_calls_per_run: config.background.autonomous.max_tool_calls_per_run,
      max_run_ms: config.background.autonomous.max_run_ms,
      paid_tools_enabled: config.background.autonomous.paid_tools_enabled,
      daily_cost_cap_usd: config.background.autonomous.daily_cost_cap_usd,
    },
    keepwarm: {
      enabled: stored?.keepwarm_enabled ?? config.background.keepwarm.enabled,
      max_output_tokens_per_run: config.background.keepwarm.max_output_tokens_per_run,
      max_run_ms: config.background.keepwarm.max_run_ms,
      daily_cost_cap_usd: config.background.keepwarm.daily_cost_cap_usd,
    },
    reminders: { enabled: stored?.reminders_enabled ?? config.background.reminders.enabled, delivery_grace_ms: config.background.reminders.delivery_grace_ms, default_local_time: config.background.reminders.default_local_time },
  };
}

/** §6.1：同一主体滚动 60 分钟冷却——以上次自主首派发开始计；创建多任务/换房间/改 ID 不重置。
 *  返回 null=冷却通过（可开始）；否则返回合法下次时刻（毫秒）。 */
export function autonomousCooldownDueAtMs(lastFirstDispatchStartedAt: string | null | undefined, nowMs: number): number | null {
  if (!lastFirstDispatchStartedAt) return null;
  const started = Date.parse(lastFirstDispatchStartedAt);
  if (!Number.isFinite(started)) return null; // 无可靠时间=不构成冷却记录
  const due = started + POLICY_CONSTANTS.background.autonomous.min_interval_ms;
  return due > nowMs ? due : null;
}

/** §5.2 到点前重新判定（保温）。返回 skip 原因或 null=可发送。 */
export function keepwarmAdmission(input: {
  settings: EffectiveSettings;
  evidenceStartedAtMs: number | null; // 最近有效缓存证据请求的 dispatch 开始（无证据=null）
  nowMs: number;
  chatActive: boolean; // 正在聊天或有待处理用户输入
  pendingUserInput: boolean;
  autonomousRunOpen: boolean; // 同主体已有合法自主执行
}): { skip: 'KEEPWARM_DISABLED' | 'KEEPWARM_CACHE_EVIDENCE_UNKNOWN' | 'KEEPWARM_CACHE_ALREADY_COLD' | 'CHAT_ACTIVE' | 'AUTONOMOUS_FIRST' | null; nextCheckAtMs?: number } {
  if (!input.settings.keepwarm.enabled) return { skip: 'KEEPWARM_DISABLED' };
  if (input.evidenceStartedAtMs === null) return { skip: 'KEEPWARM_CACHE_EVIDENCE_UNKNOWN' }; // §5.1：没证据不宣称命中
  // §5.2：聊天优先——正在聊天/待处理输入=让出，聊天结束后重新判断
  if (input.chatActive || input.pendingUserInput) return { skip: 'CHAT_ACTIVE' };
  // §5.2：同时有到期自主活动 → 先自主（它刷新缓存后取消这次重复保温）
  if (input.autonomousRunOpen) return { skip: 'AUTONOMOUS_FIRST' };
  // §5.2：超过估计到期（+1h）默认不补冷写（allow_cold_start=false 一期固定）
  if (input.nowMs - input.evidenceStartedAtMs >= 3_600_000) return { skip: 'KEEPWARM_CACHE_ALREADY_COLD' };
  return { skip: null };
}

/** 保温目标与重排（§5.4）：新证据=新目标；旧到期机会作废（调用方以最新证据重算）。 */
export function keepwarmTargetMs(evidenceStartedAtMs: number): number {
  return evidenceStartedAtMs + POLICY_CONSTANTS.background.keepwarm.idle_after_cache_ms;
}

/** §6.1 自主开始条件（领取后、首次派发前都查）。返回 null=通过。 */
export function autonomousAdmission(input: {
  settings: EffectiveSettings;
  totalSwitchEnabled: boolean; taskEnabled: boolean;
  hasPendingUserChat: boolean;
  cooldownDueAtMs: number | null; // autonomousCooldownDueAtMs 的结果
  budgetConfigured: boolean; // 两个条件：日上限>0 且（有付费工具时）价格已核——这里只管"上限已配置"
  nowMs: number;
}): { skip: 'AUTONOMOUS_DISABLED' | 'TASK_DISABLED' | 'USER_CHAT_PREEMPTED' | 'AUTONOMOUS_COOLDOWN' | 'BACKGROUND_BUDGET_NOT_CONFIGURED' | null; effectiveDueAt?: number } {
  if (!input.totalSwitchEnabled || !input.settings.autonomous.enabled) return { skip: 'AUTONOMOUS_DISABLED' };
  if (!input.taskEnabled) return { skip: 'TASK_DISABLED' };
  if (input.hasPendingUserChat) return { skip: 'USER_CHAT_PREEMPTED' };
  if (input.cooldownDueAtMs !== null) return { skip: 'AUTONOMOUS_COOLDOWN', effectiveDueAt: input.cooldownDueAtMs };
  // §4.2：daily_cost_cap_usd=null=未配置——该用途后台付费不可开始（不是无限）
  if (input.settings.autonomous.daily_cost_cap_usd === null) return { skip: 'BACKGROUND_BUDGET_NOT_CONFIGURED' };
  return { skip: null };
}

/** §9.1 状态机转换表（合法跃迁）。 */
const TRANSITIONS: Record<RunState, RunState[]> = {
  claimed: ['running', 'skipped', 'cancelled', 'failed'],
  running: ['completed', 'noop', 'cancelling', 'failed', 'unknown'],
  cancelling: ['cancelled', 'unknown'],
  unknown: ['completed', 'cancelled', 'failed'],
  completed: [], noop: [], skipped: [], cancelled: [], failed: [],
};
export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** §10.2 预算校验（transport 前准入的一部分）。整数限额有限正数；未配置上限=付费禁止。 */
export function budgetGate(input: {
  kind: 'autonomous' | 'keepwarm';
  settings: EffectiveSettings;
  run: { model_requests_started: number; tool_calls_started: number; output_tokens_observed: number; startedAtMs: number; reserved_cost_micro_usd: number; known_cost_micro_usd: number; unknown_cost_count: number };
  nowMs: number;
  nextRequestCostMicroUsd: number | null; // 保守上界；null=无法核验
}): { allowed: false; code: 'BACKGROUND_BUDGET_EXHAUSTED' | 'BUDGET_ESTIMATE_UNAVAILABLE' | 'BACKGROUND_BUDGET_NOT_CONFIGURED' } | { allowed: true } {
  const s = input.kind === 'autonomous' ? input.settings.autonomous : input.settings.keepwarm;
  if (s.daily_cost_cap_usd === null) return { allowed: false, code: 'BACKGROUND_BUDGET_NOT_CONFIGURED' };
  if (input.nextRequestCostMicroUsd === null) return { allowed: false, code: 'BUDGET_ESTIMATE_UNAVAILABLE' };
  const autoS = input.settings.autonomous;
  if (input.kind === 'autonomous') {
    if (input.run.model_requests_started >= autoS.max_model_requests_per_run) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
    if (input.run.tool_calls_started >= autoS.max_tool_calls_per_run) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
    if (input.run.output_tokens_observed >= s.max_output_tokens_per_run) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
    if (input.nowMs - input.run.startedAtMs >= s.max_run_ms) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
  } else {
    // keepwarm：单请求/零工具/30s 上限（V1 固定），输出≤max_output_tokens_per_run
    if (input.run.model_requests_started >= POLICY_CONSTANTS.background.keepwarm.max_model_requests_per_run) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
    if (input.run.tool_calls_started >= POLICY_CONSTANTS.background.keepwarm.max_tool_calls_per_run) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
    if (input.nowMs - input.run.startedAtMs >= s.max_run_ms) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
  }
  // 日预算（微美元整数）：已占（预占含未知）+ 本次上界 ≤ cap×1e6
  const capMicro = Math.round(s.daily_cost_cap_usd * 1_000_000);
  const occupied = input.run.reserved_cost_micro_usd;
  if (occupied + input.nextRequestCostMicroUsd > capMicro) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
  return { allowed: true };
}

/** §4.2/§10.1 业务日：派发开始时的上海日（跨午夜不挪账）。 */
export function budgetDayOfMs(nowMs: number): string {
  return shanghaiDayOf(new Date(nowMs).toISOString()) ?? '';
}

/** §9.2 重启恢复规则：孤儿 claimed（零派发）=skipped；有已开始派发=unknown（预占保留）。 */
export function restartDisposition(run: { state: RunState; dispatchCount: number }): { to: RunState; resultCode: string } {
  if (run.state === 'claimed' && run.dispatchCount === 0) return { to: 'skipped', resultCode: 'HOST_RESTART_BEFORE_SEND' };
  if (run.state === 'claimed' || run.state === 'running' || run.state === 'cancelling') return { to: 'unknown', resultCode: 'HOST_RESTART_MID_RUN' };
  return { to: run.state, resultCode: 'UNCHANGED' };
}

/** §4.1 时钟回拨：向后跳不缩短冷却——暂停后台模型任务并报告。 */
export function clockRegressionAction(lastTickMs: number, nowMs: number): 'BACKGROUND_CLOCK_REGRESSION' | null {
  if (lastTickMs > 0 && nowMs < lastTickMs - 2_000) return 'BACKGROUND_CLOCK_REGRESSION';
  return null;
}
