// 前台"记录"快照（contracts/records-api.md + 规范 §11.2）：只读、元数据-only。
// 不含 prompt 正文/签名思考/密钥/工具认证参数；unknown 不显示为零或 100%。打开面板不触发任何生成。
import type { Db } from '../db/connection.ts';
import type { Config } from '../config/schema.ts';
import type { WindowManager } from '../windows/manager.ts';
import type { RunnerSelection } from '../runtime/runner.ts';

export type RecordSnapshot = {
  roomId: string;
  cursor: string | null;
  epochId: string | null;
  driver: 'openrouter' | 'deepseek' | 'claude-agent-sdk' | 'mock' | 'unknown';
  exactModel: string | null;
  context: { estimatedInput: number | null; lastActualInput: number | null; effectiveSoft: number | null; effectiveWarning: number | null; hardCapacity: number | null; estimateQuality: string };
  cache: { requestedTtl: '1h' | 'auto'; lastRead: number | null; lastWrite: number | null; lastNoncached: number | null; lastCostUsd: number | null; observedAt: string | null; estimatedExpiresAt: string | null; keeperEnabled: false };
  review: { id: string; status: string; decision: string | null; holdCount: number | null; rangeCount: number | null; windowId: string; isCurrentWindow: boolean } | null;
  bookmark: { seenSequence: number | null; memoryId: string | null; updatedAt: string | null } | null; // F22：成功书签位置
  rawSync: { state: 'saved_pending_sync' | 'synced' | 'partial' | 'failed' | 'unknown'; enabled: boolean; pending: number; failed: number; acked: number };
  // F-J-42：hold 绑定状态按事实分列（绑定明细本地未留痕，不冒充已核对/未接通）
  holdEffects: Array<{ state: string; verified: boolean; memoryId: string | null; updatedAt: string; bindingDetail: string | null }>;
  // F-J-34：用量按 purpose 分列（chat / pre_rotate_review / unknown）
  usageDay: string; // 上海自然日（R18：日累计口径，非滚动 24h）
  usageByPurpose: Array<{ purpose: string; count: number; knownCostUsd: number | null; unknownCount: number }>;
};

