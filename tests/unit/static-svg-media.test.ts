import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { ContentServer } from '../../apps/content/src/service.ts';
import { ContentOperationCoordinator } from '../../apps/host/src/integrations/content/coordinator.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { materializeBlocks } from '../../apps/host/src/media/model-input.ts';
import { renderStaticSvg } from '../../apps/host/src/media/static-svg.ts';
import { ContentToolsService } from '../../apps/host/src/modules/content/service.ts';
import { MediaToolsService } from '../../apps/host/src/modules/media/service.ts';
import { handleAssetsRoutes } from '../../apps/host/src/server/routes/assets.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { makeDb, makePaths, tempRoot } from '../helpers.ts';

const frame = (body: string, attrs = '') =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1024" ${attrs}>${body}</svg>`);
const safe = frame('<rect width="2048" height="1024" style="fill:#123456;opacity:1"/>');

test('SVG 静态门拦住外部引用、脚本、事件、动画与可执行嵌入', async () => {
  for (const source of [
    frame('<image href="https://invalid.example/image.png"/>'),
    frame('<script>throw "should not run"</script>'),
    frame('<rect width="1" height="1" onload="throw 1"/>'),
    frame('<circle r="5"><animate attributeName="r" values="1;5;1" dur="2s"/></circle>'),
    frame('<rect width="1" height="1" fill="url(https://invalid.example/p.svg#p)"/>'),
    frame('<foreignObject width="1" height="1"/>'),
    Buffer.concat([Buffer.from('<?xml-stylesheet href="file:///fixture.css"?>'), safe]),
    Buffer.concat([Buffer.from('<!DOCTYPE svg [<!ENTITY text "sample">]>'), safe]),
  ]) assert.equal(await renderStaticSvg(source), null);
});

test('资产 HTTP 保存原 SVG 与绑定 PNG，发送和预览复用 PNG，重传不新增资产', async t => {
  const { db, root } = makeDb(tempRoot('static-svg-assets-'), { seed: false });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const config = buildConfig({});
  const objects = new Map<string, Buffer>();
  const store = {
    uploadBytes: async (bytes: Buffer) => {
      const content_hash = sha256Hex(bytes);
      objects.set(content_hash, bytes);
      return { content_hash };
    },
  };
  const media = new MediaService(db, makePaths(root).mediaDir, config, store as never);
  const invoke = async (method: string, route: string, body?: Buffer) => {
    const url = new URL(route, 'http://local-fixture.invalid');
    const req = Object.assign(Readable.from(body ? [body] : []), { headers: { 'idempotency-key': 'svg-one' } });
    let status = 0;
    let headers = {} as Record<string, string>;
    let data = Buffer.alloc(0);
    const res = {
      writeHead(code: number, newHeaders: Record<string, string>) { status = code; headers = newHeaders; },
      end(value: string | Buffer) { data = Buffer.from(value); },
    };
    await handleAssetsRoutes(req as never, res as never, { media, config } as never, `${method} ${url.pathname}`, url);
    return { status, headers, data };
  };

  const first = await invoke('POST', '/api/v1/assets?purpose=chat_image', safe);
  assert.equal(first.status, 201, first.data.toString());
  const { asset_id: id, mime_type, model_image_ready } = JSON.parse(first.data.toString()) as { asset_id: string; mime_type: string; model_image_ready: boolean };
  assert.equal(mime_type, 'image/svg+xml');
  assert.equal(model_image_ready, true);
  const repeated = await invoke('POST', '/api/v1/assets?purpose=chat_image', safe);
  assert.equal(JSON.parse(repeated.data.toString()).asset_id, id);
  assert.equal(objects.size, 2);
  const row = db.prepare('SELECT id FROM media_assets WHERE origin_ref=?').get(id) as { id: string };
  assert.equal(media.originalImageAsset(media.getAsset(row.id)).id, id);
  assert.equal(media.isAssetReferenced(row.id).referenced, true);
  assert.equal(media.getAsset(id).m_content_hash, sha256Hex(safe));

  const original = await invoke('GET', `/api/v1/assets/${id}/content`);
  const image = await invoke('GET', `/api/v1/assets/${id}/content?view=image`);
  assert.deepEqual(original.data, safe);
  assert.equal(image.headers['Content-Type'], 'image/png');
  assert.equal(image.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(image.data.readUInt32BE(16), 1024);
  assert.equal(image.data.readUInt32BE(20), 512);
  assert.doesNotThrow(() => media.validateForSend([{ asset_id: id, presentation: 'image' }]));
  const [block] = await materializeBlocks([{ type: 'asset_image', asset_id: id, projection_version: 'v1' }], media);
  assert.deepEqual(block, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data.toString('base64') } });

  const conflicting = await invoke('POST', '/api/v1/assets?purpose=chat_image', frame('<rect width="10" height="10"/>'));
  assert.equal(conflicting.status, 409);
  const originalCode = await media.saveBuffer({ bytes: frame('<circle r="5"><animate attributeName="r" dur="1s"/></circle>'), purpose: 'creation_icon', operationId: 'animated-work', createdBy: 'jiaming', origin: 'generated' });
  assert.doesNotThrow(() => media.validateForSend([{ asset_id: originalCode.id, presentation: 'work' }]));
  assert.throws(() => media.validateForSend([{ asset_id: originalCode.id, presentation: 'image' }]), /不接受 image\/svg\+xml/);
});

