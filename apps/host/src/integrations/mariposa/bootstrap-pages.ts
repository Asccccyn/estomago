import type { MariposaCallResult, MariposaClient } from './client.ts';

type PageClient = Pick<MariposaClient, 'bootstrapNext'>;
type RecordValue = Record<string, unknown>;
export type BootstrapSectionName = 'mood_text' | 'bootstrap' | 'i' | 'event_text' | 'our_words';
export type BootstrapGap = { section: BootstrapSectionName; memoryId?: string; code: string; retryable: boolean };
export type BootstrapCompletion = { data: RecordValue; gaps: BootstrapGap[] };

/** Safe codes only; upstream messages and private content never enter diagnostics. */
export class BootstrapPagingError extends Error {
  readonly code: string;
  readonly section: BootstrapSectionName;
  readonly httpStatus?: number;
  constructor(code: string, section: BootstrapSectionName, httpStatus?: number) {
    super(code); this.name = 'BootstrapPagingError';
    this.code = code; this.section = section; this.httpStatus = httpStatus;
  }
}
const object = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const codePoints = (text: string) => Array.from(text).length;
function fail(code: string, section: BootstrapSectionName): never { throw new BootstrapPagingError(code, section); }
function cancelled(signal: AbortSignal, section: BootstrapSectionName): BootstrapPagingError {
  return new BootstrapPagingError(signal.reason?.name === 'TimeoutError' ? 'BOOTSTRAP_DEADLINE_EXCEEDED' : 'BOOTSTRAP_CANCELLED', section);
}
export function globalBootstrapFailure(error: BootstrapPagingError): boolean {
  return error.httpStatus === 401 || error.httpStatus === 403 || [
    'SNAPSHOT_STALE', 'BOOTSTRAP_CANCELLED', 'BOOTSTRAP_DEADLINE_EXCEEDED',
    'BOOTSTRAP_AUTHORITY_INVALID', 'BOOTSTRAP_SNAPSHOT_MISMATCH',
    'BOOTSTRAP_SNAPSHOT_MISSING', 'BOOTSTRAP_RESOURCE_MISMATCH',
  ].includes(error.code);
}
export function retryableBootstrapFailure(error: BootstrapPagingError): boolean {
  return ['BOOTSTRAP_PAGE_TRANSPORT', 'BOOTSTRAP_PAGE_TIMEOUT'].includes(error.code)
    || error.httpStatus === 408 || error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500;
}
function authority(value: RecordValue, section: BootstrapSectionName, required = false): void {
  if ((required || value.instruction_authority !== undefined) && value.instruction_authority !== 'none') fail('BOOTSTRAP_AUTHORITY_INVALID', section);
  if ((required || value.content_role !== undefined) && value.content_role !== 'bootstrap_memory_package') fail('BOOTSTRAP_AUTHORITY_INVALID', section);
}

/** A per-request timeout does not abort the parent window. Parent cancellation does. */
export async function bootstrapCall(
  call: (signal: AbortSignal) => Promise<MariposaCallResult>,
  options: { signal?: AbortSignal; timeoutMs?: number; section?: BootstrapSectionName } = {},
): Promise<RecordValue> {
  const section = options.section ?? 'bootstrap';
  const timeoutMs = options.timeoutMs ?? 1500;
  if (options.signal?.aborted) throw cancelled(options.signal, section);
  const child = new AbortController();
  const result = await new Promise<MariposaCallResult>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: MariposaCallResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      if (error) { child.abort(); reject(error); } else resolve(value!);
    };
    const onAbort = () => finish(cancelled(options.signal!, section));
    const timer = setTimeout(() => finish(new BootstrapPagingError('BOOTSTRAP_PAGE_TIMEOUT', section)), timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      if (options.signal?.aborted) throw cancelled(options.signal, section);
      if (child.signal.aborted) throw new BootstrapPagingError('BOOTSTRAP_PAGE_TIMEOUT', section);
      return call(child.signal);
    }).then(value => finish(undefined, value), error => finish(error instanceof BootstrapPagingError ? error : new BootstrapPagingError('BOOTSTRAP_PAGE_TRANSPORT', section)));
  });
  if (options.signal?.aborted) throw cancelled(options.signal, section);
  if (!result.ok) {
    const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(result.code) ? result.code : 'BOOTSTRAP_PAGE_FAILED';
    throw new BootstrapPagingError(code, section, result.httpStatus);
  }
  if (!object(result.result)) fail('BOOTSTRAP_SHAPE_INVALID', section);
  return result.result;
}

