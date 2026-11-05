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
import { endCallConfirmed } from '../../modules/voice/call-service.ts';

export async function reconcileVoiceCallsOnStartup(db: Db, sirenCall: SirenAdapter | null, signal?: AbortSignal): Promise<{ ended: number; kept: number; skipped: number }> {
  const out = { ended: 0, kept: 0, skipped: 0 };
  if (!sirenCall) return out;
  // R1（复核 20261104）：候选除 active 外，还包括"已收口(ended)、确实连接过、但缺 call_end
  // 事实"的行——前端先收口后 lifecycle 通知丢失的场景（ended 行被旧查询筛掉=对账永远
  // 不查 S、事实永远缺失）。这些行只补事实：正本确认 ended/无此通话才登记（幂等）；
  // 正本仍 sessionActive=保留不补（通话可能还在）。never-connected 的行由 R2 出口规则
  // 天然不产事实，无须在此排除。
  const rows = db.prepare(`SELECT vc.call_id, vc.connected_at, vc.reserved_until FROM voice_calls vc
    WHERE vc.state='active'
       OR (vc.state='ended' AND vc.connected_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM pending_program_facts f WHERE f.id = 'call_end:' || vc.call_id))`)
    .all() as Array<{ call_id: string; connected_at: string | null; reserved_until: string | null }>;
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
      endCallConfirmed(db, row.call_id); // F01/R1：对账确认终态=共同出口（投影+事实），回调丢失在此补齐
      out.ended++;
      continue;
    }
    if (status.sessionActive) { out.kept++; continue; }
    const neverConnected = !row.connected_at;
    const reservationExpired = row.reserved_until !== null && Date.parse(row.reserved_until) <= Date.now();
    if (neverConnected && reservationExpired) {
      endCallConfirmed(db, row.call_id); // F01：孤儿收口同走共同出口（事实登记幂等）
      out.ended++;
      continue;
    }
    out.kept++;
  }
  return out;
}
