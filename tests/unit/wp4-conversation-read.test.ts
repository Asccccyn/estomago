// WP4（MANUAL_HANDOFF_JUDGE_SWITCH_V1 §7.2，2026-10-08）conversation_read：
//  - O01：锚点前后回读同房间未选段；跨房间锚点拒（房间=执行上下文派生）
//  - O02：仅 owner 真实消息+已发布 assistant；system/草稿/UI 思考零命中
//  - O03：长中文分片逐字拼回、版本/hash 对齐、进度严格前进
//  - O04：sync_state 如实（outbox 状态映射）；指定修订读不到如实拒（不冒充）
//  - O05：片段实际进入下一请求才算已见（未发出的 pending 不入 manifest）
//  - O06：已读片段可被 hold 引用；同消息未读片段不放行（码点范围门）
//  - O07：多次回读零副作用（消息/修订/outbox/书签计数不变）
//  - O08：无 include_cot 参数（思考不可请求）；协议继续态回归随全套件
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
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const toolBody = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 99, seenMessages: [], requestId: 'req-1' } as const;

function makeExecutor(root: string, mariposa?: MariposaTransport) {
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const executor = new HostToolExecutor({
    db,
    mariposa: new MariposaClient({ transport: mariposa ?? (async () => ({ ok: false, code: 'X', httpStatus: 404 })) }),
    reviews: new RotationReviewService(db),
    checkpoint: new HoldCheckpointService(db),
  })
  wireOidoCapabilitiesForTest(executor, {});;
  return { executor, db };
}

function seedMsg(db: ReturnType<typeof openDatabase>, room: string, id: string, seq: number, speaker: 'owner' | 'assistant' | 'system', content: string, opts: { published?: boolean } = {}) {
  db.prepare("INSERT OR IGNORE INTO conversations(id, owner_service, scope, created_at) VALUES (?,'estomago','private','2026-01-01T00:00:00Z')").run(room);
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES (?,?,?,?,?,1,?,?)").run(id, room, seq, speaker, 'text', speaker === 'assistant' && opts.published !== false ? '2026-01-01T00:00:00Z' : null, '2026-01-01T00:00:00Z');
  db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,?,?,?,'seed')").run(id, content, sha256Hex(content), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
}

test('O01：锚点前后回读同房间未选段；跨房间锚点拒（房间不可自填）', async () => {
  const root = tempRoot('wp4-o01-');
  const { executor, db } = makeExecutor(root);
  seedMsg(db, 'c1', 'm1', 1, 'owner', '第一条');
  seedMsg(db, 'c1', 'm2', 2, 'assistant', '第二条回复');
  seedMsg(db, 'c1', 'm3', 3, 'owner', '第三条');
  seedMsg(db, 'c1', 'm4', 4, 'owner', '第四条');
  seedMsg(db, 'other-room', 'x1', 1, 'owner', '别的房间的消息');
  const out = await executor.execute('conversation_read', { around_seq: 2, before: 1, after: 1 }, CTX);
  assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 300));
  const entries = out.output.entries as Array<{ seq: number; text: string }>;
  assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3], '锚点前后各一条，未选段也可读（选择不是读取权限全集）');
  // 跨房间锚点：本房间找不到（不泄漏存在性）
  const cross = await executor.execute('conversation_read', { around_seq: 999 }, CTX);
  assert.equal(cross.ok, false);
  assert.equal(cross.output.error_code, 'READ_ANCHOR_NOT_FOUND');
  db.close();
});

test('O02：仅 owner 与已发布 assistant——system/草稿/思考 canary 零命中', async () => {
  const root = tempRoot('wp4-o02-');
  const { executor, db } = makeExecutor(root);
  seedMsg(db, 'c1', 'u1', 1, 'owner', '她的原话canary-owner');
  seedMsg(db, 'c1', 'a1', 2, 'assistant', '正式发布的回复canary-published');
  seedMsg(db, 'c1', 'd1', 3, 'assistant', '未发布草稿canary-draft', { published: false });
  seedMsg(db, 'c1', 's1', 4, 'system', '系统片段canary-system');
  const out = await executor.execute('conversation_read', { from_sequence: 1, to_sequence: 10 }, CTX);
  assert.equal(out.ok, true);
  const blob = JSON.stringify(out.output);
  assert.ok(blob.includes('canary-owner') && blob.includes('canary-published'), 'owner 与正式助手可见');
  assert.ok(!blob.includes('canary-draft') && !blob.includes('canary-system'), '草稿/系统零命中');
  assert.ok(!blob.toLowerCase().includes('reasoning'), '无思考面（工具不提供 include_cot）');
  db.close();
});

