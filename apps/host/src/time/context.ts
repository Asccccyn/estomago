// Time Context（01 §8 / M2）：每轮实际执行前刷新；时间是程序给的事实，不靠模型猜。
// 两个"多久"不可混用：
//   elapsed_before_current_user_message —— "你多久后回来"：本次消息之前的那次用户记录
//   elapsed_since_last_user_message     —— "现在多久没收到你消息"：当前最新记录
// 助手主动消息不重置用户沉默时间。
import type { Db } from '../db/connection.ts';
import type { Config } from '../config/schema.ts';

export type TimeContext = {
  now_at_utc: string;
  business_timezone: string;
  local_date: string;
  weekday: string;
  daypart: string;
  event_occurred_at: string | null;
  processing_at: string;
  previous_user_message_at: string | null;
  elapsed_before_current_user_message: string | null; // ISO 8601 duration
  last_user_message_at: string | null;
  elapsed_since_last_user_message: string | null;
  last_assistant_published_at: string | null;
  elapsed_since_last_assistant_message: string | null;
  conversation_id: string;
  window_started_at: string | null;
  crossed_business_date: boolean;
};

export function buildTimeContext(
  db: Db,
  opts: { conversationId: string; config: Config; eventOccurredAt?: string | null; windowStartedAt?: string | null; previousUserMessageAt?: string | null },
): TimeContext {
  const now = new Date();
  const nowIso = now.toISOString();
  const tz = opts.config.time.business_timezone;

  // 共同业务时区下的本地日历字段
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour) % 24;
  const daypart = hour < 5 ? 'night' : hour < 11 ? 'morning' : hour < 13 ? 'noon' : hour < 18 ? 'afternoon' : hour < 23 ? 'evening' : 'night';

  const lastUser = db
    .prepare(`SELECT r.occurred_at FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
              WHERE m.conversation_id = ? AND m.speaker = 'owner' ORDER BY m.sequence DESC LIMIT 1`)
    .get(opts.conversationId) as { occurred_at: string } | undefined;
  const prevUser = db
    .prepare(`SELECT r.occurred_at FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
              WHERE m.conversation_id = ? AND m.speaker = 'owner' ORDER BY m.sequence DESC LIMIT 1 OFFSET 1`)
    .get(opts.conversationId) as { occurred_at: string } | undefined;
  const lastAssistant = db
    .prepare(`SELECT m.published_at FROM messages m WHERE m.conversation_id = ? AND m.speaker = 'assistant' AND m.published_at IS NOT NULL ORDER BY m.sequence DESC LIMIT 1`)
    .get(opts.conversationId) as { published_at: string } | undefined;

  // 本次事件之前的用户记录 = 除（本次正在处理的）最后一条外的最新一条
  const eventAt = opts.eventOccurredAt ?? lastUser?.occurred_at ?? null;
  const previousUserAt = opts.previousUserMessageAt ?? prevUser?.occurred_at ?? null;

  let crossedBusinessDate = false;
  if (previousUserAt && eventAt) {
    const prevLocal = localDateOf(previousUserAt, tz);
    const eventLocal = localDateOf(eventAt, tz);
    crossedBusinessDate = prevLocal !== eventLocal;
  }

  return {
    now_at_utc: nowIso,
    business_timezone: tz,
    local_date: localDate,
    weekday: String(parts.weekday ?? ''),
    daypart,
    event_occurred_at: eventAt,
    processing_at: nowIso,
    previous_user_message_at: previousUserAt,
    elapsed_before_current_user_message: previousUserAt && eventAt ? isoDuration(new Date(eventAt).getTime() - new Date(previousUserAt).getTime()) : null,
    last_user_message_at: lastUser?.occurred_at ?? null,
    elapsed_since_last_user_message: lastUser ? isoDuration(now.getTime() - new Date(lastUser.occurred_at).getTime()) : null,
    last_assistant_published_at: lastAssistant?.published_at ?? null,
    elapsed_since_last_assistant_message: lastAssistant?.published_at
      ? isoDuration(now.getTime() - new Date(lastAssistant.published_at).getTime())
      : null,
    conversation_id: opts.conversationId,
    window_started_at: opts.windowStartedAt ?? null,
    crossed_business_date: crossedBusinessDate,
  };
}

function localDateOf(iso: string, tz: string): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function isoDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `PT${h}H${m}M${s}S`;
}
