// P1（四仓合并审计 20261106，F06/F07）验收：当前集合保护、统一命令身份/重放、
// 生命周期故障（提交丢响应/登记写锁/重启恢复）、引用入口收回、旧回执兼容、消息历史保护。
// 全部走真实入口（Host HTTP→协调器→content 独立进程 HTTP），夹具仅注入网络断点与写锁。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { ContentServer, sha256ish } from '../../apps/content/src/service.ts';
import { ContentOperationCoordinator } from '../../apps/host/src/integrations/content/coordinator.ts';
import { contentForward } from '../../apps/host/src/integrations/content/client.ts';
import type { MariposaMediaStore } from '../../apps/host/src/integrations/mariposa/media-store.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { albumUploadReceipt, readAlbumUploadReceipt, reselectAlbumUpload, startAlbumUpload, uploadAlbumEntry,
  type AlbumUpload } from '../../apps/web/react/src/album-upload.ts';

const root = tempRoot('f0607-p1-');
writeApprovedIdentity(root);
const contentRoot = path.join(root, 'content');
let contentServer: ContentServer;
let host: Host;
let config: ReturnType<typeof buildConfig>;
let mediaDir: string;
let base = '';
let token = '';
const auth = (extra: Record<string, string> = {}): Record<string, string> => ({ Authorization: `Bearer ${token}`, ...extra });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001b3fcd4e', 'hex');

async function uploadAsset(opKey: string): Promise<string> {
  const r = await fetch(`${base}/api/v1/assets?purpose=chat_image`, { method: 'POST', headers: auth({ 'Content-Type': 'image/png', 'Idempotency-Key': opKey }), body: new Uint8Array(PNG) });
  assert.equal(r.status, 201);
  return ((await r.json()) as { asset_id: string }).asset_id;
}
async function deleteAsset(id: string): Promise<number> {
  return (await fetch(`${base}/api/v1/assets/${encodeURIComponent(id)}`, { method: 'DELETE', headers: auth() })).status;
}
async function contentWrite(method: 'POST' | 'PUT' | 'DELETE', p: string, body: unknown | undefined, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${p}`, { method, headers: auth({ 'Content-Type': 'application/json', Origin: base, ...headers }), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  contentServer = new ContentServer({ stateRoot: contentRoot, port: 0 });
  await contentServer.start();
  config = buildConfig({
    ...readyRuntimePatch(),
    deployment: { port: 0 },
    runtime: { ...readyRuntimePatch().runtime, provider: 'mock' },
    content: { enabled: true, port: contentServer.port },
  });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  mediaDir = buildPaths(root).mediaDir;
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
});
after(async () => { await host.stop(); await contentServer.stop(); });

test('C1 HTTP：正式存档保存、详情、固定修订原文与撤销', async t => {
  // A published user message may remain queued while the room is busy. Keep this turn queued
  // until the real edit endpoint exercises the supported pre-dispatch edit window.
  const enqueue = host.supervisor.enqueue;
  const queued: string[] = [];
  host.supervisor.enqueue = id => { queued.push(id); };
  t.after(async () => {
    host.supervisor.enqueue = enqueue;
    for (const id of queued) host.supervisor.enqueue(id);
    await host.supervisor.waitIdle();
  });
  const chat = '/api/v1/conversations/primary/messages';
  const original = '存档钉住的第一版';
  const message = await contentWrite('POST', chat, { content: original, client_message_id: 'archive-c1-chat' }, {});
  assert.equal(message.status, 201);
  const messageId = message.body.message.id;
  const now = new Date().toISOString();
  // Synthetic M source-sync receipt at the normal archive admission boundary.
  host.db.prepare(`INSERT INTO source_sync_receipts
    (id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .run('c1-receipt', 'c1-ingest', messageId, 'c1-source-room', 'c1-source-message', sha256Hex(original), now, now);
  const created = await contentWrite('POST', '/api/v1/archives', { kind: 'sweet', message_ids: [messageId] }, { 'Idempotency-Key': 'c1-create' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const edited = await contentWrite('PUT', `${chat}/${messageId}`, { content: '后来改过的第二版' }, { 'If-Match': '"1"' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const archive = `/api/v1/archives/${created.body.archive_id}`;
  const detail = await fetch(base + archive, { headers: auth() });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { messages: Array<{ revision: number }> }).messages[0]?.revision, 1);
  const expanded = await fetch(base + archive + '/messages', { headers: auth() });
  assert.equal(expanded.status, 200);
  const { items } = await expanded.json() as { items: Array<{ message_id: string; revision: number; text: string }> };
  assert.deepEqual(items.map(({ message_id, revision, text }) => [message_id, revision, text]), [[messageId, 1, original]]);
  const removed = await contentWrite('DELETE', archive, undefined, { 'If-Match': '"1"' });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await fetch(base + archive + '/messages', { headers: auth() })).status, 404);
});