test('模型作品工具把静态 SVG 原件归相册，动画保留作品；media_view 实际提供 PNG', async t => {
  const { db, root } = makeDb(tempRoot('static-svg-content-'), { seed: false });
  const paths = makePaths(root);
  const content = new ContentServer({ stateRoot: `${root}/content`, port: 0, token: 'fixture-only' });
  const client = { baseUrl: 'http://in-process-content.invalid', token: content.token };
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await content.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, client.baseUrl);
    const stream = Readable.from(init?.body ? [Buffer.from(String(init.body))] : []);
    const req = Object.assign(stream, {
      url: url.pathname + url.search, method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers)),
    });
    let status = 500;
    let json = '';
    const res = { writeHead: (value: number) => { status = value; }, end: (value: string) => { json = value; } };
    await (content as unknown as { handle(request: unknown, response: unknown): Promise<void> }).handle(req, res);
    return new Response(json, { status });
  };
  const store = { uploadBytes: async (bytes: Buffer) => ({ content_hash: sha256Hex(bytes) }) };
  const media = new MediaService(db, paths.mediaDir, buildConfig({}), store as never);
  const contentOps = new ContentOperationCoordinator({ db, media, client, logger: { warn() {}, info() {}, error() {} } as never });
  const tools = new ContentToolsService({ media, contentClient: client, contentOps });
  const context = {
    roomId: 'primary', turnId: null, requestId: 'r', purpose: 'chat' as const, activeReviewId: null, seenSequence: 0, seenMessages: [],
  };
  const args = { format: 'svg' as const, content: safe.toString(), client_operation_id: 'static-original' };
  const result = await tools.creationSaveArtifact(args, context);
  assert.equal(result.ok, true, JSON.stringify(result.output));
  const { asset_id: assetId, album_entry_id: albumEntryId } = result.output as { asset_id: string; album_entry_id: string };
  assert.ok(assetId && albumEntryId);
  assert.equal(content.db.prepare('SELECT asset_id FROM album_entries WHERE id=?').get(albumEntryId)?.asset_id, assetId);
  const replay = await tools.creationSaveArtifact(args, context);
  assert.equal(replay.output.album_entry_id, albumEntryId);
  const visual = await new MediaToolsService({ db, media, contentClient: client }).mediaView({ asset_ref: `est:${assetId}` }, context);
  assert.equal(visual.ok, true, JSON.stringify(visual.output));
  assert.equal(visual.output.mime_type, 'image/png');
  assert.deepEqual(visual.imageRefs, [assetId]);

  const animated = await tools.creationSaveArtifact({
    ...args, content: frame('<circle r="5"><animate attributeName="r" values="1;5;1" dur="2s"/></circle>').toString(),
    client_operation_id: 'animated-original',
  }, context);
  assert.equal(animated.ok, true, JSON.stringify(animated.output));
  assert.ok(animated.output.creation_id);
  assert.equal(content.db.prepare('SELECT count(*) AS n FROM creations').get()?.n, 1);
  assert.equal(content.db.prepare('SELECT count(*) AS n FROM album_entries').get()?.n, 1);
});
