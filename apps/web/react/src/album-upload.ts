export type PhotoAlbum = 'important_photos' | 'chat_screenshots'
export type UploadAlbum = PhotoAlbum | 'stickers' | 'creations'

type UploadRequest = { key: string; album: UploadAlbum; title?: string }
/** Awaiting a re-selected file after a reload, holding the picked file, or holding the
 *  asset identity so that a retry never resends bytes. */
export type AlbumUpload = UploadRequest & { file?: File; assetId?: string }

const albums: ReadonlySet<unknown> = new Set<UploadAlbum>(['important_photos', 'chat_screenshots', 'stickers', 'creations'])

export const UPLOAD_TIMEOUT_MS = 180_000

// Store the original request only, so a reload does not keep a second copy of the file.
export function albumUploadReceipt(attempt: AlbumUpload): string {
  const { file, ...receipt } = attempt
  return JSON.stringify(receipt)
}

export function readAlbumUploadReceipt(raw: string | null): AlbumUpload | null {
  try {
    const saved = JSON.parse(raw ?? 'null') as Record<string, unknown> | null
    if (!saved || !albums.has(saved.album) || typeof saved.key !== 'string' || !saved.key || saved.key.length > 256) return null
    const request = { key: saved.key, album: saved.album as UploadAlbum,
      ...(typeof saved.title === 'string' ? { title: saved.title } : {}) }
    // Receipts saved by earlier builds also carried a file digest. The upload key now
    // carries that check on the server, so the digest is read but no longer used.
    if (typeof saved.assetId === 'string' && saved.assetId) return { ...request, assetId: saved.assetId }
    return request
  } catch { return null }
}

export function startAlbumUpload(request: UploadRequest, file: File): AlbumUpload {
  // The file goes straight into the upload request. Reading it here first added nothing
  // the server does not already check, and a stalled read left the panel on "uploading".
  return { ...request, file }
}

export function reselectAlbumUpload(attempt: AlbumUpload, file: File): AlbumUpload {
  return { key: attempt.key, album: attempt.album, ...(attempt.title === undefined ? {} : { title: attempt.title }), file }
}

type AssetReceipt = {
  asset_id?: string
  state?: string
  mime_type?: string
  model_image_ready?: boolean
  m_sync_state?: 'staged' | 'pending' | 'synced' | 'out_of_scope'
  error?: { code?: string; message?: string }
}

type EntryReceipt = { id?: string; error?: AssetReceipt['error'] }

function failure(stage: string, response: Response, error?: AssetReceipt['error']): Error {
  return new Error(`${stage}失败（${error?.code ?? `HTTP ${response.status}`}）${error?.message ? ` ${error.message}` : ''}`)
}

/** A request that never answers must not leave the panel on "uploading" forever. */
async function send(request: typeof fetch, url: string, init: RequestInit, stage: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await request(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${stage}超时，网络可能较慢。重试会沿用本次操作，同一文件不会重复保存。`)
    throw error
  } finally { clearTimeout(timer) }
}

/** 每一步把可恢复的记录交回面板保存。一旦收到资产身份，后续重试依据同一资产与关系操作键，不再提交文件字节。 */
export async function uploadAlbumEntry(
  attempt: AlbumUpload,
  onRecord: (record: AlbumUpload) => void,
  request: typeof fetch = fetch,
  timeoutMs: number = UPLOAD_TIMEOUT_MS,
): Promise<void> {
  let assetId = attempt.assetId
  let asset: AssetReceipt
  if (assetId !== undefined) {
    const response = await send(request, `/api/v1/assets/${encodeURIComponent(assetId)}`, {}, `读取资产 ${assetId}`, timeoutMs)
    asset = (await response.json().catch(() => ({}))) as AssetReceipt
    if (!response.ok) throw failure(`读取资产 ${assetId}`, response, asset.error)
  } else {
    if (!attempt.file) throw new Error('请重选原文件以核对本次上传。')
    const purpose = attempt.album === 'creations' ? 'creation_work' : attempt.album === 'stickers' ? 'chat_sticker' : 'chat_image'
    const response = await send(request, `/api/v1/assets?purpose=${purpose}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': attempt.key },
      body: attempt.file,
    }, '上传', timeoutMs)
    asset = (await response.json().catch(() => ({}))) as AssetReceipt
    // After a lost receipt the same key is retried with a re-selected file. The server
    // replays the original asset for the same bytes and refuses different bytes, which
    // leaves the record awaiting the original file instead of the rejected one.
    if (response.status === 409 && asset.error?.code === 'idempotency_conflict') {
      onRecord({ key: attempt.key, album: attempt.album, ...(attempt.title === undefined ? {} : { title: attempt.title }) })
      throw new Error('选中的文件内容与原文件不同。请重选原文件，或结束此次操作。')
    }
    if (!response.ok) throw failure('上传', response, asset.error)
    assetId = asset.asset_id
    if (!assetId) throw new Error('上传回执不完整。使用本次操作重试可核对原资产。')
    onRecord({ key: attempt.key, album: attempt.album, assetId, ...(attempt.title === undefined ? {} : { title: attempt.title }) })
  }

  if (asset.state !== 'available' || asset.m_sync_state !== 'synced') {
    if (asset.state === 'available' && asset.m_sync_state === 'pending') {
      throw new Error(`文件已保存，源端仍待确认（${assetId}）。可稍后继续入库。`)
    }
    throw new Error(`资产状态未确认（${assetId}），本次未建立收藏关系。`)
  }
  if (attempt.album === 'stickers' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.mime_type ?? '')) {
    throw new Error(`资产 ${assetId} 的格式不支持加入表情包。`)
  }
  if (attempt.album !== 'creations' && asset.mime_type === 'image/svg+xml' && asset.model_image_ready !== true) {
    throw new Error(`SVG 原件已保存，PNG 视图仍待确认（${assetId}）。可稍后继续入库。`)
  }
  const workKind = asset.mime_type === 'image/svg+xml' ? 'svg' : asset.mime_type === 'text/html' ? 'html' : undefined
  if (attempt.album === 'creations' && !workKind) throw new Error(`资产 ${assetId} 不是支持导入的 HTML/SVG 代码作品。图片请使用相册。`)
  const response = await send(request, attempt.album === 'creations' ? '/api/v1/content/creations' : `/api/v1/content/albums/${attempt.album}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${attempt.key}:entry` },
    body: JSON.stringify(attempt.album === 'creations' ? {
      work_asset_id: assetId, work_kind: workKind, ...(attempt.title === undefined ? {} : { title: attempt.title }),
    } : { asset_id: assetId }),
  }, `归类（资产 ${assetId}）`, timeoutMs)
  const entry = (await response.json().catch(() => ({}))) as EntryReceipt
  if (!response.ok) throw failure(`归类（资产 ${assetId}）`, response, entry.error)
  if (!entry.id) throw new Error(`归类回执不完整（资产 ${assetId}）。使用本次操作重试可核对原条目。`)
}