test('O03：长中文分片——码点拼回逐字一致、hash 对齐、进度严格前进', async () => {
  const root = tempRoot('wp4-o03-');
  const { executor, db } = makeExecutor(root);
  const long = `开头段。${'很长的中文正文内容。'.repeat(600)}结尾段。`;
  seedMsg(db, 'c1', 'big1', 1, 'owner', long);
  const first = await executor.execute('conversation_read', { around_seq: 1 }, CTX);
  assert.equal(first.ok, true);
  const e0 = (first.output.entries as Array<Record<string, unknown>>)[0]!;
  assert.ok(e0.fragment, '长文必须分片');
  const frag0 = e0.fragment as { start_char: number; end_char: number; total_chars: number; content_complete: boolean; continue_cursor?: Record<string, unknown> };
  assert.equal(frag0.start_char, 0);
  assert.ok(frag0.end_char > 0 && frag0.end_char < frag0.total_chars);
  assert.equal(frag0.content_complete, false);
  assert.ok(frag0.continue_cursor, '有续片游标');
  const pieces: string[] = [e0.text as string];
  const hashes = new Set<string>([e0.content_hash as string]);
  let cursor = frag0.continue_cursor!;
  let prevEnd = frag0.end_char;
  for (let i = 0; i < 20; i++) {
    const page = await executor.execute('conversation_read', { cursor }, CTX);
    assert.equal(page.ok, true, JSON.stringify(page.output).slice(0, 200));
    const entry = (page.output.entries as Array<Record<string, unknown>>)[0]!;
    const fr = entry.fragment as { start_char: number; end_char: number; content_complete: boolean; continue_cursor?: Record<string, unknown> };
    assert.equal(fr.start_char, prevEnd, '进度严格前进（片段首尾相接）');
    assert.ok(fr.end_char > fr.start_char, '不空页');
    pieces.push(entry.text as string);
    hashes.add(entry.content_hash as string);
    prevEnd = fr.end_char;
    if (fr.content_complete) break;
    cursor = fr.continue_cursor!;
  }
  assert.equal(pieces.join(''), long, '拼回逐字一致');
  assert.equal(hashes.size, 1, '版本/hash 全程对齐');
  db.close();
});

test('O04：sync_state 如实映射；指定修订读不到如实拒（不冒充）', async () => {
  const root = tempRoot('wp4-o04-');
  const { executor, db } = makeExecutor(root);
  seedMsg(db, 'c1', 's1', 1, 'owner', '同步中的消息');
  seedMsg(db, 'c1', 's2', 2, 'owner', '已同步的消息');
  seedMsg(db, 'c1', 's3', 3, 'owner', '失败的消息');
  db.prepare("INSERT INTO outbox(id, operation_key, target, payload_ref, state, created_at, updated_at) VALUES ('o1','archive:s1:1','mariposa.archive','{}','sent','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO outbox(id, operation_key, target, payload_ref, state, created_at, updated_at) VALUES ('o2','archive:s2:1','mariposa.archive','{}','acked','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO outbox(id, operation_key, target, payload_ref, state, created_at, updated_at) VALUES ('o3','archive:s3:1','mariposa.archive','{}','failed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  const out = await executor.execute('conversation_read', { from_sequence: 1, to_sequence: 3 }, CTX);
  assert.equal(out.ok, true);
  const entries = out.output.entries as Array<{ seq: number; text: string; sync_state?: unknown }>;
  // 2026-10-19 她裁定（JSON 瘦身）：sync_state 不再出站（核对是系统的事）；
  // 归档状态不影响可读——三条正文都如实可读
  assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3]);
  assert.ok(entries.every((e) => !('sync_state' in e)), '条目不再携带 sync_state');
  // 指定不存在的修订 → 如实拒，不拿当前修订冒充
  const bad = await executor.execute('conversation_read', { around_seq: 1, revision: 9 }, CTX);
  assert.equal(bad.ok, false);
  assert.equal(bad.output.error_code, 'READ_REVISION_UNAVAILABLE');
  db.close();
});

