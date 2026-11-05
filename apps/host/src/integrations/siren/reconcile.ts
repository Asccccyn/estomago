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
  // R1/R3（复核 20261104 生命周期重构）：候选除 active 外，还包括"已收口(ended)但缺
  // call_end 事实"的行——**不再以本地 connected_at 预筛**（register 通知可丢，为空不等于
  // 从未连接；R3 复现：真实话轮完成+结束回调到达仍被漏记）。是否真有会话由 S 权威
  // started_at + 本地证据（connected_at/真实话轮）在共同出口统一判定（callHadRealSession）。
  // 终态确认（ended/无此通话）才登记；sessionActive=保留不补。
  // 有界性：ended 缺事实的候选限定近 7 天（收口已久且无事实的预留行不再反复查 S；
  // 真实通话的事实缺失会在首个对账周期内补齐，不受此限影响）。
  const rows = db.prepare(`SELECT vc.call_id, vc.connected_at, vc.reserved_until FROM voice_calls vc
    WHERE vc.state='active'
       OR (vc.state='ended' AND vc.ended_at > datetime('now', '-7 days')
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
      // R3：S 权威 started_at 作为证据传入——register 丢失但 S 会话真实建立过的通话由此补记
      endCallConfirmed(db, row.call_id, { sirenStartedAt: status && status !== 'not_found' ? status.startedAt : null });
      out.ended++;
      continue;
    }
    if (status.sessionActive) { out.kept++; continue; }
    // 孤儿判定（R2/R3 统一）：本地与 S 均无真实会话证据（连接/话轮/started_at）且预留
    // 时效已过 → 收口投影（无事实）。register 丢失但有真实话轮/连接的行不会被误清。
    const hasSessionEvidence = row.connected_at !== null
      || Boolean(db.prepare('SELECT 1 FROM voice_stream_turns WHERE call_id=? LIMIT 1').get(row.call_id))
      || status.startedAt != null;
    const reservationExpired = row.reserved_until !== null && Date.parse(row.reserved_until) <= Date.now();
    if (!hasSessionEvidence && reservationExpired) {
      endCallConfirmed(db, row.call_id); // 孤儿预留收口：无证据→共同出口不登记事实（R2 保留）
      out.ended++;
      continue;
    }
    out.kept++;
  }
  return out;
}
