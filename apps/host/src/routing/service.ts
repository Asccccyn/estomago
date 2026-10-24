// 路由服务 v0.3（AUD-05/06/23/36/37）：
//  - 状态拆分：只有触发票据的 attempt 是 route_owner_pending；被会话 gate 挡住的是 waiting_route_gate。
//  - 票据绑定全维度：conversation/turn/attempt/message/revision/input_hash/route_version/expiry；
//    跨 turn/跨消息/修订不符/非绑定 attempt 一律拒绝。
//  - 决议单事务（14 步）：consume+验证+（edit）revision/outbox+新 attempt+释放 waiting+durable route.resolved；
//    事件在事务内持久、提交后广播——广播失败不否定已提交事实，可按 durable 事件重放。
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
  message_id: string | null;
  input_revision: number | null;
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
  | { ok: true; row: RouteDecisionRow; editRevision: number | null; newAttemptId: string | null; turnId: string; releasedWaiting: number }
  | { ok: false; status: number; code: string; reason: string };

export type PendingTicketInput = {
  conversationId: string; turnId: string; attemptId: string;
  inputHash: string; targetModel: string | null; evidenceCode: string;
  messageId?: string | null; inputRevision?: number | null;
};

export class RoutingService {
  private db: Db;
  private events: EventService;
  private messages: MessageService;
  constructor(db: Db, events: EventService, messages: MessageService) {
    this.db = db;
    this.events = events;
    this.messages = messages;
  }

  // 事务内插入（无自开事务/无事件）——supervisor 控制序列与测试用
  createPendingInTx(o: PendingTicketInput): RouteDecisionRow {
    const id = genId('rt');
    this.db
      .prepare(
        `INSERT INTO route_decisions(id, conversation_id, turn_id, attempt_id, message_id, input_revision, input_hash, target_model, source_evidence, state, version, created_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'pending', 1, ?)`,
      )
      .run(id, o.conversationId, o.turnId, o.attemptId, o.messageId ?? null, o.inputRevision ?? null, o.inputHash, o.targetModel, o.evidenceCode, new Date().toISOString());
    return this.get(id)!;
  }

  createPending(o: PendingTicketInput): RouteDecisionRow {
    const row = this.createPendingInTx(o);
    this.events.publish('route.pending', {
      conversationId: o.conversationId, turnId: o.turnId, attemptId: o.attemptId, scope: 'private',
      payload: { decision_id: row.id, current_model: null, target_model: o.targetModel, evidence_code: o.evidenceCode, already_switched: false, affects_future_sessions: null },
    });
    return row;
  }

