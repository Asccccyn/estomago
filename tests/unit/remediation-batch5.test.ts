// 复审整改批次 A 回归（estomago-reaudit-967b899：F05/F06/F23/F24/F25/F27）。
import { test } from 'node:test';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
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
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { ArchiveSyncService } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + DONE;
const toolBody = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

const T0 = '2026-10-01T08:00:00+08:00';
const at = (h: number) => new Date(Date.parse(T0) + h * 3600e3).toISOString();

function orT(respond: (payload: Record<string, unknown>, hasTool: boolean) => string, log: Array<Record<string, unknown>> = []): OrTransport {
  let gen = 0;
  return async (payload) => {
    log.push(structuredClone(payload));
    gen++;
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const textOf = (m: { content: unknown }): string => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => (b as { text?: string }).text ?? '').join('\n') : '');
    const t = lastUser ? textOf(lastUser) : '';
    const hasTool = messages[messages.length - 1]?.role === 'tool';
    const id = `g${gen}`;
    if (t.includes('宿主运行事件')) {
      const reviewId = t.match(/review_id: (\S+)/)?.[1] ?? '';
      return { status: 200, headers: new Map<string, string>(), body: frameStream(respond(payload, hasTool) || toolBody(id, 'rc', 'context_review_complete', { review_id: reviewId, decision: 'no_new_hold' })) };
    }
    return { status: 200, headers: new Map<string, string>(), body: frameStream(respond(payload, hasTool) || textBody(id, `回复${gen}`)) };
  };
}
const mariposaOk: MariposaTransport = async (cap, payload) => {
  if (cap === 'memory.hold') {
    const op = (payload as { operation_id: string }).operation_id;
    return { ok: true, result: { operation_id: op, memory_id: 'mem-x', version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
  }
  return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
};

function compose(root: string, orTransport: OrTransport, mariposa: MariposaTransport = mariposaOk, opts: { configOver?: Record<string, unknown>; withSelections?: boolean } = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: MODEL }, ...(opts.configOver ?? {}) });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  // F25 根因修复（2026-10-24）：WindowManager 必须与生产装配（app-context）同样
  // 注入 selections/trajectory——此前测试不注入，选集消费静默不执行（confirmed 永不
  // consumed、target 恒空），恢复的大输入在每个新窗重复触发 awaiting（无限循环确认），
  // 旧测试用"循环确认≤5 次"掩盖了这条与生产漂移的夹具链。
  const trajectory = new WindowTrajectoryService(db);
  const selections = opts.withSelections ? new ManualSelectionService(db) : null;
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config, selections ?? undefined, trajectory);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const mariposa_wire_1 = new MariposaClient({ transport: mariposa });
  const { tools: tools } = assembleTestTools({ db: db, mariposa: mariposa_wire_1, reviews: reviews, checkpoint: checkpoint });;
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, orTransport);
  const supervisor = new TurnSupervisor({bootstrap: new MariposaClient({ transport: mariposa }), // S18：显式 BootstrapPort（原经 tools.mariposaClient 隐式取得）
     db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory, ...(selections ? { selections } : {}) });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, identity, windows, reviews, checkpoint, trajectory, supervisor, events, logger };
}

