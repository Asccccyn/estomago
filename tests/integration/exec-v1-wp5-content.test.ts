// ESTOMAGO_CHAT_EXEC_V1 · WP5 HTTP 集成（06 §3-§4：双 actor/幂等/If-Match/删除语义/letter/资产校验）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch, wireOidoCapabilitiesForTest } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { ContentServer } from '../../apps/content/src/service.ts';
import { contentForward } from '../../apps/host/src/integrations/content/client.ts';
import { HostToolExecutor, type ToolExecContext } from '../../apps/host/src/runtime/host-tools.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';

const root = tempRoot('exec-v1-wp5-');
writeApprovedIdentity(root);
const contentRoot = path.join(root, 'content');
let contentServer: ContentServer;
let host: Host;
let base = '';
let token = '';
const auth = (extra: Record<string, string> = {}): Record<string, string> => ({ Authorization: `Bearer ${token}`, ...extra });

// 最小 PNG（1x1）
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

before(async () => {
  // 1. 启动 content 独立进程（loopback+服务凭据）
  contentServer = new ContentServer({ stateRoot: contentRoot, port: 0 });
  await contentServer.start();
  // 2. 启动 est（content.enabled=true 且凭据文件存在）
  const config = buildConfig({
    ...readyRuntimePatch(),
    deployment: { port: 0 },
    runtime: { ...readyRuntimePatch().runtime, provider: 'mock' },
    content: { enabled: true, port: contentServer.port },
  });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
});
after(async () => { await host.stop(); await contentServer.stop(); });

test('FEED-01/02：双方发帖+评论；letter 同一模型；作者由宿主派生非 body', async () => {
  // 浏览器发帖（est 代理→content，actor=qiaosheng）
  const post1 = await fetch(`${base}/api/v1/content/posts`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'p1' }), body: JSON.stringify({ body: '今天的心情很好', presentation: 'post' }) });
  assert.equal(post1.status, 201);
  const p1 = (await post1.json()) as { id: string; author: string; presentation: string; body: string; revision: number };
  assert.equal(p1.author, 'qiaosheng'); // 宿主派生——浏览器 body 无作者字段
  assert.equal(p1.presentation, 'post');
  assert.equal(p1.revision, 1);
  // letter 展示（同一数据模型）
  const post2 = await fetch(`${base}/api/v1/content/posts`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'p2' }), body: JSON.stringify({ body: '给你的一封信', presentation: 'letter', title: '信' }) });
  const p2 = (await post2.json()) as { id: string; presentation: string; author: string };
  assert.equal(p2.presentation, 'letter');
  assert.equal(p2.author, 'qiaosheng'); // letter 也是同一作者机制
  // char评论（模型工具→content，actor=jiaming）
  const client = { baseUrl: `http://127.0.0.1:${contentServer.port}`, token: contentServer.token };
  const comment = await contentForward(client, { method: 'POST', path: `/api/v1/content/posts/${p1.id}/comments`, actor: 'jiaming', body: { body: '看到了' }, headers: { 'Idempotency-Key': 'c1' } });
  assert.equal(comment.status, 201);
  const c1 = comment.body as { id: string; author: string; body: string };
  assert.equal(c1.author, 'jiaming'); // 模型工具派生 jiaming
  // 双方都可见
  const list = await (await fetch(`${base}/api/v1/content/posts?limit=20`, { headers: auth() })).json() as { items: Array<{ id: string; author: string; comment_count: number }> };
  assert.ok(list.items.length >= 2);
  const found1 = list.items.find((i) => i.id === p1.id)!;
  assert.equal(found1.comment_count, 1);
});

test('FEED-03：幂等回执——同键同请求=原结果；同键不同请求=IDEMPOTENCY_CONFLICT', async () => {
  const body1 = { body: '幂等测试帖' };
  const r1 = await fetch(`${base}/api/v1/content/posts`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'idem-1' }), body: JSON.stringify(body1) });
  const d1 = (await r1.json()) as { id: string };
  // 同键同请求 → 原结果
  const r2 = await fetch(`${base}/api/v1/content/posts`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'idem-1' }), body: JSON.stringify(body1) });
  const d2 = (await r2.json()) as { id: string };
  assert.equal(d2.id, d1.id, '同键同请求返回原帖');
  // 同键不同请求 → 409
  const r3 = await fetch(`${base}/api/v1/content/posts`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'idem-1' }), body: JSON.stringify({ body: '不同内容' }) });
  assert.equal(r3.status, 409);
  assert.equal(((await r3.json()) as { error: { code: string } }).error.code, 'idempotency_conflict');
});

