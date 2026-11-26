import type { HeartbeatProjection, HeartbeatSource, HeartbeatSpeechSlice } from '../../../../../packages/contracts/src/heartbeat.ts';
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityRegistry } from '../../capabilities/registry.ts';
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';
import { tx, type Db } from '../../db/connection.ts';
import type { EventService, StreamEventRow } from '../../events/service.ts';
import { contentForward, type ContentClient } from '../../integrations/content/client.ts';
import { CONTENT_OPERATION_TARGET } from '../../integrations/content/coordinator.ts';
import { recoverMomentEdits } from '../../integrations/content/moment-edit-outbox.ts';
import type { MediaService } from '../../media/assets.ts';
import { HEARTBEAT_CHAT_REVEAL_SOURCE, type MessageService } from '../../messages/service.ts';
import type { ManifestEntry } from '../../context/review-policy.ts';
import { ContractError } from '../../runtime/or-contract.ts';
import type { OrMessage } from '../../runtime/or-payload.ts';
import { readTurnCompletion } from '../../runtime/turn-completion.ts';
import { isMorningWakeRun } from '../../runtime/wake-activity.ts';
import { modelClockText } from '../../time/context.ts';
import { genId } from '../../util/id.ts';
import type { ArchiveService } from '../archives/service.ts';
import { OidoSourceRepository } from '../oido/source-repository.ts';
import { canDrawHeartbeat, canStartChatDraw, drawRoundId, heartbeatBusinessDate, heartbeatContentKindAtPath, heartbeatContentSourcePath,
  HEARTBEAT_DRAW_TOOL, HeartbeatCards, RESERVED_NOTE_IDENTITY, type HeartbeatMode, type HeartbeatRun, type HeartbeatSpeechHold } from './service.ts';
export { heartbeatBusinessDate } from './service.ts';
import { HeartbeatSources } from './sources.ts';
import { heartbeatActions } from './actions.ts';

export { HEARTBEAT_DRAW_TOOL } from './service.ts';
const PROJECTION_TARGET = 'content_heartbeat_projection';

/** Host tail event. The clock is read when this run is prepared for dispatch; the
 *  frozen system prefix is never rebuilt to carry a time. */
