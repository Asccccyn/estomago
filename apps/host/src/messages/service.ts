// 消息服务 v0.2.2（AUD-15 修复版）：用户输入持久事务。
// submitUserMessageWithTurn：同一事务内完成 message+revision+sequence+输入归档 outbox+
// turn+attempt+turn_id 回填+幂等判定；commit 后才进 executor 队列。
// 幂等自愈：同 key 重试不只查 message，还校验并补齐缺失 side effects（turn/attempt/outbox）。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId, sha256Hex } from '../util/id.ts';
import { isBlankContent, normalizeNewlines, type MessageAttachmentInput, type MessageDto, type MessageKind } from '../../../../packages/contracts/src/api.ts';
import { sha256Hex as sha256HexOf } from '../util/id.ts';
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
        // members 表随迁移 v20 清退（1 写 0 读；她 2026-10-10 批）——
        // 建房只落 conversations 行
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
    attachments?: MessageAttachmentInput[]; // EXEC_V1 §03.5.2：先经 http 层 validateForSend，此处只固定绑定
    tokenEstimateJson?: string | null; // EXEC_V1 §05.7.2：发送前估计快照（调用方算好；与 content_hash 无关）
  }): SubmitWithTurnResult {
    const content = normalizeNewlines(opts.content);
    const attachments = opts.attachments ?? [];
    // §03.3/5.2：空正文仅在至少一个有效附件时允许；§3.2 语音不与其他附件混合
    if (isBlankContent(content) && attachments.length === 0) throw new BlankMessageError('正文仅空白且无附件，拒绝发送（不 trim 重写用户正文）');
    if (attachments.some((a) => a.presentation === 'voice') && attachments.length > 1) throw new Error('ATTACHMENT_MIX_INVALID: 语音消息不能与其他附件混合');
    // kind 推导（§3.2）：voice/sticker 看附件；图片消息仍 kind=text（是否含图以附件 DTO 为准）
    const derivedKind: MessageKind = attachments.length === 0 ? (opts.kind ?? 'text')
      : attachments[0]!.presentation === 'voice' ? 'voice'
        : attachments[0]!.presentation === 'sticker' ? 'sticker'
          : 'text';
    if (opts.kind !== undefined && opts.kind !== derivedKind && !(opts.kind === 'text' && derivedKind === 'text')) {
      throw new Error(`KIND_MISMATCH: 声明 kind=${opts.kind} 与附件组合推导 ${derivedKind} 不一致`);
    }
    const fingerprint = messageFingerprint(content, attachments);
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
        .prepare('SELECT id, current_revision FROM messages WHERE conversation_id = ? AND client_message_id = ?')
        .get(opts.conversationId, opts.clientMessageId) as { id: string; current_revision: number } | undefined;
      if (dup) {

        // AUD-29（她 1011 裁定）：同键不同内容=幂等冲突——只在双方 fingerprint 非 null 时比较
        const dupFp = (this.db.prepare('SELECT message_fingerprint FROM message_revisions WHERE message_id = ? AND revision = (SELECT current_revision FROM messages WHERE id = ?)').get(dup.id, dup.id) as { message_fingerprint: string | null } | undefined)?.message_fingerprint ?? null;
        if (dupFp !== null && fingerprint !== dupFp) {
          throw new Error('IDEMPOTENCY_CONFLICT: 同 client_message_id 对应不同正文/附件——请用新 ID 重新发送');
        }
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
        .run(messageId, opts.conversationId, seqRow.next, 'owner', derivedKind, opts.clientMessageId, occurredAt, nowIso);
      this.insertRevision({ messageId, revision: 1, kind: derivedKind, content, occurredAt, receivedAt: nowIso, source: 'client_submit', tokenEstimateJson: opts.tokenEstimateJson ?? null, fingerprint });
      for (let i = 0; i < attachments.length; i++) {
        // Only copy a trusted transcript of these exact stored bytes and this
        // conversation. Client-supplied derived_text is deliberately ignored.
        const transcript = attachments[i]!.presentation === 'voice'
          ? this.db.prepare(`SELECT t.derived_text,t.derived_source FROM voice_transcripts t JOIN media_assets a ON a.id=t.asset_id
              WHERE t.asset_id=? AND t.conversation_id=? AND t.state='ready' AND t.content_sha256=a.content_sha256`)
              .get(attachments[i]!.asset_id, opts.conversationId) as { derived_text: string; derived_source: string } | undefined
          : undefined;
        this.db.prepare(
          `INSERT INTO message_attachments(message_id, revision, position, asset_id, presentation, caption, derived_text, derived_source, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(messageId, 1, i, attachments[i]!.asset_id, attachments[i]!.presentation, attachments[i]!.caption ?? null, transcript?.derived_text ?? null, transcript?.derived_source ?? null, nowIso);
      }
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
  editUserMessage(messageId: string, newContent: string, tokenEstimateJson?: string | null): MessageDto {
    const content = normalizeNewlines(newContent);
    if (isBlankContent(content)) throw new BlankMessageError('编辑后正文仅空白，拒绝');
    const msg = this.getMessage(messageId);
    if (!msg) throw new Error('message not found');
    if (msg.speaker !== 'owner') throw new Error('只有用户消息可编辑');
    const nowIso = new Date().toISOString();
    tx(this.db, () => {
      const nextRev = msg.current_revision + 1;
      // §3.3：文字编辑沿用原附件——同一套绑定复制到新修订；旧修订附件引用原样保留
      const oldAttachments = this.db.prepare('SELECT asset_id, presentation, caption FROM message_attachments WHERE message_id = ? AND revision = ? ORDER BY position').all(messageId, msg.current_revision) as Array<{ asset_id: string; presentation: string; caption: string | null }>;
      const fingerprint = messageFingerprint(content, oldAttachments.map((a) => ({ asset_id: a.asset_id, presentation: a.presentation as MessageAttachmentInput['presentation'] })));
      this.insertRevision({
        messageId,
        revision: nextRev,
        kind: msg.kind,
        content,
        occurredAt: nowIso,
        receivedAt: nowIso,
        source: 'client_edit',
        supersedes: msg.current_revision,
        tokenEstimateJson: tokenEstimateJson ?? null, // 编辑=新 revision+新快照；旧修订旧快照不动
        fingerprint,
      });
      for (let i = 0; i < oldAttachments.length; i++) {
        this.db.prepare(
          `INSERT INTO message_attachments(message_id, revision, position, asset_id, presentation, caption, derived_text, derived_source, created_at)
           SELECT message_id, ?, position, asset_id, presentation, caption, derived_text, derived_source, ? FROM message_attachments WHERE message_id = ? AND revision = ? AND position = ?`,
        ).run(nextRev, nowIso, messageId, msg.current_revision, i);
      }
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
    // AUD-28 P2：路由编辑复制附件到新修订（与普通编辑一致）
    const oldAtts = this.db.prepare('SELECT asset_id, presentation, caption FROM message_attachments WHERE message_id = ? AND revision = ? ORDER BY position').all(messageId, row.current_revision) as Array<{ asset_id: string; presentation: string; caption: string | null }>;
    const fp = messageFingerprint(content, oldAtts.map((a) => ({ asset_id: a.asset_id, presentation: a.presentation as MessageAttachmentInput['presentation'] })));
    this.insertRevision({ messageId, revision: nextRev, kind: row.kind as MessageKind, content, occurredAt: nowIso, receivedAt: nowIso, source: 'route_edit', supersedes: row.current_revision, fingerprint: fp });
    for (let i = 0; i < oldAtts.length; i++) {
      this.db.prepare(
        `INSERT INTO message_attachments(message_id, revision, position, asset_id, presentation, caption, derived_text, derived_source, created_at)
         SELECT message_id, ?, position, asset_id, presentation, caption, derived_text, derived_source, ? FROM message_attachments WHERE message_id = ? AND revision = ? AND position = ?`,
      ).run(nextRev, nowIso, messageId, row.current_revision, i);
    }
    this.db.prepare('UPDATE messages SET current_revision = ? WHERE id = ?').run(nextRev, messageId);
    this.insertOutbox(`archive:${messageId}:${nextRev}`, { message_id: messageId, revision: nextRev }, nowIso);
    return { revision: nextRev, contentHash: sha256Hex(content) };
  }

  // 助手气泡正式发布（发布边界才落 message；含归档 outbox）
  publishAssistantMessage(opts: { conversationId: string; turnId: string; content: string; kind?: MessageKind; clientMessageId?: string; attachments?: MessageAttachmentInput[] }): MessageDto {
    const nowIso = new Date().toISOString();
    // EXEC_V1 §03.6.3：chat_send_attachment 幂等——同 client_message_id 重发返回原消息，
    // 复用既有 (conversation, client_message_id) 唯一索引，不另建工具专用消息通道
    if (opts.clientMessageId) {
      const dup = this.db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND client_message_id = ?').get(opts.conversationId, opts.clientMessageId) as { id: string } | undefined;
      if (dup) return this.getMessage(dup.id)!;
    }
    const messageId = genId('msg');
    tx(this.db, () => {
      const seqRow = this.db
        .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM messages WHERE conversation_id = ?')
        .get(opts.conversationId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO messages(id, conversation_id, sequence, speaker, turn_id, kind, client_message_id, current_revision, published_at, created_at)
           VALUES (?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(messageId, opts.conversationId, seqRow.next, 'assistant', opts.turnId, opts.kind ?? 'text', opts.clientMessageId ?? null, nowIso, nowIso);
      this.insertRevision({ messageId, revision: 1, kind: opts.kind ?? 'text', content: opts.content, occurredAt: nowIso, receivedAt: nowIso, source: 'assistant_publish', fingerprint: messageFingerprint(opts.content, opts.attachments ?? []) });
      const atts = opts.attachments ?? [];
      for (let i = 0; i < atts.length; i++) {
        this.db.prepare(
          `INSERT INTO message_attachments(message_id, revision, position, asset_id, presentation, caption, derived_text, derived_source, created_at)
           VALUES (?,?,?,?,?,?,NULL,NULL,?)`,
        ).run(messageId, 1, i, atts[i]!.asset_id, atts[i]!.presentation, atts[i]!.caption ?? null, nowIso);
      }
      this.insertOutbox(`archive:${messageId}:1`, { message_id: messageId }, nowIso);
    });
    return this.getMessage(messageId)!;
  }

  /** 2026-10-17 她裁定（Claude 官端说话方式）：一轮回复合成一条消息——
   *  后续段落以新修订追加到既有 assistant 消息（内容增长，不改写已发布文本；
   *  修订链+归档 outbox 同 publishAssistantMessage 口径）。返回更新后的 dto。 */
  appendAssistantPublication(messageId: string, additionalContent: string): MessageDto | null {
    const nowIso = new Date().toISOString();
    const row = this.db.prepare('SELECT id, conversation_id, current_revision FROM messages WHERE id = ? AND speaker = \'assistant\'').get(messageId) as { id: string; conversation_id: string; current_revision: number } | undefined;
    if (!row) return null;
    const cur = this.db.prepare('SELECT content FROM message_revisions WHERE message_id = ? AND revision = ?').get(messageId, row.current_revision) as { content: string } | undefined;
    const base = (cur?.content ?? '').replace(/\n+$/, '');
    const merged = base + '\n\n' + additionalContent.replace(/^\n+/, '');
    tx(this.db, () => {
      this.insertRevision({ messageId, revision: row.current_revision + 1, kind: 'text', content: merged, occurredAt: nowIso, receivedAt: nowIso, source: 'assistant_publish', fingerprint: messageFingerprint(merged, []), supersedes: row.current_revision });
      this.db.prepare('UPDATE messages SET current_revision = ? WHERE id = ?').run(row.current_revision + 1, messageId);
      this.insertOutbox(`archive:${messageId}:${row.current_revision + 1}`, { message_id: messageId }, nowIso);
    });
    return this.getMessage(messageId);
  }

  /** EXEC_V1 §04.13：预写提醒投递（speaker=system，宿主消息；幂等键防重复投递；归档 outbox 同链）。 */
  publishSystemNotice(opts: { conversationId: string; content: string; clientMessageId: string }): MessageDto {
    const nowIso = new Date().toISOString();
    const dup = this.db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND client_message_id = ?').get(opts.conversationId, opts.clientMessageId) as { id: string } | undefined;
    if (dup) return this.getMessage(dup.id)!;
    const messageId = genId('msg');
    tx(this.db, () => {
      const seqRow = this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM messages WHERE conversation_id = ?').get(opts.conversationId) as { next: number };
      this.db.prepare(
        `INSERT INTO messages(id, conversation_id, sequence, speaker, turn_id, kind, client_message_id, current_revision, published_at, created_at)
         VALUES (?,?,?, 'system', NULL, 'system', ?, 1, ?, ?)`,
      ).run(messageId, opts.conversationId, seqRow.next, opts.clientMessageId, nowIso, nowIso);
      this.insertRevision({ messageId, revision: 1, kind: 'system', content: opts.content, occurredAt: nowIso, receivedAt: nowIso, source: 'reminder_delivery', fingerprint: messageFingerprint(opts.content, []) });
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
    tokenEstimateJson?: string | null;
    fingerprint?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, supersedes_revision, occurred_at, received_at, source, token_estimate_json, message_fingerprint)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(genId('rev'), opts.messageId, opts.revision, opts.kind, opts.content, sha256Hex(opts.content), opts.supersedes ?? null, opts.occurredAt, opts.receivedAt, opts.source, opts.tokenEstimateJson ?? null, opts.fingerprint ?? null);
  }

  getMessage(messageId: string): MessageDto | null {
    const row = this.db
      .prepare(
        `SELECT m.id, m.conversation_id, m.sequence, m.speaker, m.turn_id, m.kind, m.current_revision, m.published_at, m.created_at,
                r.revision, r.content, r.content_hash, r.kind AS rkind, r.occurred_at, r.received_at, r.supersedes_revision, r.token_estimate_json
         FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.id = ?`,
      )
      .get(messageId) as MessageRow | undefined;
    return row ? rowToDto(row, attachmentsFor(this.db, row.id, row.revision)) : null;
  }

  listMessages(opts: { conversationId: string; afterSequence?: number; beforeSequence?: number; limit?: number; latest?: boolean }): MessageDto[] {
    const limit = Math.min(opts.limit ?? 100, 1000);
    // R20（复审 2026-10-07）：latest=最新一页（DESC 取满再翻回升序）——
    // 首屏方向与"加载更早"的 before= 向前游标对齐；此前默认最早 500 条，
    // before=最早序号永远翻 0 条（>500 条历史不可达）
    if (opts.latest) {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.conversation_id, m.sequence, m.speaker, m.turn_id, m.kind, m.current_revision, m.published_at, m.created_at,
                  r.revision, r.content, r.content_hash, r.kind AS rkind, r.occurred_at, r.received_at, r.supersedes_revision, r.token_estimate_json
           FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
           WHERE m.conversation_id = ?
           ORDER BY m.sequence DESC LIMIT ?`,
        )
        .all(opts.conversationId, limit) as MessageRow[];
      return rows.reverse().map((row) => rowToDto(row, attachmentsFor(this.db, row.id, row.revision)));
    }
    // F-J-48（联合审计 2026-10-06）：beforeSequence=反向翻页（历史"加载更早"）——
    // 取 sequence < before 的最新 limit 条后翻回升序，与 after 语义对偶
    if (opts.beforeSequence !== undefined) {
      const older = this.db
        .prepare(
          `SELECT m.id, m.conversation_id, m.sequence, m.speaker, m.turn_id, m.kind, m.current_revision, m.published_at, m.created_at,
                  r.revision, r.content, r.content_hash, r.kind AS rkind, r.occurred_at, r.received_at, r.supersedes_revision, r.token_estimate_json
           FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
           WHERE m.conversation_id = ? AND m.sequence < ?
           ORDER BY m.sequence DESC LIMIT ?`,
        )
        .all(opts.conversationId, opts.beforeSequence, limit) as MessageRow[];
      return older.reverse().map((row) => rowToDto(row, attachmentsFor(this.db, row.id, row.revision)));
    }
    const rows = this.db
      .prepare(
        `SELECT m.id, m.conversation_id, m.sequence, m.speaker, m.turn_id, m.kind, m.current_revision, m.published_at, m.created_at,
                r.revision, r.content, r.content_hash, r.kind AS rkind, r.occurred_at, r.received_at, r.supersedes_revision, r.token_estimate_json
         FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.conversation_id = ? AND m.sequence > ?
         ORDER BY m.sequence LIMIT ?`,
      )
      .all(opts.conversationId, opts.afterSequence ?? 0, limit) as MessageRow[];
    return rows.map((row) => rowToDto(row, attachmentsFor(this.db, row.id, row.revision)));
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
  token_estimate_json: string | null;
};

type AttachmentRow = { asset_id: string; presentation: string; caption: string | null; derived_text: string | null; derived_source: string | null };
function rowToDto(r: MessageRow, attachments: AttachmentRow[] = []): MessageDto {
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
      token_estimate: r.token_estimate_json ? (JSON.parse(r.token_estimate_json) as MessageDto['revision']['token_estimate']) : null,
      attachments: attachments.map((a) => ({ asset_id: a.asset_id, presentation: a.presentation as MessageAttachmentInput['presentation'], caption: a.caption, derived_text: a.derived_text, derived_source: a.derived_source })),
    },
  };
}

/** §03.5.2：附件按该 revision 的绑定取——不以当前附件冒充旧版本。 */
function attachmentsFor(db: import('../db/connection.ts').Db, messageId: string, revision: number): AttachmentRow[] {
  return db.prepare('SELECT asset_id, presentation, caption, derived_text, derived_source FROM message_attachments WHERE message_id = ? AND revision = ? ORDER BY position').all(messageId, revision) as AttachmentRow[];
}

function messageFingerprint(content: string, attachments: Array<{ asset_id: string; presentation: string }>): string {
  // §03.4.2：规范化正文+有序附件引用的本地指纹——与 content_hash 分离（Mariposa 合同不变）
  return sha256HexOf(`${content}\u0000${attachments.map((a) => `${a.asset_id}:${a.presentation}`).join('|')}`);
}
