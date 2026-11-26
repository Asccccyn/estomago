// User sleep time only gates system keepwarm. Explicit self-wake appointments
// and ordinary reminders retain their own schedule and admission policy.
import type { Config } from '../config/schema.ts';

export type KeepwarmSleepWindow = Config['background']['keepwarm']['sleep_window'];
export type SleepWindowConfig = KeepwarmSleepWindow;
export type KeepwarmSleepState = {
  blocked: boolean;
  code: 'KEEPWARM_SLEEP_WINDOW' | 'KEEPWARM_SLEEP_CONFIG_INVALID' | null;
  local_time: string | null;
};

export function validSleepTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(0); return timezone.length > 0; }
  catch { return false; }
}

/** Local civil time, start inclusive/end exclusive, including overnight windows.
 * IANA timezones use their actual DST rules rather than the host machine timezone.
 * Bad configuration fails closed even if a caller bypassed schema validation. */
export function keepwarmSleepState(window: KeepwarmSleepWindow, nowMs: number): KeepwarmSleepState {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!window || !hhmm.test(window.start) || !hhmm.test(window.end) || window.start === window.end || !validSleepTimezone(window.timezone) || !Number.isFinite(nowMs)) {
    return { blocked: true, code: 'KEEPWARM_SLEEP_CONFIG_INVALID', local_time: null };
  }
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: window.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(nowMs);
  const inside = window.start < window.end
    ? localTime >= window.start && localTime < window.end
    : localTime >= window.start || localTime < window.end;
  const blocked = window.enabled && inside;
  return { blocked, code: blocked ? 'KEEPWARM_SLEEP_WINDOW' : null, local_time: localTime };
}

/** Local YYYY-MM-DD in the sleep window timezone (defaults to Asia/Shanghai). */
export function localDateInTimezone(timezone: string, nowMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(nowMs);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addCalendarDays(dateStr: string, days: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** For a timestamp inside an overnight sleep window (e.g. 23:00–08:00), returns
 *  the morning business date that ends this sleep window (23:30 on D -> D+1; 04:00 on D -> D).
 *  Returns null when outside the sleep window or sleep window is disabled/invalid. */
export function overnightMorningDate(window: KeepwarmSleepWindow, nowMs: number): string | null {
  const state = keepwarmSleepState(window, nowMs);
  if (!state.blocked || state.code !== 'KEEPWARM_SLEEP_WINDOW' || !state.local_time) return null;
  const localDate = localDateInTimezone(window.timezone, nowMs);
  if (window.start > window.end && state.local_time >= window.start) {
    return addCalendarDays(localDate, 1);
  }
  return localDate;
}

/** Whether the sleep window actually blocks automatic heartbeat at nowMs, taking
 *  into account an early resume for this exact overnight cycle (e.g. >=4h gap at 04:00).
 *  Invalid sleep configs always fail closed. The 23:00 cutoff for the NEXT night is
 *  preserved because its overnightMorningDate is tomorrow (!== today's earlyResumedDate). */
export function effectiveSleepState(
  window: KeepwarmSleepWindow,
  nowMs: number,
  earlyResumedDate: string | null | undefined,
): KeepwarmSleepState {
  const state = keepwarmSleepState(window, nowMs);
  if (!state.blocked || state.code === 'KEEPWARM_SLEEP_CONFIG_INVALID') return state;
  const morningDate = overnightMorningDate(window, nowMs);
  if (morningDate && earlyResumedDate && earlyResumedDate === morningDate) {
    return { blocked: false, code: null, local_time: state.local_time };
  }
  return state;
}
