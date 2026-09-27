// 路由决定（01 §10）：票据绑定 owner/conversation/turn/attempt/输入 hash；
// 多端只有一次有效动作（原子消费）；重启后仍 pending；关弹窗/离线不算同意。
import type { Db } from '../db/connection.ts';
import type { EventService } from '../events/service.ts';
import { genId } from '../util/id.ts';

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

export class RoutingService {
  private db: Db;
  private events: EventService;
  constructor(db: Db, events: EventService) {
    this.db = db;
    this.events = events;
  }

  createPending(o: {
    conversationId: string;
    turnId: string;
    attemptId: string;
    inputHash: string;
    targetModel: string | null;
    evidence: string;
  }): RouteDecisionRow {
    const id = genId('rt');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO route_decisions(id, conversation_id, turn_id, attempt_id, input_hash, target_model, source_evidence, state, created_at)
         VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
      )
      .run(id, o.conversationId, o.turnId, o.attemptId, o.inputHash, o.targetModel, o.evidence, now);
    const row = this.get(id)!;
    this.events.publish('route.pending', {
      conversationId: o.conversationId,
      turnId: o.turnId,
      attemptId: o.attemptId,
      scope: 'private',
      payload: {
        decision_id: id,
        current_model: null, // 现场模型未知即 null，不编造
        target_model: o.targetModel,
        evidence: o.evidence,
        already_switched: false,
        affects_future_sessions: null, // 未知范围如实为 null
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

  // 原子一次消费：UPDATE ... WHERE state='pending' 保证多端重复点击只有一个成功
  consume(id: string, choice: 'approve' | 'edit' | 'cancel'): { ok: true; row: RouteDecisionRow } | { ok: false; reason: string } {
    const now = new Date().toISOString();
    const res = this.db.prepare("UPDATE route_decisions SET state = 'consumed', choice = ?, consumed_at = ? WHERE id = ? AND state = 'pending'").run(choice, now, id);
    if (res.changes === 0) {
      const cur = this.get(id);
      return { ok: false, reason: cur ? `票据已 ${cur.state}${cur.choice ? `(${cur.choice})` : ''}，不能重复生效` : '票据不存在' };
    }
    const row = this.get(id)!;
    this.events.publish('route.resolved', {
      conversationId: row.conversation_id,
      turnId: row.turn_id,
      attemptId: row.attempt_id,
      scope: 'private',
      payload: { decision_id: id, choice },
    });
    return { ok: true, row };
  }
}