  // F10：SDK 结构化路由事实落账 + 可回放事件（fallback 已发生 / 拒绝未切换）。
  // 事实与票据分离：这不是待批准动作，是已发生的观测——不得呈现为事前票据
  recordSdkRouteEvent(o: {
    conversationId: string; turnId: string; attemptId: string;
    subtype: string; originalModel: string | null; actualModel: string | null;
    scope?: string | null; noticeId?: string | null; requestId?: string | null;
  }): { id: string } {
    const id = genId('sre');
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO sdk_route_events(id, conversation_id, turn_id, attempt_id, subtype, original_model, actual_model, scope, notice_id, request_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, o.conversationId, o.turnId, o.attemptId, o.subtype, o.originalModel, o.actualModel, o.scope ?? null, o.noticeId ?? null, o.requestId ?? null, new Date().toISOString());
    });
    this.events.publish('route.observed', {
      conversationId: o.conversationId, turnId: o.turnId, attemptId: o.attemptId, scope: 'private',
      payload: { subtype: o.subtype, original_model: o.originalModel, actual_model: o.actualModel, already_switched: o.actualModel !== null, evidence: 'sdk_system_notice' },
    });
    return { id };
  }

  listRouteEvents(turnId: string): Array<{ id: string; subtype: string; original_model: string | null; actual_model: string | null; created_at: string }> {
    return this.db.prepare('SELECT id, subtype, original_model, actual_model, created_at FROM sdk_route_events WHERE turn_id = ? ORDER BY created_at').all(turnId) as Array<{ id: string; subtype: string; original_model: string | null; actual_model: string | null; created_at: string }>;
  }

  get(id: string): RouteDecisionRow | null {
    return (this.db.prepare('SELECT * FROM route_decisions WHERE id = ?').get(id) as RouteDecisionRow | undefined) ?? null;
  }

  pendingForTurn(turnId: string): RouteDecisionRow | null {
    return (this.db
      .prepare("SELECT * FROM route_decisions WHERE turn_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(turnId) as RouteDecisionRow | undefined) ?? null;
  }

  pendingForConversation(conversationId: string): RouteDecisionRow | null {
    return (this.db
      .prepare("SELECT * FROM route_decisions WHERE conversation_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(conversationId) as RouteDecisionRow | undefined) ?? null;
  }

  // —— 先全量验证，后单事务执行（AUD-06/23/36/37）——
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
    if (input.choice === 'edit' && (!input.content || /^[\\s\\u00A0\\uFEFF\\u3000]*$/.test(input.content))) {
      return { ok: false, status: 400, code: 'ROUTE_INVALID_EDIT', reason: 'edit 需要非空 content' };
    }
    // 绑定验证：turn/conversation/message/attempt/revision 全链
    const turn = this.db.prepare('SELECT id, conversation_id, input_message_id FROM turns WHERE id = ?').get(row.turn_id) as
      | { id: string; conversation_id: string; input_message_id: string | null }
      | undefined;
    if (!turn) return { ok: false, status: 409, code: 'ROUTE_TURN_GONE', reason: '票据绑定的 turn 不存在' };
    if (turn.conversation_id !== row.conversation_id) return { ok: false, status: 409, code: 'ROUTE_CONV_MISMATCH', reason: 'turn 与票据会话不符' };
    if (!turn.input_message_id) return { ok: false, status: 409, code: 'ROUTE_NO_INPUT', reason: 'turn 无输入消息' };
    if (row.message_id && row.message_id !== turn.input_message_id) {
      return { ok: false, status: 409, code: 'ROUTE_MESSAGE_MISMATCH', reason: '票据绑定的消息与 turn 当前输入不符' };
    }
    const attemptRow = this.db.prepare('SELECT id, turn_id FROM attempts WHERE id = ?').get(row.attempt_id) as { id: string; turn_id: string } | undefined;
    if (!attemptRow) return { ok: false, status: 409, code: 'ROUTE_ATTEMPT_GONE', reason: '票据绑定的 attempt 不存在' };
    if (attemptRow.turn_id !== row.turn_id) return { ok: false, status: 409, code: 'ROUTE_ATTEMPT_CROSS_TURN', reason: 'attempt 不属于票据绑定的 turn（跨 turn 拒绝）' };
    const currentHash = this.messages.currentRevisionHash(turn.input_message_id);
    if (!currentHash || currentHash !== row.input_hash) {
      return { ok: false, status: 409, code: 'ROUTE_INPUT_STALE', reason: '票据绑定的输入 hash 与当前修订不符' };
    }
    const msg = this.db.prepare('SELECT current_revision FROM messages WHERE id = ?').get(turn.input_message_id) as { current_revision: number };
    if (row.input_revision != null && row.input_revision !== msg.current_revision) {
      return { ok: false, status: 409, code: 'ROUTE_REVISION_MISMATCH', reason: '票据绑定的修订不是当前有效修订' };
    }

    let editRevision: number | null = null;
    let newAttemptId: string | null = null;
    let releasedWaiting = 0;
    let resolvedEventRow: import('../events/service.ts').StreamEventRow | null = null;
    try {
      tx(this.db, () => {
        const consumed = this.db
          .prepare("UPDATE route_decisions SET state = 'consumed', choice = ?, consumed_at = ? WHERE id = ? AND state = 'pending'")
          .run(input.choice, new Date().toISOString(), decisionId);
        if (consumed.changes === 0) throw new Error('consume_conflict');
        if (input.choice === 'edit') {
          // 修订失效一致性（她 1021 执行稿 A.3）：路由 edit 与 HTTP 编辑/
          // 编辑重试同合同——新修订创建即失效旧修订的浮现作业（同事务，
          // 回滚一致）。编辑重发为新修订登记同轮作业，提交后才唤醒。
          const r = this.messages.editMessageInTx(turn.input_message_id!, input.content, { notifySurfacing: true, resubmitSurfacing: true });
          editRevision = r.revision;
        }
        if (input.choice === 'edit' || input.choice === 'approve') {
          const maxNo = this.db.prepare('SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM attempts WHERE turn_id = ?').get(row.turn_id) as { n: number };
          const revRow = this.db.prepare('SELECT current_revision FROM messages WHERE id = ?').get(turn.input_message_id) as { current_revision: number };
          newAttemptId = genId('att');
          // route-edit 的新 attempt：fresh_session=1——修订输入不 resume 旧 session（旧输入排除语义未实测，不得带旧触发重跑）
          this.db
            .prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state, fresh_session) VALUES (?,?,?,?, 'pending', ?)")
            .run(newAttemptId, row.turn_id, maxNo.n, revRow.current_revision, input.choice === 'edit' ? 1 : 0);
          this.db.prepare("UPDATE turns SET state = 'pending', completed_at = NULL WHERE id = ?").run(row.turn_id);
        }
        if (input.choice === 'cancel') {
          this.db
            .prepare("UPDATE attempts SET state = 'blocked', blocked_reason = 'ROUTE_CANCELLED', completed_at = ? WHERE id = ?")
            .run(new Date().toISOString(), row.attempt_id);
          this.db.prepare("UPDATE turns SET state = 'blocked', completed_at = ? WHERE id = ?").run(new Date().toISOString(), row.turn_id);
        }
        // 释放会话 gate 挡住的 waiting attempts（同一事务；AUD-36/37）
        releasedWaiting = Number(
          this.db
            .prepare(
              `UPDATE attempts SET state = 'pending'
               WHERE state = 'waiting_route_gate' AND turn_id IN (SELECT id FROM turns WHERE conversation_id = ?)`,
            )
            .run(row.conversation_id).changes,
        );
        // durable route.resolved：事务内持久（广播失败不丢，可重放）。
        // edit 携带修订后消息 dto——跨端按 message ID + revision 吸收（旧 revision 不覆盖新 revision）
        resolvedEventRow = this.events.persistInTx('route.resolved', {
          conversationId: row.conversation_id, turnId: row.turn_id, attemptId: row.attempt_id, scope: 'private',
          payload: {
            decision_id: decisionId, choice: input.choice, edit_revision: editRevision, new_attempt_id: newAttemptId, released_waiting: releasedWaiting,
            ...(input.choice === 'edit' && turn.input_message_id ? { message: this.messages.getMessage(turn.input_message_id) } : {}),
          },
        });
      });
    } catch (err) {
      // 她 1024 裁定③：事务内异常按真实原因分型——编辑资格拒绝/修订过期是确定性拒绝（400 系），
      // 票据状态竞态才是真并发冲突（409）。事务已回滚：票据仍 pending、无修订/attempt/事件落地。
      const msg = String((err as Error).message ?? err);
      const errCode = (err as { code?: string }).code;
      if (errCode === 'MESSAGE_ALREADY_DISPATCHED') {
        return { ok: false, status: 422, code: 'ROUTE_EDIT_REJECTED', reason: '消息已进入模型请求或回合已完成，不可再编辑' };
      }
      if (/REVISION_CONFLICT|STALE_REVISION/.test(msg)) {
        return { ok: false, status: 409, code: 'ROUTE_EDIT_REVISION_STALE', reason: '输入修订已过期（并发编辑），请刷新后重试' };
      }
      return { ok: false, status: 409, code: 'ROUTE_CONSUME_CONFLICT', reason: `并发消费冲突（事务回滚，票据仍可用）：${msg.slice(0, 80)}` };
    }
    if (editRevision !== null) this.messages.notifyAfterEditCommit();
    // 提交后广播（失败不影响已提交事实；durable 事件可重放）
    if (resolvedEventRow) this.events.dispatchRow(resolvedEventRow);
    return { ok: true, row: this.get(decisionId)!, editRevision, newAttemptId, turnId: row.turn_id, releasedWaiting };
  }
}
