import { isHeartbeatExtensionKind, readHeartbeatProjection, readHeartbeatSource, type HeartbeatExtensionKind, type HeartbeatSource } from '../../../../../packages/contracts/src/heartbeat.ts';
import type { MariposaClient } from '../../integrations/mariposa/client.ts';
import type { WishstarClient } from '../../integrations/wishstar/client.ts';
import { contentForward, readAllContentPages, type ContentClient } from '../../integrations/content/client.ts';
import type { MediaService } from '../../media/assets.ts';
import type { MessageService } from '../../messages/service.ts';
import { sha256Hex } from '../../util/id.ts';
import type { ArchiveService } from '../archives/service.ts';
import type { OidoSourceRepository } from '../oido/source-repository.ts';

type SourceActor = 'jiaming' | 'qiaosheng';
export type SourceStatus = 'deleted' | 'forbidden' | 'revision_unavailable' | 'unavailable';
export type CardPayload = {
  status: 'available'; text: string; assetIds: string[]; imageIds: string[]; voiceTranscriptRevision?: string;
} | { status: SourceStatus };
type ContentItem = {
  id: string;
  revision: number;
  kind?: string;
  deleted?: boolean;
  asset_id?: string;
  asset_ids?: string[];
  title?: string | null;
  body?: string | null;
  caption?: string | null;
  messages?: Array<{ message_id: string; revision: number }>;
  reference?: unknown;
};
type LocalSource = Extract<HeartbeatSource['kind'], 'album' | 'archive' | 'moments' | 'reserved_note'>;
type MemorySource = { memory_id: string; version: number; text: string; original_title?: string };
type SharedStar = { id: string; content: string; author_name?: string; note?: string; state: 'SHARED' };
type ExternalSources = {
  memory?: Pick<MariposaClient, 'memoryGet'> | null;
  wishstar?: Pick<WishstarClient, 'forward'> | null;
  voice?: Pick<OidoSourceRepository, 'readyTranscript'>;
  extensions?: readonly HeartbeatSourceAdapter[];
  dailyMemorySelection?: HeartbeatDailyMemorySelection;
};

/** Internal, trusted Host composition port. Not an HTTP/model registration surface.
 * Source identities are authoritative (including cross-source canonical aliases),
 * and list/resolve must honor the supplied room, actor, deadline, and revision. */
export type HeartbeatSourceAdapter = {
  kind: HeartbeatExtensionKind;
  namespace: string;
  enabled(conversationId: string): boolean;
  list(conversationId: string, signal: AbortSignal): Promise<readonly HeartbeatSource[] | null>;
  resolve(source: HeartbeatSource, conversationId: string, signal: AbortSignal, actor: SourceActor): Promise<CardPayload>;
};

/** The daily owner (Sol) has frozen exactly one memory at Shanghai midnight.
 * Host only reads its fixed reference and independently checks permissions,
 * revision and actual-delivery cooldown. No model dispatch or reroll here. */
export type HeartbeatDailyMemorySelection = (conversationId: string, businessDate: string, signal: AbortSignal) => Promise<{
  businessDate: string; frozenAt: string; memoryId: string; revision: number;
} | null>;

const ROUTES = {
  archive: '/api/v1/content/archives',
  moments: '/api/v1/content/posts',
  reserved_note: '/api/v1/content/future-notes',
  album: '/api/v1/content/album-entries',
} satisfies Record<LocalSource, string>;

export class HeartbeatSources {
  private readonly content: ContentClient | null;
  private readonly media: MediaService;
  private readonly archives: ArchiveService;
  private readonly messages: Pick<MessageService, 'getMessageAtRevision'>;
  private readonly external: ExternalSources;
  private readonly random: () => number;
  private readonly extensions = new Map<HeartbeatExtensionKind, HeartbeatSourceAdapter>();

  constructor(
    content: ContentClient | null,
    media: MediaService,
    archives: ArchiveService,
    messages: Pick<MessageService, 'getMessageAtRevision'>,
    external: ExternalSources = {},
    random: () => number = Math.random,
  ) {
    this.content = content;
    this.media = media;
    this.archives = archives;
    this.messages = messages;
    this.external = external;
    this.random = random;
    for (const adapter of external.extensions ?? []) {
      if (!isHeartbeatExtensionKind(adapter.kind) || !adapter.namespace || this.extensions.has(adapter.kind)) {
        throw new Error('HEARTBEAT_SOURCE_REGISTRATION_INVALID');
      }
      this.extensions.set(adapter.kind, adapter);
    }
  }

