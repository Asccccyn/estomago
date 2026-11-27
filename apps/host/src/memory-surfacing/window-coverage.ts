import type { Db } from '../db/connection.ts';
import { isRecollectionText, LEGACY_SURFACE_NOTICE, type SurfaceItem } from './contracts.ts';
import { sourceCoverageRange } from './source-boundary.ts';
import { sha256Hex } from '../util/id.ts';
import { isWithheldToolResult } from '../runtime/tool-result-retention.ts';

import type { CoverageRange } from '../capabilities/contracts.ts';
export type { CoverageRange } from '../capabilities/contracts.ts';

export function coverageRanges(value: unknown): CoverageRange[] {
  if (!Array.isArray(value)) return [];
  return value.filter((range): range is CoverageRange => {
    if (!range || typeof range !== 'object') return false;
    const { resource_ref, content_version, start_char, end_char } = range;
    return typeof resource_ref === 'string' && resource_ref.length > 0
      && typeof content_version === 'string' && content_version.length > 0
      && Number.isSafeInteger(start_char) && start_char >= 0
      && Number.isSafeInteger(end_char) && end_char > start_char;
  }).map(({ resource_ref, content_version, start_char, end_char }) => ({
    resource_ref, content_version, start_char, end_char,
  }));
}

export function uncoveredRanges(range: CoverageRange, covered: readonly CoverageRange[]): CoverageRange[] {
  const overlaps = covered.filter(previous => previous.resource_ref === range.resource_ref
    && previous.content_version === range.content_version && previous.start_char < range.end_char
    && previous.end_char > range.start_char).sort((a, b) => a.start_char - b.start_char);
  const uncovered: CoverageRange[] = [];
  let start = range.start_char;
  for (const previous of overlaps) {
    if (previous.start_char > start) uncovered.push({ ...range, start_char: start, end_char: previous.start_char });
    start = Math.max(start, previous.end_char);
  }
  if (start < range.end_char) uncovered.push({ ...range, start_char: start });
  return uncovered;
}

export function surfaceItemBodyRanges(item: SurfaceItem): CoverageRange[] {
  if (item.coverage_ranges !== undefined) return coverageRanges(item.coverage_ranges);
  if ((item.kind ?? 'event') !== 'event' || !item.memory_id || !item.memory_version || !item.event_text) return [];
  // Older confirmed event deliveries carried the entire immutable bucket version.
  return [{ resource_ref: `memory:${item.memory_id}`, content_version: item.memory_version,
    start_char: 0, end_char: [...item.event_text].length }];
}

export function surfaceItemRanges(item: SurfaceItem): CoverageRange[] {
  const context = (item.kind === 'words' || item.kind === 'source') && item.source_context_text
    ? coverageRanges(item.source_context_ranges) : [];
  return [...surfaceItemBodyRanges(item), ...context];
}

/** Project verified body and neighbour ranges in the same coordinate space as active reads. */
export function unreadSurfaceItem(item: SurfaceItem, covered: readonly CoverageRange[]): SurfaceItem | null {
  if (item.kind !== 'source' && item.matched_memory) {
    // The selected bucket is atomic. Keep the complete body and quotes when
    // any part is new, and record only the ranges newly delivered in this window.
    const unread = surfaceItemBodyRanges(item).flatMap(range => uncoveredRanges(range, covered));
    return unread.length ? { ...item, coverage_ranges: unread } : null;
  }
  const original = item.quote_text ?? item.event_text;
  const body = projectCoveredText(original, surfaceItemBodyRanges(item), covered, [], false, item.coverage_text_offset);
  const metadata = { ...item };
  delete metadata.source_context_parts;
  delete metadata.coverage_text_offset;
  delete metadata.unread_parts;
  let context = item.source_context_text;
  let contextRanges = coverageRanges(item.source_context_ranges);
  if (item.source_context_parts) {
    const lines: string[] = [];
    contextRanges = [];
    for (const part of item.source_context_parts) {
      const result = projectCoveredText(part.text, coverageRanges(part.coverage_ranges),
        covered, [...body.delivered, ...contextRanges]);
      const texts = result.status === 'full' ? [part.text] : result.parts.map(piece => piece.text);
      for (const text of texts) lines.push(`${part.speaker}(${part.date})：${text}`);
      contextRanges.push(...result.delivered);
    }
    context = lines.join('\n');
  } else if (contextRanges.length && contextRanges.every(r => !uncoveredRanges(r, covered).length)) {
    context = null;
    contextRanges = [];
  }
  const pieces = body.parts;
  const text = body.status === 'full' ? original : pieces.map(piece => piece.text).join('\n…\n');
  if (!text && !context) return null;
  return { ...metadata, event_text: text, ...(item.quote_text != null ? { quote_text: text } : {}),
    ...(pieces.length ? { unread_parts: pieces } : {}),
    coverage_ranges: body.delivered, source_context_text: context, source_context_ranges: contextRanges };
}

