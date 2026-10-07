// 事件层 v0.2.2（AUD-14/29 配合）：persist（可在调用方事务内）与 dispatch（提交后内存分发）分离。
// publish = tx{persist} + dispatch；reasoning 等需要原子性的调用方在自有事务里用
// persistInTx + dispatchRow，保证"投影与回放事件同事务提交"（AUD-14）。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId, newDedupeKey } from '../util/id.ts';
import type { EventEnvelope } from '../../../../packages/contracts/src/envelope.ts';

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

const SUBSCRIBER_QUEUE_LIMIT = 256; // 慢客户端：超限断开，靠游标重连（05 §5.3）

export type SseSubscriber = {
  id: string;
  conversationId: string | null;
  queue: Array<{ sequence: number; kind: string; payload: string; eventRow: StreamEventRow }>;
  overflowed: boolean;
  onOverflow?: () => void;
};

export class EventService {
  readonly streamId: string;
  private db: Db;
  private subscribers = new Map<string, SseSubscriber>();

  constructor(db: Db) {
    this.db = db;
    this.streamId = genId('stream');
  }

  // D7（她批 2026-10-06"剩下的都做了"）：recordEnvelope+events 表已退役
  // （全仓零调用、零读者——联合审计 Q1 实证死链）；迁移 v15 DROP 表。
  

  // —— 在调用方已有事务内持久（不自己开 tx；AUD-14 原子性的关键）——
  persistInTx(kind: string, opts: {
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
    const seqRow = this.db.prepare('SELECT sequence FROM runtime_stream_events WHERE event_id = ?').get(eventId) as { sequence: number };
    return {
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
  }

  // —— 提交后分发（内存）——
  dispatchRow(row: StreamEventRow): void {
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

  // 常规发布：单事件事务 + 分发
  publish(kind: string, opts: Parameters<EventService['persistInTx']>[1]): StreamEventRow {
    const row = tx(this.db, () => this.persistInTx(kind, opts));
    this.dispatchRow(row);
    return row;
  }

  replayPage(afterSequence: number, conversationId: string | null, limit = 1000): StreamEventRow[] {
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

  subscribe(conversationId: string | null, onOverflow?: () => void): SseSubscriber {
    const sub: SseSubscriber = { id: genId('sub'), conversationId, queue: [], overflowed: false, onOverflow };
    this.subscribers.set(sub.id, sub);
    return sub;
  }

  unsubscribe(sub: SseSubscriber): void {
    this.subscribers.delete(sub.id);
  }
}
