import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { projectRevisionBlocks } from '../../apps/host/src/media/model-input.ts';
import { OidoAdapter } from '../../apps/host/src/integrations/oido/adapter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';

// JOINT-VOICE-20261022（04）用户语音闭环单元/合同：V06 无转写可听→结构化引用进入；
// V07 无听觉能力→阻断语义保持；转写单份；历史投影零变化（缓存前缀不可变）；
// façade 工具权限门（O11：不因模型报了 asset_id 就放行）。全合成夹具。

const credentialRef = 'ESTOMAGO_TEST_OIDO_CREDENTIAL';
let previousCredential: string | undefined;
before(() => {
  assert.equal(process.env.ESTOMAGO_TEST_MODE, '1', 'only isolated test mode');
  previousCredential = process.env[credentialRef];
  process.env[credentialRef] = 'unit-only-oido-token';
});
after(() => {
  if (previousCredential === undefined) delete process.env[credentialRef];
  else process.env[credentialRef] = previousCredential;
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-hearing-test-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const config = buildConfig({ integrations: { oido: { base_url: 'http://127.0.0.1:8791', credential_ref: credentialRef } } });
  const media = new MediaService(db, path.join(root, 'media'), config);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  messages.ensureConversation('other');
  const upload = (suffix = 0) => media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, suffix]), purpose: 'chat_voice', operationId: `hear-upload-${suffix}`, createdBy: 'qiaosheng', origin: 'upload' });
  return { root, db, config, media, messages, upload, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const voiceAttachment = (assetId: string, derivedText: string | null) => ({
  asset_id: assetId, presentation: 'voice', caption: null,
  derived_text: derivedText, derived_source: derivedText ? 'siren:transcribe' : null,
});

// ── 投影层 ────────────────────────────────────────────────────────────
test('V06: 无转写+听觉可用 → 结构化语音引用进入，不再阻断', () => {
  const f = fixture();
  try {
    const r = projectRevisionBlocks('', [voiceAttachment('ast_voice1', null)], { isCurrentInput: true, hearing: { available: true }, voiceDurations: new Map([['ast_voice1', 2300]]) });
    assert.equal(r.hasVoiceWithoutTranscript, false, '门不再阻断');
    const text = r.blocks.map((b) => b.type === 'text' ? b.text : '').join('\n');
    assert.match(text, /audio_ref: est:ast_voice1/);
    assert.match(text, /2300ms/);
    assert.match(text, /oido_analyze/);
  } finally { f.close(); }
});

test('V07: 无转写+无听觉能力 → 阻断语义保持（hasVoiceWithoutTranscript）', () => {
  const f = fixture();
  try {
    const r = projectRevisionBlocks('', [voiceAttachment('ast_voice2', null)], { isCurrentInput: true });
    assert.equal(r.hasVoiceWithoutTranscript, true);
    assert.equal(r.blocks.length, 0, '不产生空输入块');
    const r2 = projectRevisionBlocks('', [voiceAttachment('ast_voice2', null)], { isCurrentInput: true, hearing: { available: false } });
    assert.equal(r2.hasVoiceWithoutTranscript, true, '未配置 oído=不可听');
  } finally { f.close(); }
});

test('转写存在：只出现一次；听觉可用时附原声引用行（当前输入）', () => {
  const f = fixture();
  try {
    const r = projectRevisionBlocks('', [voiceAttachment('ast_voice3', '今天好累')], { isCurrentInput: true, hearing: { available: true }, voiceDurations: new Map([['ast_voice3', 4100]]) });
    const text = r.blocks.map((b) => b.type === 'text' ? b.text : '').join('\n');
    assert.equal((text.match(/今天好累/g) ?? []).length, 1, '转写单份');
    assert.match(text, /语音消息转写/);
    assert.match(text, /audio_ref: est:ast_voice3/);
    // 听觉不可用：不附引用行（工具不存在时引用是噪声）
    const r2 = projectRevisionBlocks('', [voiceAttachment('ast_voice3', '今天好累')], { isCurrentInput: true });
    const text2 = r2.blocks.map((b) => b.type === 'text' ? b.text : '').join('\n');
    assert.doesNotMatch(text2, /audio_ref/);
  } finally { f.close(); }
});

test('A05: 历史投影零变化（isCurrentInput=false 不带 audio_ref/引用行）', () => {
  const f = fixture();
  try {
    const r = projectRevisionBlocks('', [voiceAttachment('ast_voice4', null)], { hearing: { available: true }, voiceDurations: new Map([['ast_voice4', 900]]) });
    const text = r.blocks.map((b) => b.type === 'text' ? b.text : '').join('\n');
    assert.equal(text, '[语音消息：本条无转写，原音频已保留]', '历史占位原样');
    const r2 = projectRevisionBlocks('', [voiceAttachment('ast_voice4', '早')], {});
    const text2 = r2.blocks.map((b) => b.type === 'text' ? b.text : '').join('\n');
    assert.doesNotMatch(text2, /audio_ref/, '历史块绝不带新引用（缓存前缀不可变）');
  } finally { f.close(); }
});

// ── façade 工具 ───────────────────────────────────────────────────────
function executorFixture(transportCalls: Array<{ url: string; body?: string }>) {
  const f = fixture();
  const adapter = new OidoAdapter(f.config.integrations.oido);
  const origFetch = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = (async (url: any, opts: any) => {
    transportCalls.push({ url: String(url), body: typeof opts?.body === 'string' ? opts.body : undefined });
    if (String(url).endsWith('/v1/audio:ingest')) return Response.json({ audio_id: 'aud_t1', deduplicated: false });
    if (String(url).endsWith('/transcript')) return Response.json({ stored: true });
    if (String(url).endsWith('/v1/analyses')) return Response.json({ analysis_id: 'run_t1', revision: 1, state: 'ready', range_ms: [0, 1200], observations: [] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const reviews = new RotationReviewService(f.db);
  const checkpoint = new HoldCheckpointService(f.db);
  const tools = new HostToolExecutor({ db: f.db, mariposa: null, reviews, checkpoint, media: f.media, messages: f.messages, oido: adapter });
  const publish = (conversationId: string, assetId: string, clientMessageId: string) =>
    f.messages.publishAssistantMessage({ conversationId, turnId: 't1', content: '', kind: 'voice', clientMessageId, attachments: [{ asset_id: assetId, presentation: 'voice' }] });
  return { f, tools, publish, restore() { (globalThis as { fetch?: typeof fetch }).fetch = origFetch; } };
}

test('工具：会话内绑定资产 → 权限通过、受信导入+分析被调用（V09 离线形态）', async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const h = executorFixture(calls);
  try {
    const asset = await h.f.upload(1);
    // 她发出带语音附件的消息（primary 会话）
    h.publish('primary', asset.id, 'm-hear-1');
    const r = await h.tools.execute('oido_analyze', { audio_ref: `est:${asset.id}` }, { roomId: 'primary', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r1' });
    assert.equal(r.ok, true, JSON.stringify(r.output));
    assert.equal(r.output['analysis_id'], 'run_t1');
    const ingest = calls.find((c) => c.url.endsWith('/v1/audio:ingest'));
    assert.ok(ingest, '受信导入被调用');
    assert.equal((calls.filter((c) => c.url.endsWith('/v1/analyses'))).length, 1, '分析恰好一次');
  } finally { h.restore(); h.f.close(); }
});

test('工具 O11：其他会话的资产 / 不存在的资产 → 拒绝，不出网', async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const h = executorFixture(calls);
  try {
    const asset = await h.f.upload(2);
    h.publish('other', asset.id, 'm-hear-2');
    const r = await h.tools.execute('oido_analyze', { audio_ref: `est:${asset.id}` }, { roomId: 'primary', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r1' });
    assert.equal(r.ok, false);
    assert.equal(r.output['error_code'], 'ASSET_NOT_IN_ROOM');
    const r2 = await h.tools.execute('oido_analyze', { audio_ref: 'est:ast_missing' }, { roomId: 'primary', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r1' });
    assert.equal(r2.ok, false);
    assert.equal(calls.length, 0, '拒绝时零网络调用');
  } finally { h.restore(); h.f.close(); }
});

test('工具：oído 不可达 → 如实 OIDO_UNAVAILABLE 可重试语义', async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const h = executorFixture(calls);
  const origFetch = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
  try {
    const asset = await h.f.upload(3);
    h.publish('primary', asset.id, 'm-hear-3');
    const r = await h.tools.execute('oido_analyze', { audio_ref: `est:${asset.id}` }, { roomId: 'primary', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r1' });
    assert.equal(r.ok, false);
    assert.equal(r.output['error_code'], 'OIDO_UNAVAILABLE');
  } finally {
    (globalThis as { fetch?: typeof fetch }).fetch = origFetch;
    h.f.close();
  }
});