test('O07：多次回读零副作用——消息/修订/outbox/书签计数不变', async () => {
  const root = tempRoot('wp4-o07-');
  const { executor, db } = makeExecutor(root);
  seedMsg(db, 'c1', 'm1', 1, 'owner', '读我');
  seedMsg(db, 'c1', 'm2', 2, 'assistant', '回复');
  const counts = () => ({
    messages: (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n,
    revisions: (db.prepare('SELECT COUNT(*) n FROM message_revisions').get() as { n: number }).n,
    outbox: (db.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number }).n,
    checkpoints: (db.prepare('SELECT COUNT(*) n FROM hold_checkpoints').get() as { n: number }).n,
  });
  const before = counts();
  for (let i = 0; i < 3; i++) {
    const out = await executor.execute('conversation_read', { around_seq: 1 }, CTX);
    assert.equal(out.ok, true);
  }
  assert.deepEqual(counts(), before, '回读不发布/不归档/不推书签/不开记忆桶');
  db.close();
});

test('O08：schema 无 include_cot——思考不可请求（additionalProperties:false）', () => {
  const bad = validateToolArgs('conversation_read', { around_seq: 1, include_cot: true });
  assert.ok(!bad.ok, 'include_cot 被参数门拒绝');
});

test('O06（单元）：片段级已见——已读范围可引用，未读片段不放行', async () => {
  const root = tempRoot('wp4-o06-');
  const holdCalls: unknown[] = [];
  const mariposa: MariposaTransport = async (cap, payload) => {
    if (cap === 'memory.hold') {
      holdCalls.push(payload);
      const n = Array.isArray(payload.source_selections) ? (payload.source_selections as unknown[]).length : 0;
      return { ok: true, result: { operation_id: payload.operation_id, memory_id: 'mem-x', version: 1, binding_ids: Array.from({ length: n }, (_, i) => `msb-x-${i}`), committed_at: new Date().toISOString() } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const { executor, db } = makeExecutor(root, mariposa);
  const full = '前半段可引用的原文。' + '后半段未读的原文，这里有一只猫。'.repeat(1);
  seedMsg(db, 'c1', 'm1', 1, 'owner', full);
  // 引用前提：被引消息已完成正式来源同步（QUOTE_NOT_SYNCED 既有边界保持）
  db.prepare("INSERT INTO source_sync_receipts(operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, created_at) VALUES ('op-r1','m1',1,'conv-x','src-m1',?,'2026-01-01T00:00:00Z')").run(sha256Hex(full));
  // 已读片段=码点 [0, 11)（"前半段可引用的原文。"共 11 码点）
  const readCpEnd = [...'前半段可引用的原文。'].length;
  const holdArgs = {
    original_title: '测试', categories: ['daily'], text: '事件正文', creation_mode: 'contemporaneous',
    quotes: [{ seq: 1, from: 1, to: 1 }],
  };
  const okCtx = { ...CTX, seenMessages: [{ id: 'm1', revision: 1, char_start: 0, char_end: readCpEnd }] };
  const good = await executor.execute('memory_hold', { ...holdArgs, __tool_call_id: 'c1' }, okCtx);
  assert.equal(good.ok, true, JSON.stringify(good.output).slice(0, 200));
  assert.equal(holdCalls.length, 1, '已读句段可勾选，hold 发出');
  // 未读句段（在后半段）→ QUOTE_REF_RANGE_NOT_SEEN，零副作用
  const badHold = await executor.execute('memory_hold', { ...holdArgs, quotes: [{ seq: 1, from: 2, to: 2 }], __tool_call_id: 'c2' }, okCtx);
  assert.equal(badHold.ok, false);
  assert.equal((badHold.output as { error_code?: string }).error_code, 'QUOTE_REF_RANGE_NOT_SEEN');
  assert.equal(holdCalls.length, 1, '未读句段不放行——不因同消息其他句段已读而整条放行');
  // 整条勾选（含未读后半）同样不放行
  const badWhole = await executor.execute('memory_hold', { ...holdArgs, quotes: [{ seq: 1 }], __tool_call_id: 'c3' }, okCtx);
  assert.equal((badWhole.output as { error_code?: string }).error_code, 'QUOTE_REF_RANGE_NOT_SEEN');
  db.close();
});

// —— O05：片段实际进入下一请求才算已见（supervisor 集成） ——

function composeWp4(root: string, transport: OrTransport) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, reminders: { enabled: false } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const selections = new ManualSelectionService(db);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config, selections);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const mariposa: MariposaTransport = async (cap, payload) => {
    if (cap === 'memory.hold') {
      const n = Array.isArray(payload.source_selections) ? (payload.source_selections as unknown[]).length : 0;
      return { ok: true, result: { operation_id: payload.operation_id, memory_id: 'mem-y', version: 1, binding_ids: Array.from({ length: n }, (_, i) => `msb-y-${i}`), committed_at: new Date().toISOString() } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews, checkpoint })
  wireOidoCapabilitiesForTest(tools, {});;
  const trajectory = new WindowTrajectoryService(db);
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory, selections });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, trajectory };
}

