// 心跳（keepwarm）专属派发资格门（WAKE_KEEPWARM_V1 + Heartbeat v2.1）：
// 统一经 ConversationActivityService 读取当前权威资格、连续三次未出现暂停、异步 Sol 待判门、
// 夜间四小时提前恢复与前夜截止；晨间兜底允许跨夜冷缓存与前夜正常夜休，普通 50 分钟循环
// 沿用既有缓存证据与 satisfied_by_request 合同。
import type { Db } from '../db/connection.ts';
import { CACHE_TTL_MS, lastCacheEvidence } from './cache-observation.ts';
import { effectiveSleepState, type SleepWindowConfig } from './keepwarm-sleep.ts';
import type { SupervisorDeps } from './supervisor.ts';
import { MAX_CONSECUTIVE_UNANSWERED_HEARTBEATS, shanghaiDateOfMs } from './wake-activity.ts';

export type KeepwarmGateResult =
  | { decision: 'proceed'; capturedActivityRevision: number }
  | { decision: 'noop'; resultCode: string; detail: string };

export function keepwarmDispatchGate(input: {
  db: Db;
  activity: SupervisorDeps['activity'];
  conversationId: string;
  windowId: string;
  inputActivityRevision: number | null;
  nowMs: number;
  sleepWindow?: SleepWindowConfig | null;
  morningWake?: { sleepWindow: SleepWindowConfig } | null;
}): KeepwarmGateResult {
  const noop = (resultCode: string, detail: string): KeepwarmGateResult => ({ decision: 'noop', resultCode, detail });
  const act = input.activity?.get(input.conversationId) ?? null;
  if (act?.pending_rest_message_id) {
    return noop('REST_JUDGMENT_PENDING', '正在等待休息意图语义判断，暂不派发心跳');
  }
  const effectiveSw = input.morningWake?.sleepWindow ?? input.sleepWindow ?? null;
  if (effectiveSw) {
    const sleep = effectiveSleepState(effectiveSw, input.nowMs, act?.early_resumed_date);
    if (sleep.blocked) return noop(sleep.code!, '睡眠时段暂停心跳');
  }

  if (input.morningWake) {
    if (input.inputActivityRevision !== null && (act?.activity_revision ?? 0) !== input.inputActivityRevision) {
      return noop('KEEPWARM_SUPERSEDED', '排队期间有新真实消息，按最新目标重算');
    }
    const morning = input.activity?.morningWakeTarget({
      conversationId: input.conversationId, windowId: input.windowId,
      sleepWindow: input.morningWake.sleepWindow, nowMs: input.nowMs,
    });
    if (!morning || !morning.scheduled) {
      const code = morning?.reason === 'SLEEP_WINDOW' ? 'KEEPWARM_SLEEP_WINDOW'
        : morning?.reason === 'DAYTIME_RESTING' || morning?.reason === 'WAIT_NEXT_USER_MESSAGE' ? 'KEEPWARM_RESTING'
          : morning?.reason === 'SUPERSEDED_BY_EARLY_RESUME' ? 'KEEPWARM_SUPERSEDED'
            : morning?.reason === 'REST_JUDGMENT_PENDING' ? 'REST_JUDGMENT_PENDING'
              : 'MORNING_WAKE_EXPIRED';
      return noop(code, '晨间唤醒目标已过期、进入休息、被提前恢复取代或落入静默期');
    }
    if (input.nowMs < morning.dueAtMs) {
      return noop('KEEPWARM_SUPERSEDED', '晨间唤醒目标尚未到点');
    }
    return { decision: 'proceed', capturedActivityRevision: act?.activity_revision ?? 0 };
  }

  // —— 统一 50 分钟自动心跳循环（白天或已提前恢复的凌晨）——
  if (!act || (act.last_real_activity_at === null && act.last_effective_heartbeat_at === null)) {
    return noop('KEEPWARM_NO_REAL_ACTIVITY', '无真实活动');
  }
  if (act.resting === 1) {
    return noop('KEEPWARM_RESTING', '乔乔已休息：等她回来或次晨兜底');
  }
  const today = shanghaiDateOfMs(input.nowMs);
  if (act.consecutive_unanswered_count >= MAX_CONSECUTIVE_UNANSWERED_HEARTBEATS
    && (act.streak_paused_date === null || today <= act.streak_paused_date)) {
    return noop('KEEPWARM_CONSECUTIVE_LIMIT', '连续三次未出现，今日暂停自动心跳');
  }
  if (input.inputActivityRevision !== null && input.inputActivityRevision !== act.activity_revision) {
    return noop('KEEPWARM_SUPERSEDED', '新真实消息已使本维护候选失效');
  }
  const target = input.activity!.nextKeepwarmTarget({ conversationId: input.conversationId, windowId: input.windowId });
  if (!target.scheduled) return noop('KEEPWARM_NO_REAL_ACTIVITY', '无有效心跳锚点');
  const suppressedBeforeMs = act.keepwarm_suppressed_due_before_at ? Date.parse(act.keepwarm_suppressed_due_before_at) : NaN;
  if (Number.isFinite(suppressedBeforeMs) && target.dueAtMs <= suppressedBeforeMs) {
    return noop('KEEPWARM_SUPERSEDED', '手动关闭期间已错过的机会不补发');
  }
  if (input.nowMs < target.dueAtMs) return noop('KEEPWARM_SUPERSEDED', '目标已被新证据推后');
  if (effectiveSw && effectiveSleepState(effectiveSw, target.dueAtMs, act.early_resumed_date).blocked) {
    return noop('KEEPWARM_SLEEP_WINDOW', '心跳目标落入夜间截止时段，作废');
  }
  const evidence = lastCacheEvidence(input.db, input.windowId);
  if (evidence === null) return noop('KEEPWARM_CACHE_EVIDENCE_UNKNOWN', '无已确认缓存证据——保温不冷启动');
  if (input.nowMs - Date.parse(evidence.startedAt) >= CACHE_TTL_MS) return noop('KEEPWARM_CACHE_ALREADY_COLD', '缓存估计已冷——不补冷写');
  // 05 satisfied_by_request：同机会内一次真实请求已实际刷新有效缓存（自主唤醒/普通
  // 聊天）→ 本维护机会记技术回执进入后继，不重复付费。
  const prq = input.db.prepare('SELECT purpose FROM provider_requests WHERE id = ?').get(evidence.requestId) as { purpose: string } | undefined;
  const anchorIso = act.last_real_activity_at ?? act.last_effective_heartbeat_at!;
  const L = Date.parse(anchorIso);
  const refreshedByOther = prq && prq.purpose !== 'cache_keepalive' && Date.parse(evidence.startedAt) >= L && (input.nowMs - Date.parse(evidence.startedAt)) < 3_000_000;
  if (refreshedByOther) {
    input.activity!.noteMaintenanceReceipt({ conversationId: input.conversationId, capturedActivityRevision: act.activity_revision, requestId: evidence.requestId, windowId: input.windowId, dispatchStartedAtIso: evidence.startedAt });
    return noop('satisfied_by_request', '同机会缓存已由真实请求刷新——本维护机会不重复付费');
  }
  return { decision: 'proceed', capturedActivityRevision: act.activity_revision };
}
