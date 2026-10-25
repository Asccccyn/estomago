// memory_hold 勾选式话语（她 2026-10-18 裁定）：quotes 只报消息序号
// （可细到 from/to 句范围），宿主从已见原文直接抄录——一字不差是构造
// 出来的，不再逐字比对；说话人按来源自动映射（owner=qiaosheng /
// assistant=jiaming）；引用按 mariposa 不决定事件原文范围（收据齐
// 全才发）。序号未见过/句范围无效/未同步=如实拒绝且零副作用。
// 假 transport/假 Mariposa，零网络。
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
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'memory_hold', arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

type HoldCall = { operationId: string; holdPayload: Record<string, unknown>; sourceSelections: unknown };

/** 记录型假 Mariposa：memory.hold 参数原样留证。
 *  F-J-54 对齐（联合审计 2026-10-06）：回执 binding_ids 按真实服务端语义生成——
 *  mariposa registry._hold 对每条 source_selection 恰好建一个绑定（1:1）。 */
function recordingMariposa(calls: HoldCall[]): MariposaTransport {
  return async (capability, payload) => {
    if (capability === 'memory.hold') {
      calls.push({ operationId: payload.operation_id as string, holdPayload: payload as Record<string, unknown>, sourceSelections: payload.source_selections ?? null });
      const selCount = Array.isArray(payload.event_source_ranges) ? (payload.event_source_ranges as unknown[]).length : 0;
      return { ok: true, result: { operation_id: payload.operation_id, memory_id: `mem-${calls.length}`, version: 1, binding_ids: Array.from({ length: selCount }, (_, i) => `msb-fake-${calls.length}-${i}`), committed_at: new Date().toISOString() } };
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
  const windows = new WindowManager(db, events, identity, config);
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

test('真实顺序：提交→收据就位→hold 勾选句范围→our_words 直接抄录+说话人+不决定事件原文范围', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq2-');
  const userText = '她今天路过花店。突然好想你。';
  const holdArgs = { original_title: '路过花店想他', creation_mode: 'contemporaneous', categories: ['sweet'], text: '她在回家路上路过花店时想起了char', quotes: [{ seq: 1, from: 2, to: 2 }] };
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
  assert.equal(ourWords[0]!.text, '突然好想你。', '系统直接抄录第 2 句（构造式一字不差）');
  assert.equal(ourWords[0]!.source_ref, 'source_msg:src-m-1', 'F-J-01：正式来源身份=source_msg:<同步收据 id>');
  assert.equal(call.sourceSelections, null, '引语不建立事件原文绑定');
  ctx.db.close();
});

test('整条消息勾选（省略 from/to）：全量录入、不带 offset', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq-whole-');
  const userText = '帮我记住这件事';
  const ctx = compose(root, { original_title: '整条勾选', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x', quotes: [{ seq: 1 }] }, recordingMariposa(calls));
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: userText, clientMessageId: 'w1', occurredAt: T0 });
  seedReceipt(ctx, sub.message.id, 1, userText, 'src-conv-w', 'src-m-w');
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal(calls.length, 1);
  const ourWords = (calls[0]!.holdPayload as { our_words: Array<Record<string, unknown>> }).our_words;
  assert.equal(ourWords[0]!.text, userText, '整条消息=全文录入');
  assert.equal(calls[0]!.sourceSelections, null, '引语不建立事件原文绑定');
  ctx.db.close();
});

test('自审 P2 回归：emoji（增补平面）在句子之前时，offset 按码点计不按 UTF-16 计', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq-emoji-');
  // '😀'=1 码点但 2 个 UTF-16 单位：句 2 的码点起点=8，UTF-16 下标会算成 9
  const userText = '😀今天路过花店。突然好想你。';
  const ctx = compose(root, { original_title: '带emoji的引用', creation_mode: 'contemporaneous', categories: ['sweet'], text: 'x', quotes: [{ seq: 1, from: 2, to: 2 }] }, recordingMariposa(calls));
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: userText, clientMessageId: 'e1', occurredAt: T0 });
  seedReceipt(ctx, sub.message.id, 1, userText, 'src-conv-e', 'src-m-e');
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal(calls.length, 1, '勾选解析成功');
  const ourWords = (calls[0]!.holdPayload as { our_words: Array<Record<string, unknown>> }).our_words;
  assert.equal(ourWords[0]!.text, '突然好想你。');
  assert.equal(calls[0]!.sourceSelections, null, '引语不建立事件原文绑定');
  ctx.db.close();
});

