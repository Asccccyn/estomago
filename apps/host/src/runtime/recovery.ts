// 启动恢复（R3 2026-11-07 纯搬迁自 supervisor.ts，行为逐字保留）：
//  - recoveryPass：进程重启后把崩溃遗留的悬挂态一次性落确定终态（纯 SQL）；
//  - recoverSchedule：committed-not-dispatched 的 pending 回合重派 + 被选集阻断的恢复。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import type { Logger } from '../observability/logging.ts';
import type { SupervisorDeps } from './supervisor.ts';

export function recoveryPass(db: Db, logger: Pick<Logger, 'warn'>): { turns: number; attempts: number; blocks: number; staleWindows: number; releasedWaiting: number; failedOwners: number; staleReviews: number; orphanEffects: number } {
  const now = new Date().toISOString();
  const turns = tx(db, () => Number(db.prepare("UPDATE turns SET state = 'failed', completed_at = ? WHERE state IN ('running') AND completed_at IS NULL").run(now).changes));
  const attempts = tx(db, () => Number(db.prepare("UPDATE attempts SET state = 'failed', blocked_reason = 'RECOVERY_HOST_RESTART', completed_at = ? WHERE state IN ('running')").run(now).changes));
  const blocks = tx(db, () => Number(db.prepare("UPDATE reasoning_blocks SET state = 'failed', updated_at = ? WHERE state = 'streaming'").run(now).changes));
  // 孤儿 candidate 窗口（AUD-38）：PREPARING 悬挂 → 终态 BLOCKED
  const staleWindows = tx(db, () => Number(db.prepare("UPDATE windows SET status = 'BLOCKED', blocked_reason = 'RECOVERY_ORPHAN_CANDIDATE', updated_at = ? WHERE status = 'PREPARING'").run(now).changes));
  // waiting_route_gate 但房间已无 pending 票据 → 释放回 pending（可被调度恢复接管）
  const releasedWaiting = tx(db, () => Number(db.prepare(
    `UPDATE attempts SET state = 'pending', blocked_reason = NULL
     WHERE state = 'waiting_route_gate'
       AND turn_id IN (SELECT t.id FROM turns t WHERE NOT EXISTS (
         SELECT 1 FROM route_decisions rd WHERE rd.conversation_id = t.conversation_id AND rd.state = 'pending'))`,
  ).run().changes));
  // route_owner_pending 但票据已消失（被并发消费后崩溃等）→ failed（防悬挂 owner）
  const failedOwners = tx(db, () => Number(db.prepare(
    `UPDATE attempts SET state = 'failed', blocked_reason = 'RECOVERY_ORPHAN_ROUTE_OWNER', completed_at = ?
     WHERE state = 'route_owner_pending'
       AND NOT EXISTS (SELECT 1 FROM route_decisions rd WHERE rd.attempt_id = attempts.id AND rd.state = 'pending')`,
  ).run(now).changes));
  // D03a：无执行者的 active 评审 → failed（重启后没有任何协程会收口它；不伪造完成凭证）
  const staleReviews = tx(db, () => Number(db.prepare("UPDATE rotation_reviews SET status = 'failed', updated_at = ? WHERE status = 'active'").run(now).changes));
  // D03b：崩溃遗留 running 写操作——远端写（hold/i_write）结果不明（M 侧可能已提交，
  // 可按 operation_id 探测恢复）；本地类可判未提交（R3-M02：i_write 崩溃在提交缝时
  // 曾被误判 failed_resolved，撤掉原操作的未决资格）
  const orphanEffects = tx(db, () => Number(db.prepare(
    "UPDATE tool_side_effects SET state = CASE WHEN kind IN ('hold','i_write') THEN 'unknown' ELSE 'failed_resolved' END, updated_at = ? WHERE state = 'running'",
  ).run(now).changes));
  const total = turns + attempts + blocks + staleWindows + releasedWaiting + failedOwners + staleReviews + orphanEffects;
  if (total > 0) logger.warn('recovery_pass', { turns, attempts, blocks, staleWindows, releasedWaiting, failedOwners, staleReviews, orphanEffects, code: 'RECOVERY_HOST_RESTART' });
  return { turns, attempts, blocks, staleWindows, releasedWaiting, failedOwners, staleReviews, orphanEffects };
}

export function recoverSchedule(deps: SupervisorDeps): { redispatched: number } {
  const rows = deps.db
    .prepare("SELECT t.id FROM turns t JOIN attempts a ON a.turn_id = t.id WHERE t.state = 'pending' AND a.state IN ('pending','ready_after_route')")
    .all() as Array<{ id: string }>;
  for (const r of rows) deps.supervisor!.enqueue(r.id);
  const recoverable = deps.db.prepare(`SELECT DISTINCT s.conversation_id FROM context_selections s
    JOIN conversations c ON c.id=s.conversation_id
    WHERE s.rotation_cause IS NOT NULL AND
      (s.status='confirmed' OR (s.status='consumed' AND s.target_window_id=c.active_window_id))
      AND EXISTS (SELECT 1 FROM turns t JOIN attempts a ON a.turn_id=t.id
        WHERE t.conversation_id=s.conversation_id AND t.state='blocked' AND a.state='blocked'
        AND (a.blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' OR a.blocked_reason LIKE 'CONTEXT_ROTATION_REQUIRED%'))`).all() as Array<{ conversation_id: string }>;
  for (const row of recoverable) void deps.supervisor!.resumeAfterSelectionConfirm(row.conversation_id).catch(() => {
    deps.logger.warn('selection_recovery_failed', { code: 'ROTATION_RECOVERY_FAILED' });
  });
  return { redispatched: rows.length };
}
