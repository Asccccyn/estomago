import type { Db } from '../db/connection.ts';
import type { OrRequestEnvelope } from './runner.ts';
import { ContractError } from './or-contract.ts';

/** One validated quote at each actual model dispatch. Text UTF-8 bytes provide
 * a conservative token ceiling; tools and protocol framing are included. This
 * is reservation only, never fabricated actual usage or a new monetary cap. */
export function estimateModelRequestCostMicroUsd(db: Db, envelope: OrRequestEnvelope): number {
  const row = db.prepare("SELECT value FROM runtime_settings WHERE key='or_model_price'").get() as { value: string } | undefined;
  let price: Record<string, unknown>;
  try { price = JSON.parse(row?.value ?? 'null'); } catch { throw new ContractError('BUDGET_ESTIMATE_UNAVAILABLE'); }
  const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!price || !valid(price.input_micro_per_token) || !valid(price.output_micro_per_token)) throw new ContractError('BUDGET_ESTIMATE_UNAVAILABLE');
  const write = price.cache_write_micro_per_token ?? price.input_micro_per_token * 2;
  if (!valid(write) || !Number.isSafeInteger(envelope.maxTokens) || envelope.maxTokens <= 0) throw new ContractError('BUDGET_ESTIMATE_UNAVAILABLE');
  const inputUpper = Buffer.byteLength(JSON.stringify({ messages: envelope.messages, tools: envelope.tools }), 'utf8') + 32 * (envelope.messages.length + envelope.tools.length + 1);
  const quote = Math.ceil(inputUpper * Math.max(write, price.input_micro_per_token) + envelope.maxTokens * price.output_micro_per_token);
  if (!Number.isSafeInteger(quote) || quote <= 0) throw new ContractError('BUDGET_ESTIMATE_UNAVAILABLE');
  return quote;
}
