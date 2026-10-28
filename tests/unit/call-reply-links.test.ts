// 联合审计 A04（B3）单元回归：CallReplyLinkService——Siren turn-audio 拉取→est 助手
// 消息持久绑定（links 行+附件行）→deep_listen assistant 观察→source.attachments.sync
// 补同步（media 一次、call 按播放事实 basis 演进）；幂等重放、晚到播放更新、404 收敛。
// 外部边界替身：SirenAdapter 与 M attachmentsSync；消息/媒体/观察/收据为真实实现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { VoiceObservationService } from '../../apps/host/src/modules/oido/observations.ts';
import { CallReplyLinkService } from '../../apps/host/src/modules/voice/call-links.ts';
import type { SirenAdapter, SirenCallAudioTurn } from '../../apps/host/src/integrations/siren/adapter.ts';
import { tempRoot } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

const mp3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04]), Buffer.alloc(128)]);

/** Siren 替身：turn-audio 表 + 回复字节计数（A04 的外部付费/网络边界） */
function fakeSiren(initial: SirenCallAudioTurn[] | 'not_found' | null) {
  let current: SirenCallAudioTurn[] | 'not_found' | null = initial;
  let fetchCalls = 0;
  let failAudio = false;
  return {
    callTurnAudio: async () => Array.isArray(current) ? { turns: current, audio_finalized: false } : current,
    fetchVoiceAssetAudio: async () => { fetchCalls++; if (failAudio) throw new Error('HTTP_503'); return { bytes: new Uint8Array(mp3), mime: 'audio/mpeg' }; },
    set turns(v: SirenCallAudioTurn[] | 'not_found' | null) { current = v; },
    set failAudio(v: boolean) { failAudio = v; },
    get fetchCalls() { return fetchCalls; },
  } as unknown as SirenAdapter & { turns: SirenCallAudioTurn[] | 'not_found' | null; fetchCalls: number; failAudio: boolean };
}

/** M 附属同步替身：记录 (kind, operation_id, payload)；生产为真实 MariposaClient */
function fakeAttachments() {
  const ops: Array<{ kind: string; operation_id: string; payload: Record<string, unknown> }> = [];
  return {
    attachmentsSync: async (args: { stream_id: string; origin_message_id: string; revision: number; kind: 'media' | 'call' | 'observation'; payload: Record<string, unknown>; operation_id: string }) => { ops.push({ kind: args.kind, operation_id: args.operation_id, payload: args.payload }); return { ok: true }; },
    ops,
  };
}

/** 听觉替身：只用于让观察服务 configured（注册路径被测）；分析本身不可用=诚实 pending */
const hearingStub = {
  analyzeVoice: async () => ({ ok: false as const, error: { error_code: 'OIDO_UNAVAILABLE' } }),
  getEvidence: async () => ({ ok: false as const, error: { error_code: 'OIDO_UNAVAILABLE' } }),
};

function compose(mode: 'deep_listen' | 'ordinary') {
  const root = tempRoot('glm-a04-');
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
      db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,analysis_mode) VALUES (?,'primary','active',?,?)").run(callId, new Date().toISOString(), mode);
      const sub = messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在吗？', clientMessageId: `voice:${callId}:${turnKey}` });
      // voice_stream_turns 行由 voice-stream 路由写入；此处直造已完成接纳事实（同 schema）
      const now = new Date().toISOString();
      db.prepare("INSERT INTO voice_stream_turns(call_id,turn_key,conversation_id,text_sha256,est_turn_id,state,created_at,updated_at) VALUES (?,?,?,?,?,'completed',?,?)")
        .run(callId, turnKey, 'primary', sha256Hex('在吗？'), sub.turnId, now, now);
      const assistant = messages.publishAssistantMessage({ conversationId: 'primary', turnId: sub.turnId, content: '好呀，我在。', kind: 'text', clientMessageId: `assistant:${callId}:${turnKey}` });
      return assistant.id;
    },
    markArchived(messageId: string): void {
      // 模拟正文先 ACK（真实链路由 ArchiveSyncService 写入；此处只造读取侧前置事实）
      db.prepare(`INSERT INTO source_sync_receipts(id,operation_id,origin_message_id,revision,source_conversation_id,source_message_id,content_hash,committed_at,created_at)
        VALUES ('ssr-'||?,'op-x',?,1,'conv-primary','sm-x','hash-x',?,?)`).run(messageId, messageId, new Date().toISOString(), new Date().toISOString());
    },
    close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const turn = (callId: string, turnKey: string, playback: SirenCallAudioTurn['playback'], reply: SirenCallAudioTurn['reply_audio'] = { asset_id: 'sir-rep-1', duration_ms: 1500, completeness: 'complete' }): SirenCallAudioTurn[] => [{
  turn_id: turnKey, turn_index: 1, outcome: 'completed', user_audio: null, reply_audio: reply,
  sent_audio_ms: 1500, filler_audio_ms: 0, playback,
}];

