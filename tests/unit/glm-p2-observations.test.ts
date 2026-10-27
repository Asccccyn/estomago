// GLM_VOICE_UNIFICATION P2 验证：声音观察 sidecar——
// - P06：用户语音消息正式接纳即登记 pending（不依赖打开气泡），提交后后台一跳走
//   真实 analyzeVoice（fake oído 是外部 HTTP 边界替代）→ ready + 精简观察；
// - 深听话轮（voice-stream）快观察就绪=ready+投递事实；窗口未赶=pending；普通电话=零 oído 调用、零 sidecar；
// - GET /api/v1/voice-observations 只读返回（UI 气泡数据源）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { fixtureScenario } from '../../packages/test-fixtures/src/sdk-stream.ts';
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import type { ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { SirenAdapter } from '../../apps/host/src/integrations/siren/adapter.ts';
import { VoiceObservationService } from '../../apps/host/src/modules/oido/observations.ts';
import { OidoHearingService } from '../../apps/host/src/modules/oido/service.ts';
import { OidoSourceRepository } from '../../apps/host/src/modules/oido/source-repository.ts';
import { handleRequest } from '../../apps/host/src/server/http.ts';
import { assembleTestTools, writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';
import { bindMessageLifecycle } from '../../apps/host/src/application/message-lifecycle.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));

class FakeRes extends Writable {
  status = 0; lines: string[] = []; buffer = '';
  _write(chunk: Buffer, _e: string, cb: (e?: Error | null) => void): void {
    this.buffer += chunk.toString('utf8');
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) { const l = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1); if (l) this.lines.push(l); }
    cb();
  }
  writeHead(code: number): void { this.status = code; }
  flushTail(): void { const t = this.buffer.trim(); this.buffer = ''; if (t) this.lines.push(t); }
}

/** Siren 边界：原声取回返回真实 WAV 字节（media.saveBuffer 存真资产）。 */
function startSirenStub(): { url: string; stop(): void; audioCalls: number } {
  let audioCalls = 0;
  let postCalls = 0;
  const pcm = Buffer.alloc(3200);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /^\/v1\/voice-assets\/[^/]+\/audio$/.exec(req.url ?? '')) {
      audioCalls++;
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length) });
      res.end(wav);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/calls') {
      const id = `sc_${++postCalls}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ call_id: id, ws_url: `ws://127.0.0.1:9/ws/call/${id}`, token: `tk_${id}`, expires_at: new Date(Date.now() + 60000).toISOString(), conversation_id: 'primary' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(0, '127.0.0.1');
  return new Promise((resolve) => { server.on('listening', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, stop: () => { server.closeAllConnections?.(); server.close(); }, get audioCalls() { return audioCalls; } })); }) as never;
}

/** fake oído：外部 HTTP 边界替代（ingest/analyze 合同与 OidoAdapter 一致）。 */
function fakeOidoAdapter(counts: { ingest: number; analyze: number; keys?: string[] }) {
  return {
    configured: true,
    async ingestVoice(): Promise<{ audioId: string; deduplicated: boolean }> { counts.ingest++; return { audioId: `aud_${counts.ingest}`, deduplicated: false }; },
    async analyze(args: { idempotencyKey?: string }): Promise<Record<string, unknown>> {
      counts.analyze++;
      counts.keys?.push(args.idempotencyKey ?? '');
      return { analysis_id: `an_${counts.analyze}`, revision: 1, state: 'ready', range_ms: [0, 2000],
        observations: [{ kind: 'pause', range_ms: [400, 1600], value: 1.2, unit: 'ms', quality: 'measured' }],
        limits: ['capture_processing_unknown'] };
    },
  } as never;
}

