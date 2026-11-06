// P3（四仓合并审计 20261106，U05/T05）+ RB01（复审 20261106）：通话期间 Sol 自动浮现门控。
// - 通话话轮与通话活动期间（响铃 dial pending / 准备 / 已建立）的普通文字都不登记浮现作业
// - Sol 真正请求门在 preparePhase（augmentFor 装配路径同受门控）；最终装配准入 finalAdmit 同享通话门
// - 通话活动事实写入处（dial 响铃、S register、建呼）统一触发在途作业失效并中止在途 Sol 请求
// - 通话结束后新的非通话消息恢复正常登记（不补扫）
// 复审反例（sol-lifecycle.json）：active 期普通文字 Sol 1、dial pending 期 Sol 1、
// S register 不 abort preparing 作业——本文件按真实路由/服务入口验证为 0。
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
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { SurfacingRepository } from '../../apps/host/src/memory-surfacing/repository.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { handleDialRoutes } from '../../apps/host/src/server/routes/dial.ts';
import { handleVoiceCallLifecycle } from '../../apps/host/src/server/routes/voice-call.ts';

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

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-sol-gate-'));
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const events = new EventService(db);
  const repo = new SurfacingRepository(db);
  let solRequests = 0;
  // 真实 SolDecisionJudge 合同的最小桩：decide 计数并返回 none（合法终态，无网络）
  const sol = {
    cfg: { assistantDisplayName: null, userDisplayName: null },
    isConfigured: () => true,
    effectiveModel: () => 'sol-test',
    effectiveTemplate: () => 't',
    applyOverrides: () => {},
    decide: async () => { solRequests++; return { ok: true, decision: { decision: 'none', topic: null, basis: 'synthetic', plan: null }, usage: null, elapsed_ms: 1 }; },
  } as never;
  const svc = new SurfacingService(db, null as never, sol, {
    enabled: true, transport_overhead_text: '', policy_revision: 1, prompt_prepare_revision: 'e',
    delivery_deadline_ms: 3000, max_added_tokens_per_turn: 10, max_packet_bytes: 10, worker_concurrency: 2,
    recent_user_messages: 2, recent_window_bytes: 2048,
  } as never, null as never, events);
  const submit = (clientMessageId: string, content: string) => messages.submitUserMessageWithTurn({ conversationId: 'primary', content, clientMessageId });
  const register = (messageId: string, revision: number, sequence: number, content: string, occurredAt: string | null) =>
    svc.onUserMessageAccepted({ conversationId: 'primary', messageId, revision, sequence, content, contentHash: 'h', occurredAt });
  const openCall = (callId = 'c1') => db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at) VALUES (?,'primary','active',?)").run(callId, new Date().toISOString());
  const closeCall = (callId = 'c1') => db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id=?").run(new Date().toISOString(), callId);
  const deps = { db, config: buildConfig({}), surfacing: svc, supervisor: { submitProgramFactTurn: () => ({ turnId: 'ft' }) }, sirenCall: null, logger: { info() {}, warn() {}, error() {} } } as never;
  const http = async (handler: 'dial' | 'lifecycle', method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as Readable & { headers: Record<string, string>; method: string; url: string };
    req.headers = { 'content-type': 'application/json', ...headers }; req.method = method; req.url = url;
    const res = new FakeRes();
    await (handler === 'dial' ? handleDialRoutes : handleVoiceCallLifecycle)(req as never, res as never, deps, `${method} ${url}`);
    await new Promise((r) => setTimeout(r, 20));
    res.flushTail();
    return { status: res.status, body: res.lines.length > 0 ? JSON.parse(res.lines.join('')) as Record<string, unknown> : {} };
  };
  return { db, svc, repo, submit, register, openCall, closeCall, http, solRequests: () => solRequests, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('U05：通话话轮不登记浮现作业；非通话消息照常', () => {
  const f = fixture();
  try {
    const chat = f.submit('sol-gate-chat-1', '今天想起一件事');
    f.register(chat.message.id, 1, chat.message.sequence, '今天想起一件事', null);
    const n1 = (f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(chat.message.id) as { n: number }).n;
    assert.equal(n1, 1, '普通消息登记');
    const chat2 = f.submit('sol-gate-chat-2', '电话里说的话');
    f.db.prepare("UPDATE messages SET client_message_id='voice:c1:t2' WHERE id=?").run(chat2.message.id);
    f.register(chat2.message.id, 1, chat2.message.sequence, '电话里说的话', null);
    const n2 = (f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(chat2.message.id) as { n: number }).n;
    assert.equal(n2, 0, 'T05：通话话轮零登记');
  } finally { f.close(); }
});

test('RB01：已建立通话期间普通文字零登记零 Sol；挂断后下一条恢复', () => {
  const f = fixture();
  try {
    f.openCall();
    const chat = f.submit('sol-gate-active-1', '通话里发的普通文字');
    f.register(chat.message.id, 1, chat.message.sequence, '通话里发的普通文字', null);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs').get() as { n: number }).n, 0, 'active 通话期普通文字零登记（复审反例2：Sol 应 0）');
    f.closeCall();
    const chat2 = f.submit('sol-gate-after-1', '挂断后想起一件事');
    f.register(chat2.message.id, 1, chat2.message.sequence, '挂断后想起一件事', null);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(chat2.message.id) as { n: number }).n, 1, '结束后下一条新非通话消息恢复登记');
  } finally { f.close(); }
});

