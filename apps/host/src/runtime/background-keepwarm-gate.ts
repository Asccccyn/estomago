// 心跳（keepwarm）专属派发资格门——R4a（2026-11-07）自 supervisor.runBackgroundTurn
// 迁出，行为逐字保留：真实活动/候选版本/维护目标/缓存证据/satisfied_by_request 的
// noop 决策集中于此；改保温策略只看本文件（睡眠窗判定留在调用方入口，先于 run 检查）。
import type { Db } from '../db/connection.ts';
import { lastCacheEvidence } from './cache-observation.ts';
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
}): KeepwarmGateResult {
  const noop = (resultCode: string, detail: string): KeepwarmGateResult => ({ decision: 'noop', resultCode, detail });
  // —— 执行位内重算（05 §派发门与异常；不用 tick 快照）——
  const act = input.activity?.get(input.conversationId) ?? null;
  if (!act || act.last_real_activity_at === null) return noop('KEEPWARM_NO_REAL_ACTIVITY', '无真实活动');
  if (act.resting === 1) return noop('KEEPWARM_RESTING', '乔乔已休息：等她明确回来或手动恢复');
  if (input.inputActivityRevision !== null && input.inputActivityRevision !== act.activity_revision) {
    return noop('KEEPWARM_SUPERSEDED', '新真实消息已使本维护候选失效');
  }
  const target = input.activity!.nextKeepwarmTarget({ conversationId: input.conversationId, windowId: input.windowId });
  if (target.scheduled && input.nowMs < target.dueAtMs) return noop('KEEPWARM_SUPERSEDED', '目标已被新证据推后');
  const evidence = lastCacheEvidence(input.db, input.windowId);
  if (evidence === null) return noop('KEEPWARM_CACHE_EVIDENCE_UNKNOWN', '无已确认缓存证据——保温不冷启动');
  if (input.nowMs - Date.parse(evidence.startedAt) >= 3_600_000) return noop('KEEPWARM_CACHE_ALREADY_COLD', '缓存估计已冷——不补冷写');
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
