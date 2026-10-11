// ESTOMAGO_CHAT_EXEC_V1 §05（WP1）：独立持久系统异常红点——一套表 + 现有 SSE，不单开监控服务。
// 事务顺序（§3）：①更新 system_alerts 聚合行 → ②同事务 persistInTx 系统通知事件 →
// ③把返回 sequence 写回 last_event_sequence → ④提交后 dispatchRow（沿现有 SSE 重放）。
// 不能先发 SSE 再写 DB；不能因浏览器离线丢告警。
// 已读≠恢复：system_alert_reads 只记读者已见版本；resolve 是内部服务接口（需恢复证据），
// 不向浏览器开放任意 code 创建或自填"已修复"。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import type { EventService } from '../events/service.ts';
import { POLICY_CONSTANTS } from '../config/policy-constants.ts';

export type AlertSeverity = 'info' | 'warning' | 'critical';

// §2.1 受控 code 注册表：级别为规范默认；新增 code 必须登记+测试，不得任意字符串变红点。
// alias 列：来源侧旧/细分名 → 规范正名（§2.1 末段映射规则）。
export const ALERT_CODES: Readonly<Record<string, { severity: AlertSeverity; aliasOf?: string }>> = {
  CACHE_PARAMETER_REJECTED: { severity: 'warning' },
  CACHE_TTL_UNVERIFIED: { severity: 'warning' },
  CACHE_TTL_MISMATCH: { severity: 'critical' },
  CACHE_PREFIX_CHANGED: { severity: 'critical' },
  CACHE_UNEXPECTED_MISS: { severity: 'warning' },
  CACHE_KEEPWARM_FAILED: { severity: 'warning' },
  CONTEXT_COMPACTION_UNEXPECTED: { severity: 'critical' },
  UNEXPECTED_DISPATCH: { severity: 'critical' },
  DISPATCH_AFTER_DISABLED: { severity: 'critical' },
  RETRY_BUDGET_EXCEEDED: { severity: 'critical' },
  BACKGROUND_BUDGET_REACHED: { severity: 'warning', aliasOf: 'BACKGROUND_BUDGET_REACHED' },
  COST_EXCEEDS_RESERVATION: { severity: 'critical' },
  USAGE_MISSING: { severity: 'warning' },
  USAGE_INCONSISTENT: { severity: 'warning' },
  TOOL_OUTCOME_UNKNOWN: { severity: 'warning' },
  BACKGROUND_DUPLICATE: { severity: 'critical' },
  BACKGROUND_OVERRUN: { severity: 'warning' },
  RAW_ARCHIVE_FAILED: { severity: 'warning' },
  ASSET_ARCHIVE_CONTRACT_UNVERIFIED: { severity: 'warning' },
  MEDIA_OR_TOOL_FAILED: { severity: 'warning' },
  CLOCK_OR_RECOVERY_UNCERTAIN: { severity: 'warning' },
  // —— 规范明示的来源名映射（§2.1 末段）——
  AUTONOMOUS_DISABLED: { severity: 'info', aliasOf: 'AUTONOMOUS_DISABLED' }, // 正常终止：不冒 warning/critical
  BACKGROUND_BUDGET_EXHAUSTED: { severity: 'warning', aliasOf: 'BACKGROUND_BUDGET_REACHED' },
  BACKGROUND_OUTCOME_UNKNOWN: { severity: 'warning', aliasOf: 'TOOL_OUTCOME_UNKNOWN' },
  BACKGROUND_CLOCK_REGRESSION: { severity: 'warning', aliasOf: 'CLOCK_OR_RECOVERY_UNCERTAIN' },
};

export type ObserveInput = {
  code: string;
  severity?: AlertSeverity; // 覆盖注册表默认需给理由（仅允许升级为更严重，不允许降级隐藏）
  scopeKind: 'system' | 'conversation' | 'integration' | 'background_run';
  scopeId?: string;
  dedupeKey: string; // code+作用域+具体操作/窗口标识；不含正文/URL/query/key（§4）
  observationId: string | null; // 稳定输入 id（如 request_id+attempt+terminal_state）；null=不去重（每次都是新事实）
  safeSummary?: Record<string, string | number | boolean | null>; // 白名单短文案参数；禁止正文/凭据/URL 参数
  related?: { requestId?: string | null; runId?: string | null; turnId?: string | null };
};

