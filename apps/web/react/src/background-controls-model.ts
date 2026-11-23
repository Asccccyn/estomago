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

export type KeepwarmStatus = {
  scheduled?: boolean
  blocked_reason?: string | null
  sleep_window_active?: boolean
  next_keepwarm_at?: string
  next_keepwarm_basis?: string
  resting?: boolean
  rest_decided_at?: string | null
}

/** Words for the eligibility the server reports. The page never derives a schedule of its own. */
export function keepwarmStatusText(
  status: KeepwarmStatus | undefined,
  sleepWindow: { start: string; end: string; timezone: string } | undefined,
  formatTime: (iso: string) => string,
): string {
  const window = sleepWindow ? `（${sleepWindow.start}–${sleepWindow.end}，${sleepWindow.timezone}）` : ''
  switch (status?.blocked_reason) {
    case 'KEEPWARM_DISABLED': return '心跳保温已关闭'
    case 'KEEPWARM_RESTING': return `休息中：乔乔说晚安后暂停，等她明确醒来或在这里恢复${status.rest_decided_at ? `（${formatTime(status.rest_decided_at)} 起）` : ''}`
    case 'KEEPWARM_SLEEP_CONFIG_INVALID': return '睡眠时段配置无效，心跳已暂停'
    case 'KEEPWARM_SLEEP_WINDOW': return status.sleep_window_active ? `睡眠时段暂停${window}` : `下次到点落在睡眠时段，届时暂停${window}`
    default: break
  }
  return status?.scheduled && status.next_keepwarm_at
    ? `下次 ${formatTime(status.next_keepwarm_at)}（${status.next_keepwarm_basis === 'maintenance' ? '按上次维护' : '按最后消息'}）`
    : '暂无排程（还没有真实聊天）'
}
