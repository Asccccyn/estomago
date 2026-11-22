import type { HeartbeatProjection, HeartbeatSource } from '../../../../../packages/contracts/src/heartbeat.ts';
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityRegistry } from '../../capabilities/registry.ts';
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';
import { tx, type Db } from '../../db/connection.ts';
import type { EventService, StreamEventRow } from '../../events/service.ts';
import { contentForward, type ContentClient } from '../../integrations/content/client.ts';
import { CONTENT_OPERATION_TARGET } from '../../integrations/content/coordinator.ts';
import { recoverMomentEdits } from '../../integrations/content/moment-edit-outbox.ts';
import type { MediaService } from '../../media/assets.ts';
import type { MessageService } from '../../messages/service.ts';
import type { ManifestEntry } from '../../context/review-policy.ts';
import { ContractError } from '../../runtime/or-contract.ts';
import type { OrMessage } from '../../runtime/or-payload.ts';
import { readTurnCompletion } from '../../runtime/turn-completion.ts';
import { genId } from '../../util/id.ts';
import type { ArchiveService } from '../archives/service.ts';
import { OidoSourceRepository } from '../oido/source-repository.ts';
import { canDrawHeartbeat, heartbeatContentKindAtPath, heartbeatContentSourcePath, HEARTBEAT_DRAW_TOOL, HeartbeatCards, type HeartbeatMode } from './service.ts';
import { HeartbeatSources } from './sources.ts';
import { heartbeatActions } from './actions.ts';

export { HEARTBEAT_DRAW_TOOL } from './service.ts';
const PROJECTION_TARGET = 'content_heartbeat_projection';
const DRAW_RULES = '当天固定同一副十张牌，已用的号码不可再抽，每个逻辑回合最多抽一张。';

export function heartbeatBusinessDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function plainText(message: OrMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content?.map(block => block.type === 'text' ? block.text : '').join('') ?? '';
}

function cardOperations(messages: OrMessage[]): string[] {
  return messages.flatMap(message => {
    if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') return [];
    const text = plainText(message);
    if (!text.includes('"heartbeat_card"')) return [];
    try {
      const result = JSON.parse(text) as { heartbeat_card?: { operation_id?: string } };
      return result.heartbeat_card?.operation_id === message.tool_call_id ? [message.tool_call_id] : [];
    } catch { return []; }
  });
}

type HeartbeatFinish = {
  runId: string;
  conversationId: string;
  turnId: string;
  attemptId: string;
  hostText: string;
  finalMessages: OrMessage[];
  responseOffset?: number;
  mode: HeartbeatMode;
  completed: boolean;
  hadSent: boolean;
  terminal?: NonNullable<HeartbeatProjection['terminal']>;
};

export class HeartbeatRuntime {
  private readonly db: Db;
  private readonly content: ContentClient | null;
  private readonly media: MediaService;
  private readonly messages: MessageService;
  private readonly events: EventService;
  readonly cards: HeartbeatCards;
  readonly sources: HeartbeatSources;
  private readonly liveImages = new Map<string, { conversationId: string; ids: string[] }>();
  private readonly sourceGates = new Map<string, Promise<void>>();

  constructor(
    db: Db,
    content: ContentClient | null,
    media: MediaService,
    archives: ArchiveService,
    messages: MessageService,
    events: EventService,
    external?: ConstructorParameters<typeof HeartbeatSources>[4],
  ) {
    this.db = db;
    this.content = content;
    this.media = media;
    this.messages = messages;
    this.events = events;
    this.sources = new HeartbeatSources(content, media, archives, messages, { ...external, voice: new OidoSourceRepository(db) });
    this.cards = new HeartbeatCards(db, Date.now, source => this.sources.candidateEnabled(source));
  }

