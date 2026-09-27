// 路由服务 v0.2.2（AUD-05/06/23 修复版）：
//  - validateAndConsume：先完整验证（存在/pending/未过期/会话/turn/attempt/输入hash/载荷），
//    全部合法后在同一事务里 consume+（edit 时）revision+supersedes+outbox+新 attempt+turn 复位。
//    任何失败：回滚，票据保持可用。
//  - pendingForConversation：会话级 gate（AUD-05）。
//  - 过期票据在验证时标记 expired 并拒绝。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import type { EventService } from '../events/service.ts';
import type { MessageService } from '../messages/service.ts';

export type RouteDecisionRow = {
  id: string;
  conversation_id: string;
  turn_id: string;
  attempt_id: string;
  input_hash: string;
  target_model: string | null;
  source_evidence: string;
  state: 'pending' | 'consumed' | 'expired' | 'superseded';
  choice: 'approve' | 'edit' | 'cancel' | null;
  consumed_at: string | null;
  version: number;
  expires_at: string | null;
  created_at: string;
};

export type ConsumeInput =
  | { choice: 'approve' }
  | { choice: 'cancel' }
  | { choice: 'edit'; content: string };

export type ConsumeResult =
  | { ok: true; row: RouteDecisionRow; editRevision: number | null; newAttemptId: string | null; turnId: string }
  | { ok: false; status: number; code: string; reason: string };

export class RoutingService {
  private db: Db;
  private events: EventService;
  private messages: MessageService;
  constructor(db: Db, events: EventService, messages: MessageService) {
    this.db = db;
    this.events = events;
    this.messages = messages;
  }

