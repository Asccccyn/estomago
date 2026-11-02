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

/** 多个 origin 消息 id → 去重后的 sm id 集（按收据表全修订收全）。 */
export function syncedSourceIdsFor(db: Db, originMessageIds: string[], cap = 128): string[] {
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
    if (out.size >= cap) break;
  }
  return [...out].slice(0, cap);
}

/** 当前活动窗实际携带的消息 id（owner/assistant；cutoff_sequence 之后），
 *  最新优先有界返回——这是"本次有效输入"的原文身份区间（B3）。 */
export function windowContextMessageIds(db: Db, conversationId: string, cap = 128): string[] {
  const win = db.prepare(
    "SELECT id, cutoff_sequence FROM windows WHERE conversation_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
  ).get(conversationId) as { id: string; cutoff_sequence: number | null } | undefined;
  if (!win) return [];
  const cutoff = win.cutoff_sequence ?? 0;
  const rows = db.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND sequence > ? AND speaker IN ('owner','assistant') ORDER BY sequence DESC LIMIT ?",
  ).all(conversationId, cutoff, cap) as Array<{ id: string }>;
  return rows.map(r => r.id);
}
