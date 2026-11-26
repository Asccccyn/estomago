import type { ZashideleMoment, ZashideleMoments } from '../../integrations/zashidele/moments.ts';
import type { HeartbeatSourceAdapter } from './sources.ts';
import type { HeartbeatSource } from '../../../../../packages/contracts/src/heartbeat.ts';

const kind = 'ext:living-room' as const;
const namespace = 'zashidele';
const readable = (item: ZashideleMoment): boolean => item.scope !== 'self' && Boolean(item.text.trim());

/** Independent opt-in for the real read-only integration, never family or the
 * private self-only posts of the credential's reader. */
export function livingRoomHeartbeatSource(client: ZashideleMoments, enabled: () => boolean): HeartbeatSourceAdapter {
  return {
    kind, namespace, enabled,
    async list(conversationId, signal) {
      const refs: HeartbeatSource[] = [], seen = new Set<string>();
      let cursor: string | null = null;
      do {
        if (signal.aborted) return null;
        const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
        const response = await client.read(null, query, signal);
        if (response.status !== 200) return null;
        const page = response.body as { items: ZashideleMoment[]; next_cursor: string | null };
        for (const item of page.items) if (readable(item)) refs.push({ kind, namespace, id: item.id,
          revision: item.revision, identity: `zashidele:moment:${item.id}`, permissionScope: conversationId });
        cursor = page.next_cursor;
        if (cursor && seen.has(cursor)) return null;
        if (cursor) seen.add(cursor);
      } while (cursor);
      return signal.aborted ? null : refs;
    },
    async resolve(source, _conversationId, signal) {
      const response = await client.read(source.id, new URLSearchParams(), signal);
      if (response.status === 403) return { status: 'forbidden' };
      // Source conflates deleted/withdrawn/unreadable. Do not fall back to
      // stale cached text or pretend it is a deletion receipt.
      if (response.status === 404) return { status: 'forbidden' };
      if (response.status !== 200) return { status: 'unavailable' };
      const item = response.body as ZashideleMoment;
      if (!readable(item)) return { status: 'forbidden' };
      if (item.revision !== source.revision) return { status: 'revision_unavailable' };
      return { status: 'available', text: [item.author_name, item.text].filter(Boolean).join('\n\n'), assetIds: [], imageIds: [] };
    },
  };
}
