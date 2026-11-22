import type { HeartbeatSource } from '../../../../../packages/contracts/src/heartbeat.ts';
import { readSnapshot, tx, type Db } from '../../db/connection.ts';
import { genId, sha256Hex } from '../../util/id.ts';
import type { ToolExecContext } from '../../capabilities/contracts.ts';

export const HEARTBEAT_DRAW_TOOL = 'heartbeat_draw';

export function canDrawHeartbeat(db: Db, ctx: ToolExecContext): boolean {
  if (ctx.purpose !== 'cache_keepalive' || !ctx.backgroundRunId || !ctx.turnId) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM heartbeat_runs heartbeat JOIN background_runs run ON run.id=heartbeat.run_id
    WHERE heartbeat.mode='draw' AND run.id=? AND run.conversation_id=? AND run.window_id=?
      AND run.turn_id=? AND run.state='running' AND COALESCE(run.result_code,'') NOT LIKE 'complete:%'
  `).get(ctx.backgroundRunId, ctx.roomId, ctx.windowId, ctx.turnId));
}
export type { HeartbeatSource } from '../../../../../packages/contracts/src/heartbeat.ts';

const CARD_COUNT = 10;
const MAX_CORRECTIONS = 2;
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export type HeartbeatMode = 'unprepared' | 'source_unavailable' | 'draw' | 'exhausted_keepwarm';
export type HeartbeatDeck = { id: string; availableNumbers: number[]; deliveredNumbers: number[]; exhausted: boolean };
export type HeartbeatRun = { businessDate: string; mode: HeartbeatMode; deck: HeartbeatDeck | null };
type DrawPhase = 'claimed' | 'prepared' | 'dispatching' | 'delivered' | 'not_dispatched' | 'unknown';
type DrawRejection = 'invalid_number' | 'used_number' | 'source_unavailable' | 'source_invalid' | 'corrections_exhausted';
export type HeartbeatDraw =
  | { status: 'rejected'; reason: DrawRejection; remainingNumbers: number[]; retryAllowed: boolean }
  | { status: 'inactive' | 'operation_conflict' }
  | { status: 'already_started'; operationId: string; cardNumber: number; phase: DrawPhase }
  | { status: DrawPhase; source: HeartbeatSource; cardNumber: number; providerRequestId: string | null };
export type HeartbeatOperation = { runId: string; operationId: string };
export type HeartbeatSourceCheck = 'ready' | 'invalid' | 'unavailable';
export type HeartbeatDelivery = { outcome: 'delivered'; providerRequestId: string }
  | { outcome: 'not_dispatched' | 'unknown' };
export type ReservedNoteDeliveryStatus = 'undelivered' | 'dispatching' | 'delivered' | 'unknown';

const CONTENT_SOURCES = {
  album: { collection: 'album-entries', owner: 'album_entry' },
  reserved_note: { collection: 'future-notes', owner: 'future_note' },
  moments: { collection: 'posts', owner: 'post' },
  archive: { collection: 'archives', owner: 'conversation_archive' },
} as const;
type ContentSourceKind = keyof typeof CONTENT_SOURCES;

function isContentSourceKind(kind: HeartbeatSource['kind']): kind is ContentSourceKind {
  return Object.hasOwn(CONTENT_SOURCES, kind);
}

export function heartbeatContentSourcePath(source: Pick<HeartbeatSource, 'kind' | 'namespace' | 'id'>): string | null {
  if (source.namespace !== 'content' || !isContentSourceKind(source.kind)) return null;
  return `/api/v1/content/${CONTENT_SOURCES[source.kind].collection}/${encodeURIComponent(source.id)}`;
}

export function heartbeatContentKindAtPath(path: string): ContentSourceKind | undefined {
  const collection = /^\/api\/v1\/content\/([^/]+)\/[^/?]+$/.exec(path)?.[1];
  return (Object.keys(CONTENT_SOURCES) as ContentSourceKind[]).find(kind => CONTENT_SOURCES[kind].collection === collection);
}

export function heartbeatContentKindForOwner(owner: string): ContentSourceKind | undefined {
  return (Object.keys(CONTENT_SOURCES) as ContentSourceKind[]).find(kind => CONTENT_SOURCES[kind].owner === owner);
}

export function heartbeatSourceKeys(source: HeartbeatSource): string[] {
  return source.mediaIdentity ? [source.identity, source.mediaIdentity] : [source.identity];
}

/** Deleting one membership revokes that fixed reference, not every card sharing
 * its underlying media identity. Delivery and historical references survive. */
export function invalidateHeartbeatContentSource(db: Db, kind: ContentSourceKind, id: string): void {
  db.prepare(`UPDATE heartbeat_cards SET invalid_reason='source_deleted'
    WHERE source_kind=? AND json_extract(source_ref_json,'$.namespace')='content'
      AND json_extract(source_ref_json,'$.id')=?`).run(kind, id);
}

type RunRow = {
  run_id: string; deck_id: string | null; business_date: string; mode: HeartbeatMode;
  corrections: number; live: number;
};
type CardRow = {
  deck_id: string; card_number: number; source_identity: string; source_kind: HeartbeatSource['kind'];
  source_ref_json: string; invalid_reason: string | null; first_response_replay: number;
};
type OperationRow = {
  run_id: string; operation_id: string; selection_key: string; deck_id: string | null;
  card_number: number | null; state: DrawPhase | 'rejected'; reason: DrawRejection | null;
  remaining_json: string | null; retry_allowed: number | null; attempted_at: string | null;
  provider_request_id: string | null;
};

/** Cards own frozen references and consumption facts. The existing runner owns transport and result projection. */
export class HeartbeatCards {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly sourceEnabled: (source: HeartbeatSource) => boolean;

  constructor(db: Db, now: () => number = Date.now, sourceEnabled: (source: HeartbeatSource) => boolean = () => true) {
    this.db = db;
    this.now = now;
    this.sourceEnabled = sourceEnabled;
  }

  getDeck(conversationId: string, businessDate: string): HeartbeatDeck | null {
    return readSnapshot(this.db, () => {
      const id = this.deckId(conversationId, businessDate);
      return id ? this.deck(id) : null;
    });
  }

  getRun(runId: string): HeartbeatRun | null {
    const read = () => {
      const run = this.run(runId);
      return run ? this.runView(run) : null;
    };
    return this.db.isTransaction ? read() : readSnapshot(this.db, read);
  }

  getDraw(input: HeartbeatOperation): HeartbeatDraw | null {
    return readSnapshot(this.db, () => {
      const operation = this.operation(input);
      return operation ? this.drawView(operation) : null;
    });
  }

  getDeliveredDraw(runId: string): {
    operationId: string; cardNumber: number; source: HeartbeatSource; providerRequestId: string;
  } | null {
    const row = this.db.prepare(`
      SELECT o.operation_id,o.card_number,o.provider_request_id,c.source_ref_json
      FROM heartbeat_draw_operations o
      JOIN heartbeat_cards c ON c.deck_id=o.deck_id AND c.card_number=o.card_number
      WHERE o.run_id=? AND o.state='delivered'
    `).get(runId) as {
      operation_id: string; card_number: number; provider_request_id: string; source_ref_json: string;
    } | undefined;
    return row ? { operationId: row.operation_id, cardNumber: row.card_number,
      source: JSON.parse(row.source_ref_json) as HeartbeatSource, providerRequestId: row.provider_request_id } : null;
  }

  reservedNoteDeliveryStatus(sourceIdentity: string): ReservedNoteDeliveryStatus {
    const row = this.db.prepare(`
      SELECT o.state FROM heartbeat_draw_operations o
      JOIN heartbeat_cards c ON c.deck_id=o.deck_id AND c.card_number=o.card_number
      WHERE o.source_identity=? AND c.source_kind='reserved_note'
        AND o.state IN ('dispatching','delivered','unknown')
    `).get(sourceIdentity) as { state: Exclude<ReservedNoteDeliveryStatus, 'undelivered'> } | undefined;
    return row?.state ?? 'undelivered';
  }

  isSourceEligible(source: HeartbeatSource): boolean {
    if (!this.sourceEnabled(source)) return false;
    if (source.namespace === 'content' && isContentSourceKind(source.kind)) {
      if (this.db.prepare(`SELECT 1 FROM content_owner_state WHERE owner_type=? AND owner_id=? AND deleted=1`)
        .get(CONTENT_SOURCES[source.kind].owner, source.id)) return false;
      const path = heartbeatContentSourcePath(source);
      if (this.db.prepare(`SELECT 1 FROM outbox WHERE target='content.operation' AND json_extract(payload_ref,'$.method')='DELETE'
        AND json_extract(payload_ref,'$.path')=? AND json_extract(payload_ref,'$.commit_observed')=1`).get(path)) return false;
    }
    return this.sourceEligible(source);
  }

  /** Call inside the conversation serial slot after collecting a complete ordered candidate set. */
  begin(input: { runId: string; businessDate: string; candidates?: readonly HeartbeatSource[] }): HeartbeatRun | null {
    return tx(this.db, () => {
      const existing = this.run(input.runId);
      if (existing) return this.runView(existing);
      const run = this.db.prepare(`
        SELECT conversation_id FROM background_runs
        WHERE id=? AND kind='keepwarm' AND state IN ('claimed','running')
          AND COALESCE(result_code,'') NOT LIKE 'complete:%'
      `).get(input.runId) as { conversation_id: string } | undefined;
      if (!run) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) throw new Error('HEARTBEAT_BUSINESS_DATE_INVALID');
      let deckId = this.deckId(run.conversation_id, input.businessDate);
      const candidates = input.candidates;
      const keys = candidates?.flatMap(heartbeatSourceKeys);
      if (deckId === null && candidates?.length === CARD_COUNT
        && new Set(keys).size === keys?.length
        && candidates.every(source => this.isSourceEligible(source))) {
        deckId = genId('deck');
        this.db.prepare('INSERT INTO heartbeat_decks(id,conversation_id,business_date) VALUES(?,?,?)')
          .run(deckId, run.conversation_id, input.businessDate);
        const insert = this.db.prepare(`
          INSERT INTO heartbeat_cards(deck_id,card_number,source_identity,source_kind,source_ref_json,first_response_replay)
          VALUES(?,?,?,?,?,?)
        `);
        candidates.forEach((source, index) => {
          const { kind, namespace, id, revision, identity, mediaIdentity, permissionScope } = source;
          const replay = kind === 'moments' && source.replay === 'first_reserved_response' ? source.replay : undefined;
          const selection = source.selection ? {
            attachmentIds: source.selection.attachmentIds,
            start: source.selection.start,
            end: source.selection.end,
            voiceTranscriptRevision: source.selection.voiceTranscriptRevision,
          } : undefined;
          insert.run(deckId, index + 1, identity, kind,
            JSON.stringify({ kind, namespace, id, revision, identity, mediaIdentity, permissionScope, selection, replay }), Number(Boolean(replay)));
        });
      }

      const deck = deckId ? this.deck(deckId) : null;
      const mode = deck === null ? 'unprepared' : deck.exhausted ? 'exhausted_keepwarm'
        : deck.availableNumbers.length ? 'draw' : 'source_unavailable';
      this.db.prepare('INSERT INTO heartbeat_runs(run_id,business_date,deck_id,mode) VALUES(?,?,?,?)')
        .run(input.runId, input.businessDate, deckId, mode);
      return { businessDate: input.businessDate, mode, deck };
    });
  }

  claim(input: HeartbeatOperation & { cardNumber: unknown }): HeartbeatDraw {
    return tx(this.db, () => {
      const { cardNumber } = input;
      const selectionKey = typeof cardNumber === 'number' ? String(cardNumber)
        : 'invalid:' + sha256Hex(JSON.stringify(cardNumber) ?? 'undefined');
      const previous = this.operation(input);
      if (previous) return previous.selection_key === selectionKey ? this.drawView(previous) : { status: 'operation_conflict' };
      const run = this.run(input.runId);
      if (!run?.live || run.mode !== 'draw' || run.deck_id === null) return { status: 'inactive' };

      const started = this.db.prepare(`
        SELECT operation_id,card_number,state FROM heartbeat_draw_operations WHERE run_id=?
        AND state IN ('claimed','prepared','dispatching','delivered','unknown')
      `).get(input.runId) as { operation_id: string; card_number: number; state: DrawPhase } | undefined;
      if (started) return { status: 'already_started', operationId: started.operation_id,
        cardNumber: started.card_number, phase: started.state };
      const stopped = this.db.prepare(`
        SELECT 1 FROM heartbeat_draw_operations WHERE run_id=? AND state='rejected' AND retry_allowed=0
      `).get(input.runId);
      if (stopped) return this.reject(run, input.operationId, selectionKey, 'corrections_exhausted');

      if (typeof cardNumber !== 'number' || !Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > CARD_COUNT) {
        return this.reject(run, input.operationId, selectionKey, 'invalid_number');
      }
      const card = this.card(run.deck_id, cardNumber);
      if (!card || card.invalid_reason) return this.reject(run, input.operationId, selectionKey, 'source_invalid');
      if (this.db.prepare(`
        SELECT 1 FROM heartbeat_draw_operations
        WHERE run_id=? AND card_number=? AND state='rejected' AND reason='source_unavailable'
      `).get(input.runId, cardNumber)) return this.reject(run, input.operationId, selectionKey, 'source_unavailable');
      if (this.db.prepare("SELECT 1 FROM heartbeat_draw_operations WHERE deck_id=? AND card_number=? AND state='delivered'")
        .get(run.deck_id, cardNumber)) return this.reject(run, input.operationId, selectionKey, 'used_number');
      if (!this.isSourceEligible(JSON.parse(card.source_ref_json) as HeartbeatSource)) {
        return this.reject(run, input.operationId, selectionKey, 'source_unavailable');
      }
      this.db.prepare(`
        INSERT INTO heartbeat_draw_operations(run_id,operation_id,selection_key,deck_id,card_number,source_identity,state)
        VALUES(?,?,?,?,?,?,'claimed')
      `).run(input.runId, input.operationId, selectionKey, run.deck_id, cardNumber, card.source_identity);
      return this.drawView(this.operation(input)!);
    });
  }

  /** Source adapter verifies authorization, membership and the pinned revision without persisting its content here. */
  recordSource(input: HeartbeatOperation & { result: HeartbeatSourceCheck }): HeartbeatDraw {
    return tx(this.db, () => {
      const operation = this.operation(input);
      if (!operation) return { status: 'inactive' };
      // The last source revalidation can fail after preparation but before
      // dispatch. A harder outcome must never rewrite an in-flight attempt.
      if (operation.state !== 'claimed'
        && (operation.state !== 'prepared' || input.result === 'ready')) return this.drawView(operation);
      const run = this.run(input.runId);
      if (!run?.live) return { status: 'inactive' };
      if (input.result === 'ready') {
        this.db.prepare("UPDATE heartbeat_draw_operations SET state='prepared' WHERE run_id=? AND operation_id=?")
          .run(input.runId, input.operationId);
      } else {
        if (input.result === 'invalid') {
          this.db.prepare("UPDATE heartbeat_cards SET invalid_reason='source_invalid' WHERE deck_id=? AND card_number=?")
            .run(operation.deck_id, operation.card_number);
        }
        this.reject(run, input.operationId, operation.selection_key,
          input.result === 'invalid' ? 'source_invalid' : 'source_unavailable', true);
      }
      return this.drawView(this.operation(input)!);
    });
  }

  /** Mark the existing continuation dispatch after its final source gate, immediately before transport. */
  startDispatch(input: HeartbeatOperation & { providerRequestId: string }): boolean {
    return tx(this.db, () => {
      const operation = this.operation(input);
      const card = operation?.deck_id && operation.card_number ? this.card(operation.deck_id, operation.card_number) : undefined;
      if (!this.run(input.runId)?.live || !operation
        || (operation.state !== 'prepared' && operation.state !== 'dispatching')
        || operation.state === 'prepared' && (!card || card.invalid_reason || !this.sourceEnabled(JSON.parse(card.source_ref_json) as HeartbeatSource))
        || !this.requestCarriedCard(input, false)) return false;
      this.db.prepare(`
        UPDATE heartbeat_draw_operations SET state='dispatching',attempted_at=COALESCE(attempted_at,?)
        WHERE run_id=? AND operation_id=?
      `).run(new Date(this.now()).toISOString(), input.runId, input.operationId);
      return true;
    });
  }

  /** Provider-observed dispatch proves delivery; an uncertain attempt never returns to the pool by timeout. */
  recordDelivery(input: HeartbeatOperation & HeartbeatDelivery): boolean {
    return tx(this.db, () => {
      const operation = this.operation(input);
      if (!operation || operation.state === 'rejected') return false;
      if (operation.state === input.outcome) {
        return input.outcome !== 'delivered' || operation.provider_request_id === input.providerRequestId;
      }
      if (operation.state === 'delivered' || operation.state === 'not_dispatched') return false;
      if (input.outcome === 'delivered') {
        if (operation.state !== 'dispatching' && operation.state !== 'unknown') return false;
        const sentAt = this.requestCarriedCard(input, true);
        if (typeof sentAt !== 'string') return false;
        this.db.prepare(`
          UPDATE heartbeat_draw_operations SET state='delivered',delivered_at=?,provider_request_id=?
          WHERE run_id=? AND operation_id=?
        `).run(sentAt, input.providerRequestId, input.runId, input.operationId);
      } else {
        if (input.outcome === 'unknown' && operation.state !== 'dispatching') return false;
        // No negative provider receipt exists on this path. Once attempted
        // delivery is unknown, absence of a positive receipt is not proof of
        // no send; only the genuine positive evidence path above can settle it.
        if (operation.state === 'unknown') return false;
        // A late timeout or cancellation cannot displace a documented dispatch.
        if (operation.attempted_at && this.deliveredRequest(input)) return false;
        this.db.prepare('UPDATE heartbeat_draw_operations SET state=? WHERE run_id=? AND operation_id=?')
          .run(input.outcome, input.runId, input.operationId);
      }
      return true;
    });
  }

  /** The normal terminal path and startup recovery both settle the open selection by run identity. */
  closeRun(runId: string): void {
    tx(this.db, () => {
      const operation = this.db.prepare(`
        SELECT * FROM heartbeat_draw_operations WHERE run_id=? AND state IN ('claimed','prepared','dispatching')
      `).get(runId) as OperationRow | undefined;
      if (!operation) return;
      if (operation.state === 'dispatching') {
        const request = this.deliveredRequest({ runId, operationId: operation.operation_id });
        if (request) {
          this.db.prepare(`
            UPDATE heartbeat_draw_operations SET state='delivered',delivered_at=?,provider_request_id=?
            WHERE run_id=? AND operation_id=?
          `).run(request.sentAt, request.requestId, runId, operation.operation_id);
          return;
        }
      }
      this.db.prepare(`
        UPDATE heartbeat_draw_operations SET state=?
        WHERE run_id=? AND operation_id=?
      `).run(operation.state === 'dispatching' ? 'unknown' : 'not_dispatched', runId, operation.operation_id);
    });
  }

  hasClaimedDraw(runId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM heartbeat_draw_operations WHERE run_id=? AND card_number IS NOT NULL').get(runId));
  }

  /** Call after normal background-run recovery has classified the interrupted runs. */
  recoverClosedRuns(): void {
    const pending = this.db.prepare(`
      SELECT o.run_id FROM heartbeat_draw_operations o LEFT JOIN background_runs b ON b.id=o.run_id
      WHERE o.state IN ('claimed','prepared','dispatching') AND
        (b.id IS NULL OR b.state NOT IN ('claimed','running') OR b.result_code LIKE 'complete:%')
    `).all() as Array<{ run_id: string }>;
    pending.forEach(row => this.closeRun(row.run_id));
  }

  private run(runId: string): RunRow | undefined {
    return this.db.prepare(`
      SELECT h.*, CASE WHEN b.kind='keepwarm' AND b.state IN ('claimed','running')
        AND COALESCE(b.result_code,'') NOT LIKE 'complete:%' THEN 1 ELSE 0 END AS live
      FROM heartbeat_runs h LEFT JOIN background_runs b ON b.id=h.run_id WHERE h.run_id=?
    `).get(runId) as RunRow | undefined;
  }

  private deckId(conversationId: string, businessDate: string): string | null {
    const row = this.db.prepare('SELECT id FROM heartbeat_decks WHERE conversation_id=? AND business_date=?')
      .get(conversationId, businessDate) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private deck(id: string): HeartbeatDeck {
    const cards = this.db.prepare('SELECT * FROM heartbeat_cards WHERE deck_id=? ORDER BY card_number')
      .all(id) as CardRow[];
    const delivered = this.db.prepare(`
      SELECT o.card_number FROM heartbeat_draw_operations o
      WHERE o.deck_id=? AND o.state='delivered' AND o.provider_request_id IS NOT NULL AND o.delivered_at IS NOT NULL
      ORDER BY o.card_number
    `).all(id) as Array<{ card_number: number }>;
    const deliveredNumbers = delivered.map(row => row.card_number);
    const alreadyDelivered = new Set(deliveredNumbers);
    const availableNumbers = cards.filter(card => !card.invalid_reason && !alreadyDelivered.has(card.card_number)
      && this.isSourceEligible(JSON.parse(card.source_ref_json) as HeartbeatSource)).map(card => card.card_number);
    return { id, availableNumbers, deliveredNumbers, exhausted: cards.length === CARD_COUNT
      && deliveredNumbers.length === CARD_COUNT && deliveredNumbers.every((number, index) => number === index + 1) };
  }

  private runView(run: RunRow): HeartbeatRun {
    return { businessDate: run.business_date, mode: run.mode, deck: run.deck_id ? this.deck(run.deck_id) : null };
  }

  private card(deckId: string, cardNumber: number): CardRow | undefined {
    return this.db.prepare('SELECT * FROM heartbeat_cards WHERE deck_id=? AND card_number=?')
      .get(deckId, cardNumber) as CardRow | undefined;
  }

  private operation(input: HeartbeatOperation): OperationRow | undefined {
    return this.db.prepare('SELECT * FROM heartbeat_draw_operations WHERE run_id=? AND operation_id=?')
      .get(input.runId, input.operationId) as OperationRow | undefined;
  }

  private drawView(operation: OperationRow): HeartbeatDraw {
    if (operation.state === 'rejected') return { status: 'rejected', reason: operation.reason!,
      remainingNumbers: JSON.parse(operation.remaining_json!) as number[], retryAllowed: operation.retry_allowed === 1 };
    const card = this.card(operation.deck_id!, operation.card_number!)!;
    return { status: operation.state, source: JSON.parse(card.source_ref_json) as HeartbeatSource,
      cardNumber: card.card_number, providerRequestId: operation.provider_request_id };
  }

  private reject(run: RunRow, operationId: string, selectionKey: string, reason: DrawRejection, claimed = false): HeartbeatDraw {
    const unavailable = this.db.prepare(`
      SELECT card_number FROM heartbeat_draw_operations
      WHERE run_id=? AND state='rejected' AND reason='source_unavailable' AND card_number IS NOT NULL
    `).all(run.run_id) as Array<{ card_number: number }>;
    const rejectedNumbers = new Set(unavailable.map(row => row.card_number));
    const remainingNumbers = this.deck(run.deck_id!).availableNumbers.filter(number => !rejectedNumbers.has(number));
    const retryAllowed = remainingNumbers.length > 0 && run.corrections < MAX_CORRECTIONS
      && reason !== 'corrections_exhausted';
    if (retryAllowed) this.db.prepare('UPDATE heartbeat_runs SET corrections=corrections+1 WHERE run_id=?').run(run.run_id);
    const recordedReason = run.corrections >= MAX_CORRECTIONS && remainingNumbers.length > 0 ? 'corrections_exhausted' : reason;
    if (claimed) {
      this.db.prepare(`
        UPDATE heartbeat_draw_operations SET state='rejected',reason=?,remaining_json=?,retry_allowed=?
        WHERE run_id=? AND operation_id=?
      `).run(recordedReason, JSON.stringify(remainingNumbers), Number(retryAllowed), run.run_id, operationId);
    } else {
      this.db.prepare(`
        INSERT INTO heartbeat_draw_operations(run_id,operation_id,selection_key,state,reason,remaining_json,retry_allowed)
        VALUES(?,?,?,'rejected',?,?,?)
      `).run(run.run_id, operationId, selectionKey, recordedReason, JSON.stringify(remainingNumbers), Number(retryAllowed));
    }
    return { status: 'rejected', reason: recordedReason, remainingNumbers, retryAllowed };
  }

  private sourceEligible(source: HeartbeatSource): boolean {
    const { kind, identity, mediaIdentity } = source;
    const cutoff = new Date(this.now() - COOLDOWN_MS).toISOString();
    const identityMatch = ['o.source_identity=?'];
    const values = [identity];
    const mediaKey = mediaIdentity ?? (identity.startsWith('mariposa:media:') ? identity : undefined);
    if (mediaKey) {
      identityMatch.push(`o.source_identity=?`, `json_extract(c.source_ref_json,'$.mediaIdentity')=?`);
      values.push(mediaKey, mediaKey);
    }
    if (kind === 'moments' && source.namespace === 'content') {
      // Older image-only posts used their media hash as the primary key.
      identityMatch.push(`(c.source_kind='moments' AND json_extract(c.source_ref_json,'$.namespace')='content'
        AND json_extract(c.source_ref_json,'$.id')=?)`);
      values.push(source.id);
    }
    return !this.db.prepare(`
      SELECT 1 FROM heartbeat_draw_operations o
      JOIN heartbeat_cards c ON c.deck_id=o.deck_id AND c.card_number=o.card_number
      WHERE (${identityMatch.join(' OR ')}) AND (
        o.state IN ('claimed','prepared','dispatching')
        OR (o.state='delivered' AND (?=1 OR c.source_kind='reserved_note' OR (?=0 AND o.delivered_at>?)))
        OR o.state='unknown'
      ) LIMIT 1
    `).get(...values, Number(kind === 'reserved_note'), Number(kind === 'moments' && source.replay === 'first_reserved_response'),
      cutoff);
  }

  private deliveredRequest(input: HeartbeatOperation): { requestId: string; sentAt: string } | null {
    const rows = this.db.prepare(`
      SELECT id FROM provider_requests WHERE background_run_id=? AND purpose='cache_keepalive'
        AND sent_at IS NOT NULL ORDER BY sent_at,id
    `).all(input.runId) as Array<{ id: string }>;
    for (const row of rows) {
      const sentAt = this.requestCarriedCard({ ...input, providerRequestId: row.id }, true);
      if (typeof sentAt === 'string') return { requestId: row.id, sentAt };
    }
    return null;
  }

  private requestCarriedCard(input: HeartbeatOperation & { providerRequestId: string }, requireSent: boolean): string | boolean {
    const request = this.db.prepare(`
      SELECT payload_json,payload_wire_json,sent_at
      FROM provider_requests WHERE id=? AND background_run_id=? AND purpose='cache_keepalive'
        AND dispatch_started_at IS NOT NULL
    `).get(input.providerRequestId, input.runId) as {
      payload_json: string | null; payload_wire_json: string | null; sent_at: string | null;
    } | undefined;
    if (!request || (requireSent && !request.sent_at)) return false;
    // API routes record their wire projection. SDK records the envelope used by
    // its native continuation hook and sets sent_at on actual model start.
    const payload = request.payload_wire_json ?? request.payload_json;
    if (!payload) return false;
    try {
      const envelope = JSON.parse(payload) as {
        messages?: Array<{ role: string; tool_call_id?: string; content?: string | Array<{ type: string; text?: string }> }>;
      };
      const result = envelope.messages?.find(message => message.role === 'tool' && message.tool_call_id === input.operationId);
      const text = typeof result?.content === 'string' ? result.content
        : result?.content?.find(block => block.type === 'text')?.text;
      if (!text) return false;
      const receipt = JSON.parse(text) as { heartbeat_card?: { operation_id?: string; image_count?: number } };
      if (receipt.heartbeat_card?.operation_id !== input.operationId) return false;
      const expectedImages = receipt.heartbeat_card.image_count ?? 0;
      if (!Number.isSafeInteger(expectedImages) || expectedImages < 0 || expectedImages > 4) return false;
      const imageTypes = request.payload_wire_json ? ['image', 'image_url'] : ['asset_image', 'image', 'image_url'];
      if (expectedImages && (!Array.isArray(result?.content)
        || result.content.filter(block => imageTypes.includes(block.type)).length !== expectedImages)) return false;
      return requireSent ? request.sent_at! : true;
    } catch {
      return false;
    }
  }
}
