// 协议①②（2026-10-24）：离线合同——
// ② audio_ref：ingress 取回 Siren 原声→存 chat_voice 资产→绑附件→转写就绪→快证据标记行；
//    原声取回失败=纯文字轮降级（通话不阻断）。
// ① call_control：invite=est 授权创建邀请（经 SirenAdapter→fake HTTP）；status=查询；
//    未配置=SIREN/集成如实拒绝。邀请代理端点（owner 面）转发正确。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import type { ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { handleVoiceChatStream, handleRequest } from '../../apps/host/src/server/http.ts';
import { SirenAdapter } from '../../apps/host/src/integrations/siren/adapter.ts';
import {writeApprovedIdentity, readyRuntimePatch, tempRoot, assembleTestTools } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));
const WAV = (samples = 1600): Buffer => {
  const payload = Buffer.alloc(samples * 2, 0x10);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + payload.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(payload.length, 40);
  return Buffer.concat([h, payload]);
};

class FakeRes extends Writable {
  status = 0; lines: string[] = []; buffer = '';
  _write(chunk: Buffer, _e: string, cb: (e?: Error | null) => void): void {
    this.buffer += chunk.toString('utf8');
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) { const l = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1); if (l) this.lines.push(l); }
    cb();
  }
  writeHead(code: number): void { this.status = code; }
  /** json() 响应无结尾换行——结束时残余 buffer 计入最后一行 */
  flushTail(): void { const tail = this.buffer.trim(); this.buffer = ''; if (tail) this.lines.push(tail); }
}

function makeSirenTransport(log: Array<{ url: string; method: string }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    log.push({ url: u, method: init?.method ?? 'GET' });
    if (u.includes('/v1/invites') && !u.includes('/accept') && !u.includes('/decline') && (init?.method ?? 'GET') === 'POST') {
      return Response.json({ invite_id: 'inv-fake-1', state: 'pending', expires_at: Date.now() + 45000 }, { status: 201 });
    }
    if (u.includes('/v1/conversations/') && u.includes('/invites')) {
      return Response.json({ active: null, recent: [{ invite_id: 'inv-old', state: 'expired', expires_at: 1, created_at: 1, updated_at: 2, ended_reason: 'invite_expired' }] });
    }
    if (u.includes('/accept')) return Response.json({ invite_id: 'inv-fake-1', state: 'accepted', changed: true, state_version: 2, expires_at: 1 });
    if (u.includes('/decline')) return Response.json({ invite_id: 'inv-fake-1', state: 'declined', changed: true, state_version: 2, expires_at: 1 });
    if (u.includes('/v1/voice-assets/') && u.includes('/audio')) {
      const bytes = WAV();
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(bytes.length) } });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }) as unknown as typeof fetch;
}

