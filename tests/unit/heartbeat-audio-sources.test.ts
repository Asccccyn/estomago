import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readHeartbeatProjection, type HeartbeatSource } from '../../packages/contracts/src/heartbeat.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { HeartbeatSources } from '../../apps/host/src/modules/heartbeat/sources.ts';
import { OidoSourceRepository } from '../../apps/host/src/modules/oido/source-repository.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { makeDb } from '../helpers.ts';

test('heartbeat voice cards bind their existing room and byte-authorized transcript without weakening browser playback', async t => {
  const { db, root } = makeDb();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  messages.ensureConversation('other-room');
  const master = {
    uploadBytes: async (bytes: Uint8Array) => ({ content_hash: sha256Hex(bytes) }),
  };
  const media = new MediaService(db, path.join(root, 'media'), buildConfig(), master as never);
  async function audio(operationId: string, suffix: string) {
    return media.saveBuffer({ bytes: Buffer.from('RIFF0000WAVE' + suffix, 'ascii'), purpose: 'chat_voice',
      origin: 'upload', createdBy: 'qiaosheng', operationId });
  }
  const postAudio = await audio('post-original', 'one');
  const noteAudio = await audio('note-original', 'two');
  const foreignAudio = await audio('foreign-original', 'three');
  assert.equal(postAudio.m_sync_state, 'synced');
  const trusted = db.prepare(`INSERT INTO voice_transcripts
    (asset_id,conversation_id,operation_key,state,content_sha256,derived_text,derived_source,created_at,updated_at)
    VALUES(?,?,?,'ready',?,?,'siren:transcribe','now','now')`);
  trusted.run(postAudio.id, 'primary', 'known-post-transcript', postAudio.content_sha256, '合成原声一');
  trusted.run(noteAudio.id, 'primary', 'known-note-transcript', noteAudio.content_sha256, '合成原声二');
  trusted.run(foreignAudio.id, 'other-room', 'different-conversation-transcript', foreignAudio.content_sha256, '其他会话，不应泄露');

  const post = { id: 'post1', revision: 3, body: '', asset_ids: [postAudio.id] };
  const note = { id: 'note1', revision: 4, body: '预留说明', asset_ids: [noteAudio.id] };
  const wrongRoom = { id: 'note2', revision: 1, body: '只有说明，不应冒充语音', asset_ids: [foreignAudio.id] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://content.test');
    assert.equal(init?.method, 'GET');
    if (url.pathname === '/api/v1/content/posts') return Response.json({ items: [post], next_cursor: null });
    if (url.pathname === '/api/v1/content/future-notes') return Response.json({ items: [note, wrongRoom], next_cursor: null });
    const item = [post, note, wrongRoom].find(entry => url.pathname.endsWith('/' + entry.id));
    return Response.json(item ?? { items: [], next_cursor: null });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const sources = new HeartbeatSources({ baseUrl: 'http://content.test', token: 'fixture-only' }, media,
    {} as never, messages, { voice: new OidoSourceRepository(db) }, () => 0);
  const signal = new AbortController().signal;
  const chosen = await sources.choose('primary', () => true, signal);
  assert.deepEqual(chosen.map(source => source.id).sort(), ['note1', 'post1']);
  for (const source of chosen) {
    assert.match(source.selection?.voiceTranscriptRevision ?? '', /^[0-9a-f]{64}$/);
    const normalized = readHeartbeatProjection({ mode: 'draw', conversationId: 'primary', businessDate: '2026-11-20',
      version: 1, state: 'drawn', card: { number: 1, source }, messages: [] });
    assert.equal(normalized?.card?.source.selection?.voiceTranscriptRevision, source.selection?.voiceTranscriptRevision);
  }
  const postSource = chosen.find(source => source.kind === 'moments')!;
  const noteSource = chosen.find(source => source.kind === 'reserved_note')!;
  const providerPost = await sources.resolve(postSource, 'primary', signal);
  const providerNote = await sources.resolve(noteSource, 'primary', signal);
  assert.equal(providerPost.status === 'available' && providerPost.text, '[原声转写] 合成原声一');
  assert.equal(providerNote.status === 'available' && providerNote.text, '预留说明\n\n[原声转写] 合成原声二');
  const wrongSource: HeartbeatSource = {
    kind: 'reserved_note', namespace: 'content', id: 'note2', revision: 1, identity: 'note2', permissionScope: 'primary',
  };
  assert.deepEqual(await sources.resolve(wrongSource, 'primary', signal), { status: 'revision_unavailable' });
  const mismatch = db.prepare("UPDATE voice_transcripts SET content_sha256='unrelated-bytes' WHERE asset_id=?");
  mismatch.run(noteAudio.id);
  assert.deepEqual(await sources.resolve(noteSource, 'primary', signal), { status: 'revision_unavailable' });
  db.prepare("UPDATE voice_transcripts SET derived_text='晚到的另一版' WHERE asset_id=?").run(postAudio.id);
  assert.deepEqual(await sources.resolve(postSource, 'primary', signal), { status: 'revision_unavailable' });
  const browserPost = await sources.resolve(postSource, 'primary', signal, 'qiaosheng');
  assert.deepEqual(browserPost, { status: 'available', text: '', assetIds: [postAudio.id], imageIds: [] });
});