test('FEED-04：If-Match 编辑——缺=428；错=409；对=200+revision 递增；只能编辑本人', async () => {
  const create = await fetch(`${base}/api/v1/content/posts`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'edit-1' }), body: JSON.stringify({ body: '要编辑的帖子' }) });
  const post = (await create.json()) as { id: string; revision: number };
  // 缺 If-Match
  const noMatch = await fetch(`${base}/api/v1/content/posts/${post.id}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'e1' }), body: JSON.stringify({ body: '改' }) });
  assert.equal(noMatch.status, 428);
  // 错 If-Match
  const wrongMatch = await fetch(`${base}/api/v1/content/posts/${post.id}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': '"999"', 'Idempotency-Key': 'e2' }), body: JSON.stringify({ body: '改' }) });
  assert.equal(wrongMatch.status, 409);
  // 对 If-Match
  const ok = await fetch(`${base}/api/v1/content/posts/${post.id}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'If-Match': `"${post.revision}"`, 'Idempotency-Key': 'e3' }), body: JSON.stringify({ body: '编辑后的正文' }) });
  assert.equal(ok.status, 200);
  const edited = (await ok.json()) as { revision: number; body: string };
  assert.equal(edited.revision, post.revision + 1);
  assert.equal(edited.body, '编辑后的正文');
  // jiaming 不能编辑 qiaosheng 的帖子（只能操作本人内容）
  const client = { baseUrl: `http://127.0.0.1:${contentServer.port}`, token: contentServer.token };
  const foreign = await contentForward(client, { method: 'PUT', path: `/api/v1/content/posts/${post.id}`, actor: 'jiaming', body: { body: '冒充编辑' }, headers: { 'If-Match': `"${edited.revision}"`, 'Idempotency-Key': 'e4' } });
  assert.equal(foreign.status, 403);
});

