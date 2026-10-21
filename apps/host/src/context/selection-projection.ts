import { validateAbsoluteIso } from '../util/time.ts';

/** Calendar dates, always in the business timezone; no elapsed-day rounding. */
export function selectionDate(instant: string | null): string | null {
  if (!instant || !validateAbsoluteIso(instant).ok) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function selectionIntroduction(occurredAt: string | null, referenceAt: string): string {
  const date = selectionDate(occurredAt);
  const reference = selectionDate(referenceAt);
  if (!date || !reference) return '这是你们之前说过的话：';
  const days = (Date.parse(reference) - Date.parse(date)) / 86400000;
  if (days < 0) return '这是你们之前说过的话：';
  const word = ['今天', '昨天', '前天'][days];
  return `这是你们${word ? `${word}（${date}）` : date}说过的话：`;
}

/** One host introduction for each continuous date/selection segment. */
export function selectionGuides(messages: Array<{ sequence: number; occurred_at?: string | null; reference_at?: string }>): Map<number, string> {
  const result = new Map<number, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const previous = messages[i - 1];
    const gap = previous !== undefined && m.sequence !== previous.sequence + 1;
    if (!previous || gap || selectionDate(m.occurred_at ?? null) !== selectionDate(previous.occurred_at ?? null)) {
      result.set(m.sequence, `${gap ? '—— 原文片段 ——\n\n' : ''}${selectionIntroduction(m.occurred_at ?? null, m.reference_at ?? '')}`);
    }
  }
  return result;
}
