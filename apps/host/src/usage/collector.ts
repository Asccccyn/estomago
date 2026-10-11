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
import type { SystemAlertService } from '../observability/system-alerts.ts';
import { shanghaiDayOf, providerInputTotal, fieldTotalOf, type FieldTotal } from './attribution.ts';

export class UsageCollector {
  private db: Db;
  private alerts: SystemAlertService | null; // EXEC_V1 §05.6：矛盾终值 → USAGE_INCONSISTENT（可选：测试/最小装配不挂）
  constructor(db: Db, alerts: SystemAlertService | null = null) {
    this.db = db;
    this.alerts = alerts;
  }

  record(o: {
    turnId: string; attemptId: string; scope: 'request' | 'turn' | 'cumulative';
    usage: RawUsage; model?: string | null; requestId?: string | null; windowId?: string | null;
    source: 'sdk_result' | 'sdk_stream' | 'or_stream' | 'ds_stream' | 'estimated';
    completeness?: 'complete' | 'partial' | 'unknown';
  }): void {
    // 幂等键：(attempt, scope, request_id, model)——F15：source 不进键（同请求跨来源=同一消耗）。
    // 口径区分：source 只标来源证据；OR 行 input_tokens 携带"总输入（含缓存分类）"语义（§9.3），
    // 与 SDK 事件的非缓存口径分列展示，绝不求和混算。
    const dup = this.db
      .prepare('SELECT id, completeness, input_tokens, output_tokens, cost_usd FROM usage_observations WHERE attempt_id = ? AND scope = ? AND request_id IS ? AND model IS ?')
      .get(o.attemptId, o.scope, o.requestId ?? null, o.model ?? null) as { id: string; completeness: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null } | undefined;
    // EXEC_V1 §05.6（USAGE-01）：同一请求的矛盾终值（两份 complete 但关键字段不一致）——
    // 隔离新观测（不覆盖可信终值），出 USAGE_INCONSISTENT 可核异常；observation_id 稳定幂等。
    const newComplete = (o.completeness ?? 'complete') === 'complete';
    if (dup && dup.completeness === 'complete' && newComplete) {
      const conflict =
        (o.usage.input_tokens != null && dup.input_tokens != null && o.usage.input_tokens !== dup.input_tokens) ||
        (o.usage.output_tokens != null && dup.output_tokens != null && o.usage.output_tokens !== dup.output_tokens) ||
        (o.usage.cost_usd != null && dup.cost_usd != null && o.usage.cost_usd !== dup.cost_usd);
      if (conflict) {
        this.alerts?.observe({
          code: 'USAGE_INCONSISTENT', scopeKind: 'system', dedupeKey: `usage-inconsistent:${dup.id}`,
          observationId: `usage-inconsistent:${dup.id}:${o.usage.input_tokens ?? 'x'}:${o.usage.output_tokens ?? 'x'}:${o.usage.cost_usd ?? 'x'}`,
          safeSummary: { detail: '同一请求出现冲突终值，已隔离新观测', count: 1, known_cost_usd: dup.cost_usd, unknown_count: 1 },
          related: { requestId: o.requestId ?? null, turnId: o.turnId ?? null },
        });
        return; // §2.1：隔离该观测，不用它覆盖可信终值
      }
    }
    // EXEC_V1 §05.6：归属列——优先从 provider_requests 行取 purpose 与真实 sent_at（派发开始）；
    // 无请求行（评审/旧路径）→ purpose 缺省 unknown、日期落证据时间并标 legacy（不虚构派发时刻）
    const reqRow = o.requestId
      ? (this.db.prepare('SELECT purpose, sent_at FROM provider_requests WHERE id = ?').get(o.requestId) as { purpose: string | null; sent_at: string | null } | undefined)
      : undefined;
    const observedAt = new Date().toISOString();
    const dispatchStartedAt = reqRow?.sent_at ?? null;
    const budgetDay = shanghaiDayOf(dispatchStartedAt) ?? shanghaiDayOf(observedAt);
    const legacy = dispatchStartedAt === null ? 1 : 0;
    if (dup) {
      // 最终/完整值覆盖临时值；partial 不覆盖已有 complete
      const oldIsComplete = dup.completeness === 'complete';
      if (oldIsComplete && !newComplete) return;
      this.db
        .prepare('UPDATE usage_observations SET input_tokens = ?, output_tokens = ?, cache_read_input_tokens = ?, cache_creation_input_tokens = ?, cost_usd = ?, reasoning_tokens = ?, anomalies_json = ?, raw_usage_json = ?, window_id = COALESCE(?, window_id), completeness = ?, observed_at = ?, purpose = COALESCE(?, purpose), budget_day = COALESCE(budget_day, ?), dispatch_started_at = COALESCE(dispatch_started_at, ?) WHERE id = ?')
        .run(o.usage.input_tokens ?? null, o.usage.output_tokens ?? null, o.usage.cache_read_input_tokens ?? null, o.usage.cache_creation_input_tokens ?? null,
          o.usage.cost_usd ?? null, o.usage.reasoning_tokens ?? null, o.usage.anomalies ? JSON.stringify(o.usage.anomalies) : null, o.usage.raw_json ?? null, o.windowId ?? null,
          o.completeness ?? 'complete', observedAt, reqRow?.purpose ?? null, budgetDay, dispatchStartedAt, dup.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO usage_observations(id, request_id, attempt_id, turn_id, scope, model,
           input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
           cost_usd, reasoning_tokens, anomalies_json, raw_usage_json, window_id, source, completeness, observed_at,
           purpose, background_run_id, budget_day, dispatch_started_at, legacy_observed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        genId('use'), o.requestId ?? null, o.attemptId, o.turnId, o.scope, o.model ?? null,
        o.usage.input_tokens ?? null, o.usage.output_tokens ?? null,
        o.usage.cache_read_input_tokens ?? null, o.usage.cache_creation_input_tokens ?? null,
        o.usage.cost_usd ?? null, o.usage.reasoning_tokens ?? null,
        o.usage.anomalies ? JSON.stringify(o.usage.anomalies) : null, o.usage.raw_json ?? null, o.windowId ?? null,
        o.source, o.completeness ?? 'complete', observedAt,
        reqRow?.purpose ?? null, null, budgetDay, dispatchStartedAt, legacy,
      );
  }

  // 账本视图：每个 attempt 一行（所选口径）+ 汇总（已知值求和；任一未知则该项标 unknown）
  summaryForTurn(turnId: string): {
    attempts: Array<{ attempt_id: string; scope: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; cost_usd: number | null; completeness: string }>;
    totals: { input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; unknown_present: boolean; fields: { input_tokens: FieldTotal; output_tokens: FieldTotal; cost_usd: FieldTotal } };
  } {
    const rows = this.db
      .prepare('SELECT * FROM usage_observations WHERE turn_id = ? ORDER BY observed_at')
      .all(turnId) as Array<{
      id: string; attempt_id: string; scope: string; model: string | null; source: string;
      input_tokens: number | null; output_tokens: number | null;
      cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; cost_usd: number | null; completeness: string;
    }>;
    type Row = (typeof rows)[number];
    const sumOf = (rs: Row[], f: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'cost_usd'): number | null =>
      rs.length === 0 ? null : rs.some((r) => r[f] == null) ? null : rs.reduce((s, r) => s + (r[f] ?? 0), 0);

    const attempts: Array<{ attempt_id: string; scope: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; cost_usd: number | null; completeness: string }> = [];
    // EXEC_V1 §05.6（USAGE-02/03）：字段级聚合输入——按 provider 归一化输入；token 完整度与费用完整度独立
    const fieldRows: Array<{ source: string; input_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; output_tokens: number | null; cost_usd: number | null }> = [];
    let inSum = 0, outSum = 0, costSum = 0, inUnknown = false, outUnknown = false, costUnknown = false;
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
      // 审计 F28：观测完整度必须对照"实际发送的请求集合"（provider_requests.sent_at 非空）——
      // 发了 2 个请求只收到 1 份 usage 时，整轮不得标完整已知
      const expectedRequests = (this.db.prepare('SELECT COUNT(*) n FROM provider_requests WHERE attempt_id = ? AND sent_at IS NOT NULL').get(attemptId) as { n: number }).n;
      const observedComplete = requests.filter((r) => r.completeness === 'complete').length;
      const requestsComplete = requests.length > 0 && requests.every((r) => r.completeness === 'complete') && turnState === 'completed' && observedComplete >= expectedRequests;
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
        // D25（审计 3655d60）：missing attempt 的费用同样未知——不能只把 token 染成 unknown
        // 而留下一个看似完整的 cost_usd 总额（已知小计冒充完整总额）
        attempts.push({ attempt_id: attemptId, scope: 'none', model: null, input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, cost_usd: null, completeness: 'missing' });
        inUnknown = true; outUnknown = true; costUnknown = true;
        continue;
      }
      attempts.push({
        attempt_id: attemptId, scope, model: chosen[0]?.model ?? null,
        input_tokens: sumOf(chosen, 'input_tokens'),
        output_tokens: sumOf(chosen, 'output_tokens'),
        cache_read_input_tokens: sumOf(chosen, 'cache_read_input_tokens'),
        cache_creation_input_tokens: sumOf(chosen, 'cache_creation_input_tokens'),
        cost_usd: sumOf(chosen, 'cost_usd'),
        completeness,
      });
      if (countsTowardTotals) {
        const a = attempts[attempts.length - 1]!;
        if (a.input_tokens == null) inUnknown = true; else inSum += a.input_tokens;
        if (a.output_tokens == null) outUnknown = true; else outSum += a.output_tokens;
        // 审计 A066：已知小计+未知分量并列——cost 缺观测不写零也不吞掉已知钱
        if (a.cost_usd == null) costUnknown = true; else costSum += a.cost_usd;
        if (completeness !== 'complete') { inUnknown = true; outUnknown = true; costUnknown = true; } // partial/missing 不冒充完整总额
        // 注意：cost 缺失只影响 cost 小计（null），不把 token 口径染成 unknown——两信号独立（A066 语义）
        for (const r of chosen) fieldRows.push({ source: r.source, input_tokens: r.input_tokens, cache_read_input_tokens: r.cache_read_input_tokens, cache_creation_input_tokens: r.cache_creation_input_tokens, output_tokens: r.output_tokens, cost_usd: r.cost_usd });
      }
    }
    const empty = attempts.length === 0;
    // F15：没有任何可计入本轮消耗的观测（只剩 cumulative 快照/missing 行）→ 总额 unknown，不冒充 0
    const noCountable = attempts.every((a) => a.scope === 'cumulative' || a.scope === 'none');
    // EXEC_V1 §05.6：字段级独立完整度（USAGE-02：token 完整不被费用未知清空，反之亦然）；
    // input 按 provider 归一化（USAGE-03：OR 分类不加第二遍 / SDK 补缓存分类）
    const fields: { input_tokens: FieldTotal; output_tokens: FieldTotal; cost_usd: FieldTotal } = {
      input_tokens: fieldTotalOf(fieldRows.map((r) => providerInputTotal(r))),
      output_tokens: fieldTotalOf(fieldRows.map((r) => r.output_tokens)),
      cost_usd: fieldTotalOf(fieldRows.map((r) => r.cost_usd)),
    };
    return {
      attempts,
      totals: {
        input_tokens: empty || noCountable || inUnknown ? null : inSum,
        output_tokens: empty || noCountable || outUnknown ? null : outSum,
        cost_usd: empty || noCountable || costUnknown ? null : costSum, // 已知小计；任一未知→null+unknown_present（不显示为零）
        unknown_present: inUnknown || outUnknown || noCountable, // token 口径未知信号；cost 未知由 cost_usd=null 表达
        fields, // additive：字段级 known_subtotal / unknown_count / complete_total(null)——不破坏旧 consumer
      },
    };
  }

