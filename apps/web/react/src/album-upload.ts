export type PhotoAlbum = 'important_photos' | 'chat_screenshots'
export type UploadAlbum = PhotoAlbum | 'stickers'

type UploadRequest = { key: string; album: UploadAlbum }
export type AlbumUpload = UploadRequest & ({ file: File; assetId?: never } | { assetId: string; file?: never })

type AssetReceipt = {
  asset_id?: string
  state?: string
  mime_type?: string
  model_image_ready?: boolean
  m_sync_state?: 'pending' | 'synced' | 'out_of_scope'
  error?: { code?: string; message?: string }
}

type EntryReceipt = { id?: string; error?: AssetReceipt['error'] }

function failure(stage: string, response: Response, error?: AssetReceipt['error']): Error {
  return new Error(`${stage}失败（${error?.code ?? `HTTP ${response.status}`}）${error?.message ? ` ${error.message}` : ''}`)
}

/** 一旦收到资产身份，后续重试依据同一资产与关系操作键，不再提交文件字节。 */
export async function uploadAlbumEntry(
  attempt: AlbumUpload,
  onAssetStored: (attempt: AlbumUpload) => void,
  request: typeof fetch = fetch,
): Promise<void> {
  let assetId = attempt.assetId
  let asset: AssetReceipt
  if (assetId !== undefined) {
    const response = await request(`/api/v1/assets/${encodeURIComponent(assetId)}`)
    asset = (await response.json().catch(() => ({}))) as AssetReceipt
    if (!response.ok) throw failure(`读取资产 ${assetId}`, response, asset.error)
  } else {
    const purpose = attempt.album === 'stickers' ? 'chat_sticker' : 'chat_image'
    const response = await request(`/api/v1/assets?purpose=${purpose}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': attempt.key },
      body: attempt.file,
    })
    asset = (await response.json().catch(() => ({}))) as AssetReceipt
    if (!response.ok) throw failure('上传', response, asset.error)
    assetId = asset.asset_id
    if (!assetId) throw new Error('上传回执不完整。使用本次操作重试可核对原资产。')
    onAssetStored({ key: attempt.key, album: attempt.album, assetId })
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
  if (asset.mime_type === 'image/svg+xml' && asset.model_image_ready !== true) {
    throw new Error(`SVG 原件已保存，PNG 视图仍待确认（${assetId}）。可稍后继续入库。`)
  }
  const response = await request(`/api/v1/content/albums/${attempt.album}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${attempt.key}:entry` },
    body: JSON.stringify({ asset_id: assetId }),
  })
  const entry = (await response.json().catch(() => ({}))) as EntryReceipt
  if (!response.ok) throw failure(`归类（资产 ${assetId}）`, response, entry.error)
  if (!entry.id) throw new Error(`归类回执不完整（资产 ${assetId}）。使用本次操作重试可核对原条目。`)
}
