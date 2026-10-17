import { Bell, X } from 'lucide-react'

export type SystemAlert = {
  alert_id: string; code: string; severity: string; lifecycle: string;
  unread?: boolean; occurrence_count?: number; last_event_sequence: number;
  safe_summary?: { title?: string; detail?: string };
}

export function SystemAlertsButton({ unread, open, onClick }: {
  unread: number; open: number; onClick: () => void;
}) {
  return <button onClick={onClick}
    aria-label={`系统异常，${unread} 条未读，${open} 项待处理`}
    className="relative rounded-md p-1.5 text-[#8a8780] hover:bg-black/5 hover:text-[#3d3929]">
    <Bell size={18} />
    {unread > 0 && <span data-testid="system-alert-dot" aria-hidden="true"
      className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-600" />}
  </button>
}

export function SystemAlertsPanel({ alerts, unread, open, error, hasMore,
  onClose, onRefresh, onRead, onMore }: {
  alerts: SystemAlert[]; unread: number; open: number; error: string; hasMore: boolean;
  onClose: () => void; onRefresh: () => void; onRead: () => void; onMore: () => void;
}) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/25" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="system-alerts-heading"
      onClick={e=>e.stopPropagation()}
      className="sheet-in max-h-[75dvh] w-full overflow-y-auto rounded-t-3xl bg-[#faf9f5] px-5 pt-4 pb-[max(env(safe-area-inset-bottom),24px)]">
      <div className="mb-2 flex items-center justify-between">
        <h2 id="system-alerts-heading" className="text-[17px] font-medium">系统异常</h2>
        <button aria-label="关闭系统异常" onClick={onClose} className="rounded-md p-1.5"><X size={18}/></button>
      </div>
      <p className="mb-3 text-[13px] text-[#8a8780]">{unread} 条未读 · {open} 项待处理。标为已读不会结束尚未恢复的异常。</p>
      <div className="mb-4 flex gap-4 text-[13px] text-[#c96442]">
        <button onClick={onRefresh}>刷新</button>
        <button onClick={onRead} disabled={!alerts.some(a=>a.unread)} className="disabled:opacity-40">将已显示记录标为已读</button>
      </div>
      {error && <p role="status" className="mb-4 text-[13px] text-[#a33d2d]">{error}</p>}
      {!error && alerts.length===0 && <p className="py-4 text-[13px] text-[#8a8780]">暂无系统异常记录</p>}
      {alerts.map(alert=><article key={alert.alert_id} className="mb-3 rounded-xl border border-black/10 p-3">
        <p className="text-[14px] font-medium">{alert.safe_summary?.title || (alert.code==='BOOTSTRAP_INCOMPLETE'?'开窗资料未完整载入':alert.code)}</p>
        {alert.safe_summary?.detail && <p className="mt-1 text-[13px] text-[#5e5d59]">{alert.safe_summary.detail}</p>}
        <p className="mt-1 text-[12px] text-[#8a8780]">
          {alert.lifecycle==='resolved'?'已恢复':'待处理'} · {alert.severity==='critical'?'严重':alert.severity==='warning'?'警告':'提示'}
          {alert.unread?' · 未读':''}{typeof alert.occurrence_count==='number'?` · ${alert.occurrence_count} 次`:''}
        </p>
      </article>)}
      {hasMore && <button onClick={onMore} className="mb-3 text-[13px] text-[#c96442]">加载更早记录</button>}
    </section>
  </div>
}
