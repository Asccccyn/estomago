// R06（审计 FE-11）：权威恢复快照——单一一致性边界。
// SSE 事件史可能被裁剪/进程重启丢失，恢复不得依赖"完整保留事件"；
// 本端点在同一读事务内返回：最新消息页 + 活动 turn（含 attempts 与
// provider generations）+ 活动窗 + 事件游标。GET 严格只读：零模型调用、
// 零派发、零消息写入；前端以 cursor 对齐 SSE 重放边界后接 live。
import { tx } from '../db/connection.ts';

export type ConversationSnapshotDeps = {
  db: import('../db/connection.ts').Db;
  messages: {
    listMessages(opts: {
      conversationId: string; afterSequence?: number; beforeSequence?: number;
      limit?: number; latest?: boolean;
    }): unknown[];
  };
  windows: { activeWindow(conversationId: string): { id: string; status: string } | null };
  events: { maxSequence(): number };
};

type TurnRow = {
  id: string; state: string; trigger: string; input_message_id: string | null;
  generation: number; started_at: string | null; completed_at: string | null;
};

export function conversationSnapshot(d: ConversationSnapshotDeps, conversationId: string, limit = 100) {
  return tx(d.db, () => {
    const messages = d.messages.listMessages({ conversationId, limit, latest: true });
    const activeTurn = d.db.prepare(
      `SELECT id, state, trigger, input_message_id, generation, started_at, completed_at
       FROM turns WHERE conversation_id=? AND state IN ('pending','running','route_owner_pending')
       ORDER BY created_at DESC LIMIT 1`,
    ).get(conversationId) as TurnRow | undefined;
    let active_turn: Record<string, unknown> | null = null;
    if (activeTurn) {
      const attempts = d.db.prepare(
        `SELECT id, attempt_no, state, blocked_reason, window_id, started_at, completed_at
         FROM attempts WHERE turn_id=? ORDER BY attempt_no`,
      ).all(activeTurn.id);
      const generations = d.db.prepare(
        `SELECT id, purpose, outcome, attempt_id, generation_id, attempt_no, created_at
         FROM provider_requests WHERE turn_id=? ORDER BY created_at`,
      ).all(activeTurn.id);
      active_turn = {
        id: activeTurn.id,
        state: activeTurn.state,
        trigger: activeTurn.trigger,
        input_message_id: activeTurn.input_message_id,
        turn_generation: activeTurn.generation,
        started_at: activeTurn.started_at,
        completed_at: activeTurn.completed_at,
        attempts,
        generations,
      };
    }
    const activeWindow = d.windows.activeWindow(conversationId);
    return {
      conversation_id: conversationId,
      cursor: d.events.maxSequence(),
      messages,
      active_turn,
      active_window: activeWindow ? { id: activeWindow.id, status: activeWindow.status } : null,
    };
  });
}
