// User sleep time only gates system keepwarm. Explicit self-wake appointments
// and ordinary reminders retain their own schedule and admission policy.
import type { Config } from '../config/schema.ts';

export type KeepwarmSleepWindow = Config['background']['keepwarm']['sleep_window'];
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
