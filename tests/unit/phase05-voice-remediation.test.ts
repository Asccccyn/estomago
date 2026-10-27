// Phase 0.5 整改验证（跨仓预审 F-02/F-04，2026-10-25）：
// - F-02：接听交接——POST /api/v1/calls/invites/:id/accept 落定邀请终态后由宿主建
//   Siren 通话并交付连接信息（call_id/ws_url/token）+ voice_calls 立册；前端不再反向拨号。
// - F-04：dial 投影收口——通话结束后再拨是**新**请求（不复用旧 accepted 的已吊销连接）；
//   Siren→est 服务间终态（DELETE /v1/calls）收口 voice_calls，工具资格（memory_only）恢复。
// Siren 是外部 HTTP 边界：本地 stub 只实现其公开合同（/v1/invites 族 + /v1/calls），
// S 侧行为由 siren 仓 phase05 测试用真实 Fastify/CallCenter 直接验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
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
import { SirenAdapter } from '../../apps/host/src/integrations/siren/adapter.ts';
import { handleRequest } from '../../apps/host/src/server/http.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, assembleTestTools } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));

/** Siren 公开合同 stub（外部边界替代）：邀请族 + 建呼；每次建呼发新 call_id/token。 */
function startSirenStub(): { url: string; stop(): void; calls: string[] } {
  const calls: string[] = [];
  let inviteSeq = 0;
  const inviteState = new Map<string, string>();
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/v1/invites') {
      inviteSeq += 1;
      const id = `inv_${inviteSeq}`;
      inviteState.set(id, 'pending');
      send(201, { invite_id: id, conversation_id: 'primary', state: 'pending', expires_at: Date.now() + 45000, created_at: Date.now() });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/conversations/primary/invites') {
      const pending = [...inviteState].filter(([, s]) => s === 'pending').at(-1);
      const recent = [...inviteState].filter(([, s]) => s !== 'pending').map(([id, s]) => ({ invite_id: id, state: s, expires_at: Date.now(), created_at: Date.now(), updated_at: Date.now(), ended_reason: null }));
      send(200, { conversation_id: 'primary', active: pending ? { invite_id: pending[0], conversation_id: 'primary', state: 'pending', expires_at: Date.now() + 45000, created_at: Date.now() } : null, recent });
      return;
    }
    const acc = /^\/v1\/invites\/([^/]+)\/(accept|decline|cancel)$/.exec(req.url ?? '');
    if (req.method === 'POST' && acc) {
      const cur = inviteState.get(acc[1]!);
      if (cur === 'pending') {
        const state = acc[2] === 'accept' ? 'accepted' : acc[2] === 'decline' ? 'declined' : 'cancelled';
        inviteState.set(acc[1]!, state);
        send(200, { invite_id: acc[1]!, state, state_version: 2, changed: true, expires_at: Date.now() + 45000 });
      } else {
        send(200, { invite_id: acc[1]!, state: cur ?? 'expired', state_version: 2, changed: false, expires_at: Date.now() });
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/calls') {
      const id = `sc_${calls.length + 1}`;
      calls.push(id);
      send(200, { call_id: id, ws_url: `ws://127.0.0.1:9/ws/call/${id}`, token: `tk_${id}`, expires_at: new Date(Date.now() + 60_000).toISOString(), conversation_id: 'primary' });
      return;
    }
    send(404, { error: 'not_found' });
  });
  server.listen(0, '127.0.0.1');
  return new Promise((resolve) => { server.on('listening', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, stop: () => server.close(), calls })); }) as never;
}

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

function compose(root: string, transport: OrTransport, sirenUrl: string) {
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
  const windows = new WindowManager(db, events, identity, config);
  const { tools } = assembleTestTools({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages, sirenCall: new SirenAdapter(sirenUrl, 'stub-token') });
  const trajectory = new WindowTrajectoryService(db);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new DeepSeekRunner({ retryMax: 0 }, transport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory });
  const deps = { config, db, events, messages, supervisor, paths, logger: new Logger(path.join(root, 'logs')), auth: { isAuthorized: () => true, verifyToken: () => true, originAllowed: () => true }, sirenCall: new SirenAdapter(sirenUrl, 'stub-token') } as never;
  const call = async (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = new FakeRes();
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as Readable & { headers?: Record<string, string>; method?: string; url?: string };
    req.headers = headers; req.method = method; req.url = route;
    await handleRequest(req as never, res as never, deps);
    await new Promise((r) => setTimeout(r, 30));
    res.flushTail();
    return { status: res.status, body: res.lines.length > 0 ? JSON.parse(res.lines.join('')) as Record<string, unknown> : {} };
  };
  return { db, messages, supervisor, tools, call, deps, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const ctx = (over: Partial<ToolExecContext> = {}): ToolExecContext => ({ roomId: 'primary', windowId: 'w', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'phase05', ...over });

const quietTransport: OrTransport = async () => ({ status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) });

