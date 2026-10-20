import { useState } from 'react'
import { CalendarDays, ChevronDown, X } from 'lucide-react'

type DatePickerProps = {
  date: string | null
  timezone: string
  busy: boolean
  disabled?: boolean
  onPick: (date: string) => Promise<boolean>
}

export function dateInTimezone(timezone: string, instant = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function HistoryDatePicker({ date, timezone, busy, disabled, onPick }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const submit = async () => {
    if (!draft || busy || disabled) return
    setError('')
    try {
      if (await onPick(draft)) setOpen(false)
      else setError('暂时无法读取这一天的聊天记录，请重试。')
    } catch { setError('暂时无法读取这一天的聊天记录，请重试。') }
  }
  return (
    <div className="relative">
      <button type="button" aria-label="按日期查找聊天记录" aria-expanded={open} disabled={disabled || busy}
        onClick={() => { setDraft(date ?? dateInTimezone(timezone)); setError(''); setOpen((value) => !value) }}
        className="rounded-md p-1.5 text-[#8a8780] transition hover:bg-black/5 hover:text-[#3d3929] disabled:opacity-40">
        <CalendarDays size={18} />
      </button>
      {open && <>
        <div className="fixed inset-0 z-30" onClick={() => { if (!busy) setOpen(false) }} />
        <form aria-label="按日期查找" onSubmit={(e) => { e.preventDefault(); void submit() }}
          onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); setOpen(false) } }}
          className="absolute right-0 top-10 z-40 w-72 max-w-[calc(100vw-24px)] rounded-2xl border border-black/10 bg-white p-4 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <label htmlFor="chat-history-date" className="text-[14px] font-medium">查找聊天记录</label>
            <button type="button" aria-label="关闭日期选择" disabled={busy} onClick={() => setOpen(false)} className="rounded p-1 text-[#8a8780] hover:bg-black/5"><X size={16} /></button>
          </div>
          <input id="chat-history-date" type="date" required value={draft} disabled={busy}
            onChange={(e) => setDraft(e.target.value)} className="block w-full min-w-0 rounded-lg border border-[#d4cec0] bg-[#faf9f5] px-3 py-2 text-[16px] text-[#3d3929]" />
          <p className="mt-2 text-[11px] text-[#8a8780]">{timezone === 'Asia/Shanghai' ? '按北京时间选择日期' : `日期时区：${timezone}`}</p>
          {error && <p role="alert" className="mt-2 text-[12px] text-[#a54b35]">{error}</p>}
          <button type="submit" disabled={!draft || busy} className="mt-3 w-full rounded-full bg-[#3d3929] px-4 py-2 text-[13px] text-white disabled:opacity-50">{busy ? '正在查找…' : '查看记录'}</button>
        </form>
      </>}
    </div>
  )
}

export function HistoryBoundary({ direction, loading, hasMore, error, disabled, onLoad }: {
  direction: 'earlier' | 'later'
  loading: boolean
  hasMore: boolean
  error?: string
  disabled?: boolean
  onLoad: () => void
}) {
  const earlier = direction === 'earlier'
  return <div className="flex min-h-9 items-center justify-center px-4 pb-3 text-center text-[12px] text-[#8a8780]">
    {loading ? <span role="status">正在加载{earlier ? '更早' : '后续'}的消息…</span>
      : error ? <button type="button" disabled={disabled} onClick={onLoad} className="rounded-lg px-3 py-1 text-[#a54b35] hover:bg-black/5">{error} · 点击重试</button>
      : hasMore ? <button type="button" disabled={disabled} onClick={onLoad} className="rounded-lg px-3 py-1 hover:bg-black/5 disabled:opacity-40">{earlier ? '上滑加载更早的消息' : '加载后续消息'}</button>
      : <span>{earlier ? '已到最早的消息' : '已到最新的消息'}</span>}
  </div>
}

export function HistoryViewingBar({ date, newMessages, busy, disabled, onLatest }: { date: string | null; newMessages?: boolean; busy: boolean; disabled?: boolean; onLatest: () => void }) {
  return <div className="flex shrink-0 items-center justify-between gap-2 border-b border-black/5 bg-[#f4f1e9] px-4 py-2 text-[12px] text-[#8a8780]">
    <span>{date ? `正在查看 ${date}` : '正在查看较早的消息'}{newMessages ? ' · 有新消息' : ''}</span>
    <button type="button" disabled={busy || disabled} onClick={onLatest} className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[#5e5d59] hover:bg-black/5 disabled:opacity-40">{busy ? '正在加载…' : '回到最新'}<ChevronDown size={13} /></button>
  </div>
}