test('RB01：dial 响铃期（真实 POST /api/v1/calls/dial）普通文字零登记，且响铃取消在途作业', async () => {
  const f = fixture();
  try {
    const chat = f.submit('sol-gate-ring-1', '响铃前想起一件事');
    f.register(chat.message.id, 1, chat.message.sequence, '响铃前想起一件事', null);
    const dial = await f.http('dial', 'POST', '/api/v1/calls/dial', {});
    assert.equal(dial.status, 200);
    assert.equal(dial.body['state'], 'pending');
    const row = f.db.prepare('SELECT state, reason_code FROM surfacing_jobs WHERE source_message_id=?').get(chat.message.id) as { state: string; reason_code: string | null };
    assert.equal(row.state, 'cancelled', '响铃=通话活动开始：在途作业被取消（真实路由触发）');
    assert.equal(row.reason_code, 'CALL_ACTIVE');
    const chat2 = f.submit('sol-gate-ring-2', '响铃期间发的普通文字');
    f.register(chat2.message.id, 1, chat2.message.sequence, '响铃期间发的普通文字', null);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(chat2.message.id) as { n: number }).n, 0, 'pending 响铃期普通文字零登记（复审反例3）');
  } finally { f.close(); }
});

test('RB01：S register（真实 POST /v1/calls）取消 preparing 作业并中止在途；augmentFor 不绕过通话门', async () => {
  const f = fixture();
  const oldToken = process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'synthetic-ingress';
  try {
    const chat = f.submit('sol-gate-reg-1', '注册前想起一件事');
    f.register(chat.message.id, 1, chat.message.sequence, '注册前想起一件事', null);
    // 推到 preparing（模拟 Sol 已在途）：真实 register 触发取消
    f.repo.transition((f.db.prepare('SELECT id FROM surfacing_jobs WHERE source_message_id=?').get(chat.message.id) as { id: string }).id, ['pending'], 'preparing');
    const reg = await f.http('lifecycle', 'POST', '/v1/calls', { call_id: 'c-reg-1', conversation_id: 'primary' }, { authorization: 'Bearer synthetic-ingress' });
    assert.equal(reg.status, 200);
    const row = f.db.prepare('SELECT state, reason_code FROM surfacing_jobs WHERE source_message_id=?').get(chat.message.id) as { state: string; reason_code: string | null };
    assert.equal(row.state, 'cancelled', 'S register=活动事实写入：preparing 作业被取消（复审反例4）');
    assert.equal(row.reason_code, 'CALL_ACTIVE');
    // augmentFor 装配路径不绕过：通话活动期装配准入返回 null 且不发起 Sol
    const aug = await f.svc.augmentFor({ conversationId: 'primary', windowId: 'w1', turnId: 't1', attemptId: 'a1', message: { id: chat.message.id, revision: 1, sequence: chat.message.sequence, content: '注册前想起一件事', hash: 'h' } });
    assert.equal(aug, null, '通话活动期 augmentFor 零装配');
    assert.equal(f.solRequests(), 0, '全程零 Sol 请求（门在请求入口，不在调度层）');
  } finally {
    if (oldToken === undefined) delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN; else process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = oldToken;
    f.close();
  }
});

test('RB01：preparePhase 请求门——作业在通话开始前登记、drain 前通话变 active，worker 不发起 Sol', async () => {
  const f = fixture();
  try {
    const chat = f.submit('sol-gate-drain-1', '排程前想起一件事');
    f.register(chat.message.id, 1, chat.message.sequence, '排程前想起一件事', null);
    f.openCall('c-drain');
    await f.svc.start(); // start 会把 recoverable 收口并 scheduleWake→drain
    await new Promise((r) => setTimeout(r, 50));
    const row = f.db.prepare('SELECT state, reason_code FROM surfacing_jobs WHERE source_message_id=?').get(chat.message.id) as { state: string; reason_code: string | null };
    assert.ok(row.state === 'cancelled' || row.state === 'expired', '通话活动期作业不发起 Sol（取消或重启收口）');
    assert.equal(f.solRequests(), 0, '零 Sol 请求');
  } finally { await f.svc.stop().catch(() => {}); f.close(); }
});

