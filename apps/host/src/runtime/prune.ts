// WP-04（JFA-E01）：本地库增长有界化——维护函数（默认手动/她批的定时执行）。
//  - provider_requests.payload_json 轮转：窗口已 CLOSED 且超 keepDays 的行
//    置空大字段（行本身与 request_id/generation/usage 关联保留——账本不丢）；
//  - runtime_stream_events/reasoning_blocks 按 keepDays 删过期行（SSE 重放
//    游标按 id 单调，删旧段不破坏续读）；
//  - usage_observations 永久保留（费用账本，不轮转）。
// 禁止：不动 outbox/ingest_batches/tool_side_effects/hold_checkpoints
//（恢复协议依赖）；不删未 CLOSED 窗口的 payload；prune 计数落 audit_events。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';

export type PruneOptions = { keepWindows?: number; keepDays?: number };
export type PruneResult = {
  payload_cleared: number;
  events_deleted: number;
  reasoning_deleted: number;
};

function _cutoff(keepDays: number): string {
  return new Date(Date.now() - keepDays * 24 * 3600 * 1000).toISOString();
}

/** CLOSED 超期窗口的 provider_requests.payload_json 置空（行保留）。 */
export function pruneProviderRequests(db: Db, opts: PruneOptions = {}): number {
  const keepWindows = opts.keepWindows ?? 5;
  const keepDays = opts.keepDays ?? 30;
  // 活跃侧豁免：最近 keepWindows 个窗口（含一切非 CLOSED）不动
  const fresh = db.prepare(
    "SELECT id FROM windows ORDER BY updated_at DESC LIMIT ?",
  ).all(keepWindows) as Array<{ id: string }>;
  const freshIds = fresh.map((r) => r.id);
  const ph = freshIds.length > 0 ? freshIds.map(() => '?').join(',') : "''";
  const cutoff = _cutoff(keepDays);
  return tx(db, () => {
    const cur = db.prepare(
      `UPDATE provider_requests SET payload_json = NULL
       WHERE payload_json IS NOT NULL
         AND window_id IN (SELECT id FROM windows WHERE status = 'CLOSED' AND updated_at < ?)
         AND window_id NOT IN (${ph})`,
    ).run(cutoff, ...freshIds);
    return Number(cur.changes);
  });
}

/** 过期流事件与 reasoning 块删除（SSE 游标续读不受影响）。 */
export function pruneEvents(db: Db, opts: PruneOptions = {}): { events: number; reasoning: number } {
  const keepDays = opts.keepDays ?? 90;
  const cutoff = _cutoff(keepDays);
  return tx(db, () => {
    const ev = db.prepare(
      'DELETE FROM runtime_stream_events WHERE occurred_at < ?',
    ).run(cutoff);
    const rb = db.prepare(
      'DELETE FROM reasoning_blocks WHERE created_at < ?',
    ).run(cutoff);
    return { events: Number(ev.changes), reasoning: Number(rb.changes) };
  });
}

/** 审计留痕（独立小事务：prune 计数本身不回滚 prune）。 */
export function recordPruneAudit(db: Db, result: PruneResult, opts: PruneOptions): void {
  tx(db, () => {
    db.prepare(
      "INSERT INTO audit_events(id, who, what, scope, result, detail_ref, created_at) VALUES (?, 'system', 'maintenance.prune', 'local_db', ?, ?, ?)",
    ).run(`apr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      JSON.stringify({ ...result, opts }), null, new Date().toISOString());
  });
}

export function pruneAll(db: Db, opts: PruneOptions = {}): PruneResult {
  const payload_cleared = pruneProviderRequests(db, opts);
  const { events, reasoning } = pruneEvents(db, opts);
  const result: PruneResult = { payload_cleared, events_deleted: events, reasoning_deleted: reasoning };
  recordPruneAudit(db, result, opts);
  return result;
}
