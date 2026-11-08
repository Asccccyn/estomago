// 人工选集的容量估计与水位助手——R4b（2026-11-07）自 supervisor 迁出，行为逐字保留。
// §6.2：选集+A/B 系统段+待回答输入一起算；界=有效软线 min(soft, C-O-T-R-S)——
// 装得下还要过请求级容量终检，这里只做选集级预检。H04：待回答/排队输入不作为历史带入。
import type { Db } from '../db/connection.ts';
import type { Config } from '../config/schema.ts';

/** 选集容量估计上下文。driver=null（SDK 无信封映射）→ 粗估回退：不做选集级
 *  容量预检（请求级容量门仍在 SDK 侧），系统段记 0、界=不设限；tokenizer 未知=rough。 */
export function selectionEstimateContext(input: {
  driver: { charsPerToken: number; maxTokens: number } | null;
  systemChars: number;
  windows: Pick<Config['windows'], 'model_context_capacity' | 'soft_limit_tokens' | 'tool_input_reserve_tokens' | 'review_reserve_tokens' | 'safety_reserve_tokens'>;
  tailInputChars: number;
}): { charsPerToken: number; systemChars: number; tailInputChars: number; capacityBoundTokens: number } {
  if (!input.driver) {
    return { charsPerToken: 1.5, systemChars: 0, tailInputChars: input.tailInputChars, capacityBoundTokens: Number.MAX_SAFE_INTEGER };
  }
  const w = input.windows;
  const capacity = w.model_context_capacity ?? Number.MAX_SAFE_INTEGER;
  const bound = Math.min(w.soft_limit_tokens, capacity - input.driver.maxTokens - w.tool_input_reserve_tokens - w.review_reserve_tokens - w.safety_reserve_tokens);
  return { charsPerToken: input.driver.charsPerToken, systemChars: input.systemChars, tailInputChars: input.tailInputChars, capacityBoundTokens: Math.max(0, bound) };
}

/** 选择面截止水位：最后一条"已了结"消息（其 turn 非 pending/blocked）——
 *  待回答与排队输入不得作为历史带入（H04）。 */
export function selectionCutoffSequence(db: Db, conversationId: string): number {
  const row = db.prepare(
    `SELECT MAX(m.sequence) AS m FROM messages m
     LEFT JOIN turns t ON t.input_message_id = m.id
     WHERE m.conversation_id = ? AND (t.id IS NULL OR t.state NOT IN ('pending','blocked'))`,
  ).get(conversationId) as { m: number | null };
  return row?.m ?? 0;
}

/** 待回答/排队输入的总字符（容量估计并入"当前待回答输入"，H04/H05）。 */
export function selectionPendingInputChars(db: Db, conversationId: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(LENGTH(r.content)), 0) AS chars FROM messages m
     JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
     JOIN turns t ON t.input_message_id = m.id
     WHERE m.conversation_id = ? AND (t.state = 'pending' OR (t.state = 'blocked' AND EXISTS (SELECT 1 FROM attempts a WHERE a.turn_id=t.id AND a.state='blocked' AND (a.blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' OR a.blocked_reason LIKE 'CONTEXT_ROTATION_REQUIRED%'))))`,
  ).get(conversationId) as { chars: number };
  return row?.chars ?? 0;
}
