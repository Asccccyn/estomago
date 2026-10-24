import { Fragment, useEffect, useRef, useState } from 'react'
import { shouldSendOnKeydown } from '../../src/composer-logic.js'
import { useEstomago } from './useEstomago'
import { useChatScroll, useMobileViewport } from './useMobileChat'
import { IntegrationControls } from './IntegrationControls'
import { BackgroundControls } from './BackgroundControls'
import { SelectionCheck, SelectionMediaText, SelectionBar } from './SelectionControls'
import { SystemAlertsButton, SystemAlertsPanel } from './SystemAlerts'
import { CallPanel } from './CallPanel'
import { CallInvites } from './CallInvites'
import { SurfacedMemories } from './SurfacedMemories'
import { InlineMessageEditor } from './InlineMessageEditor'
import { BackToLatestDot, HistoryBoundary, HistoryDatePicker } from './ChatHistoryControls'
import type { ChatMessage as Msg, WorkItem, ActivityItem } from './chat-client'
import {
  Phone, MoreHorizontal, ChevronDown, ChevronLeft, Check, Heart, ListChecks, Copy, Pencil,
  Plus, Image, Camera, FileText, Archive, Mic, ArrowUp, Wrench, Sparkle, Play, Pause, LayoutGrid, Footprints, RotateCcw, X, AlarmClock,
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

function IconBtn({ children, onClick, title, disabled }: { children: React.ReactNode; onClick?: () => void; title?: string; disabled?: boolean }) {
  return (
    <button onClick={onClick} aria-label={title} disabled={disabled} className="rounded-md p-1.5 text-[#8a8780] transition hover:bg-black/5 hover:text-[#3d3929] disabled:opacity-40">
      {children}
    </button>
  )
}

function Thinking({ m, onStop, onExpand }: { m: Msg; onStop?: () => void; onExpand?: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const readDetails = () => {
    if (!onExpand || loading) return
    setLoading(true); setLoadError(false)
    void onExpand().catch(() => setLoadError(true)).finally(() => setLoading(false))
  }
  const toggle = () => {
    setOpen(!open)
    if (!open) readDetails()
  }
  return (
    <div className="mb-2 -ml-[13px]">
      <button onClick={toggle} aria-expanded={open} className="flex items-center gap-1.5 text-[13px] text-[#8a8780] hover:text-[#3d3929]">
        {m.pending ? <DotSpinner /> : <Sparkle size={14} />}
        <span>{m.pending ? 'thinking · 思考中' : m.thinkSecs == null ? '思考过程' : `thinking · ${m.thinkSecs}s`}</span>
        <ChevronLeft size={14} className={`transition-transform ${open ? '-rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-2 ml-[6px]">
          {loading && <p role="status" className="mb-2 text-[12px] text-[#8a8780]">正在读取思考过程…</p>}
          {!loading && loadError && <button type="button" onClick={readDetails} className="mb-2 text-[12px] text-[#a54b35]">思考过程读取失败 · 点击重试</button>}
          {!loading && !loadError && !m.steps?.length && <p className="mb-2 text-[12px] text-[#8a8780]">暂无可读摘要</p>}
          {m.steps?.map((s, i) => (
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
  const H = Math.max(108, 22 + (levels.length - 1) * 24)
  const pick = (y: number) => {
    const r = ref.current!.getBoundingClientRect()
    const t = 1 - Math.min(1, Math.max(0, (y - r.top - 11) / (r.height - 22)))
    onChange(Math.round(t * Math.max(0, levels.length - 1)))
  }
  const pos = (i: number) => 11 + (1 - i / Math.max(1, levels.length - 1)) * (H - 22)
  return (
    <div className="flex items-stretch gap-2">
      <div ref={ref} role="slider" aria-label="思考等级" aria-valuenow={value >= 0 ? value : undefined} aria-valuetext={value >= 0 ? levels[value] : '未选择，使用默认设置'} aria-valuemin={0} aria-valuemax={Math.max(0, levels.length - 1)}
        className="relative w-[22px] cursor-pointer touch-none rounded-full bg-[#efece4]" style={{ height: H }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e.clientY) }}
        onPointerMove={(e) => e.buttons && pick(e.clientY)}>
        <div className="absolute inset-x-0 bottom-0 rounded-full bg-gradient-to-t from-[#c96442] to-[#e0997c] transition-all duration-200"
          style={{ height: value >= 0 ? H - pos(value) + 11 : 0 }} />
        {levels.map((_, i) => (
          <span key={i} className={`absolute left-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full ${i <= value ? 'bg-white/70' : 'bg-[#cfcabd]'}`} style={{ top: pos(i) }} />
        ))}
        {value >= 0 && <span className="absolute left-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,.25)] transition-all duration-200" style={{ top: pos(value) }} />}
      </div>
      <div className="relative w-14 whitespace-nowrap text-[11px]" style={{ height: H }}>
        {levels.map((e, i) => (
          <button key={e} aria-pressed={i === value} title={i === value ? '再次点击取消选择' : undefined} onClick={() => onChange(i === value ? -1 : i)} className={`absolute left-0 -translate-y-1/2 transition ${i === value ? 'font-medium text-[#c96442]' : 'text-[#a3a099]'}`} style={{ top: pos(i) }}>{e}</button>
        ))}
      </div>
    </div>
  )
}

// V06 深听逐字谱（2026-10-24）：按页读 prosody_page（每页≤32音节），带 next_cursor 续读。
// 只展示可测声学量（半音/中音域参照）——不做情绪解读；每音节≤5 F0 点按合同渲染。
function ProsodyPages({ analysisId }: { analysisId: string }): React.JSX.Element | null {
  const [pages, setPages] = useState<Array<{ syllable: string; tone: string | null; f0: number[]; startS: number }[]>>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setPages([]); setCursor(undefined); setDone(false); setError(null) }, [analysisId])
  const loadMore = async (): Promise<void> => {
    if (loading || done) return
    setLoading(true)
    try {
      const res = await fetch('/api/v1/oido/analyses/' + encodeURIComponent(analysisId) + '/prosody' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''))
      if (!res.ok) { const b = await res.json().catch(() => ({})) as Record<string, any>; setError(String(b['error_code'] ?? b['detail'] ?? '不可用')); setDone(true); return }
      const body = await res.json() as Record<string, any>
      const syllables = (body['syllables'] ?? []) as Array<Record<string, any>>
      setPages((prev) => [...prev, syllables.map((x) => ({
        syllable: String(x['text'] ?? '?'),
        tone: x['tone'] == null ? null : String(x['tone']),
        f0: (Array.isArray(x['f0_st']) ? x['f0_st'] : []).map(Number),
        startS: Number(x['start_s'] ?? 0),
      }))])
      if (typeof body['next_cursor'] === 'string' && body['next_cursor']) setCursor(body['next_cursor'])
      else { setCursor(undefined); setDone(true) }
    } catch { setError('请求失败'); setDone(true) } finally { setLoading(false) }
  }
  if (error && pages.length === 0) return <p className="text-[11px] text-[#a05a4a]">逐字谱：{error}</p>
  if (pages.length === 0 && !loading && !done) {
    return (
      <button onClick={() => void loadMore()} className="self-start rounded-full bg-white/60 px-2.5 py-0.5 text-[11px] text-[#5e5d59]">看逐字谱</button>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {pages.flat().map((sy, i) => (
          <span key={i} className="flex w-8 flex-col items-center rounded-lg bg-white/70 py-1" title={`${sy.startS.toFixed(2)}s${sy.tone ? ' · 本调 ' + sy.tone : ''}`}>
            <span className="text-[13px] leading-none">{sy.syllable}</span>
            <span className="mt-0.5 flex h-6 w-6 items-end justify-center gap-[1px]">
              {sy.f0.slice(0, 5).map((v, j) => (
                <span key={j} className="w-[3px] rounded-full bg-[#c96442]" style={{ height: `${Math.max(3, Math.min(24, 6 + (v + 12)))}px`, opacity: 0.45 + (j / Math.max(1, sy.f0.length - 1)) * 0.55 }} />
              ))}
            </span>
          </span>
        ))}
      </div>
      {!done && <button disabled={loading} onClick={() => void loadMore()} className="self-start rounded-full bg-white/60 px-2.5 py-0.5 text-[11px] text-[#5e5d59] disabled:opacity-50">{loading ? '读取中…' : '下一页'}</button>}
      {error && pages.length > 0 && <p className="text-[11px] text-[#a05a4a]">续读：{error}</p>}
    </div>
  )
}

const BARS = [4, 9, 14, 8, 16, 11, 6, 13, 18, 10, 7, 15, 12, 5, 9, 14, 8, 11, 6, 4]
function VoiceBar({ dur, text, ai, src, assetId }: { dur?: number; text: string; ai?: boolean; src?: string; assetId?: string }) {
  // RE-15（2026-10-24 返修）：深听 UI 状态隔离——queued/409 不再显示成成功空卡；
  // 概览响应绑定发起时的 asset（消息修订换 v2 后，迟到的 v1 响应作废不挂新源）；
  // 收起再展开复用已有分析（查询），不重复发起新分析；卸载中止在途请求。
  const [listen, setListen] = useState<{ state: 'idle' | 'loading' | 'pending' | 'error' | 'ok'; analysisId?: string; overview?: Record<string, any>; error?: string }>({ state: 'idle' })
  const listenAsset = useRef<string | undefined>(undefined) // 当前 listen 状态归属的 asset
  const analysisCache = useRef<{ assetId: string; analysisId: string } | null>(null) // 该气泡已有分析（收起不丢）
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])
  const fetchOverview = async (analysisId: string, forAsset: string): Promise<void> => {
    const res = await fetch('/api/v1/oido/analyses/' + encodeURIComponent(analysisId))
    if (!aliveRef.current || forAsset !== assetId) return // 迟到/换源作废
    if (res.status === 409) { setListen({ state: 'pending', analysisId }); return } // 未就绪=待定，不是成功
    if (!res.ok) { const body = await res.json().catch(() => ({})) as Record<string, any>; setListen({ state: 'error', error: String(body['detail'] ?? body['code'] ?? '深听不可用') }); return }
    const ov = await res.json() as Record<string, any>
    if (!aliveRef.current || forAsset !== assetId) return
    setListen({ state: 'ok', analysisId, overview: ov })
  }
  const startListen = async () => {
    if (!assetId || listen.state === 'loading') return
    if (listen.state === 'ok' || listen.state === 'pending') { setListen({ state: 'idle' }); return }
    // 已有该资产的分析：展开=查询既有结果，不重新发起（查询与明确重新分析分开）
    if (analysisCache.current && analysisCache.current.assetId === assetId) {
      setListen({ state: 'loading' })
      try { await fetchOverview(analysisCache.current.analysisId, assetId) } catch { if (aliveRef.current) setListen({ state: 'error', error: '深听查询失败' }) }
      return
    }
    const forAsset = assetId
    listenAsset.current = forAsset
    setListen({ state: 'loading' })
    try {
      const res = await fetch('/api/v1/oido/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio_ref: 'est:' + assetId }) })
      const body = await res.json() as Record<string, any>
      if (!aliveRef.current || forAsset !== assetId) return
      const analysisId = body['analysis_id'] as string | undefined
      if (!res.ok || !analysisId) { setListen({ state: 'error', error: String(body['detail'] ?? body['error_code'] ?? '深听不可用') }); return }
      analysisCache.current = { assetId, analysisId }
      await fetchOverview(analysisId, forAsset)
    } catch (e) { if (aliveRef.current) setListen({ state: 'error', error: '深听请求失败' }) }
  }
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
    {assetId && (
      <div className={`flex max-w-full flex-col gap-1 ${ai ? 'items-start' : 'items-end'}`}>
        <button onClick={() => void startListen()} className="shrink-0 rounded-full bg-[#f0ede5] px-3 py-1 text-[12px] text-[#5e5d59]">
          {listen.state === 'loading' ? '深听中…' : listen.state === 'ok' ? '收起深听' : listen.state === 'pending' ? '收起（分析中）' : '深听'}
        </button>
        {listen.state === 'error' && <p className="max-w-72 break-words text-[12px] text-[#a05a4a]">深听不可用：{listen.error}</p>}
        {listen.state === 'pending' && <p className="max-w-72 text-[12px] text-[#8a8780]">分析进行中——稍后点"深听"查询结果（未就绪不当作成功）</p>}
        {listen.state === 'ok' && listen.analysisId && (
          <div className="flex max-w-80 flex-col gap-1.5 rounded-2xl bg-[#f0ede5] p-2.5">
            <img src={'/api/v1/oido/analyses/' + encodeURIComponent(listen.analysisId) + '/image'} alt="深听测量图" className="w-full rounded-xl bg-white" onError={(e) => { e.currentTarget.style.display = 'none' }} />
            <ul className="flex flex-col gap-0.5 text-[12px] leading-[1.5] text-[#5e5d59]">
              {(Array.isArray(listen.overview?.['observations']) ? listen.overview!['observations'] : []).slice(0, 6).map((o: Record<string, any>, i: number) => (
                <li key={i}>{String(o['kind'] ?? '观察')}：{o['value'] == null ? String(o['reason'] ?? '不可用') : `${o['value']}${o['unit'] ? ' ' + o['unit'] : ''}（${String(o['quality'] ?? '')}）`}</li>
              ))}
            </ul>
            {Array.isArray(listen.overview?.['limits']) && listen.overview!['limits'].length > 0 && (
              <p className="text-[11px] leading-[1.4] text-[#8a8780]">限制：{listen.overview!['limits'].map(String).join('；')}</p>
            )}
            <ProsodyPages analysisId={listen.analysisId} />
          </div>
        )}
      </div>
    )}
    </div>
  )
}

function Sheet({ kind, onClose, workbench, activity, note }: { kind: 'bench' | 'log'; onClose: () => void; workbench: WorkItem[]; activity: ActivityItem[]; note: string }) {
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

function Media({ m, ai, showText = true }: { m: Msg; ai?: boolean; showText?: boolean }) {
  if (m.media && m.media.length > 1) return <div className="flex flex-col gap-1.5">{m.media.map((item, i) => <Media key={item.src} ai={ai} showText={showText} m={{...m, media: undefined, kind: item.kind, src: item.src, text: i === 0 ? m.text : item.text || ''}} />)}</div>
  const voiceAssetId = m.src?.startsWith('/api/v1/assets/') ? decodeURIComponent(m.src.split('/')[4] ?? '') : ''
  if (m.kind === 'voice') return <VoiceBar dur={m.dur} text={showText ? m.text : ''} ai={ai} src={m.src} assetId={voiceAssetId} />
  return (
    <div className={`flex max-w-full flex-col gap-1.5 ${ai ? 'items-start' : 'items-end'}`}>
      <img src={m.src} alt={m.text || '图片'} className="max-h-64 w-full max-w-60 rounded-2xl object-cover ring-1 ring-black/5" />
      {showText && m.text && <p className={`text-[15px] leading-[1.6] text-[#1f1e1d] ${ai ? 'font-claude' : ''}`}>{m.text}</p>}
    </div>
  )
}

export default function App() {
  const { client, state, rec, recSecs, recPaused, startRec, stopRec, pauseRec, onPick, copy } = useEstomago()
  // JOINT-VOICE（04）：录音前暂停本应用全部语音播放——不把char外放录进去
  const previewAudio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    const stopPreview = () => {
      const audio = previewAudio.current
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); previewAudio.current = null }
    }
    window.addEventListener('pagehide', stopPreview)
    return () => { stopPreview(); window.removeEventListener('pagehide', stopPreview) }
  }, [])
  useEffect(() => {
    const audio = previewAudio.current
    if (audio && !state.attachments.some(a => a.assetId === audio.dataset.assetId)) {
      audio.pause(); audio.removeAttribute('src'); audio.load(); previewAudio.current = null
    }
  }, [state.attachments])
  const pauseAllVoice = () => {
    document.querySelectorAll('audio').forEach(el => el.pause())
    previewAudio.current?.pause()
  }
  const togglePreview = (assetId: string) => {
    let el = previewAudio.current
    if (el && !el.paused && el.dataset.assetId === assetId) { el.pause(); return }
    if (!el) { el = new Audio(); previewAudio.current = el; }
    el.dataset.assetId = assetId
    el.src = '/api/v1/assets/' + encodeURIComponent(assetId) + '/content'
    void el.play().catch(() => client.notify('试听失败，请稍后再试'))
  }
  const msgs = state.messages
  const model = state.model
  const effort = state.effort
  const MODELS = state.models
  const EFFORTS = state.efforts.map((e) => e === 'medium' ? 'med' : e)
  const setModel = (i: number) => { if (i !== model && window.confirm('切换模型后，下一次发送前可选择携带的历史。确认切换？')) void client.setModel(i) }
  const setEffort = (i: number) => { void client.setEffort(i) }
  const [menu, setMenu] = useState(false)
  const [plus, setPlus] = useState(false)
  const [ctxOpen, setCtxOpen] = useState(false)
  const [more, setMore] = useState(false)
  const [callOpen, setCallOpen] = useState(false)
  const [sheet, setSheet] = useState<null | 'bench' | 'log' | 'wake'>(null)
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [editing, setEditing] = useState<{ id: string; text: string; revision?: number; resend: boolean } | null>(null)
  const [historyAction, setHistoryAction] = useState<'earlier' | 'later' | 'date' | 'latest' | null>(null)
  const input = state.draft
  const setInput = client.setDraft
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const appRef = useMobileViewport()
  const loadEarlier = async () => {
    if (editing || state.selectionMode || state.historyLoading || state.loadingEarlier) return false
    preserveScroll(); setHistoryAction('earlier')
    return client.loadEarlier()
  }
  const loadLater = async () => {
    if (editing || state.selectionMode || state.historyLoading || state.loadingLater) return false
    setHistoryAction('later')
    return client.loadLater()
  }
  const jumpToDate = async (date: string) => {
    if (editing || state.selectionMode) return false
    setHistoryAction('date')
    return client.jumpToDate(date)
  }
  const returnToLatest = async () => {
    if (editing || state.selectionMode) return false
    setHistoryAction('latest')
    const loaded = await client.returnToLatest()
    if (loaded) followLatest()
    return loaded
  }
  const { scrollRef, contentRef, followLatest, preserveScroll, awayFromLatest } = useChatScroll(msgs, {
    suspended: editing !== null || state.selectionMode,
    historyMode: state.historyMode, historyVersion: state.historyVersion,
    historyLoading: state.historyLoading, loadingEarlier: state.loadingEarlier,
    hasEarlier: state.hasEarlier && !(historyAction === 'earlier' && state.historyError), ready: state.ready, onLoadEarlier: loadEarlier,
  })
  const used = state.context.used
  const limit = state.context.limit
  // 手动换窗参考线（她 2026-10-19 裁定）：容量圈按 uiReference（默认 128k）画，
  // 超出仅标红提示、不阻断；参考线缺省时退回容量口径。600k 软线=自动换窗兜底。
  const reference = state.context.reference
  const circleBase = reference ?? limit
  const pct = used != null && circleBase ? Math.min(1, used / circleBase) : 0
  const overRef = used != null && reference != null && used > reference
  const send = async () => {
    if (!client.canSend) return
    if ((state.historyMode === 'date' || state.hasLater) && !await returnToLatest()) return
    followLatest(); void client.send()
  }
  const selectMessage = (id: string) => client.select(id)
  const editMessage = (m: Msg) => {
    if (editing) return
    setEditing({ id: m.id, text: client.editText(m.id), revision: client.messageRevision(m.id), resend: m.canRetry === true })
  }
  const saveEditedMessage = async (m: Msg) => {
    if (!editing || editing.id !== m.id) return false
    const saved = await client.editMessage(m.id, editing.text, editing.resend, editing.revision)
    if (saved) setEditing(null)
    return saved
  }
  useEffect(() => {
    if (sheet && sheet !== 'wake') void client.loadPanel(sheet)
  }, [sheet, client])
  useEffect(() => {client.setAlertsOpen(alertsOpen);return ()=>client.setAlertsOpen(false)}, [alertsOpen, client])
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
          <div className="flex min-w-0 items-center gap-1">
            <IconBtn title="返回主页" onClick={() => {
              if ((input.length > 0 || state.attachments.length > 0 || rec) && !window.confirm('还有未发送的内容，确定返回主页？')) return
              window.location.assign('/')
            }}><ChevronLeft size={20} /></IconBtn>
            <h1 contentEditable suppressContentEditableWarning spellCheck={false}
              className="text-[17px] font-medium tracking-tight outline-none focus:bg-black/5">宇宙发明小机</h1>
          </div>
          <div className="flex">
            <HistoryDatePicker date={state.historyDate} timezone={state.historyTimezone} busy={state.historyLoading}
              disabled={editing !== null || state.selectionMode} onPick={jumpToDate} />
            <SystemAlertsButton unread={state.unreadAlerts} open={state.openAlerts}
              onClick={()=>{setAlertsOpen(true);setMore(false);setSheet(null)}} />
            <IconBtn title="电话" onClick={() => setCallOpen(true)}><Phone size={18} /></IconBtn>
            <div className="relative">
              <IconBtn title="更多" onClick={() => setMore(!more)}><MoreHorizontal size={18} /></IconBtn>
              {more && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMore(false)} />
                  <div className="pop-in absolute right-0 top-9 z-40 w-52 rounded-2xl border border-black/10 bg-white p-1 shadow-xl">
                    {([['bench', LayoutGrid, '工作台', 'char给我做的小东西'], ['log', Footprints, '活动日志', '自动唤醒后的足迹'], ['wake', AlarmClock, '自主预约与保温', '他的自设唤醒和心跳保温']] as const).map(([k, I, t, d]) => (
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
          {state.selectionMode ? (
            <span className="py-1 text-[12px] text-[#8a8780]">已选 {state.selected.size} 条 · 只带文本，图片不带入新窗</span>
          ) : (
          <button onClick={() => setMenu(!menu)} className="relative rounded-lg px-2 py-1 text-[13px] text-[#5e5d59] hover:bg-black/5">
            char · {MODELS[model]} · {EFFORTS[effort] ?? '默认'}
            <ChevronDown size={13} className="absolute -right-3 top-1/2 -translate-y-1/2" />
          </button>
          )}
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
                  {['opus5.5', 'fable5.1'].filter(name => !MODELS.includes(name)).map(name => (
                    <button key={name} disabled title="路由尚未接通" className="flex h-9 w-full items-center gap-2 rounded-xl pl-2.5 pr-2 text-[14px] opacity-40 cursor-not-allowed">
                      <span className="flex-1 text-left">{name}</span><span className="text-[11px]">未接通</span>
                    </button>
                  ))}
                </div>
                <span className="mx-1 h-20 w-px bg-black/5" />
                {EFFORTS.length > 0 && <EffortSlider value={effort} onChange={setEffort} levels={EFFORTS} />}
              </div>
            </>
          )}
        </div>
      </header>

      {historyAction === 'latest' && state.historyError && <p role="alert" className="px-4 py-2 text-[12px] text-[#a54b35]">{state.historyError}</p>}

      {/* Messages */}
      <main ref={scrollRef} className="no-bar min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-5">
        <div ref={contentRef} className="flow-root">
        {state.historyLoading && <p role="status" className="mb-3 text-center text-[12px] text-[#8a8780]">正在读取聊天记录…</p>}
        {state.ready && msgs.length > 0 && <HistoryBoundary direction="earlier" loading={state.loadingEarlier} hasMore={state.hasEarlier}
          error={historyAction === 'earlier' ? state.historyError : undefined} disabled={editing !== null || state.selectionMode || state.historyLoading}
          onLoad={() => void loadEarlier()} />}
        {state.historyMode === 'date' && !state.historyLoading && msgs.length === 0 && <p role="status" className="px-5 py-12 text-center text-[14px] text-[#8a8780]">这一天没有聊天记录，可以选择其他日期或回到最新。</p>}
        {msgs.map((m, index) => <Fragment key={m.id}>
          {m.dateKey && (index === 0 || msgs[index - 1]?.dateKey !== m.dateKey) && <p className="mb-5 text-center text-[11px] text-[#a3a099]">{m.dateLabel ?? m.dateKey}</p>}
          <div data-message-id={m.id} className="flow-root">
          {m.system ? <p role="status" className="mx-5 mb-4 text-center text-[12px] text-[#8a8780]">{m.text}</p> : m.role === 'user' ? (
          state.selectionMode ? (
            <button key={m.id} onClick={() => selectMessage(m.id)} aria-pressed={state.selected.has(m.id)}
              aria-label={state.selected.has(m.id) ? '取消选择这条' : '选择这条'}
              className="mb-8 flex w-full items-start gap-3 pl-5 pr-[2em] text-left">
              <SelectionCheck checked={state.selected.has(m.id)} />
              <span className="ml-auto flex w-[75%] flex-col items-end">
                {m.kind ? <SelectionMediaText kind={m.kind} text={m.text} /> : <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.6] tracking-[0.01em] text-[#1f1e1d]">{m.text}</p>}
                <span className="mt-1 text-[12px] tabular-nums text-[#a3a099]">{m.time}</span>
              </span>
            </button>
          ) : (
          <div key={m.id} className={`mb-8 ml-auto flex flex-col items-end ${editing?.id === m.id ? 'w-full px-3 sm:w-[85%] sm:pl-0 sm:pr-[2em]' : 'w-[75%] pr-[2em]'}`}>
            {editing?.id === m.id ? (
              <InlineMessageEditor value={editing.text} onChange={(text) => setEditing((draft) => draft?.id === m.id ? { ...draft, text } : draft)}
                onCancel={() => setEditing(null)} onSave={() => saveEditedMessage(m)} canRetry={editing.resend}
                pending={m.editPending} unconfirmed={m.editUnconfirmed} hasAttachment={Boolean(m.kind || m.media?.length)}>
                {m.kind && <Media m={m} showText={false} />}
              </InlineMessageEditor>
            ) : <>
            {m.kind ? <Media m={m} /> : <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.6] tracking-[0.01em] text-[#1f1e1d]">{m.text}</p>}
            <div className="mt-1 -mr-1.5 flex items-center">
              <IconBtn title="戳一戳" onClick={() => client.notify('戳一戳服务暂未接入')}><Heart size={15} /></IconBtn>
              <IconBtn title={state.selected.has(m.id) ? '已选择' : '多选'} onClick={() => selectMessage(m.id)}><ListChecks size={15} /></IconBtn>
              <IconBtn title="复制" onClick={() => void copy(m.text)}><Copy size={15} /></IconBtn>
              <IconBtn title="编辑" disabled={editing !== null || m.editPending || ['pending', 'running'].includes(m.replyState ?? '')} onClick={() => editMessage(m)}><Pencil size={15} /></IconBtn>
              <span className="ml-1.5 text-[12px] tabular-nums text-[#a3a099]">{m.time}</span>
            </div>
            </>}
            {['failed', 'blocked', 'interrupted'].includes(m.replyState ?? '') && <p role="status" className="mt-1 max-w-full text-right text-[12px] leading-relaxed text-[#a54b35]">
              {m.retryReason || (m.replyState === 'interrupted' ? '本次回复已中断。' : '这条消息尚未完成回复。')}
            </p>}
            {editing?.id !== m.id && m.canRetry && <button type="button" disabled={m.editPending} onClick={() => void client.retryMessage(m.id)}
              className="mt-2 flex items-center gap-1.5 rounded-full border border-[#d4cec0] px-3 py-1.5 text-[12px] text-[#5e5d59] hover:bg-black/5 disabled:opacity-50">
              <RotateCcw size={13} />{m.editPending ? '正在重试…' : '重试'}
            </button>}
          </div>
          )
        ) : state.selectionMode && !m.pending ? (
            <button key={m.id} onClick={() => selectMessage(m.id)} aria-pressed={state.selected.has(m.id)}
              aria-label={state.selected.has(m.id) ? '取消选择这条' : '选择这条'}
              className="mb-8 flex w-full items-start gap-3 pl-5 text-left">
              <SelectionCheck checked={state.selected.has(m.id)} />
              <span className="min-w-0 w-[75%]">
                {m.kind ? <SelectionMediaText kind={m.kind} text={m.text} /> : (
                <div className="font-claude break-words space-y-3 text-[15.5px] leading-[1.6] tracking-[-0.003em] text-[#1f1e1d]">
                  {m.text.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
                </div>
                )}
                <span className="mt-1 block text-[12px] tabular-nums text-[#a3a099]">{m.time}</span>
              </span>
            </button>
        ) : (
          <div key={m.id} className="mb-8 w-[75%] pl-[2em]">
            {(m.turnId || m.pending || m.streaming || (m.steps && m.steps.length > 0)) && <Thinking m={m}
              onExpand={m.turnId ? () => client.loadTurnDetails(m.turnId!) : undefined}
              onStop={(m.pending || m.streaming) && m.turnId ? () => void client.stopTurn(m.turnId!) : undefined} />}
            {!m.pending && (
              <>
                {m.kind ? <Media m={m} ai /> : (
                <div className="font-claude break-words space-y-3 text-[15.5px] leading-[1.6] tracking-[-0.003em] text-[#1f1e1d]">
                  {m.text.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
                </div>
                )}
                {m.turnId && <SurfacedMemories key={m.turnId} turnId={m.turnId} client={client} />}
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
        )}</div></Fragment>)}
        {(state.hasLater || state.loadingLater || state.historyMode === 'date' && msgs.length > 0 || historyAction === 'later' && state.historyError) && <HistoryBoundary
          direction="later" loading={state.loadingLater} hasMore={state.hasLater} error={historyAction === 'later' ? state.historyError : undefined}
          disabled={editing !== null || state.selectionMode || state.historyLoading} onLoad={() => void loadLater()} />}
        </div>
      </main>

      <IntegrationControls client={client} state={state} />
      {/* Composer */}
      <footer className="relative shrink-0 px-3 pt-2">
        <BackToLatestDot visible={state.historyMode === 'date' || state.hasLater || state.newMessages || awayFromLatest}
          newMessages={state.newMessages} busy={state.historyLoading}
          disabled={editing !== null || state.selectionMode} onLatest={() => void returnToLatest()} />
        {state.selectionMode ? (
        <SelectionBar count={state.selected.size}
          onConfirm={() => { if (confirm(`携带所选 ${state.selected.size} 条文本历史换窗？`)) void client.confirmSelection() }}
          onEmpty={() => { if (confirm('确认不携带历史换窗？')) void client.confirmSelection(true) }}
          onCancel={client.cancelSelection} />
        ) : (<>
        {state.attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2 text-[12px] text-[#8a8780]">{state.attachments.map(a => <div key={a.id} className="flex items-center gap-1">
          <button onClick={() => { if (a.status === 'failed') void client.retryAttachment(a.id) }}>{a.name} · {{ready:'待发送',uploading:'上传中',transcribing:'转写中',failed:'失败，点击重试',uncertain:'结果未确认'}[a.status]}</button>
          {a.kind === 'voice' && a.assetId && <button aria-label="试听录音" onClick={() => togglePreview(a.assetId!)} className="text-[#8a8780]">试听</button>}
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
                <circle cx="10" cy="10" r="7.5" fill="none" stroke={overRef ? '#d94a3a' : '#3d3929'} strokeWidth="2.5" strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 7.5}
                  style={{ strokeDashoffset: 2 * Math.PI * 7.5 * (1 - pct), transition: 'stroke-dashoffset 500ms ease, stroke 300ms ease' }} />
              </svg>
            </button>
            {ctxOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setCtxOpen(false)} />
                <div className="absolute bottom-14 left-0 z-20 w-56 rounded-xl border border-black/10 bg-white p-3 text-[12.5px] shadow-xl">
                  <p className="mb-2 font-medium">上下文窗口</p>
                  {[['已用', `${used?.toLocaleString() ?? '未知'} tokens`],
                    ['手换参考线', reference != null ? `${reference.toLocaleString()} tokens` : '未知'],
                    ['自动换窗上限', state.context.soft != null ? `${state.context.soft.toLocaleString()} tokens` : '未知'],
                    ['占比（参考线）', used != null && circleBase ? `${(pct * 100).toFixed(1)}%${overRef ? '（已超出）' : ''}` : '未知'],
                    ['缓存读取', state.context.cacheRead == null ? '未知' : `${state.context.cacheRead} tokens`], ['模型', MODELS[model]], ['思考等级', EFFORTS[effort] ?? '默认']].map(([k, v]) => (
                    <div key={k} className="flex justify-between py-0.5"><span className="text-[#8a8780]">{k}</span><span className={`tabular-nums ${k === '占比（参考线）' && overRef ? 'text-[#d94a3a]' : ''}`}>{v}</span></div>
                  ))}
                </div>
              </>
            )}
            <button aria-label="语音" onClick={() => (rec === null ? (pauseAllVoice(), startRec()) : stopRec(true))}
              className={`p-1 ${rec === null ? 'text-[#5e5d59]' : 'text-[#c96442]'}`}><Mic size={18} /></button>
            {rec !== null ? (
              <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-[14px] text-[#5e5d59]">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[#d94a3a]" />
                <span className="tabular-nums">0:{String(recSecs).padStart(2, '0')}</span>
                <button onClick={pauseRec} aria-label={recPaused ? '继续录音' : '暂停录音'} className="text-[#a3a099]">{recPaused ? '继续' : '暂停'}</button>
                <span className="flex flex-1 items-center gap-[2px] overflow-hidden">
                  {BARS.map((h, i) => <span key={i} className="w-[2px] animate-pulse rounded-full bg-[#c96442]/60" style={{ height: h * 0.8, animationDelay: `${i * 60}ms` }} />)}
                </span>
                <button onClick={() => stopRec(false)} aria-label="取消" className="text-[#a3a099]"><X size={16} /></button>
              </div>
            ) : <textarea ref={composerRef} rows={1} aria-label="回复消息" value={input} onChange={(e) => setInput(e.target.value)} title={`Enter 换行，⌘/Ctrl+Enter 发送${state.draftEstimate ? ` · 正文预计 ${state.draftEstimate.message_text_tokens ?? '未知'} token（粗估）` : ''}`}
              onCompositionStart={() => client.setComposing(true)} onCompositionEnd={() => client.setComposing(false)}
              onKeyDown={(e) => { if (shouldSendOnKeydown(e)) { e.preventDefault(); send(); } }}
              placeholder="回复…" className="min-w-0 flex-1 resize-none bg-transparent px-1 text-[16px] outline-none placeholder:text-[#a3a099]" />}
            {msgs.some(m=>m.pending||m.streaming) && <button aria-label="停止回复" onClick={() => {const running=msgs.filter(m=>m.pending||m.streaming).at(-1);if(running?.turnId)void client.stopTurn(running.turnId)}} className="shrink-0 rounded-lg px-2 py-1 text-[13px] text-[#8a8780]">停止</button>}
            <button onClick={() => (rec !== null ? stopRec(true) : send())} aria-label="发送" title="发送（⌘/Ctrl+Enter）" disabled={rec === null && !client.canSend} onPointerDown={(e) => e.preventDefault()}
              className="group flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full text-white">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#c96442] transition group-disabled:bg-[#e6c2b4]"><ArrowUp size={17} /></span>
            </button>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { setPlus(false); onPick(e.target.files?.[0]); e.target.value = '' }} />
        <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = '' }} />
        </>)}
      </footer>
      {sheet && sheet !== 'wake' && <Sheet kind={sheet} onClose={() => setSheet(null)} workbench={state.workbench} activity={state.activity} note={state.panelNote} />}
      {sheet === 'wake' && <BackgroundControls client={client} onClose={() => setSheet(null)} />}
      <CallInvites onAccept={() => setCallOpen(true)} />
      {callOpen && <CallPanel conversationId="primary" onExit={() => setCallOpen(false)} />}
      {alertsOpen && <SystemAlertsPanel alerts={state.alerts} unread={state.unreadAlerts} open={state.openAlerts}
        error={state.alertsError} hasMore={state.alertsHasMore} onClose={()=>setAlertsOpen(false)}
        onRefresh={()=>void client.loadAlerts()} onRead={()=>void client.markAlertsRead()} onMore={()=>void client.loadMoreAlerts()} />}
    </div>
  )
}
