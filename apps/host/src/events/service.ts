// 事件层：持久信封（events 表，带 dedupe/lease）+ 可回放流（runtime_stream_events，
// SSE 的唯一事实来源）+ 进程内慢客户端有界订阅（05 §5.3）。
//
// 隐私：payload 里不进签名/密钥；日志只记 ID/状态/计数。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId, newDedupeKey } from '../util/id.ts';
import { makeEnvelope, type EventEnvelope } from '../../../../packages/contracts/src/envelope.ts';

export type StreamEventRow = {
  sequence: number;
  event_id: string;
  stream_id: string;
  kind: string;
  conversation_id: string | null;
  turn_id: string | null;
  attempt_id: string | null;
  entity_ref: string | null;
  entity_revision: number | null;
  scope: string;
  occurred_at: string;
  payload_ref: string;
};

const SUBSCRIBER_QUEUE_LIMIT = 256; // 慢客户端：超限断开，靠 cursor 重连（05 §5.3）

export type SseSubscriber = {
  id: string;
  conversationId: string | null; // null = 全部
  queue: Array<{ sequence: number; kind: string; payload: string; eventRow: StreamEventRow }>;
  overflowed: boolean;
  onOverflow?: () => void;
};

export class EventService {
  readonly streamId: string;
  private subscribers = new Map<string, SseSubscriber>();

  private db: Db;
  constructor(db: Db) {
    this.db = db;
    this.streamId = genId('stream');
  }

  // —— 持久业务信封（幂等：source+dedupe_key 唯一）——
  recordEnvelope(init: {
    type: string;
    source: string;
    dedupeKey?: string;
    conversationId?: string | null;
    payload: unknown;
  }): EventEnvelope {
    const envelope = makeEnvelope({
      id: genId('evt'),
      type: init.type,
      source: init.source,
      dedupe_key: init.dedupeKey ?? newDedupeKey(),
      correlation_id: genId('corr'),
      conversation_id: init.conversationId ?? null,
      payload: init.payload,
    });
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO events(id, type, conversation_id, source, occurred_at, received_at, dedupe_key, state)
           VALUES (?,?,?,?,?,?,?, 'queued')
           ON CONFLICT(source, dedupe_key) DO NOTHING`,
        )
        .run(envelope.id, envelope.type, envelope.conversation_id, envelope.source, envelope.occurred_at, envelope.received_at, envelope.dedupe_key);
    });
    return envelope;
  }

  // —— 可回放流事件：持久化 + 即时分发。返回持久 sequence（前端回放游标）。——
  publish(kind: string, opts: {
    conversationId: string | null;
    turnId?: string | null;
    attemptId?: string | null;
    entityRef?: string | null;
    entityRevision?: number | null;
    scope?: string;
    payload: unknown;
  }): StreamEventRow {
    const eventId = genId('se');
    const occurredAt = new Date().toISOString();
    let row: StreamEventRow;
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO runtime_stream_events(event_id, stream_id, kind, conversation_id, turn_id, attempt_id, entity_ref, entity_revision, scope, occurred_at, payload_ref)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          eventId,
          this.streamId,
          kind,
          opts.conversationId,
          opts.turnId ?? null,
          opts.attemptId ?? null,
          opts.entityRef ?? null,
          opts.entityRevision ?? null,
          opts.scope ?? 'private',
          occurredAt,
          JSON.stringify(opts.payload),
        );
    });
    const seqRow = this.db
      .prepare('SELECT sequence FROM runtime_stream_events WHERE event_id = ?')
      .get(eventId) as { sequence: number };
    row = {
      sequence: seqRow.sequence,
      event_id: eventId,
      stream_id: this.streamId,
      kind,
      conversation_id: opts.conversationId,
      turn_id: opts.turnId ?? null,
      attempt_id: opts.attemptId ?? null,
      entity_ref: opts.entityRef ?? null,
      entity_revision: opts.entityRevision ?? null,
      scope: opts.scope ?? 'private',
      occurred_at: occurredAt,
      payload_ref: JSON.stringify(opts.payload),
    };
    this.dispatch(row);
    return row;
  }

  replay(afterSequence: number, conversationId: string | null, limit = 1000): StreamEventRow[] {
    // 回放只按持久 sequence；同文本不算重放依据（05 §5.2）
    if (conversationId === null) {
      return this.db
        .prepare('SELECT * FROM runtime_stream_events WHERE sequence > ? ORDER BY sequence LIMIT ?')
        .all(afterSequence, limit) as StreamEventRow[];
    }
    return this.db
      .prepare('SELECT * FROM runtime_stream_events WHERE sequence > ? AND conversation_id = ? ORDER BY sequence LIMIT ?')
      .all(afterSequence, conversationId, limit) as StreamEventRow[];
  }

  maxSequence(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS m FROM runtime_stream_events').get() as { m: number };
    return row.m;
  }

  // —— 订阅 ——

  subscribe(conversationId: string | null, onOverflow?: () => void): SseSubscriber {
    const sub: SseSubscriber = { id: genId('sub'), conversationId, queue: [], overflowed: false, onOverflow };
    this.subscribers.set(sub.id, sub);
    return sub;
  }

  unsubscribe(sub: SseSubscriber): void {
    this.subscribers.delete(sub.id);
  }

  private dispatch(row: StreamEventRow): void {
    for (const sub of this.subscribers.values()) {
      if (sub.conversationId !== null && row.conversation_id !== null && row.conversation_id !== sub.conversationId) continue;
      if (sub.queue.length >= SUBSCRIBER_QUEUE_LIMIT) {
        sub.overflowed = true;
        sub.onOverflow?.();
        continue;
      }
      sub.queue.push({ sequence: row.sequence, kind: row.kind, payload: row.payload_ref, eventRow: row });
    }
  }
}