  async choose(conversationId: string, eligible: (source: HeartbeatSource) => boolean, signal: AbortSignal,
    unavailable: HeartbeatSource['kind'][] = [], businessDate?: string): Promise<HeartbeatSource[]> {
    const [archives, photos, screenshots, moments, notes, memories, stars, extensions] = await Promise.all([
      this.list('archive', ROUTES.archive + '?conversation_id=' + encodeURIComponent(conversationId), conversationId, signal),
      this.list('album', '/api/v1/content/albums/important_photos/entries?', conversationId, signal),
      this.list('album', '/api/v1/content/albums/chat_screenshots/entries?', conversationId, signal),
      this.list('moments', ROUTES.moments + '?body_preview=1&include_references=1', conversationId, signal),
      this.list('reserved_note', ROUTES.reserved_note + '?', conversationId, signal),
      this.memoryCandidates(conversationId, businessDate, signal),
      this.sharedStars(signal).then(rows => rows?.map(star => ({
        kind: 'wishstar' as const, namespace: 'superposition', id: star.id, revision: this.starVersion(star),
        identity: 'superposition:star:' + star.id, permissionScope: conversationId,
      })) ?? null),
      Promise.all([...this.extensions.values()].filter(adapter => adapter.enabled(conversationId)).map(async adapter => {
        try {
          const rows = await adapter.list(conversationId, signal);
          const candidates = rows?.map(readHeartbeatSource);
          if (!candidates || candidates.some(source => !source || source.kind !== adapter.kind
            || source.namespace !== adapter.namespace || source.permissionScope !== conversationId)) return [adapter.kind, null] as const;
          return [adapter.kind, candidates as HeartbeatSource[]] as const;
        } catch { return [adapter.kind, null] as const; }
      })),
    ]);
    const catalogues: Array<readonly [HeartbeatSource['kind'], readonly HeartbeatSource[] | null]> = [
      ['archive', archives], ['album', photos && screenshots ? [...photos, ...screenshots] : null],
      ['moments', moments], ['reserved_note', notes], ['memory', memories], ['wishstar', stars],
    ] as const;
    catalogues.push(...extensions);
    const buckets = new Map<HeartbeatSource['kind'], HeartbeatSource[]>();
    for (const [kind, candidates] of catalogues) {
      if (!candidates) {
        unavailable.push(kind);
        continue;
      }
      for (const source of candidates) {
        if (!eligible(source)) continue;
        const bucket = buckets.get(source.kind) ?? [];
        if (!bucket.some(candidate => candidate.identity === source.identity)) bucket.push(source);
        buckets.set(source.kind, bucket);
      }
    }
    const chosen: HeartbeatSource[] = [];
    while (chosen.length < 10 && buckets.size && !signal.aborted) {
      const entries = [...buckets.entries()];
      const [, bucket] = entries[Math.floor(this.random() * entries.length)]!;
      const source = bucket[Math.floor(this.random() * bucket.length)]!;
      for (const [group, sources] of buckets) {
        const remaining = sources.filter(candidate => candidate.identity !== source.identity);
        if (remaining.length) buckets.set(group, remaining);
        else buckets.delete(group);
      }
      const payload = await this.resolve(source, conversationId, signal, 'jiaming', 'bind');
      if (payload.status === 'available' && (payload.text.trim() || payload.imageIds.length)
        && Buffer.byteLength(payload.text) <= 16000 && payload.imageIds.length <= 4) {
        chosen.push(payload.voiceTranscriptRevision
          ? { ...source, selection: { ...source.selection, voiceTranscriptRevision: payload.voiceTranscriptRevision } }
          : source);
      }
    }
    return chosen;
  }

  enabled(source: HeartbeatSource): boolean {
    if (!isHeartbeatExtensionKind(source.kind)) return true;
    const adapter = this.extensions.get(source.kind);
    return Boolean(adapter && adapter.namespace === source.namespace && adapter.enabled(source.permissionScope));
  }

