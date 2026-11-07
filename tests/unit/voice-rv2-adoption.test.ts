// RV2（复审 20261106 第二轮）：深听资格三事实分离——消息已发 ≠ 分析被采纳 ≠ O 执行终态。
// - RV2-01：真实 4000ms 准备预算耗尽、消息已发（NOT_READY 占位）＝ delivered 未采纳：
//   迟到 analysis_id 归属原操作并补发 cancel（复审计数 1），且 late getEvidence 不可消费；
//   对照：真实采纳轮（ready 证据随输入发出）的后续查询保持合法。
// - RV2-02：O 取消响应 200 {status:'succeeded',cancelled:false} 不得被投成已取消。
// 全程真实 MessageService/MediaService/OidoAdapter/HearingService/Observation；外部 HTTP
// 边界延迟/合成；不手写业务 SQL。
import { test } from 'node:test';
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
import { OidoAdapter } from '../../apps/host/src/integrations/oido/adapter.ts';
import { OidoHearingService } from '../../apps/host/src/modules/oido/service.ts';
import { OidoSourceRepository } from '../../apps/host/src/modules/oido/source-repository.ts';
import { VoiceObservationService, OBSERVATION_NOT_READY_BLOCK as OBS_TEXT } from '../../apps/host/src/modules/oido/observations.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const savedFetch = globalThis.fetch;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rv2-adopt-'));
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  process.env.ESTOMAGO_TEST_OIDO_CREDENTIAL = 'synthetic';
  const config = buildConfig({ integrations: { oido: { base_url: 'http://127.0.0.1:1', credential_ref: 'ESTOMAGO_TEST_OIDO_CREDENTIAL' } } });
  const media = new MediaService(db, path.join(root, 'media'), config);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const hearing = new OidoHearingService({ db, oido: new OidoAdapter(config.integrations.oido), sources: new OidoSourceRepository(db), audio: media, artifacts: media });
  const requests: Array<{ path: string }> = [];
  let releaseAnalysis!: () => void;
  let notifyEntered!: () => void;
  const entered = new Promise<void>(r => { notifyEntered = r; });
  const pendingAnalysis = new Promise<void>(r => { releaseAnalysis = r; });
  let analysesCalls = 0; // R3-V01：首次=自动分析 run_synthetic；后续=显式新分析 run_explicit_new
  const adapter = new OidoAdapter(config.integrations.oido);
  const observations = new VoiceObservationService(db, { hearing, archiveClient: null, streamId: 'synthetic', cancelAnalysis: (id) => adapter.cancelAnalysis(id) });
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    requests.push({ path: new URL(u).pathname });
    if (u.endsWith('/v1/audio:ingest')) return Response.json({ audio_id: 'aud_synthetic', deduplicated: false });
    if (u.endsWith('/transcript')) return Response.json({ stored: true });
    if (u.endsWith('/v1/analyses')) {
      notifyEntered();
      await pendingAnalysis;
      analysesCalls++;
      const id = analysesCalls === 1 ? 'run_synthetic' : 'run_explicit_new';
      return Response.json({ analysis_id: id, revision: 1, state: 'ready', range_ms: [0, 100], readable: 'synthetic late result', observations: [] });
    }
    if (u.endsWith('/v1/find')) return Response.json({ audio_ref: 'est:a', analysis_id: analysesCalls >= 2 ? 'run_explicit_new' : 'run_synthetic', mode: 'substring', state: 'no_match', items: [], limits: [] });
    if (u.endsWith('/v1/compare')) return Response.json({ left: { analysis_id: 'run_explicit_new' }, right: { analysis_id: 'run_explicit_new' }, metrics: [] });
    if (u.endsWith('/cancel')) return Response.json({ analysis_id: 'run_synthetic', status: 'succeeded', cancelled: false });
    if (u.endsWith('/v1/analyses/run_synthetic')) return Response.json({ analysis_id: 'run_synthetic', revision: 1, state: 'ready', range_ms: [0, 100], readable: 'synthetic audio result', observations: [] });
    throw new Error('UNEXPECTED_EXTERNAL_TRANSPORT');
  }) as typeof fetch;
  const wav = () => {
    const b = Buffer.alloc(44 + 3200);
    b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
    b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(3200, 40);
    return b;
  };
  const ctx = { roomId: 'primary', windowId: 'synthetic', turnId: null, purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'synthetic-read' };
  return {
    db, hearing, observations, messages, media, requests, wav, ctx, entered, releaseAnalysis: () => releaseAnalysis(),
    close() { globalThis.fetch = savedFetch; db.close(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.ESTOMAGO_TEST_OIDO_CREDENTIAL; },
  };
}

