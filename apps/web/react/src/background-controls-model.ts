// The scheduling form uses the same business timezone as task display.
export function backgroundInputTime(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso))
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`
}

export function backgroundInputToIso(local: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error('请选择有效的北京时间')
  const iso = new Date(`${local}:00+08:00`).toISOString()
  if (backgroundInputTime(iso) !== local) throw new Error('请选择有效的北京时间')
  return iso
}

export function appendBackgroundPage<T extends Record<string, any>>(previous: T[], page: T[], key: string): T[] {
  const merged = new Map(previous.map((row) => [row[key], row]))
  for (const row of page) merged.set(row[key], row)
  return [...merged.values()]
}

export const backgroundTaskStatus: Record<string, string> = { scheduled: '已预约', completed: '已完成', cancelled: '已取消', needs_review: '待核对' }