  async resolve(source: HeartbeatSource, conversationId: string, signal: AbortSignal, actor: SourceActor = 'jiaming',
    phase: 'bind' | 'resolve' = 'resolve'): Promise<CardPayload> {
    if (source.permissionScope !== conversationId) return { status: 'forbidden' };
    if (isHeartbeatExtensionKind(source.kind)) {
      const adapter = this.extensions.get(source.kind);
      if (!adapter || adapter.namespace !== source.namespace || !adapter.enabled(conversationId)) return { status: 'forbidden' };
      try { return await adapter.resolve(source, conversationId, signal, actor); }
      catch { return { status: 'unavailable' }; }
    }
    if (source.kind === 'memory' && source.namespace === 'mariposa') {
      if (!this.external.memory) return { status: 'unavailable' };
      try {
        const result = await this.external.memory.memoryGet(source.id, signal);
        if (!result.ok) return { status: result.httpStatus === 403 ? 'forbidden' : result.httpStatus === 404 ? 'deleted' : 'unavailable' };
        if (result.result.visibility !== 'active') return { status: 'forbidden' };
        const memory = this.activeMemory(result.result);
        if (!memory || memory.memory_id !== source.id || memory.version !== source.revision) return { status: 'revision_unavailable' };
        return this.payload([memory.original_title, memory.text].filter(Boolean).join('\n\n'), []);
      } catch { return { status: 'unavailable' }; }
    }
    if (source.kind === 'wishstar' && source.namespace === 'superposition') {
      const stars = await this.sharedStars(signal);
      if (!stars) return { status: 'unavailable' };
      const star = stars.find(item => item.id === source.id);
      if (!star) return { status: 'forbidden' };
      if (this.starVersion(star) !== source.revision) return { status: 'revision_unavailable' };
      return this.payload([star.author_name, star.content, star.note].filter(Boolean).join('\n\n'), []);
    }
    if (source.namespace !== 'content' || source.kind === 'wishstar' || source.kind === 'memory') return { status: 'unavailable' };
    if (!this.content) return { status: 'unavailable' };
    const base = ROUTES[source.kind] + '/' + encodeURIComponent(source.id);
    const path = source.kind === 'moments' && !source.replay || source.kind === 'reserved_note'
      ? base + '?revision=' + encodeURIComponent(String(source.revision)) : base;
    try {
      const response = await contentForward(this.content, { method: 'GET', path, actor, signal });
      if (response.status === 401 || response.status === 403) return { status: 'forbidden' };
      if (response.status === 410) return { status: 'deleted' };
      if (response.status === 404 && !response.bodyFailed) {
        const code = (response.body as { error?: { code?: string } }).error?.code;
        return { status: code === 'revision_unavailable' ? 'revision_unavailable' : 'deleted' };
      }
      if (response.status !== 200 || response.bodyFailed) return { status: 'unavailable' };
      const item = response.body as ContentItem;
      if (item.deleted) return { status: 'deleted' };
      // A photo and a sticker can refer to the same asset but membership
      // grants are distinct. Only the two admitted photo collections qualify.
      if (source.kind === 'album' && item.kind !== 'important_photos' && item.kind !== 'chat_screenshots') return { status: 'forbidden' };
      if (source.kind === 'moments' && source.replay) {
        const projection = readHeartbeatProjection(item.reference);
        const original = projection?.card?.source;
        if (item.id !== source.id || projection?.conversationId !== conversationId
          || projection.version !== source.revision || projection.state !== 'drawn' || original?.kind !== 'reserved_note') {
          return { status: 'revision_unavailable' };
        }
        const letter = await this.resolve(original, conversationId, signal, actor);
        if (letter.status !== 'available') return letter;
        const replies = projection.messages.map(ref => this.messages.getMessageAtRevision(conversationId, ref.messageId, ref.revision))
          .filter(row => row?.speaker === 'assistant');
        if (!replies.length) return { status: 'revision_unavailable' };
        return this.payload(['先前留下的话', letter.text, ...replies.map(message => 'char：' + message!.revision.content)].join('\n\n'),
          [...letter.assetIds, ...replies.flatMap(message => message!.revision.attachments.map(attachment => attachment.asset_id))]);
      }
      if (item.id !== source.id || item.revision !== source.revision) return { status: 'revision_unavailable' };
      if (source.kind === 'archive') {
        const archive = await this.archives.archiveOriginals(conversationId, source.id, { actor, signal });
        if (!archive.ok) return { status: 'unavailable' };
        const rows = archive.items.slice(source.selection?.start ?? 0, source.selection?.end);
        if (!rows.length || rows.some(row => row.text === null)) return { status: 'revision_unavailable' };
        const text = rows.flatMap(row => {
          const revision = this.messages.getMessageAtRevision(conversationId, row.message_id, row.revision)?.revision;
          const transcript = revision?.attachments.filter(attachment => attachment.presentation === 'voice' && attachment.derived_text)
            .map(attachment => '[原声转写] ' + attachment.derived_text).join('\n');
          const spoken = [row.text, transcript].filter(value => value?.trim()).join('\n');
          return spoken ? [`${row.speaker === 'assistant' ? 'char' : '宿主用户'}：${spoken}`] : [];
        }).join('\n');
        return this.payload(text, rows.flatMap(row => row.attachments?.map(attachment => attachment.asset_id) ?? []));
      }
      const text = [item.title, item.body ?? item.caption].filter(Boolean).join('\n\n');
      // Content's own read authorizes the fixed attachment relationship.
      // Only the model path also needs a frozen, verified voice projection.
      const voice = actor === 'jiaming' && (source.kind === 'moments' || source.kind === 'reserved_note')
        ? { conversationId, expectedRevision: source.selection?.voiceTranscriptRevision, phase } : undefined;
      return this.payload(text, item.asset_id ? [item.asset_id] : item.asset_ids ?? [], voice);
    } catch {
      return { status: 'unavailable' };
    }
  }

