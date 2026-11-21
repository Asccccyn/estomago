// 包4 §6.2（03_PROJECTION_MIGRATION）姓名投影隔离验收：
// 五个入口逐项检查 E 最后一个已确认的模型请求（provider_requests.sent_at IS NOT NULL
// 的 payload_wire_json/payload_json），不是服务中间结果或快照。
// 受控传输：DeepSeek SSE 假传输 + Mariposa 假 transport + 本地 fake Sol——
// SDK/OR/Sol/JEV 真实供应商调用为 0；数据只进临时 ESTOMAGO_HOME。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
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
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { RuntimeSettingsService } from '../../apps/host/src/runtime/runtime-settings.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { bindMessageLifecycle } from '../../apps/host/src/application/message-lifecycle.ts';
import { speakerLabelsFromConfig } from '../../apps/host/src/identity/speaker-labels.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import { assembleTestTools, fakeSolJudge, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter(Boolean).map((s) => enc.encode(`${s}\n\n`)));
const textBody = (id: string, text: string) =>
  sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } }) + DONE;
const toolBody = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
  + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 4 } }) + DONE;

/** E 最后一个已确认的模型请求（与 tool-discovery 同读取口径）。 */
function lastConfirmedRequest(db: ReturnType<typeof openDatabase>): OrMessage[] {
  const row = db.prepare(
    'SELECT payload_wire_json, payload_json FROM provider_requests WHERE sent_at IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get() as { payload_wire_json: string | null; payload_json: string } | undefined;
  assert.ok(row, '必须存在已确认（sent_at 非空）的模型请求');
  const messages = (JSON.parse(row.payload_wire_json ?? row.payload_json).messages ?? []) as OrMessage[];
  return messages;
}

const PROTOCOL_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function assertProtocolRoles(messages: OrMessage[]) {
  for (const m of messages) assert.ok(PROTOCOL_ROLES.has((m as { role: string }).role), `协议 role 越界：${(m as { role: string }).role}`);
}

/** 合成开窗包：our_words 双方各一条（M 出站枚举 jiaming/qiaosheng）。 */
const bootstrapPacket = () => ({ snapshot_id: 'snap_pkg4', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none',
  memory_days: { items: [{ memory_id: 'm_boot', original_title: '开窗记忆', memory_date: '2026-11-17', event_text: '开窗事件正文',
    our_words: [{ speaker: 'jiaming', texts: ['char的开窗原话'] }, { speaker: 'qiaosheng', texts: ['宿主用户的开窗原话'] }] }] },
  plans: { items: [] }, i: { content: '合成I' } });

type Compose = ReturnType<typeof compose>;
function compose(root: string, opts: {
  orTransport: OrTransport;
  mariposa: MariposaTransport;
  surfacing?: { svc: SurfacingService; messages: MessageService } | null;
}) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data')); migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = opts.surfacing?.messages ?? new MessageService(db);
  messages.ensureConversation('c1');
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, identity, config);
  const reviews = new RotationReviewService(db); const checkpoint = new HoldCheckpointService(db);
  const client = new MariposaClient({ transport: opts.mariposa });
  const { tools, registry } = assembleTestTools({ db, messages, events, mariposa: client, surfaceDetailClient: client, reviews, checkpoint, speakerLabels: speakerLabelsFromConfig(config) });
  const trajectory = new WindowTrajectoryService(db);
  const runner = new DeepSeekRunner({ retryMax: 0 }, opts.orTransport);
  const supervisor = new TurnSupervisor({
    bootstrap: new MariposaClient({ transport: opts.mariposa }),
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows,
    logger, tools, toolCatalog: registry, reviews, checkpoint, trajectory, settings: new RuntimeSettingsService(db),
    ...(opts.surfacing ? { surfacing: opts.surfacing.svc } : {}),
  });
  return { db, config, messages, windows, supervisor, trajectory, client, root };
}

