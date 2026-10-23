// The one background settlement path used by live usage and end-of-run recovery.
// Unknown charges retain their reservation; known late receipts can settle once.
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';

function verifiedMicroUsd(cost: number | null): number | null {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return null;
  const rounded = Math.round(cost * 1_000_000);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

export function settleBackgroundDispatch(db: Db, dispatchId: string, input: { actualCostMicroUsd: number | null; outcomeCode: string; providerRequestId?: string | null; nowIso?: string }): boolean {
  const actual = input.actualCostMicroUsd;
  if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0)) throw new Error('BACKGROUND_SETTLEMENT_INVALID');
  return tx(db, () => {
    const prior = db.prepare('SELECT run_id,state FROM background_dispatches WHERE id=?').get(dispatchId) as { run_id: string; state: string } | undefined;
    if (!prior || !['reserved', 'started', 'unknown'].includes(prior.state)) return false;
    const nowIso = input.nowIso ?? new Date().toISOString();
    const updated = db.prepare("UPDATE background_dispatches SET state=?,actual_cost_micro_usd=?,settled_at=?,outcome_code=?,provider_request_id=COALESCE(?,provider_request_id) WHERE id=? AND state=?")
      .run(actual === null ? 'unknown' : 'settled', actual, nowIso, input.outcomeCode, input.providerRequestId ?? null, dispatchId, prior.state);
    if (Number(updated.changes) !== 1) return false;
    const sums = db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual_cost_micro_usd ELSE 0 END),0) AS known,
      COALESCE(SUM(CASE WHEN state IN ('reserved','started','unknown') THEN reserved_cost_micro_usd ELSE 0 END),0) AS reserved,
      SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END) AS unknown_count FROM background_dispatches WHERE run_id=?`).get(prior.run_id) as { known: number; reserved: number; unknown_count: number };
    db.prepare('UPDATE background_runs SET known_cost_micro_usd=?,reserved_cost_micro_usd=?,unknown_cost_count=?,updated_at=? WHERE id=?').run(sums.known, sums.reserved, sums.unknown_count, nowIso, prior.run_id);
    return true;
  });
}

/** Only complete per-request usage settles a provider request. A turn/cumulative
 * aggregate must never be charged to one request and then charged again. */
export function settleBackgroundUsage(db: Db, requestId: string): void {
  const request = db.prepare('SELECT background_dispatch_id FROM provider_requests WHERE id=?').get(requestId) as { background_dispatch_id: string | null } | undefined;
  if (!request?.background_dispatch_id) return;
  const usage = db.prepare("SELECT cost_usd FROM usage_observations WHERE request_id=? AND scope='request' AND completeness='complete' AND cost_usd IS NOT NULL ORDER BY observed_at DESC LIMIT 1").get(requestId) as { cost_usd: number } | undefined;
  const micro = verifiedMicroUsd(usage?.cost_usd ?? null);
  settleBackgroundDispatch(db, request.background_dispatch_id, { actualCostMicroUsd: micro, outcomeCode: micro === null ? 'cost_unknown' : 'settled', providerRequestId: requestId });
}

/** Final sweep also preserves missing usage and external tool costs as unknown.
 * An early live usage settlement is already terminal and cannot double charge. */
export function settleBackgroundRun(db: Db, runId: string): void {
  const rows = db.prepare("SELECT bd.id,pr.id AS request_id FROM background_dispatches bd LEFT JOIN provider_requests pr ON pr.background_dispatch_id=bd.id WHERE bd.run_id=? AND bd.state IN ('reserved','started','unknown')").all(runId) as Array<{ id: string; request_id: string | null }>;
  for (const row of rows) {
    if (row.request_id) settleBackgroundUsage(db, row.request_id);
    else settleBackgroundDispatch(db, row.id, { actualCostMicroUsd: null, outcomeCode: 'cost_unknown' });
  }
}
