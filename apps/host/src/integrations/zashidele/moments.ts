import type { IntegrationConfig } from '../../config/schema.ts';

const MOMENTS_PATH = '/api/integrations/estomago/moments';
export const ZASHIDELE_MOMENTS_PATH = '/api/v1/content/moments-external';

export type ZashideleMoment = {
  id: string; revision: string; author_id: string; author_name: string | null;
  author_kind: 'human' | 'chat_ai' | 'agent_ai'; scope: 'self' | 'attendees' | 'everyone';
  source_kind: 'archive_item' | 'manual_post'; created_at: string; text: string;
};

function sourceMoment(value: unknown): ZashideleMoment | null {
  const item = value as Partial<ZashideleMoment> | null;
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.author_id !== 'string'
    || typeof item.revision !== 'string' || !/^[0-9a-f]{64}$/.test(item.revision)
    || (item.author_name !== null && typeof item.author_name !== 'string')
    || (item.author_kind !== 'human' && item.author_kind !== 'chat_ai' && item.author_kind !== 'agent_ai')
    || (item.scope !== 'self' && item.scope !== 'attendees' && item.scope !== 'everyone')
    || (item.source_kind !== 'archive_item' && item.source_kind !== 'manual_post')
    || typeof item.created_at !== 'string' || !Number.isFinite(Date.parse(item.created_at)) || typeof item.text !== 'string') return null;
  return {
    id: item.id, revision: item.revision, author_id: item.author_id, author_name: item.author_name,
    author_kind: item.author_kind, scope: item.scope, source_kind: item.source_kind, created_at: item.created_at, text: item.text,
  };
}

export class ZashideleMoments {
  private readonly base: URL | null;
  private readonly credentialRef: string | null;
  private readonly transport: typeof fetch;

  constructor(config: IntegrationConfig, transport: typeof fetch = fetch) {
    this.credentialRef = config.credential_ref;
    this.transport = transport;
    this.base = null;
    try {
      if (config.base_url) {
        const url = new URL(config.base_url);
        const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
        if ((url.protocol === 'https:' || url.protocol === 'http:' && loopback)
          && !url.username && !url.password && !url.search && !url.hash) this.base = url;
      }
    } catch { /* unavailable integration */ }
  }

  async read(id: string | null, query: URLSearchParams, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const token = this.credentialRef && process.env[this.credentialRef];
    const unavailable = { status: 503, body: { error: { code: 'zashidele_feed_unavailable', message: '扎西德勒客厅暂不可用。' } } };
    if (!this.base || !token) return unavailable;
    if (id !== null && (id === '.' || id === '..' || id.includes('/') || !id || id.length > 200)) {
      return { status: 400, body: { error: { code: 'zashidele_feed_query_invalid', message: '原帖地址无效。' } } };
    }
    const url = new URL(this.base);
    url.pathname = url.pathname.replace(/\/$/, '') + MOMENTS_PATH + (id === null ? '' : '/' + encodeURIComponent(id));
    if (id === null) {
      for (const key of ['limit', 'cursor']) {
        const value = query.get(key);
        if (value !== null) url.searchParams.set(key, value);
      }
    }
    try {
      const response = await this.transport(url, {
        method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500), cache: 'no-store',
      });
      if (response.status === 404 && id !== null) {
        return { status: 404, body: { error: { code: 'zashidele_post_unreadable', message: '原帖当前不可读。' } } };
      }
      if (response.status === 401 || response.status === 403) {
        return { status: 403, body: { error: { code: 'zashidele_feed_forbidden', message: '扎西德勒未授予当前连接阅读权限。' } } };
      }
      if (response.status === 400) {
        return { status: 400, body: { error: { code: 'zashidele_feed_query_invalid', message: '客厅阅读游标无效，请刷新。' } } };
      }
      if (response.status !== 200) return unavailable;
      const payload = await response.json() as unknown;
      if (id !== null) {
        const item = sourceMoment(payload);
        return item?.id === id ? { status: 200, body: item } : unavailable;
      }
      const page = payload as { items?: unknown[]; next_cursor?: string | null } | null;
      if (!Array.isArray(page?.items) || page.items.length > 50
        || (page.next_cursor !== null && (typeof page.next_cursor !== 'string' || !page.next_cursor))) return unavailable;
      const items = page.items.map(sourceMoment);
      return items.every(Boolean) ? { status: 200, body: { items, next_cursor: page.next_cursor } } : unavailable;
    } catch { return unavailable; }
  }
}
