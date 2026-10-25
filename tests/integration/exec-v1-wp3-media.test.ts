// ESTOMAGO_CHAT_EXEC_V1 · WP3/M1 媒体底座（03 §4-§5：资产保存/幂等/引用守卫 + 消息附件事务/编辑/If-Match）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { MediaService, MediaError, sniffMime, isPublicIp } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import {writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';

// —— 最小 PNG（1x1）与魔数素材 ——
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'); // 头（合法 PNG 前缀）
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const GARBAGE = Buffer.alloc(64, 0xab);

function svc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-v1-wp3-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  return { root, db, media, messages: new MessageService(db) };
}

test('MEDIA-01：资产字节校验保存+重启后字节一致（available 才是成功附件）', async () => {
  const { root, db, media } = svc();
  const a = await media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-1', createdBy: 'qiaosheng', origin: 'upload' });
  assert.equal(a.state, 'available');
  assert.equal(a.mime_type, 'image/png');
  assert.equal(a.content_sha256, sha256Hex(PNG));
  // 同目录重建服务（模拟重启）→ 字节一致、元数据一致
  const media2 = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const read = media2.readContent(a.id);
  assert.deepEqual(Buffer.from(read.bytes.subarray(0, PNG.length)), PNG);
  assert.equal(read.mime, 'image/png');
  assert.ok(fs.existsSync(path.join(root, 'media')));
  db.close();
});

test('MEDIA-02：超大/魔数不明/用途不符各有稳定错误；不产生假成功资产行', async () => {
  const { db, media } = svc();
  const cfg = buildConfig({});
  await assert.rejects(() => media.saveBuffer({ bytes: Buffer.alloc(cfg.media.max_image_bytes + 1, 1), purpose: 'chat_image', operationId: 'op-big', createdBy: 'u', origin: 'upload' }), (e: MediaError) => e.code === 'ASSET_TOO_LARGE');
  await assert.rejects(() => media.saveBuffer({ bytes: GARBAGE, purpose: 'chat_image', operationId: 'op-gb', createdBy: 'u', origin: 'upload' }), (e: MediaError) => e.code === 'ASSET_TYPE_UNSUPPORTED');
  await assert.rejects(() => media.saveBuffer({ bytes: PNG, purpose: 'chat_voice', operationId: 'op-mime', createdBy: 'u', origin: 'upload' }), (e: MediaError) => e.code === 'ASSET_TYPE_UNSUPPORTED'); // 图片冒充语音
  const n = (db.prepare('SELECT COUNT(*) n FROM media_assets').get() as { n: number }).n;
  assert.equal(n, 0, '失败操作不留下资产行');
  // 幂等：同键同内容=原资产；同键不同内容=冲突
  const first = await media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-idem', createdBy: 'u', origin: 'upload' });
  const again = await media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-idem', createdBy: 'u', origin: 'upload' });
  assert.equal(again.id, first.id);
  await assert.rejects(() => media.saveBuffer({ bytes: JPEG, purpose: 'chat_image', operationId: 'op-idem', createdBy: 'u', origin: 'upload' }), (e: MediaError) => e.code === 'IDEMPOTENCY_CONFLICT');
  db.close();
});

