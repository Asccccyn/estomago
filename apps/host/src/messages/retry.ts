// Explicit retry of an unanswered latest input. No history rewrite or window rotation.
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId, sha256Hex } from '../util/id.ts';
import { normalizeNewlines, isBlankContent, type MessageDto, type MessageReplyStatusDto } from '../../../../packages/contracts/src/api.ts';
import type { MessageService } from './service.ts';
import { MESSAGE_FROZEN_SQL } from './mutation.ts';

export class MessageRetryError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const reasons: Record<string, string> = {
  RETRY_NOT_OWNER: '只有你的消息可以重试。',
  RETRY_NO_TURN: '这条消息没有可重试的回复记录。',
  RETRY_NOT_FAILED: '这条消息当前不在失败或受阻状态。',
  RETRY_NOT_LATEST: '这条消息后已有新的消息，不能原位重发旧对话。',
  RETRY_CONVERSATION_BUSY: '当前对话仍在处理消息，请等本轮结束后重试。',
  RETRY_ROUTE_PENDING: '请先处理当前待确认的路由选择。',
  RETRY_HAS_REPLY: '这轮已产生回复，暂不支持从这里重新生成。',
  RETRY_HAS_TOOL_ACTIVITY: '这轮已进入工具处理，需先核对执行结果，不能直接重发。',
  RETRY_RESPONSE_STARTED: '这轮已收到上游响应，暂不支持直接重发，请先核对执行结果。',
  RETRY_CONTEXT_CHANGED: '原来的对话窗口已变化，不能把旧消息重发到新窗口。',
  RETRY_CONTEXT_UNAVAILABLE: '当前没有可安全复用的对话上下文。',
  RETRY_INPUT_IN_HISTORY: '这条消息已进入后续对话历史，暂不支持从这里重新生成。',
  RETRY_DRIVER_UNSUPPORTED: '当前模型通道暂不支持原位重发。',
};

type StatusRow = {
  id: string; state: string | null; turn_id: string | null; attempt_id: string | null;
  attempt_state: string | null; window_id: string | null; active_window_id: string | null;
  window_status: string | null; latest: number; busy: number; route_pending: number;
  has_reply: number; has_tool_activity: number; response_started: number; other_window: number; mutation_frozen: number;
};

export class MessageRetryService {
  private db: Db;
  private messages: MessageService;
  private driver: string;
  constructor(db: Db, messages: MessageService, driver: string) { this.db = db; this.messages = messages; this.driver = driver; }

