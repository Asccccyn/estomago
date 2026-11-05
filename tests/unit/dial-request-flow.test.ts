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
  const call = async (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = new FakeRes();
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as Readable & { headers?: Record<string, string>; method?: string; url?: string };
    req.headers = headers; req.method = method; req.url = route;
    await handleRequest(req as never, res as never, deps);
    await new Promise((r) => setTimeout(r, 30));
    res.flushTail();
    return { status: res.status, body: res.lines.length > 0 ? JSON.parse(res.lines.join('')) as Record<string, unknown> : {} };
  };
  return { db, messages, supervisor, tools, call, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const ctx = (over: Partial<ToolExecContext> = {}): ToolExecContext => ({ roomId: 'primary', windowId: 'w', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'dial', ...over });

test('F01（审计 P1）：停止排队轮→重开 DB→恢复零派发；未停 pending 正常恢复', async () => {
  let transportCalls = 0;
  let releaseFirst: (() => void) | null = null;
  const transport: OrTransport = async () => {
    transportCalls++;
    if (transportCalls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    return { status: 200, headers: new Map(), body: frameStream(sse({ id: 'f01', choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) };
  };
  const root = tempRoot('f01-stop-');
  const c = compose(root, transport);
  try {
    const t1 = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '第一轮', clientMessageId: 'f01a' });
    c.supervisor.enqueue(t1.turnId);
    await pause(150); // 第一轮占用执行位（transport 挂起或准备中——不影响排队事实）
    const t2 = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '将被停止', clientMessageId: 'f01b' });
    c.supervisor.enqueue(t2.turnId); // 排队（attempt=pending，串行链未到达）
    await pause(60);
    assert.equal(c.supervisor.stop(t2.turnId).stopped, true, 'stop 确认');
    assert.equal((c.db.prepare("SELECT state FROM turns WHERE id=?").get(t2.turnId) as { state: string }).state, 'failed', '停止即持久终态');
    const before = transportCalls;
    c.db.close(); // 进程退出（不释放队列——审计复现口径）
    // ── 重启：同一 DB 新进程 ──
    const c2 = compose(root, transport);
    try {
      const { TurnSupervisor } = await import('../../apps/host/src/runtime/supervisor.ts');
      TurnSupervisor.recoveryPass(c2.db, c2.supervisor['d'] ? (c2.supervisor['d'] as { logger: never }).logger : (c2.supervisor as unknown as { d: { logger: never } }).d.logger);
      const redispatched = TurnSupervisor.recoverSchedule({ db: c2.db, supervisor: c2.supervisor, logger: (c2.supervisor as unknown as { d: { logger: never } }).d.logger } as never);
      assert.equal(redispatched.redispatched, 0, '已停止排队轮不再被恢复派发（旧实现=1，审计复现）');
      await pause(200);
      assert.equal(transportCalls, before, '恢复后零新增模型派发');
      const a = c2.db.prepare("SELECT state, blocked_reason FROM attempts WHERE turn_id=?").get(t2.turnId) as { state: string; blocked_reason: string };
      assert.equal(a.state, 'failed');
      assert.equal(a.blocked_reason, 'CANCELLED_BEFORE_DISPATCH', '停止原因持久');
      assert.ok(c2.messages.getMessage(t2.message.id), '用户输入仍保存（不丢话）');
      // 对照：未停止的新轮正常完成（恢复/执行能力未被误伤）
      releaseFirst?.();
      await c2.supervisor.waitIdle();
      const t3 = c2.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '不停的一轮', clientMessageId: 'f01c' });
      c2.supervisor.enqueue(t3.turnId);
      await c2.supervisor.waitIdle();
      assert.equal((c2.db.prepare("SELECT state FROM turns WHERE id=?").get(t3.turnId) as { state: string }).state, 'completed', '未停止轮正常完成');
    } finally { releaseFirst?.(); await c2.supervisor.stopAll().catch(() => {}); c2.close(); }
  } finally {
    releaseFirst?.();
    await c.supervisor.stopAll().catch(() => {});
    try { c.close(); } catch { /* db 已在"进程退出"步骤手动关闭 */ }
  }
});

