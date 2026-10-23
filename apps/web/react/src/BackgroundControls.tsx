// WAKE_KEEPWARM_V1 §08（2026-10-22）：后台管理面——两项独立开关 + 预约任务列表/详情/取消 + 运行状态。
// 独立组件自持状态（不进 App 主状态机）；服务端是权威——开关加载前显示"加载中/未知"
// （不默认 true，A-04）；切换失败回滚并显示原因；并发修改冲突提示刷新（不静默覆盖）。
// 后端定时器不受页面隐藏/关闭影响；本组件只读状态与发起管理操作，不在 mount 时创建任务。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EstomagoClient } from './chat-client'
import { appendBackgroundPage, backgroundInputTime, backgroundInputToIso, backgroundTaskStatus } from './background-controls-model'

type Json = Record<string, any>

const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  // 08 口径：用户业务展示按 Asia/Shanghai（服务端权威值的显示层钉扎，不随访问者漂移）
  return Number.isFinite(d.getTime()) ? d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }) : '—'
}

export function BackgroundControls({ client, onClose }: { client: EstomagoClient; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<Json | null>(null)
  const [tasks, setTasks] = useState<Json[] | null>(null)
  const [runs, setRuns] = useState<Json[] | null>(null)
  const [taskCursor, setTaskCursor] = useState<string | null>(null)
  const [runCursor, setRunCursor] = useState<string | null>(null)
  const [detail, setDetail] = useState<Json | null>(null)
  const [busy, setBusy] = useState(false)
  const [wakeNote, setWakeNote] = useState('')
  const [wakeAt, setWakeAt] = useState('')
  const [editNote, setEditNote] = useState('')
  const [editAt, setEditAt] = useState('')
  const [budgets, setBudgets] = useState({ autonomous: '', keepwarm: '' })
  const refreshGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const pendingCreate = useRef<{ key: string; body: { note: string; at: string } } | null>(null)

  const refresh = useCallback(async (preserveError = false) => {
    const generation = ++refreshGeneration.current
    if (!preserveError) setError(null)
    try {
      const [s, t, r] = await Promise.all([client.backgroundSettings(), client.backgroundTasks(), client.backgroundRuns()])
      if (generation !== refreshGeneration.current) return
      setSettings(s); setTasks(t.tasks ?? []); setRuns(r.runs ?? [])
      setTaskCursor(t.next_cursor ?? null); setRunCursor(r.next_cursor ?? null)
      setBudgets({ autonomous: String(s.autonomous?.daily_cost_cap_usd ?? ''), keepwarm: String(s.keepwarm?.daily_cost_cap_usd ?? '') })
    } catch (e) {
      if (generation !== refreshGeneration.current) return
      setError((e as Error).message || '加载失败')
    } finally {
      if (generation === refreshGeneration.current) setLoading(false)
    }
  }, [client])

  useEffect(() => { void refresh(); return () => { refreshGeneration.current++ } }, [refresh])
  // 页面重新可见只补状态，不补发任何操作（08：重连不重复创建/触发）
  useEffect(() => {
    const onVisible = (): void => { if (document.visibilityState === 'visible' && !loading) void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, [refresh, loading])

  const toggle = async (section: 'autonomous' | 'keepwarm'): Promise<void> => {
    if (!settings || busy) return
    const current = settings[section]?.enabled === true
    const optimistic = { ...settings, [section]: { ...settings[section], enabled: !current } }
    setSettings(optimistic) // 乐观切换；失败回滚（A-04）
    setBusy(true)
    try {
      const r = await client.backgroundPutSettings(settings.revision, { [section]: { enabled: !current } }, `ui-${section}-${Date.now()}`)
      setSettings({ ...optimistic, revision: r.revision })
      void refresh()
    } catch (e) {
      setSettings(settings) // 回滚
      const err = e as Error & { code?: string }
      setError(err.code === 'revision_conflict' ? '设置已被其他设备修改，正在刷新——请重试' : (err.message || '切换失败'))
      if (err.code === 'revision_conflict') void refresh(true)
    } finally {
      setBusy(false)
    }
  }

  const createWake = async (): Promise<void> => {
    if (busy) return
    if (!wakeNote.trim()) { setError('预约内容不能为空'); return }
    if (!wakeAt) { setError('请选择未来的时间'); return }
    setBusy(true); setError(null)
    try {
      const body = { note: wakeNote, at: backgroundInputToIso(wakeAt) }
      if (pendingCreate.current && JSON.stringify(pendingCreate.current.body) !== JSON.stringify(body)) throw new Error('上次预约结果尚未确认，请先按原内容和时间重试。')
      pendingCreate.current ??= { key: `ui-wake-${crypto.randomUUID()}`, body }
      await client.backgroundCreateWake(pendingCreate.current.body, pendingCreate.current.key)
      pendingCreate.current = null
      setWakeNote(''); setWakeAt('')
      void refresh(true)
    } catch (e) {
      if ((e as { status?: number }).status && (e as { status: number }).status < 500) pendingCreate.current = null
      setError((e as Error).message || '创建失败')
    } finally {
      setBusy(false)
    }
  }

  const cancelTask = async (task: Json): Promise<void> => {
    if (busy || !confirm('取消这个预约？已发生的执行与费用保留。')) return
    setBusy(true); setError(null)
    try {
      await client.backgroundCancelTask(task.task_id, task.revision, `ui-cancel-${Date.now()}`)
      setDetail(null)
      void refresh()
    } catch (e) {
      const err = e as Error & { code?: string }
      setError(err.code === 'revision_conflict' ? '任务已被修改，已刷新——请核对后重试' : (err.message || '取消失败'))
      void refresh(true)
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (id: string): Promise<void> => {
    const generation = ++detailGeneration.current
    try {
      const d = await client.backgroundTaskDetail(id)
      if (generation !== detailGeneration.current) return
      setDetail(d.task ?? null)
      setEditNote(d.task?.note ?? ''); setEditAt(backgroundInputTime(d.task?.scheduled_at))
    } catch (e) {
      setError((e as Error).message || '详情读取失败')
    }
  }

  const updateTask = async (): Promise<void> => {
    if (busy || !detail) return
    if (!editNote.trim() || !editAt) { setError('请填写预约内容与未来的北京时间'); return }
    setBusy(true); setError(null)
    try {
      await client.backgroundUpdateTask(detail.task_id, detail.revision, { note: editNote, at: backgroundInputToIso(editAt) }, `ui-update-${crypto.randomUUID()}`)
      setDetail(null); await refresh()
    } catch (e) {
      setError((e as Error).message || '修改失败；请刷新详情后重试')
      await refresh(true)
    } finally { setBusy(false) }
  }

  const saveBudget = async (section: 'autonomous' | 'keepwarm'): Promise<void> => {
    if (busy || !settings) return
    const cap = Number(budgets[section])
    if (!budgets[section].trim() || !Number.isFinite(cap) || cap <= 0) { setError('日费用上限必须是有效正数（美元）'); return }
    setBusy(true); setError(null)
    try {
      await client.backgroundPutSettings(settings.revision, { [section]: { daily_cost_cap_usd: cap } }, `ui-budget-${crypto.randomUUID()}`)
      await refresh()
    } catch (e) { setError((e as Error).message || '预算保存失败'); await refresh(true) }
    finally { setBusy(false) }
  }

  const loadMore = async (kind: 'tasks' | 'runs'): Promise<void> => {
    const cursor = kind === 'tasks' ? taskCursor : runCursor
    if (!cursor || busy) return
    const generation = refreshGeneration.current
    setBusy(true); setError(null)
    try {
      const page = kind === 'tasks' ? await client.backgroundTasks(cursor) : await client.backgroundRuns(cursor)
      if (generation !== refreshGeneration.current) return
      if (kind === 'tasks') { setTasks((old) => appendBackgroundPage(old ?? [], page.tasks ?? [], 'task_id')); setTaskCursor(page.next_cursor ?? null) }
      else { setRuns((old) => appendBackgroundPage(old ?? [], page.runs ?? [], 'id')); setRunCursor(page.next_cursor ?? null) }
    } catch (e) { setError((e as Error).message || '下一页读取失败') }
    finally { setBusy(false) }
  }

  const stopRun = async (id: string): Promise<void> => {
    if (busy || !confirm('停止当前后台运行？已发生的消息与费用保留。')) return
    setBusy(true)
    try {
      await client.backgroundStopRun(id, `ui-stop-${Date.now()}`)
      void refresh()
    } catch (e) {
      setError((e as Error).message || '停止失败')
    } finally {
      setBusy(false)
    }
  }

  const kw = settings?.keepwarm_status ?? {}
  const openRun = (runs ?? []).find((r) => ['claimed', 'running', 'cancelling'].includes(r.state))

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/25" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="自主预约与心跳保温" className="max-h-[82vh] w-full overflow-y-auto rounded-t-3xl bg-[#faf9f5] p-5 text-[14px]" onClick={(e) => { e.stopPropagation() }}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-medium">自主预约与心跳保温</h2>
          <div className="flex items-center gap-2">
            <button className="text-[12px] text-[#8a8780]" onClick={() => void refresh()}>刷新</button>
            <button aria-label="关闭" onClick={onClose}>×</button>
          </div>
        </div>
        {error && <div role="alert" className="mb-3 rounded-xl bg-[#f6e8e4] px-3 py-2 text-[12.5px] text-[#a4552f]">{error}</div>}
        {loading && <p className="py-6 text-center text-[13px] text-[#8a8780]">加载中…（开关状态未知，不预设开启）</p>}
        {!loading && settings && (
          <>
            <div className="space-y-2">
              <label className="flex items-center justify-between rounded-2xl border border-black/5 bg-white px-3 py-2.5">
                <span>
                  <span className="block">自主预约唤醒</span>
                  <span className="block text-[11.5px] text-[#8a8780]">char可自己预约未来时刻醒来（互相独立）</span>
                </span>
                <input type="checkbox" checked={settings.autonomous?.enabled === true} disabled={busy} onChange={() => void toggle('autonomous')} />
              </label>
              <label className="flex items-center justify-between rounded-2xl border border-black/5 bg-white px-3 py-2.5">
                <span>
                  <span className="block">心跳保温</span>
                  <span className="block text-[11.5px] text-[#8a8780]">
                    {kw.blocked_reason === 'KEEPWARM_SLEEP_WINDOW' ? `睡眠时段暂停（${settings.keepwarm.sleep_window.start}–${settings.keepwarm.sleep_window.end}，${settings.keepwarm.sleep_window.timezone}）` : kw.blocked_reason === 'KEEPWARM_SLEEP_CONFIG_INVALID' ? '睡眠时段配置无效，心跳已暂停' : kw.scheduled ? `下次 ${fmtTime(kw.next_keepwarm_at)}（${kw.next_keepwarm_basis === 'maintenance' ? '按上次维护' : '按最后消息'}）` : '暂无排程（无真实活动或未开启）'}
                  </span>
                </span>
                <input type="checkbox" checked={settings.keepwarm?.enabled === true} disabled={busy} onChange={() => void toggle('keepwarm')} />
              </label>
            </div>
            <div className="mt-3 space-y-2 rounded-2xl border border-black/5 bg-white p-3">
              <h3 className="text-[13px] font-medium">每日费用上限（美元）</h3>
              {(['autonomous', 'keepwarm'] as const).map((section) => <label key={section} className="flex items-center gap-2 text-[12px]">
                <span className="w-20">{section === 'autonomous' ? '自主唤醒' : '心跳保温'}</span>
                <input aria-label={`${section === 'autonomous' ? '自主唤醒' : '心跳保温'}日费用上限`} type="number" min="0.01" step="0.01" className="min-w-0 flex-1 rounded-lg border border-black/10 p-2" placeholder="未配置" value={budgets[section]} onChange={(e) => setBudgets((old) => ({ ...old, [section]: e.target.value }))} />
                <button disabled={busy} onClick={() => void saveBudget(section)}>保存</button>
              </label>)}
              <p className="text-[11px] text-[#8a8780]">先保存费用上限，再开启对应开关。保存预算不会自动开启。</p>
            </div>
            {settings.current_window?.requires_normal_rotation && <p role="status" className="mt-3 text-[12px] text-[#a4552f]">当前聊天窗口尚不能使用预约工具，下次正常换窗后生效。这里仍可管理预约。</p>}
            {settings.current_window?.wake_manage_available === true && <p className="mt-2 text-[12px] text-[#8a8780]">当前聊天窗口可使用自主预约工具。</p>}
            {openRun && (
              <div className="mt-3 flex items-center justify-between rounded-2xl bg-[#f3f1ea] px-3 py-2 text-[12.5px]">
                <span>当前运行：{openRun.kind === 'keepwarm' ? '心跳保温' : '自主唤醒'} · {String(openRun.state)}</span>
                <button className="text-[#a4552f]" disabled={busy} onClick={() => void stopRun(openRun.id)}>停止</button>
              </div>
            )}
            <div className="mt-4">
              <h3 className="mb-2 text-[13px] font-medium text-[#8a8780]">预约任务（已加载 {tasks?.length ?? 0}{taskCursor ? '，还有更多' : ''}）</h3>
              <div className="space-y-1.5">
                {(tasks ?? []).map((t) => (
                  <button key={t.task_id} className="block w-full rounded-2xl border border-black/5 bg-white px-3 py-2 text-left" onClick={() => void openDetail(t.task_id)}>
                    <span className="flex items-center justify-between">
                      <span className="truncate text-[13px]">{t.note_preview || '（预约）'}</span>
                      <span className="ml-2 shrink-0 text-[11px] text-[#8a8780]">{t.status === 'scheduled' ? fmtTime(t.scheduled_at) : backgroundTaskStatus[t.status] ?? t.status}</span>
                    </span>
                  </button>
                ))}
                {(tasks ?? []).length === 0 && <p className="px-1 text-[12.5px] text-[#8a8780]">暂无预约。char可用 wake_manage 工具自己预约；这里也可代为创建。</p>}
              </div>
              {taskCursor && <button className="mt-2 text-[12px] text-[#a4552f]" disabled={busy} onClick={() => void loadMore('tasks')}>加载更多预约</button>}
            </div>
            <div className="mt-4 rounded-2xl border border-black/5 bg-white p-3">
              <h3 className="mb-2 text-[13px] font-medium text-[#8a8780]">替他预约（北京时间）</h3>
              <textarea className="mb-2 w-full rounded-xl border border-black/10 p-2 text-[13px]" rows={2} placeholder="要转告他的话（到期原样递给他自己）" value={wakeNote} onChange={(e) => setWakeNote(e.target.value)} />
              <div className="flex items-center gap-2">
                <input aria-label="预约时间（北京时间）" type="datetime-local" className="min-w-0 flex-1 rounded-xl border border-black/10 p-2 text-[13px]" value={wakeAt} onChange={(e) => setWakeAt(e.target.value)} />
                <button className="rounded-xl bg-[#c96442] px-3 py-2 text-[13px] text-white disabled:opacity-50" disabled={busy || settings.autonomous?.enabled !== true} onClick={() => void createWake()}>预约</button>
              </div>
              {settings.autonomous?.enabled !== true && <p className="mt-1.5 text-[11.5px] text-[#a4552f]">自主预约唤醒未开启——先开上面的开关。</p>}
            </div>
            {detail && (
              <div className="mt-3 rounded-2xl border border-black/10 bg-white p-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-medium">预约详情</h3>
                  <button aria-label="关闭详情" onClick={() => setDetail(null)}>×</button>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[13px]">{String(detail.note ?? '')}</p>
                <p className="mt-1 text-[11.5px] text-[#8a8780]">北京时间 {fmtTime(detail.scheduled_at)} · {backgroundTaskStatus[detail.status] ?? String(detail.status)}</p>
                {detail.kind === 'autonomous' && ['scheduled', 'needs_review'].includes(detail.status) && <div className="mt-3 space-y-2">
                  <textarea aria-label="修改预约内容" className="w-full rounded-xl border border-black/10 p-2 text-[13px]" rows={3} value={editNote} onChange={(e) => setEditNote(e.target.value)} />
                  <input aria-label="修改预约时间（北京时间）" type="datetime-local" className="w-full rounded-xl border border-black/10 p-2 text-[13px]" value={editAt} onChange={(e) => setEditAt(e.target.value)} />
                  <div className="flex gap-4 text-[12.5px] text-[#a4552f]"><button disabled={busy || settings.autonomous?.enabled !== true} onClick={() => void updateTask()}>保存修改</button><button disabled={busy} onClick={() => void cancelTask(detail)}>取消预约</button></div>
                </div>}
              </div>
            )}
            <div className="mt-4">
              <h3 className="mb-2 text-[13px] font-medium text-[#8a8780]">最近运行</h3>
              <div className="space-y-1">
                {(runs ?? []).map((r) => (
                  <p key={String(r.id)} className="flex items-center justify-between text-[12px] text-[#8a8780]">
                    <span>{r.trigger_origin === 'self_wake' ? '自主唤醒' : r.trigger_origin === 'keepwarm' ? '心跳' : '提醒'} · {String(r.state)}{r.retention === 'ephemeral_ack' ? '（纯维护回执）' : ''}</span>
                    <span>{fmtTime(r.first_dispatch_started_at ?? r.created_at)}{r.known_cost_micro_usd ? ` · $${(r.known_cost_micro_usd / 1e6).toFixed(4)}` : ''}{Number(r.unknown_cost_count) > 0 ? ` · ${r.unknown_cost_count} 笔待核实` : ''}</span>
                  </p>
                ))}
                {(runs ?? []).length === 0 && <p className="px-1 text-[12.5px] text-[#8a8780]">暂无运行记录。</p>}
              </div>
              {runCursor && <button className="mt-2 text-[12px] text-[#a4552f]" disabled={busy} onClick={() => void loadMore('runs')}>加载更多运行</button>}
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-[#8a8780]">心跳的纯“1”维护回执不进入聊天与记忆。他正式发出的消息会保存到聊天；工具记录与内部回复不会自动当作发给你的消息。</p>
          </>
        )}
      </div>
    </div>
  )
}
