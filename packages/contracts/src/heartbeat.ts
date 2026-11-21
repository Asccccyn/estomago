export const HEARTBEAT_SOURCE_KINDS = ['wishstar', 'memory', 'archive', 'album', 'moments', 'reserved_note'] as const;

export type HeartbeatSource = {
  kind: (typeof HEARTBEAT_SOURCE_KINDS)[number];
  namespace: string;
  id: string;
  revision: string | number;
  identity: string;
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
  state: 'drawn' | 'drawn_no_comment' | 'declined';
  card: { number: number; source: HeartbeatSource } | null;
  messages: Array<{ messageId: string; revision: number; sequence: number }>;
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

function readSource(value: unknown): HeartbeatSource | null {
  const source = record(value);
  if (!source || !HEARTBEAT_SOURCE_KINDS.some(kind => kind === source.kind)
    || !text(source.namespace) || !text(source.id) || !text(source.identity)
    || !text(source.permissionScope) || !(text(source.revision) || integer(source.revision))
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
  if (!projection || projection.mode !== 'draw' || !text(projection.conversationId)
    || typeof projection.businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(projection.businessDate)
    || !integer(projection.version) || !Array.isArray(projection.messages)
    || (projection.state !== 'drawn' && projection.state !== 'drawn_no_comment' && projection.state !== 'declined')) return null;
  const card = record(projection.card);
  const source = readSource(card?.source);
  if (projection.state === 'declined' ? projection.card !== null
    : !card || !integer(card.number) || card.number > 10 || !source) return null;
  const messages: HeartbeatProjection['messages'] = [];
  for (const value of projection.messages) {
    const message = record(value);
    if (!message || !text(message.messageId) || !integer(message.revision) || !integer(message.sequence)
      || (messages.at(-1)?.sequence ?? 0) >= message.sequence) return null;
    messages.push({ messageId: message.messageId, revision: message.revision, sequence: message.sequence });
  }
  return {
    mode: 'draw', conversationId: projection.conversationId, businessDate: projection.businessDate,
    version: projection.version, state: projection.state,
    card: card && source ? { number: card.number as number, source } : null,
    messages,
  };
}