export type AlertSnapshotItem = {
  alert_id: string;
  code: string;
  severity: AlertSeverity;
  lifecycle: 'open' | 'resolved';
  scope_kind: string;
  scope_id: string;
  revision: number;
  occurrence_count: number;
  first_occurred_at: string;
  last_occurred_at: string;
  resolved_at: string | null;
  last_event_sequence: number;
  unread: boolean;
  safe_summary: Record<string, unknown>;
};

type AlertRow = {
  id: string; scope_kind: string; scope_id: string; code: string; severity: AlertSeverity;
  dedupe_key: string; lifecycle: 'open' | 'resolved'; revision: number;
  first_occurred_at: string; last_occurred_at: string; resolved_at: string | null;
  occurrence_count: number; last_event_sequence: number; safe_summary_json: string;
  related_request_id: string | null; related_run_id: string | null; related_turn_id: string | null;
};

// safe_summary 白名单键（§4：结构化短文案参数； ALERT-06 隐私门）
const SAFE_SUMMARY_KEYS = new Set(['title', 'detail', 'channel', 'purpose', 'model', 'count', 'known_cost_usd', 'unknown_count', 'action_taken', 'retryable', 'window_id', 'operation_kind', 'reason', 'switch_revision', 'run_id', 'request_id']);

function sanitizeSummary(s: Record<string, unknown> | undefined): string {
  if (!s) return '{}';
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!SAFE_SUMMARY_KEYS.has(k)) continue;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return JSON.stringify(out);
}

export class SystemAlertService {
  private db: Db;
  private events: EventService;
  readonly uiActorId = 'qiaosheng'; // 浏览器登录=她；模型工具不得代她标已读（§4）

  constructor(db: Db, events: EventService) {
    this.db = db;
    this.events = events;
  }

