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
import { classifyError, ingestOperationId, serverNormalizedBytes, type IngestMessage, type IngestRequest, type MariposaClient } from './client.ts';

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
      (this.db.prepare(`SELECT COUNT(*) n FROM outbox o JOIN messages m ON m.id = CASE WHEN json_valid(o.payload_ref) THEN json_extract(o.payload_ref, '$.message_id') END WHERE o.target = 'mariposa.archive' AND m.conversation_id = ? AND ${where}`).get(conversationId) as { n: number }).n; // F24：坏 JSON 不炸快照
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
    // —— 1) 冻结批次恢复（F09）：已绑批次的行 → 原样字节重放，绝不与新消息重组。
    //     审计 F23：按会话分组、批内按最早成员的来源顺序（不按 op 哈希序）；
    //     未决（retry_later）或本地记录缺失 → 阻断该流后续所有批次（含新批阶段）。
    const frozen = this.db.prepare(
      `SELECT b.operation_id AS op, b.conversation_id AS cid, b.state AS bstate, b.payload_json AS payload,
         (SELECT MIN(o.created_at) FROM outbox o WHERE o.batch_id = b.operation_id) AS first_at
       FROM ingest_batches b
       WHERE EXISTS (SELECT 1 FROM outbox o WHERE o.batch_id = b.operation_id AND o.state IN ('sent','unknown_outcome','pending'))
       ORDER BY first_at`,
    ).all() as Array<{ op: string; cid: string; bstate: string; payload: string; first_at: string | null }>;
    const blockedStreams = new Set<string>();
    const frozenByCid = new Map<string, Array<{ op: string; bstate: string; payload: string }>>();
    for (const b of frozen) {
      const list = frozenByCid.get(b.cid) ?? [];
      list.push({ op: b.op, bstate: b.bstate, payload: b.payload });
      frozenByCid.set(b.cid, list);
    }
    for (const [cid, batches] of frozenByCid) {
      for (const b of batches) {
        if (blockedStreams.has(cid)) break;
        const rows = this.db.prepare("SELECT * FROM outbox WHERE batch_id = ? AND state IN ('sent','unknown_outcome','pending') ORDER BY created_at, id").all(b.op) as OutboxRow[];
        if (b.bstate === 'acked') {
          this.markChunk(rows, 'acked', null);
          continue;
        }
        if (b.bstate === 'dead') {
          this.markChunk(rows, 'failed', 'BATCH_DEAD'); // 终态冲突不阻断后续（前批已了结）
          continue;
        }
        if (b.bstate !== 'in_flight') {
          // 记录缺失/未知批次状态：本地证据不完整 → 行 unknown 并阻断同流（不冒充可继续）
          this.markChunk(rows, 'unknown_outcome', 'BATCH_RECORD_MISSING');
          blockedStreams.add(cid);
          summary.stopped_streams++;
          continue;
        }
        const payload = JSON.parse(b.payload) as IngestRequest;
        const outcome = await this.sendPayload(payload, rows, summary, { operationId: b.op, conversationId: cid });
        summary.batches++;
        if (outcome === 'retry_later') {
          blockedStreams.add(cid); // 同流有序：恢复批未确认，本流后续（含新批）停发
          summary.stopped_streams++;
        }
      }
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
        this.markDeadQuietly(row, 'PAYLOAD_REF_INVALID'); // 审计 F24：坏行按单行隔离处置，不再引用越界 rows
        summary.dead++;
        continue;
      }
      const msg = this.db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(messageId) as { conversation_id: string } | undefined;
      if (!msg) {
        this.markDeadQuietly(row, 'LOCAL_MESSAGE_MISSING');
        summary.dead++;
        continue;
      }
      const list = byConversation.get(msg.conversation_id) ?? [];
      list.push(row);
      byConversation.set(msg.conversation_id, list);
    }
    for (const [conversationId, streamRows] of byConversation) {
      if (blockedStreams.has(conversationId)) continue; // 审计 F23：恢复阶段未决的流不再发新批
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
      // D20（审计 3655d60）：前驱修订取"可达"版本——优先前驱当前修订**仅当**它已同步（有收据）或
      // 在本批更早位置（同批可完成）；否则回退到前驱最新已同步修订（无收据则 revision 1=首批必带）。
      // 否则 >50 条积压+前驱被编辑时，首批引用只在后批才有的修订 → SOURCE_NOT_READY 永久闭锁。
      let predRevForPayload: number | undefined;
      if (pred) {
        const earlierInBatch = batchRows.some((r) => this.messageIdOf(r) === pred.id);
        const predCurrentSynced = !!this.receiptRowOf(pred.id, pred.current_revision);
        predRevForPayload = earlierInBatch || predCurrentSynced
          ? pred.current_revision
          : this.latestSyncedRevision(pred.id) ?? 1;
      }
      const message: IngestMessage = {
        origin_message_id: msg.id,
        revision: rev.revision,
        previous_revision: rev.supersedes_revision,
        conversation_sequence: msg.sequence,
        predecessor: pred ? { origin_message_id: pred.id, revision: predRevForPayload! } : null, // pred 真值 ⇔ 上方 if(pred) 块已赋值（全程 number）
        sender: msg.speaker === 'owner' ? 'user' : 'assistant',
        // D12（审计 3655d60）：宿主内部 kind（text/sticker/voice/system）与领域 published_kind 分开映射——
        // mariposa 现行契约（aa624c9）只收 chat_message；未映射的 kind 原样发出由服务端如实拒绝（不静默转写）
        // D5（她批 2026-10-06 扩展归档合同）：宿主 kind→领域 published_kind
      // 映射；未知 kind 原样发出由服务端如实拒绝（fail-closed 不变）
      published_kind: rev.kind === 'text' ? 'chat_message'
        : rev.kind === 'sticker' ? 'sticker_message'
        : rev.kind === 'voice' ? 'voice_message'
        : rev.kind,
        occurred_at: rev.occurred_at,
        received_at: rev.received_at,
        published_at: msg.published_at,
        text: rev.content,
        assets: [],
        content_hash: rev.content_hash,
      };
      // F16 + D21（审计 3655d60）：按"完整请求信封"的**实际序列化字节**计——不再用固定 166B 常量
      // （scope/origin id 变长时曾放行 >1MiB 请求被服务端拒）。候选入批后序列化整个请求验证，
      // 超限则回退该候选并切批；单条即超限走 dead（明确报错不截断）。
      const candidateRequest = (msgs: IngestMessage[]): IngestRequest => ({
        operation_id: ingestOperationId(conversationId, [...keys, { messageId: msg.id, revision: rev.revision }]),
        stream_id: this.streamId,
        origin_instance: 'estomago',
        origin_conversation_id: conversationId,
        messages: msgs,
      });
      // F-J-12：对齐服务端规范化口径（sort_keys+Python 默认分隔符+无信封包装）——
      // 黄金夹具互证见 tests/unit/joint-audit-b4-contract.test.ts
      const wrapBytes = (req: IngestRequest): number => serverNormalizedBytes(req);
      const candidateBytes = wrapBytes(candidateRequest([...messages, message]));
      if (batchRows.length > 0 && candidateBytes > INGEST_BATCH_MAX_BYTES) break; // 切批（候选留给下一批）
      if (batchRows.length === 0 && candidateBytes > INGEST_BATCH_MAX_BYTES) {
        deadRows.push(row); // 单条连同信封超限：明确报错不截断（大对象路径不在本任务）
        continue;
      }
      bytes = candidateBytes;
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
    const attemptsNow = (this.db.prepare('SELECT attempts FROM ingest_batches WHERE operation_id = ?').get(meta.operationId) as { attempts: number } | undefined)?.attempts ?? 0;
    const exhausted = (): boolean => attemptsNow > INGEST_BATCH_MAX_ATTEMPTS;
    let result: Awaited<ReturnType<MariposaClient['sourceIngest']>>;
    try {
      result = await this.client.sourceIngest(request);
    } catch (err) {
      // 网络未知：可能已提交（§4.3）——unknown_outcome，下一轮按冻结 payload 同 op 重放。
      // 审计 F15：重试预算同样约束未知路径——超限如实 dead，不无限 in_flight。
      const code = String((err as Error)?.message ?? err).slice(0, 60);
      if (exhausted()) {
        this.markChunk(rows, 'failed', 'TRANSIENT_EXHAUSTED');
        this.markBatchDead(meta.operationId, 'TRANSIENT_EXHAUSTED');
        summary.dead += rows.length;
        return 'dead';
      }
      this.markChunk(rows, 'unknown_outcome', `TRANSPORT_UNKNOWN:${code}`);
      this.logger.warn('archive_sync_transport_unknown', { op: meta.operationId, code: 'TRANSPORT_UNKNOWN' });
      summary.retry_later += rows.length;
      return 'retry_later';
    }
    if (!result.ok) {
      const cls = classifyError(result.code, result.httpStatus); // 审计 1005B：传 httpStatus——429/423/50x 按 HTTP 语义判 retry，不再依赖码名字符串匹配
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
    // D18（审计 3655d60）：unknown 类 ACK 异常路径共享同一重试预算——超限走 TRANSIENT_EXHAUSTED dead，
    // 不再无界重复发送（服务端持续回坏 ACK 时 12 次后必须落人工可恢复状态）
    const unknownAck = (code: string): 'retry_later' | 'dead' => {
      if (!exhausted()) {
        this.markChunk(rows, 'unknown_outcome', code);
        summary.retry_later += rows.length;
        return 'retry_later';
      }
      this.markChunk(rows, 'failed', 'TRANSIENT_EXHAUSTED');
      this.markBatchDead(meta.operationId, `TRANSIENT_EXHAUSTED:${code}`);
      this.events.publish('archive.sync', { conversationId: meta.conversationId, entityRef: meta.operationId, scope: 'private', payload: { state: 'failed', code: `TRANSIENT_EXHAUSTED:${code}` } });
      summary.dead += rows.length;
      return 'dead';
    };
    const ack = result.ack;
    if (!ack || ack.operation_id !== request.operation_id) {
      return unknownAck('ACK_SHAPE_INVALID');
    }
    const byKey = new Map(ack.messages.map((m) => [`${m.origin_message_id}@${m.revision}`, m]));
    for (const reqMsg of request.messages) {
      const entry = byKey.get(`${reqMsg.origin_message_id}@${reqMsg.revision}`);
      if (!entry) {
        return unknownAck('ACK_INCOMPLETE'); // 空回执/缺条目：不冒充已同步
      }
      if (entry.content_hash !== null && entry.content_hash !== reqMsg.content_hash) {
        this.markChunk(rows, 'failed', 'ACK_HASH_MISMATCH');
        this.markBatchDead(meta.operationId, 'ACK_HASH_MISMATCH');
        this.events.publish('archive.sync', { conversationId: meta.conversationId, entityRef: meta.operationId, scope: 'private', payload: { state: 'failed', code: 'ACK_HASH_MISMATCH' } });
        summary.dead += rows.length;
        return 'dead';
      }
      // 审计 F10：正式来源证据三件套（来源会话/来源消息/内容 hash）与提交时刻缺一不可——
      // 只带 origin/revision 的骨架回执不算完整 ACK，不冒充已同步
      if (entry.source_conversation_id === null || entry.source_message_id === null || entry.content_hash === null || ack.committed_at === null) {
        return unknownAck('ACK_FIELDS_INCOMPLETE');
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

  /** D20：某 (消息,修订) 是否已有正式来源收据（=已确认同步） */
  private receiptRowOf(messageId: string, revision: number): unknown {
    return this.db.prepare('SELECT 1 FROM source_sync_receipts WHERE origin_message_id = ? AND revision = ?').get(messageId, revision);
  }

  /** D20：该消息最新已同步的修订号（无任何收据→null，调用方回退 revision 1） */
  private latestSyncedRevision(messageId: string): number | null {
    const row = this.db.prepare('SELECT MAX(revision) AS m FROM source_sync_receipts WHERE origin_message_id = ?').get(messageId) as { m: number | null };
    return row?.m ?? null;
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
