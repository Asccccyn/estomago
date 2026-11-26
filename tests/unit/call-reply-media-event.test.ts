// B2（2026-11-04）单元回归：CallReplyLinkService 媒体更新事件——附件**新增**绑定时发布
// message.media.updated（同事务持久+提交后分发）；basis 演进重收敛不动附件=不重复通知；
// 无 events 依赖=如实降级为旧行为。事件 payload 携带最新消息 DTO（客户端 absorb 直接消费）。
// 外部边界替身沿用 call-reply-links.test.ts：SirenAdapter / M attachmentsSync。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { VoiceObservationService } from '../../apps/host/src/modules/oido/observations.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { CallReplyLinkService } from '../../apps/host/src/modules/voice/call-links.ts';
import type { SirenAdapter, SirenCallAudioTurn } from '../../apps/host/src/integrations/siren/adapter.ts';
import { tempRoot } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

const mp3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04]), Buffer.alloc(128)]);

function fakeSiren(initial: SirenCallAudioTurn[]) {
  let current = initial;
  return {
    callTurnAudio: async () => ({ turns: current, audio_finalized: false }),
    fetchVoiceAssetAudio: async () => ({ bytes: new Uint8Array(mp3), mime: 'audio/mpeg' }),
    set turns(v: SirenCallAudioTurn[]) { current = v; },
  } as unknown as SirenAdapter;
}

const hearingStub = {
  analyzeVoice: async () => ({ ok: false as const, error: { error_code: 'OIDO_UNAVAILABLE' } }),
  getEvidence: async () => ({ ok: false as const, error: { error_code: 'OIDO_UNAVAILABLE' } }),
};

function compose() {
  const root = tempRoot('glm-b2-media-event-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const config = buildConfig({});
  const paths = buildPaths(root);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const media = new MediaService(db, paths.mediaDir, config);
  const voiceObs = new VoiceObservationService(db, { hearing: hearingStub as never, archiveClient: null, streamId: 'estomago-primary-live' });
  return {
    root, db, messages, media, voiceObs,
    admitCompletedTurn(callId: string, turnKey: string): string {
      db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,analysis_mode) VALUES (?,'primary','active',?,'ordinary')").run(callId, new Date().toISOString());
      const sub = messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在吗？', clientMessageId: `voice:${callId}:${turnKey}` });
      const now = new Date().toISOString();
      db.prepare("INSERT INTO voice_stream_turns(call_id,turn_key,conversation_id,text_sha256,est_turn_id,state,created_at,updated_at) VALUES (?,?,?,?,?,'completed',?,?)")
        .run(callId, turnKey, 'primary', sha256Hex('在吗？'), sub.turnId, now, now);
      const assistant = messages.publishAssistantMessage({ conversationId: 'primary', turnId: sub.turnId, content: '好呀，我在。', kind: 'text', clientMessageId: `assistant:${callId}:${turnKey}` });
      return assistant.id;
    },
  };
}

const turn = (playback: SirenCallAudioTurn['playback']): SirenCallAudioTurn[] => [{
  turn_id: 't1', turn_index: 1, outcome: 'completed', user_audio: null,
  reply_audio: { asset_id: 'sir-rep-1', duration_ms: 1500, completeness: 'complete' },
  sent_audio_ms: 1500, filler_audio_ms: 0, playback,
}];

test('B2：附件新增绑定→message.media.updated（同事务持久+提交后分发，payload 带消息 DTO）', async () => {
  const c = compose();
  const events = new EventService(c.db);
  const dispatched: Array<{ kind: string; sequence: number; payload: unknown }> = [];
  const eventsPort = {
    persistInTx: events.persistInTx.bind(events),
    dispatchRow: (row: unknown) => { const r = row as { kind: string; sequence: number; payload_ref?: string }; dispatched.push({ kind: r.kind, sequence: r.sequence, payload: JSON.parse(r.payload_ref ?? '{}') }); },
  };
  const svc = new CallReplyLinkService({
    db: c.db, sirenCall: fakeSiren(turn({ basis: 'unknown' })), media: c.media, voiceObservations: c.voiceObs,
    attachmentsClient: null, streamId: 'estomago-primary-live',
    events: eventsPort, getMessage: (id) => c.messages.getMessage(id) as unknown as Record<string, unknown> | null,
  });
  try {
    svc.start();
    const assistantId = c.admitCompletedTurn('call-1', 't1');
    await svc.wake();
    // 事件已持久（SSE 回放可见）且已分发（在线页面即时可见）
    assert.equal(dispatched.length, 1, '恰好一条媒体事件');
    assert.equal(dispatched[0]!.kind, 'message.media.updated');
    const persisted = c.db.prepare("SELECT kind, conversation_id, turn_id, entity_ref FROM runtime_stream_events WHERE kind='message.media.updated'").get() as Record<string, unknown>;
    assert.equal(persisted['conversation_id'], 'primary');
    assert.equal(persisted['entity_ref'], assistantId);
    const payload = dispatched[0]!.payload as { message: { id: string; revision: { attachments: Array<{ asset_id: string; presentation: string }> } } };
    assert.equal(payload.message.id, assistantId, 'payload 携带最新消息 DTO');
    assert.equal(payload.message.revision.attachments.length, 1);
    assert.equal(payload.message.revision.attachments[0]!.presentation, 'voice');

    // basis 演进重收敛（unknown→client_drained）：附件不变=不再发媒体事件
    c.db.prepare('UPDATE voice_calls SET state=? WHERE call_id=?').run('ended', 'call-1');
    const siren2 = fakeSiren(turn({ basis: 'client_drained' }));
    // 第二个 service 实例对同一 DB 收敛（幂等键相同）——旧实例仍持有旧 snapshot 缓存
    const svc2 = new CallReplyLinkService({
      db: c.db, sirenCall: siren2, media: c.media, voiceObservations: c.voiceObs,
      attachmentsClient: null, streamId: 'estomago-primary-live',
      events: eventsPort, getMessage: (id) => c.messages.getMessage(id) as unknown as Record<string, unknown> | null,
    });
    svc2.start();
    await svc2.wake();
    assert.equal(dispatched.length, 1, 'basis 演进不重复通知');

    // 幂等重放：再 wake 仍只有一条
    await svc2.wake();
    assert.equal(dispatched.length, 1);
  } finally {
    await svc.stop().catch(() => {});
  }
});

test('B2：无 events 依赖=如实降级（不崩溃、不发事件，附件照常绑定）', async () => {
  const c = compose();
  const svc = new CallReplyLinkService({
    db: c.db, sirenCall: fakeSiren(turn({ basis: 'unknown' })), media: c.media, voiceObservations: c.voiceObs,
    attachmentsClient: null, streamId: 'estomago-primary-live',
  });
  svc.start();
  const assistantId = c.admitCompletedTurn('call-2', 't1');
  await svc.wake();
  const link = c.db.prepare("SELECT link_state FROM voice_reply_links WHERE call_id='call-2'").get() as { link_state: string };
  assert.equal(link.link_state, 'linked');
  const att = c.db.prepare("SELECT COUNT(*) n FROM message_attachments WHERE message_id=? AND presentation='voice'").get(assistantId) as { n: number };
  assert.equal(att.n, 1, '附件照常绑定');
  const ev = c.db.prepare("SELECT COUNT(*) n FROM runtime_stream_events WHERE kind='message.media.updated'").get() as { n: number };
  assert.equal(ev.n, 0, '未接入事件服务=零事件（旧行为）');
});