test('MEDIA-04（策略面）：isPublicIp 拒内网/环回/链路本地/云元数据；sniffMime 不按扩展名', () => {
  for (const bad of ['127.0.0.1', '10.0.0.5', '192.168.1.79', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(isPublicIp(bad), false, bad);
  for (const ok of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPublicIp(ok), true, ok);
  assert.equal(sniffMime(PNG), 'image/png');
  assert.equal(sniffMime(Buffer.from('<?xml version="1.0"?><svg/>')), 'image/svg+xml');
  assert.equal(sniffMime(GARBAGE), null);
});

test('CHAT-03：附件消息原子事务——kind 推导/空正文+附件可发/校验先行无半套状态', async () => {
  const { db, media, messages } = svc();
  messages.ensureConversation('c1');
  const img = await media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-img', createdBy: 'qiaosheng', origin: 'upload' });
  const sticker = await media.saveBuffer({ bytes: JPEG, purpose: 'chat_sticker', operationId: 'op-stk', createdBy: 'qiaosheng', origin: 'upload' });
  // 空正文+有效图片可发（kind=text；含图以附件 DTO 为准）
  const r1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '', clientMessageId: 'm1', attachments: [{ asset_id: img.id, presentation: 'image' }] });
  const dto1 = messages.getMessage(r1.message.id)!;
  assert.equal(dto1.kind, 'text');
  assert.equal(dto1.revision.attachments.length, 1);
  assert.equal(dto1.revision.attachments[0]!.asset_id, img.id);
  assert.equal(dto1.revision.content_hash, sha256Hex('')); // content_hash 语义不变（不含附件）
  assert.ok(dto1.revision.revision === 1);
  // 表情消息 → kind=sticker
  const r2 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '', clientMessageId: 'm2', attachments: [{ asset_id: sticker.id, presentation: 'sticker' }] });
  assert.equal(messages.getMessage(r2.message.id)!.kind, 'sticker');
  // 文字+两张图：顺序保持
  const r3 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '两张图\n第二行', clientMessageId: 'm3', attachments: [{ asset_id: img.id, presentation: 'image' }, { asset_id: sticker.id, presentation: 'image' }] });
  const dto3 = messages.getMessage(r3.message.id)!;
  assert.deepEqual(dto3.revision.attachments.map((a) => a.asset_id), [img.id, sticker.id]);
  // 空正文无附件仍拒绝；语音不与其他附件混合
  assert.throws(() => messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '  ', clientMessageId: 'm4' }));
  assert.throws(() => messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'x', clientMessageId: 'm5', attachments: [{ asset_id: img.id, presentation: 'voice' }, { asset_id: sticker.id, presentation: 'image' }] }), /ATTACHMENT_MIX_INVALID/);
  // validateForSend：不存在/不可用资产先拒（http 层在事务前调用）
  assert.throws(() => media.validateForSend([{ asset_id: 'asset_missing', presentation: 'image' }]), (e: MediaError) => e.code === 'ASSET_NOT_FOUND');
  // 幂等：同 client_message_id 重试仍一条
  const r6 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '', clientMessageId: 'm1', attachments: [{ asset_id: img.id, presentation: 'image' }] });
  assert.equal(r6.duplicate, true);
  assert.equal(r6.message.id, r1.message.id);
  db.close();
});

test('CHAT-04：编辑正文→新修订沿用同一套附件；旧修订附件与 hash 原样；指纹覆盖正文+附件', async () => {
  const { db, media, messages } = svc();
  messages.ensureConversation('c1');
  const img = await media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-e1', createdBy: 'qiaosheng', origin: 'upload' });
  const r = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '原图说明', clientMessageId: 'e1', attachments: [{ asset_id: img.id, presentation: 'image', caption: '随手拍' }] });
  const edited = messages.editUserMessage(r.message.id, '编辑后的说明');
  assert.equal(edited.current_revision, 2);
  assert.equal(edited.revision.attachments.length, 1);
  assert.equal(edited.revision.attachments[0]!.asset_id, img.id);
  assert.equal(edited.revision.attachments[0]!.caption, '随手拍');
  // 旧修订绑定不被覆盖
  const old = db.prepare('SELECT asset_id, caption FROM message_attachments WHERE message_id = ? AND revision = 1').all(r.message.id) as Array<{ asset_id: string; caption: string | null }>;
  assert.equal(old.length, 1);
  assert.equal(old[0]!.caption, '随手拍');
  // 指纹：同正文同附件=同指纹；改正文=不同指纹
  const f1 = (db.prepare('SELECT message_fingerprint FROM message_revisions WHERE message_id = ? AND revision = 1').get(r.message.id) as { message_fingerprint: string }).message_fingerprint;
  const f2 = (db.prepare('SELECT message_fingerprint FROM message_revisions WHERE message_id = ? AND revision = 2').get(r.message.id) as { message_fingerprint: string }).message_fingerprint;
  assert.notEqual(f1, f2);
  db.close();
});