test('F-02 接听交接：邀请 accept→宿主建呼→连接信息随响应交付 + voice_calls 立册', async () => {
  const stub = await startSirenStub();
  process.env.ESTOMAGO_SIREN_BASE_URL = stub.url;
  const c = compose(tempRoot('p05-accept-'), quietTransport, stub.url);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();

    // 他（模型）发起来电邀请
    const inv = await c.tools.execute('call_control', { action: 'invite' }, ctx());
    assert.equal(inv.ok, true, JSON.stringify(inv.output));
    const inviteId = (inv.output as Record<string, unknown>)['invite_id'] as string;

    // 前端数据源：active 用 invite_id（S 新 DTO 经 est 代理透传）
    const list = await c.call('/api/v1/calls/invites');
    const active = list.body['active'] as Record<string, unknown> | null;
    assert.equal(active?.['invite_id'], inviteId);

    // 她接听：宿主落定邀请终态→建 Siren 通话→连接信息交付（不再反向拨号）
    const accepted = await c.call(`/api/v1/calls/invites/${encodeURIComponent(inviteId)}/accept`, 'POST');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body['state'], 'accepted');
    assert.equal(typeof accepted.body['call_id'], 'string');
    assert.equal(typeof accepted.body['ws_url'], 'string');
    assert.equal(typeof accepted.body['token'], 'string');
    // voice_calls 立册（memory_only 生效的同一事实源）
    const row = c.db.prepare("SELECT state FROM voice_calls WHERE call_id=?").get(accepted.body['call_id']) as { state: string };
    assert.equal(row.state, 'active');
    // 通话期间工具资格：非 memory_only 工具被拒（wake_manage=预审 F-04 指出的受影响工具）
    const gated = await c.tools.execute('wake_manage', { action: 'list' }, ctx());
    assert.equal(gated.ok, false);
    assert.equal((gated.output as Record<string, unknown>)['error_code'], 'TOOL_UNAVAILABLE_IN_CALL');

    // F-04 S→E 终态：Siren 侧结束（服务间 DELETE /v1/calls/:id，ingress token 面）
    process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'ingress-tok';
    const ended = await c.call(`/v1/calls/${encodeURIComponent(accepted.body['call_id'] as string)}`, 'DELETE', undefined, { authorization: 'Bearer ingress-tok' });
    assert.equal(ended.status, 200);
    assert.equal(ended.body['state'], 'ended');
    // 工具资格恢复（普通聊天/自主唤醒不再被 memory_only 卡住）
    const reopened = await c.tools.execute('wake_manage', { action: 'list' }, ctx());
    assert.notEqual((reopened.output as Record<string, unknown>)['error_code'], 'TOOL_UNAVAILABLE_IN_CALL', JSON.stringify(reopened.output));

    console.log(JSON.stringify({ case: 'f02_accept_handoff', invite_id: inviteId, call_id: accepted.body['call_id'], tool_gate_reopened: true }));
  } finally {
    delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
    await c.supervisor.stopAll(); c.close(); stub.stop();
  }
});

