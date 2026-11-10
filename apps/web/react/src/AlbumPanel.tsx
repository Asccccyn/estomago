import { useCallback, useEffect, useRef, useState } from 'react'
import { Heart, Image as ImageIcon, Library, Sparkles, Upload, X } from 'lucide-react'

// 相册重构 P3/P4（GLM_ALBUM_REFACTOR_EXECUTION 20261108）：四个入口的统一面板——
// 作品（creations）/ 我们的相册（important_photos）/ 对话存档（archives，争吵/甜蜜）/
// 表情包（stickers）。只读现有 content/archives HTTP 面（经 host 代理，同源鉴权）；
// 携带模式（仅收藏/下次滚窗一次/每次滚窗）与移除走既有 If-Match/幂等键合同。
// 字节经 /api/v1/assets/:id/content 读取（host 授权代理），面板不接触存储路径。
// R5/R6（复审 2026-11-08）：表情上传归类、作品入表情、非图片作品预览链接、
// 存档卡片展开选中原文（/archives/:id/messages 只读端点）。

type AlbumEntry = { id: string; asset_id: string; caption: string | null; meaning: string | null; added_by: string; carry_mode: 'none' | 'next_once' | 'always'; revision: number; created_at: string }
type Creation = { id: string; title: string | null; work_asset_id: string | null; work_kind: string | null; created_at: string }
type ArchiveItem = { id: string; kind: 'quarrel' | 'sweet'; note: string | null; created_by: string; messages: Array<{ message_id: string }>; created_at: string; revision: number }
type ArchiveOriginal = { message_id: string; revision: number; sequence: number | null; speaker: string | null; text: string | null; occurred_at: string | null; attachments?: Array<{ asset_id: string; presentation: string; caption: string | null }> }

const TABS = [
  { key: 'creations', label: '作品', icon: Sparkles },
  { key: 'photos', label: '我们的相册', icon: Heart },
  { key: 'archives', label: '对话存档', icon: Library },
  { key: 'stickers', label: '表情包', icon: ImageIcon },
] as const
type TabKey = (typeof TABS)[number]['key']

const CARRY_LABELS: Record<AlbumEntry['carry_mode'], string> = { none: '仅收藏', next_once: '下次滚窗一次', always: '每次滚窗' }
const KIND_LABELS: Record<ArchiveItem['kind'], string> = { quarrel: '争吵', sweet: '甜蜜' }
const SPEAKER_LABELS: Record<string, string> = { owner: '乔乔', assistant: 'char' }

async function jfetch<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T }
}