test('A04/C01：回复音频→确切助手消息持久绑定+deep_listen assistant 观察+Source 补同步', async () => {
  const c = compose('deep_listen');
  const siren = fakeSiren(turn('call-1', 't1', { basis: 'unknown' }));
  const att = fakeAttachments();
  const svc = new CallReplyLinkService({ db: c.db, sirenCall: siren, media: c.media, voiceObservations: c.voiceObs, attachmentsClient: att as never, streamId: 'estomago-primary-live' });
  try {
    const assistantId = c.admitCompletedTurn('call-1', 't1');
    c.markArchived(assistantId);
    svc.start();
    await svc.wake();
    // links 行：唯一、精确绑定助手消息、Siren 资产与 est 导入资产分列
    const link = c.db.prepare("SELECT * FROM voice_reply_links WHERE call_id='call-1' AND turn_key='t1'").get() as Record<string, unknown>;
    assert.equal(link['link_state'], 'linked');
    assert.equal(link['message_id'], assistantId);
    assert.equal(link['siren_asset_id'], 'sir-rep-1');
    assert.ok(link['est_asset_id'], '回复字节已导入 est 媒体');
    assert.equal(link['completeness'], 'complete');
    // 附件行：正式助手消息挂 est 资产（records/归档/oído 源授权的既有消费者直接可见）
    const att_row = c.db.prepare("SELECT asset_id FROM message_attachments WHERE message_id=? AND presentation='voice'").get(assistantId) as { asset_id: string };
    assert.equal(att_row.asset_id, link['est_asset_id']);
    // deep_listen：assistant 方向观察已登记（普通电话场景见下一用例）
    const obs = c.db.prepare("SELECT direction,status FROM voice_observations WHERE message_id=?").get(assistantId) as { direction: string; status: string };
    assert.equal(obs.direction, 'assistant');
    assert.equal(obs.status, 'pending');
    // Source 补同步：media 一次 + call 一次（basis=unknown），操作键稳定
    assert.deepEqual(att.ops.map((o) => o.kind).sort(), ['call', 'media']);
    const mediaOp = att.ops.find((o) => o.kind === 'media')!;
    assert.equal(mediaOp.operation_id, 'att-sync:media:call-1:t1');
    assert.equal(mediaOp.payload['asset_ref'], `est:${link['est_asset_id']}`);
    const callOp = att.ops.find((o) => o.kind === 'call')!;
    assert.equal(callOp.payload['direction'], 'assistant');
    assert.equal((c.db.prepare("SELECT source_media_synced_at, source_call_synced_basis FROM voice_reply_links WHERE call_id='call-1'").get() as Record<string, unknown>)['source_call_synced_basis'], 'unknown');
    assert.ok(siren.fetchCalls === 1, '只取回一次字节');
    // 幂等重放：同状态再拉不新增事实/不重复同步/不重复取字节
    await svc.wake();
    assert.equal(att.ops.length, 2);
    assert.equal(siren.fetchCalls, 1);
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM message_attachments WHERE message_id=?").get(assistantId) as { n: number }).n, 1);

    // C02：播放事实晚到演进 unknown→client_drained——links 更新，call 附属以新 basis 补一条
    siren.turns = turn('call-1', 't1', { basis: 'client_drained' });
    await svc.wake();
    const link2 = c.db.prepare("SELECT playback_json FROM voice_reply_links WHERE call_id='call-1' AND turn_key='t1'").get() as { playback_json: string };
    assert.equal((JSON.parse(link2.playback_json) as { basis: string }).basis, 'client_drained');
    const callOps = att.ops.filter((o) => o.kind === 'call');
    assert.deepEqual(callOps.map((o) => o.operation_id), ['att-sync:call:call-1:t1:unknown', 'att-sync:call:call-1:t1:client_drained']);
    assert.equal((c.db.prepare("SELECT source_call_synced_basis FROM voice_reply_links WHERE call_id='call-1'").get() as Record<string, unknown>)['source_call_synced_basis'], 'client_drained');
    assert.equal(siren.fetchCalls, 1, '播放更新不重取音频字节');
  } finally { await svc.stop(); c.close(); }
});