export function buildRecordSnapshot(d: {
  db: Db;
  config: Config;
  windows: WindowManager;
  runnerSelection: RunnerSelection;
  rawSyncState?: { pending: number; unknown_outcome: number; failed: number; acked: number; enabled: boolean } | null;
}, conversationId: string, lastEventSequence: number | null): RecordSnapshot {
  const win = d.windows.activeWindow(conversationId);
  const driver: RecordSnapshot['driver'] = d.runnerSelection.status === 'ok' ? (d.runnerSelection.runner.kind as RecordSnapshot['driver']) : 'unknown';
  const exactModel = driver === 'openrouter' ? d.config.openrouter.model : driver === 'deepseek' ? d.config.deepseek.model : d.config.runtime.model;
  // §11.1：本地粗估 + 实际 usage 校准；粗估系数按驱动（DS 默认 1.5——中文场景；OR 默认 2.5），精度分级如实
  const charsPerToken = driver === 'deepseek' ? d.config.deepseek.estimate_chars_per_token : driver === 'openrouter' ? d.config.openrouter.estimate_chars_per_token : 2.5;

  const trajRow = win
    ? (d.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id) as { messages_json: string } | undefined)
    : undefined;
  let estimated: number | null = null;
  let quality = 'unknown';
  if (trajRow) {
    const msgs = JSON.parse(trajRow.messages_json) as Array<{ content: unknown }>;
    const chars = msgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0);
    estimated = Math.ceil(chars / charsPerToken);
    quality = 'rough';
  }
  const lastUsage = win
    ? (d.db.prepare(
        `SELECT u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.observed_at
         FROM usage_observations u LEFT JOIN attempts a ON a.id = u.attempt_id
         WHERE (u.window_id = ? OR a.window_id = ?) AND u.source IN ('or_stream','ds_stream') AND u.completeness = 'complete' AND u.input_tokens IS NOT NULL
         ORDER BY u.observed_at DESC LIMIT 1`,
      ).get(win.id, win.id) as { input_tokens: number; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; observed_at: string } | undefined)
    : undefined;
  if (lastUsage) {
    estimated = Math.max(estimated ?? 0, lastUsage.input_tokens);
    quality = 'calibrated_rough';
  }
  const w = d.config.windows;
  const hardCapacity = w.model_context_capacity; // null=未测量，不画假百分比
  const maxOutput = driver === 'deepseek' ? d.config.deepseek.max_output_tokens : d.config.openrouter.max_output_tokens;
  const safeInput = hardCapacity !== null ? hardCapacity - maxOutput - w.tool_input_reserve_tokens - w.review_reserve_tokens - w.safety_reserve_tokens : null;
  const effectiveSoft = safeInput !== null ? Math.min(w.soft_limit_tokens, safeInput) : w.soft_limit_tokens;
  // D23（审计 3655d60）：前台预警线按与 rotationPlan 同式计算（不高于软线-8k；容量未测时退配置值并如实标注
  // hardCapacity=null）——旧 UI 固定显示 56000，小容量/自定义配置下是到不了的假线
  const effectiveWarning = Math.max(0, Math.min(w.warning_tokens, effectiveSoft - 8000));

  // F22：按房间取最近一次检查（成功换窗后完成结果留在旧窗——不因窗口切换显示"还没检查过"）
  const reviewRow = (d.db.prepare("SELECT id, status, decision, window_id, json_array_length(range_keys_json) AS range_count FROM rotation_reviews WHERE room_id = ? ORDER BY created_at DESC LIMIT 1").get(conversationId) as { id: string; status: string; decision: string | null; window_id: string; range_count: number | null } | undefined);
  const holdCount = reviewRow ? ((d.db.prepare("SELECT COUNT(*) n FROM tool_side_effects WHERE review_id = ? AND kind='hold' AND state='committed'").get(reviewRow.id) as { n: number }).n) : null;

  const raw = d.rawSyncState;
  const rawState: RecordSnapshot['rawSync']['state'] = !raw ? 'unknown'
    : raw.failed > 0 ? 'failed'
      : raw.unknown_outcome > 0 ? 'unknown'
        : raw.pending > 0 || !raw.enabled ? 'saved_pending_sync'
          : raw.acked > 0 ? 'synced' : 'saved_pending_sync';

  // F18：TTL 从请求开始计时（provider_requests.created_at），不是流结束后的 usage 入库时刻
  // 审计 F18：TTL 只锚定真实发送的请求（sent_at 非空）——容量门前/未发送的 planned 行不刷新热时限
  const requestStartedAt = win
    ? (d.db.prepare('SELECT sent_at FROM provider_requests WHERE window_id = ? AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1').get(win.id) as { sent_at: string } | undefined)?.sent_at ?? null
    : null;
  const observedAt = lastUsage?.observed_at ?? null;
  const costRow = win
    ? (d.db.prepare("SELECT cost_usd FROM usage_observations u LEFT JOIN attempts a ON a.id = u.attempt_id WHERE (u.window_id = ? OR a.window_id = ?) AND u.cost_usd IS NOT NULL ORDER BY u.observed_at DESC LIMIT 1").get(win.id, win.id) as { cost_usd: number } | undefined)
    : undefined; // F31：窗口直取（手动评审费用可见）
  // F-J-34（联合审计 2026-10-06）+R18（复审 2026-10-07）：用量按 purpose
  // 分列；日累计按**上海自然日**聚合（此前 SQL 参数是滚动 24 小时——
  // 上海中午会把昨日午后费用算进今天）。unknown 不补零、不以零冒充总成本。
  const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
  const shanghaiNow = new Date(Date.now() + SHANGHAI_OFFSET_MS);
  const usageDay = shanghaiNow.toISOString().slice(0, 10);
  const usageDayStartUtcIso = new Date(
    Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), shanghaiNow.getUTCDate()) - SHANGHAI_OFFSET_MS
  ).toISOString();
  const purposeCost = d.db.prepare(`
    SELECT COALESCE(pr.purpose, 'unknown') AS purpose,
           COUNT(*) AS n,
           SUM(CASE WHEN u.cost_usd IS NOT NULL THEN u.cost_usd ELSE 0 END) AS known_cost,
           SUM(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_n
    FROM usage_observations u
    LEFT JOIN provider_requests pr ON pr.id = u.request_id
    WHERE u.observed_at >= ?
    GROUP BY COALESCE(pr.purpose, 'unknown')
  `).all(usageDayStartUtcIso) as Array<{ purpose: string; n: number; known_cost: number | null; unknown_n: number }>;
  return {
    roomId: conversationId,
    cursor: lastEventSequence !== null ? String(lastEventSequence) : null,
    epochId: win?.id ?? null,
    driver,
    exactModel,
    context: { estimatedInput: estimated, lastActualInput: lastUsage?.input_tokens ?? null, effectiveSoft, effectiveWarning, hardCapacity, estimateQuality: quality },
    cache: {
      // DS 直连=自动上下文缓存（无显式 TTL 参数，命中看 lastRead 观测）；OR=显式 1h（§7）
      requestedTtl: driver === 'deepseek' ? 'auto' : '1h',
      lastRead: lastUsage?.cache_read_input_tokens ?? null,
      lastWrite: lastUsage?.cache_creation_input_tokens ?? null,
      lastNoncached: lastUsage && lastUsage.input_tokens !== null && lastUsage.cache_read_input_tokens !== null && lastUsage.cache_creation_input_tokens !== null
        ? lastUsage.input_tokens - lastUsage.cache_read_input_tokens - lastUsage.cache_creation_input_tokens
        : null,
      lastCostUsd: costRow?.cost_usd ?? null, // F19：已返回的实际费用（未返回时不编数）
      observedAt,
      // §7.3：OR 1h 从真实发送开始估计；DS 自动缓存无公开固定 TTL——不画估计线，只报观测
      estimatedExpiresAt: driver === 'deepseek' ? null : (requestStartedAt ? new Date(Date.parse(requestStartedAt) + 60 * 60 * 1000).toISOString() : null),
      keeperEnabled: false,
    },
    review: reviewRow ? { id: reviewRow.id, status: reviewRow.status, decision: reviewRow.decision, holdCount, rangeCount: reviewRow.range_count ?? null, windowId: reviewRow.window_id, isCurrentWindow: reviewRow.window_id === (win?.id ?? null) } : null,
    bookmark: (() => {
      const cp = win ? (d.db.prepare('SELECT seen_sequence, memory_id, updated_at FROM hold_checkpoints WHERE room_id = ? ORDER BY updated_at DESC LIMIT 1').get(conversationId) as { seen_sequence: number; memory_id: string; updated_at: string } | undefined) : undefined;
      return cp ? { seenSequence: cp.seen_sequence, memoryId: cp.memory_id, updatedAt: cp.updated_at } : null;
    })(),
    rawSync: { state: rawState, enabled: raw?.enabled ?? false, pending: raw?.pending ?? 0, failed: raw?.failed ?? 0, acked: raw?.acked ?? 0 },
    // F-J-42（联合审计 2026-10-06）：hold 绑定状态按**事实**分列——账本里已核实的
    // committed hold 是"创建成功"；绑定明细（binding_ids）estómago 侧未持久化，
    // 如实标注本地未留痕（需到 Mariposa 侧按 operation_id 核对），不沿用旧
    // "绑定未接通"占位（联调已证 msb_ 绑定真实存在）；rawSync 是原文归档同步，
    // 不是桶的绑定状态，两者不混。
    usageDay,
    usageByPurpose: purposeCost.map((r) => ({
      purpose: r.purpose, count: r.n,
      knownCostUsd: r.known_cost ?? null,
      unknownCount: r.unknown_n,
    })),
    holdEffects: (() => {
      const rows = d.db.prepare(
        "SELECT state, verified, memory_id, updated_at FROM tool_side_effects WHERE kind = 'hold' ORDER BY updated_at DESC LIMIT 5",
      ).all() as Array<{ state: string; verified: number; memory_id: string | null; updated_at: string }>;
      return rows.map((r) => ({
        state: r.state, verified: r.verified === 1, memoryId: r.memory_id, updatedAt: r.updated_at,
        bindingDetail: r.state === 'committed' ? 'not_recorded_locally' : null,
      }));
    })(),
  };
}