function compose(root: string, transport: OrTransport, sirenUrl: string, opts: { oido?: unknown; sdkQuery?: ConstructorParameters<typeof ClaudeSdkRunner>[0] } = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: opts.sdkQuery ? 'claude-agent-sdk' : 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const media = new MediaService(db, paths.mediaDir, config);
  const hearing = opts.oido ? new OidoHearingService({ db, oido: opts.oido as never, sources: new OidoSourceRepository(db), audio: media, artifacts: media }) : null;
  const voiceObs = new VoiceObservationService(db, { hearing, archiveClient: null, streamId: 'estomago-primary-live' });
  voiceObs.start();
  const messages = new MessageService(db, bindMessageLifecycle({
    surfacing: null, activity: null,
    voiceObservations: {
      ensureForMessage: (messageId: string, revision: number, conversationId: string): void => { voiceObs.ensureForMessage(messageId, revision, conversationId, voiceObs.configured); },
      wake: () => voiceObs.wake(),
    },
  }), null);
  messages.ensureConversation('primary');
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const sirenCall = new SirenAdapter(sirenUrl, 'stub-token');
  const { tools } = assembleTestTools({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages, media, sirenCall: null });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: opts.sdkQuery ? new ClaudeSdkRunner(opts.sdkQuery) : new DeepSeekRunner({ retryMax: 0 }, transport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory: new WindowTrajectoryService(db), voiceObservations: voiceObs, media });
  const deps = { config, db, events, messages, supervisor, paths, logger: new Logger(path.join(root, 'logs')), media, sirenCall, voiceObservations: voiceObs, auth: { isAuthorized: () => true, verifyToken: () => true, originAllowed: () => true }, ...(opts.oido ? { oido: opts.oido } : {}) } as never;
  const call = async (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = new FakeRes();
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as Readable & { headers?: Record<string, string>; method?: string; url?: string };
    req.headers = headers; req.method = method; req.url = route;
    await handleRequest(req as never, res as never, deps);
    await new Promise((r) => setTimeout(r, 30));
    res.flushTail();
    // NDJSON 流=多行 delta/done；JSON 端点=单行。取最后一行非空行解析（对两者均正确）
    const lastLine = [...res.lines].reverse().find((l) => l.trim().length > 0) ?? '';
    return { status: res.status, body: lastLine ? JSON.parse(lastLine) as Record<string, unknown> : {} };
  };
  return { db, messages, media, supervisor, voiceObs, hearing, call, deps, async close() { await voiceObs.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const ctx = (over: Partial<ToolExecContext> = {}): ToolExecContext => ({ roomId: 'primary', windowId: 'w', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'glm-p2', ...over });
const quietTransport: OrTransport = async () => ({ status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) });

test('P06 语音消息默认分析：接纳即 pending；后台一跳走真实 analyzeVoice→ready', async () => {
  const counts = { ingest: 0, analyze: 0 };
  const oido = fakeOidoAdapter(counts);
  const c = compose(tempRoot('glm-obs-'), quietTransport, 'http://127.0.0.1:1', { oido });
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    // 真实语音消息：真资产（media.saveBuffer）+ 转写就绪（voice_transcripts）+ 发布
    const pcm1 = Buffer.alloc(3200);
    const wav1 = Buffer.alloc(44 + pcm1.length);
    wav1.write('RIFF', 0); wav1.writeUInt32LE(36 + pcm1.length, 4); wav1.write('WAVE', 8);
    wav1.write('fmt ', 12); wav1.writeUInt32LE(16, 16); wav1.writeUInt16LE(1, 20); wav1.writeUInt16LE(1, 22);
    wav1.writeUInt32LE(16000, 24); wav1.writeUInt32LE(32000, 28); wav1.writeUInt16LE(2, 32); wav1.writeUInt16LE(16, 34);
    wav1.write('data', 36); wav1.writeUInt32LE(pcm1.length, 40); pcm1.copy(wav1, 44);
    const saved = await c.media.saveBuffer({ bytes: wav1, purpose: 'chat_voice', operationId: 'obs-1', createdBy: 'test', origin: 'upload' });
    c.db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,derived_source,duration_ms,created_at,updated_at) VALUES (?,?,?,?,'ready','这段是她的语音。','siren:transcribe',NULL,?,?)")
      .run(saved.id, 'primary', `t:${saved.id}`, saved.content_sha256, new Date().toISOString(), new Date().toISOString());
    const sub = c.messages.submitUserMessageWithTurn({
      conversationId: 'primary', content: '', clientMessageId: 'voice-1',
      attachments: [{ asset_id: saved.id, presentation: 'voice' } as never],
    });
    c.supervisor.enqueue(sub.turnId);
    await c.supervisor.waitIdle();
    await new Promise((r) => setTimeout(r, 250)); // afterCommit 后台一跳
    const rows = c.voiceObs.listForMessages([sub.message.id]);
    assert.equal(rows.length, 1, 'sidecar 恰一行');
    assert.equal(rows[0]!.status, 'ready', JSON.stringify(rows[0]));
    assert.ok(rows[0]!.display_text!.includes('pause'), rows[0]!.display_text ?? '');
    assert.ok((rows[0]!.display_text ?? '').includes('供参考，非诊断'), 'limits 语义保留');
    assert.equal(rows[0]!.analysis_id, 'an_1');
    assert.equal(counts.ingest, 1);
    // GET 路由只读返回
    const out = await c.call(`/api/v1/voice-observations?message_ids=${encodeURIComponent(sub.message.id)}`);
    assert.equal(out.status, 200);
    assert.equal((out.body['observations'] as Array<Record<string, unknown>>).length, 1);
    console.log(JSON.stringify({ case: 'p06_default_analysis', status: rows[0]!.status, text: rows[0]!.display_text }));
  } finally { await c.supervisor.stopAll(); await c.close(); }
});

