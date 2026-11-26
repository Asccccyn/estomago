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
  enabled?: boolean
  scheduled?: boolean
  blocked_reason?: string | null
  sleep_window_active?: boolean
  next_keepwarm_at?: string
  next_keepwarm_basis?: string
  morning_postponed_by_at?: string | null
  morning_wake?: {
    scheduled: boolean
    target_at?: string
    basis?: 'morning_baseline' | 'morning_postponed'
    postponed_by_at?: string | null
    reason?: string
  }
  resting?: boolean
  rest_decided_at?: string | null
  rest_recovery_mode?: 'morning_0800' | 'next_user_message' | null
  rest_morning_date?: string | null
  consecutive_unanswered_count?: number
  pending_rest_judgment?: boolean
}

/** Words for the eligibility the server reports (v2.1 single-switch display).
 *  The page never derives a schedule of its own. */
export function keepwarmStatusText(
  status: KeepwarmStatus | undefined,
  sleepWindow: { start: string; end: string; timezone: string } | undefined,
  formatTime: (iso: string) => string,
): string {
  const window = sleepWindow ? `（${sleepWindow.start}–${sleepWindow.end}，${sleepWindow.timezone}）` : ''
  const morningTarget = status?.morning_wake?.scheduled && status.morning_wake.target_at
    ? formatTime(status.morning_wake.target_at)
    : null

  switch (status?.blocked_reason) {
    case 'KEEPWARM_DISABLED':
      return '已关闭 · 等待手动开启'
    case 'KEEPWARM_SLEEP_CONFIG_INVALID':
      return '已开启 · 睡眠时段配置无效，心跳已暂停'
    case 'REST_JUDGMENT_PENDING':
      return '已开启 · 正在判断休息状态'
    case 'KEEPWARM_RESTING_WAIT_USER':
      return '已开启 · 正在补觉，等你下条消息'
    case 'KEEPWARM_RESTING':
      return morningTarget
        ? `已开启 · 正常夜休暂停，次晨 ${morningTarget} 有条件兜底`
        : '已开启 · 休息中，等你下条消息'
    case 'KEEPWARM_CONSECUTIVE_LIMIT':
      return morningTarget
        ? `已开启 · 连续三次未出现，今日暂停（次晨 ${morningTarget} 恢复）`
        : '已开启 · 连续三次未出现，今日暂停'
    case 'KEEPWARM_SLEEP_WINDOW':
      if (status.sleep_window_active) {
        return morningTarget
          ? `已开启 · 夜间暂停${window}，次晨 ${morningTarget} 有条件兜底`
          : `已开启 · 夜间暂停${window}`
      }
      return morningTarget
        ? `已开启 · 下次到点落在睡眠时段，今晚暂停（次晨 ${morningTarget} 有条件兜底）`
        : `已开启 · 下次到点落在睡眠时段，届时暂停${window}`
    case 'MORNING_WAKE_MISSED_GRACE':
      return morningTarget
        ? `已开启 · 今日晨间机会已错过，次晨 ${morningTarget} 有条件兜底`
        : '已开启 · 今日晨间机会已错过'
    default:
      break
  }

  if (status?.scheduled && status.next_keepwarm_at) {
    const formatted = formatTime(status.next_keepwarm_at)
    if (status.next_keepwarm_basis === 'morning_baseline') {
      return `已开启 · 下次心跳 ${formatted}（晨间兜底）`
    }
    return `已开启 · 下次心跳 ${formatted}`
  }
  return '已开启 · 暂无排程（还没有真实聊天）'
}
