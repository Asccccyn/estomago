// 原文归档同步（ESTOMAGO_OR_SELF_HOLD §1.2/§8.3 + 生命周期包 §4.1）：
//   用户提交/助手正式发布 → 同事务 outbox（既有生产者）→ 本消费者按稳定 operation_id
//   批量 source.ingest → 远端 ACK 落 source_sync_receipts → outbox acked。
//  - 只投影正式消息（用户消息修订 + 助手已发布气泡）；thinking/工具/控制事件/时间包不进 outbox，天然不在此线。
//  - 幂等：operation_id 由 (会话, 消息@修订 集合) 派生——崩溃重发同 op，服务端重放同 ACK（契约 §4.3）。
//  - 顺序：同流按 outbox 创建序（=Host authoritative sequence），依赖缺失（SOURCE_NOT_READY）停流不跳过。
//  - 未启用（archive.enabled=false 或未配 base_url）→ 不发不删，显示"待同步"语义由读取层承担。
//  - 隐私：错误/事件只记 code/计数/ID，不携正文；本文件不读任何凭据值。
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

type OutboxRow = {
  id: string;
  operation_key: string; // archive:<message_id>:<revision>
  target: string;
  payload_ref: string; // {"message_id":"..."}
  state: string;
  attempt: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sequence: number;
  speaker: string;
  kind: string;
  current_revision: number;
  published_at: string | null;
  turn_id: string | null;
};

