// WAKE_KEEPWARM_V1（04/05/07）：会话真实活动锚点 L 与保温维护回执的持久投影。
// L = 双方最后一条真实聊天消息的**服务端正式发布时间**（owner 接受 / assistant
// 发布 / 同一 assistant 消息真正追加的新段落）。不计入：工具日志、宿主事件、
// 只回 1、typing、SSE ping、重连、已读、编辑旧正文、历史导入、system 提醒。
// 维护回执按 activity_revision CAS：新真实发布使旧回执对排程失效（05 连续续温）。
// 这是"哪个已发生事件控制当前排程"的投影，不是第二份聊天或缓存数据库——
// 缓存读写量经 request_id 联 provider_requests/usage 派生，不在此复制。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { POLICY_CONSTANTS } from '../config/policy-constants.ts';

export type ConversationActivityRow = {
  conversation_id: string;
  activity_revision: number;
  last_real_message_id: string | null;
  last_real_message_revision: number | null;
  last_real_activity_at: string | null;
  maintenance_request_id: string | null;
  maintenance_for_activity_revision: number | null;
  maintenance_window_id: string | null;
  maintenance_dispatch_started_at: string | null;
  resting: number;
  rest_decided_at: string | null;
  rest_source: RestDecision['source'] | null;
  rest_message_id: string | null;
  updated_at: string;
};

/** The owner's standing decision to pause the heartbeat until she is back.
 *  It never counts as a real message and never moves the 50-minute anchor. */
export type RestDecision =
  | { kind: 'rest' | 'resume'; source: 'owner_message'; messageId: string; atIso: string }
  | { kind: 'resume'; source: 'control'; atIso: string };

export type RestState = { resting: boolean; decided_at: string | null; source: RestDecision['source'] | null };

