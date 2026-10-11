// ESTOMAGO_CHAT_EXEC_V1 §05.6（WP1）：用量归属与字段级归一化的纯函数。
//  - providerInputTotal：OR/DS input_tokens 已含缓存分类（§9.3 旧口径）；SDK 原生 input
//    可能是未缓存部分——先按 provider 归一再合计，绝不把 OR cache 读写加第二遍。
//  - shanghaiDayOf：budget_day=派发开始（dispatch_started_at）的 Asia/Shanghai 日期；
//    observed_at 只是获得证据的时间，不挪账。
//  - findSettlementBreaches：结算宽限后仍无应有 usage 的已结束请求（USAGE_MISSING 输入）。
// 纯函数：无网络、无时钟注入依赖（now 由调用方传）。
import type { Db } from '../db/connection.ts';
import type { SystemAlertService } from '../observability/system-alerts.ts';

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** UTC ISO 时刻 → 上海公历日（YYYY-MM-DD）。非法输入返回 null，不猜。 */
export function shanghaiDayOf(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export type ProviderUsageRow = {
  source: string; // or_stream / ds_stream / sdk_result / sdk_stream / estimated
  input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
};

/**
 * 按 provider 解释"总输入 token"：
 *  - or_stream / ds_stream：input_tokens 即总输入（内含缓存分类）——分类只展示，不再相加；
 *  - sdk_*：原生 input 可能是未缓存部分 → 总输入 = input + cache_read + cache_write（缺项按未知 → null）；
 *  - estimated：粗估值本身即口径，直接返回。
 * 输入为 null → null（未知不是 0）。
 */
export function providerInputTotal(row: ProviderUsageRow): number | null {
  if (row.input_tokens === null) return null;
  if (row.source.startsWith('sdk')) {
    const read = row.cache_read_input_tokens;
    const write = row.cache_creation_input_tokens;
    if (read === null || write === null) return null; // 分类未知 → SDK 总输入不可靠，不猜
    return row.input_tokens + read + write;
  }
  return row.input_tokens; // or/ds/estimated：已是总量
}

/** 每字段独立完整度：known_subtotal + unknown_count；complete_total 仅在 unknown=0 时给（可 null）。 */
export type FieldTotal = { known_subtotal: number; unknown_count: number; complete_total: number | null };

export function fieldTotalOf(values: Array<number | null>): FieldTotal {
  let known = 0;
  let unknown = 0;
  for (const v of values) {
    if (v === null) unknown++;
    else known += v;
  }
  return { known_subtotal: known, unknown_count: unknown, complete_total: unknown === 0 ? known : null };
}

/**
 * 结算宽限违规（USAGE-06 输入）：已真实发送（sent_at 非空）且所属回合已终态
 *（completed/failed/interrupted）超过宽限仍无 complete usage 的请求。
 * 纯查询：调用方（WP4 调度器/测试）传 now；本批不启动后台循环。
 */
export function findSettlementBreaches(db: Db, graceMs: number, nowIso: string): Array<{ requestId: string; attemptId: string | null; turnId: string | null; sentAt: string; turnState: string | null }> {
  const rows = db.prepare(
    `SELECT pr.id AS request_id, pr.attempt_id, pr.turn_id, pr.sent_at,
            a.state AS attempt_state, t.state AS turn_state
     FROM provider_requests pr
     LEFT JOIN attempts a ON a.id = pr.attempt_id
     LEFT JOIN turns t ON t.id = a.turn_id
     WHERE pr.sent_at IS NOT NULL`,
  ).all() as Array<{ request_id: string; attempt_id: string | null; turn_id: string | null; sent_at: string; attempt_state: string | null; turn_state: string | null }>;
  const out: Array<{ requestId: string; attemptId: string | null; turnId: string | null; sentAt: string; turnState: string | null }> = [];
  const now = Date.parse(nowIso);
  for (const r of rows) {
    // 回合仍在跑（无终态）→ 不算"已可能执行结束"，不报
    const state = r.turn_state ?? r.attempt_state;
    if (state !== null && state !== 'completed' && state !== 'failed' && state !== 'interrupted') continue;
    const complete = db.prepare("SELECT 1 FROM usage_observations WHERE request_id = ? AND completeness = 'complete' LIMIT 1").get(r.request_id);
    if (complete) continue;
    const sent = Date.parse(r.sent_at);
    if (!Number.isFinite(sent) || now - sent < graceMs) continue;
    out.push({ requestId: r.request_id, attemptId: r.attempt_id, turnId: r.turn_id, sentAt: r.sent_at, turnState: state });
  }
  return out;
}

/**
 * USAGE-06：结算宽限违规 → USAGE_MISSING 告警（每个请求一次，observation_id 稳定幂等）。
 * 预算不因此释放（unknown 费用不能释放预占——04 的结算状态说了算，05 只消费结果）。
 * 幂等重放安全：同 request 再 sweep 不重复计数。返回本次新告警数。
 */
export function sweepUsageMissing(db: Db, alerts: SystemAlertService, graceMs: number, nowIso: string): number {
  let produced = 0;
  for (const b of findSettlementBreaches(db, graceMs, nowIso)) {
    const r = alerts.observe({
      code: 'USAGE_MISSING', scopeKind: 'system', dedupeKey: `usage-missing:${b.requestId}`,
      observationId: `usage-missing:${b.requestId}`,
      safeSummary: { detail: '已结束请求在结算宽限后仍无用量证据', count: 1, action_taken: 'unknown_cost_retained', reason: 'settlement_grace_expired' },
      related: { requestId: b.requestId, turnId: b.turnId },
    });
    if (r.counted) produced++;
  }
  return produced;
}
