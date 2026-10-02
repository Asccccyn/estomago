// Time Context v0.2.2（AUD-21 修复）：previous 取"当前输入 sequence 之前"的最近用户消息，
// 不读未来/当前消息；两个"多久"继续分开；助手主动消息不重置用户沉默。
import type { Db } from '../db/connection.ts';
import type { Config } from '../config/schema.ts';
import { validateAbsoluteIso } from '../util/time.ts';

export type TimeContext = {
  now_at_utc: string;
  business_timezone: string;
  local_date: string;
  weekday: string;
  daypart: string;
  event_occurred_at: string | null;
  processing_at: string;
  previous_user_message_at: string | null;
  elapsed_before_current_user_message: string | null;
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
  opts: { conversationId: string; config: Config; eventOccurredAt?: string | null; currentInputSequence?: number | null; windowStartedAt?: string | null },
): TimeContext {
  const now = new Date();
  const nowIso = now.toISOString();
  const tz = opts.config.time.business_timezone;

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour) % 24;
  const daypart = hour < 5 ? 'night' : hour < 11 ? 'morning' : hour < 13 ? 'noon' : hour < 18 ? 'afternoon' : hour < 23 ? 'evening' : 'night';

  // AUD-21：前驱 = sequence < 当前输入 sequence 的最近一条用户消息（无 sequence 时退化为"最新一条之前的用户消息"）
  let prevUser: { occurred_at: string } | undefined;
  if (opts.currentInputSequence != null) {
    prevUser = db
      .prepare(
        `SELECT r.occurred_at FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.conversation_id = ? AND m.speaker = 'owner' AND m.sequence < ?
         ORDER BY m.sequence DESC LIMIT 1`,
      )
      .get(opts.conversationId, opts.currentInputSequence) as { occurred_at: string } | undefined;
  } else {
    prevUser = db
      .prepare(
        `SELECT r.occurred_at FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.conversation_id = ? AND m.speaker = 'owner' ORDER BY m.sequence DESC LIMIT 1 OFFSET 1`,
      )
      .get(opts.conversationId) as { occurred_at: string } | undefined;
  }
  const lastUser = db
    .prepare(
      `SELECT r.occurred_at FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       WHERE m.conversation_id = ? AND m.speaker = 'owner' ORDER BY m.sequence DESC LIMIT 1`,
    )
    .get(opts.conversationId) as { occurred_at: string } | undefined;
  const lastAssistant = db
    .prepare(
      `SELECT m.published_at FROM messages m WHERE m.conversation_id = ? AND m.speaker = 'assistant' AND m.published_at IS NOT NULL ORDER BY m.sequence DESC LIMIT 1`,
    )
    .get(opts.conversationId) as { published_at: string } | undefined;

  const eventAt = opts.eventOccurredAt ?? lastUser?.occurred_at ?? null;
  const previousUserAt = prevUser?.occurred_at ?? null;

  // F14：存量无效时间不得让整轮构建抛 RangeError——逐个验证，无效者按"未知"处理（间隔 null、跨日无法判定）
  const validIso = (v: string | null | undefined): string | null => (v != null && validateAbsoluteIso(v).ok ? v : null);
  const eventAtSafe = validIso(eventAt);
  const previousUserAtSafe = validIso(previousUserAt);
  const lastUserAtSafe = validIso(lastUser?.occurred_at ?? null);
  const lastAssistantAtSafe = validIso(lastAssistant?.published_at ?? null);
  const elapsed = (from: string | null, to: string | null): string | null => {
    if (!from || !to) return null;
    const ms = new Date(to).getTime() - new Date(from).getTime();
    return Number.isFinite(ms) ? isoDuration(ms) : null;
  };

  let crossedBusinessDate = false;
  if (previousUserAtSafe && eventAtSafe) {
    const a = localDateOf(previousUserAtSafe, tz);
    const b = localDateOf(eventAtSafe, tz);
    crossedBusinessDate = a !== null && b !== null && a !== b;
  }

  return {
    now_at_utc: nowIso,
    business_timezone: tz,
    local_date: localDate,
    weekday: String(parts.weekday ?? ''),
    daypart,
    event_occurred_at: eventAt,
    processing_at: nowIso,
    previous_user_message_at: previousUserAtSafe,
    elapsed_before_current_user_message: elapsed(previousUserAtSafe, eventAtSafe),
    last_user_message_at: lastUserAtSafe,
    elapsed_since_last_user_message: lastUserAtSafe ? isoDuration(now.getTime() - new Date(lastUserAtSafe).getTime()) : null,
    last_assistant_published_at: lastAssistantAtSafe,
    elapsed_since_last_assistant_message: lastAssistantAtSafe ? isoDuration(now.getTime() - new Date(lastAssistantAtSafe).getTime()) : null,
    conversation_id: opts.conversationId,
    window_started_at: opts.windowStartedAt ?? null,
    crossed_business_date: crossedBusinessDate,
  };
}

function localDateOf(iso: string, tz: string): string | null {
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    return null; // F14：无效日期不抛 RangeError，跨日判定退化为"无法判定"（false）
  }
}

function isoDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `PT${h}H${m}M${s}S`;
}
