// RECALL_SOURCE_BOUNDARY（2026-11-01，她批：附件 GLM_RECALL_SOURCE_BOUNDARY_REPAIR）：
// E 是实际上下文的持有方——把"当前请求不能自证过去"的来源边界解析成 M 侧
// sm id 后随检索请求下推（M 执行统一资格；B5：复用现成合同字段，E 不要求
// Sol/模型猜任何 ID）。
//  - excluded（历史证据资格，自动浮现+主动 recall 共用）：触发消息的全部
//    修订与网关回声——source_sync_receipts 按 (origin_message_id, *) 收全；
//  - inContext（仅自动补充去重）：当前窗实际携带的原文（cutoff_sequence
//    之后的消息），自动注入不再重复提供（T07 换窗携带同受抑）；主动 recall
//    不用此集（用户明确核对时可重读，B4）。
// 键=来源身份（sm id），绝不按文本相等（真旧原文逐字相同仍合格，T05）。
// 未同步（无收据）的消息无法定位 → 如实缺席（fail-open，不猜 sm id）。
import type { Db } from '../db/connection.ts';

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

/** 当前活动窗实际携带的消息 id——G1-F03（裁定 2026-11-03）修正映射：
 *  ① 边界序列取**最近 CLOSED 窗的 cutoff_sequence**（换窗时写在旧窗行上；
 *    ACTIVE 新窗该列恒 NULL，旧实现读 ACTIVE 行 → NULL 按 0 = 会话最近
 *    N 条，既误排未携带旧文也漏排已携带原文）；首个窗口无 CLOSED 前驱
 *    =无携带，边界 0 语义正确。
 *  ② 人工携带原文：window_trajectories.manifest_json 的 id 条目（换窗
 *    选集带入的旧消息，sequence ≤ 边界但确在本窗上下文）。
 *  两者并集、最新优先有界返回（B3"本次有效输入"的原文身份区间）。 */
export function windowContextMessageIds(db: Db, conversationId: string, cap = 128): string[] {
  const active = db.prepare(
    "SELECT id FROM windows WHERE conversation_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
  ).get(conversationId) as { id: string } | undefined;
  if (!active) return [];
  const prev = db.prepare(
    "SELECT cutoff_sequence FROM windows WHERE conversation_id = ? AND status = 'CLOSED' AND cutoff_sequence IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
  ).get(conversationId) as { cutoff_sequence: number } | undefined;
  const cutoff = prev?.cutoff_sequence ?? 0;
  const rows = db.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND sequence > ? AND speaker IN ('owner','assistant') ORDER BY sequence DESC LIMIT ?",
  ).all(conversationId, cutoff, cap) as Array<{ id: string }>;
  const ids = new Set(rows.map(r => r.id));
  const traj = db.prepare(
    'SELECT manifest_json FROM window_trajectories WHERE window_id = ?',
  ).get(active.id) as { manifest_json: string } | undefined;
  if (traj?.manifest_json) {
    try {
      const manifest = JSON.parse(traj.manifest_json) as Array<{ id?: string }>;
      for (const e of manifest) {
        if (typeof e?.id === 'string' && e.id.length > 0 && ids.size < cap) ids.add(e.id);
      }
    } catch { /* manifest 损坏=如实只带本窗新消息，不猜 */ }
  }
  return [...ids].slice(0, cap);
}
