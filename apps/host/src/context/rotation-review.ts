// 换窗评审服务（§3.2/§3.3/§4.3）：评审的创建、完成校验、空范围跳过、同范围凭证复用。
// 完成语义在 context/review-policy.ts completeReview；本文件做持久化、账本读取与范围去重。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import { completeReview, rawKey, type ReviewCompleteArgs, type ReviewRangeItem, type RotationReview, type SideEffectLedgerEntry, type ToolInvocation } from './review-policy.ts';

export type ReviewRow = RotationReview & { windowId: string; rangeKeys: string[]; createdAt: string };

export class RotationReviewService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(windowId: string, roomId: string, epochRevision: number, range: ReviewRangeItem[]): ReviewRow {
    const id = genId('rev');
    const now = new Date().toISOString();
    const rangeKeys = range.map(rawKey);
    tx(this.db, () => {
      this.db.prepare(
        `INSERT INTO rotation_reviews(id, window_id, room_id, epoch_revision, range_keys_json, status, created_at, updated_at)
         VALUES (?,?,?,?,?,'active',?,?)`,
      ).run(id, windowId, roomId, epochRevision, JSON.stringify(rangeKeys), now, now);
    });
    return { id, roomId, epochId: windowId, epochRevision, selected: range, status: 'active', rangeKeys, createdAt: now, windowId }; // F-J-31：补齐 ReviewRow 声明的 windowId（与 get() 对齐）
  }

  get(reviewId: string): ReviewRow | null {
    const row = this.db.prepare('SELECT * FROM rotation_reviews WHERE id = ?').get(reviewId) as
      | { id: string; window_id: string; room_id: string; epoch_revision: number; range_keys_json: string; status: string; decision: string | null; memory_ids_json: string | null; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id, windowId: row.window_id, roomId: row.room_id, epochId: row.window_id, epochRevision: row.epoch_revision,
      selected: [], rangeKeys: JSON.parse(row.range_keys_json) as string[], status: row.status as RotationReview['status'],
      ...(row.decision ? { decision: row.decision as 'no_new_hold' | 'holds_completed' } : {}),
      ...(row.memory_ids_json ? { memoryIds: JSON.parse(row.memory_ids_json) as string[] } : {}),
      createdAt: row.created_at,
    };
  }

  activeForWindow(windowId: string): ReviewRow | null {
    const row = this.db.prepare("SELECT id FROM rotation_reviews WHERE window_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(windowId) as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }

  /** 已完成评审覆盖过的范围键（§3.2.3；按房间——新窗继承旧窗凭证，不重复检查同内容） */
  reviewedKeysForRoom(roomId: string): string[] {
    const rows = this.db.prepare("SELECT range_keys_json FROM rotation_reviews WHERE room_id = ? AND status IN ('completed','skipped_empty')").all(roomId) as Array<{ range_keys_json: string }>;
    return rows.flatMap((r) => JSON.parse(r.range_keys_json) as string[]);
  }

  /** 同范围已完成评审的凭证复用（§4.3：候选准备失败后恢复不再次付费检查；按房间） */
  completedForRange(roomId: string, rangeKeys: string[]): ReviewRow | null {
    const canonical = JSON.stringify([...rangeKeys].sort());
    const rows = this.db.prepare("SELECT id FROM rotation_reviews WHERE room_id = ? AND status = 'completed'").all(roomId) as Array<{ id: string }>;
    for (const r of rows) {
      const row = this.get(r.id)!;
      if (JSON.stringify([...row.rangeKeys].sort()) === canonical) return row;
    }
    return null;
  }

  complete(reviewId: string, args: ReviewCompleteArgs, invocation: ToolInvocation): { ok: true; review: ReviewRow } | { ok: false; code: string } {
    const row = this.get(reviewId);
    if (!row) return { ok: false, code: 'REVIEW_NOT_FOUND' };
    // 审计 F08：核验范围=本窗口全部未决写（含普通聊天 hold、既往失败评审的遗留），不只本 review 的账本——
    // 旧 unknown 不能被新 review 的 no_new_hold 抹掉；有界恢复在核验前由调用方先行探测。
    const unresolvedWindow = this.unresolvedForWindow(row.windowId);
    if (unresolvedWindow.length > 0) return { ok: false, code: 'WRITE_UNRESOLVED' };
    const ledger = this.ledgerForReview(reviewId);
    try {
      const completed = completeReview(row, args, invocation, ledger);
      tx(this.db, () => {
        this.db.prepare("UPDATE rotation_reviews SET status = 'completed', decision = ?, memory_ids_json = ?, updated_at = ? WHERE id = ?")
          .run(completed.decision ?? null, JSON.stringify(completed.memoryIds ?? []), new Date().toISOString(), reviewId);
      });
      return { ok: true, review: this.get(reviewId)! };
    } catch (err) {
      return { ok: false, code: (err as { code?: string }).code ?? 'REVIEW_COMPLETE_FAILED' };
    }
  }

  /** F-J-40（联合审计 2026-10-06）：basis=空范围定位依据（书签/清单高水位/触发原因/
   *  凭证计数等事实）。仍为空范围——不伪称 reviewed/held 全覆盖；迁移 v14 落
   *  basis_json 列（旧库无列时静默降级为不存依据，不阻断换窗）。 */
  markSkippedEmpty(windowId: string, roomId: string, epochRevision: number, rangeKeys: string[], basis?: Record<string, unknown>): ReviewRow {
    const row = this.create(windowId, roomId, epochRevision, []);
    // 空范围记录（skipped_empty）：范围键写入以便同范围恢复复用；不叫模型（§3.2.5）
    tx(this.db, () => {
      this.db.prepare("UPDATE rotation_reviews SET range_keys_json = ?, status = 'skipped_empty', updated_at = ? WHERE id = ?")
        .run(JSON.stringify(rangeKeys), new Date().toISOString(), row.id);
      if (basis !== undefined) {
        try {
          this.db.prepare("UPDATE rotation_reviews SET basis_json = ? WHERE id = ?")
            .run(JSON.stringify(basis), row.id);
        } catch (err) {
          if ((err as { code?: string }).code !== 'ERR_SQLITE_ERROR') throw err;
        }
      }
    });
    return this.get(row.id)!;
  }

  markFailed(reviewId: string): void {
    tx(this.db, () => {
      this.db.prepare("UPDATE rotation_reviews SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'active'").run(new Date().toISOString(), reviewId);
    });
  }

  ledgerForReview(reviewId: string): SideEffectLedgerEntry[] {
    const rows = this.db.prepare('SELECT kind, state, verified, memory_id FROM tool_side_effects WHERE review_id = ?').all(reviewId) as Array<{ kind: string; state: string; verified: number; memory_id: string | null }>;
    return rows.map((r) => ({ reviewId, kind: r.kind as SideEffectLedgerEntry['kind'], state: r.state as SideEffectLedgerEntry['state'], verified: r.verified === 1, memoryId: r.memory_id }));
  }

  // —— 工具副作用账本（§3.3：完成前未决写检查的数据源）——
  openEffect(input: { reviewId: string | null; turnId: string | null; windowId: string; kind: 'hold' | 'source_bind' | 'review_complete'; operationId: string | null; toolCallId: string; seenSequence: number }): string {
    const id = genId('eff');
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db.prepare(
        `INSERT INTO tool_side_effects(id, review_id, turn_id, window_id, kind, state, verified, operation_id, tool_call_id, seen_sequence, created_at, updated_at)
         VALUES (?,?,?,?,?,'running',0,?,?,?,?,?)`,
      ).run(id, input.reviewId, input.turnId, input.windowId, input.kind, input.operationId, input.toolCallId, input.seenSequence, now, now);
    });
    return id;
  }

  settleEffect(id: string, state: 'committed' | 'failed_resolved' | 'failed_unresolved' | 'unknown' | 'cancelled', verified: boolean, memoryId: string | null): void {
    tx(this.db, () => {
      this.db.prepare('UPDATE tool_side_effects SET state = ?, verified = ?, memory_id = ?, updated_at = ? WHERE id = ?')
        .run(state, verified ? 1 : 0, memoryId, new Date().toISOString(), id);
    });
  }

  /** 回合内未决副作用（turn 收口时仍 unknown/running 的写操作——§3.3：不能被 no_new_hold 抹掉） */
  unresolvedForWindow(windowId: string): Array<{ id: string; kind: string; state: string; operationId: string | null; seenSequence: number | null }> {
    return this.db.prepare(
      "SELECT id, kind, state, operation_id AS operationId, seen_sequence AS seenSequence FROM tool_side_effects WHERE window_id = ? AND state IN ('pending','running','unknown','failed_unresolved')",
    ).all(windowId) as Array<{ id: string; kind: string; state: string; operationId: string | null; seenSequence: number | null }>;
  }

  /** 供有界恢复探测枚举 unknown 写（审计 F08：按原 operation_id 查询） */
  unknownEffectsForWindow(windowId: string): Array<{ id: string; operationId: string; seenSequence: number | null; memoryId: string | null }> {
    return this.db.prepare(
      "SELECT id, operation_id AS operationId, seen_sequence AS seenSequence, memory_id AS memoryId FROM tool_side_effects WHERE window_id = ? AND state = 'unknown' AND operation_id IS NOT NULL",
    ).all(windowId) as Array<{ id: string; operationId: string; seenSequence: number | null; memoryId: string | null }>;
  }
}
