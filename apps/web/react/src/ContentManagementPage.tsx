import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, HeartPulse, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { EstomagoClient } from './chat-client'
import {
  assetPath, ContentRequestError, operationKey, readContent, referencePath, writeContent,
  type AssetInfo, type ContentEntry, type ContentPage, type DeliveryState, type HeartbeatState, type SourceBlock,
} from './content-management-api'

const actionClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#d9cdbd] bg-white px-3 py-2 text-sm text-[#574633] hover:bg-[#f4eadb] disabled:opacity-50'
const primaryClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#85462f] px-3 py-2 text-sm text-white hover:bg-[#6e3826] disabled:opacity-50'
const fieldClass = 'mt-1 w-full rounded-lg border border-[#d9cdbd] bg-white px-3 py-2 text-[#372d23] focus:outline-2 focus:outline-[#85462f]'
const cardClass = 'rounded-xl border border-[#e1d5c6] bg-[#fffdf8] p-4'
const mutedClass = 'text-sm text-[#675a4c]'
const errorClass = 'rounded-lg bg-[#f8e7e0] px-3 py-2 text-sm text-[#862f23]'
const ownerActor = 'qiaosheng'
const displayDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const dateLabel = (value: string) => Number.isFinite(Date.parse(value)) ? displayDate.format(new Date(value)) : ''
const authorLabel = (author?: string | null) => author === ownerActor ? '乔乔' : author === 'jiaming' ? 'char' : author
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '请求暂未确认，请重试。'
const deliveryDescriptions: Record<DeliveryState, string> = {
  pending: '待投递', dispatching: '投递中', delivered: '已投递', unknown: '投递结果待核',
}
const unreadable: Record<Exclude<SourceBlock['status'], 'available'>, string> = {
  deleted: '来源已删除', forbidden: '当前没有读取权限', revision_unavailable: '当时的修订已不可读', unavailable: '来源暂时不可用',
}

type Mode = 'moments' | 'heartbeat'
type Layer = 'daily' | 'living-room' | 'family'
type LivingRoomPost = {
  id: string; revision: string; author_name: string | null;
  scope: 'self' | 'attendees' | 'everyone'; source_kind: 'archive_item' | 'manual_post';
  created_at: string; text: string
}
type Draft = { title: string; body: string; assetIds: string[] }
type EditorTarget = { id: string; revision: number; block?: SourceBlock; sourceRevision?: number; referenceTitle?: boolean }
type Editor = { draft: Draft; target?: EditorTarget }
type PendingUpload = { file: File; key: string; assetId?: string }

function Attachment({ id }: { id: string }) {
  const [asset, setAsset] = useState<AssetInfo | 'unavailable' | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void readContent<AssetInfo>(assetPath(id), { signal: controller.signal }).then(setAsset, () => {
      if (!controller.signal.aborted) setAsset('unavailable')
    })
    return () => controller.abort()
  }, [id])
  if (!asset) return <span className={mutedClass}>读取附件…</span>
  if (asset === 'unavailable' || asset.state !== 'available') return <span className={mutedClass}>附件暂不可读</span>
  const src = `${assetPath(id)}/content`
  if (asset.mime_type.startsWith('audio/')) return <audio src={src} controls preload="none" className="w-full" aria-label="语音附件" />
  if (asset.mime_type.startsWith('image/')) {
    return <img src={asset.mime_type === 'image/svg+xml' ? `${assetPath(id)}/preview` : src}
      alt="图片附件" loading="lazy" className="max-h-80 max-w-full rounded-lg object-contain" />
  }
  return <a href={src} className="underline" target="_blank" rel="noreferrer">打开附件</a>
}

function Attachments({ ids, remove }: { ids: string[]; remove?: (id: string) => void }) {
  return ids.length > 0 && <div className="space-y-3">
    {ids.map((id, index) => <div key={id} className="flex items-start gap-2">
      <div className="min-w-0 flex-1"><Attachment id={id} /></div>
      {remove && <button type="button" aria-label={`移除附件 ${index + 1}`} className={actionClass} onClick={() => remove(id)}>移除</button>}
    </div>)}
  </div>
}