type CoverageMessage = {
  role: string;
  tool_call_id?: string;
  content: string | Array<{ type: string; text?: string }>;
};
type ConfirmedRequest = { payload_json: string; payload_wire_json: string | null; seen_manifest_json: string };

function messagesIn(json: string | null): CoverageMessage[] {
  if (!json) return [];
  const value = JSON.parse(json);
  return Array.isArray(value?.messages) ? value.messages : Array.isArray(value) ? value : [];
}

function toolResultIds(messages: readonly CoverageMessage[]): Set<string> {
  return new Set(messages.flatMap(message => message.role === 'tool' && message.tool_call_id && !isWithheldToolResult(message.content) ? [message.tool_call_id] : []));
}

function automaticBlocks(messages: readonly CoverageMessage[]): Set<string> {
  return new Set(messages.flatMap(message => {
    if (Array.isArray(message.content)) {
      const [notice, packet] = message.content;
      if (message.role === 'user' && message.content.length === 1 && notice?.type === 'text' && notice.text && isRecollectionText(notice.text)) return [notice.text];
      return notice?.type === 'text' && notice.text === LEGACY_SURFACE_NOTICE && packet?.type === 'text' && packet.text
        ? [packet.text] : [];
    }
    // DeepSeek concatenates text blocks without a delimiter. The host envelope
    // and the receipt still share the unchanged frozen packet.
    if (message.role === 'user' && typeof message.content === 'string' && isRecollectionText(message.content)) return [message.content];
    if (typeof message.content === 'string' && message.content.startsWith(LEGACY_SURFACE_NOTICE)) {
      return [message.content.slice(LEGACY_SURFACE_NOTICE.length).replace(/^\n/, '')];
    }
    return [];
  }));
}

function textBlocks(message: CoverageMessage): string[] {
  if (typeof message.content === 'string') return [message.content];
  return message.content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []);
}

function systemBlocks(messages: readonly CoverageMessage[]): Map<string, string> {
  return new Map(messages.filter(message => message.role === 'system').flatMap(message =>
    textBlocks(message).map(text => [sha256Hex(text), text])));
}

type WindowProjection = { ranges: CoverageRange[]; known: string[] };

