// 用量采集（01 §9）：三种口径分开（单条新增输入/本轮用量/当前上下文），互不冒充。
// 崩溃/未知 → completeness=unknown，缺数不填零；累计与请求不重复相加。
import type { Db } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import type { RawUsage } from '../../../../packages/contracts/src/sdk-events.ts';
import type { UsageSummaryDto } from '../../../../packages/contracts/src/api.ts';

export class UsageCollector {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  record(o: {
    turnId: string;
    attemptId: string;
    scope: 'request' | 'turn' | 'cumulative';
    usage: RawUsage;
    model?: string | null;
    requestId?: string | null;
    source: 'sdk_result' | 'sdk_stream' | 'estimated';
    completeness?: 'complete' | 'partial' | 'unknown';
  }): void {
    this.db
      .prepare(
        `INSERT INTO usage_observations(id, request_id, attempt_id, turn_id, scope, model,
           input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, source, completeness, observed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        genId('use'),
        o.requestId ?? null,
        o.attemptId,
        o.turnId,
        o.scope,
        o.model ?? null,
        o.usage.input_tokens ?? null,
        o.usage.output_tokens ?? null,
        o.usage.cache_read_input_tokens ?? null,
        o.usage.cache_creation_input_tokens ?? null,
        o.source,
        o.completeness ?? 'complete',
        new Date().toISOString(),
      );
  }

  summaryForTurn(turnId: string): UsageSummaryDto[] {
    const rows = this.db
      .prepare('SELECT * FROM usage_observations WHERE turn_id = ? ORDER BY observed_at')
      .all(turnId) as Array<{
      scope: string;
      model: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_input_tokens: number | null;
      cache_creation_input_tokens: number | null;
      completeness: string;
    }>;
    // 唯一统计键：window/attempt/request/model —— 这里按 (scope, attempt) 去重展示最新
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) latest.set(`${r.scope}:${r.model ?? 'unknown'}`, r);
    return [...latest.values()].map((r) => ({
      scope: r.scope as UsageSummaryDto['scope'],
      model: r.model,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_input_tokens: r.cache_read_input_tokens,
      cache_creation_input_tokens: r.cache_creation_input_tokens,
      completeness: r.completeness as UsageSummaryDto['completeness'],
    }));
  }
}