test('P04/P2 深听话轮：快观察 ready 带投递事实；普通电话零 oído 零 sidecar', async () => {
  const stub = await startSirenStub();
  const counts = { ingest: 0, analyze: 0, keys: [] as string[] };
  const payloads: string[] = [];
  const capture: OrTransport = async (request, signal) => { payloads.push(JSON.stringify(request)); return quietTransport(request, signal); };
  const oido = fakeOidoAdapter(counts);
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'tok';
  const c = compose(tempRoot('glm-call-'), capture, stub.url, { oido });
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    const req = (callId: string, turn: string): unknown => ({ conversation_id: 'primary', call_id: callId, turn_id: turn, modality: 'voice_call', text: '电话里的话。', audio_ref: 'siren:va-1' });
    // 普通电话：建呼 ordinary → 话轮零 oído、零 sidecar
    const ord = await c.call('/api/v1/calls', 'POST', { conversation_id: 'primary' });
    assert.equal(ord.status, 200, JSON.stringify(ord.body).slice(0, 300));

    const res1 = await c.call('/v1/chat/stream', 'POST', req(ord.body['call_id'] as string, 't-1'), { authorization: 'Bearer tok', 'content-type': 'application/x-ndjson' });
    assert.ok(res1.status === 200, `${res1.status}: ${JSON.stringify(res1.body).slice(0, 200)}`);
    await c.supervisor.waitIdle();
    assert.equal(counts.ingest, 0, '普通电话 0 ingest');
    assert.equal(counts.analyze, 0, '普通电话 0 analyze');
    // 深听电话：显式 deep_listen → 快观察走 sidecar（ready+dispatched_turn_id）
    const dl = await c.call('/api/v1/calls', 'POST', { conversation_id: 'primary', analysis_mode: 'deep_listen' });
    await c.call('/v1/chat/stream', 'POST', req(dl.body['call_id'] as string, 't-2'), { authorization: 'Bearer tok', 'content-type': 'application/x-ndjson' });
    await c.supervisor.waitIdle();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(counts.ingest, 1, '深听电话 1 ingest');
    const msgs = c.db.prepare("SELECT id FROM messages WHERE conversation_id='primary' AND speaker='owner' AND current_revision IS NOT NULL ORDER BY sequence DESC LIMIT 1").all() as Array<{ id: string }>;
    const callMsgId = msgs[0]!.id;
    const rows = c.voiceObs.listForMessages([callMsgId]);
    assert.equal(rows.length, 1, '深听话轮 sidecar 登记一行');
    assert.equal(rows[0]!.status, 'ready', JSON.stringify(rows[0]));
    assert.ok(rows[0]!.dispatched_turn_id);
    assert.ok(rows[0]!.model_projection);
    const actual = JSON.parse(payloads.at(-1)!) as { messages: Array<{ content: string }> };
    assert.ok(actual.messages.some(m => String(m.content).includes(rows[0]!.model_projection!)), '实际模型请求必须包含被冻结的观察');
    const quickKey = counts.keys[0]!;
    const again = await c.hearing!.analyzeVoice({ audio_ref: 'est:' + rows[0]!.asset_id }, ctx());
    assert.equal(again.ok, true);
    assert.equal(counts.keys.at(-1), quickKey, '按需分析复用正式快观察生成的键');
    assert.equal(stub.audioCalls, 2, '两个话轮都取回原声（P03 原声保留不分模式）');
    assert.deepEqual(rows.map((r) => r.status), ['ready'], '深听话轮 sidecar ready');
    // 深听话轮 sidecar 唯一（UNIQUE 幂等），普通话轮无 sidecar（普通轮 owner 消息=最早一条语音）
    const ordMsgId = (c.db.prepare("SELECT t.input_message_id AS id FROM voice_stream_turns vst JOIN turns t ON t.id=vst.est_turn_id WHERE vst.turn_key='t-1'").get() as { id: string }).id;
    assert.equal(c.voiceObs.listForMessages([ordMsgId]).length, 0, '普通话轮零 sidecar');
    console.log(JSON.stringify({ case: 'p04_deep_listen_sidecar', ordinary_zero: true, deep_ready: true, dispatched: true }));
  } finally {
    delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
    await c.supervisor.stopAll(); await c.close(); stub.stop();
  }
});