export class ConversationActivityService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get(conversationId: string): ConversationActivityRow | null {
    return (this.db.prepare('SELECT * FROM conversation_activity WHERE conversation_id = ?').get(conversationId) as ConversationActivityRow | undefined) ?? null;
  }

  resting(conversationId: string): boolean {
    return this.get(conversationId)?.resting === 1;
  }

  restState(conversationId: string): RestState {
    const row = this.get(conversationId);
    return { resting: row?.resting === 1, decided_at: row?.rest_decided_at ?? null, source: row?.rest_source ?? null };
  }

  /** Call inside the transaction that accepts the owner's input or the control
   *  operation. Repeating the current decision changes nothing. */
  noteRestDecision(conversationId: string, decision: RestDecision): boolean {
    if (decision.kind === 'rest') {
      return Number(this.db.prepare(`
        INSERT INTO conversation_activity(conversation_id, resting, rest_decided_at, rest_source, rest_message_id, updated_at)
        VALUES (?, 1, ?, 'owner_message', ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET resting = 1, rest_decided_at = excluded.rest_decided_at,
          rest_source = 'owner_message', rest_message_id = excluded.rest_message_id
        WHERE conversation_activity.resting = 0
      `).run(conversationId, decision.atIso, decision.messageId, decision.atIso).changes) === 1;
    }
    return Number(this.db.prepare(`
      UPDATE conversation_activity SET resting = 0, rest_decided_at = ?, rest_source = ?, rest_message_id = NULL
      WHERE conversation_id = ? AND resting = 1
    `).run(decision.atIso, decision.source, conversationId).changes) === 1;
  }

  /** An explicit resume from the management page. The same operation key returns
   *  its first result; the heartbeat's own switch and schedule are not touched. */
  resumeRest(conversationId: string, operation: { actorId: string; operationId: string }): RestState & { changed: boolean; duplicate: boolean } {
    return tx(this.db, () => {
      const prior = this.db.prepare(`
        SELECT response_json FROM background_operations
        WHERE actor_id = ? AND conversation_id = ? AND action = 'heartbeat_resume' AND operation_id = ?
      `).get(operation.actorId, conversationId, operation.operationId) as { response_json: string } | undefined;
      if (prior) return { ...JSON.parse(prior.response_json) as RestState & { changed: boolean }, duplicate: true };
      const changed = this.noteRestDecision(conversationId, { kind: 'resume', source: 'control', atIso: new Date().toISOString() });
      const response = { ...this.restState(conversationId), changed };
      this.db.prepare(`
        INSERT INTO background_operations(actor_id, conversation_id, action, operation_id, request_hash, response_json, created_at)
        VALUES (?, ?, 'heartbeat_resume', ?, 'resume', ?, ?)
      `).run(operation.actorId, conversationId, operation.operationId, JSON.stringify(response), new Date().toISOString());
      return { ...response, duplicate: false };
    });
  }

  /** 真实发布（发布事务内调用，不加自有事务）。幂等回执路径（dup 命中）不会走到这里。 */
  noteRealPublication(conversationId: string, messageId: string, revision: number, atIso: string): void {
    this.db.prepare(
      `INSERT INTO conversation_activity(conversation_id, activity_revision, last_real_message_id, last_real_message_revision, last_real_activity_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         activity_revision = activity_revision + 1,
         last_real_message_id = excluded.last_real_message_id,
         last_real_message_revision = excluded.last_real_message_revision,
         last_real_activity_at = excluded.last_real_activity_at,
         maintenance_request_id = NULL,
         maintenance_for_activity_revision = NULL,
         maintenance_window_id = NULL,
         maintenance_dispatch_started_at = NULL,
         updated_at = excluded.updated_at`,
    ).run(conversationId, messageId, revision, atIso, atIso);
  }

  /**
   * 维护回执 CAS：仅当会话活动版本仍是领取时捕获的 revision 时写入。
   * 迟到的保温 usage（真实消息已把活动推进到新 revision）不得替新活动改维护目标（K-10）。
   * 返回 false = 活动已前进，回执如实落空（账已在 dispatch 表保留）。
   */
  noteMaintenanceReceipt(input: { conversationId: string; capturedActivityRevision: number; requestId: string; windowId: string; dispatchStartedAtIso: string }): boolean {
    const r = this.db.prepare(
      `UPDATE conversation_activity SET
         maintenance_request_id = ?, maintenance_for_activity_revision = ?,
         maintenance_window_id = ?, maintenance_dispatch_started_at = ?, updated_at = ?
       WHERE conversation_id = ? AND activity_revision = ?
         AND (maintenance_dispatch_started_at IS NULL OR maintenance_for_activity_revision != ?
              OR julianday(maintenance_dispatch_started_at) <= julianday(?))`,
    ).run(input.requestId, input.capturedActivityRevision, input.windowId, input.dispatchStartedAtIso, input.dispatchStartedAtIso, input.conversationId, input.capturedActivityRevision, input.capturedActivityRevision, input.dispatchStartedAtIso);
    return Number(r.changes) === 1;
  }

  /** 05 保温目标：有效维护回执→其 dispatch+50 分（技术续温）；否则 L+50 分（真实消息）。
   *  回执有效性含同窗条件——切窗后旧回执不构成新窗缓存已热的证据（K-16）。 */
  nextKeepwarmTarget(input: { conversationId: string; windowId: string; cacheTtlMs?: number }): { scheduled: true; dueAtMs: number; basis: 'real_message' | 'maintenance'; activityRevision: number } | { scheduled: false; reason: 'NO_REAL_ACTIVITY' } {
    const row = this.get(input.conversationId);
    if (!row || row.last_real_activity_at === null) return { scheduled: false, reason: 'NO_REAL_ACTIVITY' };
    const L = Date.parse(row.last_real_activity_at);
    const validReceipt = row.maintenance_request_id !== null
      && row.maintenance_for_activity_revision === row.activity_revision
      && row.maintenance_window_id === input.windowId
      && row.maintenance_dispatch_started_at !== null
      && Date.parse(row.maintenance_dispatch_started_at) >= L;
    if (validReceipt) {
      return { scheduled: true, dueAtMs: Date.parse(row.maintenance_dispatch_started_at!) + POLICY_CONSTANTS.background.keepwarm.idle_after_cache_ms, basis: 'maintenance', activityRevision: row.activity_revision };
    }
    return { scheduled: true, dueAtMs: L + POLICY_CONSTANTS.background.keepwarm.idle_after_cache_ms, basis: 'real_message', activityRevision: row.activity_revision };
  }
}
