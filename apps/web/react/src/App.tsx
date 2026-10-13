import { useEffect, useRef, useState } from 'react'
import { useEstomago } from './useEstomago'
import { useChatScroll, useMobileViewport } from './useMobileChat'
import { IntegrationControls } from './IntegrationControls'
import type { ChatMessage as Msg, WorkItem, ActivityItem } from './chat-client'
import {
  Phone, MoreHorizontal, ChevronDown, ChevronLeft, Check, Heart, ListChecks, Copy, Pencil,
  Plus, Image, Camera, FileText, Archive, Mic, ArrowUp, Wrench, Sparkle, Play, Pause, LayoutGrid, Footprints, X,
} from 'lucide-react'

function DotSpinner() {
  return (
    <span className="relative inline-block h-3.5 w-3.5 dotspin">
      {Array.from({ length: 8 }).map((_, i) => (
        <span key={i} className="absolute left-1/2 top-1/2 h-[3px] w-[3px] rounded-full bg-[#c96442]"
          style={{ opacity: (i + 1) / 8, transform: `rotate(${i * 45}deg) translate(5px) translate(-50%,-50%)` }} />
      ))}
    </span>
  )
}

function IconBtn({ children, onClick, title }: { children: React.ReactNode; onClick?: () => void; title?: string }) {
  return (
    <button onClick={onClick} aria-label={title} className="rounded-md p-1.5 text-[#8a8780] transition hover:bg-black/5 hover:text-[#3d3929]">
      {children}
    </button>
  )
}

function Thinking({ m, onStop }: { m: Msg; onStop?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-2 -ml-[13px]">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[13px] text-[#8a8780] hover:text-[#3d3929]">
        {m.pending ? <DotSpinner /> : <Sparkle size={14} />}
        <span>thinking · {m.pending ? '思考中' : (m.thinkSecs == null ? '—' : `${m.thinkSecs}s`)}</span>
        <ChevronLeft size={14} className={`transition-transform ${open ? '-rotate-90' : ''}`} />
      </button>
      {open && m.steps && (
        <div className="mt-2 ml-[6px]">
          {m.steps.map((s, i) => (
            <div key={i} className="relative flex gap-3 pb-3">
              {i < m.steps!.length - 1 && <span className="absolute left-[5px] top-4 bottom-0 w-px bg-[#dcd8cc]" />}
              <span className="mt-[5px] flex h-[11px] w-[11px] shrink-0 items-center justify-center rounded-full border border-[#c9c4b6] bg-[#faf9f5]">
                {s.kind === 'tool' && <span className="h-[5px] w-[5px] rounded-full bg-[#c96442]" />}
              </span>
              <p className={`text-[13.5px] leading-[1.55] text-[#8a8780] ${s.kind === 'tool' ? 'flex items-center gap-1 font-mono text-[12.5px]' : 'font-claude'}`}>
                {s.kind === 'tool' && <Wrench size={12} />}{s.text}
              </p>
            </div>
          ))}
          {onStop && <button onClick={onStop} className="ml-2 text-[12px] text-[#8a8780]">停止</button>}
        </div>
      )}
    </div>
  )
}

function EffortSlider({ value, onChange, levels }: { value: number; onChange: (v: number) => void; levels: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const H = 108
  const pick = (y: number) => {
    const r = ref.current!.getBoundingClientRect()
    const t = 1 - Math.min(1, Math.max(0, (y - r.top - 11) / (r.height - 22)))
    onChange(Math.round(t * Math.max(0, levels.length - 1)))
  }
  const pos = (i: number) => 11 + (1 - i / Math.max(1, levels.length - 1)) * (H - 22)
  return (
    <div className="flex items-stretch gap-2">
      <div ref={ref} role="slider" aria-label="思考等级" aria-valuenow={value} aria-valuemin={0} aria-valuemax={Math.max(0, levels.length - 1)}
        className="relative w-[22px] cursor-pointer touch-none rounded-full bg-[#efece4]" style={{ height: H }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e.clientY) }}
        onPointerMove={(e) => e.buttons && pick(e.clientY)}>
        <div className="absolute inset-x-0 bottom-0 rounded-full bg-gradient-to-t from-[#c96442] to-[#e0997c] transition-all duration-200"
          style={{ height: H - pos(value) + 11 }} />
        {levels.map((_, i) => (
          <span key={i} className={`absolute left-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full ${i <= value ? 'bg-white/70' : 'bg-[#cfcabd]'}`} style={{ top: pos(i) }} />
        ))}
        <span className="absolute left-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,.25)] transition-all duration-200" style={{ top: pos(value) }} />
      </div>
      <div className="relative w-9 text-[11px]" style={{ height: H }}>
        {levels.map((e, i) => (
          <button key={e} onClick={() => onChange(i)} className={`absolute left-0 -translate-y-1/2 transition ${i === value ? 'font-medium text-[#c96442]' : 'text-[#a3a099]'}`} style={{ top: pos(i) }}>{e}</button>
        ))}
      </div>
    </div>
  )
}

