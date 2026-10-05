// 成功书签（§3.1 + 生命周期包 §7.3）：每窗口一条，仅真实已核实的主模型 hold 收据推进。
// 语义在 context/review-policy.ts advanceBookmark（移植自规范参考实现）——本文件只做持久化与查询。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { advanceBookmark, type Bookmark, type HoldReceipt, type HoldRequest } from '../context/review-policy.ts';

export type CheckpointRow = Bookmark & { windowId: string; operationId: string };

export class HoldCheckpointService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  forWindow(windowId: string): CheckpointRow | null {
    const row = this.db.prepare('SELECT * FROM hold_checkpoints WHERE window_id = ?').get(windowId) as
      | { window_id: string; room_id: string; epoch_id: string; seen_sequence: number; request_id: string; receipt_id: string; memory_id: string; operation_id: string }
      | undefined;
    if (!row) return null;
    return { windowId: row.window_id, roomId: row.room_id, epochId: row.epoch_id, seenSequence: row.seen_sequence, requestId: row.request_id, receiptId: row.receipt_id, memoryId: row.memory_id, operationId: row.operation_id };
  }

  /** 推进（幂等/不倒退/旧窗收据拒绝——全部由 advanceBookmark 契约保证；冲突原样抛出） */
  advance(windowId: string, request: HoldRequest, receipt: HoldReceipt): CheckpointRow {
    const existing = this.forWindow(windowId);
    const next = advanceBookmark(existing, request, receipt);
    if (existing !== null && next === existing) return next; // 重放/不倒退：无写入
    tx(this.db, () => {
      this.db.prepare(
        `INSERT INTO hold_checkpoints(window_id, room_id, epoch_id, seen_sequence, request_id, receipt_id, memory_id, operation_id, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(window_id) DO UPDATE SET seen_sequence = excluded.seen_sequence, request_id = excluded.request_id,
           receipt_id = excluded.receipt_id, memory_id = excluded.memory_id, operation_id = excluded.operation_id, updated_at = excluded.updated_at`,
      ).run(windowId, next.roomId, next.epochId, next.seenSequence, next.requestId, next.receiptId, next.memoryId, (receipt as HoldReceipt & { operationId?: string }).operationId ?? '', new Date().toISOString());
    });
    return { ...next, windowId };
  }
}