// —— RB2-01（复审 20261106 第二轮）：活动事实的真实生产者与期限 ——

test('RB2-01：模型 invite 建立活动投影——响铃期 Sol 失效，接听/拒接收口镜像', async () => {
  const f = fixture();
  try {
    const { VoiceCallService } = await import('../../apps/host/src/modules/voice/call-service.ts');
    const siren = {
      status: 'available',
      createInvite: async () => ({ inviteId: 'inv_rb2_1', expiresAt: Date.now() + 45_000 }),
      listInvites: async () => ({ active: null, recent: [] }),
      cancelInvite: async () => ({ state: 'cancelled' }),
      requestHangup: async () => ({ accepted: true }),
      callTurnAudio: async () => null,
    };
    const calls = new VoiceCallService({ db: f.db, sirenCall: siren as never, surfacing: f.svc });
    const ctx = { roomId: 'primary', windowId: 'w', turnId: 't1', purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'rb2-invite' };
    // 先放一个在途 Sol 作业——invite 后必须失效（活动开始触发）
    const chat = f.submit('rb2-inv-pre', 'invite 前想起一件事');
    f.register(chat.message.id, 1, chat.message.sequence, 'invite 前想起一件事', null);
    const invited = await calls.control({ action: 'invite' }, ctx as never);
    assert.equal(invited.ok, true);
    const mirror = f.db.prepare("SELECT state FROM voice_invites WHERE invite_id='inv_rb2_1'").get() as { state: string };
    assert.equal(mirror.state, 'pending', 'S 邀请在 E 落忠实投影');
    const job = f.db.prepare('SELECT state, reason_code FROM surfacing_jobs WHERE source_message_id=?').get(chat.message.id) as { state: string; reason_code: string | null };
    assert.equal(job.state, 'cancelled', '模型 invite 响铃＝活动开始：在途 Sol 失效');
    assert.equal(job.reason_code, 'CALL_ACTIVE');
    // 响铃期间普通文字零登记（复审反例：E 无投影→Sol 1）
    const chat2 = f.submit('rb2-inv-during', '响铃期间普通文字');
    f.register(chat2.message.id, 1, chat2.message.sequence, '响铃期间普通文字', null);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(chat2.message.id) as { n: number }).n, 0, '模型 invite pending 期 Sol 0');
    // 镜像到期后（读时解释）恢复
    f.db.prepare('UPDATE voice_invites SET expires_at=? WHERE invite_id=?').run(Date.now() - 1000, 'inv_rb2_1');
    const chat3 = f.submit('rb2-inv-after', '邀请过期后的新文字');
    f.register(chat3.message.id, 1, chat3.message.sequence, '邀请过期后的新文字', null);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(chat3.message.id) as { n: number }).n, 1, '镜像到期（无前端轮询）后恢复');
  } finally { f.close(); }
});

test('RB2-01：用户 dial 自然到期不依赖前端轮询——到期后新文字恢复 Sol，过期 dial 不可再接听', async () => {
  const f = fixture();
  try {
    const dial = await f.http('dial', 'POST', '/api/v1/calls/dial', {});
    assert.equal(dial.status, 200);
    assert.equal(dial.body['state'], 'pending');
    // 时间边界推进 60 秒（等效复审的时钟前移）：回拨 created_at，不调用 GET /dial/current
    f.db.prepare("UPDATE dial_requests SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), dial.body['request_id']);
    const chat = f.submit('rb2-dial-expired', '过期未接听后的新文字');
    f.register(chat.message.id, 1, chat.message.sequence, '过期未接听后的新文字', null);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(chat.message.id) as { n: number }).n, 1, '复审反例：不轮询时过期 dial 不再永久抑制 Sol');
    const stillPending = f.db.prepare("SELECT state FROM dial_requests WHERE id=?").get(dial.body['request_id']) as { state: string };
    assert.equal(stillPending.state, 'pending', '行未落 expired（UI 惰性收口不变），活动事实按 TTL 读时解释');
    // 过期 dial 不可再接听（同一到期规则）
    const { VoiceCallService } = await import('../../apps/host/src/modules/voice/call-service.ts');
    const siren = { status: 'available', createCall: async () => ({ ok: true, callId: 'c_x', wsUrl: 'w', token: 't', expiresAt: null }) };
    const calls = new VoiceCallService({ db: f.db, sirenCall: siren as never });
    const ctx = { roomId: 'primary', windowId: 'w', turnId: 't1', purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'rb2-accept' };
    const accepted = await calls.control({ action: 'accept_call' }, ctx as never);
    assert.equal(accepted.ok, false, '过期请求不再是等待中');
    assert.equal((accepted as { error: { error_code: string } }).error.error_code, 'NO_PENDING_DIAL', 'accept 共用同一到期规则');
  } finally { f.close(); }
});
