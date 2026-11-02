// 执行包 P2 §6.5：默认注入不再携带 audio_ref；工具调用时由宿主从**实际装载视野**（D13）
// 补齐真实引用。只有一条明确目标语音→直接补齐；多条/没有→仅在该次工具操作给出必要、
// 简短的定位信息（候选列表），不让模型猜编号。纯读库，无副作用。
import type { Db } from '../db/connection.ts';

export type SeenRef = { id: string; revision: number };
export type VoiceRefCandidate = { assetId: string; sequence: number | null; occurredAt: string | null };
export type VoiceRefResolution =
  | { kind: 'unique'; assetId: string }
  | { kind: 'ambiguous'; candidates: VoiceRefCandidate[] };

export function resolveCurrentVoice(db: Db, roomId: string, seen: ReadonlyArray<SeenRef>): VoiceRefResolution {
  const seenMap = new Map(seen.map(s => [s.id, s.revision]));
  const rows = db.prepare(
    `SELECT ma.asset_id AS asset_id, ma.message_id AS message_id, ma.revision AS revision,
            m.sequence AS sequence, m.created_at AS created_at
     FROM message_attachments ma
     JOIN messages m ON m.id = ma.message_id AND m.current_revision = ma.revision
     WHERE m.conversation_id = ? AND ma.presentation = 'voice'
     ORDER BY m.sequence DESC LIMIT 24`,
  ).all(roomId) as Array<{ asset_id: string; message_id: string; revision: number; sequence: number | null; created_at: string | null }>;
  const seenHits = new Map<string, VoiceRefCandidate>();
  for (const row of rows) {
    if (seenMap.get(row.message_id) === row.revision && !seenHits.has(row.asset_id)) {
      seenHits.set(row.asset_id, { assetId: row.asset_id, sequence: row.sequence, occurredAt: row.created_at });
    }
  }
  const seenCandidates = [...seenHits.values()];
  if (seenCandidates.length === 1) return { kind: 'unique', assetId: seenCandidates[0]!.assetId };
  const pool = seenCandidates.length > 1
    ? seenCandidates
    : rows.slice(0, 5).map(r => ({ assetId: r.asset_id, sequence: r.sequence, occurredAt: r.created_at }));
  return { kind: 'ambiguous', candidates: pool.slice(0, 5) };
}

export function candidateLocator(candidates: VoiceRefCandidate[]): string {
  return candidates
    .map(c => `est:${c.assetId}（第${c.sequence ?? '?'}条${c.occurredAt ? ' · ' + String(c.occurredAt).slice(11, 16) + 'Z' : ''}）`)
    .join('；');
}