/** A tool receipt remains pending until its result is present in the confirmed request. */
function projectWindow(db: Db, windowId: string, requestId?: string | null, includeKnown = false): WindowProjection {
  const ranges: CoverageRange[] = [];
  const known: string[] = [];
  if (!windowId) return { ranges, known };
  const req = (requestId
    ? db.prepare('SELECT payload_json,payload_wire_json,seen_manifest_json FROM provider_requests WHERE id=? AND window_id=? AND sent_at IS NOT NULL').get(requestId, windowId)
    : db.prepare(`SELECT payload_json,payload_wire_json,seen_manifest_json FROM provider_requests
        WHERE window_id=? AND sent_at IS NOT NULL AND purpose IN ('chat','proactive_turn','cache_keepalive')
        ORDER BY sent_at DESC,rowid DESC LIMIT 1`).get(windowId)) as ConfirmedRequest | undefined;
  if (!req) return { ranges, known };

  const sent = messagesIn(req.payload_wire_json ?? req.payload_json);
  const toolIds = toolResultIds(sent);
  const visibleBlocks = automaticBlocks(sent);
  const system = systemBlocks(sent);
  if (!requestId) {
    const trajectory = db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id=?')
      .get(windowId) as { messages_json: string } | undefined;
    if (!trajectory) return { ranges, known };
    const current = messagesIn(trajectory.messages_json);
    const effectiveTools = toolResultIds(current);
    const effectiveBlocks = automaticBlocks(current);
    const effectiveSystem = systemBlocks(current);
    for (const id of toolIds) if (!effectiveTools.has(id)) toolIds.delete(id);
    for (const block of visibleBlocks) if (!effectiveBlocks.has(block)) visibleBlocks.delete(block);
    for (const hash of system.keys()) if (!effectiveSystem.has(hash)) system.delete(hash);
  }

  if (visibleBlocks.size > 0) {
    const deliveries = db.prepare(`SELECT payload_text,selected_refs_json FROM surfacing_deliveries
      WHERE window_id=? AND state IN ('dispatch_started','retained') ORDER BY rowid DESC`).all(windowId) as Array<{
        payload_text: string; selected_refs_json: string;
      }>;
    for (const delivery of deliveries) {
      if (visibleBlocks.has(delivery.payload_text)) {
        const { items } = JSON.parse(delivery.selected_refs_json) as { items: SurfaceItem[] };
        for (const item of items) {
          ranges.push(...surfaceItemRanges(item));
          if (includeKnown) {
            if (item.kind !== 'source' && item.matched_memory) {
              known.push(item.matched_memory.text, ...item.matched_memory.our_words.map(word => word.text));
            } else {
              known.push(item.quote_text ?? item.event_text);
            }
            if ((item.kind === 'words' || item.kind === 'source') && item.source_context_text) known.push(item.source_context_text);
          }
        }
      }
    }
  }

  const toolRanges = new Map<string, CoverageRange[]>();
  const usedSystem = new Set<string>();
  const openingRanges: CoverageRange[] = [];
  const openingFacts: string[] = [];
  if (toolIds.size || system.size) {
    const results = db.prepare(`SELECT manifest.value AS record FROM provider_requests p,
        json_each(p.seen_manifest_json) AS manifest
        WHERE p.window_id=? AND p.sent_at IS NOT NULL AND manifest.type='object'
          AND (json_type(manifest.value, '$.tool_coverage')='array'
            OR json_type(manifest.value, '$.window_coverage')='array')
        ORDER BY p.rowid DESC`).all(windowId) as Array<{ record: string }>;
    for (const row of results) {
      const entry = JSON.parse(row.record) as {
        tool_coverage?: Array<{ tool_call_id: string; ranges: unknown }>;
        window_coverage?: unknown;
        window_coverage_block?: string;
      };
      for (const tool of entry.tool_coverage ?? []) {
        if (toolIds.has(tool.tool_call_id) && !toolRanges.has(tool.tool_call_id)) {
          toolRanges.set(tool.tool_call_id, coverageRanges(tool.ranges));
        }
      }
      if (entry.window_coverage_block && system.has(entry.window_coverage_block) && !usedSystem.has(entry.window_coverage_block)) {
        usedSystem.add(entry.window_coverage_block);
        openingRanges.push(...coverageRanges(entry.window_coverage));
        if (includeKnown) {
          const text = system.get(entry.window_coverage_block)!;
          openingFacts.push(...text.split('\n').filter(line => /^  (事件|他|她)：/.test(line)));
        }
      }
    }
  }
  for (const message of [...sent].reverse()) {
    const metadata = message.role === 'tool' && message.tool_call_id ? toolRanges.get(message.tool_call_id) : undefined;
    if (!metadata?.length) continue;
    // Controlled JSON output only; prose in other messages does not establish a resource identity.
    ranges.push(...metadata);
    if (!includeKnown) continue;
    const payload = textBlocks(message)[0];
    if (!payload?.startsWith('{')) continue;
    const packet = JSON.parse(payload) as Record<string, unknown>;
    const rows = ['candidates', 'entries', 'source', 'our_words'].flatMap(key =>
      Array.isArray(packet[key]) ? packet[key] as Array<Record<string, unknown>> : []);
    for (const row of [packet, ...rows]) {
      if (typeof row.text === 'string') known.push(row.text);
      if (typeof row.excerpt === 'string') known.push(row.excerpt);
      const fragment = row.fragment as { text?: unknown; unread_parts?: Array<Record<string, unknown>> } | undefined;
      if (typeof fragment?.text === 'string') known.push(fragment.text);
      const items = [
        ...(Array.isArray(row.evidence) ? row.evidence as Array<Record<string, unknown>> : []),
        // 2026-11-26 recall 投影改版：配套原话从 evidence 挪到候选级 quotes，
        // 定位扫描同步认新键，否则已投递原话不被记为已入窗、后续会重复投递。
        ...(Array.isArray(row.quotes) ? row.quotes as Array<Record<string, unknown>> : []),
        ...(Array.isArray(row.unread_parts) ? row.unread_parts as Array<Record<string, unknown>> : []),
        ...(fragment?.unread_parts ?? []),
      ];
      for (const item of items) {
        if (typeof item.snippet === 'string') known.push(item.snippet);
        if (typeof item.text === 'string') known.push(item.text);
      }
    }
  }

  ranges.push(...openingRanges);
  known.push(...openingFacts);
  const actualManifest = JSON.parse(req.seen_manifest_json) as Array<{
    id?: string; revision?: number; visible?: boolean; pending_dispatch?: boolean; char_start?: number; char_end?: number;
  }>;
  for (const entry of [...actualManifest].reverse()) {
    if (entry.visible === true && entry.pending_dispatch !== true && entry.id && Number.isSafeInteger(entry.revision)) {
      const range = sourceCoverageRange(db, { ...entry, id: entry.id, revision: entry.revision! });
      if (range) ranges.push(range);
    }
  }
  return { ranges, known };
}