  async begin(input: { runId: string; conversationId: string; windowId: string; signal: AbortSignal; retainedMessages: OrMessage[] }): Promise<{
    mode: HeartbeatMode; hostText: string; unavailable?: HeartbeatSource['kind'][];
  }> {
    const businessDate = heartbeatBusinessDate();
    const unavailable: HeartbeatSource['kind'][] = [];
    const candidates = this.cards.getDeck(input.conversationId, businessDate) ? undefined
      : await this.sources.choose(input.conversationId, source => this.cards.isSourceEligible(source),
        AbortSignal.any([input.signal, AbortSignal.timeout(2800)]), unavailable, businessDate);
    if (input.signal.aborted) return { mode: 'unprepared', hostText: '' };
    const run = this.cards.begin({ runId: input.runId, businessDate, candidates });
    if (!run || run.mode === 'unprepared' || run.mode === 'source_unavailable') {
      return { mode: run?.mode ?? 'unprepared', hostText: '', unavailable };
    }
    if (run.mode === 'exhausted_keepwarm') {
      return { mode: run.mode, hostText: '[心跳唤醒] 今天十张牌已经全部交付。请回复 1 保温。' };
    }
    // A provider send may survive an interruption without becoming part of the
    // retained history. Shorten only when the actual outgoing context still
    // contains this day's earlier full invitation.
    const previous = this.db.prepare(`
      SELECT revision.content FROM heartbeat_runs frozen JOIN background_runs run ON run.id=frozen.run_id
      JOIN messages message ON message.turn_id=run.turn_id AND message.speaker='system'
        AND message.client_message_id='heartbeat:'||run.id||':invite'
      JOIN message_revisions revision ON revision.message_id=message.id AND revision.revision=1
      WHERE frozen.business_date=? AND frozen.mode='draw' AND run.window_id=? AND run.id<>?
        AND revision.source='heartbeat_host' AND instr(revision.content,?) > 0
        AND EXISTS (SELECT 1 FROM provider_requests req WHERE req.background_run_id=run.id AND req.sent_at IS NOT NULL)
    `).all(run.businessDate, input.windowId, input.runId, DRAW_RULES) as Array<{ content: string }>;
    const retained = input.retainedMessages.filter(message => message.role === 'user').map(plainText);
    const hasChoiceContext = previous.some(({ content }) =>
      retained.some(text => text === content || text.startsWith(content + '\n')));
    const hostText = [
      '[心跳唤醒] 想和乔乔说话，还是抽一张盲盒？',
      '想说话：直接写一条给她的聊天消息并结束，这轮不抽卡。',
      `想抽盲盒：用 heartbeat_draw 选一个可用号码，需要时先查看工具定义。可选号：${run.deck!.availableNumbers.join('、')}。${hasChoiceContext ? '' : DRAW_RULES}抽到后可以回应卡面，也可以安静结束。`,
    ].join('\n');
    this.db.prepare('UPDATE heartbeat_runs SET invite_text=COALESCE(invite_text,?) WHERE run_id=?').run(hostText, input.runId);
    return { mode: run.mode, hostText };
  }

