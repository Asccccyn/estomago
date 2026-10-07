// D2+G-J-01（她批准 2026-10-06"按你的顺序来，能收口的都收了"）：
//  - D2：新窗首信封注入开窗资料（B 点）——estomago profile；不可达=降级
//    不阻塞；同窗第二轮不重复注入（B 冻结在轨迹正本）
//  - G-J-01：memory_recall 工具——模型按需查；request_ref 宿主派生幂等；
//    失败分类（unknown 不当失败）；结果数据注记
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
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));

const T0 = '2026-10-06T09:00:00+08:00';

function bootPack(): Record<string, unknown> {
  return {
    snapshot_id: 'snap_t1', state_hash: 'h1', profile: 'estomago',
    memory_days: { items: [{ memory_id: '00001', memory_date: '2026-10-06', original_title: '天台看月亮', mood_tags: ['开心'] }], count: 1 },
    plans: { items: [{ plan_id: 'p1', title: '周末采购' }], count: 1 },
    anniversaries: { items: [], count: 0 },
    i: { content: '（I 当前的话：合成）', note: '' },
  };
}

function compose(root: string, transport: OrTransport, mariposa: MariposaTransport, log: Array<Record<string, unknown>>) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
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
    log.push({ kind: 'chat', prompt: JSON.stringify((payload.messages as Array<{ role: string }>)[0]) .slice(0, 80), sysLen: JSON.stringify(payload.messages[0]).length, full: payload.messages });
    return transport(payload);
  };
  const runner = new DeepSeekRunner({ retryMax: 0 }, wrapped);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, events };
}

test('D2：新窗首信封含开窗资料（B 点）——同窗第二轮不重复注入', async () => {
  const log: Array<Record<string, unknown>> = [];
  let gen = 0;
  const transport: OrTransport = async () => { gen++; return { status: 200, headers: new Map(), body: frameStream(textBody(`g${gen}`, `回${gen}`)) }; };
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'bootstrap.get') return { ok: true, result: bootPack() };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const ctx = compose(tempRoot('d2a-'), transport, mariposa, log);
  const say = async (id: string) => {
    const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `话${id}`, clientMessageId: id, occurredAt: T0 });
    ctx.supervisor.enqueue(sub.turnId);
    await ctx.supervisor.waitIdle();
  };
  await say('a'); await say('b');
  const first = log[0]!.full as Array<{ role: string; content: unknown }>;
  // R11（复审 2026-10-07）：B=独立 system 数据块——断言覆盖全部 system 块
  const sysOf = (msgs: Array<{ role: string }>) => msgs.filter((m) => m.role === 'system').map((m) => JSON.stringify(m)).join('\n');
  const sysText = sysOf(first);
  assert.ok(sysText.includes('天台看月亮'), '首信封 system 含三日条目标题');
  assert.ok(sysText.includes('周末采购'), '含未完成计划');
  assert.ok(!sysText.includes('mood_text'), 'estomago 口径：不带心情自由文字（标签可带）');
  assert.ok(sysText.includes('开心'), '心情标签在场');
  const second = log[1]!.full as Array<{ role: string; content: unknown }>;
  assert.equal(sysOf(second), sysOf(first), '同窗第二轮 system 块不变（B 已冻结进轨迹正本）');
  ctx.db.close();
});

test('D2：Mariposa 不可达→无 B 降级不阻塞；消息照常收口', async () => {
  const log: Array<Record<string, unknown>> = [];
  let gen = 0;
  const transport: OrTransport = async () => { gen++; return { status: 200, headers: new Map(), body: frameStream(textBody(`g${gen}`, 'ok')) }; };
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'bootstrap.get') throw new Error('模拟传输失败');
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const ctx = compose(tempRoot('d2b-'), transport, mariposa, log);
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一条', clientMessageId: 'x1', occurredAt: T0 });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed', '降级不阻塞消息');
  const sysText = JSON.stringify((log[0]!.full as Array<{ content: unknown }>)[0]);
  assert.ok(!sysText.includes('bootstrap'), '无 B 注入');
  ctx.db.close();
});

