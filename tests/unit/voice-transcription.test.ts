import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService, MediaError } from '../../apps/host/src/media/assets.ts';
import { VoiceService } from '../../apps/host/src/media/voice.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { projectRevisionBlocks } from '../../apps/host/src/media/model-input.ts';

const credentialRef = 'ESTOMAGO_TEST_VOICE_CREDENTIAL';
let previousCredential: string | undefined;
before(() => {
  assert.equal(process.env.ESTOMAGO_TEST_MODE, '1', 'only isolated test mode');
  previousCredential = process.env[credentialRef];
  process.env[credentialRef] = 'unit-only-synthetic-voice-token';
});
after(() => {
  if (previousCredential === undefined) delete process.env[credentialRef];
  else process.env[credentialRef] = previousCredential;
});

function fixture(transport: typeof fetch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-voice-test-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const config = buildConfig({ integrations: { siren: { base_url: 'https://voice.example.invalid', credential_ref: credentialRef, contract_version: '1.1.1' } } });
  const media = new MediaService(db, path.join(root, 'media'), config);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  messages.ensureConversation('other');
  const voice = new VoiceService(db, media, config, transport);
  const upload = (suffix = 0, createdBy = 'qiaosheng') => media.saveBuffer({ bytes: Uint8Array.from([0x1a,0x45,0xdf,0xa3,0x01,suffix]), purpose: 'chat_voice', operationId: `voice-upload-${suffix}`, createdBy, origin: 'upload' });
  return { root, db, config, media, messages, voice, upload, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('real ASR request shape; cached trusted transcript survives restart and is copied into send revision', async () => {
  let calls = 0;
  const f = fixture(async (url, opts) => {
    calls++;
    assert.equal(String(url), 'https://voice.example.invalid/v1/voice/transcribe');
    assert.equal(opts?.method, 'POST');
    assert.equal(opts?.redirect, 'error');
    assert.equal(new Headers(opts?.headers).get('Authorization'), 'Bearer unit-only-synthetic-voice-token');
    const form = opts?.body as FormData;
    assert.equal(form.get('store'), 'false');
    assert.equal(form.get('conversation_id'), 'primary');
    assert.equal(form.get('format'), 'webm');
    assert.equal((form.get('audio') as Blob).type, 'audio/webm');
    return Response.json({ text: '可信语音转写', language: 'zh', duration_ms: 1200 });
  });
  try {
    const asset = await f.upload();
    const result = await f.voice.transcribe(asset.id, 'primary', 'asr-1');
    assert.equal(result.state, 'ready');
    assert.equal(result.derived_text, '可信语音转写');
    assert.equal(result.duration_ms, 1200);
    const again = await new VoiceService(f.db, f.media, f.config, async () => { throw new Error('must use persisted result'); }).transcribe(asset.id, 'primary', 'asr-retry');
    assert.equal(again.cached, true);
    assert.equal(calls, 1);
    const attachments = [{ asset_id: asset.id, presentation: 'voice' as const, derived_text: '客户端伪造文字' }];
    const sent = f.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '', clientMessageId: 'send-1', attachments });
    const dto = sent.message;
    assert.equal(dto.kind, 'voice');
    assert.equal(dto.revision.content, '');
    assert.equal(dto.revision.attachments[0]?.derived_text, '可信语音转写');
    assert.equal(dto.revision.attachments[0]?.derived_source, 'siren:transcribe');
    assert.equal(projectRevisionBlocks('', dto.revision.attachments, { isCurrentInput: true }).hasVoiceWithoutTranscript, false);
    const edit = f.messages.editUserMessage(dto.id, '新增文字说明');
    assert.equal(edit.revision.attachments[0]?.derived_text, '可信语音转写');
    assert.equal((f.db.prepare('SELECT derived_text FROM message_attachments WHERE message_id=? AND revision=1').get(dto.id) as { derived_text:string }).derived_text, '可信语音转写');
    assert.equal(f.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '新增文字说明', clientMessageId: 'send-1', attachments }).duplicate, true);
  } finally { f.close(); }
});

