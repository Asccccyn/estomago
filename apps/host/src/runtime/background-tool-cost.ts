// Host-only billing metadata. It is never added to tool schemas or model output.
import type { Db } from '../db/connection.ts';
import { ContractError } from './or-contract.ts';
// P01.1：BackgroundToolQuote 叶类型正本迁至 capabilities/contracts.ts；此处重导出为过渡兼容
//（消费者逐步改指 contracts；删除批次登记在 MIGRATION_MATRIX / P09）。
import type { BackgroundToolQuote } from '../capabilities/contracts.ts';
export type { BackgroundToolQuote };
export const BACKGROUND_TOOL_PRICES_KEY = 'background_tool_prices';

// These entries are based on the actual current handlers, not names such as
// "read" or "local". New or unreviewed tools always require an explicit quote.
// See the audit's TOOL_COST_EVIDENCE.md for the inspected downstream paths.
const VERIFIED_FREE_HANDLERS = new Set([
  'tool_catalog', 'tool_define', // frozen SQLite catalog/definition projection
  'conversation_read', // local message/revision SELECTs
  'wake_manage', 'background_complete', 'context_review_complete', // local SQL
  'creation_save_artifact', 'identity_milestone_write', // local files + SQLite
  // Publication is local SQL + outbox. ArchiveSync only source.ingest/status:
  // Mariposa source/ingest.py writes raw files/SQLite/FTS; no provider dispatch.
  'chat_send_text', 'chat_send_attachment',
  // Confirmed downstream reads, including all branches exposed by these tools:
  // memory/detail.py read_page; identity_i/service.py getters; plans list/get.
  'memory_read_full', 'memory_i_read', 'plans_read',
]);

/** A positive trusted per-invocation upper bound is required for other handlers.
 * This is a price quote, never permission and never an actual-cost receipt.
 * No key/price lookup and no user budget default is performed here. */
export function quoteBackgroundTool(db: Db, toolName: string): BackgroundToolQuote {
  if (VERIFIED_FREE_HANDLERS.has(toolName)) return { toolName, maxCostMicroUsd: 0, verifiedFree: true };
  const row = db.prepare('SELECT value FROM runtime_settings WHERE key=?').get(BACKGROUND_TOOL_PRICES_KEY) as { value: string } | undefined;
  let prices: Record<string, unknown> | null = null;
  try {
    const value: unknown = row ? JSON.parse(row.value) : null;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) prices = value as Record<string, unknown>;
  } catch { /* Invalid quotes fail closed with the same public error. */ }
  const entry = prices && Object.hasOwn(prices, toolName) ? prices[toolName] : null;
  const upper = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>).max_cost_micro_usd : null;
  if (typeof upper !== 'number' || !Number.isSafeInteger(upper) || upper <= 0) throw new ContractError('BUDGET_ESTIMATE_UNAVAILABLE');
  return { toolName, maxCostMicroUsd: upper, verifiedFree: false };
}
