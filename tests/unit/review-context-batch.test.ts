// 复审上下文批回归（2026-10-07）：
//  R10：准备阶段开始即可取消——bootstrap 挂起时 Stop 找得到句柄；取消后
//      迟到资料不再派发模型（复审反例：attempt=pending、模型请求 0、Stop
//      返回 stopped=false、房间链卡死在准备 await）
//  R11：B 不再静默截断（无 200 字符砍、I 超 2000 不砍），截断/续页元数据
//      如实披露；B=独立 system 数据块（A/B 显式缓存分界，systemMessageCount>=2）
//  ③：新窗必拉最新开窗包（不同窗口各自取数，不复用旧窗包）
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));
const T0 = '2026-10-07T09:00:00+08:00';

const LONG_TAIL = '这条计划标题很长很长很长很长很长很长很长很长很长尾巴标记XYZEND';
const I_FULL = 'I'.repeat(2500);

function bootPack(): Record<string, unknown> {
  return {
    snapshot_id: 'snap_t1', state_hash: 'h1', profile: 'estomago',
    memory_days: { items: [{ memory_id: '00001', memory_date: '2026-10-07', original_title: '天台看月亮', mood_tags: ['开心'] }], count: 1 },
    plans: { items: [{ plan_id: 'p1', title: LONG_TAIL, detail: 'x'.repeat(260) }], count: 1, total: 3, next_cursor: { plans_offset: 1 } },
    anniversaries: { items: [], count: 0 },
    i: { content: I_FULL, truncated: true, total_chars: 2500, next_cursor: { i_offset: 2000 } },
  };
}

function compose(root: string, transport: OrTransport, mariposa: MariposaTransport, log: Array<Record<string, unknown>>) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  const wrapped: OrTransport = async (payload) => {
    log.push({ kind: 'chat', full: payload.messages });
    return transport(payload);
  };
  const runner = new DeepSeekRunner({ retryMax: 0 }, wrapped);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, events };
}

test('R10：bootstrap 挂起时可 Stop；取消后迟到资料不再派发模型', async () => {
  const log: Array<Record<string, unknown>> = [];
  let releaseBootstrap: ((v: { ok: true; result: Record<string, unknown> }) => void) | null = null;
  const gate = new Promise<void>((res) => { releaseBootstrap = () => res(); });
  let gen = 0;
  const transport: OrTransport = async () => { gen++; return { status: 200, headers: new Map(), body: frameStream(textBody(`g${gen}`, `回${gen}`)) }; };
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'bootstrap.get') { await gate; return { ok: true, result: bootPack() }; }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const ctx = compose(tempRoot('r10-'), transport, mariposa, log);
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一句', clientMessageId: 'k1', occurredAt: T0 });
  ctx.supervisor.enqueue(sub.turnId);
  await new Promise((r) => setTimeout(r, 120)); // 准备阶段挂在 bootstrap 上
  const stopped = ctx.supervisor.stop(sub.turnId);
  assert.equal(stopped.stopped, true, '准备挂起时 Stop 必须找得到句柄（反例：stopped=false）');
  releaseBootstrap!({ ok: true, result: bootPack() });
  await ctx.supervisor.waitIdle();
  assert.equal(log.length, 0, '取消后迟到的 bootstrap 结果不得再派发模型');
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'blocked', '输入已保存待恢复（STOPPED_DURING_PREP）');
  ctx.db.close();
});