test('FEED-05：删除本人帖子保留他人评论（不级联）；评论作者仍可删自己的', async () => {
  const create = await fetch(`${base}/api/v1/content/posts`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': 'del-1' }), body: JSON.stringify({ body: '要删的帖子' }) });
  const post = (await create.json()) as { id: string; revision: number };
  // jiaming 评论
  const client = { baseUrl: `http://127.0.0.1:${contentServer.port}`, token: contentServer.token };
  const cm = await contentForward(client, { method: 'POST', path: `/api/v1/content/posts/${post.id}/comments`, actor: 'jiaming', body: { body: '评论' }, headers: { 'Idempotency-Key': 'del-c1' } });
  const comment = cm.body as { id: string; revision: number };
  // qiaosheng 删帖
  const del = await fetch(`${base}/api/v1/content/posts/${post.id}`, { method: 'DELETE', headers: auth({ Origin: base, 'If-Match': `"${post.revision}"`, 'Idempotency-Key': 'del-d1' }) });
  assert.equal(del.status, 200);
  // 帖子已删——列表隐藏；但评论作者仍可查看/删除自己的评论
  const list = await (await fetch(`${base}/api/v1/content/posts?limit=100`, { headers: auth() })).json() as { items: Array<{ id: string }> };
  assert.ok(!list.items.some((i) => i.id === post.id), '已删帖子不在列表');
  // 已删帖子不再接受新评论
  const newComment = await contentForward(client, { method: 'POST', path: `/api/v1/content/posts/${post.id}/comments`, actor: 'jiaming', body: { body: '新评论' }, headers: { 'Idempotency-Key': 'del-c2' } });
  assert.equal(newComment.status, 409);
  // 评论仍可见（帖子详情/评论列表——占位+评论保留）
  const comments = await contentForward(client, { method: 'GET', path: `/api/v1/content/posts/${post.id}/comments`, actor: 'jiaming' });
  const items = (comments.body as { items: Array<{ id: string; body: string | null; deleted: boolean }> }).items;
  assert.ok(items.some((i) => i.id === comment.id && i.body === '评论'), '他人评论不被级联删除');
  // 评论作者可删自己的评论
  const delComment = await contentForward(client, { method: 'DELETE', path: `/api/v1/content/comments/${comment.id}`, actor: 'jiaming', headers: { 'If-Match': `"${comment.revision}"`, 'Idempotency-Key': 'del-dc' } });
  assert.equal(delComment.status, 200);
  // 删除后普通读取不返回原正文
  const afterDel = await contentForward(client, { method: 'GET', path: `/api/v1/content/posts/${post.id}/comments`, actor: 'jiaming' });
  const items2 = (afterDel.body as { items: Array<{ id: string; body: string | null; deleted: boolean }> }).items;
  const deletedCm = items2.find((i) => i.id === comment.id)!;
  assert.equal(deletedCm.deleted, true);
  assert.equal(deletedCm.body, null, '删除后普通读取不返回原正文');
});

test('FEED-06/ALBUM：相册条目幂等归档+our_words 反查+caption 更新', async () => {
  const client = { baseUrl: `http://127.0.0.1:${contentServer.port}`, token: contentServer.token };
  // 添加截图归档（关联 our_words）
  const add = await contentForward(client, { method: 'POST', path: '/api/v1/content/albums/chat_screenshots/entries', actor: 'qiaosheng', body: { asset_id: 'asset_test_screenshot_1', caption: '聊天截图', refs: [{ service: 'mariposa', kind: 'our_words', source_id: 'ow_test_1' }] }, headers: { 'Idempotency-Key': 'alb-1' } });
  assert.equal(add.status, 201);
  const entry = add.body as { id: string; kind: string; caption: string | null };
  // 同 kind+asset 幂等返回既有
  const add2 = await contentForward(client, { method: 'POST', path: '/api/v1/content/albums/chat_screenshots/entries', actor: 'qiaosheng', body: { asset_id: 'asset_test_screenshot_1', caption: '重复添加' }, headers: { 'Idempotency-Key': 'alb-2' } });
  const dup = add2.body as { id: string };
  assert.equal(dup.id, entry.id, '同 (kind,asset) 幂等返回既有');
  // our_words 反查
  const rev = await contentForward(client, { method: 'GET', path: '/api/v1/content/albums/chat_screenshots/entries?source_service=mariposa&source_kind=our_words&source_id=ow_test_1', actor: 'qiaosheng' });
  const revItems = (rev.body as { items: Array<{ id: string; refs: Array<{ service: string; kind: string; source_id: string }> }> }).items;
  assert.equal(revItems.length, 1);
  assert.equal(revItems[0]!.refs[0]!.source_id, 'ow_test_1');
  // 更新 caption
  const upd = await contentForward(client, { method: 'PUT', path: `/api/v1/content/album-entries/${entry.id}`, actor: 'qiaosheng', body: { caption: '更新后的说明' }, headers: { 'If-Match': '"1"', 'Idempotency-Key': 'alb-u1' } });
  assert.equal(upd.status, 200);
  // 移除归档（不删外部原文/文件）
  const rem = await contentForward(client, { method: 'DELETE', path: `/api/v1/content/album-entries/${entry.id}`, actor: 'qiaosheng', headers: { 'If-Match': '"2"', 'Idempotency-Key': 'alb-d1' } });
  assert.equal(rem.status, 200);
  const afterRem = await contentForward(client, { method: 'GET', path: '/api/v1/content/albums/chat_screenshots/entries', actor: 'qiaosheng' });
  assert.equal((afterRem.body as { items: unknown[] }).items.length, 0);
});

test('CREATION：纪念作品（bucket 引用+icon 必填+work 可空+同空同有效+创建者操作）', async () => {
  const client = { baseUrl: `http://127.0.0.1:${contentServer.port}`, token: contentServer.token };
  // 正常创建（仅 icon，无作品）
  const create = await contentForward(client, { method: 'POST', path: '/api/v1/content/creations', actor: 'jiaming', body: { bucket_id: 'bucket_test_1', icon_asset_id: 'asset_icon_1', title: '纪念图标' }, headers: { 'Idempotency-Key': 'crt-1' } });
  assert.equal(create.status, 201);
  const crt = create.body as { id: string; icon_asset_id: string; work_asset_id: string | null; work_kind: string | null; bucket_ref: { service: string; kind: string; id: string }; revision: number };
  assert.equal(crt.work_asset_id, null, '无作品是有效状态');
  assert.equal(crt.work_kind, null);
  assert.equal(crt.bucket_ref.id, 'bucket_test_1');
  // 后补作品
  const upd = await contentForward(client, { method: 'PUT', path: `/api/v1/content/creations/${crt.id}`, actor: 'jiaming', body: { work_asset_id: 'asset_work_1', work_kind: 'html' }, headers: { 'If-Match': `"${crt.revision}"`, 'Idempotency-Key': 'crt-u1' } });
  assert.equal(upd.status, 200);
  const updated = upd.body as { work_asset_id: string; work_kind: string };
  assert.equal(updated.work_asset_id, 'asset_work_1');
  assert.equal(updated.work_kind, 'html');
  // 非创建者操作 → 403
  const foreign = await contentForward(client, { method: 'PUT', path: `/api/v1/content/creations/${crt.id}`, actor: 'qiaosheng', body: { title: '冒充修改' }, headers: { 'If-Match': '"2"', 'Idempotency-Key': 'crt-f1' } });
  assert.equal(foreign.status, 403);
});

test('FUTURE-NOTE：未来留言正文——无 deliver_at 字段；双方可见仅本人管理', async () => {
  const client = { baseUrl: `http://127.0.0.1:${contentServer.port}`, token: contentServer.token };
  const create = await contentForward(client, { method: 'POST', path: '/api/v1/content/future-notes', actor: 'qiaosheng', body: { body: '给未来的信', title: '信' }, headers: { 'Idempotency-Key': 'fn-1' } });
  assert.equal(create.status, 201);
  const note = create.body as { id: string; body: string; revision: number };
  // 无 deliver_at（正文归 content，投递归 est 调度器）
  assert.ok(!('deliver_at' in note), '未来留言无 deliver_at 字段（投递归 est）');
  // jiaming 可见（双方私密可见）
  const read = await contentForward(client, { method: 'GET', path: `/api/v1/content/future-notes/${note.id}`, actor: 'jiaming' });
  assert.equal(read.status, 200);
  // jiaming 不能编辑 qiaosheng 的留言
  const edit = await contentForward(client, { method: 'PUT', path: `/api/v1/content/future-notes/${note.id}`, actor: 'jiaming', body: { body: '冒充编辑' }, headers: { 'If-Match': `"${note.revision}"`, 'Idempotency-Key': 'fn-e1' } });
  assert.equal(edit.status, 403);
});

test('模型工具：content_post_create（jiaming 身份发帖+letter）', async () => {
  // 直接构造 tools 执行器（不走 supervisor——测工具层）
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const messages = new MessageService(db);
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), archiveSync: null, media, messages, contentClient: { baseUrl: `http://127.0.0.1:${contentServer.port}`, token: contentServer.token } })
  wireOidoCapabilitiesForTest(tools, {});;
  const ctx: ToolExecContext = { roomId: 'primary', windowId: 'w1', turnId: 'turn-tool-test', purpose: 'chat', activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: 'prq-tool-test' };
  const r = await tools.execute('content_post_create', { body: 'char发的帖', presentation: 'letter', title: '一封信', idempotency_key: 'model-1', __tool_call_id: 'tc-model-1' }, ctx);
  assert.equal(r.ok, true);
  const post = r.output as { id: string; author: string; presentation: string };
  assert.equal(post.author, 'jiaming', '模型工具派生 jiaming');
  assert.equal(post.presentation, 'letter');
  // 列表
  const list = await tools.execute('content_posts_list', { limit: 5, __tool_call_id: 'tc-list' }, ctx);
  assert.equal(list.ok, true);
  const items = (list.output as { items: Array<{ id: string; author: string }> }).items;
  assert.ok(items.some((i) => i.id === post.id));
  // 评论
  const comment = await tools.execute('content_comment_create', { post_id: post.id, body: '自己的评论', idempotency_key: 'mc-1', __tool_call_id: 'tc-mc' }, ctx);
  assert.equal(comment.ok, true);
  db.close();
});
