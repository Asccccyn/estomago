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
import type { MariposaMediaStore } from '../../apps/host/src/integrations/mariposa/media-store.ts';
import { MariposaMediaStoreError } from '../../apps/host/src/integrations/mariposa/media-store.ts';
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

test('MEDIA-10：引用守卫——消息修订引用+操作 pin/committed 关系都挡物理删除；released 不挡', async () => {
  const { db, media, messages } = svc();
  messages.ensureConversation('c1');
  const img = await media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-r1', createdBy: 'qiaosheng', origin: 'upload' });
  // 无引用
  assert.deepEqual(media.isAssetReferenced(img.id), { referenced: false, by_message_revisions: 0, by_external_refs: 0 });
  // 消息绑定引用
  messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'x', clientMessageId: 'r1', attachments: [{ asset_id: img.id, presentation: 'image' }] });
  assert.equal(media.isAssetReferenced(img.id).by_message_revisions, 1);
  // 内容操作引用（P1·F06/F07 20261106）：HTTP 前 protected pin → 按权威快照 committed → 非成员 released
  media.pinAssetForOperation({ assetId: img.id, operationKey: 'op-ref-1' });
  assert.equal(media.isAssetReferenced(img.id).by_external_refs, 1, 'protected pin 挡物理删除（提交丢响应窗口）');
  media.pinAssetForOperation({ assetId: img.id, operationKey: 'op-ref-1' }); // 幂等：同操作不重复 pin
  assert.equal(media.isAssetReferenced(img.id).by_external_refs, 1);
  const confirmed = media.commitContentSnapshot({ type: 'album_entry', id: 'entry-1' }, { ownerRevision: 2, assetIds: [img.id] }, 'op-ref-1');
  assert.equal(confirmed.committed, 1, '快照成员落正式 committed 关系');
  assert.equal(confirmed.pinsReleased, 1, '本次操作 pin 收口');
  assert.equal(media.isAssetReferenced(img.id).by_external_refs, 1, 'committed 仍挡');
  // 零成员快照：同 owner 非成员关系释放 → 不再挡
  const emptied = media.commitContentSnapshot({ type: 'album_entry', id: 'entry-1' }, { ownerRevision: 3, assetIds: [] }, 'op-x');
  assert.equal(emptied.released, 1);
  assert.equal(media.isAssetReferenced(img.id).by_external_refs, 0, 'released 不挡');
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

