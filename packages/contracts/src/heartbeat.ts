export const HEARTBEAT_SOURCE_KINDS = ['wishstar', 'memory', 'archive', 'album', 'moments', 'reserved_note'] as const;
export type HeartbeatExtensionKind = `ext:${string}`;
export type HeartbeatSourceKind = (typeof HEARTBEAT_SOURCE_KINDS)[number] | HeartbeatExtensionKind;

export function isHeartbeatExtensionKind(kind: unknown): kind is HeartbeatExtensionKind {
  return typeof kind === 'string' && /^ext:[a-z][a-z0-9_-]{0,63}$/.test(kind) && kind !== 'ext:family';
}

export type HeartbeatSource = {
  kind: HeartbeatSourceKind;
  namespace: string;
  id: string;
  revision: string | number;
  identity: string;
  /** Authoritative single-media alias of a Moments post. Its object identity survives edits. */
  mediaIdentity?: string;
  permissionScope: string;
  replay?: 'first_reserved_response';
  selection?: {
    attachmentIds?: readonly string[]; start?: number; end?: number;
    /** Fixed fingerprint of existing, authorized voice projections on this Content revision. */
    voiceTranscriptRevision?: string;
  };
};

export type HeartbeatProjection = {
  mode: 'draw';
  conversationId: string;
  businessDate: string;
  version: number;
  state: 'drawn' | 'drawn_no_comment' | 'talked' | 'declined' | 'interrupted';
  card: { number: number; source: HeartbeatSource } | null;
  messages: Array<{ messageId: string; revision: number; sequence: number }>;
  /** Only the original assistant messages published after this reserved note was actually revealed. */
  reservedReplyMessages?: HeartbeatProjection['messages'];
  actions?: HeartbeatAction[];
  terminal?: { status: 'completed' | 'declined' | 'cancelled' | 'failed' | 'unknown'; reason?: 'budget' | 'quote' | 'sleep' | 'yield' | 'delivery' | 'other' };
};

