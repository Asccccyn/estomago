// GLM_VOICE_UNIFICATION P4（A05）验证：模型主动语音经 est 真实可达——
// chat_send_voice（Siren synthesize stub=外部付费 TTS 边界替代）→ 资产 → 唯一 assistant
// 语音消息（正文=原话）→ 归档投影；幂等（同 tool_call 重试不重复产出）；合成失败如实。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
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
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import type { ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { SirenAdapter } from '../../apps/host/src/integrations/siren/adapter.ts';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

/** Siren stub：/v1/voice/synthesize 返回真实 MP3 头字节；计数与失败开关。
 *  A01 恢复场景：drop-persisted=已生成并登记操作资产但响应丢失（socket 摧毁）；
 *  conflict=同键异参 409。资产按 operation_id 可查/可取回字节。 */
function startSirenStub(): { url: string; stop(): void; synthCalls: number; failSynthesis: boolean; mode: 'normal' | 'hang' | 'drop' | 'drop-persisted' | 'conflict'; clientClosed: Promise<void>; entered: Promise<void> } {
  let synthCalls = 0;
  let failSynthesis = false;
  let mode: 'normal' | 'hang' | 'drop' | 'drop-persisted' | 'conflict' = 'normal';
  let markClosed!: () => void;
  const clientClosed = new Promise<void>((resolve) => { markClosed = resolve; });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const mp3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04]), Buffer.alloc(400)]); // ID3 头
  const opAssets = new Map<string, { id: string }>(); // operation_id → 资产（生成即持久面）
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/voice/synthesize') {
      synthCalls++;
      markEntered();
      if (mode === 'hang') { res.on('close', () => { if (!res.writableEnded) markClosed(); }); return; } // 合成中：等调用方断开
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { operation_id?: string };
        const opId = typeof body.operation_id === 'string' ? body.operation_id : null;
        if (mode === 'conflict') { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'operation_conflict', differs: ['text'] })); return; }
        if (mode === 'drop-persisted' && opId) { opAssets.set(opId, { id: 'asset-x' }); req.socket.destroy(); return; } // 已生成已持久，响应丢失
        if (mode === 'drop') { req.socket.destroy(); return; } // 服务端中途断连：结果不明
        if (failSynthesis) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'provider_failed' })); return; }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'x-siren-format': 'mp3', 'x-siren-duration-ms': '1200', 'x-siren-voice-profile': 'main' });
        res.end(mp3);
      });
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/v1/voice/messages?')) {
      const opId = new URL(req.url, 'http://x').searchParams.get('message_id') ?? '';
      const asset = opAssets.get(opId);
      if (!asset) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ items: [] })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [{ id: asset.id, duration_ms: 1200, audio_format: 'mp3' }] }));
      return;
    }
    if (req.method === 'GET' && /^\/v1\/voice-assets\/[^/]+\/audio$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(mp3);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(0, '127.0.0.1');
  return new Promise((resolve) => { server.on('listening', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, stop: () => { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); server.close(); }, get synthCalls() { return synthCalls; }, set failSynthesis(v: boolean) { failSynthesis = v; }, set mode(v: 'normal' | 'hang' | 'drop' | 'drop-persisted' | 'conflict') { mode = v; }, clientClosed, entered })); }) as never;
}

function compose(root: string, transport: OrTransport, sirenUrl: string) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const media = new MediaService(db, paths.mediaDir, config);
  const identity = new IdentityService(config, paths);
  const { tools } = assembleTestTools({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages, media, sirenCall: new SirenAdapter(sirenUrl, 'stub-token'), programFacts: { submitProgramFactTurn: () => undefined } });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new DeepSeekRunner({ retryMax: 0 }, transport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing: new RoutingService(db, events, messages), windows: new WindowManager(db, events, identity, config), logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory: new WindowTrajectoryService(db) });
  return { db, messages, media, supervisor, tools, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}


