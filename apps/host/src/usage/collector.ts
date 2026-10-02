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

  // 账本视图：每个 attempt 一行 + 汇总（已知值求和；任一未知则该项标 unknown）
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
    // F15：request 与 turn 是同一消耗的两种口径——每个 attempt 只呈现一种：
    // 有 request 观测用其求和；否则用 turn 最新观测；都没有只剩 cumulative 快照。
    // 绝不把 request 合计与 turn 汇总相加（同轮两者并存会双倍虚增）。
    type Row = (typeof rows)[number];
    const buckets = new Map<string, { requests: Row[]; turnLatest: Row | null; cumulativeLatest: Row | null }>();
    for (const r of rows) {
      let b = buckets.get(r.attempt_id);
      if (!b) {
        b = { requests: [], turnLatest: null, cumulativeLatest: null };
        buckets.set(r.attempt_id, b);
      }
      if (r.scope === 'request') b.requests.push(r);
      else if (r.scope === 'turn') b.turnLatest = r;
      else b.cumulativeLatest = r;
    }
    const sumOf = (rs: Row[], f: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'): number | null =>
      rs.some((r) => r[f] == null) ? null : rs.reduce((s, r) => s + (r[f] ?? 0), 0);
    const attempts: Array<{ attempt_id: string; scope: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; completeness: string }> = [];
    let inSum = 0, outSum = 0, inUnknown = false, outUnknown = false;
    const seen = new Set<string>();
    for (const [attemptId, b] of buckets) {
      seen.add(attemptId);
      const useRequests = b.requests.length > 0;
      const src: Row[] = useRequests ? b.requests : b.turnLatest ? [b.turnLatest] : b.cumulativeLatest ? [b.cumulativeLatest] : [];
      const scope = useRequests ? 'request' : b.turnLatest ? 'turn' : 'cumulative';
      const completeness = src.length === 0 ? 'missing' : src.every((r) => r.completeness === 'complete') ? 'complete' : 'partial';
      attempts.push({
        attempt_id: attemptId, scope, model: src[0]?.model ?? null,
        input_tokens: sumOf(src, 'input_tokens'),
        output_tokens: sumOf(src, 'output_tokens'),
        cache_read_input_tokens: sumOf(src, 'cache_read_input_tokens'),
        cache_creation_input_tokens: sumOf(src, 'cache_creation_input_tokens'),
        completeness,
      });
      if (scope !== 'cumulative') {
        const a = attempts[attempts.length - 1]!;
        if (a.input_tokens == null) inUnknown = true; else inSum += a.input_tokens;
        if (a.output_tokens == null) outUnknown = true; else outSum += a.output_tokens;
        if (completeness !== 'complete') { inUnknown = true; outUnknown = true; } // F15：partial/missing 不冒充完整总额
      }
    }
    // F15：该 turn 存在但完全没有 usage 观测的 attempt（如 failed 早退）→ 如实列 null 行并置 unknown
    const declared = this.db.prepare('SELECT id FROM attempts WHERE turn_id = ?').all(turnId) as Array<{ id: string }>;
    for (const m of declared) {
      if (seen.has(m.id)) continue;
      attempts.push({ attempt_id: m.id, scope: 'none', model: null, input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, completeness: 'missing' });
      inUnknown = true;
      outUnknown = true;
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
