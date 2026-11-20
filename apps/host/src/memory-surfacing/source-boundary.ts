// 触发消息的全部修订不能自证历史。实际已读仅从已确认投影的具体范围导出。
import type { Db } from '../db/connection.ts';
import type { CoverageRange } from '../capabilities/contracts.ts';
import { sha256Hex } from '../util/id.ts';
import { effectiveRevisionText } from '../messages/effective-text.ts';

/** 多个 origin 消息 id → 去重后的 sm id 集（按收据表全修订收全）。
 *  RR4-W2e（林石见 2026-11-10 修正稿）：**不截断**——排除资格是正确性约束，
 *  E 先截断再把截断结果当完整集合下推，会让封存内容回流。调用方如需有界展示
 *  自行切片；来源资格排除一律全量。 */
export function syncedSourceIdsFor(db: Db, originMessageIds: string[]): string[] {
  const out = new Set<string>();
  for (const id of originMessageIds) {
    if (typeof id !== 'string' || id.length === 0) continue;
    const rows = db.prepare(
      'SELECT source_message_id FROM source_sync_receipts WHERE origin_message_id = ? AND source_message_id IS NOT NULL',
    ).all(id) as Array<{ source_message_id: string }>;
    for (const r of rows) {
      const sid = r.source_message_id.startsWith('source_msg:') ? r.source_message_id.slice('source_msg:'.length) : r.source_message_id;
      if (sid.startsWith('sm_')) out.add(sid);
    }
  }
  return [...out];
}


/** A chat range is valid locally even before source sync has acknowledged it. */
export function sourceCoverageRange(
  db: Db,
  ref: { id: string; revision: number; char_start?: number; char_end?: number },
  text?: string,
): CoverageRange | null {
  const row = db.prepare(`SELECT m.content,r.source_message_id,r.content_hash FROM message_revisions m
    LEFT JOIN source_sync_receipts r ON r.origin_message_id=m.message_id AND r.revision=m.revision
    WHERE m.message_id=? AND m.revision=?`).get(ref.id, ref.revision) as {
      content: string; source_message_id: string | null; content_hash: string | null;
    } | undefined;
  if (!row) return null;
  // A blank voice message alone proves no transcript was delivered. Only when
  // the caller supplies actual projected text may we verify the saved transcript.
  const content = text === undefined ? row.content : effectiveRevisionText(db, ref.id, ref.revision, row.content);
  const codePoints = [...content];
  const start = ref.char_start ?? 0;
  const end = ref.char_end ?? codePoints.length;
  if (start < 0 || end > codePoints.length || end <= start
    || (text !== undefined && codePoints.slice(start, end).join('') !== text)) return null;
  const sourceId = row.source_message_id?.replace(/^source_msg:/, '');
  const identity = sourceId?.startsWith('sm_') && row.content_hash && row.content_hash === sha256Hex(content)
    ? { resource_ref: `source_msg:${sourceId}`, content_version: row.content_hash }
    : { resource_ref: `conversation_message:${ref.id}`, content_version: String(ref.revision) };
  return { ...identity, start_char: start, end_char: end };
}