test('RV2-01：超时占位轮＝delivered 未采纳——迟到 ID 补 cancel 且不可消费；采纳轮后续查询保持合法', async () => {
  const f = fixture();
  try {
    const asset = await f.media.saveBuffer({ bytes: f.wav(), purpose: 'chat_voice', operationId: 'rv2-voice-1', createdBy: 'qiaosheng', origin: 'upload' });
    const msg = f.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: 'synthetic observation input', clientMessageId: 'rv2-voice-1', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    f.observations.ensureForMessage(msg.message.id, 1, 'primary', true);
    const running = f.observations.runPending(f.hearing);
    await f.entered; // 真实慢 POST：analysis_id 尚未抵达
    const initial = f.observations.listForMessages([msg.message.id])[0]!;
    assert.equal(initial.status, 'processing');
    assert.equal(initial.analysis_id, null, '分析 ID 只随 HTTP 结果抵达');
    await f.observations.awaitReadyForDispatch(msg.message.id, 1, 4000); // 真实 4000ms 预算耗尽
    const used = f.observations.snapshotsForRevision(msg.message.id, 1, true);
    assert.ok(used[0]!.text.includes('尚未就绪'), '未就绪占位随输入发出');
    assert.equal(used[0]!.adopted, false, '占位快照＝未采纳');
    f.observations.commitProjection({ messageId: msg.message.id, revision: 1 }, msg.turnId, 'synthetic-first-dispatch', used);
    const closed = f.observations.listForMessages([msg.message.id])[0]!;
    assert.equal(closed.status, 'failed');
    assert.equal(closed.error_code, 'QUALIFICATION_CLOSED');
    assert.equal((f.db.prepare('SELECT analysis_adopted FROM voice_observations WHERE message_id=?').get(msg.message.id) as { analysis_adopted: number }).analysis_adopted, 0, 'delivered 未采纳落定');
    f.releaseAnalysis();
    await running;
    const late = f.observations.listForMessages([msg.message.id])[0]!;
    assert.equal(late.status, 'failed', '迟到成功不回写 ready');
    // 迟到 ID 归属原操作并补发 cancel（cancelInFlight 经微任务出队）
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.requests.filter(r => r.path.endsWith('/cancel')).length, 1, '迟到 analysis_id 补发取消');
    // 消费门：被丢弃的分析不再可读（复审反例 lateGetReadable=true）
    const lateGet = await f.hearing.getEvidence({ analysis_id: 'run_synthetic' }, f.ctx);
    assert.equal(lateGet.ok, false, 'RV2-01：超时未采纳的分析不可再消费');
    const lateView = await f.hearing.view({ analysis_id: 'run_synthetic' }, f.ctx);
    assert.equal(lateView.ok, false, 'view 同门');
  } finally { f.close(); }
});

test('RV2-01 对照：真实采纳轮（ready 证据随输入发出）的后续查询保持合法', async () => {
  const f = fixture();
  try {
    const asset = await f.media.saveBuffer({ bytes: f.wav(), purpose: 'chat_voice', operationId: 'rv2-voice-2', createdBy: 'qiaosheng', origin: 'upload' });
    f.releaseAnalysis(); // 对照轮：分析即时返回（不等延迟门）
    const msg = f.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: 'synthetic adopted input', clientMessageId: 'rv2-voice-2', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    f.observations.ensureForMessage(msg.message.id, 1, 'primary', true);
    await f.observations.runPending(f.hearing); // 快路径：分析即时返回（无延迟门）
    const row = f.observations.listForMessages([msg.message.id])[0]!;
    assert.equal(row.status, 'ready', '分析就绪');
    f.observations.commitProjection({ messageId: msg.message.id, revision: 1 }, msg.turnId, 'synthetic-adopted-dispatch',
      f.observations.snapshotsForRevision(msg.message.id, 1, true));
    assert.equal((f.db.prepare('SELECT analysis_adopted FROM voice_observations WHERE message_id=?').get(msg.message.id) as { analysis_adopted: number }).analysis_adopted, 1, 'ready 证据＝已采纳');
    const get = await f.hearing.getEvidence({ analysis_id: 'run_synthetic' }, f.ctx);
    assert.equal(get.ok, true, '已采纳分析的后续查询合法（合法语义保留）');
  } finally { f.close(); }
});