function opId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export default function AlbumPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('creations')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [entries, setEntries] = useState<AlbumEntry[]>([])
  const [creations, setCreations] = useState<Creation[]>([])
  const [archives, setArchives] = useState<ArchiveItem[]>([])
  const [openArchive, setOpenArchive] = useState<string | null>(null)
  const [originals, setOriginals] = useState<ArchiveOriginal[] | null>(null)
  const stickerInputRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      if (tab === 'creations') {
        const { status, body } = await jfetch<{ items?: Creation[] }>('/api/v1/content/creations?limit=50')
        if (status !== 200) throw new Error('作品读取失败 ' + status)
        setCreations(body.items ?? [])
      } else if (tab === 'archives') {
        const { status, body } = await jfetch<{ items?: ArchiveItem[] }>('/api/v1/archives?limit=50')
        if (status !== 200) throw new Error('存档读取失败 ' + status)
        setArchives(body.items ?? [])
      } else {
        const kind = tab === 'photos' ? 'important_photos' : 'stickers'
        const { status, body } = await jfetch<{ items?: AlbumEntry[] }>(`/api/v1/content/albums/${kind}/entries?limit=50`)
        if (status !== 200) throw new Error('相册读取失败 ' + status)
        setEntries(body.items ?? [])
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }, [tab])
  useEffect(() => { void load() }, [load])

  const setCarry = async (entry: AlbumEntry, mode: AlbumEntry['carry_mode']) => {
    setBusy(true); setErr(null)
    try {
      const { status, body } = await jfetch<{ error?: { message?: string } }>(`/api/v1/content/album-entries/${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': `"${entry.revision}"`, 'Idempotency-Key': `ui-carry:${entry.id}:${mode}:${Date.now()}` },
        body: JSON.stringify({ carry_mode: mode }),
      })
      if (status !== 200) throw new Error(body?.error?.message ?? ('设置失败 ' + status))
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const removeEntry = async (entry: AlbumEntry) => {
    if (!confirm('从相册移除（只解除关系，不删除图片和历史消息）？')) return
    setBusy(true); setErr(null)
    try {
      const { status, body } = await jfetch<{ error?: { message?: string } }>(`/api/v1/content/album-entries/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"${entry.revision}"`, 'Idempotency-Key': `ui-album-del:${entry.id}:${Date.now()}` },
      })
      if (status !== 200) throw new Error(body?.error?.message ?? ('移除失败 ' + status))
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const removeArchive = async (a: ArchiveItem) => {
    if (!confirm(`删除这条${KIND_LABELS[a.kind]}存档？（原文与记忆不受影响）`)) return
    setBusy(true); setErr(null)
    try {
      const { status, body } = await jfetch<{ error?: { message?: string } }>(`/api/v1/archives/${encodeURIComponent(a.id)}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"${a.revision}"`, 'Idempotency-Key': `ui-arc-del:${a.id}:${Date.now()}` },
      })
      if (status !== 200) throw new Error(body?.error?.message ?? ('删除失败 ' + status))
      setOpenArchive(null); setOriginals(null)
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  /** R6 存档打开链：展开存档钉住版本的原文明文（只读端点，E 库按修订取正文）。 */
  const toggleArchive = async (a: ArchiveItem) => {
    if (openArchive === a.id) { setOpenArchive(null); setOriginals(null); return }
    setOpenArchive(a.id); setOriginals(null)
    try {
      const { status, body } = await jfetch<{ items?: ArchiveOriginal[]; error?: { message?: string } }>(`/api/v1/archives/${encodeURIComponent(a.id)}/messages`)
      if (status !== 200) throw new Error(body?.error?.message ?? ('原文读取失败 ' + status))
      setOriginals(body.items ?? [])
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setOpenArchive(null) }
  }

  /** R5 表情上传归类：上传（purpose=chat_sticker，MIME 白名单在服务端）→ 建 stickers 条目。 */
  const uploadSticker = async (file: File) => {
    setBusy(true); setErr(null)
    try {
      const key = opId('ui-sticker')
      const up = await fetch('/api/v1/assets?purpose=chat_sticker', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': key }, body: file })
      const upBody = (await up.json().catch(() => ({}))) as { asset_id?: string; error?: { message?: string } }
      if (up.status !== 201 && up.status !== 200) throw new Error(upBody.error?.message ?? ('上传失败 ' + up.status))
      const { status, body } = await jfetch<{ error?: { message?: string } }>('/api/v1/content/albums/stickers/entries', {
        method: 'POST',
        headers: { 'Idempotency-Key': `${key}:entry` },
        body: JSON.stringify({ asset_id: upBody.asset_id }),
      })
      if (status !== 201 && status !== 200) throw new Error(body?.error?.message ?? ('归类失败 ' + status))
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  /** R5 作品入表情：作品卡片的 work 资产归入 stickers（同 entries 接口 kind=stickers）。 */
  const addCreationToStickers = async (c: Creation) => {
    if (!c.work_asset_id) return
    setBusy(true); setErr(null)
    try {
      const { status, body } = await jfetch<{ error?: { message?: string } }>('/api/v1/content/albums/stickers/entries', {
        method: 'POST',
        headers: { 'Idempotency-Key': opId(`ui-creation-sticker:${c.id}`) },
        body: JSON.stringify({ asset_id: c.work_asset_id }),
      })
      if (status !== 201 && status !== 200) throw new Error(body?.error?.message ?? ('加入失败 ' + status))
      setErr(null)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-label="相册" onClick={(e) => e.stopPropagation()}
        className="flex h-[78vh] w-full max-w-[560px] flex-col rounded-t-3xl bg-[#faf8f2] shadow-2xl sm:rounded-3xl">
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <div className="text-[16px] font-medium text-[#3d3929]">相册</div>
          <button aria-label="关闭" onClick={onClose} className="rounded-xl p-1.5 text-[#8a8780] hover:bg-black/5"><X size={18} /></button>
        </div>
        <div className="flex gap-1 px-4 pb-2" role="tablist">
          {TABS.map(({ key, label, icon: I }) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
              className={`flex flex-1 items-center justify-center gap-1 rounded-xl px-2 py-1.5 text-[13px] transition ${tab === key ? 'bg-[#c96442] text-white' : 'text-[#5e5d59] hover:bg-black/5'}`}>
              <I size={14} />{label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {err && <p className="rounded-xl bg-[#f7e8e4] px-3 py-2 text-[13px] text-[#b3554d]">{err}</p>}
          {busy && <p className="py-3 text-center text-[13px] text-[#a3a099]">读取中…</p>}
          {!busy && tab === 'creations' && (creations.length === 0
            ? <Empty text="还没有作品——char画完会自动进来" />
            : <div className="grid grid-cols-2 gap-3 pt-1 sm:grid-cols-3">
              {creations.map((c) => c.work_asset_id && c.work_kind === 'image'
                ? <div key={c.id} className="overflow-hidden rounded-2xl border border-black/10 bg-white">
                    <img src={`/api/v1/assets/${encodeURIComponent(c.work_asset_id)}/content`} alt={c.title ?? '作品'} className="aspect-square w-full object-cover" />
                    <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                      <span className="truncate text-[12px] text-[#5e5d59]">{c.title ?? '未命名作品'}</span>
                      <button disabled={busy} onClick={() => void addCreationToStickers(c)} title="加入表情包"
                        className="shrink-0 rounded-lg px-1.5 py-0.5 text-[11px] text-[#5e5d59] hover:bg-black/5">入表情</button>
                    </div>
                  </div>
                : <div key={c.id} className="rounded-2xl border border-black/10 bg-white px-3 py-3 text-[13px] text-[#5e5d59]">
                    <p>{c.title ?? '作品'}（{c.work_kind ?? 'svg'}）</p>
                    {c.work_asset_id && (c.work_kind === 'svg' || c.work_kind === 'html') && (
                      <a href={`/api/v1/assets/${encodeURIComponent(c.work_asset_id)}/preview`} target="_blank" rel="noreferrer"
                        className="mt-1 inline-block rounded-lg bg-black/5 px-2 py-0.5 text-[12px] text-[#3d3929] hover:bg-black/10">沙箱预览打开 ↗</a>
                    )}
                  </div>)}
            </div>)}
          {!busy && (tab === 'photos' || tab === 'stickers') && (
            <div className="flex flex-col gap-2 pt-1">
              {tab === 'stickers' && (
                <button disabled={busy} onClick={() => stickerInputRef.current?.click()}
                  className="flex items-center justify-center gap-1.5 rounded-2xl border border-dashed border-black/15 px-3 py-2.5 text-[13px] text-[#5e5d59] hover:bg-black/5">
                  <Upload size={14} />上传表情（自动归入表情包）
                </button>
              )}
              {entries.length === 0
                ? <Empty text={tab === 'photos' ? '还没有精选——点聊天图片下的星标可收藏' : '表情包还是空的——上传图片，或把作品归入表情包'} />
                : entries.map((e) => (
                  <div key={e.id} className="flex items-center gap-3 rounded-2xl border border-black/10 bg-white p-2.5">
                    <img src={`/api/v1/assets/${encodeURIComponent(e.asset_id)}/content`} alt="" className="h-16 w-16 shrink-0 rounded-xl object-cover" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-[#3d3929]">{[e.caption, e.meaning].filter(Boolean).join(' · ') || '（无留言）'}</p>
                      <p className="mt-0.5 text-[11px] text-[#a3a099]">{e.added_by === 'qiaosheng' ? '乔乔' : 'char'} 收藏 · {new Date(e.created_at).toLocaleDateString()}</p>
                      {tab === 'photos' && (
                        <div className="mt-1.5 flex gap-1">
                          {(['none', 'next_once', 'always'] as const).map((m) => (
                            <button key={m} disabled={busy} onClick={() => void setCarry(e, m)}
                              className={`rounded-lg px-2 py-0.5 text-[11px] transition ${e.carry_mode === m ? 'bg-[#c96442] text-white' : 'bg-black/5 text-[#5e5d59] hover:bg-black/10'}`}>
                              {CARRY_LABELS[m]}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button aria-label="移除" disabled={busy} onClick={() => void removeEntry(e)} className="shrink-0 rounded-xl p-1.5 text-[#a3a099] hover:bg-black/5 hover:text-[#b3554d]"><X size={15} /></button>
                  </div>
                ))}
            </div>)}
          {!busy && tab === 'archives' && (archives.length === 0
            ? <Empty text="还没有对话存档——多选消息后可存为争吵/甜蜜存档" />
            : <div className="flex flex-col gap-2 pt-1">
              {archives.map((a) => (
                <div key={a.id} className="rounded-2xl border border-black/10 bg-white p-3" data-open={openArchive === a.id}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-lg px-2 py-0.5 text-[11px] ${a.kind === 'quarrel' ? 'bg-[#f7e8e4] text-[#b3554d]' : 'bg-[#f0e6d2] text-[#8a6d1f]'}`}>{KIND_LABELS[a.kind]}存档</span>
                      <button disabled={busy} onClick={() => void toggleArchive(a)} className="rounded-lg px-2 py-0.5 text-[11px] text-[#3d3929] hover:bg-black/5">
                        {openArchive === a.id ? '收起原文' : '展开原文'}
                      </button>
                    </div>
                    <button aria-label="删除存档" disabled={busy} onClick={() => void removeArchive(a)} className="rounded-xl p-1.5 text-[#a3a099] hover:bg-black/5 hover:text-[#b3554d]"><X size={15} /></button>
                  </div>
                  <p className="mt-1.5 text-[13px] text-[#3d3929]">{a.note ?? '（无说明）'}</p>
                  <p className="mt-0.5 text-[11px] text-[#a3a099]">{a.messages.length} 条消息 · {a.created_by === 'qiaosheng' ? '乔乔' : 'char'} · {new Date(a.created_at).toLocaleString()}</p>
                  {openArchive === a.id && (
                    <div className="mt-2 rounded-xl bg-[#f6f4ec] px-3 py-2">
                      {originals === null
                        ? <p className="text-[12px] text-[#a3a099]">原文读取中…</p>
                        : originals.length === 0
                          ? <p className="text-[12px] text-[#a3a099]">原文暂不可读（存档关系仍在）</p>
                          : <ol className="flex flex-col gap-2">
                            {originals.map((o) => (
                              <li key={o.message_id} className="text-[13px] leading-relaxed">
                                <span className="mr-1 text-[11px] text-[#a3a099]">{SPEAKER_LABELS[o.speaker ?? ''] ?? o.speaker}：</span>
                                <span className="whitespace-pre-wrap text-[#3d3929]">{o.text ?? '（正文缺失）'}</span>
                                {(o.attachments ?? []).filter((a) => a.presentation === 'image' || a.presentation === 'sticker').map((a) => (
                                  <img key={a.asset_id} src={`/api/v1/assets/${encodeURIComponent(a.asset_id)}/content`} alt={a.caption ?? ''} title={a.caption ?? undefined} className="mt-1 max-h-44 rounded-xl object-contain" />
                                ))}
                              </li>
                            ))}
                          </ol>}
                    </div>
                  )}
                </div>
              ))}
            </div>)}
        </div>
      </div>
      <input ref={stickerInputRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadSticker(f) }} />
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="py-10 text-center text-[13px] text-[#a3a099]">{text}</p>
}
