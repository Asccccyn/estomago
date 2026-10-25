// Host-only billing metadata. It is never added to tool schemas or model output.
import type { Db } from '../db/connection.ts';
import { ContractError } from './or-contract.ts';
// P01.1：BackgroundToolQuote 叶类型正本迁至 capabilities/contracts.ts；此处重导出为过渡兼容
//（消费者逐步改指 contracts；删除批次登记在 MIGRATION_MATRIX / P09）。
import type { BackgroundToolQuote } from '../capabilities/contracts.ts';
export type { BackgroundToolQuote };
export const BACKGROUND_TOOL_PRICES_KEY = 'background_tool_prices';

// S17b 批次3：业务免费名单已删——免费资格由各模块声明（quote 返回 verifiedFree）；
// discovery 入口的免费政策属 capabilities/model-bridge。本文件仅保留可信配置报价读取。
/** A positive trusted per-invocation upper bound is required for other handlers.
 * This is a price quote, never permission and never an actual-cost receipt.
 * No key/price lookup and no user budget default is performed here. */
export function quoteBackgroundTool(db: Db, toolName: string): BackgroundToolQuote {
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