test('MEDIA-M02（包1 2026-11-15）：work=SVG/HTML 作品引用可发送——不进图片白名单，位图不冒充 work，投影走文本引用', async () => {
  const { db, media, messages } = svc();
  messages.ensureConversation('c1');
  const svg = await media.saveBuffer({ bytes: Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><circle r="3"/></svg>'), purpose: 'creation_icon', operationId: 'op-work-1', createdBy: 'jiaming', origin: 'generated' });
  const png = await media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-work-2', createdBy: 'qiaosheng', origin: 'upload' });
  // 旧缺陷：SVG 走 presentation=image 被拒（保存成功却发不出去的根因）
  assert.throws(() => media.validateForSend([{ asset_id: svg.id, presentation: 'image' }]), (e: MediaError) => e.code === 'ASSET_TYPE_UNSUPPORTED');
  // work：svg 放行；png 冒充 work 拒（隔离方向不放宽）
  media.validateForSend([{ asset_id: svg.id, presentation: 'work' }]);
  assert.throws(() => media.validateForSend([{ asset_id: png.id, presentation: 'work' }]), (e: MediaError) => e.code === 'ASSET_TYPE_UNSUPPORTED');
  // 真实发布链路（v71 CHECK 含 work）：附件消息可入库、投影给文本引用+沙箱预览入口而非位图块
  const msg = messages.publishAssistantMessage({ conversationId: 'c1', turnId: 't1', content: '', clientMessageId: 'work-send-1', attachments: [{ asset_id: svg.id, presentation: 'work' }] });
  assert.equal(msg.revision.attachments[0]!.presentation, 'work');
  const { projectRevisionBlocks } = await import('../../apps/host/src/media/model-input.ts');
  const proj = projectRevisionBlocks('', [{ asset_id: svg.id, presentation: 'work', caption: null, derived_text: null, derived_source: null }]);
  assert.equal(proj.hasImage, false, '代码作品不投位图块');
  assert.ok(proj.blocks.some((b) => b.type === 'text' && String((b as { text: string }).text).includes(`/api/v1/assets/${svg.id}/preview`)), '投影带沙箱预览入口');
  db.close();
});

test('C3 HTTP：聊天附件放弃不进 M，部分落正保留原操作重试，共享正本保持有效', async () => {
  const media = host.heartbeat.media;
  const attempts: string[] = [];
  const masterObjects = new Set<string>();
  const pngHash = sha256Hex(PNG);
  const jpegHash = sha256Hex(JPEG);
  let unavailableHash: string | null = jpegHash;
  const store = {
    uploadBytes: async (bytes: Uint8Array) => {
      const content_hash = sha256Hex(Buffer.from(bytes));
      attempts.push(content_hash);
      if (unavailableHash === content_hash) throw new MariposaMediaStoreError('UNAVAILABLE', 'M 合成不可达');
      const deduplicated = masterObjects.has(content_hash);
      masterObjects.add(content_hash);
      return { content_hash, deduplicated };
    },
  } as unknown as MariposaMediaStore;
  const storeSlot = media as unknown as { mStore: MariposaMediaStore | null };
  storeSlot.mStore = store;
  const pick = (key: string, bytes: Buffer) => fetch(`${base}/api/v1/assets?purpose=chat_image&staged=1`, { method: 'POST',
    headers: auth({ 'Content-Type': 'application/octet-stream', 'Idempotency-Key': key, Origin: base }), body: new Uint8Array(bytes) });
  const send = (clientMessageId: string, ...assetIds: string[]) => fetch(`${base}/api/v1/conversations/primary/messages`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json', Origin: base }),
    body: JSON.stringify({ content: '看这两张图', client_message_id: clientMessageId, attachments: assetIds.map(asset_id => ({ asset_id, presentation: 'image' })) }) });
  const selected = async (key: string, bytes: Buffer) => {
    const response = await pick(key, bytes);
    assert.equal(response.status, 201);
    const receipt = await response.json() as { asset_id: string; m_sync_state: string };
    assert.equal(receipt.m_sync_state, 'staged');
    return receipt.asset_id;
  };
  const messageCount = (key: string) => host.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_message_id = ?').get(key)?.n;
  try {
    const first = await selected('staged-pick-1', PNG);
    assert.equal(await selected('staged-pick-1', PNG), first, '选中文件同键重试仍为原暂存资产');
    const second = await selected('staged-pick-2', JPEG);
    assert.deepEqual(attempts, []);
    // 记录 #10 尚存的边界：第一张在 M 落正，第二张失败，E 没有正式消息。
    const refused = await send('staged-send-1', first, second);
    assert.equal(refused.status, 503);
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'asset_master_commit_failed');
    assert.equal(messageCount('staged-send-1'), 0);
    assert.equal(media.getAsset(first).m_sync_state, 'synced');
    assert.equal(media.getAsset(second).m_sync_state, 'staged');
    assert.deepEqual([...masterObjects], [pngHash]);
    assert.equal(media.isAssetReferenced(first).referenced, false);
    const discardLanded = await fetch(`${base}/api/v1/assets/${first}?staged=1`, { method: 'DELETE', headers: auth({ Origin: base }) });
    assert.equal(discardLanded.status, 409, '编辑器的草稿清理保留已落正但可重试的资产身份');
    assert.equal(media.getAsset(first).state, 'available');
    unavailableHash = null;
    const sent = await send('staged-send-1', first, second);
    assert.ok(sent.status === 200 || sent.status === 201, `send=${sent.status}`);
    const replay = await send('staged-send-1', first, second);
    assert.equal(replay.status, 200);
    assert.deepEqual(attempts, [pngHash, jpegHash, jpegHash], '只重新上传未落正项');
    assert.equal(messageCount('staged-send-1'), 1);
    assert.equal(media.getAsset(second).m_sync_state, 'synced');
    for (const id of [first, second]) assert.equal(media.isAssetReferenced(id).by_message_revisions, 1);
    const kept = await fetch(`${base}/api/v1/assets/${first}`, { method: 'DELETE', headers: auth({ Origin: base }) });
    assert.equal(kept.status, 409);

    const shared = await selected('staged-pick-3', PNG);
    assert.notEqual(shared, first, '同哈希为不同 E 资产');
    const uniqueBytes = Buffer.concat([JPEG, Buffer.from('独有字节')]);
    unavailableHash = sha256Hex(uniqueBytes);
    const unique = await selected('staged-pick-4', uniqueBytes);
    const secondBatch = await send('staged-send-2', shared, unique);
    assert.equal(secondBatch.status, 503);
    assert.equal(messageCount('staged-send-2'), 0);
    assert.equal(media.isAssetReferenced(first).by_message_revisions, 1);
    assert.equal(media.getAsset(unique).m_sync_state, 'staged');
    const discarded = await fetch(`${base}/api/v1/assets/${unique}`, { method: 'DELETE', headers: auth({ Origin: base }) });
    assert.equal(discarded.status, 200);
    assert.equal(((await discarded.json()) as { state: string }).state, 'discarded');
    assert.equal((await fetch(`${base}/api/v1/assets/${unique}`, { headers: auth() })).status, 404);
    assert.deepEqual([...masterObjects], [pngHash, jpegHash], '相同字节复用原正式对象');

    const abandoned = await selected('staged-abandoned', uniqueBytes);
    const beforeDiscard = attempts.length;
    assert.equal((await fetch(`${base}/api/v1/assets/${abandoned}?staged=1`, { method: 'DELETE', headers: auth({ Origin: base }) })).status, 200);
    assert.equal(attempts.length, beforeDiscard, '未点击发送的草稿完全不进 M');
  } finally { storeSlot.mStore = null; }
});