test('browser transcript cannot create a trusted voice projection; unrelated conversation stays isolated', async () => {
  const f = fixture(async () => Response.json({ text: '真实结果' }));
  try {
    const asset = await f.upload();
    const initial = f.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '', clientMessageId: 'before-transcribe', attachments: [{ asset_id: asset.id, presentation: 'voice', ...{ derived_text: 'forged' } }] });
    assert.equal(initial.message.revision.attachments[0]?.derived_text, null);
    assert.equal(projectRevisionBlocks('', initial.message.revision.attachments, { isCurrentInput: true }).hasVoiceWithoutTranscript, true);
    await f.voice.transcribe(asset.id, 'primary', 'asr-1');
    // Later ASR does not mutate a previously saved revision.
    assert.equal(f.messages.getMessage(initial.message.id)?.revision.attachments[0]?.derived_text, null);
    await assert.rejects(() => f.voice.transcribe(asset.id, 'other', 'asr-other'), (e: MediaError) => e.code === 'VOICE_TRANSCRIPT_CONFLICT');
    const other = f.messages.submitUserMessageWithTurn({ conversationId: 'other', content: '', clientMessageId: 'other-message', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    assert.equal(other.message.revision.attachments[0]?.derived_text, null);
    const another = await f.upload(1);
    await assert.rejects(() => f.voice.transcribe(another.id, 'primary', 'asr-1'), (e: MediaError) => e.code === 'IDEMPOTENCY_CONFLICT');
  } finally { f.close(); }
});

test('concurrent same-asset calls and uncertain outcomes never replay the external request', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const f = fixture(async () => { calls++; await gate; throw new Error('private upstream diagnostics must not escape'); });
  try {
    const asset = await f.upload();
    const pending = f.voice.transcribe(asset.id, 'primary', 'asr-1');
    await assert.rejects(() => f.voice.transcribe(asset.id, 'primary', 'asr-2'), (e: MediaError) => e.code === 'VOICE_TRANSCRIPTION_UNCONFIRMED');
    release();
    await assert.rejects(() => pending, (e: MediaError) => e.code === 'SIREN_OUTCOME_UNKNOWN' && !e.message.includes('private upstream'));
    await assert.rejects(() => f.voice.transcribe(asset.id, 'primary', 'asr-3'), (e: MediaError) => e.code === 'VOICE_TRANSCRIPTION_UNCONFIRMED');
    assert.equal(calls, 1);
    assert.equal((f.db.prepare('SELECT state FROM voice_transcripts WHERE asset_id=?').get(asset.id) as { state:string }).state, 'unknown');
  } finally { release(); f.close(); }
});

test('confirmed rejection and empty transcripts stay failed; explicit new operation can retry', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) return new Response('upstream private diagnostic', { status: 401 });
    if (calls === 2) return Response.json({ text: '   ' });
    return Response.json({ text: '最终结果' });
  });
  try {
    const asset = await f.upload();
    await assert.rejects(() => f.voice.transcribe(asset.id, 'primary', 'asr-1'), (e: MediaError) => e.code === 'SIREN_AUTH_REJECTED');
    await assert.rejects(() => f.voice.transcribe(asset.id, 'primary', 'asr-1'), (e: MediaError) => e.code === 'SIREN_AUTH_REJECTED');
    assert.equal(calls, 1);
    await assert.rejects(() => f.voice.transcribe(asset.id, 'primary', 'asr-2'), (e: MediaError) => e.code === 'SIREN_TRANSCRIPT_EMPTY');
    assert.equal((await f.voice.transcribe(asset.id, 'primary', 'asr-3')).derived_text, '最终结果');
  } finally { f.close(); }
});

test('unconfigured, unsupported contract, missing credential and unsafe URL are explicit blocked states', async () => {
  const f = fixture(async () => { throw new Error('external transport must not run'); });
  try {
    const asset = await f.upload();
    for (const [patch, reason] of [
      [{ base_url:null }, 'siren_not_configured'],
      [{ contract_version:'unverified' }, 'siren_contract_unverified'],
      [{ credential_ref:'ESTOMAGO_TEST_VOICE_MISSING' }, 'siren_credential_missing'],
      [{ base_url:'http://voice.example.invalid' }, 'siren_url_invalid'],
    ] as const) {
      const config = buildConfig({ integrations: { siren: { ...f.config.integrations.siren, ...patch } } });
      const voice = new VoiceService(f.db, f.media, config, async () => { throw new Error('must not call'); });
      assert.deepEqual(voice.status(), { available:false, reason, verification:'blocked' });
      await assert.rejects(() => voice.transcribe(asset.id, 'primary', 'asr-blocked'), (e: MediaError) => e.httpStatus === 503);
    }
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM voice_transcripts').get() as { n:number }).n, 0);
    const foreign = await f.upload(9, 'jiaming');
    await assert.rejects(() => f.voice.transcribe(foreign.id, 'primary', 'foreign'), (e: MediaError) => e.code === 'VOICE_ASSET_NOT_ALLOWED');
  } finally { f.close(); }
});