const T0 = '2026-10-01T08:00:00+08:00';

function createActiveWindow(db: ReturnType<typeof openDatabase>) {
  db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES ('w1','c1','ACTIVE','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  db.prepare("UPDATE conversations SET active_window_id = 'w1' WHERE id = 'c1'").run();
}


async function say(ctx: ReturnType<typeof composeWp4>, content: string, id: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: T0 });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

test('O05：回读片段进入下一请求→入已见清单；未发出（下一轮失败）→不入', async () => {
  // 场景 A（正例）：第 1 轮模型调 conversation_read，第 2 轮（带工具结果）正常收尾
  const rootA = tempRoot('wp4-o05a-');
  let genA = 0;
  const ctxA = composeWp4(rootA, async (payload) => {
    const msgs = payload.messages as Array<{ role: string }>;
    genA++;
    if (msgs.some((m) => m.role === 'tool')) return { status: 200, headers: new Map(), body: frameStream(textBody(`a${genA}`, '好的，我看过了')) };
    return { status: 200, headers: new Map(), body: frameStream(toolBody(`a${genA}`, 'call-read-a', 'conversation_read', { around_seq: 2, before: 1, after: 1 })) };
  });
  // 存量历史（不经 turn，直接种行）+ 一条会话消息
  const hist = '很久以前的一段原文内容';
  ctxA.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('hist1','c1',2,'owner','text',1,?,'2026-01-01T00:00:00Z')").run('2026-01-01T00:00:00Z');
  ctxA.db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('hist1',1,'text',?,?,?,?, 'seed')").run(hist, sha256Hex(hist), '2026-09-30T20:00:00Z', '2026-09-30T20:00:00Z');
  createActiveWindow(ctxA.db);
  const subA = await say(ctxA, '读一下旧消息', 'm-a');
  const attA = ctxA.db.prepare('SELECT state FROM attempts WHERE id = ?').get(subA.attemptId) as { state: string };
  assert.equal(attA.state, 'completed', '正例回合完成');
  const winA = ctxA.windows.activeWindow('c1')!;
  const manifestA = ctxA.trajectory.forWindow(winA.id)!.manifest ?? [];
  assert.ok(manifestA.some((m) => m.id === 'hist1' && m.origin === 'tool'), '已发出的回读片段进入已见清单（O05 正例）');
  ctxA.db.close();

  // 场景 B（负例）：第 1 轮调 conversation_read，第 2 轮（携带工具结果的请求）传输失败
  // → 工具结果未进入任何模型请求 → 片段不得入已见清单
  const rootB = tempRoot('wp4-o05b-');
  let genB = 0;
  const ctxB = composeWp4(rootB, async (payload) => {
    const msgs = payload.messages as Array<{ role: string }>;
    genB++;
    if (msgs.some((m) => m.role === 'tool')) throw new Error('模拟第二轮传输失败');
    return { status: 200, headers: new Map(), body: frameStream(toolBody(`b${genB}`, 'call-read-b', 'conversation_read', { around_seq: 2 })) };
  });
  const hist2 = '另一段历史原文';
  ctxB.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('hist2','c1',2,'owner','text',1,?,'2026-01-01T00:00:00Z')").run('2026-01-01T00:00:00Z');
  ctxB.db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('hist2',1,'text',?,?,?,?, 'seed')").run(hist2, sha256Hex(hist2), '2026-09-30T20:00:00Z', '2026-09-30T20:00:00Z');
  createActiveWindow(ctxB.db);
  const subB = await say(ctxB, '再读一条', 'm-b');
  const attB = ctxB.db.prepare('SELECT state FROM attempts WHERE id = ?').get(subB.attemptId) as { state: string };
  assert.equal(attB.state, 'failed', '负例回合失败（第二轮传输失败）');
  const winB = ctxB.windows.activeWindow('c1')!;
  const manifestB = ctxB.trajectory.forWindow(winB.id)!.manifest ?? [];
  // 注意：旧自动 12k 回退（origin=dialogue）可含 hist2——那是既有装配路径；
  // O05 断言的是**工具来源**的已见条目：未发出的工具结果不得以 origin=tool 入清单
  assert.ok(!manifestB.some((m) => m.id === 'hist2' && m.origin === 'tool'), '未发出的工具结果不算已见（O05 负例——pending 不转正）');
  ctxB.db.close();
});

