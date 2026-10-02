// 消息服务 v0.2.2（AUD-15 修复版）：用户输入持久事务。
// submitUserMessageWithTurn：同一事务内完成 message+revision+sequence+输入归档 outbox+
// turn+attempt+turn_id 回填+幂等判定；commit 后才进 executor 队列。
// 幂等自愈：同 key 重试不只查 message，还校验并补齐缺失 side effects（turn/attempt/outbox）。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId, sha256Hex } from '../util/id.ts';
import { isBlankContent, normalizeNewlines, type MessageDto, type MessageKind } from '../../../../packages/contracts/src/api.ts';
import { validateAbsoluteIso } from '../util/time.ts';

export type SubmitResult = { message: MessageDto; duplicate: boolean };
export type SubmitWithTurnResult = SubmitResult & { turnId: string; attemptId: string; repaired: boolean };

export class BlankMessageError extends Error {}

export class MessageService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  ensureConversation(conversationId: string, title: string | null = null): void {
    const exists = this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId);
    if (!exists) {
      tx(this.db, () => {
        this.db
          .prepare('INSERT INTO conversations(id, owner_service, scope, title, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(conversationId, 'estomago', 'private', title, new Date().toISOString());
        this.db.prepare('INSERT INTO members(conversation_id, participant_id, role) VALUES (?, ?, ?)').run(conversationId, 'owner', 'owner');
      });
    }
  }

  // —— 用户输入 + turn 原子事务（AUD-15 核心）——
  submitUserMessageWithTurn(opts: {
    conversationId: string;
    content: string;
    clientMessageId: string;
    occurredAt?: string | null;
    kind?: MessageKind;
  }): SubmitWithTurnResult {
    const content = normalizeNewlines(opts.content);
    if (isBlankContent(content)) throw new BlankMessageError('正文仅空白且无附件，拒绝发送（不 trim 重写用户正文）');
    this.ensureConversation(opts.conversationId);
    const nowIso = new Date().toISOString();
    // F14：occurred_at 必须是逐项日历校验通过的带时区 ISO 8601 绝对时间字符串或 null
    // （拒绝数字/空串/无时区/2月30日/99月——Date.parse 的宽松归一化不作依据）
    let occurredAt = opts.occurredAt ?? nowIso;
    if (opts.occurredAt !== null && opts.occurredAt !== undefined && opts.occurredAt !== '') {
      const v = validateAbsoluteIso(opts.occurredAt);
      if (!v.ok) {
        throw new Error(`INVALID_OCCURRED_AT: 客户端时间必须是带时区的合法 ISO 8601 日历日期（拒绝原因 ${v.reason}；收到 "${String(opts.occurredAt).slice(0, 30)}"）`);
      }
      occurredAt = v.iso; // 有效值保持原字符串（不重新序列化——避免精度/格式变化影响排序）
    }

    return tx(this.db, () => {
      const dup = this.db
        .prepare('SELECT id FROM messages WHERE conversation_id = ? AND client_message_id = ?')
        .get(opts.conversationId, opts.clientMessageId) as { id: string } | undefined;
      if (dup) {
        // 幂等自愈：校验整套 side effects，缺什么补什么（同一事务）
        let repaired = false;
        const outbox = this.db
          .prepare('SELECT 1 FROM outbox WHERE target = ? AND operation_key = ?')
          .get('mariposa.archive', `archive:${dup.id}:1`);
        if (!outbox) {
          this.insertOutbox(`archive:${dup.id}:1`, { message_id: dup.id }, nowIso);
          repaired = true;
        }
        let turn = this.db.prepare('SELECT id FROM turns WHERE input_message_id = ? ORDER BY created_at DESC LIMIT 1').get(dup.id) as { id: string } | undefined;
        if (turn) {
          const attempt = this.db.prepare('SELECT 1 FROM attempts WHERE turn_id = ?').get(turn.id);
          if (!attempt) {
            this.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,1,1,'pending')")
              .run(genId('att'), turn.id);
            repaired = true;
          }
        } else {
          const turnId = genId('turn');
          this.db
            .prepare("INSERT INTO turns(id, conversation_id, trigger, state, input_message_id, created_at) VALUES (?,?, 'user_message', 'pending', ?, ?)")
            .run(turnId, opts.conversationId, dup.id, nowIso);
          this.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,1,1,'pending')").run(genId('att'), turnId);
          this.db.prepare('UPDATE messages SET turn_id = ? WHERE id = ?').run(turnId, dup.id);
          turn = { id: turnId };
          repaired = true;
        }
        const attemptRow = this.db.prepare('SELECT id FROM attempts WHERE turn_id = ? ORDER BY attempt_no LIMIT 1').get(turn.id) as { id: string };
        return { message: this.getMessage(dup.id)!, duplicate: true, turnId: turn.id, attemptId: attemptRow.id, repaired };
      }

      const messageId = genId('msg');
      const seqRow = this.db
        .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM messages WHERE conversation_id = ?')
        .get(opts.conversationId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO messages(id, conversation_id, sequence, speaker, kind, client_message_id, current_revision, published_at, created_at)
           VALUES (?,?,?,?,?,?,1,?,?)`,
        )
        .run(messageId, opts.conversationId, seqRow.next, 'owner', opts.kind ?? 'text', opts.clientMessageId, occurredAt, nowIso);
      this.insertRevision({ messageId, revision: 1, kind: opts.kind ?? 'text', content, occurredAt, receivedAt: nowIso, source: 'client_submit' });
      this.insertOutbox(`archive:${messageId}:1`, { message_id: messageId }, nowIso);
      const turnId = genId('turn');
      const attemptId = genId('att');
      this.db
        .prepare("INSERT INTO turns(id, conversation_id, trigger, state, input_message_id, created_at) VALUES (?,?, 'user_message', 'pending', ?, ?)")
        .run(turnId, opts.conversationId, messageId, nowIso);
      this.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,1,1,'pending')").run(attemptId, turnId);
      this.db.prepare('UPDATE messages SET turn_id = ? WHERE id = ?').run(turnId, messageId);
      return { message: this.getMessage(messageId)!, duplicate: false, turnId, attemptId, repaired: false };
    });
  }

  // 用户编辑：新 revision + supersedes + 归档 outbox 同事务（AUD-15/07）
  editUserMessage(messageId: string, newContent: string): MessageDto {
    const content = normalizeNewlines(newContent);
    if (isBlankContent(content)) throw new BlankMessageError('编辑后正文仅空白，拒绝');
    const msg = this.getMessage(messageId);
    if (!msg) throw new Error('message not found');
    if (msg.speaker !== 'owner') throw new Error('只有用户消息可编辑');
    const nowIso = new Date().toISOString();
    tx(this.db, () => {
      const nextRev = msg.current_revision + 1;
      this.insertRevision({
        messageId,
        revision: nextRev,
        kind: msg.kind,
        content,
        occurredAt: nowIso,
        receivedAt: nowIso,
        source: 'client_edit',
        supersedes: msg.current_revision,
      });
      this.db.prepare('UPDATE messages SET current_revision = ? WHERE id = ?').run(nextRev, messageId);
      this.insertOutbox(`archive:${messageId}:${nextRev}`, { message_id: messageId, revision: nextRev }, nowIso);
    });
    return this.getMessage(messageId)!;
  }

  // 供路由事务内直接修订（同一外部 tx；AUD-06/07）
  editMessageInTx(messageId: string, newContent: string): { revision: number; contentHash: string } {
    const row = this.db
      .prepare('SELECT current_revision, kind FROM messages WHERE id = ?')
      .get(messageId) as { current_revision: number; kind: string } | undefined;
    if (!row) throw new Error('message not found');
    const content = normalizeNewlines(newContent);
    if (isBlankContent(content)) throw new BlankMessageError('编辑后正文仅空白，拒绝');
    const nowIso = new Date().toISOString();
    const nextRev = row.current_revision + 1;
    this.insertRevision({ messageId, revision: nextRev, kind: row.kind as MessageKind, content, occurredAt: nowIso, receivedAt: nowIso, source: 'route_edit', supersedes: row.current_revision });
    this.db.prepare('UPDATE messages SET current_revision = ? WHERE id = ?').run(nextRev, messageId);
    this.insertOutbox(`archive:${messageId}:${nextRev}`, { message_id: messageId, revision: nextRev }, nowIso);
    return { revision: nextRev, contentHash: sha256Hex(content) };
  }

  // 助手气泡正式发布（发布边界才落 message；含归档 outbox）
  publishAssistantMessage(opts: { conversationId: string; turnId: string; content: string; kind?: MessageKind }): MessageDto {
    const messageId = genId('msg');
    const nowIso = new Date().toISOString();
    tx(this.db, () => {
      const seqRow = this.db
        .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM messages WHERE conversation_id = ?')
        .get(opts.conversationId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO messages(id, conversation_id, sequence, speaker, turn_id, kind, current_revision, published_at, created_at)
           VALUES (?,?,?,?,?,?,1,?,?)`,
        )
        .run(messageId, opts.conversationId, seqRow.next, 'assistant', opts.turnId, opts.kind ?? 'text', nowIso, nowIso);
      this.insertRevision({ messageId, revision: 1, kind: opts.kind ?? 'text', content: opts.content, occurredAt: nowIso, receivedAt: nowIso, source: 'assistant_publish' });
      this.insertOutbox(`archive:${messageId}:1`, { message_id: messageId }, nowIso);
    });
    return this.getMessage(messageId)!;
  }

  private insertOutbox(operationKey: string, payload: Record<string, unknown>, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO outbox(id, operation_key, target, payload_ref, state, created_at, updated_at)
         VALUES (?,?,?,?, 'pending', ?, ?)
         ON CONFLICT(target, operation_key) DO NOTHING`,
      )
      .run(genId('obx'), operationKey, 'mariposa.archive', JSON.stringify(payload), nowIso, nowIso);
  }

  private insertRevision(opts: {
    messageId: string;
    revision: number;
    kind: MessageKind;
    content: string;
    occurredAt: string;
    receivedAt: string;
    source: string;
    supersedes?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, supersedes_revision, occurred_at, received_at, source)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(genId('rev'), opts.messageId, opts.revision, opts.kind, opts.content, sha256Hex(opts.content), opts.supersedes ?? null, opts.occurredAt, opts.receivedAt, opts.source);
  }

  getMessage(messageId: string): MessageDto | null {
    const row = this.db
      .prepare(
        `SELECT m.id, m.conversation_id, m.sequence, m.speaker, m.turn_id, m.kind, m.current_revision, m.published_at, m.created_at,
                r.revision, r.content, r.content_hash, r.kind AS rkind, r.occurred_at, r.received_at, r.supersedes_revision
         FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.id = ?`,
      )
      .get(messageId) as MessageRow | undefined;
    return row ? rowToDto(row) : null;
  }

  listMessages(opts: { conversationId: string; afterSequence?: number; limit?: number }): MessageDto[] {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const rows = this.db
      .prepare(
        `SELECT m.id, m.conversation_id, m.sequence, m.speaker, m.turn_id, m.kind, m.current_revision, m.published_at, m.created_at,
                r.revision, r.content, r.content_hash, r.kind AS rkind, r.occurred_at, r.received_at, r.supersedes_revision
         FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.conversation_id = ? AND m.sequence > ?
         ORDER BY m.sequence LIMIT ?`,
      )
      .all(opts.conversationId, opts.afterSequence ?? 0, limit) as MessageRow[];
    return rows.map(rowToDto);
  }

  currentRevisionHash(messageId: string): string | null {
    const row = this.db.prepare('SELECT content_hash FROM message_revisions WHERE message_id = ? AND revision = (SELECT current_revision FROM messages WHERE id = ?)').get(messageId, messageId) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }
}

type MessageRow = {
  id: string;
  conversation_id: string;
  sequence: number;
  speaker: 'owner' | 'assistant' | 'system';
  turn_id: string | null;
  kind: string;
  current_revision: number;
  published_at: string | null;
  created_at: string;
  revision: number;
  content: string;
  content_hash: string;
  rkind: string;
  occurred_at: string;
  received_at: string;
  supersedes_revision: number | null;
};

function rowToDto(r: MessageRow): MessageDto {
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    sequence: r.sequence,
    speaker: r.speaker,
    turn_id: r.turn_id,
    kind: r.kind as MessageKind,
    current_revision: r.current_revision,
    published_at: r.published_at,
    created_at: r.created_at,
    revision: {
      revision: r.revision,
      content: r.content,
      content_hash: r.content_hash,
      kind: r.kind as MessageKind,
      occurred_at: r.occurred_at,
      received_at: r.received_at,
      supersedes_revision: r.supersedes_revision,
    },
  };
}