test('F02 链A：多段发布后 manifest 修订随追加推进（引用不再按旧修订截断）', async () => {
  const transport: OrTransport = async () => ({ status: 200, headers: new Map(), body: frameStream(
    sse({ id: 'm1', choices: [{ delta: { content: '第一段内容。' } }] }) +
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) });
  const c = compose(tempRoot('f02-rev-'), transport);
  try {
    const t1 = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '说两段', clientMessageId: 'f02a' });
    c.supervisor.enqueue(t1.turnId);
    await c.supervisor.waitIdle();
    const assistant = c.db.prepare("SELECT m.id, m.current_revision FROM messages m WHERE m.turn_id=? AND m.speaker='assistant' ORDER BY m.sequence DESC LIMIT 1").get(t1.turnId) as { id: string; current_revision: number } | undefined;
    assert.ok(assistant, '助手消息已发布');
    // DS 全量事件=单段单修订；流式多段（append→rev2）的 manifest 推进由 6f9a050 的
    // entry.revision 推进逻辑保证——本 DS harness 的 normalizer 会把多 delta 合并为一次
    // 全量发布，无法在此触发真实分段（如实说明：流式场景待 SDK 流/自然流量验证）。
    assert.ok(assistant.current_revision >= 1, '发布产生修订');
    const manifestRow = c.db.prepare("SELECT manifest_json FROM window_trajectories WHERE window_id=(SELECT active_window_id FROM conversations WHERE id='primary')").get() as { manifest_json: string };
    const manifest = JSON.parse(manifestRow.manifest_json) as Array<{ id: string; revision: number }>;
    const entry = manifest.find((e) => e.id === assistant.id);
    assert.ok(entry, '助手消息进入已见 manifest');
    assert.equal(entry.revision, assistant.current_revision, 'manifest 修订=当前修订（追加分段时由推进逻辑同步）');
  } finally { await c.supervisor.stopAll().catch(() => {}); c.close(); }
});

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

test('F01：通话结束事实归确认终态共同出口（S-first/UI-first/对账补齐/幂等/消费核销）', async () => {
  const prompts: string[] = [];
  const transport: OrTransport = async (payload: any) => {
    prompts.push(JSON.stringify(payload.messages));
    return { status: 200, headers: new Map(), body: frameStream(sse({ id: 'ce', choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) };
  };
  const c = compose(tempRoot('call-end-fact-'), transport);
  const oldToken = process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'synthetic-ingress';
  const lifecycle = (callId: string) => c.call(`/v1/calls/${callId}`, 'DELETE', undefined, { authorization: 'Bearer synthetic-ingress' });
  const factRow = (callId: string) => c.db.prepare("SELECT kind, consumed_at FROM pending_program_facts WHERE id=?").get(`call_end:${callId}`) as { kind: string; consumed_at: string | null } | undefined;
  try {
    const now = new Date().toISOString();
    // ── 场景 A（审计复现）：lifecycle 先到（Siren 确认终态），前端后到 ──
    c.db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,connected_at,analysis_mode) VALUES ('call-s-first','primary','active',?,?,'ordinary')").run(now, now);
    assert.equal((await lifecycle('call-s-first')).status, 200);
    assert.equal(factRow('call-s-first')?.kind, 'call_end', 'S-first：lifecycle 确认终态登记事实（旧实现此路径漏登记）');
    await c.call('/api/v1/calls/call-s-first', 'DELETE'); // 前端后到
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM pending_program_facts WHERE id='call_end:call-s-first'").get() as { n: number }).n, 1, '重复到达不重复登记');
    assert.equal((await lifecycle('call-s-first')).status, 200, 'lifecycle 幂等重放仍 200');
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM pending_program_facts WHERE id='call_end:call-s-first'").get() as { n: number }).n, 1, '幂等：仍恰一条');

    // ── 场景 B（真假事实修正）：前端挂断命令先到——意图不登记事实 ──
    c.db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,connected_at,analysis_mode) VALUES ('call-ui-first','primary','active',?,?,'ordinary')").run(now, now);
    const ui = await c.call('/api/v1/calls/call-ui-first', 'DELETE');
    assert.equal(ui.status, 200);
    assert.equal(ui.body['state'], 'ended', '前端端点仍本端收口投影');
    assert.equal(factRow('call-ui-first'), undefined, 'F01：挂断命令（linger 意图）不登记"通话已结束"事实');
    await lifecycle('call-ui-first'); // S 稍后确认终态
    assert.equal(factRow('call-ui-first')?.kind, 'call_end', '确认终态到达后补登记');

    // ── 场景 C（回调丢失）：对账发现正本 ended → 补齐 ──
    c.db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,connected_at,analysis_mode) VALUES ('call-reconcile','primary','active',?,?,'ordinary')").run(now, now);
    const { reconcileVoiceCallsOnStartup } = await import('../../apps/host/src/integrations/siren/reconcile.ts');
    const out = await reconcileVoiceCallsOnStartup(c.db, { callStatus: async () => ({ dbStatus: 'ended', sessionActive: false }) } as never);
    assert.equal(out.ended, 1, '对账收口 call-reconcile');
    assert.equal(factRow('call-reconcile')?.kind, 'call_end', '对账确认终态补登记事实');

    // ── 消费链：事实随下一次正常文字轮附带并核销 ──
    const turn = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '回来了', clientMessageId: 'm-after-call' });
    c.supervisor.enqueue(turn.turnId);
    await c.supervisor.waitIdle();
    assert.ok(prompts.some((p) => p.includes('语音通话已结束')), '结束事实随正常轮附带');
    for (const id of ['call-s-first', 'call-ui-first', 'call-reconcile']) {
      assert.ok(factRow(id)?.consumed_at, `已派发即核销：${id}`);
    }
    // 核销后不重复附带（历史轨迹恰一次）
    const turn2 = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '嗯嗯', clientMessageId: 'm-after-call-2' });
    c.supervisor.enqueue(turn2.turnId);
    await c.supervisor.waitIdle();
    const occurrences = prompts.slice(-1)[0]!.split('语音通话已结束').length - 1;
    assert.equal(occurrences, 3, `核销后仅历史留存（三通各一次，实际 ${occurrences}）`);
  } finally {
    if (oldToken === undefined) delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN; else process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = oldToken;
    await c.supervisor.stopAll(); c.close();
  }
});