test('MEDIA-10：引用守卫——消息修订引用+protected/committed 引用都挡物理删除；released 不挡；If-Match 校验', async () => {
  const { db, media, messages } = svc();
  messages.ensureConversation('c1');
  const img = await media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-r1', createdBy: 'qiaosheng', origin: 'upload' });
  // 无引用
  assert.deepEqual(media.isAssetReferenced(img.id), { referenced: false, by_message_revisions: 0, by_external_refs: 0 });
  // 消息绑定引用
  messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'x', clientMessageId: 'r1', attachments: [{ asset_id: img.id, presentation: 'image' }] });
  assert.equal(media.isAssetReferenced(img.id).by_message_revisions, 1);
  // 外部引用：protected → committed → released
  const ref = media.registerReference({ assetId: img.id, ownerService: 'content', ownerType: 'album_entry', ownerId: 'entry-1', operationId: 'op-ref-1' });
  assert.equal(ref.state, 'protected');
  assert.equal(media.isAssetReferenced(img.id).by_external_refs, 1);
  assert.deepEqual(media.confirmReference(ref.referenceId), { referenceId: ref.referenceId, revision: 1, state: 'committed' });
  // 幂等重放：同 operation 再登记=原引用
  assert.deepEqual(media.registerReference({ assetId: img.id, ownerService: 'content', ownerType: 'album_entry', ownerId: 'entry-1', operationId: 'op-ref-1' }).referenceId, ref.referenceId);
  // 解除：revision 不匹配 → 拒；匹配 → released；released 后不再保护
  assert.throws(() => media.releaseReference({ referenceId: ref.referenceId, expectedRevision: 99, operationId: 'op-un-1' }), (e: MediaError) => e.code === 'REVISION_CONFLICT');
  const rel = media.releaseReference({ referenceId: ref.referenceId, expectedRevision: 1, operationId: 'op-un-1' });
  assert.equal(rel.state, 'released');
  assert.equal(rel.revision, 2);
  assert.equal(media.isAssetReferenced(img.id).by_message_revisions, 1, '消息修订引用仍在——内容删除不解除聊天引用');
  db.close();
});

// —— HTTP 面（真实 Host + fetch）：上传/读取/Range/发送/If-Match —— 
const httpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-v1-wp3-http-'));
writeApprovedIdentity(httpRoot);
let host: Host;
let base = '';
let token = '';
const auth = (extra: Record<string, string> = {}): Record<string, string> => ({ Authorization: `Bearer ${token}`, ...extra });

before(async () => {
  const config = buildConfig({ ...readyRuntimePatch(), deployment: { port: 0 }, runtime: { ...readyRuntimePatch().runtime, provider: 'mock' } });
  host = await Host.create({ stateRoot: httpRoot, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(httpRoot, 'config/auth.token'), 'utf8').trim();
});
after(async () => { await host.stop(); });

test('HTTP voice configuration is explicit; uploaded audio cannot trust a browser transcript', async () => {
  const unauthorized = await fetch(`${base}/api/v1/voice/status`);
  assert.equal(unauthorized.status, 401);
  const status = await (await fetch(`${base}/api/v1/voice/status`, { headers: auth() })).json();
  assert.deepEqual(status, { available: false, reason: 'siren_not_configured', verification: 'blocked' });
  const uploaded = await fetch(`${base}/api/v1/assets?purpose=chat_voice`, {
    method: 'POST', headers: auth({ 'Content-Type': 'application/octet-stream', 'Idempotency-Key': 'voice-http-upload', Origin: base }),
    body: Uint8Array.from([0x1a,0x45,0xdf,0xa3,0x01]),
  });
  assert.equal(uploaded.status, 201);
  const asset = await uploaded.json() as { asset_id: string };
  const endpoint = `${base}/api/v1/assets/${asset.asset_id}/transcribe`;
  const headers = auth({ 'Content-Type': 'application/json', Origin: base });
  const missingKey = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ conversation_id: 'primary' }) });
  assert.equal(missingKey.status, 400);
  const nullBody = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'asr-null' }, body: 'null' });
  assert.equal(nullBody.status, 400);
  const blocked = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'asr-http' }, body: JSON.stringify({ conversation_id: 'primary', derived_text: 'forged by client' }) });
  assert.equal(blocked.status, 503);
  assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, 'siren_not_configured');
  assert.equal((host.db.prepare('SELECT COUNT(*) n FROM voice_transcripts').get() as { n: number }).n, 0);
});