  // 事务内插入（不自开事务、不发事件）——供 supervisor 的单事务控制序列使用
  createPendingInTx(o: { conversationId: string; turnId: string; attemptId: string; inputHash: string; targetModel: string | null; evidenceCode: string }): RouteDecisionRow {
    const id = genId('rt');
    this.db
      .prepare(
        `INSERT INTO route_decisions(id, conversation_id, turn_id, attempt_id, input_hash, target_model, source_evidence, state, created_at)
         VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
      )
      .run(id, o.conversationId, o.turnId, o.attemptId, o.inputHash, o.targetModel, o.evidenceCode, new Date().toISOString());
    return this.get(id)!;
  }

  createPending(o: { conversationId: string; turnId: string; attemptId: string; inputHash: string; targetModel: string | null; evidenceCode: string }): RouteDecisionRow {
    const id = genId('rt');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO route_decisions(id, conversation_id, turn_id, attempt_id, input_hash, target_model, source_evidence, state, created_at)
         VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
      )
      .run(id, o.conversationId, o.turnId, o.attemptId, o.inputHash, o.targetModel, o.evidenceCode, now);
    const row = this.get(id)!;
    this.events.publish('route.pending', {
      conversationId: o.conversationId, turnId: o.turnId, attemptId: o.attemptId, scope: 'private',
      payload: {
        decision_id: id,
        current_model: null,
        target_model: o.targetModel,
        evidence_code: o.evidenceCode, // 稳定码，不含 SDK 原文（AUD-28）
        already_switched: false,
        affects_future_sessions: null,
      },
    });
    return row;
  }

  get(id: string): RouteDecisionRow | null {
    return (this.db.prepare('SELECT * FROM route_decisions WHERE id = ?').get(id) as RouteDecisionRow | undefined) ?? null;
  }

  pendingForTurn(turnId: string): RouteDecisionRow | null {
    return (this.db
      .prepare("SELECT * FROM route_decisions WHERE turn_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(turnId) as RouteDecisionRow | undefined) ?? null;
  }

  // 会话级待决（AUD-05）：房间内任一 pending 票据都冻结新模型执行
  pendingForConversation(conversationId: string): RouteDecisionRow | null {
    return (this.db
      .prepare("SELECT * FROM route_decisions WHERE conversation_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(conversationId) as RouteDecisionRow | undefined) ?? null;
  }

  // 先验证后事务消费（AUD-06/23）
  validateAndConsume(decisionId: string, input: ConsumeInput): ConsumeResult {
    const row = this.get(decisionId);
    if (!row) return { ok: false, status: 404, code: 'ROUTE_NOT_FOUND', reason: '票据不存在' };
    if (row.state !== 'pending') return { ok: false, status: 409, code: 'ROUTE_ALREADY_RESOLVED', reason: `票据已 ${row.state}${row.choice ? `(${row.choice})` : ''}` };
    const now = new Date();
    if (row.expires_at && new Date(row.expires_at).getTime() < now.getTime()) {
      tx(this.db, () => {
        this.db.prepare("UPDATE route_decisions SET state = 'expired' WHERE id = ? AND state = 'pending'").run(decisionId);
      });
      return { ok: false, status: 409, code: 'ROUTE_EXPIRED', reason: '票据已过期并标记 expired' };
    }
    // 载荷验证（edit 必须带非空正文；校验发生在任何状态变更之前）
    if (input.choice === 'edit' && (!input.content || /^[\s\u00A0\uFEFF\u3000]*$/.test(input.content))) {
      return { ok: false, status: 400, code: 'ROUTE_INVALID_EDIT', reason: 'edit 需要非空 content' };
    }
    // 输入 hash 绑定：票据必须仍对应当前有效输入修订
    const turn = this.db.prepare('SELECT input_message_id FROM turns WHERE id = ?').get(row.turn_id) as { input_message_id: string | null } | undefined;
    if (!turn?.input_message_id) return { ok: false, status: 409, code: 'ROUTE_NO_INPUT', reason: 'turn 无输入消息' };
    const currentHash = this.messages.currentRevisionHash(turn.input_message_id);
    if (!currentHash || currentHash !== row.input_hash) {
      return { ok: false, status: 409, code: 'ROUTE_INPUT_STALE', reason: '票据绑定的输入 hash 与当前修订不符（票据作废前需重新确认）' };
    }
    // attempt 存在性
    const attempt = this.db.prepare('SELECT id FROM attempts WHERE id = ?').get(row.attempt_id) as { id: string } | undefined;
    if (!attempt) return { ok: false, status: 409, code: 'ROUTE_ATTEMPT_GONE', reason: '票据绑定的 attempt 不存在' };

    // —— 全部验证通过：单事务 consume + 动作 ——
    try {
      const result = tx(this.db, () => {
        const consumed = this.db
          .prepare("UPDATE route_decisions SET state = 'consumed', choice = ?, consumed_at = ? WHERE id = ? AND state = 'pending'")
          .run(input.choice, new Date().toISOString(), decisionId);
        if (consumed.changes === 0) throw new Error('consume_conflict');
        let editRevision: number | null = null;
        let newAttemptId: string | null = null;
        if (input.choice === 'edit') {
          // 真修订：原 message_id 不变，revision+1，supersedes，归档 outbox（AUD-07）
          const r = this.messages.editMessageInTx(turn.input_message_id!, input.content);
          editRevision = r.revision;
        }
        if (input.choice === 'edit' || input.choice === 'approve') {
          // 新 attempt：edit 用新修订；approve 用原修订（continue 能力 unknown，如实重跑本输入）
          const maxNo = this.db.prepare('SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM attempts WHERE turn_id = ?').get(row.turn_id) as { n: number };
          const revRow = this.db.prepare('SELECT current_revision FROM messages WHERE id = ?').get(turn.input_message_id) as { current_revision: number };
          newAttemptId = genId('att');
          this.db
            .prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,?,?, 'pending')")
            .run(newAttemptId, row.turn_id, maxNo.n, revRow.current_revision);
          this.db.prepare("UPDATE turns SET state = 'pending', completed_at = NULL WHERE id = ?").run(row.turn_id);
        }
        if (input.choice === 'cancel') {
          this.db
            .prepare("UPDATE attempts SET state = 'blocked', blocked_reason = 'ROUTE_CANCELLED', completed_at = ? WHERE id = ?")
            .run(new Date().toISOString(), row.attempt_id);
          this.db.prepare("UPDATE turns SET state = 'blocked', completed_at = ? WHERE id = ?").run(new Date().toISOString(), row.turn_id);
        }
        return { editRevision, newAttemptId };
      });
      this.events.publish('route.resolved', {
        conversationId: row.conversation_id, turnId: row.turn_id, attemptId: row.attempt_id, scope: 'private',
        payload: { decision_id: decisionId, choice: input.choice, edit_revision: result.editRevision, new_attempt_id: result.newAttemptId },
      });
      return { ok: true, row: this.get(decisionId)!, editRevision: result.editRevision, newAttemptId: result.newAttemptId, turnId: row.turn_id };
    } catch {
      return { ok: false, status: 409, code: 'ROUTE_CONSUME_CONFLICT', reason: '并发消费冲突（事务回滚，票据仍可用）' };
    }
  }
}
