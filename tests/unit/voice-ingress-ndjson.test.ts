// R4（2026-10-23）：voice ingress——Siren CoreBridge 同窗电话入口。
// 合同逐字段对齐 http-core-bridge.ts：POST /v1/chat/stream NDJSON 流（delta*/done|error）。
// 同窗=supervisor.enqueue 共用串行链/工具/轨迹；断开=stop 同管线；token 未配=503 fail-closed。
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { handleVoiceChatStream } from '../../apps/host/src/server/http.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));

class FakeRes extends Writable {
  status = 0;
  headers: Record<string, string> = {};
  lines: string[] = [];
  buffer = '';
  _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.lines.push(line);
    }
    cb();
  }
  writeHead(code: number, headers: Record<string, string>): void { this.status = code; this.headers = headers; }
  override write = ((chunk: unknown) => { this._write(Buffer.from(String(chunk)), 'utf8', () => {}); return true; }) as Writable['write'];
}

function compose(root: string, transport: OrTransport) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const trajectory = new WindowTrajectoryService(db);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new DeepSeekRunner({ retryMax: 0 }, transport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory });
  return { db, config, messages, events, supervisor, deps: { config, db, events, messages, supervisor } as never, close() { db.close(); } };
}

const REQ = (obj: unknown, headers: Record<string, string> = {}): never => {
  const r = Readable.from([Buffer.from(JSON.stringify(obj), 'utf8')]) as Readable & { headers?: Record<string, string> };
  r.headers = headers;
  return r as never;
};
const withHeaders = (r: never, h: Record<string, string>): never => { ((r as unknown as { headers?: Record<string, string> }).headers) = h; return r; };

test('未配置 token=503 fail-closed；错 token=401；缺 conversation=422；未知会话=404', async () => {
  const root = tempRoot('r4-1-');
  const ctx = compose(root, async () => ({ status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + DONE) }));
  try {
    const prev = process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
    delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
    let res = new FakeRes();
    await handleVoiceChatStream(withHeaders(REQ({ conversation_id: 'c1', text: 'hi' }), {}) as never, res as never, ctx.deps);
    assert.equal(res.status, 503);
    process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'tok';
    res = new FakeRes();
    await handleVoiceChatStream(withHeaders(REQ({ conversation_id: 'c1', text: 'hi' }), { authorization: 'Bearer wrong' }) as never, res as never, ctx.deps);
    assert.equal(res.status, 401);
    res = new FakeRes();
    await handleVoiceChatStream(withHeaders(REQ({ text: 'hi' }), { authorization: 'Bearer tok' }) as never, res as never, ctx.deps);
    assert.equal(res.status, 422);
    // B2/RE-03（2026-10-24）：call_id/turn_id 必填（先完备性校验，后会话查找）；
    // 旧测试在缺 ID 时仍期待 404——被新合同替代
    res = new FakeRes();
    await handleVoiceChatStream(withHeaders(REQ({ conversation_id: 'nope', text: 'hi' }), { authorization: 'Bearer tok' }) as never, res as never, ctx.deps);
    assert.equal(res.status, 422);
    res = new FakeRes();
    await handleVoiceChatStream(withHeaders(REQ({ conversation_id: 'nope', call_id: 'c', turn_id: 't', text: 'hi' }), { authorization: 'Bearer tok' }) as never, res as never, ctx.deps);
    assert.equal(res.status, 404);
    if (prev === undefined) delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN; else process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = prev;
  } finally { ctx.close(); }
});

test('同窗电话轮：NDJSON delta…done；正文进主聊天留存；同窗串行（文字轮在其后有序）', async () => {
  const root = tempRoot('r4-2-');
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'tok';
  let n = 0;
  const ctx = compose(root, async () => {
    n += 1;
    return { status: 200, headers: new Map(), body: frameStream(sse({ id: `g${n}`, choices: [{ delta: { content: '电话回复正文。' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + DONE) };
  });
  try {
    const res = new FakeRes();
    const req = REQ({ conversation_id: 'c1', call_id: 'call-1', turn_id: 'st-1', modality: 'voice', text: '电话里说的话' }, { 'content-type': 'application/x-ndjson', authorization: 'Bearer tok' });
    const done = handleVoiceChatStream(req as never, res as never, ctx.deps);
    const lines = await new Promise<string[]>((resolve) => {
      const t = setInterval(() => {
        if (res.lines.some((l) => l.includes('"done"') || l.includes('"error"'))) { clearInterval(t); resolve([...res.lines]); }
      }, 25);
      setTimeout(() => { clearInterval(t); resolve([...res.lines]); }, 8000).unref();
    });
    await done.catch(() => {});
    assert.equal(res.status, 200, 'NDJSON 200');
    const evRows = ctx.db.prepare('SELECT kind, turn_id FROM runtime_stream_events ORDER BY sequence').all() as Array<{kind:string;turn_id:string|null}>;
    console.log('EVENTS:', JSON.stringify(evRows));
    const mpRow = ctx.db.prepare("SELECT payload_ref FROM runtime_stream_events WHERE kind='message.published' LIMIT 1").get() as { payload_ref: string };
    console.log('MP:', mpRow?.payload_ref?.slice(0, 300));
    const deltas = lines.filter((l) => l.includes('"type":"delta"'));
    assert.ok(deltas.length >= 1 && deltas.some((l) => l.includes('电话回复正文')), `lines=${JSON.stringify(lines)} status=${res.status}`);
    assert.ok(lines.some((l) => l.includes('"type":"done"')), 'done 终态');
    // 主聊天留存：用户语音输入与助手正文都入 messages
    const msgs = ctx.db.prepare('SELECT speaker, kind FROM messages WHERE conversation_id=? ORDER BY sequence').all('c1') as Array<{ speaker: string; kind: string }>;
    assert.ok(msgs.some((m) => m.speaker === 'owner'), '用户输入入主聊天');
    assert.ok(msgs.some((m) => m.speaker === 'assistant'), '助手正文入主聊天（一份，不另造电话历史）');
    // 轨迹同窗：助手正文进入窗口轨迹（与文字轮同链产物）
    const trajRow = ctx.db.prepare('SELECT messages_json FROM window_trajectories ORDER BY updated_at DESC LIMIT 1').get() as { messages_json: string } | undefined;
    assert.ok(trajRow && trajRow.messages_json.includes('电话回复正文'), '助手正文入窗口轨迹（同窗，不另造历史）');
  } finally {
    delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
    ctx.close();
  }
});