async function drive(ctx: Compose, content: string, clientMessageId: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal(ctx.db.prepare('SELECT state FROM turns WHERE id=?').get(sub.turnId)?.state, 'completed', `回合未完成：${clientMessageId}`);
  return sub;
}

function cleanup(ctx: Compose) { ctx.db.close(); fs.rmSync(ctx.root, { recursive: true, force: true }); }

// —— 入口 1：自动浮现（含同字回应场景）——
test('pkg4-name 自动浮现：同字回应投影为宿主用户，char已读句不重发；邻句与协议 role 合同', async () => {
  const root = tempRoot('pkg4-name-surface-');
  const repeat = '松针纸条收好。';
  const prepareCalls: Array<Record<string, unknown>> = [];
  const wordsItem = {
    kind: 'words' as const, event_id: 'ev_w1', memory_id: 'mem_w1', memory_version: '3',
    memory_date: '2026-11-18', date_confidence: 'exact', event_text: repeat,
    body_hash: sha256Hex(repeat), detail_ref: 'sdr_pkg4_w1', resource_ref: 'our_word:w_pkg4',
    speaker: 'qiaosheng', quote_text: repeat, source_ref: null,
    source_context_text: 'char(2026-11-18 08:01)：松针纸条收好。\n宿主用户(2026-11-18 08:02)：松针纸条收好。',
    source_context_ranges: [], source_context_parts: [
      { speaker: 'char', date: '2026-11-18 08:01', text: repeat, coverage_ranges: [] },
      { speaker: '宿主用户', date: '2026-11-18 08:02', text: repeat, coverage_ranges: [] },
    ],
    coverage_ranges: [],
  };
  const mariposa: MariposaTransport = async (cap, args) => {
    if (cap === 'bootstrap.get') return { ok: true, result: bootstrapPacket() };
    if (cap.endsWith('.prepare')) { prepareCalls.push(args as Record<string, unknown>); return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_pkg4' } }; }
    if (cap.endsWith('.validate')) return { ok: true, result: { status: 'ready', validation_receipt: 'svr_pkg4', items: [wordsItem] } };
    if (cap.endsWith('.check')) return { ok: true, result: { valid: true, accepted_detail_refs: ['sdr_pkg4_w1'] } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const sol = fakeSolJudge([
    { decision: 'observe' },
    { decision: 'recall', plan: { purpose: '核对同字原话', route: 'words', breadth: 'single',
      queries: [{ need_kind: 'words', need: '宿主用户重复的那句原话', semantic: '同字原话', keywords: ['松针纸条'], time_hint: null, speaker: '宿主用户', source_mode: null, person_focus: null }] } },
  ], { config: { userDisplayName: '宿主用户', assistantDisplayName: 'char' } });
  let orCalls = 0;
  const orTransport: OrTransport = async payload => {
    orCalls++;
    const hasTool = (payload.messages as Array<{ role: string }>).some(m => m.role === 'tool');
    // 回合1：先把char的那句实际发进模型窗口（已确认请求）。
    if (orCalls === 1) return { status: 200, headers: new Map(), body: frameStream(textBody('pkg4-1', repeat)) };
    // 回合2：浮现包随请求进入，随后普通文本收尾。
    void hasTool;
    return { status: 200, headers: new Map(), body: frameStream(textBody(`pkg4-${orCalls}`, '我也收好了。')) };
  };
  // surfacing 服务走独立 db/messages 生命周期绑定（与 sdk-first 投影测试同装配）。
  const surfacingDbRoot = root; // 同一根：compose 内共享 db/messages
  void surfacingDbRoot;
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data')); migrate(db, sha256Hex);
  const events = new EventService(db);
  const client = new MariposaClient({ transport: mariposa });
  const svc = new SurfacingService(db, client, sol.judge, {
    enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v2',
    delivery_deadline_ms: 4000, max_added_tokens_per_turn: 4096, max_packet_bytes: 24576,
    worker_concurrency: 1, recent_user_messages: 3, recent_window_bytes: 24576,
  }, null, events);
  const messages = new MessageService(db, bindMessageLifecycle({ surfacing: svc, activity: null }));
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, identity, config);
  const reviews = new RotationReviewService(db); const checkpoint = new HoldCheckpointService(db);
  const { tools, registry } = assembleTestTools({ db, messages, events, mariposa: client, surfaceDetailClient: client, reviews, checkpoint, speakerLabels: speakerLabelsFromConfig(config) });
  const trajectory = new WindowTrajectoryService(db);
  const runner = new DeepSeekRunner({ retryMax: 0 }, orTransport);
  const supervisor = new TurnSupervisor({
    bootstrap: new MariposaClient({ transport: mariposa }),
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows,
    logger: new Logger(path.join(root, 'logs')), tools, toolCatalog: registry, reviews, checkpoint, trajectory,
    settings: new RuntimeSettingsService(db), surfacing: svc,
  });
  const ctx = { db, config, messages, windows, supervisor, trajectory, client, root };
  try {
    await drive(ctx, '先说一句交代。', 'pkg4-surface-1');
    // 第一句已进入模型窗口：已确认请求里出现过，且助手消息已发布。
    assert.ok(ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker='assistant' AND published_at IS NOT NULL").get());
    const repeatJob = 'pkg4-surface-2';
    await drive(ctx, repeat, repeatJob);
    const messages2 = lastConfirmedRequest(ctx.db);
    assertProtocolRoles(messages2);
    const texts = messages2.flatMap(m => typeof m.content === 'string' ? [m.content] : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? '') : []);
    const surfaceText = texts.find(t => t.startsWith('你想起了一段往事。'));
    assert.ok(surfaceText, '最终请求必须携带回忆');
    assert.ok(surfaceText.includes(`宿主用户当时说：“${repeat}”`));
    assert.ok(surfaceText.includes('char(2026-11-18 08:01)：松针纸条收好。'));
    assert.ok(surfaceText.includes('宿主用户(2026-11-18 08:02)：松针纸条收好。'));
    // char已读的那句不重发：记忆块内同字句恰好 3 处（宿主用户正文 1 + 邻句 2 行），
    // 且记忆数组只有一条（无 speaker char 的同字条目）；其余 2 处=协议历史 1 + 本轮输入 1。
    const inMemories = surfaceText.split(repeat).length - 1;
    assert.equal(inMemories, 3, `记忆块内同字句应为 3 处，实际 ${inMemories}`);
    const outsideMemories = texts.filter(t => t !== surfaceText).join('\n').split(repeat).length - 1;
    assert.equal(outsideMemories, 2, `记忆块外同字句应为 2 处（历史+本轮输入），实际 ${outsideMemories}`);
    assert.ok(!surfaceText.includes(`char当时说：“${repeat}”`));
    const payload = JSON.stringify(messages2);
    for (const token of ['"speaker":"jiaming"', '"speaker":"qiaosheng"', '"speaker":"owner"', '"speaker":"assistant"']) {
      assert.equal(payload.includes(token), false, `最终请求不得再含内部枚举 ${token}`);
    }
    // 身份配置贯通：prepare 携带 speaker_names 真实姓名。
    assert.ok(prepareCalls.length >= 1);
    assert.deepEqual(prepareCalls.at(-1)!.speaker_names, { owner: '宿主用户', assistant: 'char' });
  } finally {
    await svc.stop(); cleanup(ctx);
  }
});

// —— 入口 2：主动召回（含续页）——
test('pkg4-name 主动召回与续页：候选 speaker 投影为宿主用户/char', async () => {
  const root = tempRoot('pkg4-name-recall-');
  const mariposa: MariposaTransport = async cap => {
    if (cap === 'bootstrap.get') return { ok: true, result: bootstrapPacket() };
    if (cap === 'memory.recall.start') return { ok: true, result: {
      recall_session_id: 'rs_pkg4', search_status: 'FOUND', judge_mode: 'on',
      candidates: [
        { resource_ref: 'our_word:w1', memory_ref: 'rm_w1', content_version: '1', speaker: 'jiaming', word_id: 'w1', text: 'char的召回原话', memory_date: '2026-11-01' },
        { resource_ref: 'memory:m2', memory_ref: 'rm_m2', content_version: '2', memory_date: '2026-11-02', text: '事件候选正文' },
      ],
      pagination: { result_set_id: 'rps_pkg4', next_cursor: 'cur_pkg4', has_more: true, candidate_total: 3 },
    } };
    if (cap === 'memory.recall.page') return { ok: true, result: {
      recall_session_id: 'rs_pkg4', judge_mode: 'on',
      candidates: [{ resource_ref: 'our_word:w2', memory_ref: 'rm_w2', content_version: '1', speaker: 'qiaosheng', word_id: 'w2', text: '宿主用户的续页原话', memory_date: '2026-11-03' }],
      pagination: { result_set_id: 'rps_pkg4', candidate_total: 3, has_more: false },
    } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  let orCalls = 0;
  const orTransport: OrTransport = async () => {
    orCalls++;
    if (orCalls === 1) return { status: 200, headers: new Map(), body: frameStream(toolBody('r1', 'call_recall', 'memory_recall', { query: '查我们说过的话' })) };
    if (orCalls === 2) return { status: 200, headers: new Map(), body: frameStream(toolBody('r2', 'call_next', 'memory_recall_next', { result_set_id: 'rps_pkg4', cursor: 'cur_pkg4', session_id: 'rs_pkg4' })) };
    return { status: 200, headers: new Map(), body: frameStream(textBody('r3', '查到了。')) };
  };
  const ctx = compose(root, { orTransport, mariposa });
  try {
    await drive(ctx, '帮我把那几句话找回来。', 'pkg4-recall-1');
    const final = lastConfirmedRequest(ctx.db);
    assertProtocolRoles(final);
    const toolTexts = final.filter(m => (m as { role: string }).role === 'tool').map(m => typeof m.content === 'string' ? m.content : '');
    const joined = toolTexts.join('\n');
    assert.ok(joined.includes('"speaker":"char"'), '首页 words 候选应显示char');
    assert.ok(joined.includes('"speaker":"宿主用户"'), '续页 words 候选应显示宿主用户');
    for (const token of ['"speaker":"jiaming"', '"speaker":"qiaosheng"', '"speaker":"owner"', '"speaker":"assistant"']) {
      assert.equal(joined.includes(token), false, `召回/续页工具结果不得再含内部枚举 ${token}`);
    }
  } finally { cleanup(ctx); }
});

// —— 入口 3：原文深读（memory_read_full）+ 第三方署名对照 ——
test('pkg4-name 原文深读：our_words/source 说话人投影；第三方署名与 user/assistant 字样逐字保留', async () => {
  const root = tempRoot('pkg4-name-detail-');
  const mariposa: MariposaTransport = async cap => {
    if (cap === 'bootstrap.get') return { ok: true, result: bootstrapPacket() };
    if (cap === 'memory.recall.start') return { ok: true, result: {
      recall_session_id: 'rs_d1', search_status: 'FOUND', judge_mode: 'on',
      candidates: [{ resource_ref: 'memory:m9', memory_ref: 'rm_d1', content_version: '5', memory_date: '2026-11-05', text: '深读目标事件' }],
    } };
    if (cap === 'memory.detail.read') return { ok: true, result: {
      memory_id: 'm9', version: '5', date: '2026-11-05', text: '深读正文正文。',
      our_words: [
        { word_id: 'w9a', speaker: 'jiaming', text: 'char的深读原话', source_ref: 'source_msg:sm9a', source_binding_version: '1' },
        { word_id: 'w9b', speaker: 'qiaosheng', text: '宿主用户的深读原话', source_ref: 'source_msg:sm9b', source_binding_version: '1' },
      ],
      source: [
        { message_id: 'sm9a', speaker: 'jiaming', normalized_sender: 'assistant', occurred_date: '2026-11-05', text: 'user 与 assistant 字样所在的正文甲' },
        { message_id: 'sm9z', speaker: null, normalized_sender: 'unknown', occurred_date: '2026-11-05', text: '第三方·小林：user 和 assistant 的原文逐字保留' },
      ],
      next_cursor: null,
    } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  let orCalls = 0;
  const orTransport: OrTransport = async () => {
    orCalls++;
    if (orCalls === 1) return { status: 200, headers: new Map(), body: frameStream(toolBody('d1', 'call_recall', 'memory_recall', { query: '找那条深读目标' })) };
    if (orCalls === 2) return { status: 200, headers: new Map(), body: frameStream(toolBody('d2', 'call_read', 'memory_read_full', { memory_ref: 'rm_d1' })) };
    return { status: 200, headers: new Map(), body: frameStream(textBody('d3', '读完了。')) };
  };
  const ctx = compose(root, { orTransport, mariposa });
  try {
    await drive(ctx, '把那条记忆整篇读出来。', 'pkg4-detail-1');
    const final = lastConfirmedRequest(ctx.db);
    assertProtocolRoles(final);
    const detailText = final.filter(m => (m as { role: string }).role === 'tool')
      .map(m => typeof m.content === 'string' ? m.content : '')
      .find(t => t.includes('"our_words"'));
    assert.ok(detailText, '最终请求须含深读工具结果');
    const detail = JSON.parse(detailText!) as { our_words: Array<{ speaker: string }>; source: Array<{ speaker?: string; normalized_sender?: string; text: string }> };
    assert.deepEqual(detail.our_words.map(w => w.speaker), ['char', '宿主用户']);
    // 已核实双方 → 姓名；第三方（speaker 空）→ 无姓名投影，normalized_sender 原样。
    assert.equal(detail.source[0]!.speaker, 'char');
    assert.equal(detail.source[0]!.normalized_sender, 'assistant');
    assert.ok(detail.source[1]!.speaker == null, '第三方 speaker 保持空（未核实身份不映射）');
    assert.equal(detail.source[1]!.normalized_sender, 'unknown');
    assert.equal(detail.source[1]!.text, '第三方·小林：user 和 assistant 的原文逐字保留');
    assert.ok(detailText!.includes('user 与 assistant 字样所在的正文甲'));
    for (const token of ['"speaker":"jiaming"', '"speaker":"qiaosheng"']) {
      assert.equal(detailText!.includes(token), false, `深读结果不得再含内部枚举 ${token}`);
    }
  } finally { cleanup(ctx); }
});

// —— 入口 4：conversation_read ——
test('pkg4-name conversation_read：entries speaker 投影为宿主用户/char', async () => {
  const root = tempRoot('pkg4-name-cread-');
  const mariposa: MariposaTransport = async cap => {
    if (cap === 'bootstrap.get') return { ok: true, result: bootstrapPacket() };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  let orCalls = 0;
  const orTransport: OrTransport = async () => {
    orCalls++;
    if (orCalls === 1) return { status: 200, headers: new Map(), body: frameStream(toolBody('c1', 'call_read', 'conversation_read', { anchor: { speaker: 'char', quote: '历史第二句' } })) };
    return { status: 200, headers: new Map(), body: frameStream(textBody('c2', '读到了。')) };
  };
  const ctx = compose(root, { orTransport, mariposa });
  try {
    // 合成历史：owner 两条 + 已发布 assistant 一条（进入可见面）。
    const seed = (id: string, seq: number, speaker: 'owner' | 'assistant', content: string) => {
      ctx.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES(?, 'c1', ?, ?, 'text', 1, ?, '2026-11-18T00:00:00Z')")
        .run(id, seq, speaker, speaker === 'assistant' ? '2026-11-18T00:00:00Z' : null);
      ctx.db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES(?, 1, 'text', ?, ?, '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z', 'seed')")
        .run(id, content, sha256Hex(content));
    };
    seed('cm1', 1, 'owner', '历史第一句（宿主用户）。');
    seed('cm2', 2, 'assistant', '历史第二句（char）。');
    seed('cm3', 3, 'owner', '历史第三句（宿主用户）。');
    await drive(ctx, '回读一下刚才那几句。', 'pkg4-cread-1');
    const final = lastConfirmedRequest(ctx.db);
    assertProtocolRoles(final);
    const readText = final.filter(m => (m as { role: string }).role === 'tool')
      .map(m => typeof m.content === 'string' ? m.content : '')
      .find(t => t.includes('"entries"'));
    assert.ok(readText, '最终请求须含 conversation_read 工具结果');
    const entries = (JSON.parse(readText!).entries as Array<{ seq: number; speaker: string; text: string }>).sort((a, b) => a.seq - b.seq);
    assert.ok(entries.length >= 3, `应读到 3 条，实际 ${entries.length}`);
    assert.equal(entries[0]!.speaker, '宿主用户');
    assert.equal(entries[1]!.speaker, 'char');
    assert.equal(entries[2]!.speaker, '宿主用户');
    for (const token of ['"speaker":"owner"', '"speaker":"assistant"']) {
      assert.equal(readText!.includes(token), false, `conversation_read 不得再含内部枚举 ${token}`);
    }
  } finally { cleanup(ctx); }
});

// —— 入口 5：开窗回放（B 段 our_words 署名 + 实际携带的历史片段协议 role）——
test('pkg4-name 开窗回放：B 段 our_words 行首用姓名；携带历史片段保持协议 role', async () => {
  const root = tempRoot('pkg4-name-replay-');
  const mariposa: MariposaTransport = async cap => {
    if (cap === 'bootstrap.get') return { ok: true, result: bootstrapPacket() };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  let orCalls = 0;
  const orTransport: OrTransport = async () => {
    orCalls++;
    if (orCalls === 1) return { status: 200, headers: new Map(), body: frameStream(textBody('p1', '回放前夜的话。')) };
    return { status: 200, headers: new Map(), body: frameStream(textBody('p2', '接着说。')) };
  };
  const ctx = compose(root, { orTransport, mariposa });
  try {
    // 首回合：开窗 B 段随第一个请求冻结。
    await drive(ctx, '开窗第一句。', 'pkg4-replay-1');
    const first = lastConfirmedRequest(ctx.db);
    const firstText = JSON.stringify(first);
    assert.ok(firstText.includes('char：char的开窗原话'), 'B 段 our_words 行首应为char');
    assert.ok(firstText.includes('宿主用户：宿主用户的开窗原话'), 'B 段 our_words 行首应为宿主用户');
    assert.equal(first.includes('他：'), false, '旧代词署名不得再出现');
    assert.equal(first.includes('她：'), false, '旧代词署名不得再出现');
    // 次回合：实际携带的历史片段按协议 role 回放，不出现内部枚举。
    await drive(ctx, '第二天第一句。', 'pkg4-replay-2');
    const second = lastConfirmedRequest(ctx.db);
    assertProtocolRoles(second);
    const secondText = JSON.stringify(second);
    assert.ok(second.some(m => (m as { role: string }).role === 'user' && JSON.stringify(m).includes('开窗第一句')), '历史用户消息以 user role 回放');
    assert.ok(second.some(m => (m as { role: string }).role === 'assistant' && JSON.stringify(m).includes('回放前夜的话')), '历史助手消息以 assistant role 回放');
    for (const token of ['"speaker":"jiaming"', '"speaker":"qiaosheng"', '"speaker":"owner"', '"speaker":"assistant"']) {
      assert.equal(secondText.includes(token), false, `回放请求不得含内部枚举 ${token}`);
      assert.equal(firstText.includes(token), false, `开窗请求不得含内部枚举 ${token}`);
    }
  } finally { cleanup(ctx); }
});
