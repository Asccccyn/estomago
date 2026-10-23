// Tests-only contract oracle, not a production admission or state-machine implementation.
// Real dispatch, queue, recovery and budget behavior is tested through Host/Supervisor/Scheduler.
import { POLICY_CONSTANTS } from '../../apps/host/src/config/policy-constants.ts';
import { keepwarmSleepState } from '../../apps/host/src/runtime/keepwarm-sleep.ts';
import type { EffectiveSettings, RunState } from '../../apps/host/src/runtime/background-policy.ts';

/**
 * WAKE_KEEPWARM_V1 §05 到点（取得会话执行位后）重新判定（保温）。
 * 返回 skip 原因或 null=可发送。缓存证据要求：不宣称无证据的命中、估计已冷不补冷写
 * （allow_cold_start=false 一期固定——自主预约不受此保温专属门影响，K-14）。
 */
export function keepwarmAdmission(input: {
  settings: EffectiveSettings;
  evidenceStartedAtMs: number | null; // 最近有效缓存证据请求的 dispatch 开始（无证据=null）
  nowMs: number;
  autonomousRunOpen: boolean; // 同主体已有合法自主执行（同到期自主优先，K-15）
}): { skip: 'KEEPWARM_DISABLED' | 'KEEPWARM_SLEEP_WINDOW' | 'KEEPWARM_SLEEP_CONFIG_INVALID' | 'KEEPWARM_CACHE_EVIDENCE_UNKNOWN' | 'KEEPWARM_CACHE_ALREADY_COLD' | 'AUTONOMOUS_FIRST' | null; nextCheckAtMs?: number } {
  if (!input.settings.keepwarm.enabled) return { skip: 'KEEPWARM_DISABLED' };
  const sleep = keepwarmSleepState(input.settings.keepwarm.sleep_window, input.nowMs);
  if (sleep.blocked) return { skip: sleep.code };
  if (input.evidenceStartedAtMs === null) return { skip: 'KEEPWARM_CACHE_EVIDENCE_UNKNOWN' }; // §5.1：没证据不宣称命中
  // K-15：同时有到期自主活动 → 先自主（它刷新缓存后这次机会可标 satisfied_by_request）
  if (input.autonomousRunOpen) return { skip: 'AUTONOMOUS_FIRST' };
  // §5.2：超过估计到期（+1h）默认不补冷写（allow_cold_start=false 一期固定）
  if (input.nowMs - input.evidenceStartedAtMs >= 3_600_000) return { skip: 'KEEPWARM_CACHE_ALREADY_COLD' };
  return { skip: null };
}

/** 保温目标（旧证据+50 分语义保留用于派发内重算；正本见 wake-activity.nextKeepwarmTarget）。 */
export function keepwarmTargetMs(evidenceStartedAtMs: number): number {
  return evidenceStartedAtMs + POLICY_CONSTANTS.background.keepwarm.idle_after_cache_ms;
}

/**
 * WAKE_KEEPWARM_V1 §04 自主开始条件（领取后、首次派发前在执行位内重查）。
 * 2026-10-22：60 分钟冷却与"用户在场取消"已删除（U02/U04）；预算未配置=付费不可开始。
 */
export function autonomousAdmission(input: {
  settings: EffectiveSettings;
  totalSwitchEnabled: boolean; taskEnabled: boolean;
  budgetConfigured: boolean; // 日上限>0 且（有付费工具时）价格已核——这里只管"上限已配置"
  nowMs: number;
}): { skip: 'AUTONOMOUS_DISABLED' | 'TASK_DISABLED' | 'BACKGROUND_BUDGET_NOT_CONFIGURED' | null } {
  if (!input.totalSwitchEnabled || !input.settings.autonomous.enabled) return { skip: 'AUTONOMOUS_DISABLED' };
  if (!input.taskEnabled) return { skip: 'TASK_DISABLED' };
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