export function windowCoverage(db: Db, windowId: string, requestId?: string | null): CoverageRange[] {
  const all = projectWindow(db, windowId, requestId).ranges.map(range => {
    if (!range.resource_ref.startsWith('conversation_message:')) return range;
    return sourceCoverageRange(db, { id: range.resource_ref.slice('conversation_message:'.length),
      revision: Number(range.content_version), char_start: range.start_char, char_end: range.end_char }) ?? range;
  });
  const priority = new Map<string, number>();
  const key = (range: CoverageRange) => JSON.stringify([range.resource_ref, range.content_version]);
  all.forEach((range, index) => { if (!priority.has(key(range))) priority.set(key(range), index); });
  return mergeCoverageRanges(all).sort((a, b) => priority.get(key(a))! - priority.get(key(b))!);
}

export function windowCoverageDigest(db: Db, windowId: string, maxItems: number, maxChars: number, dialogueText: string): string[] {
  const letters = [...dialogueText.replace(/[^\p{L}\p{N}]/gu, '')];
  const terms = [...new Set(letters.slice(0, -1).map((letter, index) => letter + letters[index + 1]))];
  const relevance = (text: string) => {
    const body = text.replace(/\s+/g, '');
    return terms.reduce((matches, term) => matches + Number(body.includes(term)), 0);
  };
  return [...new Set(projectWindow(db, windowId, undefined, true).known)]
    .map(text => ({ text, relevance: relevance(text) }))
    .filter(item => item.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxItems)
    .map(item => [...item.text.replace(/\s+/g, ' ')].slice(0, maxChars).join(''));
}

export function coveredRangesForMariposa(ranges: readonly CoverageRange[]): CoverageRange[] {
  return ranges.filter(range => !range.resource_ref.startsWith('conversation_message:')).slice(0, 256);
}

export function mergeCoverageRanges(ranges: readonly CoverageRange[]): CoverageRange[] {
  const ordered = [...ranges].sort((a, b) => a.resource_ref.localeCompare(b.resource_ref)
    || a.content_version.localeCompare(b.content_version) || a.start_char - b.start_char);
  const merged: CoverageRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && previous.resource_ref === range.resource_ref && previous.content_version === range.content_version
        && previous.end_char >= range.start_char) {
      previous.end_char = Math.max(previous.end_char, range.end_char);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Each range addresses the same field, possibly through a verified source alias. */
export function projectCoveredText(
  text: string,
  ranges: readonly CoverageRange[],
  confirmed: readonly CoverageRange[],
  pending: readonly CoverageRange[] = [],
  reread = false,
  textOffset?: number,
): {
  status: 'full' | 'partial' | 'already_in_window' | 'included_in_this_request';
  parts: Array<{ start_char: number; end_char: number; text: string }>;
  delivered: CoverageRange[];
} {
  const codePoints = [...text];
  const offset = textOffset ?? 0;
  const length = textOffset === undefined ? codePoints.length :
    ranges[0] ? ranges[0].end_char - ranges[0].start_char : 0;
  const exact = Number.isSafeInteger(offset) && offset >= 0 && offset + length <= codePoints.length
    ? ranges.filter(range => range.end_char - range.start_char === length)
    : [];
  const first = exact[0];
  if (!first || reread) return { status: 'full', parts: [], delivered: exact };
  const available = (covered: readonly CoverageRange[]) => {
    const blocked = exact.flatMap(range => covered.filter(prior => prior.resource_ref === range.resource_ref
      && prior.content_version === range.content_version).map(prior => ({
      ...first,
      start_char: prior.start_char - range.start_char + first.start_char,
      end_char: prior.end_char - range.start_char + first.start_char,
    })));
    return uncoveredRanges(first, blocked);
  };
  const unread = available(confirmed);
  if (unread.length === 0) return { status: 'already_in_window', parts: [], delivered: [] };
  const toSend = pending.length > 0 ? available([...confirmed, ...pending]) : unread;
  if (toSend.length === 0) return { status: 'included_in_this_request', parts: [], delivered: [] };
  if (toSend.length === 1 && toSend[0]!.start_char === first.start_char && toSend[0]!.end_char === first.end_char) {
    return { status: 'full', parts: [], delivered: exact };
  }
  return {
    status: 'partial',
    parts: toSend.map(range => ({
      start_char: range.start_char, end_char: range.end_char,
      text: codePoints.slice(range.start_char - first.start_char + offset, range.end_char - first.start_char + offset).join(''),
    })),
    delivered: exact.flatMap(alias => toSend.map(range => ({
      ...alias, start_char: alias.start_char + range.start_char - first.start_char,
      end_char: alias.start_char + range.end_char - first.start_char,
    }))),
  };
}