test('C2 HTTP：上传和归类 201 正文挂住，刷新重选和续办只产生一份正本及一条关系', async () => {
  const media = (host as unknown as { mediaServiceRef: MediaService }).mediaServiceRef;
  const storeSlot = media as unknown as { mStore: MariposaMediaStore | null };
  const previousStore = storeSlot.mStore;
  const bytes = Buffer.concat([PNG, Buffer.from('c2-unique')]);
  const uploadedHashes: string[] = [];
  storeSlot.mStore = { async uploadBytes(bytes: Uint8Array) {
    const content_hash = sha256Hex(bytes);
    uploadedHashes.push(content_hash);
    return { content_hash };
  } } as unknown as MariposaMediaStore;
  const newFile = () => new File([new Uint8Array(bytes)], 'c2.png', { type: 'image/png' });
  let attempt = startAlbumUpload({ key: 'c2-upload', album: 'important_photos' }, newFile());
  const record = (value: AlbumUpload) => { attempt = value; };
  const restore = () => readAlbumUploadReceipt(albumUploadReceipt(attempt))!;
  const uploadKeys: Array<string | null> = [];
  const entryKeys: Array<string | null> = [];
  const lostStatuses: number[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const key = headers.get('Idempotency-Key');
    const keys = url.startsWith('/api/v1/assets?') ? uploadKeys : url.endsWith('/entries') ? entryKeys : null;
    keys?.push(key);
    const response = await fetch(base + url, { ...init, headers: auth({ ...Object.fromEntries(headers), Origin: base }) });
    if (keys?.length !== 1) return response;
    lostStatuses.push(response.status);
    await response.arrayBuffer();
    return new Response(new ReadableStream<Uint8Array>({}), { status: response.status, headers: response.headers });
  };
  try {
    await assert.rejects(uploadAlbumEntry(attempt, record, request, 400), /上传超时.*结果待确认/);
    assert.equal(restore().assetId, undefined);
    attempt = reselectAlbumUpload(restore(), newFile());
    await assert.rejects(uploadAlbumEntry(attempt, record, request, 400), /归类.*超时.*结果待确认/);
    const saved = restore();
    assert.ok(saved.assetId);
    assert.equal(saved.file, undefined);
    await uploadAlbumEntry(saved, record, request, 400);
    assert.deepEqual(lostStatuses, [201, 201]);
    assert.deepEqual(uploadKeys, ['c2-upload', 'c2-upload']);
    assert.deepEqual(entryKeys, ['c2-upload:entry', 'c2-upload:entry']);
    assert.deepEqual(uploadedHashes, [sha256Hex(bytes)]);
    assert.equal(host.db.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE content_sha256=?').get(sha256Hex(bytes))?.n, 1);
    assert.equal(contentServer.db.prepare('SELECT COUNT(*) AS n FROM album_entries WHERE asset_id=? AND deleted_at IS NULL').get(saved.assetId)?.n, 1);
  } finally { storeSlot.mStore = previousStore; }
});

test('C3 HTTP：普通帖子、预留留言与映射源编辑共用暂存落正及旧回执边界', async () => {
  const media = (host as unknown as { mediaServiceRef: MediaService }).mediaServiceRef;
  const storeSlot = media as unknown as { mStore: MariposaMediaStore | null };
  const previousStore = storeSlot.mStore;
  let blockedHash: string | null = null;
  const masterObjects = new Set<string>();
  let masterWrites = 0;
  storeSlot.mStore = {
    async uploadBytes(bytes: Uint8Array) {
      const content_hash = sha256Hex(Buffer.from(bytes));
      masterWrites++;
      if (blockedHash === content_hash) throw Error('synthetic master failure');
      const deduplicated = masterObjects.has(content_hash);
      masterObjects.add(content_hash);
      return { content_hash, deduplicated };
    },
  } as unknown as MariposaMediaStore;
  const stage = async (key: string) => {
    const bytes = Buffer.concat([PNG, Buffer.from(key)]);
    const response = await fetch(base + '/api/v1/assets?purpose=chat_image&staged=1', { method: 'POST',
      headers: auth({ 'Content-Type': 'application/octet-stream', 'Idempotency-Key': key, Origin: base }), body: new Uint8Array(bytes) });
    assert.equal(response.status, 201);
    const asset = await response.json() as { asset_id: string; m_sync_state: string };
    assert.equal(asset.m_sync_state, 'staged');
    return { id: asset.asset_id, hash: sha256Hex(bytes) };
  };
  try {
    const posts = '/api/v1/content/posts';
    const postImage = await stage('c3-post-image');
    const noteImage = await stage('c3-note-image');
    const replacement = await stage('c3-edit-image');
    assert.equal(masterWrites, 0);
    const post = await contentWrite('POST', posts, { body: '映射来源原帖', asset_ids: [postImage.id] }, { 'Idempotency-Key': 'c3-post-save' });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const note = await contentWrite('POST', '/api/v1/content/future-notes', { body: '预留留言', asset_ids: [noteImage.id] }, { 'Idempotency-Key': 'c3-note-save' });
    assert.equal(note.status, 201, JSON.stringify(note.body));
    assert.deepEqual(post.body.asset_ids, [postImage.id]);
    assert.deepEqual(note.body.asset_ids, [noteImage.id]);
    assert.deepEqual([...masterObjects], [postImage.hash, noteImage.hash]);

    // Real Content projection ingress, supplying a frozen source card for the host HTTP edit.
    const projected = await contentForward({ baseUrl: `http://127.0.0.1:${contentServer.port}`, token: contentServer.token }, {
      method: 'PUT', actor: 'qiaosheng', path: '/internal/heartbeat-projections/c3-staged',
      body: { mode: 'draw', conversationId: 'primary', businessDate: '2026-11-24', version: 1, state: 'drawn_no_comment', messages: [],
        card: { number: 1, source: { kind: 'moments', namespace: 'content', id: post.body.id,
          revision: 1, identity: `content:moments:${post.body.id}`, permissionScope: 'primary' } } },
    });
    assert.equal(projected.status, 200, JSON.stringify(projected.body));
    const mappingId = (projected.body as { id: string }).id;
    const source = `${posts}/${post.body.id}`;
    const edit = () => contentWrite('PUT', `/api/v1/content/moment-references/${mappingId}/blocks/card`,
      { body: '从映射编辑原帖', asset_ids: [postImage.id, replacement.id], expected_source_revision: 1 },
      { 'Idempotency-Key': 'c3-map-edit', 'If-Match': '"1"' });
    blockedHash = replacement.hash;
    const failed = await edit();
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.equal(failed.body.error.code, 'asset_master_commit_failed');
    assert.equal(media.getAsset(replacement.id).m_sync_state, 'staged');
    assert.equal((await (await fetch(base + source, { headers: auth() })).json() as { revision: number }).revision, 1);
    assert.deepEqual([...masterObjects], [postImage.hash, noteImage.hash]);
    blockedHash = null;

    const saved = await edit();
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const current = await (await fetch(base + source, { headers: auth() })).json() as { revision: number; asset_ids: string[] };
    assert.deepEqual([current.revision, current.asset_ids], [2, [postImage.id, replacement.id]]);
    for (const asset of [postImage, noteImage, replacement]) {
      assert.equal(media.getAsset(asset.id).m_sync_state, 'synced');
      assert.equal(media.isAssetReferenced(asset.id).by_external_refs, 1);
      assert.equal(await deleteAsset(asset.id), 409);
    }
    assert.deepEqual([...masterObjects], [postImage.hash, noteImage.hash, replacement.hash]);
    assert.equal(masterWrites, 4, '三次成功落正及一次暂时失败');
    assert.deepEqual(await edit(), saved, '原键连同原 If-Match 重放原回执');
    assert.equal(masterWrites, 4);
  } finally { storeSlot.mStore = previousStore; }
});

test('F01 当前完整成员：creation icon=A/work=A 只换 work=B，A 仍受保护；仅改正文不释放', async () => {
  const a = await uploadAsset('f01-a');
  const b = await uploadAsset('f01-b');
  const created = await contentWrite('POST', '/api/v1/content/creations', { bucket_id: 'bk-f01', icon_asset_id: a, work_asset_id: a, work_kind: 'image', title: 'F01' }, { 'Idempotency-Key': 'f01-c1' });
  assert.equal(created.status, 201);
  const crt = created.body;
  assert.equal((await deleteAsset(a)), 409, 'icon=A 受保护');
  const upd = await contentWrite('PUT', `/api/v1/content/creations/${crt.id}`, { work_asset_id: b, work_kind: 'image' }, { 'Idempotency-Key': 'f01-u1', 'If-Match': `"${crt.revision}"` });
  assert.equal(upd.status, 200);
  assert.equal((await deleteAsset(a)), 409, 'F01 核心：work 换成 B 后 icon 角色的 A 仍按当前完整集合保护（旧实现误释放）');
  // 仅改 title（不触碰资产字段）不释放任何保护
  const upd2 = await contentWrite('PUT', `/api/v1/content/creations/${crt.id}`, { title: 'F01b' }, { 'Idempotency-Key': 'f01-u2', 'If-Match': `"${upd.body.revision}"` });
  assert.equal(upd2.status, 200);
  assert.equal((await deleteAsset(a)), 409, '仅正文变化不释放');
  assert.equal((await deleteAsset(b)), 409, 'B 受保护');
});

test('F02 旧回执与新状态：A→B→A 后重放旧 B 操作回原回执，但不撤当前 A 保护', async () => {
  const a = await uploadAsset('f02-a');
  const b = await uploadAsset('f02-b');
  const p1 = await contentWrite('POST', '/api/v1/content/posts', { body: 'F02', asset_ids: [a] }, { 'Idempotency-Key': 'f02-k1' });
  assert.equal(p1.status, 201);
  const rev1 = p1.body.revision;
  const toB = await contentWrite('PUT', `/api/v1/content/posts/${p1.body.id}`, { body: 'F02-B', asset_ids: [b] }, { 'Idempotency-Key': 'f02-k2', 'If-Match': `"${rev1}"` });
  assert.equal(toB.status, 200);
  const backToA = await contentWrite('PUT', `/api/v1/content/posts/${p1.body.id}`, { body: 'F02-A', asset_ids: [a] }, { 'Idempotency-Key': 'f02-k3', 'If-Match': `"${toB.body.revision}"` });
  assert.equal(backToA.status, 200);
  // 重放旧 B 操作（同 key/原 If-Match/原 body）
  const replayB = await contentWrite('PUT', `/api/v1/content/posts/${p1.body.id}`, { body: 'F02-B', asset_ids: [b] }, { 'Idempotency-Key': 'f02-k2', 'If-Match': `"${rev1}"` });
  assert.equal(replayB.status, 200, '旧操作重放=原业务回执');
  assert.equal(replayB.body.revision, toB.body.revision, '回放的是当时的 revision，不是当前状态');
  assert.equal((await deleteAsset(a)), 409, 'F02 核心：旧回执重放不得撤掉当前 A 保护（旧实现变 200 可删）');
});

test('F05 父帖删除后：旧评论重放原 201；新评论拒绝 409', async () => {
  const p = await contentWrite('POST', '/api/v1/content/posts', { body: 'F05' }, { 'Idempotency-Key': 'f05-p1' });
  const c1 = await contentWrite('POST', `/api/v1/content/posts/${p.body.id}/comments`, { body: '第一条' }, { 'Idempotency-Key': 'f05-c1' });
  assert.equal(c1.status, 201);
  const del = await contentWrite('DELETE', `/api/v1/content/posts/${p.body.id}`, undefined, { 'Idempotency-Key': 'f05-d1', 'If-Match': `"${p.body.revision}"` });
  assert.equal(del.status, 200);
  const replay = await contentWrite('POST', `/api/v1/content/posts/${p.body.id}/comments`, { body: '第一条' }, { 'Idempotency-Key': 'f05-c1' });
  assert.equal(replay.status, 201, 'F05 核心：已成功评论的原请求重放原 201（旧实现 409）');
  assert.equal(replay.body.id, c1.body.id, '回放同一评论，不新增第二条');
  const fresh = await contentWrite('POST', `/api/v1/content/posts/${p.body.id}/comments`, { body: '新评论' }, { 'Idempotency-Key': 'f05-c2' });
  assert.equal(fresh.status, 409, '父帖已删，新评论拒绝');
  const list = await fetch(`${base}/api/v1/content/posts/${p.body.id}/comments?limit=10`, { headers: auth() });
  const comments = (await list.json()) as { items: unknown[] };
  assert.equal(comments.items.length, 1, '评论仍只有一条');
});

test('F06+F14 命令身份：跨资源删除/跨创建路由同 key 必须冲突；同 key 同请求回放原结果', async () => {
  const p = await contentWrite('POST', '/api/v1/content/posts', { body: 'F06' }, { 'Idempotency-Key': 'f06-p1' });
  const a = await uploadAsset('f06-a');
  const entry = await contentWrite('POST', '/api/v1/content/albums/stickers/entries', { asset_id: a }, { 'Idempotency-Key': 'f06-e1' });
  assert.equal(entry.status, 201);
  // 删除 post（key d1）；同 key/原 If-Match/同 ID 打到 album-entries 路由 → 必须冲突
  const delPost = await contentWrite('DELETE', `/api/v1/content/posts/${p.body.id}`, undefined, { 'Idempotency-Key': 'f06-d1', 'If-Match': `"${p.body.revision}"` });
  assert.equal(delPost.status, 200);
  const crossKind = await contentWrite('DELETE', `/api/v1/content/album-entries/${entry.body.id}`, undefined, { 'Idempotency-Key': 'f06-d1', 'If-Match': `"${p.body.revision}"` });
  assert.equal(crossKind.status, 409, 'F06 核心：同 key 裸 ID 换资源类型=冲突（旧实现回放他人 200）');
  // 跨创建路由：post create 用了 k，creation create 同 key → 冲突，不产生第二个对象
  const crossCreate = await contentWrite('POST', '/api/v1/content/creations', { bucket_id: 'bk-f06', icon_asset_id: a }, { 'Idempotency-Key': 'f06-p1' });
  assert.equal(crossCreate.status, 409, 'F14：跨创建路由同 key 冲突（旧实现回帖子 201）');
  const creations = await fetch(`${base}/api/v1/content/creations?limit=100`, { headers: auth() });
  const creationItems = ((await creations.json()) as { items: Array<{ bucket_ref: { id: string } }> }).items;
  assert.ok(!creationItems.some((i) => i.bucket_ref.id === 'bk-f06'), '冲突不创建作品');
  // 同 key 同请求重放：原 201
  const replayPost = await contentWrite('POST', '/api/v1/content/posts', { body: 'F06' }, { 'Idempotency-Key': 'f06-p1' });
  assert.equal(replayPost.status, 201);
  assert.equal(replayPost.body.id, p.body.id, '回放原对象');
});

test('F07 Host 重放顺序：A 已被替换且删除后重放原创建请求，先解析旧结果，不被 unavailable 挡住', async () => {
  const a = await uploadAsset('f07-a');
  const b = await uploadAsset('f07-b');
  const p = await contentWrite('POST', '/api/v1/content/posts', { body: 'F07', asset_ids: [a] }, { 'Idempotency-Key': 'f07-k1' });
  const toB = await contentWrite('PUT', `/api/v1/content/posts/${p.body.id}`, { body: 'F07-B', asset_ids: [b] }, { 'Idempotency-Key': 'f07-k2', 'If-Match': `"${p.body.revision}"` });
  assert.equal(toB.status, 200);
  assert.equal((await deleteAsset(a)), 200, 'A 已退出引用，可删（missing）');
  const del = await contentWrite('DELETE', `/api/v1/content/posts/${p.body.id}`, undefined, { 'Idempotency-Key': 'f07-k3', 'If-Match': `"${toB.body.revision}"` });
  assert.equal(del.status, 200);
  const replay = await contentWrite('POST', '/api/v1/content/posts', { body: 'F07', asset_ids: [a] }, { 'Idempotency-Key': 'f07-k1' });
  assert.equal(replay.status, 201, 'F07 核心：回放按原回执解析（旧实现先查 A available 得 422）');
  assert.equal(replay.body.id, p.body.id);
});

test('F09 引用 HTTP 写入口已收回（410）', async () => {
  const a = await uploadAsset('f09-a');
  const reg = await fetch(`${base}/api/v1/assets/${encodeURIComponent(a)}/references`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', 'Idempotency-Key': 'f09-r1' }), body: JSON.stringify({ owner_service: 'content', owner_type: 'creation', owner_id: 'x' }) });
  assert.equal(reg.status, 410, '登记入口收回');
  const unref = await fetch(`${base}/api/v1/assets/${encodeURIComponent(a)}/references/whatever`, { method: 'DELETE', headers: auth({ 'If-Match': '"1"', 'Idempotency-Key': 'f09-u1' }) });
  assert.equal(unref.status, 410, '解除入口收回');
});

test('F10 消息历史保护：内容零成员/删除后，消息附件引用仍令删除 409', async () => {
  const a = await uploadAsset('f10-a');
  // 已提交消息附件事实（message_attachments 独立于内容引用，不受内容删除影响）
  host.db.prepare("INSERT INTO message_attachments(message_id, revision, position, asset_id, presentation, caption, derived_text, derived_source, created_at) VALUES ('m-f10', 1, 0, ?, 'image', NULL, NULL, NULL, ?)").run(a, new Date().toISOString());
  const p = await contentWrite('POST', '/api/v1/content/posts', { body: 'F10', asset_ids: [a] }, { 'Idempotency-Key': 'f10-p1' });
  const zero = await contentWrite('PUT', `/api/v1/content/posts/${p.body.id}`, { body: 'F10-清空', asset_ids: [] }, { 'Idempotency-Key': 'f10-u1', 'If-Match': `"${p.body.revision}"` });
  assert.equal(zero.status, 200);
  const del = await contentWrite('DELETE', `/api/v1/content/posts/${p.body.id}`, undefined, { 'Idempotency-Key': 'f10-d1', 'If-Match': `"${zero.body.revision}"` });
  assert.equal(del.status, 200);
  assert.equal((await deleteAsset(a)), 409, 'F10：消息附件仍保护（消息引用 1）');
  const read = await fetch(`${base}/api/v1/assets/${encodeURIComponent(a)}`, { headers: auth() });
  assert.equal(read.status, 200, '资产仍可读');
});

test('F11 同资产重新引用：available 退出后可再引用且保护恢复；missing 不再可引用', async () => {
  const a = await uploadAsset('f11-a');
  const p1 = await contentWrite('POST', '/api/v1/content/posts', { body: 'F11-1', asset_ids: [a] }, { 'Idempotency-Key': 'f11-k1' });
  assert.equal((await deleteAsset(a)), 409);
  const d1 = await contentWrite('DELETE', `/api/v1/content/posts/${p1.body.id}`, undefined, { 'Idempotency-Key': 'f11-k2', 'If-Match': `"${p1.body.revision}"` });
  assert.equal(d1.status, 200);
  // 同一 available 资产解除关系后再被新对象引用：候选核验应通过，保护恢复
  const p2 = await contentWrite('POST', '/api/v1/content/posts', { body: 'F11-2', asset_ids: [a] }, { 'Idempotency-Key': 'f11-k3' });
  assert.equal(p2.status, 201, 'available 资产退出关系后可再引用');
  assert.equal((await deleteAsset(a)), 409, '再引用后保护恢复');
  // 彻底删除（最后关系退出→资产删成 missing）后，新引用按候选核验拒绝——不允许借旧字节复活
  const d2 = await contentWrite('DELETE', `/api/v1/content/posts/${p2.body.id}`, undefined, { 'Idempotency-Key': 'f11-k4', 'If-Match': `"${p2.body.revision}"` });
  assert.equal(d2.status, 200);
  assert.equal((await deleteAsset(a)), 200, '最后引用退出后可删（missing）');
  const p3 = await contentWrite('POST', '/api/v1/content/posts', { body: 'F11-3', asset_ids: [a] }, { 'Idempotency-Key': 'f11-k5' });
  assert.equal(p3.status, 422, 'missing 资产不再可被新内容引用');
});

test('F12 多 owner：删一个对象保留其他 owner 的保护；最后合法关系退出才可删', async () => {
  const a = await uploadAsset('f12-a');
  const c1 = await contentWrite('POST', '/api/v1/content/creations', { bucket_id: 'bk-f12-1', icon_asset_id: a }, { 'Idempotency-Key': 'f12-k1' });
  const c2 = await contentWrite('POST', '/api/v1/content/creations', { bucket_id: 'bk-f12-2', icon_asset_id: a }, { 'Idempotency-Key': 'f12-k2' });
  assert.equal(c1.status, 201); assert.equal(c2.status, 201);
  const d1 = await contentWrite('DELETE', `/api/v1/content/creations/${c1.body.id}`, undefined, { 'Idempotency-Key': 'f12-k3', 'If-Match': `"${c1.body.revision}"` });
  assert.equal(d1.status, 200);
  assert.equal((await deleteAsset(a)), 409, 'F12：另一作品仍引用 A');
  const d2 = await contentWrite('DELETE', `/api/v1/content/creations/${c2.body.id}`, undefined, { 'Idempotency-Key': 'f12-k4', 'If-Match': `"${c2.body.revision}"` });
  assert.equal(d2.status, 200);
  assert.equal((await deleteAsset(a)), 200, '最后关系退出后可删');
});

test('F13 零集合版本锚：删除形成带版本空集合；迟到重放不复活、不撤已生效删除', async () => {
  const a = await uploadAsset('f13-a');
  const p = await contentWrite('POST', '/api/v1/content/posts', { body: 'F13', asset_ids: [a] }, { 'Idempotency-Key': 'f13-k1' });
  const del = await contentWrite('DELETE', `/api/v1/content/posts/${p.body.id}`, undefined, { 'Idempotency-Key': 'f13-k2', 'If-Match': `"${p.body.revision}"` });
  assert.equal(del.status, 200);
  const delRev = del.body.revision as number;
  assert.ok(typeof delRev === 'number' && delRev > p.body.revision, '删除响应带递增版本');
  const ownerState = host.db.prepare('SELECT applied_revision, deleted, asset_ids_json FROM content_owner_state WHERE owner_type = ? AND owner_id = ?').get('post', p.body.id) as { applied_revision: number; deleted: number; asset_ids_json: string };
  assert.equal(ownerState.deleted, 1, '零集合版本锚=删除版本');
  assert.equal(ownerState.asset_ids_json, '[]');
  assert.equal(ownerState.applied_revision, delRev);
  // 重放原创建（旧回执）：不改当前保护状态
  const replay = await contentWrite('POST', '/api/v1/content/posts', { body: 'F13', asset_ids: [a] }, { 'Idempotency-Key': 'f13-k1' });
  assert.equal(replay.status, 201, '旧回执照常回放');
  const after = host.db.prepare('SELECT applied_revision FROM content_owner_state WHERE owner_type = ? AND owner_id = ?').get('post', p.body.id) as { applied_revision: number };
  assert.equal(after.applied_revision, delRev, '迟到旧确认不降版本、不复活');
  assert.equal((await deleteAsset(a)), 200, '删除后零成员：资产不被复活保护卡住');
});

test('F14 身份语义（jiaming 直连协调器）：同 key 同参回放、异参冲突（真实模型续轮路径见 content-rf-recovery RF02B）', async () => {
  const p = await contentWrite('POST', '/api/v1/content/posts', { body: 'F14' }, { 'Idempotency-Key': 'f14-p1' });
  const media = new MediaService(host.db, mediaDir, config);
  const coord = new ContentOperationCoordinator({ db: host.db, client: { baseUrl: `http://127.0.0.1:${contentServer.port}`, token: contentServer.token }, media, logger: host.logger });
  const c1 = await coord.write({ method: 'POST', path: `/api/v1/content/posts/${p.body.id}/comments`, actor: 'jiaming', body: { body: '模型评论' }, headers: { 'idempotency-key': 'tool:t1:r1:mk1' } });
  assert.equal(c1.status, 201);
  const replay = await coord.write({ method: 'POST', path: `/api/v1/content/posts/${p.body.id}/comments`, actor: 'jiaming', body: { body: '模型评论' }, headers: { 'idempotency-key': 'tool:t1:r1:mk1' } });
  assert.equal(replay.status, 201);
  assert.equal((replay.body as { id: string }).id, (c1.body as { id: string }).id, '同 key 同请求=同一评论');
  const other = await coord.write({ method: 'POST', path: `/api/v1/content/posts/${p.body.id}/comments`, actor: 'jiaming', body: { body: '另一条' }, headers: { 'idempotency-key': 'tool:t1:r1:mk1' } });
  assert.equal(other.status, 409, '同 key 异参冲突');
});

test('F03 提交丢响应（直连协调器收口面）：pin 在 HTTP 前持久；恢复沿原身份确认，不重建业务（真实 Host 周期消费者见 content-rf-recovery RF01）', async () => {
  const a = await uploadAsset('f03-a');
  // 黑洞代理：转发到真实 content，拿到响应后断开调用方连接（提交成功、响应丢失）
  const realBase = `http://127.0.0.1:${contentServer.port}`;
  const blackhole = net.createServer((socket) => {
    let acc = Buffer.alloc(0);
    let forwarded = false;
    const tryForward = () => {
      if (forwarded) return;
      const sep = acc.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const head = acc.slice(0, sep).toString('utf8');
      const rawHeaders = head.split('\r\n').slice(1);
      const headers: Record<string, string> = {};
      for (const h of rawHeaders) { const idx = h.indexOf(':'); if (idx > 0) headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim(); }
      const len = Number(headers['content-length'] ?? 0);
      if (acc.length < sep + 4 + len) return;
      forwarded = true;
      const [verb, target] = head.split('\r\n')[0]!.split(' ');
      delete headers['host']; delete headers['content-length']; delete headers['connection'];
      const body = acc.slice(sep + 4, sep + 4 + len);
      const swallow = verb === 'POST' && !target.startsWith('/api/v1/content/operations/'); // 业务写吞响应；resolve 正常回写
      const req = httpRequest(`${realBase}${target}`, { method: verb as 'POST', headers }, (res) => {
        if (swallow) { res.resume(); res.on('end', () => socket.destroy()); return; }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const payload = Buffer.concat(chunks);
          socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`);
          socket.end(payload);
        });
      });
      req.on('error', () => socket.destroy());
      req.end(body.length > 0 ? body : undefined);
    };
    socket.on('data', (buf) => { acc = Buffer.concat([acc, buf]); tryForward(); });
    socket.on('error', () => { /* 调用方超时断开 */ });
  });
  await new Promise<void>((r) => { blackhole.listen(0, '127.0.0.1', () => r()); });
  const bhPort = (blackhole.address() as net.AddressInfo).port;
  const media = new MediaService(host.db, mediaDir, config);
  const coord = new ContentOperationCoordinator({ db: host.db, client: { baseUrl: `http://127.0.0.1:${bhPort}`, token: contentServer.token }, media, logger: host.logger });
  const key = 'f03-k1';
  const result = await coord.write({ method: 'POST', path: '/api/v1/content/posts', actor: 'qiaosheng', body: { body: 'F03', asset_ids: [a] }, headers: { 'idempotency-key': key } });
  assert.equal(result.status, 504, '响应未知');
  // content 已提交（真实对象存在），Host 端 pin 已在 HTTP 前落盘 → 删除守卫拒绝
  const posts = await fetch(`${base}/api/v1/content/posts?limit=50`, { headers: auth() });
  const items = ((await posts.json()) as { items: Array<{ body: string }> }).items;
  assert.ok(items.some((i) => i.body === 'F03'), '业务已提交（丢的只是响应）');
  assert.equal((await deleteAsset(a)), 409, 'F03 核心：提交丢响应后资产仍被 pin 保护（旧实现可删）');
  const row = host.db.prepare("SELECT state FROM outbox WHERE target = 'content.operation' AND operation_key = ?").get(`content:qiaosheng:${key}`) as { state: string };
  assert.equal(row.state, 'unknown_outcome');
  // “重启恢复”：真实客户端的协调器按原身份回查 → 回执存在 → 确认映射收口
  const realCoord = new ContentOperationCoordinator({ db: host.db, client: { baseUrl: realBase, token: contentServer.token }, media, logger: host.logger });
  await realCoord.recoverOnce(10);
  const row2 = host.db.prepare("SELECT state, payload_ref FROM outbox WHERE target = 'content.operation' AND operation_key = ?").get(`content:qiaosheng:${key}`) as { state: string; payload_ref: string };
  assert.equal(row2.state, 'acked', '恢复收口为已确认');
  const payload = JSON.parse(row2.payload_ref) as { applied_revision: number };
  assert.ok(typeof payload.applied_revision === 'number', '记录已应用 owner 版本');
  const committed = host.db.prepare("SELECT COUNT(*) n FROM asset_external_refs WHERE asset_id = ? AND owner_service = 'content' AND state = 'committed'").get(a) as { n: number };
  assert.equal(committed.n, 1, '正式 committed 关系落位');
  assert.equal((await deleteAsset(a)), 409, '确认后仍受保护');
  blackhole.close();
});

test('F04 登记写锁：意图持久失败=操作未提交；解锁后同 key 重试成功且保护成立', async () => {
  const a = await uploadAsset('f04-a');
  const postsBefore = ((await (await fetch(`${base}/api/v1/content/posts?limit=100`, { headers: auth() })).json()) as { items: unknown[] }).items.length;
  const lock = new DatabaseSync(path.join(root, 'data', 'chat.sqlite3'));
  lock.exec('BEGIN IMMEDIATE');
  const r = await contentWrite('POST', '/api/v1/content/posts', { body: 'F04', asset_ids: [a] }, { 'Idempotency-Key': 'f04-k1' });
  assert.equal(r.status, 503, '意图登记失败如实上抛（不静默吞掉）');
  const postsMid = ((await (await fetch(`${base}/api/v1/content/posts?limit=100`, { headers: auth() })).json()) as { items: unknown[] }).items.length;
  assert.equal(postsMid, postsBefore, 'F04 核心：登记失败=content 未提交（不能成功假收口）');
  const pinned = host.db.prepare("SELECT COUNT(*) n FROM asset_external_refs WHERE asset_id = ? AND state = 'protected'").get(a) as { n: number };
  assert.equal(pinned.n, 0, '失败的意图事务不留半截 pin');
  lock.exec('ROLLBACK'); lock.close();
  const retry = await contentWrite('POST', '/api/v1/content/posts', { body: 'F04', asset_ids: [a] }, { 'Idempotency-Key': 'f04-k1' });
  assert.equal(retry.status, 201, '解锁后同 key 重试成功');
  assert.equal((await deleteAsset(a)), 409, '保护成立');
});

test('F15 旧回执兼容（手造 DTO 形状面）：旧算法+资源形状对上才回放；不足则待核冲突（真实旧库迁移/旧删除形状见 content-rf-recovery RF03）', async () => {
  const a = await uploadAsset('f15-a');
  const legacyBody = { bucket_id: 'bk-legacy', icon_asset_id: a, title: '旧作品' };
  const legacyHash = sha256ish(JSON.stringify({ body: legacyBody, actor: 'qiaosheng' })); // 旧创建指纹（逐字重建）
  const createdAt = new Date().toISOString();
  contentServer.db.prepare("INSERT INTO content_receipts(actor, idem_key, request_hash, status, response_json, created_at, fingerprint_version) VALUES ('qiaosheng', 'legacy-c1', ?, 201, ?, ?, 0)")
    .run(legacyHash, JSON.stringify({ id: 'crt_legacy_1', creator: 'qiaosheng', title: '旧作品', bucket_ref: { service: 'mariposa', kind: 'bucket', id: 'bk-legacy' }, icon_asset_id: a, work_asset_id: null, work_kind: null, revision: 1, deleted: false }), createdAt);
  // 同 key 同 body（旧算法命中 + creation DTO 形状一致）→ 回放原 201
  const replay = await contentWrite('POST', '/api/v1/content/creations', legacyBody, { 'Idempotency-Key': 'legacy-c1' });
  assert.equal(replay.status, 201, '旧回执按原结果回放');
  assert.equal(replay.body.id, 'crt_legacy_1');
  // 同 key 不同 body → 待核冲突，保留原结果不换 key 重建
  const mismatch = await contentWrite('POST', '/api/v1/content/creations', { ...legacyBody, title: '另一件' }, { 'Idempotency-Key': 'legacy-c1' });
  assert.equal(mismatch.status, 409);
  // 同 key 同 body 打到 post 创建（资源类型不一致）→ 冲突，不回放 creation 结果
  const cross = await contentWrite('POST', '/api/v1/content/posts', { body: 'x', bucket_id: 'bk-legacy', icon_asset_id: a }, { 'Idempotency-Key': 'legacy-c1' });
  assert.equal(cross.status, 409);
  const kept = contentServer.db.prepare('SELECT status, response_json FROM content_receipts WHERE actor = ? AND idem_key = ?').get('qiaosheng', 'legacy-c1') as { status: number; response_json: string };
  assert.equal(JSON.parse(kept.response_json).id, 'crt_legacy_1', '原 13 类旧回执原样保留');
});

test('联合审计 F07：Host 实际 MIME、作品类别及用途幂等边界一致', async () => {
  const key = 'joint-audit-f07-photo';
  const assetId = await uploadAsset(key);
  const changedPurpose = await fetch(`${base}/api/v1/assets?purpose=chat_sticker`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/octet-stream', 'Idempotency-Key': key }), body: new Uint8Array(PNG),
  });
  assert.equal(changedPurpose.status, 409);
  assert.equal((await changedPurpose.json() as { error: { code: string } }).error.code, 'idempotency_conflict');
  for (const kind of ['image', 'svg', 'html']) {
    const rejected = await contentWrite('POST', '/api/v1/content/creations', { work_asset_id: assetId, work_kind: kind }, { 'Idempotency-Key': `joint-audit-f07-${kind}` });
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'image_belongs_in_album');
  }
  const photo = await contentWrite('POST', '/api/v1/content/albums/important_photos/entries', { asset_id: assetId }, { 'Idempotency-Key': 'joint-audit-f07-photo-entry' });
  assert.equal(photo.status, 201);
  const sticker = await contentWrite('POST', '/api/v1/content/albums/stickers/entries', { asset_id: assetId }, { 'Idempotency-Key': 'joint-audit-f07-sticker-entry' });
  assert.equal(sticker.status, 201);
  assert.notEqual(photo.body.id, sticker.body.id);
  const html = Buffer.from('<!doctype html><html><body>synthetic work only</body></html>');
  const uploaded = await fetch(`${base}/api/v1/assets?purpose=creation_work`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/octet-stream', 'Idempotency-Key': 'joint-audit-f07-code' }), body: new Uint8Array(html),
  });
  assert.equal(uploaded.status, 201);
  const codeAsset = (await uploaded.json() as { asset_id: string }).asset_id;
  const created = await contentWrite('POST', '/api/v1/content/creations', { work_asset_id: codeAsset, work_kind: 'html', title: 'fixture' }, { 'Idempotency-Key': 'joint-audit-f07-code-entry' });
  assert.equal(created.status, 201);
  const mismatch = await contentWrite('PUT', `/api/v1/content/creations/${created.body.id}`, { work_asset_id: assetId }, { 'Idempotency-Key': 'joint-audit-f07-bad-update', 'If-Match': '"1"' });
  assert.equal(mismatch.status, 422);
  const removed = await contentWrite('DELETE', `/api/v1/content/creations/${created.body.id}`, undefined, { 'Idempotency-Key': 'joint-audit-f07-delete-code', 'If-Match': '"1"' });
  assert.equal(removed.status, 200);
  assert.equal((await fetch(`${base}/api/v1/assets/${codeAsset}/preview`, { headers: auth() })).status, 200);
});
