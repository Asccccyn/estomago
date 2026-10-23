// ESTOMAGO_CHAT_EXEC_V1 §04（WP4）+ WAKE_KEEPWARM_V1（2026-10-22）：后台策略纯函数——
// 保温目标/准入判定、预算验证、状态转换、时钟防护。无 IO、无时钟依赖（now 由调用方注入）。
// 2026-10-22 改造：60 分钟自主冷却删除（U02）；keepwarm 单请求/零工具封锁删除（心跳=
// 完整回合，09）；CHAT_ACTIVE 用户在场门删除（U04：不能把"用户在场"当暂停理由——
// 排队与让位由会话串行链在执行位内处理，03）；纯1维护回执与真实活动双时钟语义见
// wake-activity.ts。数字唯一正本=policy-constants（经 POLICY_CONSTANTS）。
import { shanghaiDayOf } from '../usage/attribution.ts';
import type { Config } from '../config/schema.ts';
import type { KeepwarmSleepWindow } from './keepwarm-sleep.ts';

export type BackgroundKind = 'autonomous' | 'keepwarm' | 'reminder';
export type RunState = 'claimed' | 'running' | 'cancelling' | 'completed' | 'noop' | 'skipped' | 'cancelled' | 'failed' | 'unknown';

export type EffectiveSettings = {
  revision: number;
  autonomous: { enabled: boolean; max_model_requests_per_run: number; max_output_tokens_per_run: number; max_tool_calls_per_run: number; max_run_ms: number; daily_cost_cap_usd: number | null };
  keepwarm: { enabled: boolean; max_run_ms: number; daily_cost_cap_usd: number | null; sleep_window: KeepwarmSleepWindow };
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
      daily_cost_cap_usd: config.background.autonomous.daily_cost_cap_usd,
    },
    keepwarm: {
      enabled: stored?.keepwarm_enabled ?? config.background.keepwarm.enabled,
      // The former pure-cache 30s limit must not truncate a full tool turn.
      // Keep its YAML key readable for old configurations; use the normal
      // background turn limit, just as keepwarm uses the normal output limit.
      max_run_ms: config.background.autonomous.max_run_ms,
      daily_cost_cap_usd: config.background.keepwarm.daily_cost_cap_usd,
      sleep_window: { ...config.background.keepwarm.sleep_window },
    },
    reminders: { enabled: stored?.reminders_enabled ?? config.background.reminders.enabled, delivery_grace_ms: config.background.reminders.delivery_grace_ms, default_local_time: config.background.reminders.default_local_time },
  };
}

/**
 * §10.2 预算校验（transport 前准入的一部分）。日占用=已结算 actual + 未结算预占（含
 * unknown）+ 本次上界；上界不可核验=UNAVAILABLE（09：未知价格不当 0、不放行）。
 * 2026-10-22：keepwarm 分支不再有单请求/零工具/128 输出心跳封锁——保留的只有
 * max_run_ms 结构保护与日预算；模型请求数门只对 autonomous 生效（每 run 付费上限）。
 */
export function budgetGate(input: {
  kind: 'autonomous' | 'keepwarm';
  dispatchKind?: 'model' | 'tool';
  settings: EffectiveSettings;
  run: { model_requests_started: number; tool_calls_started: number; output_tokens_observed: number; startedAtMs: number; reserved_cost_micro_usd: number; known_cost_micro_usd: number; unknown_cost_count: number };
  nowMs: number;
  nextRequestCostMicroUsd: number | null; // 保守上界；null=无法核验
}): { allowed: false; code: 'BACKGROUND_BUDGET_EXHAUSTED' | 'BUDGET_ESTIMATE_UNAVAILABLE' | 'BACKGROUND_BUDGET_NOT_CONFIGURED' } | { allowed: true } {
  const s = input.kind === 'autonomous' ? input.settings.autonomous : input.settings.keepwarm;
  if (s.daily_cost_cap_usd === null || !Number.isFinite(s.daily_cost_cap_usd) || s.daily_cost_cap_usd <= 0) return { allowed: false, code: 'BACKGROUND_BUDGET_NOT_CONFIGURED' };
  if (input.nextRequestCostMicroUsd === null || !Number.isSafeInteger(input.nextRequestCostMicroUsd) || input.nextRequestCostMicroUsd < 0) return { allowed: false, code: 'BUDGET_ESTIMATE_UNAVAILABLE' };
  if (input.kind === 'autonomous') {
    const autoS = input.settings.autonomous;
    if ((input.dispatchKind ?? 'model') === 'model' && input.run.model_requests_started >= autoS.max_model_requests_per_run) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
    if (input.dispatchKind === 'tool' && input.run.tool_calls_started >= autoS.max_tool_calls_per_run) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
  }
  if (input.nowMs - input.run.startedAtMs >= s.max_run_ms) return { allowed: false, code: 'BACKGROUND_BUDGET_EXHAUSTED' };
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

/**
 * §9.2 + WAKE_KEEPWARM_V1 §04 恢复规则：零派发 claimed=可恢复（删除孤儿行，同
 * occurrence 由调度器重新领取——W-14"领取≠消耗"）；有已开始派发=unknown（预占保留）。
 */
export function restartDisposition(run: { state: RunState; dispatchCount: number; kind?: BackgroundKind }): { to: RunState; resultCode: string } {
  if (run.dispatchCount === 0 && (run.state === 'claimed' || (run.state === 'running' && run.kind !== 'reminder'))) return { to: 'skipped', resultCode: 'HOST_RESTART_BEFORE_SEND' };
  if (run.state === 'claimed' || run.state === 'running' || run.state === 'cancelling') return { to: 'unknown', resultCode: 'HOST_RESTART_MID_RUN' };
  return { to: run.state, resultCode: 'UNCHANGED' };
}

/** §4.1 时钟回拨：向后跳暂停后台模型任务并报告。 */
export function clockRegressionAction(lastTickMs: number, nowMs: number): 'BACKGROUND_CLOCK_REGRESSION' | null {
  if (lastTickMs > 0 && nowMs < lastTickMs - 2_000) return 'BACKGROUND_CLOCK_REGRESSION';
  return null;
}
