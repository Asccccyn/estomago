// 心跳（keepwarm）专属派发资格门——R4a（2026-11-07）自 supervisor.runBackgroundTurn
// 迁出，行为逐字保留：真实活动/候选版本/维护目标/缓存证据/satisfied_by_request 的
// noop 决策集中于此；晨间唤醒按最新有效晨间目标核对，允许跨夜冷缓存与前夜休息，
// 但受总开关、睡眠静默窗及领取后新前台聊天/新休息约束。
import type { Db } from '../db/connection.ts';
import { CACHE_TTL_MS, lastCacheEvidence } from './cache-observation.ts';
import { keepwarmSleepState, type SleepWindowConfig } from './keepwarm-sleep.ts';
import type { SupervisorDeps } from './supervisor.ts';

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
  morningWake?: { sleepWindow: SleepWindowConfig } | null;
}): KeepwarmGateResult {
  const noop = (resultCode: string, detail: string): KeepwarmGateResult => ({ decision: 'noop', resultCode, detail });
  const act = input.activity?.get(input.conversationId) ?? null;
  if (input.morningWake) {
    const sleep = keepwarmSleepState(input.morningWake.sleepWindow, input.nowMs);
    if (sleep.blocked) return noop(sleep.code!, '睡眠时段暂停晨间唤醒');
    if (input.inputActivityRevision !== null && (act?.activity_revision ?? 0) !== input.inputActivityRevision) {
      return noop('KEEPWARM_SUPERSEDED', '排队期间有新真实消息，按最新目标重算');
    }
    const morning = input.activity?.morningWakeTarget({
      conversationId: input.conversationId, windowId: input.windowId,
      sleepWindow: input.morningWake.sleepWindow, nowMs: input.nowMs,
    });
    if (!morning || !morning.scheduled) {
      const code = morning?.reason === 'SLEEP_WINDOW' ? 'KEEPWARM_SLEEP_WINDOW'
        : morning?.reason === 'DAYTIME_RESTING' ? 'KEEPWARM_RESTING'
          : 'MORNING_WAKE_EXPIRED';
      return noop(code, '晨间唤醒目标已过期、进入休息或落入静默期');
    }
    if (input.nowMs < morning.dueAtMs) {
      return noop('KEEPWARM_SUPERSEDED', '新前台聊天已将当日晨间唤醒顺延');
    }
    return { decision: 'proceed', capturedActivityRevision: act?.activity_revision ?? 0 };
  }
  // —— 普通 50 分钟缓存保温：执行位内重算（05 §派发门与异常；不用 tick 快照）——
  if (!act || act.last_real_activity_at === null) return noop('KEEPWARM_NO_REAL_ACTIVITY', '无真实活动');
  if (act.resting === 1) return noop('KEEPWARM_RESTING', '乔乔已休息：等她明确回来或手动恢复');
  if (input.inputActivityRevision !== null && input.inputActivityRevision !== act.activity_revision) {
    return noop('KEEPWARM_SUPERSEDED', '新真实消息已使本维护候选失效');
  }
  const target = input.activity!.nextKeepwarmTarget({ conversationId: input.conversationId, windowId: input.windowId });
  if (!target.scheduled) return noop('KEEPWARM_SUPERSEDED', '当前活动版本已由晨间唤醒响应');
  if (input.nowMs < target.dueAtMs) return noop('KEEPWARM_SUPERSEDED', '目标已被新证据推后');
  const evidence = lastCacheEvidence(input.db, input.windowId);
  if (evidence === null) return noop('KEEPWARM_CACHE_EVIDENCE_UNKNOWN', '无已确认缓存证据——保温不冷启动');
  if (input.nowMs - Date.parse(evidence.startedAt) >= CACHE_TTL_MS) return noop('KEEPWARM_CACHE_ALREADY_COLD', '缓存估计已冷——不补冷写');
  // 05 satisfied_by_request：同机会内一次真实请求已实际刷新有效缓存（自主唤醒/普通
  // 聊天）→ 本维护机会记技术回执进入后继，不重复付费。
  const prq = input.db.prepare('SELECT purpose FROM provider_requests WHERE id = ?').get(evidence.requestId) as { purpose: string } | undefined;
  const L = Date.parse(act.last_real_activity_at);
  const refreshedByOther = prq && prq.purpose !== 'cache_keepalive' && Date.parse(evidence.startedAt) >= L && (input.nowMs - Date.parse(evidence.startedAt)) < 3_000_000;
  if (refreshedByOther) {
    input.activity!.noteMaintenanceReceipt({ conversationId: input.conversationId, capturedActivityRevision: act.activity_revision, requestId: evidence.requestId, windowId: input.windowId, dispatchStartedAtIso: evidence.startedAt });
    return noop('satisfied_by_request', '同机会缓存已由真实请求刷新——本维护机会不重复付费');
  }
  return { decision: 'proceed', capturedActivityRevision: act.activity_revision };
}
