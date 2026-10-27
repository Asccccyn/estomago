// 邀请终态与轮次账（联合审计 A08 / B5，2026-10-27 执行口径）：
// ①她拒接：事实保留在 Siren 正本与 call_control 查询面，est 不新增独立付费反应轮；
// ②模型取消邀请：工具回执即事实，原续轮自主回应，不追加强制说明 program_fact 轮；
// ③串行：程序事实轮与文字轮共用唯一串行链（incoming_dial/留言机会轮的既有入口性质不变）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
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
import {writeApprovedIdentity, readyRuntimePatch, tempRoot, assembleTestTools } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sirenTransport(log: Array<{ url: string; method: string }>, inviteState: { state: string }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); const m = init?.method ?? 'GET';
    log.push({ url: u, method: m });
    if (u.includes('/decline')) { inviteState.state = 'declined'; return Response.json({ invite_id: 'inv-1', state: 'declined', changed: true }); }
    if (u.includes('/cancel')) { inviteState.state = 'cancelled'; return Response.json({ invite_id: 'inv-1', state: 'cancelled', changed: true }); }
    if (u.includes('/invites') && m === 'POST') return Response.json({ invite_id: 'inv-1', state: 'pending', expires_at: Date.now() + 45000 }, { status: 201 });
    if (u.includes('/invites')) {
      return Response.json({
        active: inviteState.state === 'pending' ? { invite_id: 'inv-1', state: 'pending', expires_at: 1 } : null,
        // 终态事实保留在正本查询面（recent）——拒接/取消事实不丢，后续合法轮次按需消费
        recent: inviteState.state === 'pending' ? [] : [{ invite_id: 'inv-1', state: inviteState.state, expires_at: 1, created_at: 1 }],
      });
    }
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
}

function compose(root: string, transport: OrTransport, siren: typeof fetch, inviteState: { state: string }) {
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
  const sirenCall = new SirenAdapter('http://127.0.0.1:1', 't', siren);
  // B5：voice 模块不再持有 ProgramFactsPort（拒接/取消无附加轮）；装配保持向后兼容入参
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages: messages, sirenCall: sirenCall, programFacts: null });
  const trajectory = new WindowTrajectoryService(db);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new DeepSeekRunner({ retryMax: 0 }, transport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory });
  return { db, config, messages, supervisor, tools, sirenCall, inviteState, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('R02：她拒接——事实留正本可查，无独立付费反应轮、不伪造她的消息', async () => {
  const prompts: string[] = [];
  const transport: OrTransport = async (p) => { prompts.push(JSON.stringify(p.messages)); return { status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '在' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) }; };
  const inviteState = { state: 'pending' };
  const sirenLog: Array<{ url: string; method: string }> = [];
  const ctx = compose(tempRoot('ir-decline-'), transport, sirenTransport(sirenLog, inviteState), inviteState);
  try {
    const first = ctx.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在吗', clientMessageId: 'm0' });
    ctx.supervisor.enqueue(first.turnId);
    await ctx.supervisor.waitIdle();
    const modelRoundsBefore = prompts.length;
    const ownerBefore = (ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='owner'").get() as { n: number }).n;

    // 她拒接（est 代理同链：transitionInvite → Siren declined）
    const out = await ctx.sirenCall.transitionInvite('inv-1', 'decline');
    assert.equal(out?.['state'], 'declined');
    await ctx.supervisor.waitIdle();
    await pause(80);
    // B5：拒接不新增独立付费反应轮——没有 program_fact 轮、没有新模型请求
    assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM turns WHERE trigger='program_fact'").get() as { n: number }).n, 0, '拒接不触发程序事实轮');
    assert.equal(prompts.length, modelRoundsBefore, '拒接不新增模型请求');
    const ownerAfter = (ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='owner'").get() as { n: number }).n;
    assert.equal(ownerAfter, ownerBefore, '拒接不伪造她的消息');
    // 拒接事实不丢：Siren 正本查询面（call_control status 走同一 listInvites）可见
    const status = await ctx.sirenCall.listInvites('primary');
    const declined = (status?.recent ?? []).find((r) => r['invite_id'] === 'inv-1');
    assert.ok(declined && declined['state'] === 'declined', '拒接终态保留在查询面');
    console.log(JSON.stringify({ case: 'r02_declined_no_reaction_round' }));
  } finally { await ctx.supervisor.stopAll(); ctx.close(); }
});

test('R03：模型取消邀请——工具回执即事实，原续轮自主回应，无强制说明轮', async () => {
  const prompts: string[] = [];
  const transport: OrTransport = async (p) => { prompts.push(JSON.stringify(p.messages)); return { status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '刚那通是我拨错时间了，晚上再打给你。' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + DONE) }; };
  const inviteState = { state: 'pending' };
  const ctx = compose(tempRoot('ir-cancel-'), transport, sirenTransport([], inviteState), inviteState);
  try {
    const first = ctx.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '嗯', clientMessageId: 'm0' });
    ctx.supervisor.enqueue(first.turnId);
    await ctx.supervisor.waitIdle();
    const tctx: ToolExecContext = { roomId: 'primary', windowId: 'w', turnId: 't-1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'ir' };
    const out = await ctx.tools.execute('call_control', { action: 'cancel' }, tctx);
    assert.equal(out.ok, true, JSON.stringify(out.output));
    await ctx.supervisor.waitIdle();
    await pause(80);
    // B5：取消不追加 program_fact 轮（工具回执本身即事实——真实续轮的注入由 runner 工具循环
    // 既有机制完成，不经第二个事实轮）
    assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM turns WHERE trigger='program_fact'").get() as { n: number }).n, 0, '取消无独立说明事实轮');
    // 回执只报真实阶段，不再强迫"说一两句并说明原因或改约"
    const note = String((out.output as Record<string, unknown>)['note'] ?? '');
    assert.ok(note.includes('已取消'), '取消回执真实');
    assert.doesNotMatch(note, /说一两句|说明原因/);
    console.log(JSON.stringify({ case: 'r03_cancelled_no_forced_round' }));
  } finally { await ctx.supervisor.stopAll(); ctx.close(); }
});

test('串行：程序事实轮与文字轮共用唯一串行链，不并发第二个模型请求', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let active = 0; let maxActive = 0;
  const transport: OrTransport = async () => { active += 1; maxActive = Math.max(maxActive, active); await gate.catch(() => {}); active -= 1; return { status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '回' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) }; };
  const inviteState = { state: 'pending' };
  const ctx = compose(tempRoot('ir-serial-'), transport, sirenTransport([], inviteState), inviteState);
  try {
    const first = ctx.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '占链', clientMessageId: 'm0' });
    ctx.supervisor.enqueue(first.turnId);
    await pause(120); // 文字轮进入模型（占住串行链）
    // incoming_dial（她来电通知）沿用既有事实轮入口：排队不并发
    const r = ctx.supervisor.submitProgramFactTurn('primary', 'incoming_dial', '她刚刚发起语音通话请求（等你接听）。', 'dial:dial-x');
    assert.equal('turnId' in r, true);
    await pause(120);
    assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM turns WHERE trigger='program_fact' AND state='pending'").get() as { n: number }).n, 1, '事实轮在链上等待');
    release();
    await ctx.supervisor.waitIdle();
    assert.equal(maxActive, 1, '任一时刻至多一个模型请求');
  } finally { release?.(); await ctx.supervisor.stopAll(); ctx.close(); }
});