// 记录事件白名单（§11.2 契约 kind 集合中实际存在的；元数据 payload，不含正文类事件）
const RECORD_EVENT_KINDS = new Set(['archive.sync', 'context.warning', 'review.sent', 'review.failed', 'window.rotated']);

export type RecordEventItem = { eventId: string; sequence: number; roomId: string; occurredAt: string; kind: string; payload: unknown };
export type RecordEventsPage = { events: RecordEventItem[]; nextCursor: string | null; prevCursor: string | null };

const RECORD_EVENT_SQL_WHERE = `conversation_id = ? AND sequence > ? AND kind IN ('archive.sync','context.warning','review.sent','review.failed','window.rotated')`;

/** forward：游标向后翻页（历史分页）。recent（F21）：返回最新 limit 条（升序）+ prevCursor 向更早翻页。 */
export function listRecordEvents(db: Db, conversationId: string, after: number, limit: number, mode: 'forward' | 'recent' | 'older' = 'forward', before: number | null = null): RecordEventsPage {
  if (mode === 'recent') {
    const rows = db.prepare(
      `SELECT sequence, event_id, occurred_at, kind, payload_ref FROM runtime_stream_events
       WHERE conversation_id = ? AND kind IN ('archive.sync','context.warning','review.sent','review.failed','window.rotated')
       ORDER BY sequence DESC LIMIT ?`,
    ).all(conversationId, limit) as Array<{ sequence: number; event_id: string; occurred_at: string; kind: string; payload_ref: string | null }>;
    const events = rows.slice().reverse().map(rowToEvent(conversationId));
    const prevCursor = events.length > 0 ? String(events[0]!.sequence) : null; // F26：older 模式消费"严格小于此序号"
    return { events, nextCursor: null, prevCursor };
  }
  if (mode === 'older' && before !== null) {
    // 审计 F26：向更早翻页=严格小于游标序号（旧实现 > cursor 会原样重发当前页）
    const rows = db.prepare(
      `SELECT sequence, event_id, occurred_at, kind, payload_ref FROM runtime_stream_events
       WHERE conversation_id = ? AND sequence < ? AND kind IN ('archive.sync','context.warning','review.sent','review.failed','window.rotated')
       ORDER BY sequence DESC LIMIT ?`,
    ).all(conversationId, before, limit) as Array<{ sequence: number; event_id: string; occurred_at: string; kind: string; payload_ref: string | null }>;
    const events = rows.slice().reverse().map(rowToEvent(conversationId));
    const prevCursor = events.length > 0 ? String(events[0]!.sequence) : null;
    return { events, nextCursor: null, prevCursor };
  }
  const rows = db.prepare(
    `SELECT sequence, event_id, occurred_at, kind, payload_ref FROM runtime_stream_events
     WHERE ${RECORD_EVENT_SQL_WHERE}
     ORDER BY sequence LIMIT ?`,
  ).all(conversationId, after, limit + 1) as Array<{ sequence: number; event_id: string; occurred_at: string; kind: string; payload_ref: string | null }>;
  const page = rows.slice(0, limit);
  const events = page.map(rowToEvent(conversationId));
  return { events, nextCursor: rows.length > limit ? String(page[page.length - 1]!.sequence) : null, prevCursor: null };
}

const rowToEvent = (roomId: string) => (r: { sequence: number; event_id: string; occurred_at: string; kind: string; payload_ref: string | null }): RecordEventItem =>
  ({ eventId: r.event_id, sequence: r.sequence, roomId, occurredAt: r.occurred_at, kind: r.kind, payload: r.payload_ref ? (JSON.parse(r.payload_ref) as unknown) : null });
