// 用量账本 v0.2.2（AUD-18 修复）：按 attempt/request 幂等记账；展示按 attempt 分列 + 明确规则汇总，
// 不再用 scope:model → latest 覆盖。未知为 null 不填零。
import type { Db } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import type { RawUsage } from '../../../../packages/contracts/src/sdk-events.ts';

export class UsageCollector {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  record(o: {
    turnId: string; attemptId: string; scope: 'request' | 'turn' | 'cumulative';
    usage: RawUsage; model?: string | null; requestId?: string | null;
    source: 'sdk_result' | 'sdk_stream' | 'estimated';
    completeness?: 'complete' | 'partial' | 'unknown';
  }): void {
    // 幂等键：(attempt, scope, request_id, model, source)；同键重复事件不重复入账（AUD-18/USE-01）
    const dup = this.db
      .prepare('SELECT id FROM usage_observations WHERE attempt_id = ? AND scope = ? AND source = ? AND request_id IS ? AND model IS ?')
      .get(o.attemptId, o.scope, o.source, o.requestId ?? null, o.model ?? null) as { id: string } | undefined;
    if (dup) {
      this.db
        .prepare('UPDATE usage_observations SET input_tokens = ?, output_tokens = ?, cache_read_input_tokens = ?, cache_creation_input_tokens = ?, completeness = ?, observed_at = ? WHERE id = ?')
        .run(o.usage.input_tokens ?? null, o.usage.output_tokens ?? null, o.usage.cache_read_input_tokens ?? null, o.usage.cache_creation_input_tokens ?? null, o.completeness ?? 'complete', new Date().toISOString(), dup.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO usage_observations(id, request_id, attempt_id, turn_id, scope, model,
           input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, source, completeness, observed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        genId('use'), o.requestId ?? null, o.attemptId, o.turnId, o.scope, o.model ?? null,
        o.usage.input_tokens ?? null, o.usage.output_tokens ?? null,
        o.usage.cache_read_input_tokens ?? null, o.usage.cache_creation_input_tokens ?? null,
        o.source, o.completeness ?? 'complete', new Date().toISOString(),
      );
  }

  // 账本视图：每个 attempt 一行（取该 attempt 最新观测）+ 汇总（已知值求和；任一未知则该项标 unknown）
  summaryForTurn(turnId: string): {
    attempts: Array<{ attempt_id: string; scope: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; completeness: string }>;
    totals: { input_tokens: number | null; output_tokens: number | null; unknown_present: boolean };
  } {
    const rows = this.db
      .prepare('SELECT * FROM usage_observations WHERE turn_id = ? ORDER BY observed_at')
      .all(turnId) as Array<{
      id: string; attempt_id: string; scope: string; model: string | null;
      input_tokens: number | null; output_tokens: number | null;
      cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; completeness: string;
    }>;
    // F15：同 attempt 聚合全部 request（非 cumulative）；cumulative 单列
    const perAttempt = new Map<string, { attempt_id: string; scope: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; completeness: string }>();
    for (const r of rows) {
      if (r.scope === 'cumulative') continue; // cumulative 是基线快照，单独列
      const cur = perAttempt.get(r.attempt_id);
      if (!cur) {
        perAttempt.set(r.attempt_id, { ...r });
      } else {
        // 同 attempt 多 request：求和（同维度有 null 则保留 null）
        cur.input_tokens = cur.input_tokens == null || r.input_tokens == null ? null : cur.input_tokens + r.input_tokens;
        cur.output_tokens = cur.output_tokens == null || r.output_tokens == null ? null : cur.output_tokens + r.output_tokens;
        cur.cache_read_input_tokens = cur.cache_read_input_tokens == null || r.cache_read_input_tokens == null ? null : cur.cache_read_input_tokens + r.cache_read_input_tokens;
        cur.cache_creation_input_tokens = cur.cache_creation_input_tokens == null || r.cache_creation_input_tokens == null ? null : cur.cache_creation_input_tokens + r.cache_creation_input_tokens;
        cur.completeness = cur.completeness === 'complete' && r.completeness === 'complete' ? 'complete' : 'partial';
      }
    }
    const attempts = [...perAttempt.values()].map((r) => ({
      attempt_id: r.attempt_id, scope: r.scope, model: r.model,
      input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      cache_read_input_tokens: r.cache_read_input_tokens, cache_creation_input_tokens: r.cache_creation_input_tokens,
      completeness: r.completeness,
    }));
    let inSum = 0, outSum = 0, inUnknown = false, outUnknown = false;
    for (const a of attempts) {
      if (a.scope === 'cumulative') continue; // §20：累计口径是基线快照，不与 request/turn 相加
      if (a.input_tokens == null) inUnknown = true; else inSum += a.input_tokens;
      if (a.output_tokens == null) outUnknown = true; else outSum += a.output_tokens;
    }
    const empty = attempts.length === 0;
    return {
      attempts,
      totals: {
        input_tokens: empty || inUnknown ? null : inSum,
        output_tokens: empty || outUnknown ? null : outSum,
        unknown_present: inUnknown || outUnknown,
      },
    };
  }
}