  /** 生产点统一入口（§3）。幂等：同一 observationId 的重复投递（乱序重放/双源）不重复计数。 */
  observe(input: ObserveInput): { alertId: string; counted: boolean; duplicateObservation: boolean } {
    const reg = ALERT_CODES[input.code];
    if (!reg) throw new Error(`UNKNOWN_ALERT_CODE:${input.code}`); // 未注册 code 拒绝——不得任意字符串变红点
    // §2.1 末段映射：来源细分名 → 规范正名（BACKGROUND_BUDGET_EXHAUSTED→BACKGROUND_BUDGET_REACHED 等）
    const code = reg.aliasOf ?? input.code;
    let severity = input.severity ?? reg.severity;
    if (input.severity && severityRank(input.severity) < severityRank(reg.severity)) severity = reg.severity; // 只许升级不许降级

    const nowIso = new Date().toISOString();
    // 消费账本先行：observation_id 已消费 → 幂等 no-op（ALERT-04：不依赖只比较 last_dedupe_observation_id）
    if (input.observationId !== null) {
      const dupObs = this.db.prepare('SELECT alert_id FROM system_alert_observations WHERE observation_id = ?').get(input.observationId) as { alert_id: string } | undefined;
      if (dupObs) return { alertId: dupObs.alert_id, counted: false, duplicateObservation: true };
    }

    const result = tx(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM system_alerts WHERE dedupe_key = ?').get(input.dedupeKey) as AlertRow | undefined;
      let alertId: string;
      let occurrenceCount: number;
      let revision: number;
      if (!existing) {
        alertId = genId('alert');
        occurrenceCount = 1;
        revision = 1;
        this.db.prepare(
          `INSERT INTO system_alerts(id, scope_kind, scope_id, code, severity, dedupe_key, lifecycle, revision,
             first_occurred_at, last_occurred_at, occurrence_count, safe_summary_json,
             related_request_id, related_run_id, related_turn_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?, 'open', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        ).run(alertId, input.scopeKind, input.scopeId ?? '', code, severity, input.dedupeKey, revision, nowIso, nowIso, sanitizeSummary(input.safeSummary), input.related?.requestId ?? null, input.related?.runId ?? null, input.related?.turnId ?? null, nowIso, nowIso);
      } else {
        alertId = existing.id;
        // 复发：reopen（不新开告警、不删历史）；occurrence/revision/sequence 增加
        occurrenceCount = existing.occurrence_count + 1;
        revision = existing.revision + 1;
        this.db.prepare(
          `UPDATE system_alerts SET severity = ?, lifecycle = 'open', resolved_at = NULL, revision = ?,
             last_occurred_at = ?, occurrence_count = ?, safe_summary_json = ?,
             related_request_id = COALESCE(?, related_request_id), related_run_id = COALESCE(?, related_run_id),
             related_turn_id = COALESCE(?, related_turn_id), updated_at = ?
           WHERE id = ?`,
        ).run(severity, revision, nowIso, occurrenceCount, sanitizeSummary(input.safeSummary) === '{}' && existing.safe_summary_json !== '{}' ? existing.safe_summary_json : sanitizeSummary(input.safeSummary), input.related?.requestId ?? null, input.related?.runId ?? null, input.related?.turnId ?? null, nowIso, alertId);
      }
      // ②同事务 persist 系统通知事件（payload 仅元数据，无正文——§3/ALERT-06）
      const row = this.events.persistInTx('system.alert.changed', {
        conversationId: null,
        entityRef: alertId,
        entityRevision: revision,
        payload: {
          alert_id: alertId, code, severity, lifecycle: 'open', revision,
          occurrence_count: occurrenceCount, // 真实异常次数，不是 SSE 回放次数
        },
      });
      // ③sequence 写回聚合行
      this.db.prepare('UPDATE system_alerts SET last_event_sequence = ? WHERE id = ?').run(row.sequence, alertId);
      if (input.observationId !== null) {
        this.db.prepare('INSERT INTO system_alert_observations(observation_id, alert_id, observed_at) VALUES (?,?,?)').run(input.observationId, alertId, nowIso);
      }
      return { row, alertId };
    });
    // ④提交后分发（沿现有 SSE）
    this.events.dispatchRow(result.row);
    return { alertId: result.alertId, counted: true, duplicateObservation: false };
  }

  /** 恢复=真实故障条件解除（内部接口）。必须给 resolution 证据描述；无证据不 resolve（§4：不能计时器自动 resolve）。 */
  resolve(dedupeKey: string, evidence: { summary?: Record<string, string | number | boolean | null> }): { resolved: boolean } {
    const nowIso = new Date().toISOString();
    const out = tx(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM system_alerts WHERE dedupe_key = ?').get(dedupeKey) as AlertRow | undefined;
      if (!existing || existing.lifecycle === 'resolved') return { resolved: false, row: null as null | ReturnType<EventService['persistInTx']> };
      const revision = existing.revision + 1;
      this.db.prepare(
        `UPDATE system_alerts SET lifecycle = 'resolved', resolved_at = ?, revision = ?, updated_at = ?,
           safe_summary_json = ? WHERE id = ?`,
      ).run(nowIso, revision, nowIso, sanitizeSummary(evidence.summary) === '{}' ? existing.safe_summary_json : sanitizeSummary(evidence.summary), existing.id);
      const row = this.events.persistInTx('system.alert.changed', {
        conversationId: null, entityRef: existing.id, entityRevision: revision,
        payload: { alert_id: existing.id, code: existing.code, severity: existing.severity, lifecycle: 'resolved', revision, occurrence_count: existing.occurrence_count },
      });
      this.db.prepare('UPDATE system_alerts SET last_event_sequence = ? WHERE id = ?').run(row.sequence, existing.id);
      return { resolved: true, row };
    });
    if (out.row) this.events.dispatchRow(out.row);
    return { resolved: out.resolved };
  }

  /** 已读：只接受不超过该 alert 已存在版本的 sequence；max(old,incoming) 单调不减；幂等；不 resolve 故障。 */
  markRead(actorId: string, items: Array<{ alert_id: string; seen_event_sequence: number }>): { accepted: number } {
    if (items.length > POLICY_CONSTANTS.system_alerts.read_batch_max) throw new Error('READ_BATCH_TOO_LARGE');
    const nowIso = new Date().toISOString();
    let accepted = 0;
    tx(this.db, () => {
      for (const it of items) {
        const alert = this.db.prepare('SELECT id, last_event_sequence FROM system_alerts WHERE id = ?').get(it.alert_id) as { id: string; last_event_sequence: number } | undefined;
        if (!alert) continue; // 未知 id 忽略（快照外/已清理）
        const seen = Math.min(Math.max(0, Math.floor(it.seen_event_sequence)), alert.last_event_sequence); // 不超过已存在版本
        const prev = this.db.prepare('SELECT seen_event_sequence FROM system_alert_reads WHERE actor_id = ? AND alert_id = ?').get(actorId, alert.id) as { seen_event_sequence: number } | undefined;
        if (prev && prev.seen_event_sequence >= seen) continue; // 单调不减：不倒退
        this.db.prepare(
          `INSERT INTO system_alert_reads(actor_id, alert_id, seen_event_sequence, seen_at) VALUES (?,?,?,?)
           ON CONFLICT(actor_id, alert_id) DO UPDATE SET seen_event_sequence = excluded.seen_event_sequence, seen_at = excluded.seen_at`,
        ).run(actorId, alert.id, seen, nowIso);
        accepted++;
      }
    });
    if (accepted > 0) {
      // 已读事件不逐条 SSE（快照+summary 刷新足够；避免 read 风暴）——前端以 summary 重查
    }
    return { accepted };
  }

  /** 分页快照：last_event_sequence DESC, id DESC 的 opaque keyset cursor（绑定过滤与权限作用域）。 */
  list(opts: { actorId: string; lifecycle?: 'all' | 'open' | 'resolved'; unreadOnly?: boolean; limit?: number; cursor?: string | null }): {
    items: AlertSnapshotItem[];
    next_cursor: string | null;
    has_more: boolean;
    unread_anomaly_count: number;
    open_count: number;
    snapshot_sequence: number;
  } {
    // policy-defaults：超限返回参数错误，不能偷偷截断成"完整结果"
    const limit = opts.limit ?? POLICY_CONSTANTS.pagination.default_limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > POLICY_CONSTANTS.pagination.max_limit) {
      throw new Error(`INVALID_LIMIT:${limit}`);
    }
    const lifecycle = opts.lifecycle ?? 'all';
    let afterSeq: number | null = null;
    let afterId: string | null = null;
    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      if (!decoded) throw new Error('INVALID_CURSOR');
      afterSeq = decoded.seq; afterId = decoded.id;
    }
    const reads = new Map((this.db.prepare('SELECT alert_id, seen_event_sequence FROM system_alert_reads WHERE actor_id = ?').all(opts.actorId) as Array<{ alert_id: string; seen_event_sequence: number }>).map((r) => [r.alert_id, r.seen_event_sequence]));
    const allRows = this.db.prepare('SELECT * FROM system_alerts ORDER BY last_event_sequence DESC, id DESC').all() as AlertRow[];
    const isUnread = (r: AlertRow): boolean => {
      const seen = reads.get(r.id);
      return seen === undefined || seen < r.last_event_sequence;
    };
    let filtered = allRows.filter((r) => (lifecycle === 'all' ? true : r.lifecycle === lifecycle));
    if (opts.unreadOnly) filtered = filtered.filter((r) => isUnread(r) && r.lifecycle === 'open');
    let page = filtered;
    if (afterSeq !== null && afterId !== null) {
      page = page.filter((r) => r.last_event_sequence < afterSeq! || (r.last_event_sequence === afterSeq! && r.id < afterId!));
    }
    const items = page.slice(0, limit).map(rowToItem(reads));
    const hasMore = page.length > limit;
    const nextCursor = hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]!.last_event_sequence, items[items.length - 1]!.alert_id) : null;
    return {
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
      unread_anomaly_count: allRows.filter((r) => r.lifecycle === 'open' && (r.severity === 'warning' || r.severity === 'critical') && isUnread(r)).length,
      open_count: allRows.filter((r) => r.lifecycle === 'open').length,
      snapshot_sequence: this.events.maxSequence(),
    };
  }

  /** 轻量状态（§5）：启动/重连一次 + SSE 后有界刷新；不每秒轮询。 */
  summary(actorId: string): { unread_anomaly_count: number; open_count: number; highest_open_severity: AlertSeverity | null; snapshot_sequence: number } {
    const reads = new Map((this.db.prepare('SELECT alert_id, seen_event_sequence FROM system_alert_reads WHERE actor_id = ?').all(actorId) as Array<{ alert_id: string; seen_event_sequence: number }>).map((r) => [r.alert_id, r.seen_event_sequence]));
    const rows = this.db.prepare("SELECT id, severity, last_event_sequence FROM system_alerts WHERE lifecycle = 'open'").all() as Array<{ id: string; severity: AlertSeverity; last_event_sequence: number }>;
    let highest: AlertSeverity | null = null;
    let unread = 0;
    for (const r of rows) {
      const seen = reads.get(r.id);
      const isUnread = seen === undefined || seen < r.last_event_sequence;
      if ((r.severity === 'warning' || r.severity === 'critical') && isUnread) {
        unread++;
        if (highest === null || severityRank(r.severity) > severityRank(highest)) highest = r.severity;
      }
    }
    return { unread_anomaly_count: unread, open_count: rows.length, highest_open_severity: highest, snapshot_sequence: this.events.maxSequence() };
  }
}

function severityRank(s: AlertSeverity): number {
  return s === 'critical' ? 2 : s === 'warning' ? 1 : 0;
}

function rowToItem(reads: Map<string, number>): (r: AlertRow) => AlertSnapshotItem {
  return (r) => ({
    alert_id: r.id, code: r.code, severity: r.severity, lifecycle: r.lifecycle,
    scope_kind: r.scope_kind, scope_id: r.scope_id, revision: r.revision,
    occurrence_count: r.occurrence_count,
    first_occurred_at: r.first_occurred_at, last_occurred_at: r.last_occurred_at, resolved_at: r.resolved_at,
    last_event_sequence: r.last_event_sequence,
    unread: (() => { const seen = reads.get(r.id); return seen === undefined || seen < r.last_event_sequence; })(),
    safe_summary: JSON.parse(r.safe_summary_json) as Record<string, unknown>,
  });
}

// opaque cursor：内容版本化（v1: seq|id base64url）——绑定过滤与权限作用域由服务端每次重算
function encodeCursor(seq: number, id: string): string {
  return Buffer.from(`v1:${seq}:${id}`, 'utf8').toString('base64url');
}
function decodeCursor(c: string): { seq: number; id: string } | null {
  try {
    const [v, seq, id] = Buffer.from(c, 'base64url').toString('utf8').split(':');
    if (v !== 'v1' || !seq || !id) return null;
    const n = Number(seq);
    if (!Number.isSafeInteger(n)) return null;
    return { seq: n, id };
  } catch {
    return null;
  }
}

// —— §2.2 缓存未命中不能见 0 就报错：CACHE_UNEXPECTED_MISS 的五条件门（WP2 接传输侧真实证据）——
export type CacheMissGateInput = {
  cache_read_tokens: number | null; // 完整 usage 的 read 分类；null=供应商没提供（≠0）
  same_model_and_upstream: boolean; // 相同模型/生效上游约束
  same_cacheable_prefix_version: boolean; // 相同可缓存前缀版本（未授权 tools/system/history 改写会被断言拦）
  has_prior_reliable_read_write: boolean; // 上次可靠缓存读写证据存在
  within_expected_ttl: boolean; // 仍在预计 TTL 内
  known_cold_start: boolean; // 首次/新窗/换模型/获准工具集变化后的首请求/受控换窗/媒体重新物化等已知前缀变化
  prefix_at_least_min_cacheable: boolean; // 提示达到该模型最小可缓存长度
};

/** 只有全部温态条件齐备且完整 usage 明确 read=0 才触发；任何不确定=不触发（展示信息即可）。 */
export function evaluateCacheMiss(input: CacheMissGateInput): { trigger: boolean; reason: string } {
  if (input.cache_read_tokens === null) return { trigger: false, reason: 'cache_fields_missing_unknown' }; // null 不是 0，更不是命中
  if (input.cache_read_tokens > 0) return { trigger: false, reason: 'partial_or_full_hit' }; // read>0 不证明全命中，但绝不是意外 miss
  if (input.known_cold_start) return { trigger: false, reason: 'known_cold_or_prefix_change' };
  if (!input.prefix_at_least_min_cacheable) return { trigger: false, reason: 'below_min_cacheable' };
  if (!input.same_model_and_upstream) return { trigger: false, reason: 'model_or_upstream_changed' };
  if (!input.same_cacheable_prefix_version) return { trigger: false, reason: 'prefix_version_changed' };
  if (!input.has_prior_reliable_read_write) return { trigger: false, reason: 'no_prior_cache_evidence' };
  if (!input.within_expected_ttl) return { trigger: false, reason: 'outside_expected_ttl' };
  return { trigger: true, reason: 'warm_cache_expected_read_zero' };
}
