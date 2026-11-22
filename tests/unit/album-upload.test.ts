import assert from 'node:assert/strict'
import test from 'node:test'
import { albumUploadReceipt, readAlbumUploadReceipt, reselectAlbumUpload, startAlbumUpload, uploadAlbumEntry,
  type AlbumUpload } from '../../apps/web/react/src/album-upload.ts'

test('相册直传先确认落正，归类失败后重试沿同一资产和原操作键', async () => {
  const file = new File(['photo fixture'], 'photo.png', { type: 'image/png' })
  const original = await startAlbumUpload({ key: 'upload-one', album: 'chat_screenshots' }, file)
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
  await uploadAlbumEntry(await startAlbumUpload({ key: 'gif-one', album: 'stickers' }, file), () => {}, request)
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

test('作品导入归类失败时保留原文件身份及标题，重试不重复上传', async () => {
  const file = new File(['<!doctype html><html><body>fixture</body></html>'], 'fixture.html', { type: 'text/html' })
  let attempt = await startAlbumUpload({ key: 'work-one', album: 'creations', title: file.name }, file)
  let uploads = 0, entries = 0
  const request: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/v1/assets?purpose=creation_work') {
      uploads++
      return Response.json({ asset_id: 'asset-work', mime_type: 'text/html', state: 'available', m_sync_state: 'synced' }, { status: 201 })
    }
    if (url === '/api/v1/assets/asset-work') return Response.json({ id: 'asset-work', mime_type: 'text/html', state: 'available', m_sync_state: 'synced' })
    assert.equal(url, '/api/v1/content/creations')
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'work-one:entry')
    assert.deepEqual(JSON.parse(String(init?.body)), { work_asset_id: 'asset-work', work_kind: 'html', title: 'fixture.html' })
    entries++
    return entries === 1 ? Response.json({ error: { code: 'content_write_unknown' } }, { status: 504 }) : Response.json({ id: 'creation-work' })
  }
  const record = (stored: AlbumUpload) => { attempt = stored }
  await assert.rejects(uploadAlbumEntry(attempt, record, request), /content_write_unknown/)
  await uploadAlbumEntry(attempt, record, request)
  assert.equal(uploads, 1)
  assert.equal(entries, 2)
})

test('尚未确认资产的恢复记录绑定原文件内容、用途与键，刷新不用保存文件字节', async () => {
  const file = new File(['abc'], 'fixture.html', { type: 'text/html' })
  const original = await startAlbumUpload({ key: 'original-key', album: 'creations', title: file.name }, file)
  const saved = readAlbumUploadReceipt(albumUploadReceipt(original))!
  assert.deepEqual(saved, { key: 'original-key', album: 'creations', title: file.name,
    fileDigest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' })
  await assert.rejects(reselectAlbumUpload(saved, new File(['xyz'], file.name, { type: file.type })), /与原文件不同/)
  await assert.rejects(uploadAlbumEntry(saved, () => {}, async () => assert.fail('must reselect before sending any request')), /重选原文件/)
  const renamed = new File(['abc'], 'renamed.html', { type: 'text/html' })
  const reselected = await reselectAlbumUpload(saved, renamed)
  const urls: string[] = []
  await uploadAlbumEntry(reselected, () => {}, async (url, init) => {
    urls.push(String(url))
    if (urls.length === 1) {
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), saved.key)
      assert.equal(init?.body, renamed)
      return Response.json({ asset_id: 'original-asset', mime_type: 'text/html', state: 'available', m_sync_state: 'synced' })
    }
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), `${saved.key}:entry`)
    assert.deepEqual(JSON.parse(String(init?.body)), { work_asset_id: 'original-asset', work_kind: 'html', title: file.name })
    return Response.json({ id: 'one-entry' })
  })
  assert.deepEqual(urls, ['/api/v1/assets?purpose=creation_work', '/api/v1/content/creations'])
})