test('RV2-02：取消响应读业务 body——200 {succeeded, cancelled:false} 不再投成已取消', async () => {
  process.env.SYNTHETIC_OIDO_CREDENTIAL = 'synthetic-only';
  try {
    const adapter = new OidoAdapter({ base_url: 'http://127.0.0.1:1', credential_ref: 'SYNTHETIC_OIDO_CREDENTIAL' });
    globalThis.fetch = (async () => Response.json({ analysis_id: 'run_done', status: 'succeeded', cancelled: false })) as typeof fetch;
    const result = await adapter.cancelAnalysis('run_done');
    assert.equal(result.cancelled, false, 'O 实际未取消（分析已终态 succeeded）');
    assert.equal(result.status, 200);
    globalThis.fetch = (async () => Response.json({ analysis_id: 'run_ok', status: 'cancelled', cancelled: true })) as typeof fetch;
    const okResult = await adapter.cancelAnalysis('run_ok');
    assert.equal(okResult.cancelled, true, '真实取消确认');
  } finally { globalThis.fetch = savedFetch; delete process.env.SYNTHETIC_OIDO_CREDENTIAL; }
});

// —— R3-V01（第三轮复审）：显式新分析不再被旧自动历史整资产锁死 ——

test('R3-V01：丢弃后显式新分析成功——find/compare 按实际 analysis 放行', async () => {
  const f = fixture();
  try {
    f.releaseAnalysis(); // 分析即时返回
    const asset = await f.media.saveBuffer({ bytes: f.wav(), purpose: 'chat_voice', operationId: 'rv3-voice-1', createdBy: 'qiaosheng', origin: 'upload' });
    const msg = f.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: 'rv3 input', clientMessageId: 'rv3-voice-1', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    f.observations.ensureForMessage(msg.message.id, 1, 'primary', true);
    await f.observations.runPending(f.hearing); // 自动分析 ready（run_synthetic）
    // 本轮投递"尚未就绪"占位（未采纳）——旧自动分析被丢弃
    f.observations.commitProjection({ messageId: msg.message.id, revision: 1 }, msg.turnId, 'rv3-dispatch',
      [{ id: f.observations.listForMessages([msg.message.id])[0]!.id, assetId: asset.id, text: OBS_TEXT, adopted: false }]);
    const closedOld = await f.hearing.getEvidence({ analysis_id: 'run_synthetic' }, f.ctx);
    assert.equal(closedOld.ok, false, '被丢弃的旧分析仍不可读');
    // 显式新分析（真实 analyzeVoice：快键判丢弃→legacy 新键→O POST #2 → run_explicit_new）
    const explicit = await f.hearing.analyzeVoice({ audio_ref: `est:${asset.id}` }, f.ctx);
    assert.equal(explicit.ok, true, '显式新分析成功');
    assert.equal((explicit.value as { view: { analysis_id?: string } }).view.analysis_id, 'run_explicit_new', '新操作身份（非旧 id）');
    // find：O 返回新 analysis_id → 放行（旧实现整资产锁死）
    const findResult = await f.hearing.find({ audio_ref: `est:${asset.id}`, query: 'x' }, f.ctx);
    assert.equal(findResult.ok, true, 'R3-V01：新分析后 find 放行（旧实现被旧自动历史封锁）');
    const cmp = await f.hearing.compare({ left: { audio_ref: `est:${asset.id}` }, right: { audio_ref: `est:${asset.id}` } }, f.ctx);
    assert.equal(cmp.ok, true, 'compare 同门放行');
  } finally { f.close(); }
});
