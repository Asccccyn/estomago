// R6′（2026-10-23）：oído 删除传播重试——outbox 式意图收口。
// 独立定时器驱动（不经调度器/会话串行链）；每跳 ≤1 条意图（限速）；指数退避按
// attempts 计（updated_at 距今 ≥ 30s*2^min(attempts,6) 才可重试）；404/成功=删意图行。
import type { Db } from '../../db/connection.ts';
import type { OidoAdapter } from './adapter.ts';

export async function retryOneOidoDelete(db: Db, oido: OidoAdapter, signal: AbortSignal): Promise<'done' | 'retry_scheduled' | 'backoff' | 'idle'> {
  if (signal.aborted) return 'idle';
  const now = Date.now();
  const rows = db.prepare('SELECT est_asset_id, oido_audio_id, attempts, updated_at FROM oido_delete_intents ORDER BY created_at ASC').all() as Array<{ est_asset_id: string; oido_audio_id: string; attempts: number; updated_at: string }>;
  // attempts=0（新意图）立即首试；失败后按指数退避（30s·2^min(attempts,6)）
  const due = rows.find((r) => r.attempts === 0 || now - Date.parse(r.updated_at) >= 30_000 * 2 ** Math.min(r.attempts, 6));
  if (!due) return rows.length > 0 ? 'backoff' : 'idle';
  try {
    await oido.deleteAudio({ audioId: due.oido_audio_id, signal });
    db.prepare('DELETE FROM oido_delete_intents WHERE est_asset_id = ?').run(due.est_asset_id);
    return 'done';
  } catch {
    db.prepare('UPDATE oido_delete_intents SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE est_asset_id = ?')
      .run('retry_pending', new Date().toISOString(), due.est_asset_id);
    return 'retry_scheduled';
  }
}