const BARS = [4, 9, 14, 8, 16, 11, 6, 13, 18, 10, 7, 15, 12, 5, 9, 14, 8, 11, 6, 4]
function VoiceBar({ dur, text, ai, src }: { dur?: number; text: string; ai?: boolean; src?: string }) {
  const [play, setPlay] = useState(false)
  const [t, setT] = useState(0)
  const [duration, setDuration] = useState<number | null>(dur ?? null)
  const [failed, setFailed] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  useEffect(() => { const audio = audioRef.current; return () => { audio?.pause() } }, [src])
  const togglePlay = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (!audio.paused) audio.pause()
    else { try { await audio.play() } catch { setFailed(true) } }
  }
  const prog = duration ? t / duration : 0
  const bars = Array.from({ length: Math.min(28, 8 + Math.round((duration ?? 6) * 0.7)) }, (_, i) => BARS[i % BARS.length])
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (shown >= text.length) return
    const id = setTimeout(() => setShown((v) => v + 1), 35)
    return () => clearTimeout(id)
  }, [shown, text])
  return (
    <div className={`flex max-w-full flex-col gap-1.5 ${ai ? 'items-start' : 'items-end'}`}>
    <audio hidden ref={audioRef} src={src} preload="metadata"
      onLoadedMetadata={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)}
      onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onPlay={() => setPlay(true)} onPause={() => setPlay(false)}
      onEnded={() => { setPlay(false); setT(0) }} onError={() => setFailed(true)} />
    <button onClick={() => void togglePlay()} className="flex max-w-full shrink-0 items-center gap-2.5 rounded-full bg-[#f0ede5] py-1.5 pl-1.5 pr-4">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white ${ai ? 'bg-[#3d3929]' : 'bg-[#c96442]'}`}>
        {play ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" className="ml-0.5" />}
      </span>
      <span className="flex h-[18px] items-center gap-[2px] overflow-hidden">
        {bars.map((h, i) => (
          <span key={i} className={`w-[2.5px] shrink-0 rounded-full transition-colors ${i / bars.length < prog ? (ai ? 'bg-[#3d3929]' : 'bg-[#c96442]') : 'bg-[#b9b4a7]'}`} style={{ height: h }} />
        ))}
      </span>
      <span className="shrink-0 whitespace-nowrap text-[12px] tabular-nums text-[#5e5d59]">{failed ? '暂不可用' : duration == null ? '…' : `${Math.ceil(duration)}″`}</span>
    </button>
    {text && (
      <p className={`max-w-full break-words text-[13.5px] leading-[1.55] text-[#8a8780] ${ai ? 'pl-1' : 'pr-1 text-right'}`}>
        {text.slice(0, shown)}{shown < text.length && <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-[#8a8780] align-middle" />}
      </p>
    )}
    </div>
  )
}

