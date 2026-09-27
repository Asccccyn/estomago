// 消息服务：01 §4 的写入边界。
// - 用户提交：权限/幂等键校验 → 同一事务内写 message + revision + 分配 sequence + outbox → 返回回执
// - 换行规范化为 \n，保留行序/空行；多行正文是一条消息，绝不拆分（11.1 硬规则）
// - 助手输出：pending 草稿不进正式表；只有正式发布边界才写 message + outbox
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId, sha256Hex } from '../util/id.ts';
import { isBlankContent, normalizeNewlines, type MessageDto, type MessageKind } from '../../../../packages/contracts/src/api.ts';

export type SubmitResult = { message: MessageDto; duplicate: boolean };

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
        this.db
          .prepare('INSERT INTO members(conversation_id, participant_id, role) VALUES (?, ?, ?)')
          .run(conversationId, 'owner', 'owner');
      });
    }
  }

  // 用户消息提交。幂等：同 (conversation, client_message_id) 返回原记录（duplicate=true）。
  submitUserMessage(opts: {
    conversationId: string;
    content: string; // 原始正文，只做换行规范化
    clientMessageId: string;
    occurredAt?: string | null;
    kind?: MessageKind;
  }): SubmitResult {
    const content = normalizeNewlines(opts.content);
    if (isBlankContent(content)) {
      throw new BlankMessageError('正文仅空白且无附件，拒绝发送（不 trim 重写用户正文）');
    }
    const dup = this.db
      .prepare('SELECT id FROM messages WHERE conversation_id = ? AND client_message_id = ?')
      .get(opts.conversationId, opts.clientMessageId) as { id: string } | undefined;
    if (dup) return { message: this.getMessage(dup.id)!, duplicate: true };

    const nowIso = new Date().toISOString();
    const occurredAt = opts.occurredAt ?? nowIso;
    const messageId = genId('msg');
    const receivedAt = nowIso;

    tx(this.db, () => {
      const seqRow = this.db
        .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM messages WHERE conversation_id = ?')
        .get(opts.conversationId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO messages(id, conversation_id, sequence, speaker, kind, client_message_id, current_revision, published_at, created_at)
           VALUES (?,?,?,?,?,?,1,?,?)`,
        )
        .run(messageId, opts.conversationId, seqRow.next, 'owner', opts.kind ?? 'text', opts.clientMessageId, occurredAt, receivedAt);
      this.insertRevision({ messageId, revision: 1, kind: opts.kind ?? 'text', content, occurredAt, receivedAt, source: 'client_submit' });
    });
    return { message: this.getMessage(messageId)!, duplicate: false };
  }

  // 用户编辑：新 revision + supersedes；旧版本保留审计（4.2）
  editUserMessage(messageId: string, newContent: string): MessageDto {
    const content = normalizeNewlines(newContent);
    if (isBlankContent(content)) throw new BlankMessageError('编辑后正文仅空白，拒绝');
    const msg = this.getMessage(messageId);
    if (!msg) throw new Error('message not found');
    if (msg.speaker !== 'owner') throw new Error('只有用户消息可编辑');
    const nowIso = new Date().toISOString();
    tx(this.db, () => {
      const nextRev = msg.current_revision + 1;
      this.db.prepare('UPDATE messages SET current_revision = ? WHERE id = ?').run(nextRev, messageId);
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
    });
    return this.getMessage(messageId)!;
  }

  // 助手气泡正式发布（发布边界才落 message；pending 草稿只存在于运行缓冲 4.1）
  publishAssistantMessage(opts: {
    conversationId: string;
    turnId: string;
    content: string;
    kind?: MessageKind;
    windowId?: string | null;
  }): MessageDto {
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
      // 归档 outbox：区分"已保存到聊天库"与"已归档到记忆库"（4.3）；archive.enabled=false 时由分发器标 disabled
      this.db
        .prepare(
          `INSERT INTO outbox(id, operation_key, target, payload_ref, state, created_at, updated_at)
           VALUES (?,?,?,?,'pending',?,?)
           ON CONFLICT(target, operation_key) DO NOTHING`,
        )
        .run(genId('obx'), `archive:${messageId}:1`, 'mariposa.archive', JSON.stringify({ message_id: messageId }), nowIso, nowIso);
    });
    return this.getMessage(messageId)!;
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
      .run(
        genId('rev'),
        opts.messageId,
        opts.revision,
        opts.kind,
        opts.content,
        sha256Hex(opts.content),
        opts.supersedes ?? null,
        opts.occurredAt,
        opts.receivedAt,
        opts.source,
      );
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
    const limit = Math.min(opts.limit ?? 100, 500);
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

  lastMessageOf(opts: { conversationId: string; speaker?: 'owner' | 'assistant' }): MessageDto | null {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.conversation_id, m.sequence, m.speaker, m.turn_id, m.kind, m.current_revision, m.published_at, m.created_at,
                r.revision, r.content, r.content_hash, r.kind AS rkind, r.occurred_at, r.received_at, r.supersedes_revision
         FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.conversation_id = ? AND (? IS NULL OR m.speaker = ?)
         ORDER BY m.sequence DESC LIMIT 1`,
      )
      .all(opts.conversationId, opts.speaker ?? null, opts.speaker ?? null) as MessageRow[];
    return rows[0] ? rowToDto(rows[0]) : null;
  }
}

export class BlankMessageError extends Error {}

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