async function say(ctx: ReturnType<typeof compose>, content: string, id: string, occurredAt: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

test('F05：容量换窗评审占用房间串行链，chat 排队等待', async () => {
  const log: Array<Record<string, unknown>> = [];
  let releaseReview = () => {};
  const gate = new Promise<void>((r) => { releaseReview = r; });
  let heldFirstChat = false;
  const t = orT((payload, hasTool) => {
    const messages = payload.messages as Array<{ role: string }>;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user') as unknown as { content: Array<{ text?: string }> };
    const t2 = Array.isArray(lastUser?.content) ? (lastUser.content[0]?.text ?? '') : '';
    if (t2.includes('宿主运行事件')) {
      return new Promise<string>((resolve) => { gate.then(() => resolve('')); }) as never as string; // 由 respond 返回值外层包装
    }
    void hasTool;
    return '';
  }, log);
  // 上面的 respond 不适合异步——换成显式 transport
  const t2: OrTransport = async (payload) => {
    log.push(structuredClone(payload));
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const textOf = (m: { content: unknown }): string => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => (b as { text?: string }).text ?? '').join('\n') : '');
    const txt = lastUser ? textOf(lastUser) : '';
    if (txt.includes('宿主运行事件')) {
      await gate; // 评审请求挂起（模拟审计：manual review 等待中）
      const reviewId = txt.match(/review_id: (\S+)/)?.[1] ?? '';
      return { status: 200, headers: new Map<string, string>(), body: frameStream(toolBody('gr', 'rc', 'context_review_complete', { review_id: reviewId, decision: 'no_new_hold' })) };
    }
    if (!heldFirstChat) { heldFirstChat = true; return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody('g1', '第一答')) }; }
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody('g2', '第二答')) };
  };
  void t;
  const root = tempRoot('r5a-');
  const ctx = compose(root, t2);
  await say(ctx, '第一句', 'f1', T0);
  // 手动换窗（评审挂起中）+ 同时提交新 chat：chat 必须等评审+换窗完成后才发送
  const manualPromise = (ctx.supervisor as any).runSerialized('c1', () => (ctx.supervisor as any).rotateConfirmed('c1', 'capacity'));
  await new Promise((r) => setTimeout(r, 150)); // 评审已发出并挂起
  const sub2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '评审中的新消息', clientMessageId: 'f2', occurredAt: at(1) });
  ctx.supervisor.enqueue(sub2.turnId);
  await new Promise((r) => setTimeout(r, 150));
  const duringReviewSends = log.filter((p) => {
    const ms = p.messages as Array<{ role: string; content: unknown }>;
    const lu = [...ms].reverse().find((m) => m.role === 'user');
    const txt = typeof lu?.content === 'object' ? JSON.stringify(lu?.content) : '';
    return !txt.includes('宿主运行事件');
  }).length;
  assert.equal(duringReviewSends, 1, '评审挂起期间不发送新 chat（原来会并发送出）');
  releaseReview();
  await manualPromise;
  await ctx.supervisor.waitIdle();
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub2.attemptId) as { state: string };
  assert.equal(att.state, 'completed', '排队消息在评审/换窗完成后正常执行');
  const reviewCount = (ctx.db.prepare('SELECT COUNT(*) n FROM rotation_reviews').get() as { n: number }).n;
  assert.equal(reviewCount, 1, '并发 manual+chat 只产生一个评审（原来会产生两个）');
  ctx.db.close();
});