test('A04/C05：ordinary 电话不建 assistant 自动分析', async () => {
  const c = compose('ordinary');
  const siren = fakeSiren(turn('call-2', 't1', { basis: 'client_drained' }));
  const svc = new CallReplyLinkService({ db: c.db, sirenCall: siren, media: c.media, voiceObservations: c.voiceObs, attachmentsClient: null, streamId: 'estomago-primary-live' });
  try {
    const assistantId = c.admitCompletedTurn('call-2', 't1');
    svc.start();
    await svc.wake();
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM voice_observations WHERE message_id=?").get(assistantId) as { n: number }).n, 0);
    const link = c.db.prepare("SELECT link_state FROM voice_reply_links WHERE call_id='call-2'").get() as { link_state: string };
    assert.equal(link.link_state, 'linked'); // 关联照常建立；只是不自动分析
  } finally { await svc.stop(); c.close(); }
});

test('A04/C04：通话结束后 Siren 404——如实 unavailable，不猜音频', async () => {
  const c = compose('ordinary');
  const siren = fakeSiren('not_found');
  const svc = new CallReplyLinkService({ db: c.db, sirenCall: siren, media: c.media, voiceObservations: c.voiceObs, attachmentsClient: null, streamId: 'estomago-primary-live' });
  try {
    c.admitCompletedTurn('call-3', 't1');
    c.db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id='call-3'").run(new Date().toISOString());
    svc.start();
    await svc.wake();
    const link = c.db.prepare("SELECT link_state, siren_asset_id FROM voice_reply_links WHERE call_id='call-3'").get() as { link_state: string; siren_asset_id: string | null };
    assert.equal(link.link_state, 'unavailable');
    assert.equal(link.siren_asset_id, null);
    assert.equal(siren.fetchCalls, 0);
  } finally { await svc.stop(); c.close(); }
});

for (const failure of ['audio', 'call-sync'] as const) test(`回复关联恢复：${failure} 失败不记完成，恢复后只补缺失阶段`, async () => {
  const c = compose('deep_listen');
  const siren = fakeSiren(turn('call-recover', 't1', { basis: 'client_drained' }));
  siren.failAudio = failure === 'audio';
  let failCall = failure === 'call-sync';
  const accepted: Array<{ kind: string; operation_id: string }> = [];
  const callKeys: string[] = [];
  const client = {
    async attachmentsSync(args: { kind: string; operation_id: string }) {
      if (args.kind === 'call') {
        callKeys.push(args.operation_id);
        if (failCall) return { ok: false };
      }
      accepted.push(args);
      return { ok: true };
    },
  };
  const svc = new CallReplyLinkService({ db: c.db, sirenCall: siren, media: c.media, voiceObservations: c.voiceObs, attachmentsClient: client, streamId: 'estomago-primary-live' });
  try {
    const messageId = c.admitCompletedTurn('call-recover', 't1');
    c.markArchived(messageId);
    svc.start();
    await svc.wake();
    const before = c.db.prepare("SELECT * FROM voice_reply_links WHERE call_id='call-recover'").get() as Record<string, unknown>;
    assert.equal(before.source_call_synced_basis, null, '没有成功 ACK，不推进同步标记');
    if (failure === 'audio') {
      assert.equal(before.link_state, 'pending');
      assert.equal(before.est_asset_id, null);
      assert.equal(accepted.length, 0, '音频尚未绑定，不提交完成的媒体事实');
      assert.equal(c.db.prepare('SELECT 1 FROM voice_observations WHERE message_id=?').get(messageId), undefined);
    } else {
      assert.equal(before.link_state, 'linked');
      assert.deepEqual(accepted.map(a => a.kind), ['media']);
    }
    const fetchedBefore = siren.fetchCalls;
    siren.failAudio = false;
    failCall = false;
    await svc.wake();
    const after = c.db.prepare("SELECT * FROM voice_reply_links WHERE call_id='call-recover'").get() as Record<string, unknown>;
    assert.equal(after.link_state, 'linked');
    assert.ok(after.est_asset_id);
    assert.equal(after.source_call_synced_basis, 'client_drained');
    assert.equal(siren.fetchCalls, fetchedBefore + (failure === 'audio' ? 1 : 0));
    assert.deepEqual(accepted.map(a => a.kind), ['media', 'call']);
    assert.equal(new Set(callKeys).size, 1, '同步恢复沿用原操作身份');
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM message_attachments WHERE message_id=? AND presentation='voice'").get(messageId) as { n: number }).n, 1);
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM voice_observations WHERE message_id=? AND direction='assistant'").get(messageId) as { n: number }).n, 1);
    await svc.wake();
    assert.equal(accepted.length, 2);
    assert.equal(siren.fetchCalls, fetchedBefore + (failure === 'audio' ? 1 : 0));
  } finally { await svc.stop(); c.close(); }
});
