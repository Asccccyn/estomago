import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { materializeImage } from '../../apps/host/src/media/model-input.ts';
import { MODEL_IMAGE_MAX_PIXELS, clearModelViewCache, modelImageView } from '../../apps/host/src/media/model-view.ts';

async function jpeg(width: number, height: number, marked = false): Promise<Buffer> {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  const gradient = context.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, '#274a8f')
  gradient.addColorStop(1, '#e8a33d')
  context.fillStyle = gradient
  context.fillRect(0, 0, width, height)
  // Fine texture keeps the encoder from shrinking the picture to almost nothing.
  context.fillStyle = 'rgba(255,255,255,0.35)'
  for (let y = 0; y < height; y += 7) context.fillRect(0, y, width, 1)
  if (marked) { context.fillStyle = '#e01e1e'; context.fillRect(0, 0, Math.round(width / 8), Math.round(height / 8)) }
  return Buffer.from(await canvas.encode('jpeg', 90))
}

/** An APP1 segment holding only an orientation tag; 6 turns the picture a quarter clockwise for display. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0])
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 8 + tiff.length]), Buffer.from('Exif\0\0', 'latin1'), tiff])
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

async function isRed(image: Awaited<ReturnType<typeof loadImage>>, x: number, y: number): Promise<boolean> {
  const context = createCanvas(1, 1).getContext('2d')
  context.drawImage(image, Math.round(x), Math.round(y), 1, 1, 0, 0, 1, 1)
  const [red, green] = context.getImageData(0, 0, 1, 1).data
  return red > 180 && green < 90
}

test('超过像素预算的 JPEG 以缩小视图送模型，画面比例不变', async () => {
  clearModelViewCache()
  const original = { bytes: await jpeg(3000, 2250, true), mime: 'image/jpeg' }
  const view = await modelImageView('landscape', original)
  assert.equal(view.mime, 'image/jpeg')
  assert.ok(view.bytes.byteLength < original.bytes.byteLength / 4)
  const image = await loadImage(view.bytes)
  assert.ok(image.width * image.height <= MODEL_IMAGE_MAX_PIXELS)
  assert.ok(image.width * image.height >= MODEL_IMAGE_MAX_PIXELS * 0.98)
  assert.ok(Math.abs(image.width / image.height - 3000 / 2250) < 0.01)
  assert.equal(await isRed(image, image.width / 16, image.height / 16), true)
  assert.equal(await isRed(image, image.width * 15 / 16, image.height / 16), false)
})

test('带 EXIF 方向的照片按显示方向缩小', async () => {
  clearModelViewCache()
  const original = { bytes: withOrientation(await jpeg(2400, 1600, true), 6), mime: 'image/jpeg' }
  const view = await modelImageView('portrait', original)
  const image = await loadImage(view.bytes)
  // Stored sideways as 2400×1600: the view is the upright 1600×2400 picture, scaled down.
  assert.ok(image.height > image.width)
  assert.ok(image.width * image.height <= MODEL_IMAGE_MAX_PIXELS)
  assert.equal(await isRed(image, image.width * 15 / 16, image.height / 16), true)
  assert.equal(await isRed(image, image.width / 16, image.height / 16), false)
})

test('预算内的图片和动图原样发送', async () => {
  clearModelViewCache()
  const small = { bytes: await jpeg(640, 480), mime: 'image/jpeg' }
  assert.equal(await modelImageView('small', small), small)
  const png = { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+JT1gAAAAASUVORK5CYII=', 'base64'), mime: 'image/png' }
  assert.equal(await modelImageView('png', png), png)
  const gif = { bytes: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), mime: 'image/gif' }
  assert.equal(await modelImageView('gif', gif), gif)
})

test('透明来源的 PNG 视图仍是 PNG', async () => {
  clearModelViewCache()
  const canvas = createCanvas(2000, 1400)
  const context = canvas.getContext('2d')
  context.fillStyle = '#2aa56a'
  context.beginPath(); context.arc(1000, 700, 500, 0, Math.PI * 2); context.fill()
  const view = await modelImageView('drawing', { bytes: Buffer.from(await canvas.encode('png')), mime: 'image/png' })
  assert.equal(view.mime, 'image/png')
  const image = await loadImage(view.bytes)
  assert.ok(image.width * image.height <= MODEL_IMAGE_MAX_PIXELS)
  assert.ok(image.width > image.height)
})

test('无法解码的图片原样发送', async () => {
  clearModelViewCache()
  const broken = { bytes: Buffer.from('not an image at all'), mime: 'image/jpeg' }
  assert.equal(await modelImageView('broken', broken), broken)
})

test('文件头声明尺寸过大的图片不解码，原样发送', async () => {
  clearModelViewCache()
  // A one-pixel PNG whose header claims 30000×20000: reading it is cheap, decoding it is not.
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+JT1gAAAAASUVORK5CYII=', 'base64')
  bytes.writeUInt32BE(30000, 16)
  bytes.writeUInt32BE(20000, 20)
  const declared = { bytes, mime: 'image/png' }
  const started = performance.now()
  assert.equal(await modelImageView('declared', declared), declared)
  assert.ok(performance.now() - started < 5000)
})

test('WebP 大图的视图是 PNG', async () => {
  clearModelViewCache()
  const canvas = createCanvas(2000, 1500)
  const context = canvas.getContext('2d')
  context.fillStyle = '#2aa56a'
  context.fillRect(0, 0, 2000, 1500)
  context.fillStyle = '#f2d24b'
  context.fillRect(400, 300, 1200, 900)
  const view = await modelImageView('webp', { bytes: Buffer.from(await canvas.encode('webp', 90)), mime: 'image/webp' })
  assert.equal(view.mime, 'image/png')
  const image = await loadImage(view.bytes)
  assert.ok(image.width * image.height <= MODEL_IMAGE_MAX_PIXELS)
  assert.ok(Math.abs(image.width / image.height - 4 / 3) < 0.01)
})

test('同一资产在一个进程内只生成一次视图', async () => {
  clearModelViewCache()
  const original = { bytes: await jpeg(2400, 1600), mime: 'image/jpeg' }
  const first = await modelImageView('once', original)
  assert.equal(await modelImageView('once', original), first)
})

test('各接入共用的物化边界输出视图，小图逐字节不变', async () => {
  clearModelViewCache()
  const big = await jpeg(3000, 2250)
  const block = await materializeImage('asset-big', async () => ({ bytes: big, mime: 'image/jpeg' }))
  assert.equal(block.source.media_type, 'image/jpeg')
  assert.equal(block.source.data, (await modelImageView('asset-big', { bytes: big, mime: 'image/jpeg' })).bytes.toString('base64'))
  assert.ok(Buffer.from(block.source.data, 'base64').byteLength < big.byteLength)
  const tiny = await jpeg(320, 240)
  assert.deepEqual(await materializeImage('asset-tiny', async () => ({ bytes: tiny, mime: 'image/jpeg' })),
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: tiny.toString('base64') } })
})