// Business receipts are references, not copies of private source prose. They
// remain independent of the (possibly truncated) model result and chat.
export const HEARTBEAT_ACTION_KINDS = [
  'selection', 'star_reply', 'star_write', 'star_request', 'star_respond', 'star_offer', 'star_accept',
  'memory_hold', 'memory_update', 'relation_link', 'relation_correct',
  'anchor_write', 'plan_write', 'i_write', 'post', 'comment', 'album', 'creation', 'image', 'archive', 'wake', 'chat',
] as const;
export type HeartbeatActionKind = (typeof HEARTBEAT_ACTION_KINDS)[number];
export type HeartbeatAction = {
  operationId: string;
  kind: HeartbeatActionKind;
  afterSequence: number;
  status: 'committed' | 'partial' | 'failed' | 'cancelled' | 'unknown';
  cardNumber?: number;
  wakeOperation?: 'schedule' | 'update' | 'cancel';
  source?: { namespace: string; id: string; revision?: string | number; parentId?: string };
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function integer(value: unknown, minimum = 1): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

export function readHeartbeatSource(value: unknown): HeartbeatSource | null {
  const source = record(value);
  if (!source || (!HEARTBEAT_SOURCE_KINDS.some(kind => kind === source.kind) && !isHeartbeatExtensionKind(source.kind))
    || !text(source.namespace) || !text(source.id) || !text(source.identity)
    || !text(source.permissionScope) || !(text(source.revision) || integer(source.revision))
    || source.mediaIdentity !== undefined && (source.kind !== 'moments' || source.namespace !== 'content'
      || typeof source.mediaIdentity !== 'string' || !/^mariposa:media:[a-f0-9]{64}$/.test(source.mediaIdentity))
    || source.replay !== undefined && (source.kind !== 'moments' || source.replay !== 'first_reserved_response')) return null;
  const selection = record(source.selection);
  const ids = selection?.attachmentIds;
  const start = selection?.start;
  const end = selection?.end;
  const voiceTranscriptRevision = selection?.voiceTranscriptRevision;
  if (source.selection !== undefined && !selection
    || ids !== undefined && (!Array.isArray(ids) || ids.length > 50 || !ids.every(text))
    || start !== undefined && !integer(start, 0)
    || end !== undefined && !integer(end, 0)
    || voiceTranscriptRevision !== undefined && (
      (source.kind !== 'moments' && source.kind !== 'reserved_note') || source.namespace !== 'content' || source.replay !== undefined
      || typeof voiceTranscriptRevision !== 'string' || !/^[0-9a-f]{64}$/.test(voiceTranscriptRevision))
    || typeof start === 'number' && typeof end === 'number' && start > end) return null;
  return {
    kind: source.kind as HeartbeatSource['kind'], namespace: source.namespace, id: source.id,
    identity: source.identity, revision: source.revision, permissionScope: source.permissionScope,
    ...(typeof source.mediaIdentity === 'string' ? { mediaIdentity: source.mediaIdentity } : {}),
    ...(source.replay === 'first_reserved_response' ? { replay: source.replay } : {}),
    ...(selection ? { selection: {
      attachmentIds: ids as string[] | undefined, start: start as number | undefined, end: end as number | undefined,
      ...(voiceTranscriptRevision === undefined ? {} : { voiceTranscriptRevision: voiceTranscriptRevision as string }),
    } } : {}),
  };
}

/** Retain only sourced identities and ordered references. A transport payload is never a projection. */
export function readHeartbeatProjection(value: unknown): HeartbeatProjection | null {
  const projection = record(value);
  const state = projection?.state;
  if (!projection || projection.mode !== 'draw' || !text(projection.conversationId)
    || typeof projection.businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(projection.businessDate)
    || !integer(projection.version) || !Array.isArray(projection.messages)
    || (state !== 'drawn' && state !== 'drawn_no_comment' && state !== 'talked' && state !== 'declined' && state !== 'interrupted')) return null;
  const card = record(projection.card);
  const source = readHeartbeatSource(card?.source);
  const drewCard = state === 'drawn' || state === 'drawn_no_comment';
  if (drewCard ? !card || !integer(card.number) || card.number > 10 || !source : projection.card !== null) return null;
  const messages: HeartbeatProjection['messages'] = [];
  for (const value of projection.messages) {
    const message = record(value);
    if (!message || !text(message.messageId) || !integer(message.revision) || !integer(message.sequence)
      || (messages.at(-1)?.sequence ?? 0) >= message.sequence) return null;
    messages.push({ messageId: message.messageId, revision: message.revision, sequence: message.sequence });
  }
  const reservedReplyMessages: HeartbeatProjection['messages'] = [];
  if (projection.reservedReplyMessages !== undefined) {
    if (!Array.isArray(projection.reservedReplyMessages) || source?.kind !== 'reserved_note') return null;
    for (const value of projection.reservedReplyMessages) {
      const message = record(value);
      const original = message && messages.find(ref => ref.messageId === message.messageId
        && ref.revision === message.revision && ref.sequence === message.sequence);
      if (!original || (reservedReplyMessages.at(-1)?.sequence ?? 0) >= original.sequence) return null;
      reservedReplyMessages.push(original);
    }
    if (reservedReplyMessages.length > 0 && state !== 'drawn') return null;
  }
  const actions: HeartbeatAction[] = [];
  const terminal = record(projection.terminal);
  if (projection.actions !== undefined) {
    if (!Array.isArray(projection.actions) || projection.actions.length > 1000) return null;
    for (const value of projection.actions) {
      const action = record(value);
      const source = record(action?.source);
      if (!action || !text(action.operationId) || !HEARTBEAT_ACTION_KINDS.some(kind => kind === action.kind)
        || !integer(action.afterSequence, 0) || !['committed', 'partial', 'failed', 'cancelled', 'unknown'].includes(String(action.status))
        || action.cardNumber !== undefined && (!integer(action.cardNumber) || action.cardNumber > 10)
        || action.wakeOperation !== undefined && (action.kind !== 'wake' || !['schedule','update','cancel'].includes(String(action.wakeOperation)))
        || action.source !== undefined && (!source || !text(source.namespace) || !text(source.id)
          || source.revision !== undefined && !(text(source.revision) || integer(source.revision))
          || source.parentId !== undefined && !text(source.parentId))) return null;
      actions.push({ operationId: action.operationId, kind: action.kind as HeartbeatActionKind,
        afterSequence: action.afterSequence, status: action.status as HeartbeatAction['status'],
        ...(action.cardNumber !== undefined ? { cardNumber: action.cardNumber as number } : {}),
        ...(action.wakeOperation !== undefined ? { wakeOperation: action.wakeOperation as HeartbeatAction['wakeOperation'] } : {}),
        ...(source ? { source: { namespace: source.namespace as string, id: source.id as string,
          ...(source.revision !== undefined ? { revision: source.revision as string | number } : {}),
          ...(source.parentId !== undefined ? { parentId: source.parentId as string } : {}) } } : {}) });
    }
  }
  if (projection.terminal !== undefined && (!terminal || !['completed','declined','cancelled','failed','unknown'].includes(String(terminal.status))
    || terminal.reason !== undefined && !['budget','quote','sleep','yield','delivery','other'].includes(String(terminal.reason)))) return null;
  return {
    mode: 'draw', conversationId: projection.conversationId, businessDate: projection.businessDate,
    version: projection.version, state,
    card: card && source ? { number: card.number as number, source } : null,
    messages,
    ...(projection.reservedReplyMessages !== undefined ? { reservedReplyMessages } : {}),
    ...(projection.actions !== undefined ? { actions } : {}),
    ...(terminal ? { terminal: { status: terminal.status as NonNullable<HeartbeatProjection['terminal']>['status'],
      ...(terminal.reason !== undefined ? { reason: terminal.reason as NonNullable<HeartbeatProjection['terminal']>['reason'] } : {}) } } : {}),
  };
}