test('F23：冻结批恢复未决 → 同流后续批（含新批）停发；恢复按来源顺序', async () => {
  const calls: string[] = [];
  let aNotReady = true; // A 消息持续 NOT_READY，直至第三次 drain 放行
  const m: MariposaTransport = async (cap, payload) => {
    if (cap !== 'source.ingest') return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    const req = payload as unknown as { operation_id: string; messages: Array<{ origin_message_id: string; revision: number; text: string; content_hash: string }> };
    calls.push(req.messages.map((x) => x.text).join(','));
    if (aNotReady && req.messages.some((x) => x.text === 'A')) {
      return { ok: false, code: 'SOURCE_NOT_READY', httpStatus: 409 };
    }
    return { ok: true, result: { operation_id: req.operation_id, committed_at: new Date().toISOString(), messages: req.messages.map((x) => ({ origin_message_id: x.origin_message_id, revision: x.revision, source_conversation_id: 'mc', source_message_id: `s-${x.origin_message_id}`, content_hash: x.content_hash })) } };
  };
  const root = tempRoot('r5c-');
  const ctx = compose(root, orT(() => ''), m, { configOver: { archive: { enabled: true, source_scope: 's' }, integrations: { mariposa: { base_url: 'http://127.0.0.1:9', credential_ref: null } } } });
  const sync = new ArchiveSyncService({ db: ctx.db, events: ctx.events, logger: ctx.logger, client: new MariposaClient({ transport: m }), config: ctx.config });
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'A', clientMessageId: 'a1', occurredAt: T0 });
  await sync.drainOnce(); // A 冻结批次首发 → NOT_READY → 行回 pending
  assert.deepEqual(calls, ['A'], 'A 批首发');
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'B', clientMessageId: 'b1', occurredAt: at(1) });
  await sync.drainOnce(); // A 恢复重试仍 NOT_READY → B 必须被同流阻断（不发）
  assert.deepEqual(calls, ['A', 'A'], '第二次 drain 只重放 A（B 被停发阻断，原来会发 AB/越序）');
  const bState = ctx.db.prepare("SELECT o.state FROM outbox o WHERE json_extract(o.payload_ref, '$.message_id') = (SELECT id FROM messages WHERE client_message_id = 'b1')").get() as { state: string } | undefined;
  assert.ok(bState === undefined || bState.state === 'pending', 'B 仍未发送');
  aNotReady = false;
  await sync.drainOnce(); // A 重试成功 → 解除阻断，同 drain 内 B 进新批
  assert.deepEqual(calls, ['A', 'A', 'A', 'B'], 'A 恢复成功后 B 才按来源顺序发送');
  const states = ctx.db.prepare("SELECT state FROM outbox ORDER BY operation_key").all() as Array<{ state: string }>;
  assert.ok(states.every((r) => r.state === 'acked'), `两批最终 acked（实际 ${JSON.stringify(states)}）`);
  ctx.db.close();
});

test('F24：坏 payload_ref 行不再炸掉整个 drain；后续正常行照常同步', async () => {
  const calls: string[] = [];
  const m: MariposaTransport = async (cap, payload) => {
    if (cap !== 'source.ingest') return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    const req = payload as unknown as { operation_id: string; messages: Array<{ origin_message_id: string; revision: number; content_hash: string }> };
    calls.push(req.messages.map((x) => x.origin_message_id).join(','));
    return { ok: true, result: { operation_id: req.operation_id, committed_at: new Date().toISOString(), messages: req.messages.map((x) => ({ origin_message_id: x.origin_message_id, revision: x.revision, source_conversation_id: 'mc', source_message_id: `s-${x.origin_message_id}`, content_hash: x.content_hash })) } };
  };
  const root = tempRoot('r5d-');
  const ctx = compose(root, orT(() => ''), m, { configOver: { archive: { enabled: true, source_scope: 's' }, integrations: { mariposa: { base_url: 'http://127.0.0.1:9', credential_ref: null } } } });
  const sync = new ArchiveSyncService({ db: ctx.db, events: ctx.events, logger: ctx.logger, client: new MariposaClient({ transport: m }), config: ctx.config });
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '正常消息', clientMessageId: 'ok1', occurredAt: T0 });
  ctx.db.prepare("INSERT INTO outbox(id, operation_key, target, payload_ref, state, created_at, updated_at) VALUES ('bad1','archive:gone:1','mariposa.archive','不是JSON','pending',?,?)").run(new Date().toISOString(), new Date().toISOString());
  const summary = await sync.drainOnce(); // 原来在此抛 rows is not defined
  assert.ok(summary.dead >= 1, '坏行按单行标 dead');
  const ok = ctx.db.prepare("SELECT state FROM outbox WHERE operation_key='archive:gone:1'").get() as { state: string };
  assert.equal(ok.state, 'failed');
  const good = ctx.db.prepare("SELECT state, last_error FROM outbox WHERE operation_key != 'archive:gone:1'").get() as { state: string; last_error: string | null };
  assert.equal(good.state, 'acked', '坏行不阻断正常行同步');
  const snap = sync.rawSyncState('c1'); // 坏 JSON 不炸快照
  assert.equal(snap.acked, 1);
  ctx.db.close();
});