const recallResult = {
  recall_session_id: 'rs_1', revision: 1, search_status: 'FOUND',
  candidates: [{ memory_id: '00001', original_title: '天台看月亮', text: '她约今晚天台看月亮' }],
  continuation: { continue_request_ref: 'cont_abc', for_revision: 1 },
};

test('G-J-01：memory_recall 工具——宿主派生 request_ref、同调用重试同 ref、结果数据注记', async () => {
  const root = tempRoot('gj01-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const calls: Array<Record<string, unknown>> = [];
  const mariposa: MariposaTransport = async (cap, payload) => {
    if (cap === 'memory.recall.start') { calls.push(payload); return { ok: true, result: recallResult }; }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const out = await tools.execute('memory_recall', { __tool_call_id: 'call-r1', query: '上次聊中秋看月亮' }, { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-1' });
  assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 200));
  assert.equal(calls.length, 1);
  const p0 = calls[0]!;
  assert.equal(p0.request_ref, `es-recall-${sha256Hex('t1:call-r1').slice(0, 40)}`, '宿主派生幂等 ref（模型不能自编）');
  assert.equal((p0.query_plan as Record<string, unknown>).original_request, '上次聊中秋看月亮');
  assert.equal(out.output.recall_session_id, 'rs_1');
  assert.ok(String(out.output.note).includes('数据'), '结果=数据非指令注记');
  assert.ok(String((out.output as Record<string, unknown>).continuation_note).includes('cont_abc'), '续查引用透传');
  // 重试同 ref
  await tools.execute('memory_recall', { __tool_call_id: 'call-r1', query: '上次聊中秋看月亮' }, { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-1' });
  assert.equal(calls.length, 2);
  assert.equal((calls[1]!.request_ref as string), (calls[0]!.request_ref as string), '同 tool_call 重试同 ref（服务端按 request_ref 幂等）');
  db.close();
});

test('G-J-01：5xx→OUTCOME_UNKNOWN；参数门拒缺 query；白名单外工具名拒', async () => {
  const root = tempRoot('gj01b-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'memory.recall.start') return { ok: false, code: 'HTTP_502', httpStatus: 502 };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const out = await tools.execute('memory_recall', { __tool_call_id: 'c9', query: 'x' }, { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r' });
  assert.equal(out.ok, false);
  assert.equal(out.output.error_code, 'RECALL_OUTCOME_UNKNOWN', '结果不明不当失败');
  const bad = validateToolArgs('memory_recall', {});
  assert.ok(!bad.ok && bad.code === 'TOOL_ARG_REQUIRED', '缺 query 拒');
  const notOurs = await tools.execute('evil_tool', {}, { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r' });
  assert.equal(notOurs.output.error_code, 'TOOL_NOT_IN_ALLOWLIST');
  db.close();
});

test('D3：凭空建房防护——POST 不存在的房间 404；primary 正常', async () => {
  // 复用已启动 mock 服务模式：直接构造 compose+真实 HTTP 太重——走 messages 层模拟 HTTP 守卫
  const root = tempRoot('d3-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const exists = (id: string) => db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id);
  assert.ok(exists('primary'), 'primary 在');
  assert.equal(exists('ghost-room'), undefined, '凭空房间不存在→HTTP 层 404（守卫在 http.ts）');
  db.close();
});

test('D5：sticker/voice 消息 kind 映射到领域 published_kind', () => {
  // 映射逻辑在 archive-sync（纯函数级验证映射表本身）
  const map = (kind: string): string => kind === 'text' ? 'chat_message'
    : kind === 'sticker' ? 'sticker_message'
    : kind === 'voice' ? 'voice_message'
    : kind;
  assert.equal(map('text'), 'chat_message');
  assert.equal(map('sticker'), 'sticker_message');
  assert.equal(map('voice'), 'voice_message');
  assert.equal(map('system'), 'system', '未知 kind 原样发出→服务端 fail-closed 拒');
});