export type BootstrapPagingOptions = { signal?: AbortSignal; maxPages?: number; maxBytes?: number; pageTimeoutMs?: number; maxDurationMs?: number };

/**
 * Resolve mood fields independently. A failed field loses its entire text, including
 * the first fragment. The caller must validate the original snapshot before it may
 * deliver data with gaps; stale/auth/authority/cancellation errors are never local.
 */
export async function completeBootstrapPages(client: PageClient, packet: RecordValue, options: BootstrapPagingOptions = {}): Promise<BootstrapCompletion> {
  const maxPages = options.maxPages ?? 64, maxBytes = options.maxBytes ?? 512 * 1024;
  const timeoutMs = options.pageTimeoutMs ?? 1500;
  const maxDurationMs = options.maxDurationMs ?? 4000;
  if (![maxPages, maxBytes, timeoutMs].every(v => integer(v) && v > 0) || !integer(maxDurationMs)) throw new RangeError('Invalid bootstrap paging limits');
  // Slow optional mood pages cannot consume the entire window preparation
  // deadline and starve I or the final same-snapshot validation.
  const deadline = performance.now() + maxDurationMs;
  const signal = options.signal ?? AbortSignal.timeout(8000);
  if (signal.aborted) throw cancelled(signal, 'bootstrap');
  if (!object(packet)) fail('BOOTSTRAP_SHAPE_INVALID', 'bootstrap');
  authority(packet, 'bootstrap');
  const memorySection = packet.memory_days;
  if (memorySection != null && (!object(memorySection) || (memorySection.items !== undefined && !Array.isArray(memorySection.items)))) fail('BOOTSTRAP_SHAPE_INVALID', 'bootstrap');
  const snapshotId = typeof packet.snapshot_id === 'string' && packet.snapshot_id ? packet.snapshot_id : null;
  const output = { ...packet }; delete output.anniversaries;
  const gaps: BootstrapGap[] = [];
  let requests = 0, bytes = 0;
  const measure = (text: string) => { bytes += Buffer.byteLength(JSON.stringify(text), 'utf8'); if (bytes > maxBytes) fail('BOOTSTRAP_BYTE_LIMIT', 'mood_text'); };
  const next = async (cursor: RecordValue) => {
    if (!snapshotId) fail('BOOTSTRAP_SNAPSHOT_MISSING', 'mood_text');
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) fail('BOOTSTRAP_MOOD_TIME_LIMIT', 'mood_text');
      if (requests >= maxPages) fail('BOOTSTRAP_PAGE_LIMIT', 'mood_text');
      requests++;
      try {
        const page = await bootstrapCall(s => client.bootstrapNext(snapshotId, cursor, 'memory_item', s), { signal, timeoutMs: Math.min(timeoutMs, remaining), section:'mood_text' });
        if (page.snapshot_id !== snapshotId) fail('BOOTSTRAP_SNAPSHOT_MISMATCH', 'mood_text');
        if (page.section !== 'memory_item') fail('BOOTSTRAP_RESOURCE_MISMATCH', 'mood_text');
        authority(page, 'mood_text', true);
        return page;
      } catch (error) {
        if (!(error instanceof BootstrapPagingError) || globalBootstrapFailure(error) || !retryableBootstrapFailure(error) || attempt >= 1) throw error;
      }
    }
  };
  if (object(memorySection)) {
    const items: RecordValue[] = [];
    for (const original of (memorySection.items ?? []) as unknown[]) {
      if (!object(original)) fail('BOOTSTRAP_SHAPE_INVALID', 'bootstrap');
      const item = { ...original };
      try {
        if ((item.mood_text != null && typeof item.mood_text !== 'string') || (item.mood_text_truncated !== undefined && typeof item.mood_text_truncated !== 'boolean')) fail('BOOTSTRAP_SHAPE_INVALID', 'mood_text');
        let content = typeof item.mood_text === 'string' ? item.mood_text : '';
        measure(content); let loaded = codePoints(content);
        const initialTotal = item.mood_text_total_chars;
        if (initialTotal !== undefined && !integer(initialTotal)) fail('BOOTSTRAP_TOTAL_INVALID', 'mood_text');
        let total = integer(initialTotal) ? initialTotal : null;
        let cursor = item.mood_text_next;
        if (item.mood_text_truncated === true && cursor == null) fail('BOOTSTRAP_CURSOR_MISSING', 'mood_text');
        const seen = new Set<number>();
        while (cursor != null) {
          if (!object(cursor) || cursor.memory_id !== item.memory_id || typeof item.memory_id !== 'string' || !item.memory_id || cursor.field !== 'mood_text' || !integer(cursor.offset)) fail('BOOTSTRAP_CURSOR_INVALID', 'mood_text');
          const offset = cursor.offset;
          if (seen.has(offset)) fail('BOOTSTRAP_CURSOR_REPEATED', 'mood_text');
          if (offset !== loaded) fail('BOOTSTRAP_OFFSET_MISMATCH', 'mood_text');
          seen.add(offset);
          const page = await next(cursor);
          if (page.memory_id !== item.memory_id || page.field !== 'mood_text') fail('BOOTSTRAP_RESOURCE_MISMATCH', 'mood_text');
          if (page.offset !== offset) fail('BOOTSTRAP_OFFSET_MISMATCH', 'mood_text');
          if (typeof page.content !== 'string' || !page.content.length) fail('BOOTSTRAP_NO_PROGRESS', 'mood_text');
          if (!integer(page.total_chars) || (total != null && page.total_chars !== total)) fail('BOOTSTRAP_TOTAL_MISMATCH', 'mood_text');
          total = page.total_chars; measure(page.content);
          const end = loaded + codePoints(page.content);
          if (end > total) fail('BOOTSTRAP_TOTAL_MISMATCH', 'mood_text');
          if (!Object.hasOwn(page, 'next_cursor')) fail('BOOTSTRAP_CURSOR_MISSING', 'mood_text');
          const upcoming = page.next_cursor;
          if (upcoming != null) {
            if (!object(upcoming) || upcoming.memory_id !== item.memory_id || upcoming.field !== 'mood_text' || !integer(upcoming.offset)) fail('BOOTSTRAP_CURSOR_INVALID', 'mood_text');
            if (seen.has(upcoming.offset)) fail('BOOTSTRAP_CURSOR_REPEATED', 'mood_text');
            if (upcoming.offset !== end) fail('BOOTSTRAP_OFFSET_MISMATCH', 'mood_text');
          } else if (end !== total) fail('BOOTSTRAP_INCOMPLETE', 'mood_text');
          content += page.content; loaded = end; cursor = upcoming;
        }
        if (total != null && loaded !== total) fail('BOOTSTRAP_INCOMPLETE', 'mood_text');
        if (item.mood_text_next != null) { item.mood_text = content; item.mood_text_next = null; item.mood_text_truncated = false; }
      } catch (error) {
        if (!(error instanceof BootstrapPagingError) || globalBootstrapFailure(error)) throw error;
        for (const key of ['mood_text','mood_text_next','mood_text_truncated','mood_text_total_chars']) delete item[key];
        gaps.push({section:'mood_text', ...(typeof item.memory_id === 'string' ? {memoryId:item.memory_id} : {}), code:error.code, retryable:retryableBootstrapFailure(error) || error.code === 'BOOTSTRAP_MOOD_TIME_LIMIT'});
      }
      items.push(item);
    }
    output.memory_days = { ...memorySection, items };
  }
  if (signal.aborted) throw cancelled(signal, 'bootstrap');
  return {data:output,gaps};
}