  async draw(cardNumber: unknown, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!ctx.backgroundRunId || !ctx.toolCallId || !canDrawHeartbeat(this.db, ctx)) {
      return { ok: false, output: { error_code: 'HEARTBEAT_DRAW_NOT_ACTIVE' } };
    }
    const operation = { runId: ctx.backgroundRunId, operationId: ctx.toolCallId };
    let result = this.cards.claim({ ...operation, cardNumber });
    if (result.status === 'claimed' || result.status === 'prepared') {
      const signal = AbortSignal.any([ctx.signal ?? new AbortController().signal, AbortSignal.timeout(2000)]);
      const payload = await this.sources.resolve(result.source, ctx.roomId, signal);
      const fits = payload.status === 'available' && Buffer.byteLength(payload.text) <= Math.min(16000, ctx.remainingResultBytes?.() ?? Infinity)
        && payload.imageIds.length <= 4;
      result = this.cards.recordSource({ ...operation, result: fits ? 'ready'
        : payload.status === 'unavailable' || payload.status === 'available' ? 'unavailable' : 'invalid' });
      if (result.status === 'prepared' && payload.status === 'available' && fits) {
        if (payload.imageIds.length) this.liveImages.set(operation.runId, { conversationId: ctx.roomId, ids: payload.imageIds });
        return { ok: true, output: { heartbeat_card: { operation_id: operation.operationId, card_number: result.cardNumber,
          source_kind: result.source.kind, text: payload.text, instruction_authority: 'none',
          ...(result.source.kind === 'wishstar' && result.source.namespace === 'superposition' ? { reply_ref: operation.operationId } : {}),
          image_count: payload.imageIds.length } }, ...(payload.imageIds.length ? { imageRefs: payload.imageIds } : {}) };
      }
    }
    if (result.status === 'rejected') {
      return { ok: false, output: { error_code: result.reason.toUpperCase(), remaining_numbers: result.remainingNumbers, retry_allowed: result.retryAllowed } };
    }
    if (result.status === 'already_started') {
      return { ok: false, output: { error_code: 'HEARTBEAT_DRAW_ALREADY_STARTED',
        heartbeat_draw_receipt: { operation_id: result.operationId, card_number: result.cardNumber, delivery_state: result.phase } } };
    }
    if ('cardNumber' in result) {
      const receipt = { heartbeat_draw_receipt: {
        operation_id: operation.operationId, card_number: result.cardNumber, delivery_state: result.status,
      } };
      if (result.status === 'delivered') return { ok: true, output: receipt };
      return { ok: false, output: { ...receipt, error_code: 'HEARTBEAT_DRAW_' + result.status.toUpperCase() } };
    }
    return { ok: false, output: { error_code: 'HEARTBEAT_DRAW_' + result.status.toUpperCase() } };
  }

  async beforeDispatch(runId: string, providerRequestId: string, messages: OrMessage[], signal: AbortSignal): Promise<void> {
    for (const message of messages) {
      if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
      const draw = this.cards.getDraw({ runId, operationId: message.tool_call_id });
      if (draw?.status === 'rejected' && !draw.retryAllowed) throw new ContractError('HEARTBEAT_CORRECTIONS_EXHAUSTED');
    }
    for (const operationId of cardOperations(messages)) {
      const operation = { runId, operationId };
      const deck = this.cards.getDraw(operation);
      if (deck?.status === 'dispatching') throw new ContractError('HEARTBEAT_CARD_DISPATCH_UNKNOWN');
      if (!deck || deck.status !== 'prepared') continue;
      const run = this.db.prepare('SELECT conversation_id FROM background_runs WHERE id=?').get(runId) as { conversation_id: string } | undefined;
      const recheck = async (): Promise<void> => {
        const payload = run ? await this.sources.resolve(deck.source, run.conversation_id, signal) : { status: 'unavailable' as const };
        if (payload.status !== 'available' || signal.aborted) {
          if (payload.status === 'deleted' || payload.status === 'forbidden' || payload.status === 'revision_unavailable') {
            this.cards.recordSource({ ...operation, result: 'invalid' });
          }
          this.cards.recordDelivery({ ...operation, outcome: 'not_dispatched' });
          throw new ContractError('HEARTBEAT_SOURCE_INVALID_BEFORE_DISPATCH');
        }
        if (!this.cards.startDispatch({ ...operation, providerRequestId })) throw new ContractError('HEARTBEAT_DISPATCH_NOT_ADMITTED');
      };
      const path = heartbeatContentSourcePath(deck.source);
      if (path) {
        await this.guardSourceMutation(path, async () => {
          // A timed-out source deletion can still be completing. Wait for its
          // authoritative result instead of dispatching from a racing read.
          const unresolvedDeletion = this.db.prepare(`
            SELECT 1 FROM outbox WHERE target=? AND state IN ('pending','unknown_outcome')
              AND json_extract(payload_ref,'$.method')='DELETE' AND json_extract(payload_ref,'$.path')=? LIMIT 1
          `).get(CONTENT_OPERATION_TARGET, path);
          if (unresolvedDeletion) {
            this.cards.recordDelivery({ ...operation, outcome: 'not_dispatched' });
            throw new ContractError('HEARTBEAT_SOURCE_DELETE_PENDING');
          }
          await recheck();
        });
      } else {
        await recheck();
      }
    }
  }

  async guardSourceMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
    if (!heartbeatContentKindAtPath(path)) return operation();
    const prior = this.sourceGates.get(path) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.sourceGates.set(path, next);
    try {
      await prior;
      return await operation();
    } finally {
      release();
      if (this.sourceGates.get(path) === next) this.sourceGates.delete(path);
    }
  }

  async replyTarget(ref: string, ctx: ToolExecContext): Promise<HeartbeatSource | null> {
    if (!ctx.backgroundRunId || !canDrawHeartbeat(this.db, ctx)) return null;
    const draw = this.cards.getDeliveredDraw(ctx.backgroundRunId);
    if (!draw || draw.operationId !== ref || draw.source.kind !== 'wishstar'
      || draw.source.namespace !== 'superposition' || draw.source.permissionScope !== ctx.roomId) return null;
    const signal = AbortSignal.any([ctx.signal ?? new AbortController().signal, AbortSignal.timeout(2000)]);
    const source = await this.sources.resolve(draw.source, ctx.roomId, signal);
    return source.status === 'available' && !signal.aborted ? draw.source : null;
  }

  observeDelivery(runId: string, providerRequestId: string, messages: OrMessage[], hostText?: string): void {
    const run = this.db.prepare(`SELECT b.conversation_id,b.turn_id,a.id AS attempt_id
      FROM background_runs b JOIN attempts a ON a.turn_id=b.turn_id WHERE b.id=?`).get(runId) as
      { conversation_id: string; turn_id: string; attempt_id: string } | undefined;
    const mode = this.cards.getRun(runId)?.mode;
    if (run && (mode === 'draw' || mode === 'exhausted_keepwarm') && hostText) {
      this.publishObserved(runId, run, 'invite', hostText);
    }
    for (const operationId of cardOperations(messages)) {
      this.cards.recordDelivery({ runId, operationId, outcome: 'delivered', providerRequestId });
    }
    const delivered = this.cards.getDeliveredDraw(runId);
    if (run && mode === 'draw' && delivered) {
      this.publishObserved(runId, run, 'card', `[心跳唤醒] 揭开了 ${delivered.cardNumber} 号牌。`);
    }
  }

  private publishObserved(runId: string, run: { conversation_id: string; turn_id: string; attempt_id: string },
    part: 'invite' | 'card', content: string): void {
    const scope = { runId, conversationId: run.conversation_id, turnId: run.turn_id, attemptId: run.attempt_id };
    const { event } = tx(this.db, () => this.publishInTx(scope, part, content));
    if (event) this.events.dispatchRow(event);
  }

  private publishInTx(scope: Pick<HeartbeatFinish, 'runId' | 'conversationId' | 'turnId' | 'attemptId'>,
    part: Parameters<MessageService['publishHeartbeatInTx']>[0]['part'], content: string) {
    const { runId, conversationId, turnId, attemptId } = scope;
    const existing = this.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND client_message_id=?')
      .get(conversationId, `heartbeat:${runId}:${part}`);
    const message = this.messages.publishHeartbeatInTx({ runId, conversationId, turnId, part, content });
    const event = existing ? null : this.events.persistInTx('message.published', { conversationId,
      turnId, attemptId, entityRef: message.id, entityRevision: 1, payload: { message } });
    return { message, event };
  }

  /** Publish only complete main-channel text from the current response, in wire order. */
  publishRepliesInTx(scope: Pick<HeartbeatFinish, 'runId' | 'conversationId' | 'turnId' | 'attemptId'>,
    tail: OrMessage[], start: number): { manifest: ManifestEntry[]; eventRows: StreamEventRow[] } {
    const manifest: ManifestEntry[] = [];
    const eventRows: StreamEventRow[] = [];
    for (const [offset, packet] of tail.entries()) {
      if (packet.role !== 'assistant') continue;
      const text = plainText(packet);
      if (!text.trim()) continue;
      const { message, event } = this.publishInTx(scope, `reply:${start + offset}`, text);
      manifest.push({ id: message.id, revision: 1, seq: message.sequence, origin: 'dialogue', visible: true });
      if (event) eventRows.push(event);
    }
    return { manifest, eventRows };
  }

  closeProtocol(runId: string, messages: OrMessage[], _sentMessages: OrMessage[] | null): void {
    this.liveImages.delete(runId);
    // Media projection can replace the original card result with an error.
    // The draw ledger, not the presence of card text in the final packet, owns settlement.
    this.cards.closeRun(runId);
    for (const operationId of cardOperations(messages)) {
      const operation = { runId, operationId };
      const draw = this.cards.getDraw(operation);
      if (!draw || draw.status === 'delivered') continue;
      const index = messages.findIndex(message => message.role === 'tool' && message.tool_call_id === operationId);
      if (index >= 0) messages[index] = {
        ...messages[index]!,
        content: JSON.stringify({ error_code: 'HEARTBEAT_CARD_NOT_CONFIRMED', delivery: draw.status === 'unknown' ? 'unknown' : 'not_dispatched' }),
      };
    }
  }

  readImage(assetId: string, conversationId: string, runId?: string): ReturnType<MediaService['readContentResolvingMaster']> | null {
    const live = runId ? this.liveImages.get(runId) : undefined;
    if (live?.conversationId === conversationId && live.ids.includes(assetId)) {
      return this.media.readContentResolvingMaster(assetId, { modelImage: true });
    }
    const delivered = this.db.prepare(`
      SELECT 1 FROM heartbeat_draw_operations draw
      JOIN background_runs run ON run.id=draw.run_id
      JOIN provider_requests request ON request.id=draw.provider_request_id
      JOIN json_each(request.payload_json, '$.messages') message
      JOIN json_each(CASE WHEN json_type(message.value,'$.content')='array'
        THEN json_extract(message.value,'$.content') ELSE '[]' END) block
      WHERE run.conversation_id=? AND draw.state='delivered' AND request.sent_at IS NOT NULL
        AND json_extract(message.value,'$.tool_call_id')=draw.operation_id
        AND json_extract(block.value,'$.type')='asset_image' AND json_extract(block.value,'$.asset_id')=? LIMIT 1
    `).get(conversationId, assetId);
    return delivered ? this.media.readContentResolvingMaster(assetId, { modelImage: true }) : null;
  }

  hasUnknownDelivery(runId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM heartbeat_draw_operations WHERE run_id=? AND state='unknown' LIMIT 1").get(runId));
  }

  async cardForDisplay(runId: string, conversationId: string) {
    const draw = this.cards.getDeliveredDraw(runId);
    if (!draw || draw.source.permissionScope !== conversationId) return null;
    const resolved = await this.sources.resolve(draw.source, conversationId, AbortSignal.timeout(1800), 'qiaosheng', 'history');
    return resolved.status === 'available'
      ? { status: resolved.status, text: resolved.text, asset_ids: resolved.assetIds }
      : { status: resolved.status };
  }

  commitInTx(input: HeartbeatFinish): { manifest: ManifestEntry[]; eventRows: StreamEventRow[] } {
    const eventRows: StreamEventRow[] = [];
    const manifest: ManifestEntry[] = [];
    const result = { eventRows, manifest };
    if (!input.hadSent) return result;
    const run = this.cards.getRun(input.runId);
    if (!run || run.mode !== input.mode) return result;
    const last = input.finalMessages.at(-1);
    const text = input.completed && last?.role === 'assistant' ? plainText(last) : '';
    const publish = (part: Parameters<MessageService['publishHeartbeatInTx']>[0]['part'], content: string): void => {
      const { message, event } = this.publishInTx(input, part, content);
      if (part === 'ack') {
        manifest.push({ id: message.id, revision: 1, seq: message.sequence, origin: 'dialogue', visible: true });
      }
      if (event) eventRows.push(event);
    };
    publish('invite', input.hostText);
    if (run.mode === 'exhausted_keepwarm') {
      if (text.trim() === '1') publish('ack', text);
      return result;
    }
    if (run.mode !== 'draw') return result;
    const delivered = this.cards.getDeliveredDraw(input.runId);
    if (delivered) publish('card', `[心跳唤醒] 揭开了 ${delivered.cardNumber} 号牌。`);
    if (input.completed && input.responseOffset !== undefined && last?.role === 'assistant'
        && !(Array.isArray(last.tool_calls) && last.tool_calls.length)) {
      const speech = this.publishRepliesInTx(input, input.finalMessages.slice(input.responseOffset), input.responseOffset);
      manifest.push(...speech.manifest);
      eventRows.push(...speech.eventRows);
    }
    const talked = input.completed && !delivered && Boolean(this.db.prepare(`SELECT 1 FROM messages
      WHERE turn_id=? AND speaker='assistant' AND client_message_id LIKE ?`).get(input.turnId, `heartbeat:${input.runId}:reply:%`));
    const decline = input.completed && !delivered && !talked && !this.cards.hasClaimedDraw(input.runId)
      && readTurnCompletion(this.db, input.attemptId, input.turnId) === 'noop';
    if (decline) publish('decline', '[心跳唤醒] 本轮未抽卡');
    const actions = heartbeatActions(this.db, input.runId);
    const refs = this.db.prepare(`
      SELECT id, current_revision, sequence, speaker, client_message_id FROM messages WHERE turn_id=? AND published_at IS NOT NULL ORDER BY sequence
    `).all(input.turnId) as Array<{ id: string; current_revision: number; sequence: number; speaker: string; client_message_id: string | null }>;
    const revealSequence = refs.find(message => message.client_message_id === `heartbeat:${input.runId}:card`)?.sequence;
    const afterReveal = revealSequence === undefined ? [] : refs.filter(message => message.speaker === 'assistant' && message.sequence > revealSequence);
    const projectionRef = (message: typeof refs[number]) => ({ messageId: message.id, revision: message.current_revision, sequence: message.sequence });
    const projection: HeartbeatProjection = {
      mode: 'draw', conversationId: input.conversationId, businessDate: run.businessDate, version: 2,
      state: delivered ? refs.some(message => message.speaker === 'assistant') ? 'drawn' : 'drawn_no_comment'
        : talked ? 'talked' : decline ? 'declined' : 'interrupted',
      card: delivered ? { number: delivered.cardNumber, source: delivered.source } : null,
      messages: refs.map(projectionRef),
      ...(delivered?.source.kind === 'reserved_note' ? { reservedReplyMessages: afterReveal.map(projectionRef) } : {}),
      actions,
      terminal: decline ? { status: 'declined' } : input.terminal ?? { status: input.completed ? 'completed' : 'failed' },
    };
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO outbox(id,operation_key,target,payload_ref,state,created_at,updated_at)
      VALUES(?,?,?,?, 'pending',?,?)
    `).run(genId('ob'), `heartbeat-moment:${input.runId}`, PROJECTION_TARGET, JSON.stringify(projection), now, now);
    return result;
  }

  dispatchEvents(rows: StreamEventRow[]): void {
    rows.forEach(row => this.events.dispatchRow(row));
  }

  recoverClosedRuns(): void {
    this.cards.recoverClosedRuns();
    // A process can stop after a confirmed source write but before model
    // completion. Preserve the already-observed business and display facts,
    // not a fabricated protocol continuation or a new model request.
    const rows = this.db.prepare(`SELECT h.run_id,h.invite_text,b.conversation_id,b.turn_id,b.state,a.id AS attempt_id
      FROM heartbeat_runs h JOIN background_runs b ON b.id=h.run_id JOIN attempts a ON a.turn_id=b.turn_id
      WHERE h.mode='draw' AND h.invite_text IS NOT NULL AND b.state NOT IN ('claimed','running','cancelling')
        AND EXISTS (SELECT 1 FROM provider_requests p WHERE p.background_run_id=b.id AND p.sent_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.operation_key='heartbeat-moment:'||h.run_id)`).all() as
      Array<{ run_id: string; invite_text: string; conversation_id: string; turn_id: string; state: string; attempt_id: string }>;
    for (const row of rows) {
      const recovered = tx(this.db, () => this.commitInTx({
        runId: row.run_id, hostText: row.invite_text, conversationId: row.conversation_id, turnId: row.turn_id,
        attemptId: row.attempt_id, mode: 'draw', hadSent: true, finalMessages: [], completed: false,
        terminal: { status: row.state === 'cancelled' ? 'cancelled' : row.state === 'failed' ? 'failed' : 'unknown' },
      }));
      this.dispatchEvents(recovered.eventRows);
    }
  }

  status(conversationId: string) {
    const date = heartbeatBusinessDate();
    const deck = this.cards.getDeck(conversationId, date);
    const daily = this.db.prepare(`SELECT selected_at FROM heartbeat_daily_memory_choices WHERE conversation_id=? AND business_date=?`)
      .get(conversationId,date) as {selected_at:string}|undefined;
    const dailyRun = this.db.prepare(`SELECT state,result_code FROM background_runs WHERE conversation_id=? AND kind='heartbeat_memory' AND scheduled_for=?
      ORDER BY created_at DESC,id DESC LIMIT 1`).get(conversationId,new Date(date+'T00:00:00+08:00').toISOString()) as {state:string;result_code:string|null}|undefined;
    const available = deck?.availableNumbers ?? [];
    const delivered = deck?.deliveredNumbers ?? [];
    return {
      date, mode: !deck ? 'unprepared' : deck.exhausted ? 'exhausted_keepwarm' : available.length ? 'draw' : 'source_unavailable',
      daily_memory: daily ? {state:'selected',selected_at:daily.selected_at} : {state:dailyRun?.state ?? 'unprepared',reason:dailyRun?.result_code ?? null},
      available_numbers: available, delivered_numbers: delivered,
      source_unavailable_numbers: deck ? Array.from({ length: 10 }, (_, index) => index + 1)
        .filter(number => !available.includes(number) && !delivered.includes(number)) : [],
    };
  }

  noteStatus(id: string, conversationId: string, sourceDeleted = false) {
    if (sourceDeleted) this.db.prepare(`
      UPDATE heartbeat_cards SET invalid_reason='source_deleted'
      WHERE source_kind='reserved_note' AND source_identity=?
    `).run('content:reserved_note:' + id);
    const state = this.cards.reservedNoteDeliveryStatus('content:reserved_note:' + id);
    const date = heartbeatBusinessDate();
    const card = this.db.prepare(`
      SELECT c.card_number,c.invalid_reason,json_extract(c.source_ref_json,'$.revision') AS revision
      FROM heartbeat_decks d JOIN heartbeat_cards c ON c.deck_id=d.id
      WHERE d.conversation_id=? AND d.business_date=? AND c.source_kind='reserved_note' AND c.source_identity=?
    `).get(conversationId, date, 'content:reserved_note:' + id) as { card_number: number; invalid_reason: string | null; revision: number } | undefined;
    return {
      delivery_state: state === 'undelivered' ? 'pending' : state,
      ...(card ? { frozen_card: { number: card.card_number, revision: card.revision, available: card.invalid_reason === null } } : {}),
    };
  }

  async recoverProjections(limit: number): Promise<void> {
    if (!this.content) return;
    const rows = this.db.prepare(`
      SELECT id,operation_key,payload_ref,attempt FROM outbox
      WHERE target=? AND state IN ('pending','unknown_outcome') ORDER BY created_at LIMIT ?
    `).all(PROJECTION_TARGET, limit) as Array<{ id: string; operation_key: string; payload_ref: string; attempt: number }>;
    for (const row of rows) {
      let state = 'unknown_outcome';
      try {
        const response = await contentForward(this.content, { method: 'PUT', actor: 'qiaosheng',
          path: '/internal/heartbeat-projections/' + encodeURIComponent(row.operation_key.slice('heartbeat-moment:'.length)),
          body: JSON.parse(row.payload_ref), timeoutMs: 1500 });
        if (response.status === 200 && !response.bodyFailed) state = 'acked';
        else if ([400, 403, 409, 422].includes(response.status)) state = 'failed';
      } catch { /* retain the same operation for the bounded recovery worker */ }
      if (state === 'unknown_outcome' && row.attempt >= 4) state = 'failed';
      this.db.prepare('UPDATE outbox SET state=?,attempt=attempt+1,updated_at=? WHERE id=? AND attempt=? AND payload_ref=?')
        .run(state, new Date().toISOString(), row.id, row.attempt, row.payload_ref);
    }
    await recoverMomentEdits(this.db, this.content, limit);
  }
}

export function registerHeartbeatDrawCapability(registry: CapabilityRegistry, runtime: Pick<HeartbeatRuntime, 'draw'>): void {
  const capability = toolCapability({
    owner: 'heartbeat', id: HEARTBEAT_DRAW_TOOL, group: 'D', baselineOrder: 61, free: true, memoryOnlyAllowed: false,
    heartbeatAction: 'selection',
    label: '心跳选号', silent: false,
    definition: () => ({ type: 'function', function: {
      name: HEARTBEAT_DRAW_TOOL, description: '仅在本轮收到心跳抽卡邀请时选择一个可用号码。1 号揭 1 号牌。普通发言的数字不选号。',
      parameters: { type: 'object', properties: { card_number: { type: 'integer' } }, required: ['card_number'], additionalProperties: false },
    } }),
    run: (args, context) => runtime.draw(args.card_number, context),
    toModel: (value: ToolExecResult['output']) => value,
  });
  registry.register({
    ...capability,
    parse: (raw, frozenSpec) => {
      const checked = capability.parse(raw, frozenSpec);
      if (checked.ok || checked.code !== 'TOOL_ARG_TYPE' || !checked.detail.startsWith('/card_number ')
        || !capability.parse({ ...raw, card_number: 1 }, frozenSpec).ok) return checked;
      // Keep the frozen schema and unchanged input. The authorized draw
      // handler records the invalid choice and supplies bounded correction.
      return { ok: true, value: raw };
    },
  });
}
