// 原文归档同步（ESTOMAGO_OR_SELF_HOLD §1.2/§8.3 + 生命周期包 §4.1/§4.3）：
//   用户提交/助手正式发布 → 同事务 outbox（既有生产者）→ 本消费者按冻结批次同步
//   source.ingest → 远端 ACK 逐条校验后落 source_sync_receipts → outbox acked。
//  审计修复（estomago-audit-18a1f1f）：
//   - F09：批次在首次发送前冻结（ingest_batches：规范化 payload+成员键集）。崩溃/响应丢失
//     按**字节一致**的原 payload 重放（同 op），新消息只进新批——不重组批、不重读可变前驱版本。
//   - F10：ACK 逐条校验——op 必须匹配、每条 (origin,revision) 必须有对应回执且 hash 相符；
//     空回执/缺条目=unknown_outcome，不标 acked。
//   - F15：SOURCE_NOT_READY/429/502/503/504 视为可重试（批次 attempts 有界，超限 dead）；其余领域错误 dead。
//   - F16：切批按规范化 JSON 的 UTF-8 字节数（含转义与元数据），不只算原始正文。
//  隐私：错误/事件只记 code/计数/ID；本文件不读任何凭据值。
import type { Db } from '../../db/connection.ts';
import { tx } from '../../db/connection.ts';
import { Buffer } from 'node:buffer';
import { genId } from '../../util/id.ts';
import type { EventService } from '../../events/service.ts';
import type { Logger } from '../../observability/logging.ts';
import type { Config } from '../../config/schema.ts';
import { classifyError, ingestOperationId, type IngestMessage, type IngestRequest, type MariposaClient } from './client.ts';

export const INGEST_BATCH_MAX_MESSAGES = 50; // 契约建议初值：每请求 ≤50 条
export const INGEST_BATCH_MAX_BYTES = 1024 * 1024; // 规范化 JSON 总计 ≤1MiB
export const INGEST_BATCH_MAX_ATTEMPTS = 10; // 瞬时错误有界重试（F15：超限 dead，不无限循环）