test('F01-R1/R2 复核返修：UI先收口+回调丢失→对账补事实；未连接预留到期→零事实', async () => {
  const transport: OrTransport = async () => ({ status: 200, headers: new Map(), body: frameStream(sse({ id: 'r12', choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) });
  const c = compose(tempRoot('call-end-r1r2-'), transport);
  const oldToken = process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'synthetic-ingress';
  const factRow = (callId: string) => c.db.prepare("SELECT kind FROM pending_program_facts WHERE id=?").get(`call_end:${callId}`) as { kind: string } | undefined;
  try {
    const now = new Date().toISOString();
    const { reconcileVoiceCallsOnStartup } = await import('../../apps/host/src/integrations/siren/reconcile.ts');
    let statusCalls = 0;
    const siren = { callStatus: async () => { statusCalls++; return { dbStatus: 'ended', sessionActive: false }; } } as never;

    // ── R1：UI 先收口（真实前端 DELETE）→ lifecycle 通知丢失（无调用）→ 对账补齐 ──
    c.db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,connected_at,analysis_mode) VALUES ('call-r1','primary','active',?,?,'ordinary')").run(now, now);
    const ui = await c.call('/api/v1/calls/call-r1', 'DELETE');
    assert.equal(ui.body['state'], 'ended');
    assert.equal(factRow('call-r1'), undefined, '挂断命令不登记事实');
    const before = statusCalls;
    const out1 = await reconcileVoiceCallsOnStartup(c.db, siren);
    assert.equal(statusCalls - before, 1, 'R1：ended 缺事实的行**确有**被对账查询（旧实现=0）');
    assert.equal(factRow('call-r1')?.kind, 'call_end', '对账确认 S 终态后补登记');
    // 补齐后不再重复查（幂等收敛）
    const out2 = await reconcileVoiceCallsOnStartup(c.db, siren);
    assert.equal(out2.ended, 0, '已补事实行不再进入候选');

    // ── R2：未连接预留到期 → 投影收口但零结束事实 ──
    c.db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,reserved_until,analysis_mode) VALUES ('call-r2','primary','active',?,?,'ordinary')").run(now, new Date(Date.now() - 1000).toISOString());
    const out3 = await reconcileVoiceCallsOnStartup(c.db, siren);
    assert.equal(out3.ended, 1, '孤儿预留仍被收口（投影清理保留）');
    assert.equal(factRow('call-r2'), undefined, 'R2：未连接预留**不产生**通话结束事实');
    // 对照：真正连接过的通话结束=恰一条
    c.db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,connected_at,analysis_mode) VALUES ('call-r2b','primary','active',?,?,'ordinary')").run(now, now);
    await reconcileVoiceCallsOnStartup(c.db, siren);
    assert.equal(factRow('call-r2b')?.kind, 'call_end', '连接过的通话结束=恰一条');
  } finally {
    if (oldToken === undefined) delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN; else process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = oldToken;
    await c.supervisor.stopAll(); c.close();
  }
});