  /**
   * EXEC_V1 §05.6（USAGE-04/05）：按 budget_day（真实派发开始的上海日）汇总费用归属。
   * 从 usage 行本身出发（不依赖 turn JOIN）——后台无用户消息 turn 的费用不会从前台统计消失。
   * purpose 优先取行内（provider_requests 回填），无请求行时 unknown；legacy 行如实计数。
   */
  summaryByDay(day: string): {
    day: string;
    purposes: Array<{ purpose: string; row_count: number; known_cost_usd: number; unknown_cost_count: number; known_input_total: number | null; legacy_row_count: number }>;
    legacy_row_count: number;
  } {
    const rows = this.db
      .prepare('SELECT purpose, cost_usd, input_tokens, source, legacy_observed_at FROM usage_observations WHERE budget_day = ?')
      .all(day) as Array<{ purpose: string | null; cost_usd: number | null; input_tokens: number | null; source: string; legacy_observed_at: number }>;
    const byPurpose = new Map<string, { purpose: string; row_count: number; known_cost_usd: number; unknown_cost_count: number; inputs: Array<number | null>; legacy_row_count: number }>();
    for (const r of rows) {
      const key = r.purpose ?? 'unknown';
      const cur = byPurpose.get(key) ?? { purpose: key, row_count: 0, known_cost_usd: 0, unknown_cost_count: 0, inputs: [], legacy_row_count: 0 };
      cur.row_count++;
      if (r.cost_usd === null) cur.unknown_cost_count++; else cur.known_cost_usd += r.cost_usd;
      cur.inputs.push(providerInputTotal({ source: r.source, input_tokens: r.input_tokens, cache_read_input_tokens: null, cache_creation_input_tokens: null }));
      if (r.legacy_observed_at === 1) cur.legacy_row_count++;
      byPurpose.set(key, cur);
    }
    return {
      day,
      purposes: [...byPurpose.values()].map((p) => ({
        purpose: p.purpose, row_count: p.row_count,
        known_cost_usd: p.known_cost_usd, unknown_cost_count: p.unknown_cost_count,
        known_input_total: p.inputs.some((v) => v === null) ? null : p.inputs.reduce<number>((s, v) => s + (v as number), 0),
        legacy_row_count: p.legacy_row_count,
      })),
      legacy_row_count: rows.filter((r) => r.legacy_observed_at === 1).length,
    };
  }
}