function compose(root: string, transport: OrTransport, sirenTransport: typeof fetch, opts: { oido?: unknown } = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  messages.ensureConversation('primary'); // 邀请代理端点固定作用于 primary（产品单会话）
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const media = new MediaService(db, paths.mediaDir, config);
  const sirenCall = new SirenAdapter('http://127.0.0.1:1', 'fake-token', sirenTransport);
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), media: media, messages: messages, sirenCall: sirenCall });
  const trajectory = new WindowTrajectoryService(db);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new DeepSeekRunner({ retryMax: 0 }, transport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory, media });
  const oido = opts.oido as never;
  return { root, db, config, messages, events, supervisor, media, sirenCall, oido, tools, deps: { config, db, events, messages, supervisor, paths, logger: new Logger(path.join(root, 'logs')), media, sirenCall, ...(oido ? { oido } : {}) } as never, async close() { await new Promise((r) => setTimeout(r, 150)); db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const normalTransport: OrTransport = async () => ({ status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '合成电话回复。' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + DONE) });
const REQ = (obj: unknown, headers: Record<string, string> = {}): never => {
  const r = Readable.from([Buffer.from(JSON.stringify(obj), 'utf8')]) as Readable & { headers?: Record<string, string> };
  r.headers = headers;
  return r as never;
};

test('协议② audio_ref：原声取回→资产绑定→快证据标记', async () => {
  const prior = process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'tok';
  const sirenLog: Array<{ url: string; method: string }> = [];
  const fakeOido = {
    configured: true,
    ingestVoice: async () => ({ audioId: 'oido-audio-1', deduplicated: false }),
    analyze: async () => ({ analysis_id: 'an-1', state: 'ready', observations: [{ kind: '末尾停顿', value: 1.2, unit: 's' }] }),
  };
  const ctx = compose(tempRoot('p2-audio-'), normalTransport, makeSirenTransport(sirenLog), { oido: fakeOido });
  let res: FakeRes | null = null;
  try {
    res = new FakeRes();
    await handleVoiceChatStream(REQ({ conversation_id: 'c1', call_id: 'c-1', turn_id: 't-1', modality: 'voice_call', text: '电话里说的话。', audio_ref: 'siren:va-1' }, { authorization: 'Bearer tok' }) as never, res as never, ctx.deps);
    await ctx.supervisor.waitIdle();
    await pause(150);
    // ① 原声取回（服务间端点）
    assert.ok(sirenLog.some((l) => l.url.includes('/v1/voice-assets/va-1/audio')), JSON.stringify(sirenLog));
    // ② est 资产+转写+附件绑定
    const att = ctx.db.prepare("SELECT a.id, a.mime_type FROM message_attachments ma JOIN media_assets a ON a.id=ma.asset_id WHERE ma.presentation='voice' LIMIT 1").get() as { id: string; mime_type: string } | undefined;
    assert.ok(att, '语音附件必须绑定到消息');
    assert.equal(att.mime_type, 'audio/wav');
    const vt = ctx.db.prepare('SELECT derived_text FROM voice_transcripts WHERE asset_id=?').get(att.id) as { derived_text: string };
    assert.ok(vt.derived_text.includes('电话里说的话。'), '转写入库');
    assert.ok(vt.derived_text.includes('[声音观察（oído 快证据，非转写）：末尾停顿'), '快证据标记行随转写进模型面: ' + vt.derived_text);
    // ③ 流正常完成
    assert.ok(res.lines.some((l) => l.includes('"done"')), '电话轮完成');
    console.log(JSON.stringify({ case: 'p2_audio_chain', transcript: vt.derived_text.slice(0, 80) }));
  } finally {
    if (prior === undefined) delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN; else process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = prior;
    await ctx.supervisor.stopAll();
    await ctx.close();
  }
});

test('协议② 降级：取回失败=纯文字轮，通话不阻断', async () => {
  const prior = process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'tok';
  const failingSiren: typeof fetch = (async () => Response.json({ error: 'down' }, { status: 503 })) as unknown as typeof fetch;
  const ctx = compose(tempRoot('p2-degrade-'), normalTransport, failingSiren);
  let res: FakeRes | null = null;
  try {
    res = new FakeRes();
    await handleVoiceChatStream(REQ({ conversation_id: 'c1', call_id: 'c-2', turn_id: 't-1', modality: 'voice_call', text: '没有原声的电话轮。', audio_ref: 'siren:va-x' }, { authorization: 'Bearer tok' }) as never, res as never, ctx.deps);
    await ctx.supervisor.waitIdle();
    await pause(120);
    assert.ok(res.lines.some((l) => l.includes('"done"')), '纯文字轮正常完成');
    const msg = ctx.db.prepare("SELECT r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.speaker='owner' ORDER BY m.sequence DESC LIMIT 1").get() as { content: string };
    assert.equal(msg.content, '没有原声的电话轮。', '正文兜底为文字');
    console.log(JSON.stringify({ case: 'p2_degrade' }));
  } finally {
    if (prior === undefined) delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN; else process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = prior;
    await ctx.supervisor.stopAll();
    await ctx.close();
  }
});

test('协议① call_control：invite 经 SirenAdapter 创建；未配置如实拒绝；status 查询', async () => {
  const sirenLog: Array<{ url: string; method: string }> = [];
  const ctx = compose(tempRoot('p1-callctl-'), normalTransport, makeSirenTransport(sirenLog), {});
  try {
    const ctl = (over: Partial<ToolExecContext> = {}): ToolExecContext => ({ roomId: 'c1', windowId: 'w', turnId: 'turn-1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'p1', ...over });
    const inv = await ctx.tools.execute('call_control', { action: 'invite' }, ctl());
    assert.equal(inv.ok, true, JSON.stringify(inv.output));
    assert.equal((inv.output as Record<string, unknown>)['invite_id'], 'inv-fake-1');
    assert.ok(sirenLog.some((l) => l.url.endsWith('/v1/invites') && l.method === 'POST'));
    const st = await ctx.tools.execute('call_control', { action: 'status' }, ctl());
    assert.equal(st.ok, true);
    const recent = (st.output as { recent: Array<{ state: string }> }).recent;
    assert.equal(recent[0]!.state, 'expired');
    // 未配置：SirenAdapter status=not_configured → 集成缺口如实拒绝
    const { tools: noSiren } = assembleTestTools({ db: ctx.db, mariposa: null, reviews: new RotationReviewService(ctx.db), checkpoint: new HoldCheckpointService(ctx.db), sirenCall: new SirenAdapter(null, null) });
    const r = await noSiren.execute('call_control', { action: 'invite' }, ctl());
    assert.equal(r.ok, false);
    assert.equal((r.output as Record<string, unknown>)['error_code'], 'INTEGRATION_UNCONFIGURED');
    console.log(JSON.stringify({ case: 'p1_call_control' }));
  } finally {
    await ctx.supervisor.stopAll();
    await ctx.close();
  }
});

test('协议① 邀请代理端点（owner 面）：列表/接听/拒接转发', async () => {
  const sirenLog: Array<{ url: string; method: string }> = [];
  const ctx = compose(tempRoot('p1-proxy-'), normalTransport, makeSirenTransport(sirenLog), {});
  try {
    const deps = { ...ctx.deps, auth: { isAuthorized: () => true, verifyToken: () => true, originAllowed: () => true } } as never;
    const call = async (route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = new FakeRes();
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as Readable & { headers?: Record<string, string>; method?: string; url?: string };
      req.headers = {}; req.method = method; req.url = route;
      await handleRequest(req as never, res as never, deps);
      await new Promise((r) => setTimeout(r, 30)); // Writable.end 异步冲刷
      res.flushTail();
      return { status: res.status, body: res.lines.length > 0 ? JSON.parse(res.lines.join('')) as Record<string, unknown> : {} };
    };
    const list = await call('/api/v1/calls/invites');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body['recent']));
    const acc = await call('/api/v1/calls/invites/inv-fake-1/accept', 'POST');
    assert.equal(acc.status, 200);
    assert.equal(acc.body['state'], 'accepted');
    const dec = await call('/api/v1/calls/invites/inv-fake-1/decline', 'POST');
    assert.equal(dec.body['state'], 'declined');
    assert.ok(sirenLog.some((l) => l.url.includes('/accept') && l.method === 'POST'));
    console.log(JSON.stringify({ case: 'p1_invite_proxy' }));
  } finally {
    await ctx.supervisor.stopAll();
    await ctx.close();
  }
});