  private activeMemory(value: unknown): MemorySource | null {
    const memory = value as Partial<MemorySource> & { visibility?: string; representation?: string; content_gap?: unknown } | null;
    if (!memory || memory.visibility !== 'active' || memory.representation === 'forgotten_summary' || memory.content_gap
      || typeof memory.memory_id !== 'string' || typeof memory.version !== 'number' || typeof memory.text !== 'string' || !memory.text.trim()) return null;
    return memory as MemorySource;
  }

  private async memoryCandidates(conversationId: string, businessDate: string | undefined, signal: AbortSignal): Promise<HeartbeatSource[] | null> {
    if (!this.external.memory || !this.external.dailyMemorySelection || !businessDate || signal.aborted) return null;
    try {
      const selection = await this.external.dailyMemorySelection(conversationId, businessDate, signal);
      if (signal.aborted || !selection || selection.businessDate !== businessDate
        || Date.parse(selection.frozenAt) !== Date.parse(businessDate + 'T00:00:00+08:00')) return null;
      const source = readHeartbeatSource({ kind: 'memory', namespace: 'mariposa', id: selection.memoryId, revision: selection.revision,
        identity: 'mariposa:memory:' + selection.memoryId, permissionScope: conversationId });
      return source && typeof source.revision === 'number' ? [source] : null;
    } catch { return null; }
  }

  private async sharedStars(signal: AbortSignal): Promise<SharedStar[] | null> {
    if (!this.external.wishstar) return null;
    try {
      // The source's shared listing is read-only. Its detail route records a view.
      const response = await this.external.wishstar.forward('GET', '/api/stars/shared', undefined, undefined, signal);
      if (response.status !== 200 || !Array.isArray(response.body.items)) return null;
      return response.body.items.filter((star): star is SharedStar => star?.state === 'SHARED'
        && typeof star.id === 'string' && typeof star.content === 'string' && Boolean(star.content.trim()));
    } catch { return null; }
  }

  private starVersion(star: SharedStar): string {
    return sha256Hex(JSON.stringify([star.content, star.author_name, star.note]));
  }