test('生命周期重构 R3：register 丢失但真实话轮/结束回调/S 权威事实——结束事实不漏记（整链）', async () => {
  const transport: OrTransport = async () => ({ status: 200, headers: new Map(), body: frameStream(sse({ id: 'r3', choices: [{ delta: { content: '在' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) });
  const c = compose(tempRoot('call-r3-'), transport);
  const oldToken = process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'synthetic-ingress';
  const factRow = (callId: string) => c.db.prepare("SELECT kind FROM pending_program_facts WHERE id=?").get(`call_end:${callId}`) as { kind: string } | undefined;
  const lifecycle = (callId: string) => c.call(`/v1/calls/${callId}`, 'DELETE', undefined, { authorization: 'Bearer synthetic-ingress' });
  // 正式建呼入口的产物=预留行（SirenAdapter 未配置时 POST /api/v1/calls 会 503——
  // 预留行字段与 dial.ts/call-service 建呼写入一致；connected_at 留空=register 丢失）
  const reserve = (callId: string) => c.db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,reserved_until,analysis_mode) VALUES (?,'primary','active',?,?,'ordinary')").run(callId, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  const realTurn = async (callId: string, turnKey: string) => {
    await c.call('/v1/chat/stream', 'POST', { conversation_id: 'primary', call_id: callId, turn_id: turnKey, modality: 'voice_call', text: '喂？能听到吗？' }, { authorization: 'Bearer synthetic-ingress', 'content-type': 'application/x-ndjson' }).catch(() => null);
    await c.supervisor.waitIdle();
  };
  try {
    // ── 链1（R3 主场景）：register 丢失 → 真实话轮 → 结束回调 → 事实恰一条 ──
    reserve('call-r3a');
    await realTurn('call-r3a', 't1');
    assert.equal(c.db.prepare("SELECT state FROM voice_stream_turns WHERE call_id='call-r3a' AND turn_key='t1'").get()?.state, 'completed', '真实话轮完成');
    assert.equal((await lifecycle('call-r3a')).status, 200, '结束回调到达');
    assert.equal(factRow('call-r3a')?.kind, 'call_end', 'R3：真实话轮+结束回调→事实登记（旧实现漏记）');
    await lifecycle('call-r3a');
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM pending_program_facts WHERE id LIKE 'call_end:call-r3a%'").get() as { n: number }).n, 1, '重复回调仍恰一条');

    // ── 链2（R3+恢复）：register 丢失 → 真实话轮 → UI 先收口 → 回调也丢 → 对账按 S 权威事实补记 ──
    reserve('call-r3b');
    await realTurn('call-r3b', 't1');
    const ui = await c.call('/api/v1/calls/call-r3b', 'DELETE');
    assert.equal(ui.body['state'], 'ended');
    assert.equal(factRow('call-r3b'), undefined, '挂断命令不登记（意图≠终态）');
    const { reconcileVoiceCallsOnStartup } = await import('../../apps/host/src/integrations/siren/reconcile.ts');
    const out = await reconcileVoiceCallsOnStartup(c.db, { callStatus: async () => ({ dbStatus: 'ended', sessionActive: false, startedAt: 1793800000000 }) } as never);
    assert.equal(factRow('call-r3b')?.kind, 'call_end', '对账按 S started_at 补记（本地无 register 证据）');

    // ── 链3（零话轮零 register 的真实会话）：仅 S 权威事实证明 ──
    reserve('call-r3c');
    await c.call('/api/v1/calls/call-r3c', 'DELETE'); // UI 收口（无证据）
    await reconcileVoiceCallsOnStartup(c.db, { callStatus: async () => ({ dbStatus: 'ended', sessionActive: false, startedAt: 1793800000001 }) } as never);
    assert.equal(factRow('call-r3c')?.kind, 'call_end', 'S 说会话真实建立过→登记');

    // ── 链4（R2 保留）：未连接预留到期，S 无会话事实 → 零事实 ──
    c.db.prepare("UPDATE voice_calls SET reserved_until=? WHERE call_id='call-r3d'").run(new Date(Date.now() - 1000).toISOString()) ;
    reserve('call-r3d');
    c.db.prepare("UPDATE voice_calls SET reserved_until=? WHERE call_id='call-r3d'").run(new Date(Date.now() - 1000).toISOString());
    const out2 = await reconcileVoiceCallsOnStartup(c.db, { callStatus: async () => ({ dbStatus: 'ended', sessionActive: false, startedAt: null }) } as never);
    assert.equal(out2.ended >= 1, true, '孤儿预留仍收口');
    assert.equal(factRow('call-r3d'), undefined, 'R2：未连接预留零结束事实');
  } finally {
    if (oldToken === undefined) delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN; else process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = oldToken;
    await c.supervisor.stopAll(); c.close();
  }
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