function ReferenceHistory({ postId, block }: { postId: string; block: SourceBlock }) {
  const [open, setOpen] = useState(false)
  const [original, setOriginal] = useState<SourceBlock | null>(null)
  const [error, setError] = useState<string | null>(null)
  const observed = block.observed_revision
  useEffect(() => {
    if (!open || observed === undefined) return
    const controller = new AbortController()
    const url = `${referencePath(postId)}/blocks/${encodeURIComponent(block.id)}?revision=${observed}`
    void readContent<SourceBlock>(url, { signal: controller.signal }).then(setOriginal, readError => {
      if (!controller.signal.aborted) setError(errorMessage(readError))
    })
    return () => controller.abort()
  }, [open, postId, block.id, observed])

  return <div className="space-y-2">
    <button type="button" className={actionClass} aria-expanded={open} onClick={() => {
      setOriginal(null)
      setError(null)
      setOpen(!open)
    }}>{open ? '收起当时版本' : '查看当时版本'}</button>
    {open && (error ? <p role="status" className={mutedClass}>{error}</p>
      : original ? <div className="space-y-2 rounded-lg bg-[#f8f1e6] p-3">
        <p className={mutedClass}>当时版本</p>
        {original.text && <p className="whitespace-pre-wrap break-words">{original.text}</p>}
        <Attachments ids={original.asset_ids ?? []} />
      </div> : <p role="status" className={mutedClass}>读取当时版本…</p>)}
  </div>
}

function noteState(entry: ContentEntry): string {
  if (!entry.delivery_state) return '投递状态暂不可用'
  const state = deliveryDescriptions[entry.delivery_state]
  if (!entry.frozen_card) return state
  const card = entry.frozen_card
  return `${state} · 今日 ${card.number} 号${!card.available && entry.delivery_state === 'pending' ? '已不可用' : card.available && card.revision !== entry.revision ? '仍使用已固定的旧修订' : ''}`
}

const background = new EstomagoClient()

function HeartbeatStatus({ refreshVersion }: { refreshVersion: number }) {
  const [status, setStatus] = useState<HeartbeatState | null>(null)
  const [settings, setSettings] = useState<{ revision: number; enabled: boolean } | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await readContent<HeartbeatState>('/api/v1/background/heartbeat', { signal })
      if (signal?.aborted) return
      setStatus(next)
      setStatusError(null)
    } catch (error) {
      if (signal?.aborted) return
      setStatus(null)
      setStatusError(errorMessage(error))
    }
  }, [])
  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await background.backgroundSettings()
      if (signal?.aborted) return
      setSettings({ revision: next.revision, enabled: next.keepwarm?.enabled === true })
      setSettingsError(null)
    } catch (error) {
      if (signal?.aborted) return
      setSettings(null)
      setSettingsError(errorMessage(error))
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void loadStatus(controller.signal)
    return () => controller.abort()
  }, [loadStatus, refreshVersion])
  useEffect(() => {
    const controller = new AbortController()
    void loadSettings(controller.signal)
    return () => controller.abort()
  }, [loadSettings])

  async function toggle() {
    if (!settings || busy) return
    setBusy(true)
    setSettingsError(null)
    try {
      await background.backgroundPutSettings(settings.revision, { keepwarm: { enabled: !settings.enabled } }, operationKey('keepwarm'))
      await loadSettings()
      await loadStatus()
    } catch (error) {
      await loadSettings()
      setSettingsError(errorMessage(error))
    } finally { setBusy(false) }
  }

  return <section className={`${cardClass} space-y-3`} aria-label="心跳状态">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><HeartPulse size={18} />
        心跳保温
        <button type="button" className={actionClass} onClick={() => void toggle()} disabled={!settings || busy}
          aria-label="心跳保温" aria-pressed={settings?.enabled ?? false}>{settings ? settings.enabled ? '已开启' : '已关闭' : '状态未知'}</button>
      </div>
      <button type="button" className={actionClass} onClick={() => { void loadStatus(); void loadSettings() }} disabled={busy}><RefreshCw size={14} />刷新</button>
    </div>
    {settingsError && <p role="alert" className={errorClass}>{settingsError}</p>}
    {statusError && <p role="status" className={mutedClass}>今日牌组暂不可读取。{statusError}</p>}
    {status && <>
      <h2 className="font-medium">今日牌组 <span className={mutedClass}>{status.date} · 上海时间</span></h2>
      <p className={mutedClass}>{status.mode === 'exhausted_keepwarm' ? '今日十张已全部抽完，后续心跳回复 1 保温。'
        : status.mode === 'unprepared' ? '牌组尚未准备好。' : status.mode === 'source_unavailable' ? '有来源暂不可用或待核。' : '等待char自行选择。'}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt>可选</dt><dd>{status.available_numbers.join('、') || '—'}</dd>
        <dt>已实际交付</dt><dd>{status.delivered_numbers.join('、') || '—'}</dd>
        <dt>失效或待核</dt><dd>{status.source_unavailable_numbers.join('、') || '—'}</dd>
      </dl>
    </>}
  </section>
}