test('F-04 重拨收口：挂断后再拨得到新请求（不复活已结束通话的连接信息）', async () => {
  const stub = await startSirenStub();
  process.env.ESTOMAGO_SIREN_BASE_URL = stub.url;
  const c = compose(tempRoot('p05-redial-'), quietTransport, stub.url);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();

    // 她发起 → char accept_call（est 建 Siren 通话挂到请求上）
    const d1 = await c.call('/api/v1/calls/dial', 'POST', {});
    assert.equal(d1.body['state'], 'pending');
    const acc = await c.tools.execute('call_control', { action: 'accept_call' }, ctx());
    assert.equal(acc.ok, true, JSON.stringify(acc.output));
    const call1 = (acc.output as Record<string, unknown>)['call_id'] as string;
    const cur1 = await c.call('/api/v1/calls/dial/current');
    assert.equal(cur1.body['state'], 'accepted');
    assert.equal(cur1.body['call_id'], call1);

    // 她挂断：est owner 收口 voice_calls
    const del = await c.call(`/api/v1/calls/${encodeURIComponent(call1)}`, 'DELETE');
    assert.equal(del.body['state'], 'ended');

    // 再拨：新请求、pending、不带旧连接信息（旧代码：返回同一 accepted 请求+已吊销 token）
    const d2 = await c.call('/api/v1/calls/dial', 'POST', {});
    assert.equal(d2.body['state'], 'pending');
    assert.notEqual(d2.body['request_id'], d1.body['request_id']);
    assert.equal(d2.body['ws_url'], undefined);
    const cur2 = await c.call('/api/v1/calls/dial/current');
    assert.equal(cur2.body['state'], 'pending');

    console.log(JSON.stringify({ case: 'f04_redial_new_request', first: d1.body['request_id'], second: d2.body['request_id'] }));
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('R-03 重复接听同一邀请：取回同一交接结果，不重复建呼、不遗留孤儿 active', async () => {
  const stub = await startSirenStub();
  process.env.ESTOMAGO_SIREN_BASE_URL = stub.url;
  const c = compose(tempRoot('p05-replay-'), quietTransport, stub.url);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();

    const inv = await c.tools.execute('call_control', { action: 'invite' }, ctx());
    const inviteId = (inv.output as Record<string, unknown>)['invite_id'] as string;

    // 第一次接听：建呼成功，但模拟连接信息响应丢失（不用返回值建立 WS）
    const a1 = await c.call(`/api/v1/calls/invites/${encodeURIComponent(inviteId)}/accept`, 'POST');
    assert.equal(a1.body['state'], 'accepted');
    const call1 = a1.body['call_id'] as string;

    // 页面重试同一接听（Siren 幂等返回 accepted/changed=false）：
    // 取回同一交接（call_id/token 相同），不再向 Siren 建第二次呼
    const createdBefore = stub.calls.length;
    const a2 = await c.call(`/api/v1/calls/invites/${encodeURIComponent(inviteId)}/accept`, 'POST');
    assert.equal(a2.status, 200, JSON.stringify(a2.body));
    assert.equal(a2.body['state'], 'accepted');
    assert.equal(a2.body['call_id'], call1, '同一邀请取回同一通话');
    assert.equal(a2.body['token'], a1.body['token'], '连接信息可重放');
    assert.equal(a2.body['handoff_replayed'], true);
    assert.equal(stub.calls.length, createdBefore, 'Siren 未被重复请求建呼');
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM voice_calls WHERE state='active'").get() as { n: number }).n, 1, '只有一条 active');

    // 该通话结束后再重试：如实告知已结束，不复活连接
    await c.call(`/api/v1/calls/${encodeURIComponent(call1)}`, 'DELETE');
    const a3 = await c.call(`/api/v1/calls/invites/${encodeURIComponent(inviteId)}/accept`, 'POST');
    assert.equal(a3.status, 200);
    assert.equal(a3.body['call_id'], call1);
    assert.equal(a3.body['ws_url'], undefined, '不交付已结束通话的连接信息');
    assert.ok(String(a3.body['note'] ?? '').includes('通话已结束'), JSON.stringify(a3.body));
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM voice_calls WHERE state='active'").get() as { n: number }).n, 0);

    console.log(JSON.stringify({ case: 'r03_accept_replay', invite_id: inviteId, same_call: true, siren_create_count: stub.calls.length, orphan_active: 0 }));
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('R-03A 并发首次接听（双页面同刻）：唯一建呼，两响应同交接', async () => {
  const stub = await startSirenStub();
  process.env.ESTOMAGO_SIREN_BASE_URL = stub.url;
  const c = compose(tempRoot('p05-race-'), quietTransport, stub.url);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    const inv = await c.tools.execute('call_control', { action: 'invite' }, ctx());
    const inviteId = (inv.output as Record<string, unknown>)['invite_id'] as string;

    // 两个独立请求对象并发到达（模拟两个已打开页面在同一轮询刷新前各发首次 accept）
    const route = `/api/v1/calls/invites/${encodeURIComponent(inviteId)}/accept`;
    const fire = (): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = new FakeRes();
      const req = Readable.from([]) as Readable & { headers?: Record<string, string>; method?: string; url?: string };
      req.headers = {}; req.method = 'POST'; req.url = route;
      return handleRequest(req as never, res as never, (c as unknown as { deps: never }).deps).then(async () => {
        await new Promise((r) => setTimeout(r, 30));
        res.flushTail();
        return { status: res.status, body: res.lines.length > 0 ? JSON.parse(res.lines.join('')) as Record<string, unknown> : {} };
      });
    };
    const [r1, r2] = await Promise.all([fire(), fire()]);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r1.body['call_id'], r2.body['call_id'], '并发首次接听取回同一通话');
    assert.equal(r1.body['token'], r2.body['token']);
    assert.equal(stub.calls.length, 1, 'Siren 只被请求建呼一次');
    assert.equal((c.db.prepare('SELECT COUNT(*) n FROM invite_call_handoffs').get() as { n: number }).n, 1, '归属唯一');
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM voice_calls WHERE state='active'").get() as { n: number }).n, 1, 'active 唯一');
    console.log(JSON.stringify({ case: 'r03a_concurrent_first_accept', siren_create_count: stub.calls.length, same_call: true }));
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('R-03B token 过期：已连接的通话不被误结束；未连接的孤儿才收口', async () => {
  const stub = await startSirenStub();
  process.env.ESTOMAGO_SIREN_BASE_URL = stub.url;
  const c = compose(tempRoot('p05-token-'), quietTransport, stub.url);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();

    // 场景1：接听后通话已建立（Siren register 通知=WS 注册）→ token 过期后重试
    const inv1 = await c.tools.execute('call_control', { action: 'invite' }, ctx());
    const id1 = (inv1.output as Record<string, unknown>)['invite_id'] as string;
    const a1 = await c.call(`/api/v1/calls/invites/${encodeURIComponent(id1)}/accept`, 'POST');
    const callA = a1.body['call_id'] as string;
    process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'ingress-tok';
    const reg = await c.call('/v1/calls', 'POST', { call_id: callA, conversation_id: 'primary' }, { authorization: 'Bearer ingress-tok' });
    assert.equal(reg.body['state'], 'active');
    assert.ok((c.db.prepare('SELECT connected_at FROM voice_calls WHERE call_id=?').get(callA) as { connected_at: string }).connected_at, 'register 通知记录连接事实');
    // 时间推进加速：token 到期（生产为自然推进可达状态）
    c.db.prepare("UPDATE invite_call_handoffs SET expires_at='2000-01-01T00:00:00Z' WHERE invite_id=?").run(id1);
    const a2 = await c.call(`/api/v1/calls/invites/${encodeURIComponent(id1)}/accept`, 'POST');
    assert.equal(a2.status, 200);
    assert.equal(a2.body['ws_url'], undefined, '过期连接信息不再交付');
    assert.ok(String(a2.body['note'] ?? '').includes('通话已建立'), JSON.stringify(a2.body));
    // 核心断言：通话仍在进行（已连接），token 过期不得结束它
    assert.equal((c.db.prepare('SELECT state FROM voice_calls WHERE call_id=?').get(callA) as { state: string }).state, 'active');

    // 场景2：接听后从未连接（响应丢失、无 WS）→ token 过期后重试=孤儿收口
    const inv2 = await c.tools.execute('call_control', { action: 'invite' }, ctx());
    const id2 = (inv2.output as Record<string, unknown>)['invite_id'] as string;
    const b1 = await c.call(`/api/v1/calls/invites/${encodeURIComponent(id2)}/accept`, 'POST');
    const callB = b1.body['call_id'] as string;
    c.db.prepare("UPDATE invite_call_handoffs SET expires_at='2000-01-01T00:00:00Z' WHERE invite_id=?").run(id2);
    const b2 = await c.call(`/api/v1/calls/invites/${encodeURIComponent(id2)}/accept`, 'POST');
    assert.equal(b2.body['ws_url'], undefined);
    assert.ok(String(b2.body['note'] ?? '').includes('从未建立'), JSON.stringify(b2.body));
    assert.equal((c.db.prepare('SELECT state FROM voice_calls WHERE call_id=?').get(callB) as { state: string }).state, 'ended', '未连接+永不可连的孤儿被收口');
    console.log(JSON.stringify({ case: 'r03b_token_expiry_facts', connected_call_kept_active: true, never_connected_orphan_ended: true }));
  } finally {
    delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
    await c.supervisor.stopAll(); c.close(); stub.stop();
  }
});

test('R-01 正式宿主交付的 /chat-app.js = 重建后的前端产物（含 F-02/F-03/R-02 客户端修复）', async () => {
  const stub = await startSirenStub();
  process.env.ESTOMAGO_SIREN_BASE_URL = stub.url;
  const c = compose(tempRoot('p05-bundle-'), quietTransport, stub.url);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    // 真实静态 handler（serveStatic 逐字节读 apps/web/dist）取回正式入口资源
    const chunks: Buffer[] = [];
    const rawRes = new Writable({
      write(chunk: Buffer, _e: string, cb: (e?: Error | null) => void): void { chunks.push(Buffer.from(chunk)); cb(); },
    }) as Writable & { status: number; writeHead(code: number): void };
    rawRes.status = 0;
    rawRes.writeHead = (code: number): void => { rawRes.status = code; };
    const req = Readable.from([]) as Readable & { headers?: Record<string, string>; method?: string; url?: string };
    req.headers = {}; req.method = 'GET'; req.url = '/chat-app.js';
    const { handleRequest } = await import('../../apps/host/src/server/http.ts');
    await handleRequest(req as never, rawRes as never, (c as unknown as { deps: never }).deps);
    const served = Buffer.concat(chunks);
    assert.equal(rawRes.status, 200);
    const servedSha = crypto.createHash('sha256').update(served).digest('hex');
    const distSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(import.meta.dirname, '../../apps/web/dist/chat-app.js'))).digest('hex');
    assert.equal(servedSha, distSha, '静态 handler 必须交付重建后的产物（修复前 SHA=452334d6…）');
    const body = served.toString('utf8');
    for (const marker of ['setMuted', 'voice_interrupt', 'interrupted', 'playback_drained']) {
      assert.ok(body.includes(marker), `产物缺少修复标记 ${marker}`);
    }
    console.log(JSON.stringify({ case: 'r01_static_bundle', sha256: servedSha.slice(0, 16) + '…', markers: ['setMuted', 'voice_interrupt', 'interrupted', 'playback_drained'] }));
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('P04 模式分流：普通电话 0 自动 oído；深听模式才走快观察', async () => {
  const stub = await startSirenStub();
  process.env.ESTOMAGO_SIREN_BASE_URL = stub.url;
  const c = compose(tempRoot('p04-mode-'), quietTransport, stub.url);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    const inv = await c.tools.execute('call_control', { action: 'invite' }, ctx());
    const inviteId = (inv.output as Record<string, unknown>)['invite_id'] as string;
    const a1 = await c.call(`/api/v1/calls/invites/${encodeURIComponent(inviteId)}/accept`, 'POST');
    const callId = a1.body['call_id'] as string;
    // 新通话默认 ordinary（未显式选择深听）
    assert.equal((c.db.prepare('SELECT analysis_mode FROM voice_calls WHERE call_id=?').get(callId) as { analysis_mode: string }).analysis_mode, 'ordinary');
    // 深听入口：POST /api/v1/calls 显式 deep_listen
    const dl = await c.call('/api/v1/calls', 'POST', { conversation_id: 'primary', analysis_mode: 'deep_listen' });
    assert.equal((c.db.prepare('SELECT analysis_mode FROM voice_calls WHERE call_id=?').get(dl.body['call_id']) as { analysis_mode: string }).analysis_mode, 'deep_listen');
    // dial 方向：dial POST 带 mode → accept_call 沿用
    await c.call(`/api/v1/calls/${encodeURIComponent(callId)}`, 'DELETE');
    const dd = await c.call('/api/v1/calls/dial', 'POST', { analysis_mode: 'deep_listen' });
    assert.equal(dd.body['state'], 'pending');
    const acc = await c.tools.execute('call_control', { action: 'accept_call' }, ctx());
    assert.equal(acc.ok, true, JSON.stringify(acc.output));
    const dialCall = (acc.output as Record<string, unknown>)['call_id'] as string;
    assert.equal((c.db.prepare('SELECT analysis_mode FROM voice_calls WHERE call_id=?').get(dialCall) as { analysis_mode: string }).analysis_mode, 'deep_listen', '她发起的深听 dial 被沿用');
    console.log(JSON.stringify({ case: 'p04_analysis_mode', invite_call: 'ordinary', manual_call: 'deep_listen', dial_honors_mode: true }));
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});

test('F01 归档正文投影：空正文语音消息的 Source 正文=转写快照，hash 重算，assets 带引用', async () => {
  const stub = await startSirenStub();
  process.env.ESTOMAGO_SIREN_BASE_URL = stub.url;
  const c = compose(tempRoot('f01-archive-'), quietTransport, stub.url);
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    // 构造一条真实语音消息：正文空 + 附件带转写快照（真实公开入口 submitUserMessageWithTurn）
    // 附件转写按产品路径来自 voice_transcripts（按资产 hash 匹配；客户端 derived_text 被有意忽略）
    const voiceSha = crypto.createHash('sha256').update('wav-bytes-f01').digest('hex');
    c.db.prepare("INSERT INTO media_assets(id,creation_operation_id,state,mime_type,byte_size,content_sha256,storage_key,origin,created_by,ingest_purpose,created_at,updated_at) VALUES ('ast_voice_1','test:f01:asset','available','audio/wav',12,?,'test/f01.wav','import','test','chat_voice',?,?)").run(voiceSha, new Date().toISOString(), new Date().toISOString());
    c.db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,derived_source,duration_ms,created_at,updated_at) VALUES ('ast_voice_1','primary','test:f01',?,'ready','这段是我说的话。','siren:transcribe',NULL,?,?)").run(voiceSha, new Date().toISOString(), new Date().toISOString());
    const sub = c.messages.submitUserMessageWithTurn({
      conversationId: 'primary', content: '', clientMessageId: 'voice-1',
      attachments: [{ asset_id: 'ast_voice_1', presentation: 'voice' as never, derived_text: '这段是我说的话。', derived_source: 'siren:transcribe' } as never],
    });
    c.supervisor.enqueue(sub.turnId);
    await c.supervisor.waitIdle();
    // 直接驱动真实 ArchiveSyncService 的批量构造路径（capture transport 记录出站）
    const sent: Array<{ capability: string; payload: Record<string, unknown> }> = [];
    const { MariposaClient } = await import('../../apps/host/src/integrations/mariposa/client.ts');
    const { ArchiveSyncService } = await import('../../apps/host/src/integrations/mariposa/archive-sync.ts');
    const { EventService } = await import('../../apps/host/src/events/service.ts');
    const { Logger } = await import('../../apps/host/src/observability/logging.ts');
    const os = await import('node:os');
    const { default: fsp } = await import('node:fs');
    const logDir = fsp.mkdtempSync(`${os.tmpdir()}/f01-logs-`);
    const client = new MariposaClient({ transport: async (capability: string, payload: Record<string, unknown>) => { sent.push({ capability, payload }); return { ok: true, result: {} }; } });

    const archiveConfig = buildConfig({ ...readyRuntimePatch(), archive: { enabled: true, continuous_grant_ref: null, source_scope: null, semantic_auto_binding_threshold: null, semantic_auto_binding_enabled: false }, integrations: { mariposa: { base_url: 'http://127.0.0.1:1', credential_ref: null, archive_credential_ref: null, contract_version: null }, siren: { base_url: null, credential_ref: null, archive_credential_ref: null, contract_version: null }, oido: { base_url: null, credential_ref: null, archive_credential_ref: null, contract_version: null }, superposition: { base_url: null, credential_ref: null, archive_credential_ref: null, contract_version: null }, zashidele: { base_url: null, credential_ref: null, archive_credential_ref: null, contract_version: null } } }) as never;
    const sync = new ArchiveSyncService({ db: c.db, events: new EventService(c.db), logger: new Logger(logDir), client, config: archiveConfig });
    await sync.drainOnce();
    const ingest = sent.flatMap((x) => (x.payload['messages'] as Array<Record<string, unknown>>) ?? []);
    const voice = ingest.find((m) => m['origin_message_id'] === sub.message.id) as Record<string, unknown> | undefined;
    assert.ok(voice, '语音消息进入 Source 归档');
    assert.equal(voice['text'], '这段是我说的话。', 'Source 正文=转写快照（非空）');
    assert.equal(voice['content_hash'], crypto.createHash('sha256').update('这段是我说的话。').digest('hex'), 'hash 按投影文本重算（非空 content 的 hash）');
    assert.deepEqual(voice['assets'], ['est:ast_voice_1'], '稳定资产引用随归档');
    console.log(JSON.stringify({ case: 'f01_archive_projection', text: voice['text'], assets: voice['assets'] }));
  } finally { await c.supervisor.stopAll(); c.close(); stub.stop(); }
});