test('参数门补充：勾选条目缺 seq/非整数/白名单外字段在门口拒绝', () => {
  const noSeq = validateToolArgs('memory_hold', { original_title: 't', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x', quotes: [{ from: 1 }] });
  assert.ok(!noSeq.ok && noSeq.code === 'TOOL_ARG_REQUIRED', '缺 seq 拒收');
  const badSeq = validateToolArgs('memory_hold', { original_title: 't', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x', quotes: [{ seq: '一' }] });
  assert.ok(!badSeq.ok && badSeq.code === 'TOOL_ARG_TYPE', 'seq 非 integer 拒收');
  const extra = validateToolArgs('memory_hold', { original_title: 't', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x', quotes: [{ seq: 1, snippet: '原文复述' }] });
  assert.ok(!extra.ok && extra.code === 'TOOL_ARG_UNKNOWN', '白名单外字段拒收（不接受复述正文）');
  const badP = validateToolArgs('memory_hold', { original_title: 't', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x', plan_ids: [''] });
  assert.ok(!badP.ok && badP.code === 'TOOL_ARG_LENGTH', 'plan_ids 空串条目拒收（mariposa items minLength=1 对齐）');
});

test('序号未见过：模型勾选了没看过的消息 → QUOTE_REF_SEQ_NOT_SEEN，hold 不发、账本不开（零副作用）', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq3-');
  const ctx = compose(root, { original_title: '记录确认', creation_mode: 'contemporaneous', categories: ['daily'], text: '他确认记下了', quotes: [{ seq: 99 }] }, recordingMariposa(calls));
  const sub = await say(ctx, '帮我记住这件事', 'b1', T0);
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed', '回合照常收口（工具错误是模型可见输出，不是宿主故障）');
  assert.equal(calls.length, 0, '勾选未见过=hold 不发');
  const effects = ctx.db.prepare('SELECT COUNT(*) n FROM tool_side_effects').get() as { n: number };
  assert.equal(effects.n, 0, '账本也不开 effect（勾选先于 openEffect 收口）');
  ctx.db.close();
});

test('句范围无效：超出该消息句数 → QUOTE_REF_RANGE_INVALID 拒绝', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq-range-');
  const ctx = compose(root, { original_title: '范围无效', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x', quotes: [{ seq: 1, from: 2, to: 9 }] }, recordingMariposa(calls));
  const sub = await say(ctx, '这句话只有一句。', 'r1', T0);
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed');
  assert.equal(calls.length, 0, '句范围无效=hold 不发');
  ctx.db.close();
});

test('重复勾选同一句 → QUOTE_REF_DUPLICATE 拒绝', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq-dup-');
  const ctx = compose(root, { original_title: '重复勾选', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x', quotes: [{ seq: 1, from: 1, to: 1 }, { seq: 1, from: 1, to: 1 }] }, recordingMariposa(calls));
  const sub = await say(ctx, '第一句。第二句。', 'd1', T0);
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed');
  assert.equal(calls.length, 0, '重叠勾选=hold 不发');
  ctx.db.close();
});

test('整句勾选（消息边界）：上一轮已发布的助手回复，第二轮 hold 勾选→jiaming+无 offset', async () => {
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
  const windows = new WindowManager(db, events, identity, config);
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
    else body = hasToolResult ? textBody(`g${gen}`, '记好了') : toolBody(`g${gen}`, `c${gen}`, { original_title: '引用上一轮', creation_mode: 'contemporaneous', categories: ['daily'], text: '补一条引用', quotes: [{ seq: 2 }] });
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
    "SELECT m.id, m.sequence, r.content FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision WHERE m.speaker='assistant' ORDER BY m.sequence LIMIT 1",
  ).get() as { id: string; sequence: number; content: string };
  assert.equal(asst.content, '这是上一轮的原话');
  assert.equal(asst.sequence, 2, '助手回复=第 2 条消息（seq 供勾选）');
  seedReceipt({ db } as never, asst.id, 1, asst.content, 'src-conv-2', 'src-m-2');
  phase = 1;
  const t2 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第二轮', clientMessageId: 'p2', occurredAt: new Date(Date.parse(T0) + 60_000).toISOString() });
  supervisor.enqueue(t2.turnId);
  await supervisor.waitIdle();
  assert.equal(calls.length, 1);
  const ourWords = (calls[0]!.holdPayload as { our_words: Array<Record<string, unknown>> }).our_words;
  assert.equal(ourWords[0]!.speaker, 'jiaming', '助手原话→jiaming');
  assert.equal(ourWords[0]!.text, '这是上一轮的原话');
  assert.equal(calls[0]!.sourceSelections, null, '引语不建立事件原文绑定');
  db.close();
});

test('未同步勾选：消息存在但无来源收据 → QUOTE_NOT_SYNCED 拒绝（不宣称未入库的引用）', async () => {
  const calls: HoldCall[] = [];
  const root = tempRoot('hq5-');
  const ctx = compose(root, { original_title: '无收据', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x', quotes: [{ seq: 1 }] }, recordingMariposa(calls));
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '这句还没同步的话先说着', clientMessageId: 'u1', occurredAt: T0 });
  // 不种收据、executor 无 archiveSync → 直接拒
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal(calls.length, 0, '未同步=不发 hold');
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed', '回合照常收口（工具错误是模型可见输出，不是宿主故障）');
  ctx.db.close();
});


test('独立事件范围：没有 quotes 仍在 hold 同次发送完整原文 manifest', async () => {
  const calls: HoldCall[] = [];
  const ctx = compose(tempRoot('event-no-quotes-'), { original_title: '事件', creation_mode: 'contemporaneous', categories: ['daily'], text: '事件正文', source_ranges: [{start_seq: 1,end_seq: 1}] }, recordingMariposa(calls));
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '完整原文\n第二行', clientMessageId: 'event1', occurredAt: T0 });
  seedReceipt(ctx, sub.message.id, 1, '完整原文\n第二行', 'event-conv', 'event-msg');
  ctx.supervisor.enqueue(sub.turnId); await ctx.supervisor.waitIdle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.holdPayload.our_words, undefined);
  assert.deepEqual(calls[0]!.holdPayload.event_source_ranges, [{conversation_id:'event-conv',members:[{source_message_id:'event-msg',content_hash:sha256Hex('完整原文\n第二行')}]}]);
  ctx.db.close();
});

test('事件范围未同步：整次 hold 拒绝，不能用引语或时间补齐', async () => {
  const calls: HoldCall[] = [];
  const ctx = compose(tempRoot('event-unsynced-'), {original_title:'事件', creation_mode:'contemporaneous', categories:['daily'],text:'正文',source_ranges:[{start_seq:1,end_seq:1}]}, recordingMariposa(calls));
  await say(ctx,'尚未同步','event2',T0);
  assert.equal(calls.length,0);
  ctx.db.close();
});