  /** One batched SQL projection for a page; no client-side per-message status requests. */
  decorate(messages: MessageDto[]): MessageDto[] {
    const owners = messages.filter(m => m.speaker === 'owner');
    if (!owners.length) return messages;
    const rows = this.db.prepare(`
      SELECT m.id, t.id AS turn_id, t.state, a.id AS attempt_id, a.state AS attempt_state,
        a.window_id, c.active_window_id, w.status AS window_status,
        ${MESSAGE_FROZEN_SQL} AS mutation_frozen,
        NOT EXISTS(SELECT 1 FROM messages newer WHERE newer.conversation_id=m.conversation_id AND newer.sequence>m.sequence) AS latest,
        EXISTS(SELECT 1 FROM turns busy WHERE busy.conversation_id=m.conversation_id AND busy.state IN ('pending','running','route_owner_pending')) AS busy,
        EXISTS(SELECT 1 FROM route_decisions rd WHERE rd.conversation_id=m.conversation_id AND rd.state='pending') AS route_pending,
        EXISTS(SELECT 1 FROM messages reply WHERE reply.turn_id=t.id AND reply.speaker='assistant') AS has_reply,
        EXISTS(SELECT 1 FROM provider_requests p WHERE p.turn_id=t.id AND p.purpose='chat' AND (p.sent_at IS NOT NULL OR p.generation_id IS NOT NULL OR p.outcome='completed')) AS response_started,
        (EXISTS(SELECT 1 FROM tool_side_effects e WHERE e.turn_id=t.id)
          OR EXISTS(SELECT 1 FROM runtime_stream_events e WHERE e.turn_id=t.id AND e.kind IN ('tool.status','turn.tool'))) AS has_tool_activity,
        EXISTS(SELECT 1 FROM provider_requests p WHERE p.turn_id=t.id AND p.window_id IS NOT c.active_window_id) AS other_window
      FROM messages m
      LEFT JOIN turns t ON t.id=m.turn_id AND t.input_message_id=m.id
      LEFT JOIN attempts a ON a.id=(SELECT last.id FROM attempts last WHERE last.turn_id=t.id ORDER BY last.attempt_no DESC LIMIT 1)
      JOIN conversations c ON c.id=m.conversation_id
      LEFT JOIN windows w ON w.id=c.active_window_id
      WHERE m.id IN (${owners.map(() => '?').join(',')})
    `).all(...owners.map(m => m.id)) as StatusRow[];
    const byId = new Map(rows.map(row => [row.id, row]));
    const manifests = new Map<string, Set<string> | null>();
    return messages.map(message => {
      if (message.speaker !== 'owner') return message;
      const row = byId.get(message.id);
      let reason: string | null = null;
      if (!row?.turn_id || !row.attempt_id) reason = 'RETRY_NO_TURN';
      else if (!['failed', 'blocked'].includes(row.state ?? '') || !['failed', 'blocked'].includes(row.attempt_state ?? '')) reason = 'RETRY_NOT_FAILED';
      else if (row.has_reply) reason = 'RETRY_HAS_REPLY';
      else if (!row.latest) reason = 'RETRY_NOT_LATEST';
      else if (row.route_pending) reason = 'RETRY_ROUTE_PENDING';
      else if (row.busy) reason = 'RETRY_CONVERSATION_BUSY';
      else if (row.has_tool_activity) reason = 'RETRY_HAS_TOOL_ACTIVITY';
      else if (row.response_started) reason = 'RETRY_RESPONSE_STARTED';
      else if (!['openrouter', 'deepseek', 'mock'].includes(this.driver)) reason = 'RETRY_DRIVER_UNSUPPORTED';
      else if (!row.active_window_id || row.window_status !== 'ACTIVE') reason = 'RETRY_CONTEXT_UNAVAILABLE';
      else if (row.other_window || (row.window_id && row.window_id !== row.active_window_id)) reason = 'RETRY_CONTEXT_CHANGED';
      else {
        if (!manifests.has(row.active_window_id)) {
          const trajectory = this.db.prepare('SELECT manifest_json FROM window_trajectories WHERE window_id=?').get(row.active_window_id) as { manifest_json: string | null } | undefined;
          let ids: Set<string> | null = null;
          try {
            const manifest: unknown = JSON.parse(trajectory?.manifest_json ?? 'null');
            if (Array.isArray(manifest) && manifest.every(entry => entry && typeof entry.id === 'string')) ids = new Set(manifest.filter(entry => entry.pending_dispatch !== true).map(entry => entry.id));
          } catch { /* Unknown historical evidence cannot authorize a replay. */ }
          manifests.set(row.active_window_id, ids);
        }
        const manifest = manifests.get(row.active_window_id);
        if (!manifest) reason = 'RETRY_CONTEXT_UNAVAILABLE';
        else if (manifest.has(message.id)) reason = 'RETRY_INPUT_IN_HISTORY';
      }
      const reply_status: MessageReplyStatusDto = {
        state: row?.state ?? 'unknown', can_retry: reason === null, reason,
        turn_id: row?.turn_id ?? message.turn_id, attempt_id: row?.attempt_id ?? null,
      };
      const frozen = !row || Boolean(row.mutation_frozen);
      return { ...message, reply_status, mutation_status: { can_edit: !frozen, can_withdraw: !frozen, reason: frozen ? 'MESSAGE_ALREADY_DISPATCHED' : null } };
    });
  }

