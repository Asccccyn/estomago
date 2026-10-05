// 用量账本 v0.3（AUD-18/F15 修复）：先保留原始观测，再按确定性规则归一化出本轮总额。
//  - 幂等键 = (attempt, scope, request_id, model)：source 只是来源证据，不进唯一键——
//    同一 provider 请求从 sdk_stream 与 sdk_result 到达是同一消耗的两份观测，只记一份
//    （complete 覆盖 partial；partial 不得覆盖已有的 complete）。
//  - 总额口径（每个 attempt 一选）：完整 turn 汇总权威 → 仅当无可靠 turn 时用 request 求和
//    （且仅在回合已 completed 且全部 request 观测完整时才算数）。cumulative 是全局基线快照，
//    单列展示、绝不入总额，也不冒充本轮 0。缺观测/partial/口径冲突 → 总额 unknown，不补零。
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
    source: 'sdk_result' | 'sdk_stream' | 'or_stream' | 'estimated';
    completeness?: 'complete' | 'partial' | 'unknown';
  }): void {
    // 幂等键：(attempt, scope, request_id, model)——F15：source 不进键（同请求跨来源=同一消耗）。
    // 口径区分：source 只标来源证据；OR 行 input_tokens 携带"总输入（含缓存分类）"语义（§9.3），
    // 与 SDK 事件的非缓存口径分列展示，绝不求和混算。
    const dup = this.db
      .prepare('SELECT id, completeness FROM usage_observations WHERE attempt_id = ? AND scope = ? AND request_id IS ? AND model IS ?')
      .get(o.attemptId, o.scope, o.requestId ?? null, o.model ?? null) as { id: string; completeness: string } | undefined;
    if (dup) {
      // 最终/完整值覆盖临时值；partial 不覆盖已有 complete
      const oldIsComplete = dup.completeness === 'complete';
      const newIsComplete = (o.completeness ?? 'complete') === 'complete';
      if (oldIsComplete && !newIsComplete) return;
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

  // 账本视图：每个 attempt 一行（所选口径）+ 汇总（已知值求和；任一未知则该项标 unknown）
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
    type Row = (typeof rows)[number];
    const sumOf = (rs: Row[], f: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'): number | null =>
      rs.length === 0 ? null : rs.some((r) => r[f] == null) ? null : rs.reduce((s, r) => s + (r[f] ?? 0), 0);

    const attempts: Array<{ attempt_id: string; scope: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; completeness: string }> = [];
    let inSum = 0, outSum = 0, inUnknown = false, outUnknown = false;
    const seen = new Set<string>();
    const declared = this.db.prepare('SELECT id FROM attempts WHERE turn_id = ?').all(turnId) as Array<{ id: string }>;
    const attemptIds = [...new Set([...declared.map((d) => d.id), ...rows.map((r) => r.attempt_id)])];
    for (const attemptId of attemptIds) {
      seen.add(attemptId);
      const mine = rows.filter((r) => r.attempt_id === attemptId);
      const requests = mine.filter((r) => r.scope === 'request');
      const turnRows = mine.filter((r) => r.scope === 'turn');
      const cumulative = mine.filter((r) => r.scope === 'cumulative');
      const turnState = (this.db.prepare('SELECT t.state AS state FROM turns t JOIN attempts a ON a.turn_id = t.id WHERE a.id = ?').get(attemptId) as { state: string } | undefined)?.state ?? null;

      // 口径选择（F15）：完整 turn 权威；否则 request（须集合完整）；否则只剩 cumulative（单列，不入总额）
      const authoritativeTurn = turnRows.find((r) => r.completeness === 'complete') ?? null;
      const requestsComplete = requests.length > 0 && requests.every((r) => r.completeness === 'complete') && turnState === 'completed';
      let chosen: Row[]; let scope: string; let completeness: string; let countsTowardTotals = true;
      if (authoritativeTurn) {
        chosen = [authoritativeTurn]; scope = 'turn'; completeness = 'complete';
      } else if (requestsComplete) {
        chosen = requests; scope = 'request'; completeness = 'complete';
      } else if (requests.length > 0 || turnRows.length > 0) {
        // 有观测但不可靠（partial / 回合未完成 / 请求集合不完整）——展示最好的一份，总额标 unknown
        chosen = requests.length > 0 ? requests : [turnRows[turnRows.length - 1]!];
        scope = requests.length > 0 ? 'request' : 'turn';
        completeness = 'partial';
      } else if (cumulative.length > 0) {
        // F15：仅累计快照——不是本轮消耗，单列展示；总额 null + unknown，绝不当作本轮 0
        chosen = [cumulative[cumulative.length - 1]!]; scope = 'cumulative'; completeness = cumulative[cumulative.length - 1]!.completeness; countsTowardTotals = false;
      } else {
        // 该 turn 声明了 attempt 但完全没有 usage 观测（如 failed 早退）→ 如实列 null 行
        attempts.push({ attempt_id: attemptId, scope: 'none', model: null, input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, completeness: 'missing' });
        inUnknown = true; outUnknown = true;
        continue;
      }
      attempts.push({
        attempt_id: attemptId, scope, model: chosen[0]?.model ?? null,
        input_tokens: sumOf(chosen, 'input_tokens'),
        output_tokens: sumOf(chosen, 'output_tokens'),
        cache_read_input_tokens: sumOf(chosen, 'cache_read_input_tokens'),
        cache_creation_input_tokens: sumOf(chosen, 'cache_creation_input_tokens'),
        completeness,
      });
      if (countsTowardTotals) {
        const a = attempts[attempts.length - 1]!;
        if (a.input_tokens == null) inUnknown = true; else inSum += a.input_tokens;
        if (a.output_tokens == null) outUnknown = true; else outSum += a.output_tokens;
        if (completeness !== 'complete') { inUnknown = true; outUnknown = true; } // partial/missing 不冒充完整总额
      }
    }
    const empty = attempts.length === 0;
    // F15：没有任何可计入本轮消耗的观测（只剩 cumulative 快照/missing 行）→ 总额 unknown，不冒充 0
    const noCountable = attempts.every((a) => a.scope === 'cumulative' || a.scope === 'none');
    return {
      attempts,
      totals: {
        input_tokens: empty || noCountable || inUnknown ? null : inSum,
        output_tokens: empty || noCountable || outUnknown ? null : outSum,
        unknown_present: inUnknown || outUnknown || noCountable,
      },
    };
  }
}