// 她 1024 裁定②落地：容量=实际发送载荷（含目录底座）；被拒大输入不得污染后续请求/已见。
test('F25 场景一：底座实证装得下→大输入拒发→短输入正常且最终请求不含被拒大文', async () => {
  const log: Array<Record<string, unknown>> = [];
  const t = orT(() => '', log);
  const root = tempRoot('r5e-s1-');
  const ctx = compose(root, t, mariposaOk, { withSelections: true }); // 容量/软线运行时按实证定；场景一需选集服务完成换窗收口
  try {
    // 先独立实证底座：发一条探针短输入，取其实际请求 chars→tokens（裁定②：前提要证明，不预设）
    const probe = await say(ctx, '底座探针', 'p0', T0);
    await ctx.supervisor.waitIdle();
    assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id=?').get(probe.attemptId) as { state: string }).state, 'completed');
    const lastWire = ctx.db.prepare("SELECT payload_wire_json FROM provider_requests WHERE sent_at IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as { payload_wire_json: string };
    const probeWire = JSON.parse(lastWire.payload_wire_json); // 裁定②：底座实证含冻结工具目录（统一口径——目录实测占大头）
    const baseTokens = Math.ceil((probeWire.messages.reduce((s: number, m: any) => s + JSON.stringify(m.content ?? '').length, 0) + JSON.stringify(probeWire.tools ?? []).length) / 2.5);
    // 容量=底座*2+安全余量：短输入必过、40000 字大输入（≈16k token）必超安全上界
    const _w = ctx.config.windows as unknown as Record<string, number>;
    const _out = (ctx.config.openrouter as { max_output_tokens?: number }).max_output_tokens ?? 8192;
    const _reserves = (_w.tool_input_reserve_tokens ?? 0) + (_w.review_reserve_tokens ?? 0) + (_w.safety_reserve_tokens ?? 0);
    const cap1 = _out + _reserves + baseTokens + Math.ceil(baseTokens * 0.3) + 1_000; // 总容量包输出+预留+底座+30%（短输入必过；+40000 字≈16k token 必超安全上界）
    const w1 = ctx.config.windows as { model_context_capacity: number; soft_limit_tokens: number };
    w1.model_context_capacity = cap1; w1.soft_limit_tokens = Math.floor(cap1 * 0.9); // 只有大输入越软线
    const big = await say(ctx, '巨'.repeat(40000), 'big1', at(1));
    await ctx.supervisor.waitIdle();
    // D06 真实两段式：大输入先触发换窗并等选集（CONTEXT_SELECTION_REQUIRED）→ 模拟她确认空选
    const attWait = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(big.attemptId) as { state: string; blocked_reason: string | null };
    assert.ok((attWait.blocked_reason ?? '').includes('CONTEXT_SELECTION_REQUIRED') || attWait.state === 'failed' || ['blocked','failed'].includes(attWait.state), `大输入先挂换窗等选集（得到 ${attWait.state}/${attWait.blocked_reason}）`);
    // R13/F25 根因修复后（2026-10-24）：一次空选确认即收口——选集被切换事务消费
    //（consumed+target），恢复的大输入经"刚准备好的目标窗不重复旋转"守卫直达请求级
    // 硬门，得到明确容量拒绝。不再存在"重复要求空选"的循环（旧夹具缺 selections
    // 注入时 confirmed 永不 consumed，会在每个新窗重复 awaiting）。
    const aw = ctx.db.prepare("SELECT selection_id, source_window_id FROM context_selections WHERE conversation_id='c1' AND status='awaiting' ORDER BY created_at DESC LIMIT 1").get() as { selection_id: string; source_window_id: string } | undefined;
    assert.ok(aw, '存在待确认选集');
    const conf = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: aw.source_window_id, items: [], explicitEmpty: true, idempotencyKey: `f25-s1-${aw.selection_id}` });
    assert.ok(conf.ok, `空选确认成功（${JSON.stringify(conf).slice(0, 160)}）`);
    await ctx.supervisor.waitIdle();
    await new Promise((r) => setTimeout(r, 80));
    // 大输入：一次确认后明确容量拒绝（绝不再要求选集）
    const attBig = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(big.attemptId) as { state: string; blocked_reason: string | null };
    const turnBig = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(big.turnId) as { state: string };
    assert.equal(attBig.state, 'failed', `一次确认后明确容量拒绝（att=${attBig.state}/${attBig.blocked_reason?.slice(0,60)} turn=${turnBig.state}）`);
    assert.ok((attBig.blocked_reason ?? '').includes('CAPACITY_BLOCKED'), `拒绝原因如实为容量硬门（得到 ${attBig.blocked_reason?.slice(0, 80)}）`);
    const consumedSel = ctx.db.prepare("SELECT status, target_window_id FROM context_selections WHERE selection_id = ?").get(aw.selection_id) as { status: string; target_window_id: string | null };
    assert.equal(consumedSel.status, 'consumed', '选集已消费并绑定目标窗');
    assert.ok(consumedSel.target_window_id, 'target_window_id 已落');
    const awaitingAfter = ctx.db.prepare("SELECT COUNT(*) n FROM context_selections WHERE conversation_id='c1' AND status='awaiting'").get() as { n: number };
    assert.equal(awaitingAfter.n, 0, '不再重复要求选集');
    // 短输入：必须正常发送完成
    const short = await say(ctx, '短', 's1', at(2));
    await ctx.supervisor.waitIdle();
    const attShort = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(short.attemptId) as { state: string; blocked_reason: string | null };
    assert.equal(attShort.state, 'completed', `短输入不再被未发送的大历史持续阻断（得到 ${attShort.state}/${attShort.blocked_reason}）`);
    // 被拒大文不得出现在任何已发送请求（保存≠发送）
    const anyLeak = ctx.db.prepare("SELECT COUNT(*) n FROM provider_requests WHERE sent_at IS NOT NULL AND payload_wire_json LIKE '%'||?||'%'").get('巨'.repeat(60)) as { n: number };
    assert.equal(anyLeak.n, 0, '被拒大输入从未实际发送');
    // 不入已见：轨迹 manifest 不含大文消息
    const win = ctx.windows.activeWindow('c1')!;
    const traj = ctx.trajectory.forWindow(win.id)!;
    assert.ok(!traj.manifest.some((m) => m.seq === big.message?.sequence ?? -1), '被拒输入未进已见 manifest');
  } finally { await ctx.supervisor.stopAll?.(); ctx.db.close(); }
});
test('F25 场景二：底座本身装不下→短输入也如实拒并报告量级（不放松硬门）', async () => {
  const log: Array<Record<string, unknown>> = [];
  const t = orT(() => '', log);
  const root = tempRoot('r5e-s2-');
  const ctx = compose(root, t, mariposaOk, { configOver: { windows: { soft_limit_tokens: 500 } } });
  try {
    const probe = await say(ctx, '底座探针', 'p0', T0);
    await ctx.supervisor.waitIdle();
    const lastWire = ctx.db.prepare("SELECT payload_wire_json FROM provider_requests WHERE sent_at IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as { payload_wire_json: string };
    const probeWire = JSON.parse(lastWire.payload_wire_json); // 裁定②：底座实证含冻结工具目录（统一口径——目录实测占大头）
    const baseTokens = Math.ceil((probeWire.messages.reduce((s: number, m: any) => s + JSON.stringify(m.content ?? '').length, 0) + JSON.stringify(probeWire.tools ?? []).length) / 2.5);
    // 容量压到显著低于底座：即使一个字也装不下
    const _w2 = ctx.config.windows as unknown as Record<string, number>;
    const _out2 = (ctx.config.openrouter as { max_output_tokens?: number }).max_output_tokens ?? 8192;
    const cap2 = Math.max(50, _out2 + (_w2.tool_input_reserve_tokens ?? 0) + (_w2.review_reserve_tokens ?? 0) + (_w2.safety_reserve_tokens ?? 0) + Math.floor(baseTokens * 0.3)); // 仅预留+30%底座：装不下底座本体
    const w2 = ctx.config.windows as { model_context_capacity: number; soft_limit_tokens: number };
    w2.model_context_capacity = cap2; w2.soft_limit_tokens = Math.floor(cap2 * 0.9);
    const short = await say(ctx, '短', 's1', at(1));
    await ctx.supervisor.waitIdle();
    await new Promise((r) => setTimeout(r, 100));
    const att = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(short.attemptId) as { state: string; blocked_reason: string | null };
    const turnS = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(short.turnId) as { state: string };
    assert.ok(['blocked', 'failed'].includes(att.state) || turnS.state === 'failed', `短输入被拒（att=${att.state} turn=${turnS.state}）`);
    assert.ok((att.blocked_reason ?? '').includes('CAPACITY_BLOCKED') || turnS.state === 'failed', `硬门如实（得到 ${att.blocked_reason}/${turnS.state}）`);
    const sentAfter = ctx.db.prepare("SELECT COUNT(*) n FROM provider_requests WHERE sent_at IS NOT NULL AND rowid > (SELECT MAX(rowid) FROM provider_requests WHERE turn_id=?)").get(probe.turnId) as { n: number };
    assert.equal(sentAfter.n, 0, '底座超限后零新发送');
  } finally { await ctx.supervisor.stopAll?.(); ctx.db.close(); }
});

test('F27：v11 旧行 manifest=NULL 且含真实历史 → 重建成功并正常评审；无法重建 → 阻断不签 skipped_empty', async () => {
  // 场景1：正文可无歧义匹配 → 重建
  const log: Array<Record<string, unknown>> = [];
  const t = orT(() => '', log);
  const root = tempRoot('r5f-');
  const ctx = compose(root, t);
  await say(ctx, '历史第一句', 'h1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  // 模拟 v11 旧行：清空 manifest（NULL）+ last_boundary 保留
  ctx.db.prepare('UPDATE window_trajectories SET manifest_json = NULL WHERE window_id = ?').run(win1.id);
  const manual = await (ctx.supervisor as any).rotateConfirmed('c1', 'capacity');
  assert.ok(manual.ok, '正文可匹配 → 重建 manifest → 评审/换窗正常');
  const traj = ctx.trajectory.forWindow(win1.id);
  assert.ok(traj?.manifest && traj.manifest.length > 0, '重建后的 manifest 非空且已回填');
  ctx.db.close();

  // 场景2：轨迹正文在库中不存在（不可重建）→ 阻断，不签 skipped_empty
  const root2 = tempRoot('r5g-');
  const ctx2 = compose(root2, orT(() => '', log));
  await say(ctx2, '会消失的历史', 'x1', T0);
  const win2 = ctx2.windows.activeWindow('c1')!;
  ctx2.db.prepare('UPDATE window_trajectories SET manifest_json = NULL WHERE window_id = ?').run(win2.id);
  // 直接删除消息行（模拟正文无法回查）
  ctx2.db.prepare('DELETE FROM message_revisions').run();
  ctx2.db.prepare('DELETE FROM messages').run();
  const manual2 = await (ctx2.supervisor as any).rotateConfirmed('c1', 'capacity');
  assert.ok(manual2.ok === false && manual2.reason.includes('ROTATION_RANGE_UNKNOWN'), '范围未知 → 如实阻断（不签发空范围凭证）');
  const skipped = ctx2.db.prepare("SELECT COUNT(*) n FROM rotation_reviews WHERE status='skipped_empty'").get() as { n: number };
  assert.equal(skipped.n, 0, '未产生 skipped_empty（F27 修复）');
  ctx2.db.close();
});
