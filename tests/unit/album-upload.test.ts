import assert from 'node:assert/strict'
import test from 'node:test'
import { uploadAlbumEntry, type AlbumUpload } from '../../apps/web/react/src/album-upload.ts'

test('相册直传先确认落正，归类失败后重试沿同一资产和原操作键', async () => {
  const file = new File(['photo fixture'], 'photo.png', { type: 'image/png' })
  const original: AlbumUpload = { key: 'upload-one', album: 'chat_screenshots', file }
  let attempt: AlbumUpload = original
  const recordAsset = (stored: AlbumUpload) => { attempt = stored }
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let entryRequests = 0
  const request: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === '/api/v1/assets?purpose=chat_image') {
      assert.equal(init?.body, file)
      return Response.json({ asset_id: 'asset-1', state: 'available', m_sync_state: 'pending' }, { status: 201 })
    }
    if (url === '/api/v1/assets/asset-1') {
      return Response.json({ id: 'asset-1', state: 'available', m_sync_state: 'synced' })
    }
    assert.equal(url, '/api/v1/content/albums/chat_screenshots/entries')
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'upload-one:entry')
    assert.deepEqual(JSON.parse(String(init?.body)), { asset_id: 'asset-1' })
    entryRequests++
    return entryRequests === 1
      ? Response.json({ error: { code: 'content_write_unknown', message: '回执待核' } }, { status: 504 })
      : Response.json({ id: 'entry-1' }, { status: 200 })
  }

  await assert.rejects(uploadAlbumEntry(attempt, recordAsset, request), /文件已保存，源端仍待确认/)
  assert.equal(calls.length, 1)
  assert.deepEqual(attempt, { key: original.key, album: original.album, assetId: 'asset-1' })
  await assert.rejects(uploadAlbumEntry(attempt, recordAsset, request), /asset-1.*content_write_unknown/)
  await uploadAlbumEntry(attempt, recordAsset, request)
  assert.equal(calls.filter(call => call.init?.body === file).length, 1)
  assert.equal(entryRequests, 2)
})

test('动图表情直传与相册使用各自用途和集合', async () => {
  const file = new File(['sticker fixture'], 'sticker.gif', { type: 'image/gif' })
  const urls: string[] = []
  const request: typeof fetch = async (input, init) => {
    const url = String(input)
    urls.push(url)
    if (urls.length === 1) {
      assert.equal(init?.body, file)
      return Response.json({ asset_id: 'asset-gif', mime_type: 'image/gif', state: 'available', m_sync_state: 'synced' }, { status: 201 })
    }
    assert.deepEqual(JSON.parse(String(init?.body)), { asset_id: 'asset-gif' })
    return Response.json({ id: 'entry-sticker' }, { status: 201 })
  }
  await uploadAlbumEntry({ key: 'gif-one', album: 'stickers', file }, () => {}, request)
  assert.deepEqual(urls, ['/api/v1/assets?purpose=chat_sticker', '/api/v1/content/albums/stickers/entries'])
})

test('现有代码作品不可经收藏入口归类为表情', async () => {
  const request: typeof fetch = async (input, init) => {
    assert.equal(String(input), '/api/v1/assets/asset-html')
    assert.equal(init, undefined)
    return Response.json({ id: 'asset-html', mime_type: 'text/html', state: 'available', m_sync_state: 'synced' })
  }
  await assert.rejects(uploadAlbumEntry({ key: 'album-one', album: 'stickers', assetId: 'asset-html' }, () => {}, request), /格式不支持加入表情包/)
})