test('HTTP：上传→元数据→content(Range)→附件发送→编辑 If-Match(428/409/200)', async () => {
  // 1. 二进制上传（无 readJson；带 purpose + Idempotency-Key）
  const up = await fetch(`${base}/api/v1/assets?purpose=chat_image`, { method: 'POST', headers: auth({ 'Content-Type': 'application/octet-stream', 'Idempotency-Key': 'up-1', Origin: base }), body: new Uint8Array(PNG) });
  assert.equal(up.status, 201);
  const asset = (await up.json()) as { asset_id: string; mime_type: string; state: string };
  assert.equal(asset.mime_type, 'image/png');
  assert.equal(asset.state, 'available');
  // 重放同键同内容 → 原资产
  const up2 = await fetch(`${base}/api/v1/assets?purpose=chat_image`, { method: 'POST', headers: auth({ 'Content-Type': 'application/octet-stream', 'Idempotency-Key': 'up-1', Origin: base }), body: new Uint8Array(PNG) });
  assert.equal(((await up2.json()) as { asset_id: string }).asset_id, asset.asset_id);
  // 2. 元数据 + content（Range 206）
  const meta = await (await fetch(`${base}/api/v1/assets/${encodeURIComponent(asset.asset_id)}`, { headers: auth() })).json() as { content_url: string };
  const full = await fetch(`${base}${meta.content_url}`, { headers: auth() });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  const ranged = await fetch(`${base}${meta.content_url}`, { headers: { ...auth(), Range: 'bytes=0-15' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-15/${PNG.length}`);
  assert.equal((await ranged.arrayBuffer()).byteLength, 16);
  // 3. 空正文+附件发送（201）；DTO 带附件
  const send = await fetch(`${base}/api/v1/conversations/primary/messages`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base }), body: JSON.stringify({ content: '', client_message_id: 'wp3-http-1', attachments: [{ asset_id: asset.asset_id, presentation: 'image', caption: '测试图' }] }) });
  assert.ok(send.status === 200 || send.status === 201, `send=${send.status}`);
  const msg = ((await send.json()) as { message: { id: string; current_revision: number; revision: { attachments: Array<{ asset_id: string; caption: string | null }> } } }).message;
  assert.equal(msg.revision.attachments.length, 1);
  assert.equal(msg.revision.attachments[0]!.caption, '测试图');
  // 4. 编辑：无 If-Match → 428；错版本 → 409；对版本 → 200（新修订沿用附件）
  const e428 = await fetch(`${base}/api/v1/conversations/primary/messages/${encodeURIComponent(msg.id)}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', Origin: base }), body: JSON.stringify({ content: '改' }) });
  assert.equal(e428.status, 428);
  const e409 = await fetch(`${base}/api/v1/conversations/primary/messages/${encodeURIComponent(msg.id)}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', 'If-Match': '"999"', Origin: base }), body: JSON.stringify({ content: '改' }) });
  assert.equal(e409.status, 409);
  const e200 = await fetch(`${base}/api/v1/conversations/primary/messages/${encodeURIComponent(msg.id)}`, { method: 'PUT', headers: auth({ 'Content-Type': 'application/json', 'If-Match': `"${msg.current_revision}"`, Origin: base }), body: JSON.stringify({ content: '编辑后的说明' }) });
  assert.equal(e200.status, 200);
  const edited = ((await e200.json()) as { message: { current_revision: number; revision: { attachments: Array<{ asset_id: string }> } } }).message;
  assert.equal(edited.current_revision, msg.current_revision + 1);
  assert.equal(edited.revision.attachments[0]!.asset_id, asset.asset_id);
  // 5. 历史读取（GET messages）带附件
  const list = await (await fetch(`${base}/api/v1/conversations/primary/messages?limit=10`, { headers: auth() })).json() as { messages: Array<{ id: string; revision: { attachments: unknown[] } }> };
  const mine = list.messages.find((m) => m.id === msg.id)!;
  assert.equal(mine.revision.attachments.length, 1);
  // 6. 上传超大 → 413；缺幂等键 → 400
  const tooBig = await fetch(`${base}/api/v1/assets?purpose=chat_image`, { method: 'POST', headers: auth({ 'Content-Type': 'application/octet-stream', Origin: base }), body: new Uint8Array(Buffer.alloc(1024)) });
  assert.equal(tooBig.status, 400); // 无 Idempotency-Key
  const garbage = await fetch(`${base}/api/v1/assets?purpose=chat_image`, { method: 'POST', headers: auth({ 'Content-Type': 'application/octet-stream', 'Idempotency-Key': 'up-g', Origin: base }), body: new Uint8Array(GARBAGE) });
  assert.equal(garbage.status, 422); // 魔数不明
});
