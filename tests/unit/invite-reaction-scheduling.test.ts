// 拒接/取消留言调度（2026-10-24，她拆分两种）：
// ①她拒接（est 代理 decline 终态 declined）→ char程序事实反应轮——模型请求 prompt 含
//   [program_fact] 事实（含"拒接了"），回复正常发布落会话；不伪造她的消息（messages 无 owner 新行）。
// ②char取消（call_control cancel → Siren cancelled）→ 附带说话轮（事实含"取消了自己发起的来电"）。
// 幂等：同 dedupe_key 重复触发不建第二轮；串行：文字轮占链时事实轮排队不并发。
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
    if (u.includes('/invites')) return Response.json({ active: inviteState.state === 'pending' ? { invite_id: 'inv-1', state: 'pending', expires_at: 1 } : null, recent: [] });
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
  // voice 模块 ProgramFactsPort 绑定真实 Supervisor（call_control cancel → 程序事实）；
  // supervisor 尚未构造——经惰性绑定（构造完成后赋值）
  let supervisorRef: { submitProgramFactTurn(conversationId: string, kind: string, factText: string, dedupeKey: string): unknown } | null = null;
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages: messages, sirenCall: sirenCall, programFacts: { submitProgramFactTurn: (...a: Parameters<{ submitProgramFactTurn(conversationId: string, kind: string, factText: string, dedupeKey: string): unknown }>) => supervisorRef!.submitProgramFactTurn(...a) } });
  const trajectory = new WindowTrajectoryService(db);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new DeepSeekRunner({ retryMax: 0 }, transport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory });
  supervisorRef = supervisor;
  return { db, config, messages, supervisor, tools, sirenCall, inviteState, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('①她拒接 → est 代理触发char反应轮：prompt 含 [program_fact] 拒接事实，回复落会话，不伪造她的消息', async () => {
  const prompts: string[] = [];
  const transport: OrTransport = async (p) => { prompts.push(JSON.stringify(p.messages)); return { status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '好，你先忙。' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + DONE) }; };
  const inviteState = { state: 'pending' };
  const ctx = compose(tempRoot('ir-decline-'), transport, sirenTransport([], inviteState), inviteState);
  try {
    // 先建立窗口轨迹（首条消息）
    const first = ctx.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在吗', clientMessageId: 'm0' });
    ctx.supervisor.enqueue(first.turnId);
    await ctx.supervisor.waitIdle();
    const ownerBefore = (ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='owner'").get() as { n: number }).n;

    // 她拒接（走 est 代理 → Siren declined → 反应轮）
    const out = await ctx.sirenCall.transitionInvite('inv-1', 'decline');
    assert.equal(out?.['state'], 'declined');
    // 手动执行与代理相同的触发（代理端点在 http 层；此处直接调同 API 验证核心链）
    const r = ctx.supervisor.submitProgramFactTurn('primary', 'invite_declined', '她于 12:00 拒接了你发起的来电（邀请未接通，这是她自己的选择，不是故障）。你可以自然地说一两句话落在本会话。', 'invite:inv-1:declined');
    assert.equal('turnId' in r, true);
    await ctx.supervisor.waitIdle();
    await pause(100);
    // 模型收到了事实（prompt 含 [program_fact]+拒接）
    const factPrompt = prompts.find((p) => p.includes('[program_fact]') && p.includes('拒接了你发起的来电'));
    assert.ok(factPrompt, '事实块必须进入模型请求');
    assert.ok((factPrompt ?? '').includes('不是用户发言'));
    // char回复落会话
    const reply = ctx.db.prepare("SELECT r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.speaker='assistant' ORDER BY m.sequence DESC LIMIT 1").get() as { content: string };
    assert.equal(reply.content, '好，你先忙。');
    // 不伪造她的消息
    const ownerAfter = (ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='owner'").get() as { n: number }).n;
    assert.equal(ownerAfter, ownerBefore, '拒接不得写她的消息');
    // 幂等
    const r2 = ctx.supervisor.submitProgramFactTurn('primary', 'invite_declined', 'x', 'invite:inv-1:declined');
    assert.deepEqual(r2, { deduplicated: true });
    const dispatches = (ctx.db.prepare("SELECT COUNT(*) n FROM turns WHERE trigger='program_fact'").get() as { n: number }).n;
    assert.equal(dispatches, 1);
    console.log(JSON.stringify({ case: 'ir_declined', reply: reply.content }));
  } finally { await ctx.supervisor.stopAll(); ctx.close(); }
});

test('②char取消（call_control cancel）→ Siren cancelled + 附带说话轮', async () => {
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
    await pause(100);
    const factPrompt = prompts.find((p) => p.includes('[program_fact]') && p.includes('取消了自己发起的来电'));
    assert.ok(factPrompt, '取消事实必须进入模型请求');
    const reply = ctx.db.prepare("SELECT r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.speaker='assistant' ORDER BY m.sequence DESC LIMIT 1").get() as { content: string };
    assert.ok(reply.content.includes('晚上再打'), '他说了改约的话');
    console.log(JSON.stringify({ case: 'ir_cancelled', reply: reply.content }));
  } finally { await ctx.supervisor.stopAll(); ctx.close(); }
});

test('串行：文字轮占链时事实轮排队，不并发第二个模型请求', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let active = 0; let maxActive = 0;
  const transport: OrTransport = async () => { active += 1; maxActive = Math.max(maxActive, active); await gate.catch(() => {}); active -= 1; return { status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '回' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) }; };
  const inviteState = { state: 'pending' };
  const ctx = compose(tempRoot('ir-serial-'), transport, sirenTransport([], inviteState), inviteState);
  try {
    const first = ctx.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '占链', clientMessageId: 'm0' });
    ctx.supervisor.enqueue(first.turnId);
    await pause(120); // 文字轮进入模型（占住串行链）
    const r = ctx.supervisor.submitProgramFactTurn('primary', 'invite_declined', '她拒接了你的来电。', 'invite:inv-9:declined');
    assert.equal('turnId' in r, true);
    await pause(120);
    assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM turns WHERE trigger='program_fact' AND state='pending'").get() as { n: number }).n, 1, '事实轮在链上等待');
    release();
    await ctx.supervisor.waitIdle();
    assert.equal(maxActive, 1, '任一时刻至多一个模型请求');
  } finally { release?.(); await ctx.supervisor.stopAll(); ctx.close(); }
});