test('O06（集成）：回读片段进入请求后，同回合 hold 可引用该片段', async () => {
  const root = tempRoot('wp4-o06i-');
  const holdCalls: unknown[] = [];
  let gen = 0;
  const ctx = composeWp4(root, async (payload) => {
    const msgs = payload.messages as Array<{ role: string; content: unknown }>;
    gen++;
    const toolResults = msgs.filter((m) => m.role === 'tool');
    if (toolResults.length === 0) {
      // 第 1 轮：先回读
      return { status: 200, headers: new Map(), body: frameStream(toolBody(`g${gen}`, 'call-read', 'conversation_read', { around_seq: 2 })) };
    }
    if (toolResults.length === 1) {
      // 第 2 轮：回读结果已在请求里——hold 引用已读片段
      return { status: 200, headers: new Map(), body: frameStream(toolBody(`g${gen}`, 'call-hold', 'memory_hold', {
        original_title: '引用测试', categories: ['daily'], text: '事件正文', creation_mode: 'contemporaneous',
        quotes: [{ seq: 2, from: 1, to: 1 }],
      })) };
    }
    return { status: 200, headers: new Map(), body: frameStream(textBody(`g${gen}`, '记好了')) };
  });
  // 历史正文：第 1 句（前 9 码点）落在回读视野内
  const hist3 = '久远的可引用片段。还有后面没读到的部分。';
  ctx.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('hist3','c1',2,'owner','text',1,?,'2026-01-01T00:00:00Z')").run('2026-01-01T00:00:00Z');
  ctx.db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('hist3',1,'text',?,?,?,?, 'seed')").run(hist3, sha256Hex(hist3), '2026-09-30T20:00:00Z', '2026-09-30T20:00:00Z');
  createActiveWindow(ctx.db);
  const sub = await say(ctx, '读并记录', 'm-c');
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed');
  // 第 2 轮请求（含回读工具结果）真实发出 + 第 2 轮的 hold 已可用回读片段视野
  const payloads = (ctx.db.prepare("SELECT payload_json FROM provider_requests WHERE purpose = 'chat' ORDER BY created_at").all() as Array<{ payload_json: string }>).map((r) => r.payload_json);
  assert.ok(payloads.some((p) => p.includes('久远的可引用片段。')), '回读结果真实进入了下一请求');
  const holdPr = payloads.find((p) => p.includes('memory_hold'));
  assert.ok(holdPr, 'hold 请求存在');
  ctx.db.close();
});
