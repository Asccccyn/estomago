// 她→他通话请求（2026-10-24 她要的功能）：她发起（dial 端点）→ char程序事实轮收到 →
// accept_call（est 建 Siren 通话挂连接）或 decline_call（他同轮说话落会话）；她取消/到期如实。
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
import { ModelToolBridge, type ToolExecContext } from '../../apps/host/src/capabilities/model-bridge.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { handleRequest } from '../../apps/host/src/server/http.ts';
import {writeApprovedIdentity, readyRuntimePatch, tempRoot, assembleTestTools } from '../helpers.ts';
import { registerVoiceCapabilities as importRegisterVoiceCapabilities } from '../../apps/host/src/modules/voice/module.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function compose(root: string, transport: OrTransport) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config) // 合并对齐：handoffsDir 已随 handoff 退役移除（集成侧 2026-10-24 裁定）;
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages: messages });
  const trajectory = new WindowTrajectoryService(db);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new DeepSeekRunner({ retryMax: 0 }, transport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory });
  const deps = { config, db, events, messages, supervisor, paths, logger: new Logger(path.join(root, 'logs')), auth: { isAuthorized: () => true, verifyToken: () => true, originAllowed: () => true } } as never;
  const call = async (route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = new FakeRes();
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as Readable & { headers?: Record<string, string>; method?: string; url?: string };
    req.headers = {}; req.method = method; req.url = route;
    await handleRequest(req as never, res as never, deps);
    await new Promise((r) => setTimeout(r, 30));
    res.flushTail();
    return { status: res.status, body: res.lines.length > 0 ? JSON.parse(res.lines.join('')) as Record<string, unknown> : {} };
  };
  return { db, messages, supervisor, tools, call, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const ctx = (over: Partial<ToolExecContext> = {}): ToolExecContext => ({ roomId: 'primary', windowId: 'w', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'dial', ...over });

test('她发起→char收到事实轮并 decline_call：请求 declined+他同轮的话落会话', async () => {
  const prompts: string[] = [];
  const transport: OrTransport = async (p) => {
    prompts.push(JSON.stringify(p.messages));
    const last = (p.messages as Array<{ role: string; content: unknown }>).at(-1);
    if (last?.role === 'user' && JSON.stringify(last.content).includes('发起语音通话请求')) {
      // 事实轮：他调 decline_call 然后说一句
      return { status: 200, headers: new Map(), body: frameStream(sse({ id: 'd1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'call_control', arguments: JSON.stringify({ action: 'decline_call' }) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE) };
    }
    if (last?.role === 'tool') {
      return { status: 200, headers: new Map(), body: frameStream(sse({ id: 'd2', choices: [{ delta: { content: '我现在不太方便说话，晚上打给你好不好。' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + DONE) };
    }
    return { status: 200, headers: new Map(), body: frameStream(sse({ id: 'd3', choices: [{ delta: { content: '嗯' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) };
  };
  const c = compose(tempRoot('dial-decline-'), transport);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    const ownerBefore = (c.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='owner'").get() as { n: number }).n;

    const dial = await c.call('/api/v1/calls/dial', 'POST', {});
    assert.equal(dial.status, 200);
    assert.equal(dial.body['state'], 'pending');
    await c.supervisor.waitIdle(); // 事实轮跑完（他拒绝+说话）
    await pause(150);
    // 事实进入模型
    assert.ok(prompts.some((p) => p.includes('发起语音通话请求') && p.includes('decline_call')));
    // 请求终态
    const cur = await c.call('/api/v1/calls/dial/current');
    assert.equal(cur.body['state'], 'declined');
    // 他同轮的话落会话
    const reply = c.db.prepare("SELECT r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.speaker='assistant' ORDER BY m.sequence DESC LIMIT 1").get() as { content: string };
    assert.ok(reply.content.includes('晚上打给你'), reply.content);
    // 不写她的消息
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='owner'").get() as { n: number }).n, ownerBefore);
    console.log(JSON.stringify({ case: 'dial_declined', reply: reply.content }));
  } finally { await c.supervisor.stopAll(); c.close(); }
});

test('她取消后再 accept_call：DIAL_SUPERSEDED 如实（不建通话）', async () => {
  const transport: OrTransport = async () => ({ status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) });
  const c = compose(tempRoot('dial-cancel-'), transport);
  process.env.ESTOMAGO_SIREN_BASE_URL = 'http://127.0.0.1:1'; // accept 建呼会失败——先测 superseded（在建呼前）
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    const dial = await c.call('/api/v1/calls/dial', 'POST', {});
    const id = dial.body['request_id'] as string;
    // 她关面板=取消
    const del = await c.call(`/api/v1/calls/dial/${id}`, 'DELETE');
    assert.equal(del.body['state'], 'cancelled');
    // 他迟到 accept：无 pending → 如实
    const r = await c.tools.execute('call_control', { action: 'accept_call' }, ctx());
    assert.equal(r.ok, false);
    assert.equal((r.output as Record<string, unknown>)['error_code'], 'NO_PENDING_DIAL');
    console.log(JSON.stringify({ case: 'dial_cancelled_then_accept' }));
  } finally { delete process.env.ESTOMAGO_SIREN_BASE_URL; await c.supervisor.stopAll(); c.close(); }
});

test('到期惰性过期：pending 超 TTL → current 返回 expired', async () => {
  const transport: OrTransport = async () => ({ status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) });
  const c = compose(tempRoot('dial-exp-'), transport);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    await c.call('/api/v1/calls/dial', 'POST', {});
    // 篡改 created_at 到过去（测试加速；TTL 45s）
    c.db.prepare("UPDATE dial_requests SET created_at = datetime('now','-2 minutes')").run();
    const cur = await c.call('/api/v1/calls/dial/current');
    assert.equal(cur.body['state'], 'expired');
    console.log(JSON.stringify({ case: 'dial_expired' }));
  } finally { await c.supervisor.stopAll(); c.close(); }
});