type RevisionRow = {
  message_id: string;
  revision: number;
  kind: string;
  content: string;
  content_hash: string;
  occurred_at: string | null;
  received_at: string;
  source: string;
  supersedes_revision: number | null;
};

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

  /** 同步状态快照（记录面板/只读）：正文外的计数与状态 */
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
    if (this.draining) return summary; // 单执行者（房间串行语义在同步层同样成立）
    this.draining = true;
    try {
      await this.drainLocked(summary);
    } finally {
      this.draining = false;
    }
    return summary;
  }

  private async drainLocked(summary: DrainSummary): Promise<void> {
    // 按会话分组、创建序取待同步行。含 unknown_outcome（响应丢失→同 op 重放）与遗留 sent
    // （进程在标记 sent 后崩溃——重启后按同批行重派生同 op 重发，幂等恢复，不换 op 盲建）。
    const rows = this.db.prepare(
      `SELECT o.* FROM outbox o WHERE o.target = 'mariposa.archive' AND o.state IN ('pending','unknown_outcome','sent')
       ORDER BY o.created_at, o.id`,
    ).all() as OutboxRow[];
    if (rows.length === 0) return;

    const byConversation = new Map<string, OutboxRow[]>();
    for (const row of rows) {
      const messageId = this.messageIdOf(row);
      if (!messageId) {
        this.markDead(row, 'PAYLOAD_REF_INVALID', summary);
        continue;
      }
      const msg = this.db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(messageId) as { conversation_id: string } | undefined;
      if (!msg) {
        this.markDead(row, 'LOCAL_MESSAGE_MISSING', summary);
        continue;
      }
      const list = byConversation.get(msg.conversation_id) ?? [];
      list.push(row);
      byConversation.set(msg.conversation_id, list);
    }

    for (const [conversationId, streamRows] of byConversation) {
      let stopped = false;
      let i = 0;
      while (i < streamRows.length && !stopped) {
        const built = this.buildBatch(conversationId, streamRows, i);
        i += built.consumed;
        for (const row of built.deadRows) this.markDead(row, 'OVERSIZED_MESSAGE', summary);
        if (built.request === null) continue; // 本段全是本地坏行/超大行，已被逐行处置
        const outcome = await this.sendBatch(built.request, built.rows);
        summary.batches++;
        if (outcome.kind === 'acked') {
          summary.acked += built.rows.length;
        } else if (outcome.kind === 'retry_later') {
          summary.retry_later += built.rows.length;
          summary.stopped_streams++;
          stopped = true; // 同流有序：前面批次未确认，后面不继续（不跳过）
        } else {
          summary.dead += built.rows.length;
        }
      }
    }
  }

  private messageIdOf(row: OutboxRow): string | null {
    try {
      const v = JSON.parse(row.payload_ref) as { message_id?: unknown };
      return typeof v.message_id === 'string' ? v.message_id : null;
    } catch {
      return null;
    }
  }

  // 从 rows[startIdx] 起累积一个批次：≤50 条且规范化正文合计 ≤1MiB（契约工程初值）。
  // 超出即切批（剩余行下一批，稳定 op 身份分别派生）；单条自身超限才标死（大对象路径不在本任务）。
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
        continue; // 本地坏行：处置后越过（consumed 由 i 推进）
      }
      const msg = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined;
      const rev = this.db.prepare('SELECT * FROM message_revisions WHERE message_id = ? AND revision = ?').get(messageId, revisionNo) as RevisionRow | undefined;
      if (!msg || !rev) {
        this.markDeadQuietly(row, 'LOCAL_ROW_MISSING');
        continue;
      }
      // 字节上限按 UTF-8 实际字节数（契约：不用 JS UTF-16 length 冒充字节数）
      const serializedBytes = Buffer.byteLength(rev.content ?? '', 'utf8');
      if (batchRows.length > 0 && bytes + serializedBytes > INGEST_BATCH_MAX_BYTES) break; // 切批，剩余行下一批
      if (serializedBytes > INGEST_BATCH_MAX_BYTES) {
        deadRows.push(row); // 单条超限：明确报错，不静默截断
        continue;
      }
      // predecessor：同流 sequence-1 消息及其当前修订（服务端链路校验的对象）；本地链断=坏行处置
      const pred = msg.sequence > 1
        ? (this.db.prepare('SELECT id, current_revision FROM messages WHERE conversation_id = ? AND sequence = ?').get(conversationId, msg.sequence - 1) as { id: string; current_revision: number } | undefined)
        : undefined;
      if (msg.sequence > 1 && !pred) {
        this.markDeadQuietly(row, 'LOCAL_CHAIN_MISSING');
        continue;
      }
      bytes += serializedBytes;
      batchRows.push(row);
      messages.push({
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
      });
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

  private async sendBatch(request: IngestRequest, chunk: OutboxRow[]): Promise<{ kind: 'acked' | 'retry_later' | 'dead' }> {
    // 先落 sent（attempt+1）：发送后崩溃 → unknown_outcome 由下一轮同 op 重放恢复
    const now = new Date().toISOString();
    tx(this.db, () => {
      for (const row of chunk) {
        this.db.prepare("UPDATE outbox SET state = 'sent', attempt = attempt + 1, updated_at = ? WHERE id = ?").run(now, row.id);
      }
    });
    let result: Awaited<ReturnType<MariposaClient['sourceIngest']>>;
    try {
      result = await this.client.sourceIngest(request);
    } catch (err) {
      // 网络未知结果：可能已提交（§4.3）——unknown_outcome，同 op 重发由服务端重放，不换 op 盲建
      const code = String((err as Error)?.message ?? err).slice(0, 60);
      this.markChunk(chunk, 'unknown_outcome', `TRANSPORT_UNKNOWN:${code}`);
      this.logger.warn('archive_sync_transport_unknown', { op: request.operation_id, code: 'TRANSPORT_UNKNOWN' });
      return { kind: 'retry_later' };
    }
    if (!result.ok) {
      const cls = classifyError(result.code);
      if (cls === 'retry_later') {
        this.markChunk(chunk, 'pending', result.code);
        this.events.publish('archive.sync', { conversationId: request.origin_conversation_id, entityRef: request.operation_id, scope: 'private', payload: { state: 'retry_later', code: result.code } });
        return { kind: 'retry_later' };
      }
      this.markChunk(chunk, 'failed', result.code);
      this.events.publish('archive.sync', { conversationId: request.origin_conversation_id, entityRef: request.operation_id, scope: 'private', payload: { state: 'failed', code: result.code } });
      this.logger.warn('archive_sync_dead', { op: request.operation_id, code: result.code });
      return { kind: 'dead' };
    }
    const ack = result.ack;
    if (!ack || ack.operation_id !== request.operation_id) {
      this.markChunk(chunk, 'unknown_outcome', 'ACK_SHAPE_INVALID');
      return { kind: 'retry_later' };
    }
    // ACK 落库：远端 source 身份映射（后续 hold/source_selections 使用的正主 ID）与 outbox acked 同事务
    tx(this.db, () => {
      for (const m of ack.messages) {
        this.db.prepare(
          `INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(origin_message_id, revision) DO UPDATE SET source_message_id = excluded.source_message_id, content_hash = excluded.content_hash`,
        ).run(genId('ssr'), ack.operation_id, m.origin_message_id, m.revision, m.source_conversation_id, m.source_message_id, m.content_hash, ack.committed_at, new Date().toISOString());
      }
      for (const row of chunk) {
        this.db.prepare("UPDATE outbox SET state = 'acked', last_error = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
      }
    });
    this.events.publish('archive.sync', { conversationId: request.origin_conversation_id, entityRef: request.operation_id, scope: 'private', payload: { state: 'acked', messages: ack.messages.length, batch_ref: ack.batch_ref } });
    return { kind: 'acked' };
  }

  private markChunk(chunk: OutboxRow[], state: 'pending' | 'failed' | 'unknown_outcome', code: string): void {
    const now = new Date().toISOString();
    tx(this.db, () => {
      for (const row of chunk) {
        this.db.prepare('UPDATE outbox SET state = ?, last_error = ?, updated_at = ? WHERE id = ?').run(state, code.slice(0, 200), now, row.id);
      }
    });
  }

  private markDeadQuietly(row: OutboxRow, code: string): void {
    tx(this.db, () => {
      this.db.prepare("UPDATE outbox SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(code, new Date().toISOString(), row.id);
    });
  }

  private markDead(row: OutboxRow, code: string, summary: DrainSummary): void {
    this.markDeadQuietly(row, code);
    summary.dead++;
  }
}
