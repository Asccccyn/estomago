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
  driver: 'openrouter' | 'claude-agent-sdk' | 'mock' | 'unknown';
  exactModel: string | null;
  context: { estimatedInput: number | null; lastActualInput: number | null; effectiveSoft: number | null; hardCapacity: number | null; estimateQuality: string };
  cache: { requestedTtl: '1h'; lastRead: number | null; lastWrite: number | null; lastNoncached: number | null; lastCostUsd: number | null; observedAt: string | null; estimatedExpiresAt: string | null; keeperEnabled: false };
  review: { id: string; status: string; decision: string | null; holdCount: number | null; windowId: string; isCurrentWindow: boolean } | null;
  rawSync: { state: 'saved_pending_sync' | 'synced' | 'partial' | 'failed' | 'unknown'; enabled: boolean; pending: number; failed: number; acked: number };
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
  const exactModel = driver === 'openrouter' ? d.config.openrouter.model : d.config.runtime.model;

  // §11.1：本地粗估 + 实际 usage 校准；精度分级如实
  const trajRow = win
    ? (d.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id) as { messages_json: string } | undefined)
    : undefined;
  let estimated: number | null = null;
  let quality = 'unknown';
  if (trajRow) {
    const msgs = JSON.parse(trajRow.messages_json) as Array<{ content: unknown }>;
    const chars = msgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0);
    estimated = Math.ceil(chars / 2.5);
    quality = 'rough';
  }
  const lastUsage = win
    ? (d.db.prepare(
        `SELECT u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.observed_at
         FROM usage_observations u LEFT JOIN attempts a ON a.id = u.attempt_id
         WHERE (u.window_id = ? OR a.window_id = ?) AND u.source = 'or_stream' AND u.completeness = 'complete' AND u.input_tokens IS NOT NULL
         ORDER BY u.observed_at DESC LIMIT 1`,
      ).get(win.id, win.id) as { input_tokens: number; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; observed_at: string } | undefined)
    : undefined;
  if (lastUsage) {
    estimated = Math.max(estimated ?? 0, lastUsage.input_tokens);
    quality = 'calibrated_rough';
  }
  const w = d.config.windows;
  const hardCapacity = w.model_context_capacity; // null=未测量，不画假百分比
  const safeInput = hardCapacity !== null ? hardCapacity - d.config.openrouter.max_output_tokens - w.tool_input_reserve_tokens - w.review_reserve_tokens - w.safety_reserve_tokens : null;
  const effectiveSoft = safeInput !== null ? Math.min(w.soft_limit_tokens, safeInput) : w.soft_limit_tokens;

  // F22：按房间取最近一次检查（成功换窗后完成结果留在旧窗——不因窗口切换显示"还没检查过"）
  const reviewRow = (d.db.prepare("SELECT id, status, decision, window_id FROM rotation_reviews WHERE room_id = ? ORDER BY created_at DESC LIMIT 1").get(conversationId) as { id: string; status: string; decision: string | null; window_id: string } | undefined);
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
  return {
    roomId: conversationId,
    cursor: lastEventSequence !== null ? String(lastEventSequence) : null,
    epochId: win?.id ?? null,
    driver,
    exactModel,
    context: { estimatedInput: estimated, lastActualInput: lastUsage?.input_tokens ?? null, effectiveSoft, hardCapacity, estimateQuality: quality },
    cache: {
      requestedTtl: '1h',
      lastRead: lastUsage?.cache_read_input_tokens ?? null,
      lastWrite: lastUsage?.cache_creation_input_tokens ?? null,
      lastNoncached: lastUsage && lastUsage.input_tokens !== null && lastUsage.cache_read_input_tokens !== null && lastUsage.cache_creation_input_tokens !== null
        ? lastUsage.input_tokens - lastUsage.cache_read_input_tokens - lastUsage.cache_creation_input_tokens
        : null,
      lastCostUsd: costRow?.cost_usd ?? null, // F19：已返回的实际费用（未返回时不编数）
      observedAt,
      estimatedExpiresAt: requestStartedAt ? new Date(Date.parse(requestStartedAt) + 60 * 60 * 1000).toISOString() : null, // §7.3：真实发送开始+1h（F18：未发送行不刷 TTL）
      keeperEnabled: false,
    },
    review: reviewRow ? { id: reviewRow.id, status: reviewRow.status, decision: reviewRow.decision, holdCount, windowId: reviewRow.window_id, isCurrentWindow: reviewRow.window_id === (win?.id ?? null) } : null,
    rawSync: { state: rawState, enabled: raw?.enabled ?? false, pending: raw?.pending ?? 0, failed: raw?.failed ?? 0, acked: raw?.acked ?? 0 },
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
