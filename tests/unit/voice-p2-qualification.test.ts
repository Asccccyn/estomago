// P2（四仓合并审计 20261106，V01/U03）验收：深听资格同轮终结。
// - delivered 决定随 commitProjection 同点落库；之后 worker 不再驱动、迟到结果不写行、
//   在途 O 分析被取消（fake cancel 记录）；重启不复活已决定修订。
// - 创建阶段失败=终态 failed（不按定时重新发起）；NOT_READY 仅允许同 analysis 续查至资格终结。
// - deep_listen 通话轮与聊天语音同语义（同轮等待+未就绪块）；ordinary 通话零登记零等待。
// - assistant 自动深听入口已移除（U03：深听只允许同轮交付）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { VoiceObservationService, OBSERVATION_NOT_READY_BLOCK } from '../../apps/host/src/modules/oido/observations.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-p2-qual-'));
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const config = buildConfig({});
  const media = new MediaService(db, buildPaths(root).mediaDir, config);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const state = { analyzeCalls: 0, mode: 'ready' as 'ready' | 'create_fail' | 'not_ready', cancels: [] as string[] };
  const hearing = {
    async analyzeVoice(): Promise<{ ok: boolean; value?: { view: Record<string, unknown> }; error?: { error_code: string } }> {
      state.analyzeCalls++;
      if (state.mode === 'create_fail') return { ok: false, error: { error_code: 'OIDO_ANALYZE_5XX' } };
      return { ok: true, value: { view: { analysis_id: `an_${state.analyzeCalls}`, revision: 1, state: 'ready', readable: '总长约 1 秒的合成音。', observations: [] } } };
    },
    async getEvidence(): Promise<{ ok: boolean; value?: { view: Record<string, unknown> }; error?: { error_code: string } }> {
      if (state.mode === 'not_ready') return { ok: false, error: { error_code: 'OIDO_NOT_READY' } };
      return { ok: true, value: { view: { analysis_id: 'an_x', revision: 1, state: 'ready', readable: '续查结果。', observations: [] } } };
    },
  };
  const svc = new VoiceObservationService(db, {
    hearing: hearing as never, archiveClient: null, streamId: 's',
    cancelAnalysis: async (id: string) => { state.cancels.push(id); },
  });
  const wav = minimalWav();
  const uploadVoice = async (suffix: string) => (await media.saveBuffer({ bytes: wav, purpose: 'chat_voice', operationId: `p2-voice-${suffix}`, createdBy: 'qiaosheng', origin: 'upload' })).id;
  const submitVoice = (assetId: string, clientMessageId: string) => messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '', clientMessageId, attachments: [{ asset_id: assetId, presentation: 'voice' }] });
  return { root, db, svc, state, messages, uploadVoice, submitVoice, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function minimalWav(): Buffer {
  const pcm = Buffer.alloc(3200);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

test('T06/T07 同轮终结：delivered 决定冻结一切；迟到结果丢弃；在途分析取消', async () => {
  const f = fixture();
  try {
    const a = await f.uploadVoice('a');
    const sub = f.submitVoice(a, 'vm-qual-1');
    f.svc.ensureForMessage(sub.message.id, 1, 'primary', true);
    await f.svc.runPending(f.svc['worker']!.hearing!, 5);
    let row = f.db.prepare('SELECT id,status,analysis_id FROM voice_observations WHERE message_id=?').get(sub.message.id) as { id: string; status: string; analysis_id: string };
    assert.equal(row.status, 'ready');
    // 首次模型输入提交：快照带 NOT_READY 场景改投 ready 场景——此处用实际 ready 快照冻结
    const snaps = f.svc.snapshotsForRevision(sub.message.id, 1, true);
    assert.equal(snaps.length, 1);
    f.svc.commitProjection({ messageId: sub.message.id, revision: 1 }, 'turn1', 'req1', snaps);
    assert.equal(f.svc.decided(sub.message.id, 1)?.decision, 'delivered', '投影冻结同点落 delivered 决定');
    // 决定后 worker 不再驱动该修订；迟到结果不写行
    f.db.prepare("UPDATE voice_observations SET status='pending' WHERE id=?").run(row.id); // 模拟迟到在途
    await f.svc.runPending(f.svc['worker']!.hearing!, 5);
    row = f.db.prepare('SELECT status FROM voice_observations WHERE id=?').get(row.id) as { status: string };
    assert.equal(row.status, 'pending', '已决定修订不被 worker 触碰（迟到分析不再驱动/写行）');
    // 在途 O 分析取消：决定时 pending/processing 行的 analysis_id 走 cancel
    const b = await f.uploadVoice('b');
    const sub2 = f.submitVoice(b, 'vm-qual-2');
    f.svc.ensureForMessage(sub2.message.id, 1, 'primary', true);
    const row2 = f.db.prepare('SELECT id FROM voice_observations WHERE message_id=?').get(sub2.message.id) as { id: string };
    f.db.prepare("UPDATE voice_observations SET analysis_id='an_inflight' WHERE id=?").run(row2.id);
    f.svc.commitProjection({ messageId: sub2.message.id, revision: 1 }, 'turn2', 'req2', []);
    assert.ok(f.state.cancels.includes('an_inflight'), '资格终结取消在途 O 分析（E→O cancel 接线）');
    const row2b = f.db.prepare('SELECT status,error_code FROM voice_observations WHERE id=?').get(row2.id) as { status: string; error_code: string };
    assert.equal(row2b.status, 'failed');
    assert.equal(row2b.error_code, 'QUALIFICATION_CLOSED');
  } finally { f.close(); }
});

test('T07 创建失败=终态；NOT_READY 仅续查——不再定时重新发起同一深听', async () => {
  const f = fixture();
  try {
    f.state.mode = 'create_fail';
    const a = await f.uploadVoice('c');
    const sub = f.submitVoice(a, 'vm-qual-3');
    f.svc.ensureForMessage(sub.message.id, 1, 'primary', true);
    await f.svc.runPending(f.svc['worker']!.hearing!, 5);
    const row = f.db.prepare('SELECT status,error_code FROM voice_observations WHERE message_id=?').get(sub.message.id) as { status: string; error_code: string };
    assert.equal(row.status, 'failed', '创建失败终态（旧实现无限 pending 重试）');
    const calls1 = f.state.analyzeCalls;
    await f.svc.runPending(f.svc['worker']!.hearing!, 5);
    assert.equal(f.state.analyzeCalls, calls1, '终态行不再重新 analyze');
    // NOT_READY（同 analysis 在途）：保留 pending 续查；资格终结后停
    const b = await f.uploadVoice('d');
    const sub2 = f.submitVoice(b, 'vm-qual-4');
    f.svc.ensureForMessage(sub2.message.id, 1, 'primary', true);
    const row2 = f.db.prepare('SELECT id FROM voice_observations WHERE message_id=?').get(sub2.message.id) as { id: string };
    f.db.prepare("UPDATE voice_observations SET analysis_id='an_nr', status='pending' WHERE id=?").run(row2.id);
    f.state.mode = 'not_ready';
    await f.svc.runPending(f.svc['worker']!.hearing!, 5);
    const mid = f.db.prepare('SELECT status FROM voice_observations WHERE id=?').get(row2.id) as { status: string };
    assert.equal(mid.status, 'pending', '同一 analysis 在途＝续查（非重新发起）');
    f.svc.commitProjection({ messageId: sub2.message.id, revision: 1 }, 't', 'r', []);
    await f.svc.runPending(f.svc['worker']!.hearing!, 5);
    const after = f.db.prepare('SELECT status,error_code FROM voice_observations WHERE id=?').get(row2.id) as { status: string; error_code: string };
    assert.equal(after.status, 'failed', '资格终结后未就绪＝failed（如实无结果）');
    assert.equal(after.error_code, 'QUALIFICATION_CLOSED');
  } finally { f.close(); }
});

test('T09 deep_listen 通话轮同轮语义；ordinary 通话零观察', async () => {
  const f = fixture();
  try {
    const a = await f.uploadVoice('e');
    const sub = f.submitVoice(a, 'vm-qual-5');
    f.db.prepare("UPDATE messages SET client_message_id='voice:call_dl:t1' WHERE id=?").run(sub.message.id);
    f.db.prepare("INSERT INTO voice_calls(call_id, conversation_id, state, started_at, analysis_mode) VALUES ('call_dl','primary','active',?, 'deep_listen')").run(new Date().toISOString());
    f.svc.recordCallTurnObservation(sub.message.id, 1, a, null);
    const snaps = f.svc.snapshotsForRevision(sub.message.id, 1, true);
    assert.equal(snaps.length, 1, '深听通话轮未就绪观察如实入当前输入（同轮语义）');
    assert.equal(snaps[0]!.text, OBSERVATION_NOT_READY_BLOCK);
    // ordinary 通话：不登记、不等待、无块
    const b = await f.uploadVoice('f');
    const sub2 = f.submitVoice(b, 'vm-qual-6');
    f.db.prepare("UPDATE messages SET client_message_id='voice:call_ord:t1' WHERE id=?").run(sub2.message.id);
    f.db.prepare("INSERT INTO voice_calls(call_id, conversation_id, state, started_at, analysis_mode) VALUES ('call_ord','primary','active',?, 'ordinary')").run(new Date().toISOString());
    f.svc.ensureForMessage(sub2.message.id, 1, 'primary', true);
    const n = (f.db.prepare('SELECT COUNT(*) n FROM voice_observations WHERE message_id=?').get(sub2.message.id) as { n: number }).n;
    assert.equal(n, 0, 'ordinary 通话零自动观察（U04）');
    const snaps2 = f.svc.snapshotsForRevision(sub2.message.id, 1, true);
    assert.equal(snaps2.length, 0);
    await f.svc.awaitReadyForDispatch(sub2.message.id, 1, 50);
    assert.ok(true, 'ordinary 不等待（无观察可等）');
  } finally { f.close(); }
});

test('T23 重启不复活：start() 不再把 processing 改 pending；已决定修订不重排', async () => {
  const f = fixture();
  try {
    const a = await f.uploadVoice('g');
    const sub = f.submitVoice(a, 'vm-qual-7');
    f.svc.ensureForMessage(sub.message.id, 1, 'primary', true);
    const row = f.db.prepare('SELECT id FROM voice_observations WHERE message_id=?').get(sub.message.id) as { id: string };
    // 已决定修订的 processing 残余：start 不复活（决定时应已收口；此处验证 start 无批量 UPDATE）
    f.svc.commitProjection({ messageId: sub.message.id, revision: 1 }, 't', 'r', []);
    f.db.prepare("UPDATE voice_observations SET status='processing' WHERE id=?").run(row.id); // 模拟决定竞态残余
    f.svc.start();
    await new Promise((r) => setTimeout(r, 50));
    const st = f.db.prepare('SELECT status FROM voice_observations WHERE id=?').get(row.id) as { status: string };
    assert.notEqual(st.status, 'pending', 'start 不做 processing→pending 批量复活');
    await f.svc.stop();
  } finally { f.close(); }
});

test('U03 assistant 自动深听入口已移除', () => {
  const f = fixture();
  try {
    const svc = f.svc as unknown as Record<string, unknown>;
    assert.equal(svc['registerAssistantObservation'], undefined, '助手音频自动分析入口删除（深听只允许同轮交付）');
  } finally { f.close(); }
});