function Sheet({ kind, onClose, workbench, activity, note, alerts, markRead }: { kind: 'bench' | 'log'; onClose: () => void; workbench: WorkItem[]; activity: ActivityItem[]; note: string; alerts: Array<Record<string, any>>; markRead: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/25" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="sheet-in max-h-[75dvh] w-full overflow-y-auto rounded-t-3xl bg-[#faf9f5] px-5 pt-3 pb-[max(env(safe-area-inset-bottom),24px)] no-bar">
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-black/15" />
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-[17px] font-medium">{kind === 'bench' ? '工作台' : '活动日志'}</h2>
          <IconBtn title="关闭" onClick={onClose}><X size={18} /></IconBtn>
        </div>
        <p className="mb-4 text-[13px] text-[#8a8780]">{kind === 'bench' ? 'char给你做的小东西存档点' : '自动唤醒后char的足迹'}</p>
        {note && <p className="mb-4 text-[13px] text-[#8a8780]">{note}</p>}
        {kind === 'bench' ? (
          <div className="grid grid-cols-2 gap-3">
            {workbench.map((w) => (
              <div key={w.id} onClick={() => { if (w.href) window.open(w.href, '_blank', 'noopener') }} className="rounded-2xl bg-white p-3.5 ring-1 ring-black/5">
                <div className="mb-6 h-8 w-8 rounded-lg bg-[#f3e6df]">{w.icon && <img src={w.icon} alt="" className="h-full w-full object-contain" />}</div>
                <p className="text-[14px] font-medium leading-snug">{w.t}</p>
                <p className="mt-0.5 text-[12px] text-[#8a8780]">{w.d}</p>
                <p className="mt-2 text-[11px] text-[#b3afa5]">{w.at}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="pl-1">
            {alerts.map((alert) => <p key={alert.alert_id} className="mb-3 text-[13px] text-[#8a8780]">{alert.safe_summary?.title || alert.code}</p>)}
            {alerts.length > 0 && <button className="mb-3 text-[13px] text-[#c96442]" onClick={markRead}>标为已读</button>}
            {activity.map((a, i) => (
              <div key={a.id} className="relative flex gap-3 pb-5">
                {i < activity.length - 1 && <span className="absolute left-[4.5px] top-3 bottom-0 w-px bg-[#dcd8cc]" />}
                <span className="mt-[6px] h-[10px] w-[10px] shrink-0 rounded-full border-2 border-[#c96442] bg-[#faf9f5]" />
                <div className="flex-1">
                  <div className="flex items-baseline justify-between"><p className="text-[14px] font-medium">{a.t}</p><span className="text-[12px] tabular-nums text-[#a3a099]">{a.at}</span></div>
                  <p className="text-[13px] text-[#8a8780]">{a.d}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Media({ m, ai }: { m: Msg; ai?: boolean }) {
  if (m.media && m.media.length > 1) return <div className="flex flex-col gap-1.5">{m.media.map((item, i) => <Media key={item.src} ai={ai} m={{...m, media: undefined, kind: item.kind, src: item.src, text: i === 0 ? m.text : item.text || ''}} />)}</div>
  if (m.kind === 'voice') return <VoiceBar dur={m.dur} text={m.text} ai={ai} src={m.src} />
  return (
    <div className={`flex max-w-full flex-col gap-1.5 ${ai ? 'items-start' : 'items-end'}`}>
      <img src={m.src} alt={m.text || '图片'} className="max-h-64 w-full max-w-60 rounded-2xl object-cover ring-1 ring-black/5" />
      {m.text && <p className={`text-[15px] leading-[1.6] text-[#1f1e1d] ${ai ? 'font-claude' : ''}`}>{m.text}</p>}
    </div>
  )
}

export default function App() {
  const { client, state, rec, recSecs, startRec, stopRec, onPick, copy } = useEstomago()
  const msgs = state.messages
  const model = state.model
  const effort = state.effort
  const MODELS = state.models
  const EFFORTS = state.efforts.map((e) => e === 'medium' ? 'med' : e === 'default' ? '默认' : e)
  const setModel = (i: number) => { if (i !== model && window.confirm('切换模型后，下一次发送前可选择携带的历史。确认切换？')) void client.setModel(i) }
  const setEffort = (i: number) => { void client.setEffort(i) }
  const [menu, setMenu] = useState(false)
  const [plus, setPlus] = useState(false)
  const [ctxOpen, setCtxOpen] = useState(false)
  const [more, setMore] = useState(false)
  const [sheet, setSheet] = useState<null | 'bench' | 'log'>(null)
  const input = state.draft
  const setInput = client.setDraft
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const appRef = useMobileViewport()
  const { scrollRef, contentRef, followLatest } = useChatScroll(msgs)
  const used = state.context.used
  const limit = state.context.limit
  const pct = used != null && limit ? Math.min(1, used / limit) : 0
  const send = () => { followLatest(); void client.send() }
  const selectMessage = (id: string) => client.select(id)
  const editMessage = (id: string) => { const next = window.prompt('编辑消息', client.originalText(id)); if (next !== null) void client.editMessage(id, next) }
  useEffect(() => {
    if (sheet) { void client.loadPanel(sheet); if (sheet === 'log') void client.loadAlerts() }
  }, [sheet, client])
  useEffect(() => {
    if (ctxOpen) void client.loadContext()
  }, [ctxOpen, client])
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = '24px'
    el.style.height = Math.min(120, el.scrollHeight) + 'px'
  }, [input])
  return (
    <div ref={appRef} className="chat-app flex w-full overflow-hidden flex-col bg-[#faf9f5]">
      {/* Header */}
      <header className="relative z-20 shrink-0 border-b border-black/5 pb-2">
        <div className="flex items-center justify-between pl-5 pr-3">
          <h1 contentEditable suppressContentEditableWarning spellCheck={false}
            className="text-[17px] font-medium tracking-tight outline-none focus:bg-black/5">宇宙发明小机</h1>
          <div className="flex">
            <IconBtn title="电话" onClick={() => client.notify('实时语音通话暂未接入')}><Phone size={18} /></IconBtn>
            <div className="relative">
              <IconBtn title="更多" onClick={() => setMore(!more)}><MoreHorizontal size={18} /></IconBtn>
              {more && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMore(false)} />
                  <div className="pop-in absolute right-0 top-9 z-40 w-52 rounded-2xl border border-black/10 bg-white p-1 shadow-xl">
                    {([['bench', LayoutGrid, '工作台', 'char给我做的小东西'], ['log', Footprints, '活动日志', '自动唤醒后的足迹']] as const).map(([k, I, t, d]) => (
                      <button key={k} onClick={() => { setSheet(k); setMore(false) }} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-[#f3f1ea]">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#f3e6df] text-[#c96442]"><I size={16} /></span>
                        <span><span className="block text-[14px]">{t}</span><span className="block text-[11.5px] text-[#8a8780]">{d}</span></span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="relative flex justify-center">
          <button onClick={() => setMenu(!menu)} className="relative rounded-lg px-2 py-1 text-[13px] text-[#5e5d59] hover:bg-black/5">
            char · {MODELS[model]} · {EFFORTS[effort]}
            <ChevronDown size={13} className="absolute -right-3 top-1/2 -translate-y-1/2" />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0" onClick={() => setMenu(false)} />
              <div className="pop-in absolute top-9 z-30 flex items-center gap-1 rounded-2xl border border-black/10 bg-white py-1 pl-1 pr-2.5 shadow-xl">
                <div>
                  {MODELS.map((m, i) => (
                    <button key={m} onClick={() => setModel(i)} className={`flex h-9 w-full items-center gap-2 rounded-xl pl-2.5 pr-2 text-[14px] ${i === model ? 'bg-[#f3f1ea]' : 'hover:bg-[#f7f5ef]'}`}>
                      <span className="flex-1 text-left">{m}</span>
                      <Check size={14} className={i === model ? 'text-[#c96442]' : 'invisible'} />
                    </button>
                  ))}
                </div>
                <span className="mx-1 h-20 w-px bg-black/5" />
                <EffortSlider value={effort} onChange={setEffort} levels={EFFORTS} />
              </div>
            </>
          )}
        </div>
      </header>

      {/* Messages */}
      <main ref={scrollRef} className="no-bar min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-5">
        <div ref={contentRef} className="flow-root">
        {state.hasEarlier && <button className="mx-auto mb-4 block text-[12px] text-[#8a8780]" onClick={() => void client.loadEarlier()}>加载更早</button>}
        {msgs.map((m) => m.system ? <p key={m.id} role="status" className="mx-5 mb-4 text-center text-[12px] text-[#8a8780]">{m.text}</p> : m.role === 'user' ? (
          <div key={m.id} className="mb-8 ml-auto flex w-[75%] flex-col items-end pr-[2em]">
            {m.kind ? <Media m={m} /> : <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.6] tracking-[0.01em] text-[#1f1e1d]">{m.text}</p>}
            <div className="mt-1 -mr-1.5 flex items-center">
              <IconBtn title="戳一戳" onClick={() => client.notify('戳一戳服务暂未接入')}><Heart size={15} /></IconBtn>
              <IconBtn title={state.selected.has(m.id) ? '已选择' : '多选'} onClick={() => selectMessage(m.id)}><ListChecks size={15} /></IconBtn>
              <IconBtn title="复制" onClick={() => void copy(m.text)}><Copy size={15} /></IconBtn>
              <IconBtn title="编辑" onClick={() => editMessage(m.id)}><Pencil size={15} /></IconBtn>
              <span className="ml-1.5 text-[12px] tabular-nums text-[#a3a099]">{m.time}</span>
            </div>
          </div>
        ) : (
          <div key={m.id} className="mb-8 w-[75%] pl-[2em]">
            <Thinking m={m} onStop={(m.pending || m.streaming) && m.turnId ? () => void client.stopTurn(m.turnId!) : undefined} />
            {!m.pending && (
              <>
                {m.kind ? <Media m={m} ai /> : (
                <div className="font-claude break-words space-y-3 text-[15.5px] leading-[1.6] tracking-[-0.003em] text-[#1f1e1d]">
                  {m.text.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
                </div>
                )}
                <div className="mt-2 -ml-1.5 flex items-center">
                  <span className="mx-1.5 text-[12px] tabular-nums text-[#a3a099]">{m.time}</span>
                  <span className="mr-1 text-[12px] tabular-nums text-[#a3a099]">{m.tokens == null ? '' : `约 ${m.tokens.toLocaleString()}`}</span>
                  <IconBtn title={state.selected.has(m.id) ? '已选择' : '多选'} onClick={() => selectMessage(m.id)}><ListChecks size={15} /></IconBtn>
                  <IconBtn title="复制" onClick={() => void copy(m.text)}><Copy size={15} /></IconBtn>
                  <IconBtn title="戳一戳" onClick={() => client.notify('戳一戳服务暂未接入')}><Heart size={15} /></IconBtn>
                </div>
              </>
            )}
          </div>
        ))}
        </div>
      </main>

      <IntegrationControls client={client} state={state} />
      {/* Composer */}
      <footer className="relative shrink-0 px-3 pt-2">
        {state.attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2 text-[12px] text-[#8a8780]">{state.attachments.map(a => <div key={a.id} className="flex items-center gap-1">
          <button onClick={() => { if (a.status === 'failed') void client.retryAttachment(a.id) }}>{a.name} · {{ready:'待发送',uploading:'上传中',transcribing:'转写中',failed:'失败，点击重试',uncertain:'结果未确认'}[a.status]}</button>
          <button aria-label="移除附件" onClick={() => client.removeAttachment(a.id)}>×</button>
        </div>)}</div>}
        <div className="flex items-center gap-2">
          <div className="relative shrink-0">
          {plus && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setPlus(false)} />
              <div className="pop-up absolute bottom-[54px] left-0 z-40 flex gap-1 rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl">
                {([[Image, '相册'], [Camera, '拍照'], [FileText, '文件'], [Archive, '存档读取']] as const).map(([I, l]) => (
                  <button key={l} aria-label={l} onClick={() => (l === '相册' || l === '文件' ? fileRef.current?.click() : l === '拍照' ? camRef.current?.click() : (setPlus(false), client.beginSelection()))} className="flex h-11 w-11 items-center justify-center rounded-xl text-[#3d3929] hover:bg-[#f3f1ea]">
                    <I size={20} />
                  </button>
                ))}
                <span className="absolute -bottom-[6px] left-[14px] h-3 w-3 rotate-45 border-b border-r border-black/10 bg-white" />
              </div>
            </>
          )}
          <button onClick={() => setPlus(!plus)} aria-label="更多功能"
            className={`relative z-40 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-black/10 bg-white text-[#5e5d59] transition ${plus ? 'rotate-45' : ''}`}>
            <Plus size={20} />
          </button>
          </div>
          <div className="relative flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-full border border-black/10 bg-white pl-2 pr-1.5 shadow-sm">
            <button onClick={() => setCtxOpen(!ctxOpen)} aria-label="上下文用量" className="p-1">
              <svg width="20" height="20" viewBox="0 0 20 20" className="-rotate-90">
                <circle cx="10" cy="10" r="7.5" fill="none" stroke="#e6e2d8" strokeWidth="2.5" />
                <circle cx="10" cy="10" r="7.5" fill="none" stroke="#3d3929" strokeWidth="2.5" strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 7.5} strokeDashoffset={2 * Math.PI * 7.5 * (1 - pct)} />
              </svg>
            </button>
            {ctxOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setCtxOpen(false)} />
                <div className="absolute bottom-14 left-0 z-20 w-56 rounded-xl border border-black/10 bg-white p-3 text-[12.5px] shadow-xl">
                  <p className="mb-2 font-medium">上下文窗口</p>
                  {[['已用', `${used?.toLocaleString() ?? '未知'} tokens`], ['上限', `${limit?.toLocaleString() ?? '未知'} tokens`], ['占比', used != null && limit ? `${(pct * 100).toFixed(1)}%` : '未知'],
                    ['缓存读取', state.context.cacheRead == null ? '未知' : `${state.context.cacheRead} tokens`], ['模型', MODELS[model]], ['思考等级', EFFORTS[effort]]].map(([k, v]) => (
                    <div key={k} className="flex justify-between py-0.5"><span className="text-[#8a8780]">{k}</span><span className="tabular-nums">{v}</span></div>
                  ))}
                </div>
              </>
            )}
            <button aria-label="语音" onClick={() => (rec === null ? startRec() : stopRec(true))}
              className={`p-1 ${rec === null ? 'text-[#5e5d59]' : 'text-[#c96442]'}`}><Mic size={18} /></button>
            {rec !== null ? (
              <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-[14px] text-[#5e5d59]">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[#d94a3a]" />
                <span className="tabular-nums">0:{String(recSecs).padStart(2, '0')}</span>
                <span className="flex flex-1 items-center gap-[2px] overflow-hidden">
                  {BARS.map((h, i) => <span key={i} className="w-[2px] animate-pulse rounded-full bg-[#c96442]/60" style={{ height: h * 0.8, animationDelay: `${i * 60}ms` }} />)}
                </span>
                <button onClick={() => stopRec(false)} aria-label="取消" className="text-[#a3a099]"><X size={16} /></button>
              </div>
            ) : <textarea ref={composerRef} rows={1} value={input} onChange={(e) => setInput(e.target.value)} title={state.draftEstimate ? `正文预计 ${state.draftEstimate.message_text_tokens ?? '未知'} token（粗估）` : undefined}
              onCompositionStart={() => client.setComposing(true)} onCompositionEnd={() => client.setComposing(false)}
              placeholder="回复…" className="min-w-0 flex-1 resize-none bg-transparent px-1 text-[16px] outline-none placeholder:text-[#a3a099]" />}
            <button onClick={() => (rec !== null ? stopRec(true) : send())} aria-label="发送" disabled={rec === null && !client.canSend} onPointerDown={(e) => e.preventDefault()}
              className="group flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full text-white">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#c96442] transition group-disabled:bg-[#e6c2b4]"><ArrowUp size={17} /></span>
            </button>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { setPlus(false); onPick(e.target.files?.[0]); e.target.value = '' }} />
        <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = '' }} />
      </footer>
      {sheet && <Sheet kind={sheet} onClose={() => setSheet(null)} workbench={state.workbench} activity={state.activity} note={state.panelNote} alerts={state.alerts} markRead={() => void client.markAlertsRead()} />}
    </div>
  )
}