function wakeEvent(now: Date | undefined, body: readonly string[]): string {
  // The leading marker is the stable host-source label; only the clock after it changes per run.
  return [`[心跳唤醒] ${modelClockText((now ?? new Date()).toISOString(), 'Asia/Shanghai')}`, ...body].join('\n');
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
  /** A stop condition at publication time: generated speech is neither sent now, resent later, nor shown as a reply. */
  speechHold?: HeartbeatSpeechHold | null;
  morningWake?: boolean;
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

  async begin(input: { runId: string; conversationId: string; signal: AbortSignal; now?: () => Date; morningWake?: boolean; allowDraw?: boolean }): Promise<{
    mode: HeartbeatMode; hostText: string; unavailable?: HeartbeatSource['kind'][];
  }> {
    const businessDate = heartbeatBusinessDate(input.now?.());
    const unavailable: HeartbeatSource['kind'][] = [];
    const candidates = await this.todayCandidates(input.conversationId, businessDate, input.signal, unavailable);
    if (input.signal.aborted) return { mode: 'unprepared', hostText: '' };
    const run = this.cards.begin({ runId: input.runId, businessDate, candidates });
    if (!run) return { mode: 'unprepared', hostText: '', unavailable };
    let effectiveMode = run.mode;
    if (input.morningWake && effectiveMode === 'draw' && input.allowDraw === false) {
      effectiveMode = 'unprepared';
      this.db.prepare('UPDATE heartbeat_runs SET mode=? WHERE run_id=?').run(effectiveMode, input.runId);
    }
    if (!input.morningWake && (effectiveMode === 'unprepared' || effectiveMode === 'source_unavailable')) {
      return { mode: effectiveMode, hostText: '', unavailable };
    }
    const now = input.now?.();
    let hostText: string;
    if (input.morningWake) {
      if (effectiveMode === 'draw') {
        hostText = wakeEvent(now, [
          '醒了，这是今天的晨间活动机会。可以直接找乔乔说话，也可以先抽一张，再决定要不要找她；也可以安静结束。',
          `可抽号码：${run.deck!.availableNumbers.join('、')}。`,
          '这一轮的聊天正文会直接发给乔乔。',
        ]);
      } else if (effectiveMode === 'exhausted_keepwarm') {
        hostText = wakeEvent(now, [
          '醒了，这是今天的晨间活动机会。今天十张牌已经全部交付，本轮不能再抽牌；可以直接找乔乔说话，也可以安静结束。',
          '这一轮的聊天正文会直接发给乔乔。',
        ]);
      } else {
        const reasonLine = input.allowDraw === false
          ? '当前窗口未装载抽牌工具，本轮不能抽牌；可以直接找乔乔说话，也可以安静结束。'
          : effectiveMode === 'source_unavailable'
            ? '今天牌组里已没有可用的牌，本轮不能抽牌；可以直接找乔乔说话，也可以安静结束。'
            : '今天凑不够十张可用卡源，本轮不能抽牌；可以直接找乔乔说话，也可以安静结束。';
        hostText = wakeEvent(now, [
          `醒了，这是今天的晨间活动机会。${reasonLine}`,
          '这一轮的聊天正文会直接发给乔乔。',
        ]);
      }
    } else {
      hostText = effectiveMode === 'exhausted_keepwarm'
        ? wakeEvent(now, ['今天十张牌已经全部交付。请回复 1 保温。'])
        : wakeEvent(now, [
          '醒了。可以直接找乔乔说话，也可以先抽一张，再决定要不要找她；也可以安静结束。',
          `可抽号码：${run.deck!.availableNumbers.join('、')}。`,
          '这一轮的聊天正文会直接发给乔乔。',
        ]);
    }
    this.db.prepare('UPDATE heartbeat_runs SET invite_text=COALESCE(invite_text,?) WHERE run_id=?').run(hostText, input.runId);
    return { mode: effectiveMode, hostText, ...(unavailable.length ? { unavailable } : {}) };
  }

  /** Today's fixed deck, or the ten candidates to fix it with when it does not exist yet. */
  private async todayCandidates(conversationId: string, businessDate: string, signal: AbortSignal, unavailable: HeartbeatSource['kind'][] = []) {
    return this.cards.getDeck(conversationId, businessDate) ? undefined
      : await this.sources.choose(conversationId, source => this.cards.isSourceEligible(source),
        AbortSignal.any([signal, AbortSignal.timeout(2800)]), unavailable, businessDate);
  }

  private async openChatRound(ctx: ToolExecContext): Promise<HeartbeatRun | null> {
    const businessDate = heartbeatBusinessDate();
    const candidates = await this.todayCandidates(ctx.roomId, businessDate, ctx.signal ?? new AbortController().signal);
    return this.cards.beginChat({ turnId: ctx.turnId!, conversationId: ctx.roomId, businessDate, candidates });
  }

  /** The ordinary turn that drew has ended. Settle what is still open and record
   *  the card with what was said to her about it; committed work is kept. */
  closeChatRound(turnId: string): void {
    this.liveImages.delete(turnId);
    const round = this.cards.getRun(turnId);
    if (round?.origin !== 'chat') return;
    this.cards.closeRun(turnId);
    this.finishChatProjection(turnId, round.businessDate);
  }

  private finishChatProjection(turnId: string, businessDate: string): void {
    const delivered = this.cards.getDeliveredDraw(turnId);
    const scope = delivered ? this.roundScope(turnId) : undefined;
    if (delivered && scope) this.publishObserved(turnId, scope, 'card', `[抽牌] 抽到了 ${delivered.cardNumber} 号牌。`);
    tx(this.db, () => this.projectChatRound(turnId, businessDate));
  }

  /** Preserve the original conservative result if an older run did not record
   *  the flush boundary. Its buffered opening text could have landed after reveal. */
  private legacyChatReplies(turnId: string, conversationId: string, revealSequence: number,
    delivered: NonNullable<ReturnType<HeartbeatCards['getDeliveredDraw']>>): HeartbeatProjection['messages'] {
    const request = this.db.prepare('SELECT payload_wire_json,payload_json FROM provider_requests WHERE id=?')
      .get(delivered.providerRequestId) as { payload_wire_json: string | null; payload_json: string | null } | undefined;
    let opener = '';
    const payload = request?.payload_wire_json ?? request?.payload_json;
    if (payload) {
      try {
        const packet = (JSON.parse(payload) as { messages?: OrMessage[] }).messages?.find(message => message.role === 'assistant'
          && Array.isArray(message.tool_calls) && message.tool_calls.some(call => call.id === delivered.operationId));
        opener = plainText(packet).trim();
      } catch { return []; }
    }
    const rows = this.db.prepare(`
      SELECT m.id AS messageId, m.current_revision AS revision, m.sequence, r.content
      FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision
      WHERE m.turn_id=? AND m.conversation_id=? AND m.speaker='assistant' AND m.published_at IS NOT NULL AND m.sequence>?
      ORDER BY m.sequence
    `).all(turnId, conversationId, revealSequence) as Array<{ messageId: string; revision: number; sequence: number; content: string }>;
    return rows.filter(message => !(opener && message.content.startsWith(opener)))
      .map(({ messageId, revision, sequence }) => ({ messageId, revision, sequence }));
  }

  /** Confirmed reveal divides the official assistant revisions. Text appended to
   *  a prior bubble and interleaved tool messages enter Moments in their write order. */
  private projectChatRound(turnId: string, businessDate: string): void {
    if (this.db.prepare('SELECT 1 FROM outbox WHERE operation_key=?').get(`heartbeat-moment:${turnId}`)) return;
    const scope = this.roundScope(turnId);
    if (!scope) return;
    const delivered = this.cards.getDeliveredDraw(turnId);
    const unknown = this.db.prepare("SELECT 1 FROM heartbeat_draw_operations WHERE run_id=? AND state='unknown'").get(turnId);
    if (!delivered && !unknown) return;
    const reveal = this.db.prepare(`
      SELECT m.id, m.current_revision, m.sequence, r.rowid AS rev_rowid, r.source
      FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision
      WHERE m.conversation_id=? AND m.client_message_id=?
    `).get(scope.conversation_id, `heartbeat:${turnId}:card`) as
      { id: string; current_revision: number; sequence: number; rev_rowid: number; source: string } | undefined;
    if (!reveal) return;
    const projectionRef = (message: { id: string; current_revision: number; sequence: number }) => ({ messageId: message.id, revision: message.current_revision, sequence: message.sequence });
    const hasSpeechBoundary = delivered !== null && reveal.source === HEARTBEAT_CHAT_REVEAL_SOURCE;
    const postRevs = hasSpeechBoundary ? (this.db.prepare(`
      SELECT m.id AS message_id, m.sequence, r.revision, r.content, prev.content AS prev_content
      FROM message_revisions r
      JOIN messages m ON m.id=r.message_id
      LEFT JOIN message_revisions prev ON prev.message_id=r.message_id AND prev.revision=r.revision-1
      WHERE m.turn_id=? AND m.conversation_id=? AND m.speaker='assistant'
        AND m.published_at IS NOT NULL AND r.source='assistant_publish' AND r.rowid>?
      ORDER BY r.rowid ASC
    `).all(turnId, scope.conversation_id, reveal.rev_rowid) as Array<{
      message_id: string; sequence: number; revision: number; content: string; prev_content: string | null;
    }>) : [];
    const speech: HeartbeatSpeechSlice[] = [];
    for (const rev of postRevs) {
      const chars = Array.from(rev.content);
      let start: number | undefined;
      let end: number | undefined;
      if (rev.revision > 1) {
        const prefix = (rev.prev_content ?? '').replace(/\n+$/, '') + '\n\n';
        if (!rev.content.startsWith(prefix)) continue;
        start = Array.from(prefix).length;
        end = chars.length;
        if (start >= end) continue;
      }
      const prev = speech.at(-1);
      if (prev && prev.messageId === rev.message_id && rev.revision > prev.revision) {
        prev.revision = rev.revision;
        if (prev.start !== undefined || prev.end !== undefined) prev.end = chars.length;
      } else {
        speech.push({
          messageId: rev.message_id,
          revision: rev.revision,
          sequence: rev.sequence,
          ...(start !== undefined && end !== undefined ? { start, end } : {}),
        });
      }
    }
    // Downgrade safety: older readers ignore speech and render messages verbatim.
    // Only include unsliced post-reveal whole messages in messages so an older reader never leaks pre-reveal text.
    const sliceCounts = new Map<string, number>();
    for (const item of speech) sliceCounts.set(item.messageId, (sliceCounts.get(item.messageId) ?? 0) + 1);
    const wholeReplies = delivered && !hasSpeechBoundary
      ? this.legacyChatReplies(turnId, scope.conversation_id, reveal.sequence, delivered) : [];
    for (const item of speech) {
      if (item.start === undefined && item.end === undefined && sliceCounts.get(item.messageId) === 1 && item.sequence > reveal.sequence) {
        if ((wholeReplies.at(-1)?.sequence ?? 0) < item.sequence) {
          wholeReplies.push({ messageId: item.messageId, revision: item.revision, sequence: item.sequence });
        }
      }
    }
    const turn = this.db.prepare('SELECT state FROM turns WHERE id=?').get(turnId) as { state: string } | undefined;
    const projection: HeartbeatProjection = {
      mode: 'draw', origin: 'chat', conversationId: scope.conversation_id, businessDate, version: 2,
      state: delivered ? (speech.length || wholeReplies.length ? 'drawn' : 'drawn_no_comment') : 'interrupted',
      card: delivered ? { number: delivered.cardNumber, source: delivered.source } : null,
      messages: [projectionRef(reveal), ...wholeReplies],
      ...(hasSpeechBoundary ? { speech } : {}),
      ...(delivered?.source.kind === 'reserved_note' ? { reservedReplyMessages: wholeReplies } : {}),
      actions: heartbeatActions(this.db, turnId),
      terminal: unknown && !delivered ? { status: 'unknown' } : turn?.state === 'completed' ? { status: 'completed' } : { status: 'failed' },
    };
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO outbox(id,operation_key,target,payload_ref,state,created_at,updated_at)
      VALUES(?,?,?,?, 'pending',?,?)
    `).run(genId('ob'), `heartbeat-moment:${turnId}`, PROJECTION_TARGET, JSON.stringify(projection), now, now);
  }

  async draw(cardNumber: unknown, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!ctx.toolCallId) return { ok: false, output: { error_code: 'HEARTBEAT_DRAW_NOT_ACTIVE' } };
    if (ctx.purpose === 'chat') {
      // An ordinary reply to her draws from the same daily deck. The night
      // window, rest and the heartbeat switch only gate automatic wakes.
      if (!canStartChatDraw(this.db, ctx)) return { ok: false, output: { error_code: 'HEARTBEAT_DRAW_NOT_ACTIVE' } };
      const turnId = ctx.turnId!;
      const round = this.cards.getRun(turnId)?.origin === 'chat' ? this.cards.getRun(turnId) : await this.openChatRound(ctx);
      if (!round) return { ok: false, output: { error_code: 'HEARTBEAT_DRAW_NOT_ACTIVE' } };
      if (round.mode !== 'draw') {
        const exhausted = round.mode === 'exhausted_keepwarm';
        return { ok: false, output: { error_code: exhausted ? 'HEARTBEAT_DECK_EXHAUSTED' : 'HEARTBEAT_SOURCE_UNAVAILABLE',
          detail: exhausted ? '今天十张牌已经全部抽完。' : '今天已没有可抽的牌。', remaining_numbers: [], retry_allowed: false } };
      }
    } else if (!canDrawHeartbeat(this.db, ctx)) {
      return { ok: false, output: { error_code: 'HEARTBEAT_DRAW_NOT_ACTIVE' } };
    }
    const operation = { runId: drawRoundId(ctx)!, operationId: ctx.toolCallId };
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
        heartbeat_draw_receipt: { operation_id: result.operationId, card_number: result.cardNumber, delivery_state: result.phase } },
        // Asking again for the number this round already drew repeats that selection;
        // asking for another number is a second, refused selection.
        ...(cardNumber === result.cardNumber ? { heartbeatReceipt: { operationId: result.operationId, replayed: true as const,
          status: result.phase === 'delivered' ? 'committed' as const : result.phase === 'unknown' || result.phase === 'dispatching' ? 'unknown' as const : 'failed' as const } } : {}) };
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

  /** The continuation request of an ordinary turn is about to leave with a card
   *  result in it. Re-verify the card source and admission just like heartbeat
   *  dispatch, without applying automatic-wake night/rest/switch gates. */
  async beforeChatDispatch(turnId: string, providerRequestId: string, messages: OrMessage[], signal: AbortSignal): Promise<void> {
    if (this.cards.getRun(turnId)?.origin !== 'chat') return;
    await this.admitCardOperations(turnId, providerRequestId, messages, signal);
  }

  async beforeDispatch(runId: string, providerRequestId: string, messages: OrMessage[], signal: AbortSignal, beforeStartDispatch?: () => void): Promise<void> {
    for (const message of messages) {
      if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
      const draw = this.cards.getDraw({ runId, operationId: message.tool_call_id });
      if (draw?.status === 'rejected' && !draw.retryAllowed) throw new ContractError('HEARTBEAT_CORRECTIONS_EXHAUSTED');
    }
    const admitted = await this.admitCardOperations(runId, providerRequestId, messages, signal, beforeStartDispatch);
    if (!admitted) beforeStartDispatch?.();
  }

  private async admitCardOperations(
    runId: string,
    providerRequestId: string,
    messages: OrMessage[],
    signal: AbortSignal,
    beforeStartDispatch?: () => void,
  ): Promise<boolean> {
    let admitted = false;
    for (const operationId of cardOperations(messages)) {
      const operation = { runId, operationId };
      const deck = this.cards.getDraw(operation);
      if (deck?.status === 'dispatching') throw new ContractError('HEARTBEAT_CARD_DISPATCH_UNKNOWN');
      if (!deck || deck.status !== 'prepared') continue;
      const conversationId = this.roundScope(runId)?.conversation_id;
      const recheck = async (): Promise<void> => {
        const payload = conversationId ? await this.sources.resolve(deck.source, conversationId, signal) : { status: 'unavailable' as const };
        if (payload.status !== 'available' || signal.aborted) {
          if (payload.status === 'deleted' || payload.status === 'forbidden' || payload.status === 'revision_unavailable') {
            this.cards.recordSource({ ...operation, result: 'invalid' });
          }
          this.cards.recordDelivery({ ...operation, outcome: 'not_dispatched' });
          throw new ContractError('HEARTBEAT_SOURCE_INVALID_BEFORE_DISPATCH');
        }
        try {
          beforeStartDispatch?.();
        } catch (error) {
          this.cards.recordDelivery({ ...operation, outcome: 'not_dispatched' });
          throw error;
        }
        if (!this.cards.startDispatch({ ...operation, providerRequestId })) {
          this.cards.recordDelivery({ ...operation, outcome: 'not_dispatched' });
          throw new ContractError('HEARTBEAT_DISPATCH_NOT_ADMITTED');
        }
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
      admitted = true;
    }
    return admitted;
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
    const round = drawRoundId(ctx);
    if (!round || !canDrawHeartbeat(this.db, ctx)) return null;
    const draw = this.cards.getDeliveredDraw(round);
    if (!draw || draw.operationId !== ref || draw.source.kind !== 'wishstar'
      || draw.source.namespace !== 'superposition' || draw.source.permissionScope !== ctx.roomId) return null;
    const signal = AbortSignal.any([ctx.signal ?? new AbortController().signal, AbortSignal.timeout(2000)]);
    const source = await this.sources.resolve(draw.source, ctx.roomId, signal);
    return source.status === 'available' && !signal.aborted ? draw.source : null;
  }

  /** Where a round's messages belong: the heartbeat run's turn, or the ordinary turn itself. */
  private roundScope(runId: string): { conversation_id: string; turn_id: string; attempt_id: string } | undefined {
    return (this.db.prepare(`SELECT b.conversation_id,b.turn_id,a.id AS attempt_id
      FROM background_runs b JOIN attempts a ON a.turn_id=b.turn_id WHERE b.id=?`).get(runId)
      ?? this.db.prepare(`SELECT t.conversation_id,t.id AS turn_id,a.id AS attempt_id
        FROM turns t JOIN attempts a ON a.turn_id=t.id WHERE t.id=? ORDER BY a.attempt_no DESC LIMIT 1`).get(runId)) as
      { conversation_id: string; turn_id: string; attempt_id: string } | undefined;
  }

  /** A request of an ordinary turn that carried a card result was confirmed sent. */
  observeChatDelivery(turnId: string, providerRequestId: string, messages: OrMessage[], beforeReveal?: () => void): void {
    if (this.cards.getRun(turnId)?.origin !== 'chat' || this.cards.getDeliveredDraw(turnId)) return;
    for (const operationId of cardOperations(messages)) {
      if (!this.cards.recordDelivery({ runId: turnId, operationId, outcome: 'delivered', providerRequestId })) continue;
      const run = this.roundScope(turnId);
      const delivered = this.cards.getDeliveredDraw(turnId);
      if (run && delivered) {
        beforeReveal?.();
        this.publishObserved(turnId, run, 'card', `[抽牌] 抽到了 ${delivered.cardNumber} 号牌。`, true);
      }
    }
  }

  observeDelivery(runId: string, providerRequestId: string, messages: OrMessage[], hostText?: string): void {
    const run = this.roundScope(runId);
    const round = this.cards.getRun(runId);
    const mode = round?.mode;
    if (run && mode && hostText) {
      this.publishObserved(runId, run, 'invite', hostText);
    }
    for (const operationId of cardOperations(messages)) {
      this.cards.recordDelivery({ runId, operationId, outcome: 'delivered', providerRequestId });
    }
    const delivered = this.cards.getDeliveredDraw(runId);
    if (run && mode === 'draw' && delivered) {
      this.publishObserved(runId, run, 'card', round?.origin === 'chat'
        ? `[抽牌] 抽到了 ${delivered.cardNumber} 号牌。` : `[心跳唤醒] 揭开了 ${delivered.cardNumber} 号牌。`);
    }
  }

  private publishObserved(runId: string, run: { conversation_id: string; turn_id: string; attempt_id: string },
    part: 'invite' | 'card', content: string, chatRevealBoundary?: true): void {
    const scope = { runId, conversationId: run.conversation_id, turnId: run.turn_id, attemptId: run.attempt_id };
    const { event } = tx(this.db, () => this.publishInTx(scope, part, content, chatRevealBoundary));
    if (event) this.events.dispatchRow(event);
  }

  private publishInTx(scope: Pick<HeartbeatFinish, 'runId' | 'conversationId' | 'turnId' | 'attemptId'>,
    part: Parameters<MessageService['publishHeartbeatInTx']>[0]['part'], content: string, chatRevealBoundary?: true) {
    const { runId, conversationId, turnId, attemptId } = scope;
    const existing = this.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND client_message_id=?')
      .get(conversationId, `heartbeat:${runId}:${part}`);
    const message = this.messages.publishHeartbeatInTx({ runId, conversationId, turnId, part, content,
      ...(chatRevealBoundary ? { chatRevealBoundary } : {}) });
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
      LEFT JOIN background_runs run ON run.id=draw.run_id
      LEFT JOIN turns turn ON turn.id=draw.run_id
      JOIN provider_requests request ON request.id=draw.provider_request_id
      JOIN json_each(request.payload_json, '$.messages') message
      JOIN json_each(CASE WHEN json_type(message.value,'$.content')='array'
        THEN json_extract(message.value,'$.content') ELSE '[]' END) block
      WHERE COALESCE(run.conversation_id, turn.conversation_id)=? AND draw.state='delivered' AND request.sent_at IS NOT NULL
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
    if (run.mode === 'exhausted_keepwarm' && !input.morningWake) {
      if (!input.speechHold && text.trim() === '1') publish('ack', text);
      return result;
    }
    if (run.mode !== 'draw' && !input.morningWake) return result;
    const delivered = run.mode === 'draw' ? this.cards.getDeliveredDraw(input.runId) : null;
    if (delivered) publish('card', `[心跳唤醒] 揭开了 ${delivered.cardNumber} 号牌。`);
    if (!input.speechHold && input.completed && input.responseOffset !== undefined && last?.role === 'assistant'
        && !(Array.isArray(last.tool_calls) && last.tool_calls.length)) {
      const speech = this.publishRepliesInTx(input, input.finalMessages.slice(input.responseOffset), input.responseOffset);
      manifest.push(...speech.manifest);
      eventRows.push(...speech.eventRows);
    }
    // Chat tools publish under their own message identity, so formal speech is
    // any published assistant message of this turn. Host notices of a draw turn
    // are speaker=system; the exhausted ack never occurs in draw mode.
    const talked = input.completed && !delivered && Boolean(this.db.prepare(`SELECT 1 FROM messages
      WHERE turn_id=? AND speaker='assistant' AND published_at IS NOT NULL`).get(input.turnId));
    const decline = run.mode === 'draw' && input.completed && !delivered && !talked && !this.cards.hasClaimedDraw(input.runId)
      && readTurnCompletion(this.db, input.attemptId, input.turnId) === 'noop';
    if (decline) publish('decline', '[心跳唤醒] 本轮未抽卡');
    const actions = heartbeatActions(this.db, input.runId);
    if (run.mode !== 'draw' && !talked && actions.length === 0) return result;
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
    for (const runId of [...this.liveImages.keys()]) {
      const liveBg = this.db.prepare("SELECT 1 FROM background_runs WHERE id=? AND state IN ('claimed','running','cancelling')").get(runId);
      const liveTurn = this.db.prepare("SELECT 1 FROM turns WHERE id=? AND state='running'").get(runId);
      if (!liveBg && !liveTurn) this.liveImages.delete(runId);
    }
    // A process can stop after a confirmed source write but before model
    // completion. Preserve the already-observed business and display facts,
    // not a fabricated protocol continuation or a new model request.
    const rows = this.db.prepare(`SELECT h.run_id,h.mode,h.invite_text,b.conversation_id,b.turn_id,b.state,a.id AS attempt_id
      FROM heartbeat_runs h JOIN background_runs b ON b.id=h.run_id JOIN attempts a ON a.turn_id=b.turn_id
      WHERE (h.mode='draw' OR b.occurrence_key LIKE 'morning-wake:%') AND h.invite_text IS NOT NULL AND b.state NOT IN ('claimed','running','cancelling')
        AND EXISTS (SELECT 1 FROM provider_requests p WHERE p.background_run_id=b.id AND p.sent_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.operation_key='heartbeat-moment:'||h.run_id)`).all() as
      Array<{ run_id: string; mode: HeartbeatMode; invite_text: string; conversation_id: string; turn_id: string; state: string; attempt_id: string }>;
    for (const row of rows) {
      const recovered = tx(this.db, () => this.commitInTx({
        runId: row.run_id, hostText: row.invite_text, conversationId: row.conversation_id, turnId: row.turn_id,
        attemptId: row.attempt_id, mode: row.mode, hadSent: true, finalMessages: [], completed: false,
        morningWake: isMorningWakeRun(this.db, row.run_id),
        terminal: { status: row.state === 'cancelled' ? 'cancelled' : row.state === 'failed' ? 'failed' : 'unknown' },
      }));
      this.dispatchEvents(recovered.eventRows);
    }
    // A turn that drew while chatting and ended before its Moments entry was written.
    const chatRounds = this.db.prepare(`
      SELECT h.run_id,h.business_date FROM heartbeat_runs h
      WHERE EXISTS (SELECT 1 FROM turns t WHERE t.id=h.run_id AND t.state<>'running')
        AND EXISTS (SELECT 1 FROM heartbeat_draw_operations o WHERE o.run_id=h.run_id AND o.state IN ('delivered','unknown'))
        AND NOT EXISTS (SELECT 1 FROM outbox WHERE operation_key='heartbeat-moment:'||h.run_id)
    `).all() as Array<{ run_id: string; business_date: string }>;
    for (const row of chatRounds) this.finishChatProjection(row.run_id, row.business_date);
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

  /** Delivery state of every reserved note that has left the waiting list, keyed by note id. */
  reservedNoteUsage(): ReturnType<HeartbeatCards['reservedNoteUsage']> { return this.cards.reservedNoteUsage(); }

  noteStatus(id: string, conversationId: string, sourceDeleted = false) {
    if (sourceDeleted) this.db.prepare(`
      UPDATE heartbeat_cards SET invalid_reason='source_deleted'
      WHERE source_kind='reserved_note' AND source_identity=?
    `).run(RESERVED_NOTE_IDENTITY + id);
    const state = this.cards.reservedNoteDeliveryStatus(RESERVED_NOTE_IDENTITY + id);
    const date = heartbeatBusinessDate();
    const card = this.db.prepare(`
      SELECT c.card_number,c.invalid_reason,json_extract(c.source_ref_json,'$.revision') AS revision
      FROM heartbeat_decks d JOIN heartbeat_cards c ON c.deck_id=d.id
      WHERE d.conversation_id=? AND d.business_date=? AND c.source_kind='reserved_note' AND c.source_identity=?
    `).get(conversationId, date, RESERVED_NOTE_IDENTITY + id) as { card_number: number; invalid_reason: string | null; revision: number } | undefined;
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
    owner: 'heartbeat', id: HEARTBEAT_DRAW_TOOL, baselineOrder: 61, free: true, memoryOnlyAllowed: false,
    heartbeatAction: 'selection',
    label: '心跳选号', silent: false,
    definition: () => ({ type: 'function', function: {
      name: HEARTBEAT_DRAW_TOOL, description: '从今天的牌里抽一张：填一个可抽号码，1 号揭 1 号牌；每个逻辑回合最多成功抽一张，已抽过的号码当天不能再抽。心跳邀请里列出了可抽号码；平时聊天里想抽、或想看还剩哪些号码时，重新读取本工具的定义（tool_define 或 tool_catalog），结果会带上当前可抽号码。普通发言里的数字不选号。',
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