  retry(input: { conversationId: string; messageId: string; content: string; expectedRevision: number; operationKey: string; tokenEstimateJson?: string | null }): { message: MessageDto; turn_id: string; attempt_id: string; duplicate: boolean } {
    const content = normalizeNewlines(input.content);
    const requestHash = sha256Hex(JSON.stringify({ content, expected_revision: input.expectedRevision }));
    let edited = false;
    const result = tx(this.db, () => {
      const current = this.messages.getMessage(input.messageId);
      if (!current || current.conversation_id !== input.conversationId) throw new MessageRetryError(404, 'not_found', '消息不存在或不属于该房间。');
      if (current.speaker !== 'owner') throw new MessageRetryError(403, 'RETRY_NOT_OWNER', reasons.RETRY_NOT_OWNER!);
      // Authorization/resource binding precedes receipts; receipt replay precedes revision/state checks.
      const receipt = this.db.prepare('SELECT request_hash, turn_id, attempt_id FROM message_retry_receipts WHERE conversation_id=? AND message_id=? AND operation_key=?')
        .get(input.conversationId, input.messageId, input.operationKey) as { request_hash: string; turn_id: string; attempt_id: string } | undefined;
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new MessageRetryError(409, 'idempotency_conflict', '同一次重试的内容或修订已变化，请重新发起操作。');
        return { turn_id: receipt.turn_id, attempt_id: receipt.attempt_id, duplicate: true };
      }
      if (current.current_revision !== input.expectedRevision) throw new MessageRetryError(409, 'revision_conflict', '消息已在其他页面更新，请核对最新内容后重新编辑。');
      const status = this.decorate([current])[0]!.reply_status!;
      if (!status.can_retry) throw new MessageRetryError(409, status.reason!, reasons[status.reason!] ?? '当前不能重试这条消息。');
      if (isBlankContent(content) && current.revision.attachments.length === 0) throw new MessageRetryError(422, 'blank_content', '正文仅空白且无附件，拒绝重发。');
      let revision = current.current_revision;
      if (content !== current.revision.content) {
        // The existing text-edit contract keeps all original attachment bindings.
        revision = this.messages.editMessageInTx(current.id, content, { source: 'client_edit_retry', resubmitSurfacing: true, tokenEstimateJson: input.tokenEstimateJson, notifySurfacing: true, allowBlankWithAttachments: true }).revision;
        edited = true;
      } else if (revision > 1) {
        // A prior "save only" edit has no job. Explicit retry may register it,
        // while the revision's unique key preserves existing work and deadline.
        this.messages.registerResubmittedRevisionInTx(current.id);
        edited = true;
      }
      const turnId = status.turn_id!;
      const attemptId = genId('att');
      const next = this.db.prepare('SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM attempts WHERE turn_id=?').get(turnId) as { n: number };
      const window = this.db.prepare('SELECT active_window_id FROM conversations WHERE id=?').get(input.conversationId) as { active_window_id: string };
      this.db.prepare("INSERT INTO attempts(id,turn_id,attempt_no,input_revision,input_hash,state,retry_window_id) VALUES (?,?,?,?,?,'pending',?)")
        .run(attemptId, turnId, next.n, revision, sha256Hex(content), window.active_window_id);
      this.db.prepare("UPDATE turns SET state='pending', completed_at=NULL WHERE id=?").run(turnId);
      this.db.prepare('INSERT INTO message_retry_receipts(conversation_id,message_id,operation_key,request_hash,turn_id,attempt_id,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.conversationId, current.id, input.operationKey, requestHash, turnId, attemptId, new Date().toISOString());
      return { turn_id: turnId, attempt_id: attemptId, duplicate: false };
    });
    if (edited) this.messages.notifyAfterEditCommit();
    // Current status is returned even when replaying a receipt after the attempt completed.
    return { message: this.decorate([this.messages.getMessage(input.messageId)!])[0]!, ...result };
  }
}
