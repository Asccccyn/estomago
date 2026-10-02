// F14：绝对时间严格验证器——API 入库与存量修复共用的单一事实源。
// 拒绝：非字符串、空串、无时区相对值、月99、2月30、非闰年2月29、25时、61秒、超范围偏移。
// Date.parse 的宽松归一化（如 2026-02-30 → 3月2日）不得作为校验依据，逐项日历校验。
export type TimeValidation = { ok: true; iso: string } | { ok: false; reason: string };

const ISO_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function validateAbsoluteIso(input: unknown): TimeValidation {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, reason: 'not_string' };
  const m = ISO_SHAPE.exec(input);
  if (!m) return { ok: false, reason: 'not_timezone_qualified_iso' };
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
  const tz = m[8]!, tzHour = m[9] !== undefined ? Number(m[9]) : 0, tzMinute = m[10] !== undefined ? Number(m[10]) : 0;
  if (month < 1 || month > 12) return { ok: false, reason: 'month_out_of_range' };
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > daysInMonth) return { ok: false, reason: 'day_out_of_range' };
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'time_out_of_range' };
  if (tz !== 'Z' && (tzHour > 23 || tzMinute > 59)) return { ok: false, reason: 'offset_out_of_range' };
  if (Number.isNaN(Date.parse(input))) return { ok: false, reason: 'unparseable' };
  return { ok: true, iso: input };
}
