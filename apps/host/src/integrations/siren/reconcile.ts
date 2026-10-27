// est voice_calls 投影对账；Host 拥有启动、定时触发和关闭取消。
// Siren 是通话生死正本；终态通知（lifecycle end）与浏览器挂断都可能丢失——
// 宿主启动时按正本逐一核对 active 投影，只处理**确定事实**：
//   - Siren 正本 ended / 正本无此通话 → 收口（通知丢失、linger/断线/重启 endAllActive 均收敛于此）；
//   - WS 会话仍在 → 保留；
//   - 正本 active 但无会话：从未连接（connected_at 空）且签发时效（reserved_until）
//     已过 → 永不可连，收口孤儿（与接听重放的收口语义同一事实依据）；
//     时效未过 → 保留（她可能正要连接）。token 时效本身不结束已连接的通话
//    （connected_at 有值但正本 active 的组合在正本模型下不可达，保守保留）。
// 通知本身幂等（DELETE /v1/calls），对账只修正确定的终态。
import type { Db } from '../../db/connection.ts';
import type { SirenAdapter } from './adapter.ts';

export async function reconcileVoiceCallsOnStartup(db: Db, sirenCall: SirenAdapter | null, signal?: AbortSignal): Promise<{ ended: number; kept: number; skipped: number }> {
  const out = { ended: 0, kept: 0, skipped: 0 };
  if (!sirenCall) return out;
  const rows = db.prepare("SELECT call_id, connected_at, reserved_until FROM voice_calls WHERE state='active'").all() as Array<{ call_id: string; connected_at: string | null; reserved_until: string | null }>;
  for (const row of rows) {
    if (signal?.aborted) break;
    let status: Awaited<ReturnType<SirenAdapter['callStatus']>>;
    try {
      status = await sirenCall.callStatus(row.call_id, { signal });
    } catch {
      out.skipped++; // Siren 不可达：不动投影，下一次对账重试。
      continue;
    }
    if (signal?.aborted) break;
    const now = new Date().toISOString();
    if (status === null || status === 'not_found' || status.dbStatus === 'ended') {
      db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id=? AND state='active'").run(now, row.call_id);
      out.ended++;
      continue;
    }
    if (status.sessionActive) { out.kept++; continue; }
    const neverConnected = !row.connected_at;
    const reservationExpired = row.reserved_until !== null && Date.parse(row.reserved_until) <= Date.now();
    if (neverConnected && reservationExpired) {
      db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id=? AND state='active'").run(now, row.call_id);
      out.ended++;
      continue;
    }
    out.kept++;
  }
  return out;
}