const ctx = (over: Partial<ToolExecContext> = {}): ToolExecContext => ({ roomId: 'primary', windowId: 'w', turnId: 't9', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'glm-a05', toolCallId: 'tc1', ...over });
const quietTransport: OrTransport = async () => ({ status: 200, headers: new Map(), body: Readable.from([]) as never });

test('A05 模型主动语音：chat_send_voice→真实资产→唯一 assistant 语音消息→归档正文=原话', async () => {
  const stub = await startSirenStub();
  const c = compose(tempRoot('glm-a05-'), quietTransport, stub.url);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();

    const out = await c.tools.execute('chat_send_voice', { text: '这条我想用语音说。' }, ctx());
    assert.equal(out.ok, true, JSON.stringify(out.output));
    const v = out.output as Record<string, unknown>;
    assert.equal(v['state'], 'published');
    const assetId = v['audio_asset_id'] as string;
    // 资产真实存在且 mp3
    const asset = c.db.prepare('SELECT mime_type, state FROM media_assets WHERE id=?').get(assetId) as { mime_type: string; state: string };
    assert.equal(asset.mime_type, 'audio/mpeg');
    assert.equal(asset.state, 'available');
    // 唯一 assistant 语音消息：正文=原话、附件=合成音频
    const msg = c.db.prepare("SELECT m.id, m.speaker, m.current_revision, r.content, r.kind FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.id=?").get(v['message_id']) as { speaker: string; content: string; kind: string };
    assert.equal(msg.speaker, 'assistant');
    assert.equal(msg.kind, 'voice');
    assert.equal(msg.content, '这条我想用语音说。');
    const att = c.db.prepare('SELECT asset_id FROM message_attachments WHERE message_id=? AND presentation=\'voice\'').get(v['message_id']) as { asset_id: string };
    assert.equal(att.asset_id, assetId);
    // RR-05（复审）：幂等在**费用边界之前**——已完成操作重放不再二次合成
    const again = await c.tools.execute('chat_send_voice', { text: '这条我想用语音说。' }, ctx());
    assert.equal(again.ok, true);
    assert.equal((again.output as Record<string, unknown>)['message_id'], v['message_id'], '同幂等键取回同一消息');
    assert.equal((again.output as Record<string, unknown>)['replayed'], true);
    assert.equal(stub.synthCalls, 1, 'RR-05：重放零二次合成（付费边界前置幂等）');
    console.log(JSON.stringify({ case: 'a05_voice_send', published: true, idempotent: true }));
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('A05 合成失败如实：工具错误可重试，不产出半截消息', async () => {
  const stub = await startSirenStub();
  stub.failSynthesis = true;
  const c = compose(tempRoot('glm-a05f-'), quietTransport, stub.url);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    const out = await c.tools.execute('chat_send_voice', { text: '说一句。' }, ctx());
    assert.equal(out.ok, false);
    assert.equal((out.output as Record<string, unknown>)['error_code'], 'SIREN_SYNTHESIS_FAILED');
    assert.equal(stub.synthCalls, 1);
    // 无半截 assistant 语音消息
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='assistant' AND kind='voice'").get() as { n: number }).n, 0);
    console.log(JSON.stringify({ case: 'a05_synthesis_failure', honest_error: true, no_partial_message: true }));
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('联合审计 A01：轮次取消真实断开到 Siren 的合成请求；不发布消息', async () => {
  const stub = await startSirenStub();
  stub.mode = 'hang';
  const c = compose(tempRoot('glm-a01c-'), quietTransport, stub.url);
  try {
    const turn = new AbortController();
    const pending = c.tools.execute('chat_send_voice', { text: '说到一半被停。' }, ctx({ signal: turn.signal }));
    await stub.entered;
    turn.abort();
    await stub.clientClosed; // Siren 侧观察到连接在响应前关闭（其路由据此取消 provider）
    const out = await pending;
    assert.equal(out.ok, false);
    assert.equal((out.output as Record<string, unknown>)['error_code'], 'CANCELLED');
    assert.equal(stub.synthCalls, 1);
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='assistant' AND kind='voice'").get() as { n: number }).n, 0);
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('联合审计 A01：合成结果不明如实报告，不引导立即重复收费调用', async () => {
  const stub = await startSirenStub();
  stub.mode = 'drop';
  const c = compose(tempRoot('glm-a01u-'), quietTransport, stub.url);
  try {
    const out = await c.tools.execute('chat_send_voice', { text: '这句结果不明。' }, ctx());
    assert.equal(out.ok, false);
    const o = out.output as Record<string, unknown>;
    assert.equal(o['error_code'], 'SIREN_OUTCOME_UNKNOWN');
    assert.doesNotMatch(String(o['detail']), /可重试/);
    assert.equal(stub.synthCalls, 1);
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='assistant' AND kind='voice'").get() as { n: number }).n, 0);
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('联合审计 A01-F02：响应丢失后按操作身份找回已生成资产发布（不重新合成）', async () => {
  const stub = await startSirenStub();
  stub.mode = 'drop-persisted'; // Siren 已生成并持久、响应丢失：est 应恢复而非重付
  const c = compose(tempRoot('glm-a01r-'), quietTransport, stub.url);
  try {
    const out = await c.tools.execute('chat_send_voice', { text: '找回这句。' }, ctx());
    assert.equal(out.ok, true, JSON.stringify(out.output));
    const v = out.output as Record<string, unknown>;
    assert.equal(v['state'], 'published');
    assert.equal(v['recovered'], true);
    assert.equal(stub.synthCalls, 1, '恢复不重新合成：同操作只有一次 provider 调用');
    // 唯一 assistant 语音消息，附件=取回的同一资产
    const msg = c.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='assistant' AND kind='voice'").get() as { n: number };
    assert.equal(msg.n, 1);
    const att = c.db.prepare("SELECT a.mime_type FROM message_attachments ma JOIN media_assets a ON a.id=ma.asset_id WHERE ma.presentation='voice'").get() as { mime_type: string };
    assert.equal(att.mime_type, 'audio/mpeg');
    // 幂等重放仍取同一消息（恢复后同键不再重复）
    const again = await c.tools.execute('chat_send_voice', { text: '找回这句。' }, ctx());
    assert.equal((again.output as Record<string, unknown>)['message_id'], v['message_id']);
    assert.equal(stub.synthCalls, 1);
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('联合审计 A01-F03：est 已有合成资产（发布前中断）——重试复用资产发布，零 TTS', async () => {
  const stub = await startSirenStub();
  const c = compose(tempRoot('glm-a01p-'), quietTransport, stub.url);
  try {
    const clientMessageId = 'voice-say:t9:tc1';
    const opKey = `voice-say:${sha256Hex(clientMessageId).slice(0, 24)}`;
    const saved = await c.media.saveBuffer({
      bytes: Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04]), Buffer.alloc(64)]), purpose: 'chat_voice',
      operationId: opKey, createdBy: 'assistant-voice', origin: 'import', originService: 'siren',
    });
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    const out = await c.tools.execute('chat_send_voice', { text: '发布中断后重试。' }, ctx());
    assert.equal(out.ok, true, JSON.stringify(out.output));
    const v = out.output as Record<string, unknown>;
    assert.equal(v['state'], 'published');
    assert.equal(v['reused_asset'], true);
    assert.equal(v['audio_asset_id'], saved.id);
    assert.equal(stub.synthCalls, 0, '已有资产：重试零合成');
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('联合审计 A01：同键异参冲突如实报告（SIREN_OPERATION_CONFLICT），不产出消息', async () => {
  const stub = await startSirenStub();
  stub.mode = 'conflict';
  const c = compose(tempRoot('glm-a01c2-'), quietTransport, stub.url);
  try {
    const out = await c.tools.execute('chat_send_voice', { text: '参数对不上的那句。' }, ctx());
    assert.equal(out.ok, false);
    const o = out.output as Record<string, unknown>;
    assert.equal(o['error_code'], 'SIREN_OPERATION_CONFLICT');
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='assistant' AND kind='voice'").get() as { n: number }).n, 0);
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});
