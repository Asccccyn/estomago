// memory_hold 新契约（mariposa@d14a24e 对齐）+ 模型指认式引用（她的裁定 2026-10-05）：
// quotes 由模型给片段，网关在"发起请求实际看见的原话"里逐字核对；说话人按来源自动映射
// （owner=qiaosheng / assistant=jiaming）；引用按 mariposa source_selections 钉住（收据齐全才发）。
// 失配/未同步=如实拒绝且零副作用。假 transport/假 Mariposa，零网络。
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
import { HostToolExecutor, validateToolArgs } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const toolBody = (id: string, callId: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'memory_hold', arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

type HoldCall = { operationId: string; holdPayload: Record<string, unknown>; sourceSelections: unknown };

/** 记录型假 Mariposa：memory.hold 参数原样留证 */
function recordingMariposa(calls: HoldCall[]): MariposaTransport {
  return async (capability, payload) => {
    if (capability === 'memory.hold') {
      calls.push({ operationId: payload.operation_id as string, holdPayload: payload as Record<string, unknown>, sourceSelections: payload.source_selections ?? null });
      return { ok: true, result: { operation_id: payload.operation_id, memory_id: `mem-${calls.length}`, version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
}

function compose(root: string, holdArgs: Record<string, unknown>, mariposa: MariposaTransport) {
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
  let gen = 0;
  const transport: OrTransport = async (payload) => {
    const msgs = payload.messages as Array<{ role: string; content: unknown }>;
    const hasToolResult = msgs.some((m) => m.role === 'tool');
    gen++;
    const body = hasToolResult ? textBody(`g${gen}`, '记好了') : toolBody(`g${gen}`, `call-${gen}`, holdArgs);
    return { status: 200, headers: new Map<string, string>(), body: frameStream(body) };
  };
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, messages, supervisor };
}

const T0 = '2026-10-02T09:00:00+08:00';

async function say(ctx: ReturnType<typeof compose>, content: string, id: string, at: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: at });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

/** 给消息种正式来源收据（模拟 archive-sync 已 ACK） */
function seedReceipt(ctx: ReturnType<typeof compose>, messageId: string, revision: number, content: string, srcConv: string, srcMsg: string): void {
  ctx.db.prepare(
    `INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at)
     VALUES ('ssr-${messageId}-${revision}', 'op-seed', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(messageId, revision, srcConv, srcMsg, sha256Hex(content), new Date().toISOString(), new Date().toISOString());
}

test('真实顺序：提交→收据就位→hold 带片段引用→our_words 逐字+说话人+source_selections 钉住', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq2-');
  const userText = '今天路过花店，突然好想你';
  const holdArgs = { original_title: '路过花店想他', categories: ['sweet'], text: '她在回家路上路过花店时想起了char', quotes: ['路过花店，突然好想你'] };
  const ctx = compose(root, holdArgs, recordingMariposa(calls));
  // 手动走真实顺序：提交消息（不 enqueue）→ 种收据 → enqueue 驱动
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: userText, clientMessageId: 'q2', occurredAt: T0 });
  seedReceipt(ctx, sub.message.id, 1, userText, 'src-conv-1', 'src-m-1');
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed');
  assert.equal(calls.length, 1, '恰好一次 hold');
  const call = calls[0]!;
  assert.equal((call.holdPayload as { original_title: string }).original_title, '路过花店想他');
  assert.deepEqual((call.holdPayload as { categories: string[] }).categories, ['sweet']);
  const ourWords = (call.holdPayload as { our_words: Array<Record<string, unknown>> }).our_words;
  assert.equal(ourWords.length, 1);
  assert.equal(ourWords[0]!.speaker, 'qiaosheng', '用户原话→qiaosheng（来源自动映射）');
  assert.equal(ourWords[0]!.text, '路过花店，突然好想你', '逐字保真（模型零复述）');
  assert.equal(ourWords[0]!.expression_kind, 'verbatim', '网关核对过的=verbatim');
  const sel = (call.sourceSelections as Array<Record<string, unknown>>)[0]!;
  assert.equal(sel.conversation_id, 'src-conv-1', '按 mariposa 来源会话钉');
  const member = (sel.members as Array<Record<string, string>>)[0]!;
  assert.equal(member.source_message_id, 'src-m-1');
  assert.equal(member.content_hash, sha256Hex(userText), '内容 hash=原文 sha256（mariposa 契约）');
  assert.equal(sel.start_char_offset, userText.indexOf('路过花店'), '句内片段带字符区间');
  assert.equal(sel.end_char_offset, userText.indexOf('路过花店') + '路过花店，突然好想你'.length);
  ctx.db.close();
});

test('自审 P2 回归：emoji（增补平面）在片段之前时，offset 按码点计不按 UTF-16 计', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq-emoji-');
  // '😀'=1 码点但 2 个 UTF-16 单位：旧实现会把 start 多算 1、end 多算 1 → mariposa（码点半开区间）钉错区间
  const userText = '😀今天路过花店，突然好想你';
  const frag = '路过花店，突然好想你';
  const ctx = compose(root, { original_title: '带emoji的引用', categories: ['sweet'], text: 'x', quotes: [frag] }, recordingMariposa(calls));
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: userText, clientMessageId: 'e1', occurredAt: T0 });
  seedReceipt(ctx, sub.message.id, 1, userText, 'src-conv-e', 'src-m-e');
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal(calls.length, 1, '引用命中（indexOf 匹配不受代理对影响）');
  const sel = (calls[0]!.sourceSelections as Array<Record<string, unknown>>)[0]!;
  const startCp = 3; // 😀(1) + 今(1) + 天(1) —— UTF-16 下标会是 4
  assert.equal(sel.start_char_offset, startCp, 'start=码点口径（mariposa query.py CB-029 契约），不是 UTF-16');
  assert.equal(sel.end_char_offset, startCp + [...frag].length, 'end=码点半开区间（frag 码点长度）');
  assert.notEqual(sel.start_char_offset, userText.indexOf(frag), '确实与 UTF-16 下标不同（用例有效性）');
  ctx.db.close();
});

test('参数门补充：quotes/plan_ids 空串条目在门口拒绝', async () => {
  const badQ = validateToolArgs('memory_hold', { original_title: 't', categories: ['daily'], text: 'x', quotes: ['正常片段', ''] });
  assert.ok(!badQ.ok && badQ.code === 'TOOL_ARG_LENGTH', 'quotes 空串条目拒收');
  const badP = validateToolArgs('memory_hold', { original_title: 't', categories: ['daily'], text: 'x', plan_ids: [''] });
  assert.ok(!badP.ok && badP.code === 'TOOL_ARG_LENGTH', 'plan_ids 空串条目拒收（mariposa items minLength=1 对齐）');
});

test('引用失配：模型指认了不存在的原话 → QUOTE_MATCH_FAILED，hold 不发、账本不开（零副作用）', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq3-');
  const ctx = compose(root, { original_title: '记录确认', categories: ['daily'], text: '他确认记下了', quotes: ['模型编造的、从没说过的话'] }, recordingMariposa(calls));
  const sub = await say(ctx, '帮我记住这件事', 'b1', T0);
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed', '回合照常收口（工具错误是模型可见输出，不是宿主故障）');
  assert.equal(calls.length, 0, '引用失配=hold 不发（不替模型圆谎）');
  const effects = ctx.db.prepare('SELECT COUNT(*) n FROM tool_side_effects').get() as { n: number };
  assert.equal(effects.n, 0, '账本也不开 effect（引用先于 openEffect 收口）');
  ctx.db.close();
});

test('整句引用（消息边界）：上一轮已发布的助手回复，第二轮 hold 引用→jiaming+无 offset', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq4-');
  // 自定义 transport：第 1 个请求纯文本回复，之后 hold（不复用 compose 的固定脚本）
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
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: recordingMariposa(calls) }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  let gen = 0;
  let phase = 0; // 0=第一轮纯文本；1=此后走 hold 脚本
  const transport: OrTransport = async (payload) => {
    const msgs = payload.messages as Array<{ role: string; content: unknown }>;
    const hasToolResult = msgs.some((m) => m.role === 'tool');
    gen++;
    let body: string;
    if (phase === 0) body = textBody(`g${gen}`, '这是上一轮的原话');
    else body = hasToolResult ? textBody(`g${gen}`, '记好了') : toolBody(`g${gen}`, `c${gen}`, { original_title: '引用上一轮', categories: ['daily'], text: '补一条引用', quotes: ['这是上一轮的原话'] });
    return { status: 200, headers: new Map<string, string>(), body: frameStream(body) };
  };
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  phase = 0;
  const t1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一轮', clientMessageId: 'p1', occurredAt: T0 });
  supervisor.enqueue(t1.turnId);
  await supervisor.waitIdle();
  const asst = db.prepare(
    "SELECT m.id, r.content FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision WHERE m.speaker='assistant' ORDER BY m.sequence LIMIT 1",
  ).get() as { id: string; content: string };
  assert.equal(asst.content, '这是上一轮的原话');
  seedReceipt({ db } as never, asst.id, 1, asst.content, 'src-conv-2', 'src-m-2');
  phase = 1;
  const t2 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第二轮', clientMessageId: 'p2', occurredAt: new Date(Date.parse(T0) + 60_000).toISOString() });
  supervisor.enqueue(t2.turnId);
  await supervisor.waitIdle();
  assert.equal(calls.length, 1);
  const ourWords = (calls[0]!.holdPayload as { our_words: Array<Record<string, unknown>> }).our_words;
  assert.equal(ourWords[0]!.speaker, 'jiaming', '助手原话→jiaming');
  assert.equal(ourWords[0]!.text, '这是上一轮的原话');
  const sel = (calls[0]!.sourceSelections as Array<Record<string, unknown>>)[0]!;
  assert.equal(sel.start_char_offset, undefined, '整条消息引用=消息边界（不带 offset）');
  assert.equal(sel.end_char_offset, undefined);
  const member = (sel.members as Array<Record<string, string>>)[0]!;
  assert.equal(member.source_message_id, 'src-m-2');
  db.close();
});

test('未同步引用：消息存在但无来源收据 → QUOTE_NOT_SYNCED 拒绝（不宣称未入库的引用）', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq5-');
  const ctx = compose(root, { original_title: '无收据', categories: ['daily'], text: 'x', quotes: ['还没同步的话'] }, recordingMariposa(calls));
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '这句还没同步的话先说着', clientMessageId: 'u1', occurredAt: T0 });
  // 不种收据、executor 无 archiveSync → 直接拒
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal(calls.length, 0, '未同步=不发 hold');
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed', '回合照常收口（工具错误是模型可见输出，不是宿主故障）');
  ctx.db.close();
});