type OutboxRow = {
  id: string;
  operation_key: string; // archive:<message_id>:<revision>
  target: string;
  payload_ref: string;
  state: string;
  attempt: number;
  last_error: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = { id: string; conversation_id: string; sequence: number; speaker: string; kind: string; current_revision: number; published_at: string | null };
type RevisionRow = { message_id: string; revision: number; kind: string; content: string; content_hash: string; occurred_at: string | null; received_at: string; source: string; supersedes_revision: number | null };

export type DrainSummary = { batches: number; acked: number; retry_later: number; dead: number; skipped_disabled: boolean; stopped_streams: number };

export class ArchiveSyncService {
  private db: Db;
  private events: EventService;
  private logger: Logger;
  private client: MariposaClient;
  private streamId: string;
  private enabled: boolean;
  private draining = false;

  constructor(deps: { db: Db; events: EventService; logger: Logger; client: MariposaClient; config: Config }) {
    this.db = deps.db;
    this.events = deps.events;
    this.logger = deps.logger;
    this.client = deps.client;
    this.streamId = deps.config.archive.source_scope ?? 'estomago-primary-live';
    this.enabled = deps.config.archive.enabled && deps.config.integrations.mariposa.base_url !== null;
  }

  rawSyncState(conversationId: string): { pending: number; unknown_outcome: number; failed: number; acked: number; enabled: boolean } {
    const n = (where: string): number =>
      (this.db.prepare(`SELECT COUNT(*) n FROM outbox o JOIN messages m ON m.id = json_extract(o.payload_ref, '$.message_id') WHERE o.target = 'mariposa.archive' AND m.conversation_id = ? AND ${where}`).get(conversationId) as { n: number }).n;
    return {
      pending: n("o.state IN ('pending','sent')"),
      unknown_outcome: n("o.state = 'unknown_outcome'"),
      failed: n("o.state = 'failed'"),
      acked: n("o.state = 'acked'"),
      enabled: this.enabled,
    };
  }

  async drainOnce(): Promise<DrainSummary> {
    const summary: DrainSummary = { batches: 0, acked: 0, retry_later: 0, dead: 0, skipped_disabled: false, stopped_streams: 0 };
    if (!this.enabled) {
      summary.skipped_disabled = true;
      return summary;
    }
    if (this.draining) return summary; // 单执行者
    this.draining = true;
    try {
      await this.drainLocked(summary);
    } finally {
      this.draining = false;
    }
    return summary;
  }

  private async drainLocked(summary: DrainSummary): Promise<void> {
    // —— 1) 冻结批次恢复（F09）：已绑批次的行（sent/unknown_outcome/重试回退的 pending）
    //     → 原样字节重放，绝不与新消息重组 ——
    const frozenOps = this.db.prepare(
      `SELECT DISTINCT o.batch_id AS op FROM outbox o WHERE o.target = 'mariposa.archive' AND o.state IN ('sent','unknown_outcome','pending') AND o.batch_id IS NOT NULL ORDER BY o.batch_id`,
    ).all() as Array<{ op: string }>;
    for (const { op } of frozenOps) {
      const batch = this.db.prepare('SELECT * FROM ingest_batches WHERE operation_id = ?').get(op) as
        | { operation_id: string; conversation_id: string; payload_json: string; state: string; attempts: number }
        | undefined;
      const rows = this.db.prepare("SELECT * FROM outbox WHERE batch_id = ? AND state IN ('sent','unknown_outcome','pending') ORDER BY created_at, id").all(op) as OutboxRow[];
      if (!batch || batch.state === 'acked') {
        // 批次已确认/记录缺失：行对齐到批次终态（记录缺失=本地证据丢失，按 unknown 保留不冒充）
        if (batch?.state === 'acked') this.markChunk(rows, 'acked', null);
        else this.markChunk(rows, 'unknown_outcome', 'BATCH_RECORD_MISSING');
        continue;
      }
      if (batch.state === 'dead') {
        this.markChunk(rows, 'failed', 'BATCH_DEAD');
        continue;
      }
      const payload = JSON.parse(batch.payload_json) as IngestRequest;
      await this.sendPayload(payload, rows, summary, { operationId: op, conversationId: batch.conversation_id });
    }

    // —— 2) 新批次：pending/sent/unknown_outcome 且未绑批次 → 组批 → 冻结 → 发送 ——
    const fresh = this.db.prepare(
      `SELECT o.* FROM outbox o WHERE o.target = 'mariposa.archive' AND o.state IN ('pending','unknown_outcome','sent') AND o.batch_id IS NULL
       ORDER BY o.created_at, o.id`,
    ).all() as OutboxRow[];
    if (fresh.length === 0) return;
    const byConversation = new Map<string, OutboxRow[]>();
    for (const row of fresh) {
      const messageId = this.messageIdOf(row);
      if (!messageId) {
        this.markDeadQuietly(row, 'PAYLOAD_REF_INVALID');
        summary.dead += rows.length;
        continue;
      }
      const msg = this.db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(messageId) as { conversation_id: string } | undefined;
      if (!msg) {
        this.markDeadQuietly(row, 'LOCAL_MESSAGE_MISSING');
        summary.dead += rows.length;
        continue;
      }
      const list = byConversation.get(msg.conversation_id) ?? [];
      list.push(row);
      byConversation.set(msg.conversation_id, list);
    }
    for (const [conversationId, streamRows] of byConversation) {
      let stopped = false;
      let i = 0;
      let lastOutcome: 'acked' | 'retry_later' | 'dead' = 'acked';
      while (i < streamRows.length && !stopped) {
        const built = this.buildBatch(conversationId, streamRows, i);
        i += built.consumed;
        for (const row of built.deadRows) {
          this.markDeadQuietly(row, 'OVERSIZED_MESSAGE');
          summary.dead++;
        }
          if (built.request === null) continue;
          // F09：发送前冻结——payload/成员键/op 落 ingest_batches，行绑批次（同一事务）
          tx(this.db, () => {
            this.db.prepare('INSERT INTO ingest_batches(operation_id, conversation_id, payload_json, keys_json, created_at, updated_at) VALUES (?,?,?,?,?,?)')
              .run(built.request!.operation_id, conversationId, JSON.stringify(built.request), JSON.stringify(built.rows.map((r) => r.operation_key)), new Date().toISOString(), new Date().toISOString());
            for (const row of built.rows) {
              this.db.prepare('UPDATE outbox SET batch_id = ? WHERE id = ?').run(built.request!.operation_id, row.id);
            }
          });
          lastOutcome = await this.sendPayload(built.request, built.rows, summary, { operationId: built.request.operation_id, conversationId });
          summary.batches++;
          if (lastOutcome === 'retry_later') {
            stopped = true; // 同流有序：前批未确认，后面不继续（不跳过）
            summary.stopped_streams++;
          }
        }
    }
  }

  // 按 JSON 字节数（F16）累积一个批次：≤50 条且规范化消息对象 UTF-8 合计 ≤1MiB
  private buildBatch(conversationId: string, rows: OutboxRow[], startIdx: number): { request: IngestRequest | null; rows: OutboxRow[]; consumed: number; deadRows: OutboxRow[] } {
    const batchRows: OutboxRow[] = [];
    const messages: IngestMessage[] = [];
    const keys: Array<{ messageId: string; revision: number }> = [];
    const deadRows: OutboxRow[] = [];
    let bytes = 0;
    let i = startIdx;
    for (; i < rows.length; i++) {
      const row = rows[i]!;
      if (batchRows.length >= INGEST_BATCH_MAX_MESSAGES) break;
      const messageId = this.messageIdOf(row);
      const revisionNo = Number(row.operation_key.split(':').pop());
      if (!messageId || !Number.isInteger(revisionNo)) {
        this.markDeadQuietly(row, 'PAYLOAD_REF_INVALID');
        continue;
      }
      const msg = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined;
      const rev = this.db.prepare('SELECT * FROM message_revisions WHERE message_id = ? AND revision = ?').get(messageId, revisionNo) as RevisionRow | undefined;
      if (!msg || !rev) {
        this.markDeadQuietly(row, 'LOCAL_ROW_MISSING');
        continue;
      }
      const pred = msg.sequence > 1
        ? (this.db.prepare('SELECT id, current_revision FROM messages WHERE conversation_id = ? AND sequence = ?').get(conversationId, msg.sequence - 1) as { id: string; current_revision: number } | undefined)
        : undefined;
      if (msg.sequence > 1 && !pred) {
        this.markDeadQuietly(row, 'LOCAL_CHAIN_MISSING');
        continue;
      }
      const message: IngestMessage = {
        origin_message_id: msg.id,
        revision: rev.revision,
        previous_revision: rev.supersedes_revision,
        conversation_sequence: msg.sequence,
        predecessor: pred ? { origin_message_id: pred.id, revision: pred.current_revision } : null,
        sender: msg.speaker === 'owner' ? 'user' : 'assistant',
        published_kind: rev.kind,
        occurred_at: rev.occurred_at,
        received_at: rev.received_at,
        published_at: msg.published_at,
        text: rev.content,
        assets: [],
        content_hash: rev.content_hash,
      };
      // F16：按序列化后的消息对象字节计（转义/元数据全算），不是裸正文
      const serializedBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
      if (batchRows.length > 0 && bytes + serializedBytes > INGEST_BATCH_MAX_BYTES) break; // 切批
      if (serializedBytes > INGEST_BATCH_MAX_BYTES) {
        deadRows.push(row); // 单条超限：明确报错不截断（大对象路径不在本任务）
        continue;
      }
      bytes += serializedBytes;
      batchRows.push(row);
      messages.push(message);
      keys.push({ messageId: msg.id, revision: rev.revision });
    }
    if (messages.length === 0) return { request: null, rows: [], consumed: i - startIdx, deadRows };
    const request: IngestRequest = {
      operation_id: ingestOperationId(conversationId, keys),
      stream_id: this.streamId,
      origin_instance: 'estomago',
      origin_conversation_id: conversationId,
      messages,
    };
    return { request, rows: batchRows, consumed: i - startIdx, deadRows };
  }

  // 发送一个（冻结的）payload。F09 恢复路径与新批共用：绝不重建内容。
  private async sendPayload(request: IngestRequest, rows: OutboxRow[], summary: DrainSummary, meta: { operationId: string; conversationId: string }): Promise<'acked' | 'retry_later' | 'dead'> {
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db.prepare('UPDATE ingest_batches SET attempts = attempts + 1, updated_at = ? WHERE operation_id = ?').run(now, meta.operationId);
      for (const row of rows) {
        this.db.prepare("UPDATE outbox SET state = 'sent', attempt = attempt + 1, updated_at = ? WHERE id = ?").run(now, row.id);
      }
    });
    let result: Awaited<ReturnType<MariposaClient['sourceIngest']>>;
    try {
      result = await this.client.sourceIngest(request);
    } catch (err) {
      // 网络未知：可能已提交（§4.3）——unknown_outcome，下一轮按冻结 payload 同 op 重放
      const code = String((err as Error)?.message ?? err).slice(0, 60);
      this.markChunk(rows, 'unknown_outcome', `TRANSPORT_UNKNOWN:${code}`);
      this.logger.warn('archive_sync_transport_unknown', { op: meta.operationId, code: 'TRANSPORT_UNKNOWN' });
      summary.retry_later += rows.length;
      return 'retry_later';
    }
    if (!result.ok) {
      const cls = classifyError(result.code);
      const attempts = (this.db.prepare('SELECT attempts FROM ingest_batches WHERE operation_id = ?').get(meta.operationId) as { attempts: number } | undefined)?.attempts ?? 0;
      // F15：瞬时错误（SOURCE_NOT_READY/429/502/503/504）可重试但有界；领域冲突=dead
      if (cls === 'retry_later' && attempts <= INGEST_BATCH_MAX_ATTEMPTS) {
        this.markChunk(rows, 'pending', result.code);
        this.events.publish('archive.sync', { conversationId: meta.conversationId, entityRef: meta.operationId, scope: 'private', payload: { state: 'retry_later', code: result.code, attempts } });
        summary.retry_later += rows.length;
        return 'retry_later';
      }
      const code = cls === 'retry_later' ? 'TRANSIENT_EXHAUSTED' : result.code;
      this.markChunk(rows, 'failed', code);
      this.markBatchDead(meta.operationId, code);
      this.events.publish('archive.sync', { conversationId: meta.conversationId, entityRef: meta.operationId, scope: 'private', payload: { state: 'failed', code } });
      this.logger.warn('archive_sync_dead', { op: meta.operationId, code });
      summary.dead += rows.length;
      return 'dead';
    }
    // F10：ACK 逐条校验——op 匹配 + 每条请求消息都有对应回执（origin+revision），hash 相符
    const ack = result.ack;
    if (!ack || ack.operation_id !== request.operation_id) {
      this.markChunk(rows, 'unknown_outcome', 'ACK_SHAPE_INVALID');
      summary.retry_later += rows.length;
      return 'retry_later';
    }
    const byKey = new Map(ack.messages.map((m) => [`${m.origin_message_id}@${m.revision}`, m]));
    for (const reqMsg of request.messages) {
      const entry = byKey.get(`${reqMsg.origin_message_id}@${reqMsg.revision}`);
      if (!entry) {
        this.markChunk(rows, 'unknown_outcome', 'ACK_INCOMPLETE'); // 空回执/缺条目：不冒充已同步
        summary.retry_later += rows.length;
        return 'retry_later';
      }
      if (entry.content_hash !== null && entry.content_hash !== reqMsg.content_hash) {
        this.markChunk(rows, 'failed', 'ACK_HASH_MISMATCH');
        this.markBatchDead(meta.operationId, 'ACK_HASH_MISMATCH');
        this.events.publish('archive.sync', { conversationId: meta.conversationId, entityRef: meta.operationId, scope: 'private', payload: { state: 'failed', code: 'ACK_HASH_MISMATCH' } });
        summary.dead += rows.length;
        return 'dead';
      }
    }
    tx(this.db, () => {
      for (const m of ack.messages) {
        this.db.prepare(
          `INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(origin_message_id, revision) DO UPDATE SET source_message_id = excluded.source_message_id, content_hash = excluded.content_hash`,
        ).run(genId('ssr'), ack.operation_id, m.origin_message_id, m.revision, m.source_conversation_id, m.source_message_id, m.content_hash, ack.committed_at, new Date().toISOString());
      }
      for (const row of rows) {
        this.db.prepare("UPDATE outbox SET state = 'acked', last_error = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
      }
      this.db.prepare("UPDATE ingest_batches SET state = 'acked', updated_at = ? WHERE operation_id = ?").run(new Date().toISOString(), meta.operationId);
    });
    this.events.publish('archive.sync', { conversationId: meta.conversationId, entityRef: meta.operationId, scope: 'private', payload: { state: 'acked', messages: ack.messages.length } });
    summary.acked += rows.length;
    return 'acked';
  }

  private messageIdOf(row: OutboxRow): string | null {
    try {
      const v = JSON.parse(row.payload_ref) as { message_id?: unknown };
      return typeof v.message_id === 'string' ? v.message_id : null;
    } catch {
      return null;
    }
  }

  private markChunk(chunk: OutboxRow[], state: 'pending' | 'failed' | 'acked' | 'unknown_outcome', code: string | null): void {
    const now = new Date().toISOString();
    tx(this.db, () => {
      for (const row of chunk) {
        this.db.prepare('UPDATE outbox SET state = ?, last_error = ?, updated_at = ? WHERE id = ?').run(state, code !== null ? code.slice(0, 200) : null, now, row.id);
      }
    });
  }

  private markBatchDead(operationId: string, code: string): void {
    tx(this.db, () => {
      this.db.prepare("UPDATE ingest_batches SET state = 'dead', last_error = ?, updated_at = ? WHERE operation_id = ?").run(code, new Date().toISOString(), operationId);
    });
  }

  private markDeadQuietly(row: OutboxRow, code: string): void {
    tx(this.db, () => {
      this.db.prepare("UPDATE outbox SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(code, new Date().toISOString(), row.id);
    });
  }
}