test('F03 观察补同步：ready 且正文已 ACK→attachmentsSync 幂等出站；未 ACK 跳过', async () => {
  const oido = fakeOidoAdapter({ ingest: 0, analyze: 0 });
  const c = compose(tempRoot('glm-f03-'), quietTransport, 'http://127.0.0.1:1', { oido });
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    const pcm1 = Buffer.alloc(3200);
    const wav1 = Buffer.alloc(44 + pcm1.length);
    wav1.write('RIFF', 0); wav1.writeUInt32LE(36 + pcm1.length, 4); wav1.write('WAVE', 8);
    wav1.write('fmt ', 12); wav1.writeUInt32LE(16, 16); wav1.writeUInt16LE(1, 20); wav1.writeUInt16LE(1, 22);
    wav1.writeUInt32LE(16000, 24); wav1.writeUInt32LE(32000, 28); wav1.writeUInt16LE(2, 32); wav1.writeUInt16LE(16, 34);
    wav1.write('data', 36); wav1.writeUInt32LE(pcm1.length, 40); pcm1.copy(wav1, 44);
    const saved = await c.media.saveBuffer({ bytes: wav1, purpose: 'chat_voice', operationId: 'f03-1', createdBy: 'test', origin: 'upload' });
    c.db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,derived_source,duration_ms,created_at,updated_at) VALUES (?,?,?,?,'ready','她说的话。','siren:transcribe',NULL,?,?)")
      .run(saved.id, 'primary', `t:${saved.id}`, saved.content_sha256, new Date().toISOString(), new Date().toISOString());
    const sub = c.messages.submitUserMessageWithTurn({
      conversationId: 'primary', content: '', clientMessageId: 'voice-f03',
      attachments: [{ asset_id: saved.id, presentation: 'voice' } as never],
    });
    c.supervisor.enqueue(sub.turnId);
    await c.supervisor.waitIdle();
    const sent: Array<{ args: Record<string, unknown> }> = [];
    const fakeClient = { attachmentsSync: async (args: Record<string, unknown>) => { sent.push({ args }); return { ok: true }; } };
    await c.voiceObs.syncPendingAttachments(fakeClient as never, 'estomago-primary-live');
    assert.equal(sent.length, 0, '正文未 ACK 时不发附属结果');
    // 正文 ACK（source_sync_receipts 真实行）
    c.db.prepare("INSERT INTO source_sync_receipts(id,operation_id,origin_message_id,revision,source_conversation_id,source_message_id,content_hash,committed_at,created_at) VALUES ('r1','op-1',?,1,'sc','sm_1','h',?,?)")
      .run(sub.message.id, new Date().toISOString(), new Date().toISOString());
    await c.voiceObs.syncPendingAttachments(fakeClient as never, 'estomago-primary-live');
    await c.voiceObs.syncPendingAttachments(fakeClient as never, 'estomago-primary-live'); // 第二跳：已标记不再发
    assert.equal(sent.length, 1, '幂等：只补同步一次');
    assert.equal(sent[0]!.args['origin_message_id'], sub.message.id);
    assert.equal(sent[0]!.args['kind'], 'observation');
    assert.equal(sent[0]!.args['operation_id'], `att-sync:${(c.voiceObs.listForMessages([sub.message.id])[0] as unknown as { id: string }).id}`);
    assert.ok((sent[0]!.args['payload'] as Record<string, unknown>)['observation']);
    // 行标记
    assert.ok((c.db.prepare('SELECT attachment_synced_at FROM voice_observations WHERE message_id=?').get(sub.message.id) as { attachment_synced_at: string | null }).attachment_synced_at);
    // 未 ACK 的消息：跳过
    const rows2 = await c.voiceObs.syncPendingAttachments(fakeClient as never, 'estomago-primary-live');
    void rows2;
    console.log(JSON.stringify({ case: 'f03_attachment_sync', once: true, kind: 'observation' }));
  } finally { await c.supervisor.stopAll(); await c.close(); }
});