  private async list(kind: LocalSource, route: string, conversationId: string, signal: AbortSignal): Promise<HeartbeatSource[] | null> {
    if (!this.content) return null;
    const result = await readAllContentPages<ContentItem>(this.content, {
      signal,
      buildPath: cursor => `${route}&limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    });
    if (!result.ok) return null;
    return result.items.flatMap<HeartbeatSource>(item => {
      if (item.deleted || typeof item.id !== 'string' || !Number.isSafeInteger(item.revision)) return [];
      if (kind === 'album' && item.kind !== 'important_photos' && item.kind !== 'chat_screenshots') return [];
      if (kind === 'moments' && item.kind === 'reference') {
        const projection = readHeartbeatProjection(item.reference);
        if (projection?.conversationId !== conversationId || projection.state !== 'drawn'
          || projection.card?.source.kind !== 'reserved_note') return [];
        return [{ kind, namespace: 'content', id: item.id, revision: projection.version,
          identity: `content:moments:first-reserved:${item.id}`, permissionScope: conversationId, replay: 'first_reserved_response' }];
      }
      let identity = `content:${kind}:${item.id}`;
      let selection: HeartbeatSource['selection'];
      if (kind === 'album' || (kind === 'moments' && item.asset_ids?.length === 1 && !item.body?.trim())) {
        const id = item.asset_id ?? item.asset_ids?.[0];
        if (!id) return [];
        try {
          const asset = this.media.getAsset(id);
          const eligibleMime = asset.mime_type.startsWith('image/') || kind === 'moments' && asset.mime_type.startsWith('audio/');
          if (asset.state !== 'available' || asset.m_sync_state !== 'synced' || !asset.m_content_hash || !eligibleMime) return [];
          if (asset.mime_type === 'image/svg+xml' && !this.media.canProvideImage(asset)) return [];
          const original = asset.ingest_purpose === 'derived_view' ? this.media.originalImageAsset(asset) : asset;
          if (original.state !== 'available' || original.m_sync_state !== 'synced' || !original.m_content_hash) return [];
          identity = `mariposa:media:${original.m_content_hash}`;
        } catch { return []; }
      } else if (kind === 'archive') {
        if (!item.messages?.length) return [];
        selection = { start: 0, end: Math.min(item.messages.length, 6) };
        identity = 'estomago:chat-range:' + sha256Hex(JSON.stringify([
          conversationId, item.messages.slice(0, selection.end).map(message => message.message_id),
        ]));
      }
      return [{ kind, namespace: 'content', id: item.id, revision: item.revision, identity, permissionScope: conversationId, selection }];
    });
  }

  private payload(text: string, ids: string[], voice?: {
    conversationId: string; expectedRevision?: string; phase: 'bind' | 'resolve';
  }): CardPayload {
    const assetIds = [...new Set(ids)];
    const images: string[] = [];
    const transcripts: Array<{ id: string; assetHash: string; source: string; text: string }> = [];
    for (const id of assetIds) {
      try {
        const asset = this.media.getAsset(id);
        if (asset.state !== 'available') return { status: 'revision_unavailable' };
        if (asset.mime_type === 'image/svg+xml' && !this.media.canProvideImage(asset)) return { status: 'unavailable' };
        if (asset.mime_type.startsWith('image/')) images.push(id);
        if (voice && asset.mime_type.startsWith('audio/')) {
          if (asset.m_sync_state !== 'synced' || !asset.m_content_hash) return { status: 'unavailable' };
          const transcript = this.external.voice?.readyTranscript(id, voice.conversationId, asset.content_sha256);
          if (!transcript?.derived_text?.trim() || !transcript.derived_source) return { status: 'revision_unavailable' };
          transcripts.push({ id, assetHash: asset.content_sha256, source: transcript.derived_source, text: transcript.derived_text });
        }
      } catch { return { status: 'revision_unavailable' }; }
    }
    const voiceTranscriptRevision = transcripts.length ? sha256Hex(JSON.stringify(transcripts)) : undefined;
    if (voice?.phase === 'resolve' && voice.expectedRevision !== voiceTranscriptRevision) {
      return { status: 'revision_unavailable' };
    }
    const modelText = [text, ...transcripts.map(transcript => '[原声转写] ' + transcript.text)].filter(Boolean).join('\n\n');
    return modelText.trim() || assetIds.length
      ? { status: 'available', text: modelText, assetIds, imageIds: images, ...(voiceTranscriptRevision ? { voiceTranscriptRevision } : {}) }
      : { status: 'revision_unavailable' };
  }
}