test('R11+③：B 不静默截断+元数据披露；B 为独立 system 块；新窗各自取数', async () => {
  const log: Array<Record<string, unknown>> = [];
  let bootCalls = 0;
  let gen = 0;
  const transport: OrTransport = async () => { gen++; return { status: 200, headers: new Map(), body: frameStream(textBody(`g${gen}`, `回${gen}`)) }; };
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'bootstrap.get') { bootCalls++; return { ok: true, result: bootPack() }; }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const ctx = compose(tempRoot('r11-'), transport, mariposa, log);
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一句', clientMessageId: 'k1', occurredAt: T0 });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  const first = log[0]!.full as Array<{ role: string; content: unknown }>;
  const systems = first.filter((m) => m.role === 'system');
  assert.equal(systems.length, 2, 'B=独立 system 数据块（A/B 显式缓存分界，systemMessageCount=2）');
  const bText = JSON.stringify(systems[1]);
  assert.ok(bText.includes('XYZEND'), '计划正文完整（不被 200 字符砍）');
  assert.ok(bText.includes('x'.repeat(260)), '计划长字段完整');
  assert.ok(bText.includes('还有更多未载入'), '续页元数据如实披露');
  assert.ok(bText.includes(I_FULL.slice(-30)), 'I 全文渲染（不被 2000 砍）');
  assert.ok(bText.includes('超窗未全载'), 'I 截断标记披露');
  assert.ok(!JSON.stringify(systems[0]).includes('XYZEND'), 'B 不并入 A 段（A=身份/规则，不含资料）');
  // ③：第二个会话的新窗各自取最新开窗包（不复用旧窗冻结包）
  ctx.messages.ensureConversation('c2');
  const sub2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c2', content: '新窗第一句', clientMessageId: 'k2', occurredAt: T0 });
  ctx.supervisor.enqueue(sub2.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal(bootCalls, 2, '新窗必拉最新（每窗一次，不跨窗复用冻结包）');
  ctx.db.close();
});

test('R02：召回带语义查询与词项；续查走 refine 回原会话；提示如实', async () => {
  const root = tempRoot('r02-');
  writeApprovedIdentity(root);
  buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const packet = {
    recall_session_id: 'rs_1', revision: 1, search_status: 'FOUND',
    // WP-04（C10）：judge_mode 恒在信封（M 现行契约——夹具对齐）
    judge_mode: 'on', judgement_status: 'evaluated', judged_count: 1,
    candidates: [{ memory_id: '00001' }],
    continuation: { continue_request_ref: 'cont_abc', for_revision: 1 },
  };
  const mariposa: MariposaTransport = async (cap, payload) => {
    calls.push({ cap, payload: payload as Record<string, unknown> });
    return { ok: true, result: packet };
  };
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r' } as const;
  await tools.execute('memory_recall', { __tool_call_id: 'c1', query: '上次聊中秋看月亮' }, CTX);
  let plan = (calls[0]!.payload as { query_plan: Record<string, unknown> }).query_plan;
  assert.equal(plan.semantic_query, '上次聊中秋看月亮', '自然语言显式进语义通道（服务端只认显式值）');
  assert.equal(plan.lexical_terms, undefined, '不带词项=纯语义');
  await tools.execute('memory_recall', { __tool_call_id: 'c2', query: '中秋', lexical_terms: ['中秋', '月亮'] }, CTX);
  plan = (calls[1]!.payload as { query_plan: Record<string, unknown> }).query_plan;
  assert.deepEqual(plan.lexical_terms, ['中秋', '月亮'], '模型可补精确词项');
  // 续查：refine 回原 session（不是另起 start）
  const out = await tools.execute('memory_recall', { __tool_call_id: 'c3', query: '就中秋那天', refine_session_id: 'rs_1', refine_continue_ref: 'cont_abc' }, CTX);
  assert.equal(out.ok, true);
  assert.equal(calls[2]!.cap, 'memory.recall.refine', '续查走 refine');
  const p3 = calls[2]!.payload as Record<string, unknown>;
  assert.equal(p3.session_id, 'rs_1');
  assert.equal((p3.query_plan as Record<string, unknown>).request_ref, 'cont_abc', '服务端续查引用透传');
  assert.ok(String((out.output as Record<string, unknown>).continuation_note).includes('refine_session_id'), '续查提示如实（不再宣称另起=会话延续）');
  // 只带一半续查参数 → 拒
  const half = await tools.execute('memory_recall', { __tool_call_id: 'c4', query: 'x', refine_session_id: 'rs_1' }, CTX);
  assert.equal(half.ok, false, '续查参数必须成对');
  db.close();
});