test('SDK 正式驱动入口同样收到转写与观察，派发记录对应真实 query', async () => {
  const stub = await startSirenStub();
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'tok';
  const prompts: string[] = [];
  const c = compose(tempRoot('sdk-obs-'), quietTransport, stub.url, {
    oido: fakeOidoAdapter({ ingest: 0, analyze: 0 }),
    sdkQuery: async function* (req) {
      prompts.push(req.prompt);
      for (const raw of fixtureScenario('consistent', req.prompt)) yield raw;
    },
  });
  try {
    const call = await c.call('/api/v1/calls', 'POST', { conversation_id: 'primary', analysis_mode: 'deep_listen' });
    assert.equal(call.status, 200);
    const response = await c.call('/v1/chat/stream', 'POST',
      { conversation_id: 'primary', call_id: call.body.call_id, turn_id: 'sdk-observation-turn', modality: 'voice_call', text: 'SDK 的原声转写。', audio_ref: 'siren:sdk-audio' },
      { authorization: 'Bearer tok', 'content-type': 'application/x-ndjson' });
    assert.equal(response.status, 200);
    await c.supervisor.waitIdle();
    const row = c.db.prepare("SELECT model_projection,dispatched_turn_id,projection_request_id FROM voice_observations").get() as { model_projection: string; dispatched_turn_id: string; projection_request_id: string };
    assert.ok(row.model_projection);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]!.includes('SDK 的原声转写。'));
    assert.ok(prompts[0]!.includes(row.model_projection));
    assert.ok(row.dispatched_turn_id);
    assert.ok(row.projection_request_id.startsWith('sdk:'));
  } finally { await c.supervisor.stopAll(); await c.close(); stub.stop(); delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN; }
});