export default function ContentManagementPage({ mode }: { mode: Mode }) {
  const notes = mode === 'heartbeat'
  const noun = notes ? '留言' : '帖子'
  const path = notes ? '/api/v1/content/future-notes' : '/api/v1/content/posts'
  const [layer, setLayer] = useState<Layer>('daily')
  const [items, setItems] = useState<ContentEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null)
  const [statusRefresh, setStatusRefresh] = useState(0)
  const readGeneration = useRef(0)
  const pendingWrite = useRef<{ fingerprint: string; key: string } | null>(null)

  const load = useCallback(async (pageCursor?: string) => {
    const generation = ++readGeneration.current
    setLoading(true)
    setListError(null)
    const params = new URLSearchParams({ limit: '20', ...(notes ? {} : { include_references: '1' }) })
    if (pageCursor) params.set('cursor', pageCursor)
    try {
      const data = await readContent<ContentPage>(`${path}?${params}`)
      if (generation !== readGeneration.current) return
      setItems(previous => pageCursor ? [...previous, ...data.items.filter(item => !previous.some(old => old.id === item.id))] : data.items)
      setCursor(data.has_more ? data.next_cursor ?? null : null)
    } catch (readError) {
      if (generation === readGeneration.current) setListError(errorMessage(readError))
    } finally {
      if (generation === readGeneration.current) setLoading(false)
    }
  }, [notes, path])

  useEffect(() => {
    void load()
    return () => { readGeneration.current++ }
  }, [load])

  async function upload(attempt: PendingUpload) {
    setBusy(true)
    setError(null)
    setPendingUpload(attempt)
    try {
      let id = attempt.assetId
      let asset: AssetInfo
      if (id) {
        asset = await readContent<AssetInfo>(assetPath(id))
      } else {
        const purpose = attempt.file.type.startsWith('audio/') ? 'chat_voice' : 'chat_image'
        asset = await readContent<AssetInfo>(`/api/v1/assets?purpose=${purpose}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': attempt.key },
          body: attempt.file,
        })
        id = asset.asset_id
        if (!id) throw new Error('上传回执未给出资产身份，可用同一操作重试。')
        setPendingUpload({ ...attempt, assetId: id })
      }
      if (asset.state !== 'available' || asset.m_sync_state !== 'synced') {
        throw new Error('原文件仍在等待正本确认。请稍后继续加入附件。')
      }
      const confirmedId = id
      setEditor(current => current && ({
        ...current, draft: { ...current.draft, assetIds: [...new Set([...current.draft.assetIds, confirmedId])] },
      }))
      setPendingUpload(null)
    } catch (uploadError) { setError(errorMessage(uploadError)) }
    finally { setBusy(false) }
  }

  function closeEditor() {
    setEditor(null)
    setError(null)
    pendingWrite.current = null
    setPendingUpload(null)
  }
  function setDraft(change: Partial<Draft>) {
    setEditor(current => current && ({ ...current, draft: { ...current.draft, ...change } }))
  }

  async function openEdit(entry: ContentEntry, block?: SourceBlock) {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      if (block) {
        const url = `${referencePath(entry.id)}/blocks/${encodeURIComponent(block.id)}`
        const source = await readContent<SourceBlock>(url)
        if (!source.editable || source.status !== 'available' || typeof source.current_revision !== 'number') {
          throw new Error(source.status !== 'available' ? unreadable[source.status] : '对应来源当前只读。')
        }
        setEditor({
          target: { id: entry.id, revision: entry.revision, block, sourceRevision: source.current_revision },
          draft: { title: '', body: source.text ?? '', assetIds: source.asset_ids ?? [] },
        })
      } else if (entry.kind === 'reference') {
        const current = await readContent<ContentEntry>(referencePath(entry.id))
        setEditor({ target: { id: current.id, revision: current.revision, referenceTitle: true }, draft: { title: current.title ?? '', body: '', assetIds: [] } })
      } else {
        const current = await readContent<ContentEntry>(`${path}/${encodeURIComponent(entry.id)}`)
        if (current.deleted || current.author !== ownerActor) throw new Error(`这条${noun}当前无法编辑。`)
        setEditor({ target: { id: current.id, revision: current.revision }, draft: { title: current.title ?? '', body: current.body ?? '', assetIds: current.asset_ids ?? [] } })
      }
    } catch (readError) { setError(errorMessage(readError)) }
    finally { setBusy(false) }
  }

  async function save() {
    if (!editor || pendingUpload || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    const { target, draft } = editor
    const block = target?.block
    const url = block
      ? `${referencePath(target.id)}/blocks/${encodeURIComponent(block.id)}`
      : target?.referenceTitle ? referencePath(target.id) : target ? `${path}/${encodeURIComponent(target.id)}` : path
    const body = JSON.stringify(target?.referenceTitle ? { title: draft.title } : {
      body: draft.body,
      asset_ids: draft.assetIds,
      ...(block ? { expected_source_revision: target.sourceRevision } : notes || !target ? { title: draft.title } : {}),
    })
    const fingerprint = JSON.stringify([url, target?.revision, body])
    try {
      if (pendingWrite.current && pendingWrite.current.fingerprint !== fingerprint) {
        throw new Error('上次保存结果仍待确认。请先按原草稿重试，或刷新列表核对结果。')
      }
      pendingWrite.current ??= { fingerprint, key: operationKey('save-content') }
      const saved = await writeContent<ContentEntry>(url, target ? 'PUT' : 'POST', pendingWrite.current.key, target?.revision, body)
      closeEditor()
      setResult(notes ? `已保存。 ${noteState(saved)}。` : '已保存。')
      setStatusRefresh(version => version + 1)
      await load()
    } catch (saveError) {
      if (saveError instanceof ContentRequestError && saveError.status >= 400 && saveError.status < 500) pendingWrite.current = null
      if (saveError instanceof ContentRequestError && [409, 412].includes(saveError.status)) {
        setError(`${errorMessage(saveError)} 草稿已保留。可刷新列表核对当前修订。`)
      } else {
        setError(errorMessage(saveError))
      }
    } finally { setBusy(false) }
  }

  async function remove(entry: ContentEntry) {
    const reference = entry.kind === 'reference'
    const question = reference ? '从朋友圈移除这条映射？原文继续保留。' : notes ? '删除这条留言？已发生的投递会保留。' : '删除这条帖子？'
    const blockingCard = notes && entry.frozen_card?.available && entry.delivery_state === 'pending'
    const cardEffect = blockingCard ? `若尚未开始投递，今日 ${entry.frozen_card?.number} 号会失效。` : ''
    if (!window.confirm(question + cardEffect)) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const url = reference ? referencePath(entry.id) : `${path}/${encodeURIComponent(entry.id)}`
      const removed = await writeContent<Partial<ContentEntry>>(url, 'DELETE', `ui-remove:${entry.id}:${entry.revision}`, entry.revision)
      const state = removed.delivery_state
      setResult(notes && state ? `留言已移除，原投递状态为${deliveryDescriptions[state]}。` : '已移除。')
      setStatusRefresh(version => version + 1)
      await load()
    } catch (removeError) {
      setError(errorMessage(removeError))
    } finally { setBusy(false) }
  }

  const daily = layer === 'daily'
  return <main className="h-dvh overflow-y-auto bg-[#f8f1e6] px-4 pb-12 text-[#372d23]">
    <div className="mx-auto max-w-2xl space-y-4">
      <header className="flex flex-wrap items-center gap-3 border-b border-[#e1d5c6] py-4">
        <a href="/" className={actionClass}><ArrowLeft size={16} />首页</a>
        <h1 className="text-xl font-semibold">{notes ? '心跳' : '朋友圈'}</h1>
      </header>
      {notes ? <HeartbeatStatus refreshVersion={statusRefresh} /> :
        <nav aria-label="朋友圈来源" className="flex gap-2">
          {([['daily', '日常'], ['living-room', '客厅'], ['family', 'family']] as const).map(([key, label]) =>
            <button key={key} type="button" aria-pressed={layer === key} disabled={Boolean(editor) || busy}
              className={layer === key ? primaryClass : actionClass} onClick={() => setLayer(key)}>{label}</button>)}
        </nav>}
      {layer === 'family' && <p className={mutedClass}>family 暂未开放。</p>}
      {layer === 'living-room' && <LivingRoomMoments />}
      {daily && <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {notes && <h2 className="font-medium">预留留言</h2>}
          <div className="flex gap-2">
            {!editor && <button type="button" className={primaryClass} disabled={busy} onClick={() => {
              setEditor({ draft: { title: '', body: '', assetIds: [] } })
              setError(null)
              setResult(null)
            }}><Plus size={16} />{notes ? '新增留言' : '发布帖子'}</button>}
            <button type="button" className={actionClass} disabled={busy || loading} onClick={() => void load()}><RefreshCw size={14} />刷新列表</button>
          </div>
        </div>
        {listError && <p role="alert" className={errorClass}>{listError}</p>}
        {error && <p role="alert" className={errorClass}>{error}</p>}
        {result && <p role="status" className={mutedClass}>{result}</p>}
        {editor && <form className={`${cardClass} space-y-3`} onSubmit={event => { event.preventDefault(); void save() }}>
          <h2 className="font-medium">{editor.target?.referenceTitle ? '编辑展示标题' : editor.target?.block ? `编辑来源｜${editor.target.block.source_label}` : editor.target ? `编辑${noun}` : `新建${noun}`}</h2>
          {editor.target?.block && <p className={mutedClass}>保存会修改这条来源的原文。</p>}
          {!editor.target?.block && (notes || !editor.target || editor.target.referenceTitle) && <label className="block text-sm">标题（可选）
            <input value={editor.draft.title} maxLength={200} onChange={event => setDraft({ title: event.currentTarget.value })} className={fieldClass} disabled={busy} />
          </label>}
          {!editor.target?.referenceTitle && <><label className="block text-sm">正文
            <textarea value={editor.draft.body} rows={5} maxLength={!notes && !editor.target?.block ? 40000 : undefined} onChange={event => setDraft({ body: event.currentTarget.value })} className={fieldClass} disabled={busy} />
          </label>
          <Attachments ids={editor.draft.assetIds} remove={busy ? undefined : id => setDraft({ assetIds: editor.draft.assetIds.filter(value => value !== id) })} />
          <label className="block text-sm">添加图片或语音
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,audio/*" className="mt-1 block max-w-full"
              disabled={busy || Boolean(pendingUpload)} onChange={event => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void upload({ file, key: operationKey('content-asset') })
              }} />
          </label></>}
          {pendingUpload && <div className="flex gap-2">
            <button type="button" className={actionClass} disabled={busy} onClick={() => void upload(pendingUpload)}>{pendingUpload.assetId ? '继续加入' : '重试上传'}</button>
            <button type="button" className={actionClass} disabled={busy} onClick={() => { setPendingUpload(null); setError(null) }}>取消添加</button>
          </div>}
          <div className="flex gap-2">
            <button type="submit" className={primaryClass} disabled={busy || Boolean(pendingUpload) || (!editor.target?.referenceTitle && !editor.draft.body.trim() && editor.draft.assetIds.length === 0)}>{busy ? '处理中…' : '保存'}</button>
            <button type="button" disabled={busy} className={actionClass} onClick={closeEditor}>取消</button>
          </div>
        </form>}
        {loading && <p role="status" className={mutedClass}>读取中…</p>}
        {!loading && !listError && !items.length && <p className={mutedClass}>{notes ? '还没有预留留言。' : '这里还没有日常。'}</p>}
        {items.map(entry => <article key={entry.id} className={`${cardClass} space-y-3`}>
          <header className="flex flex-wrap items-center justify-between gap-2">
            <span className={mutedClass}>{entry.kind === 'reference' ? '心跳' : authorLabel(entry.author)} · {dateLabel(entry.published_at ?? entry.created_at)}</span>
            {entry.kind !== 'reference' && entry.revision > 1 && <span className={mutedClass}>已编辑</span>}
          </header>
          {entry.title && <h3 className="text-base font-medium">{entry.title}</h3>}
          {notes && <p className={mutedClass}>{noteState(entry)}</p>}
          {entry.kind === 'reference' ? (
            entry.blocks?.length ? <div className="space-y-3">{entry.blocks.map(block =>
              <section key={block.id} className="space-y-2 border-l border-[#e1d5c6] pl-3">
                <p className={mutedClass}>{block.source_label}{block.author ? ` · ${authorLabel(block.author)}` : ''}
                  {block.display_revision !== undefined && block.display_revision !== block.observed_revision
                    ? ` · ${block.editor ? authorLabel(block.editor) : ''}已编辑` : ''}</p>
                {block.status === 'available' ? <>
                  {block.text && <p className="whitespace-pre-wrap break-words">{block.text}</p>}
                  <Attachments ids={block.asset_ids ?? []} />
                </> : <p className={mutedClass}>{unreadable[block.status]}</p>}
                {block.id === 'card' && block.observed_revision !== undefined && block.display_revision !== undefined
                  && block.observed_revision !== block.display_revision && <ReferenceHistory postId={entry.id} block={block} />}
                {block.editable ? <button type="button" className={actionClass} disabled={busy || Boolean(editor)} onClick={() => void openEdit(entry, block)}><Pencil size={14} />编辑来源</button> : block.status === 'available' && <p className={mutedClass}>此来源只读。</p>}
              </section>)}</div> : <p className={mutedClass}>暂时读不到原文。</p>
          ) : <>
            {entry.body && <p className="whitespace-pre-wrap break-words">{entry.body}</p>}
            <Attachments ids={entry.asset_ids ?? []} />
          </>}
          {(entry.author === ownerActor || entry.kind === 'reference') && <div className="flex flex-wrap gap-2">
            <button type="button" className={actionClass} disabled={busy || Boolean(editor)} onClick={() => void openEdit(entry)}><Pencil size={14} />{entry.kind === 'reference' ? '编辑展示标题' : '编辑'}</button>
            <button type="button" className={actionClass} disabled={busy || Boolean(editor)} onClick={() => void remove(entry)}><Trash2 size={14} />{entry.kind === 'reference' ? '从朋友圈移除' : '删除'}</button>
          </div>}
        </article>)}
        {cursor && <button type="button" className={actionClass} disabled={busy || loading} onClick={() => void load(cursor)}>加载更多</button>}
      </>}
    </div>
  </main>
}

function LivingRoomMoments() {
  const [items, setItems] = useState<LivingRoomPost[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const load = useCallback(async (next: string | null = null) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(null)
    if (next === null) {
      setItems([])
      setCursor(null)
    }
    try {
      const query = new URLSearchParams({ limit: '20' })
      if (next) query.set('cursor', next)
      const page = await readContent<{ items: LivingRoomPost[]; next_cursor: string | null }>(
        '/api/v1/content/moments-external?' + query, { signal: controller.signal },
      )
      if (controller.signal.aborted) return
      setCursor(page.next_cursor)
      setItems(current => [...new Map([...current, ...page.items].map(post => [post.id, post])).values()])
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof ContentRequestError && failure.status === 403) {
          setItems([])
          setCursor(null)
        }
        setError(errorMessage(failure))
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [])
  useEffect(() => {
    void load()
    return () => request.current?.abort()
  }, [load])
  return <section className="space-y-3" aria-label="扎西德勒客厅">
    <header className="flex items-center justify-between">
      <h2 className="font-medium">扎西德勒客厅</h2>
      <button type="button" className={actionClass} disabled={busy} onClick={() => void load()}><RefreshCw size={14} />刷新</button>
    </header>
    {error && <p className={errorClass} role="alert">{error}</p>}
    {busy && <p className={mutedClass} role="status">读取中…</p>}
    {!busy && !error && !items.length && <p className={mutedClass}>当前没有可读的客厅帖子。</p>}
    {items.map(post => <article key={post.id} className={`${cardClass} space-y-2`}>
      <p className={mutedClass}>{post.author_name ?? '原作者署名暂不可用'} · {dateLabel(post.created_at)}
        {' · '}{post.source_kind === 'archive_item' ? '会后存档' : '原帖'}
        {' · '}{post.scope === 'everyone' ? '客厅成员可见' : post.scope === 'attendees' ? '参与者及源端授权对象' : '个人及源端授权对象'}</p>
      <p className="whitespace-pre-wrap break-words">{post.text}</p>
    </article>)}
    {cursor && <button type="button" className={actionClass} disabled={busy} onClick={() => void load(cursor)}>加载更多</button>}
  </section>
}
