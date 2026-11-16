// 包2 批D（2026-11-16）：交叉联验——各批隔离验证之外的组合场景（04 §2.D）。
// ①SDK 与 API 双投影分别核对（DBG-07 引导语归位后）：同一选集窗场景，SDK 走真实
//   ClaudeSdkRunner→runSdkHostQuery 转换链（systemPrompt 不含引导语；引导语并回后继
//   历史消息文本块头部、两段顺序保持）；API/DS 信封里引导语 system 块原位带 guide 标记、
//   A 段正本不含引导语。
// ②BIND 午夜批处理 × 聊天回合并发（B12）：聊天回合在途时维护批照常处理（聊天不等待）、
//   任务零聊天消息写入、window_toolsets/context_selections/window_trajectories 不被任务
//   触碰、绑定经真实 SourceBindingService 写入桩 M。
// ③编辑冲突 × 存档三种定位的协作语义在 archives.test ARC-26（复用 content 夹具）。
// 全链真实生产代码（TurnSupervisor/窗口装配/SDK 转换/SourceBindingService），fake 只在
// transport 边界（OR/DS/SDK query/M/GLM）。真实付费调用未执行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex, genId } from '../../apps/host/src/util/id.ts';
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
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { SubscriptionAccessRunner } from '../../apps/host/src/runtime/subscription-access.ts';
import { RuntimeSettingsService } from '../../apps/host/src/runtime/runtime-settings.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { GlmChatAdapter, type GlmChatTransport } from '../../apps/host/src/integrations/glm/chat.ts';
import { SourceBindingService } from '../../apps/host/src/modules/sourcebinding/service.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));

const mariposaOk: MariposaTransport = async () => ({ ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 });
const SOFT = { windows: { soft_limit_tokens: 27_630 /* Codex P2-1：里程碑文案 +50B≈+80 token；包2 DBG-04：锚点参数 +722B≈+400 token（同 wp3 系） */ } };
const dayAgo = (n: number): string => new Date(Date.now() - n * 86400_000).toISOString();

function seedHist(db: ReturnType<typeof openDatabase>, id: string, content: string, seq: number, speaker: 'owner' | 'assistant', occurredAt: string): void {
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES (?,'c1',?,?,'text',1,?,?)").run(id, seq, speaker, occurredAt, occurredAt);
  db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,?,?,?,'seed')").run(id, content, sha256Hex(content), occurredAt, occurredAt);
}

/** 选集窗场景（容量路径）：首条建窗→种两条跨日历史（seq 10/11）→长输入触发换窗→确认选集→恢复。 */
async function driveSelectionWindow(ctx: {
  db: ReturnType<typeof openDatabase>; messages: MessageService; supervisor: TurnSupervisor; windows: WindowManager;
}, confirmKey: string): Promise<void> {
  const s1 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '今天聊点新的', clientMessageId: 'bd-m1', occurredAt: dayAgo(4) });
  ctx.supervisor.enqueue(s1.turnId);
  await ctx.supervisor.waitIdle();
  const win1 = ctx.windows.activeWindow('c1')!;
  seedHist(ctx.db, 'bd-h1', '十月早餐桌上的原话', 10, 'owner', dayAgo(3));
  seedHist(ctx.db, 'bd-h2', '第二天我们确认了菜单', 11, 'assistant', dayAgo(1));
  const longInput = `第二段很长的输入，用于越过软线触发换窗。${'内容填充。'.repeat(2500)}`; // 覆盖不同模型 charsPerToken 估算档位都越过软线（capacity 未测量=无硬门）
  const s2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: longInput, clientMessageId: 'bd-m2', occurredAt: dayAgo(1) });
  ctx.supervisor.enqueue(s2.turnId);
  await ctx.supervisor.waitIdle();
  const att2 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(s2.attemptId) as { state: string; blocked_reason: string | null };
  assert.equal(att2.state, 'blocked', '长输入按预期等待选集（前置：换窗已触发）');
  assert.ok(att2.blocked_reason!.startsWith('CONTEXT_SELECTION_REQUIRED'));
  const confirm = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: win1.id, items: [{ message_id: 'bd-h1' }, { message_id: 'bd-h2' }], explicitEmpty: false, idempotencyKey: confirmKey });
  assert.equal(confirm.ok, true, JSON.stringify(confirm));
  await ctx.supervisor.waitIdle();
  const turn2 = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(s2.turnId) as { state: string };
  assert.equal(turn2.state, 'completed', '确认选集后被阻断输入恢复完成');
}

function baseDeps(root: string, config: ReturnType<typeof buildConfig>) {
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const selections = new ManualSelectionService(db);
  const windows = new WindowManager(db, identity, config, selections);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const mariposa = new MariposaClient({ transport: mariposaOk });
  const { tools, registry } = assembleTestTools({ db, mariposa, reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  messages.ensureConversation('c1');
  return { db, messages, identity, routing, selections, windows, reviews, checkpoint, mariposa, tools, registry, trajectory, events, logger };
}

test('BD-1 (SDK 投影): 选集引导语经真实 SDK 转换链——systemPrompt 不含引导语，并回后继历史消息头部且两段顺序保持', async () => {
  const root = tempRoot('bd-sdk-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter', access_policy: 'subscription-first', model: 'claude-sonnet-4-6', subscription_proxy_url: 'http://127.0.0.1:1' }, openrouter: { model: 'anthropic/claude-sonnet-4.6' }, reminders: { enabled: false }, ...SOFT });
  const d = baseDeps(root, config);
  const captures: Array<{ systemPrompt: string; frames: Array<{ type: string; message: { role: string; content: Array<{ type: string; text?: string }> } }> }> = [];
  const fakeQuery = ((input: { prompt: AsyncIterable<unknown>; options: { systemPrompt?: string | string[] } }) => {
    const sp = Array.isArray(input.options?.systemPrompt) ? input.options!.systemPrompt.join('\n') : String(input.options?.systemPrompt ?? '');
    const frames: Array<{ type: string; message: { role: string; content: Array<{ type: string; text?: string }> } }> = [];
    captures.push({ systemPrompt: sp, frames });
    const run = (async function* () {
      // 真实重放回执协议（同 frozen 测试）：历史帧逐帧 echo+result 确认，到当前输入帧后给模型应答
      const hasCurrent = yield* scriptedSdkInput(input, 'sess-bd1', (frame, history) => {
        for (const h of history) frames.push(h as never);
        frames.push(frame as never);
      });
      if (!hasCurrent) return;
      yield { type: 'assistant', session_id: 'sess-bd1', message: { id: 'm-bd1', content: [{ type: 'text', text: '好的' }] } };
      yield { type: 'stream_event', session_id: 'sess-bd1', event: { type: 'message_start', message: { id: 'm-bd1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 0 } } } };
      yield { type: 'stream_event', event: { type: 'message_stop' } };
      yield { type: 'result', subtype: 'success', session_id: 'sess-bd1', is_error: false, duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {}, result: 'ok' };
    })();
    return Object.assign(run, { close() {}, accountInfo: async () => ({ apiProvider: 'firstParty' }), usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: false } } }) });
  }) as never;
  const settings = new RuntimeSettingsService(d.db);
  settings.set('access_policy', 'subscription-first');
  const runner = new SubscriptionAccessRunner(config, settings, async () => ({ status: 'ok', runner: new ClaudeSdkRunner(fakeQuery) }));
  const supervisor = new TurnSupervisor({ db: d.db, config, messages: d.messages, events: d.events, identity: d.identity, windows: d.windows, trajectory: d.trajectory, settings, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(d.db, d.events), usage: new UsageCollector(d.db), routing: d.routing, logger: d.logger, tools: d.tools, toolCatalog: d.registry, reviews: d.reviews, checkpoint: d.checkpoint, selections: d.selections });
  try {
    // 存量历史 + 无活动窗（H13 路径，不依赖容量软线——SDK 模型估算档位不同也不影响确定性）
    seedHist(d.db, 'bd-h1', '十月早餐桌上的原话', 10, 'owner', dayAgo(3));
    seedHist(d.db, 'bd-h2', '第二天我们确认了菜单', 11, 'assistant', dayAgo(1));
    const sub = d.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '看看我们之前说过的话', clientMessageId: 'bd-s1', occurredAt: new Date().toISOString() });
    supervisor.enqueue(sub.turnId);
    await supervisor.waitIdle();
    const att = d.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string; blocked_reason: string | null };
    assert.equal(att.state, 'blocked', '存量历史无活动窗：等待选集');
    const awaiting = d.selections.awaitingFor('c1')!;
    const confirm = await supervisor.selectionConfirm({ conversationId: 'c1', windowId: awaiting.source_window_id, items: [{ message_id: 'bd-h1' }, { message_id: 'bd-h2' }], explicitEmpty: false, idempotencyKey: 'bd-sdk-confirm' });
    assert.equal(confirm.ok, true, JSON.stringify(confirm));
    await supervisor.waitIdle();
    const turn = d.db.prepare('SELECT state FROM turns WHERE id = ?').get(sub.turnId) as { state: string };
    assert.equal(turn.state, 'completed', '确认后建窗并恢复输入（经真实 SDK 链发出）');
    const withHistory = captures.filter((c) => c.frames.some((f) => JSON.stringify(f.message.content).includes('十月早餐桌上的原话')));
    assert.ok(withHistory.length >= 1, '选集历史经真实转换链进入 SDK prompt 流');
    const cap = withHistory[0]!;
    assert.ok(!cap.systemPrompt.includes('这是你们'), 'DBG-07：引导语不进 systemPrompt');
    const textOf = (f: typeof cap.frames[number]): string => f.message.content.map((b) => b.text ?? '').join('\n');
    const hist1 = cap.frames.find((f) => textOf(f).includes('十月早餐桌上的原话'))!;
    assert.ok(hist1.message.content[0]!.text!.startsWith('这是你们'), '引导语并回后继历史消息文本块头部（相邻顺序保持）');
    assert.ok(hist1.message.role !== 'system', '引导语不再作为独立 system 帧出现');
    const hist2 = cap.frames.find((f) => textOf(f).includes('第二天我们确认了菜单'))!;
    assert.ok(hist2.message.content[0]!.text!.startsWith('这是你们'), '第二段引导语同样并回其消息头部');
    assert.ok(cap.frames.indexOf(hist1) < cap.frames.indexOf(hist2), '两段历史顺序保持');
    assert.equal(cap.frames.filter((f) => textOf(f).startsWith('这是你们')).length, 2, '恰两段引导语（跨日），无独立引导语帧');
  } finally { d.db.close(); }
});

test('BD-2 (API 投影): 同一选集场景 DS 信封——引导语 system 块原位出现，A 段正本不含引导语', async () => {
  const root = tempRoot('bd-api-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, reminders: { enabled: false }, ...SOFT });
  const d = baseDeps(root, config);
  const seen: Array<Record<string, unknown>> = [];
  const runner = new DeepSeekRunner({ retryMax: 0 }, (async (payload) => { seen.push(payload as Record<string, unknown>); return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody('bd-api', '好的')) }; }) as OrTransport);
  const supervisor = new TurnSupervisor({ db: d.db, config, messages: d.messages, events: d.events, identity: d.identity, windows: d.windows, trajectory: d.trajectory, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(d.db, d.events), usage: new UsageCollector(d.db), routing: d.routing, logger: d.logger, tools: d.tools, reviews: d.reviews, checkpoint: d.checkpoint, selections: d.selections });
  try {
    await driveSelectionWindow({ db: d.db, messages: d.messages, supervisor, windows: d.windows }, 'bd-api-confirm');
    const msgsOf = (p: Record<string, unknown>): Array<Record<string, unknown>> => (p['messages'] as Array<Record<string, unknown>>) ?? [];
    const withHistory = seen.filter((p) => JSON.stringify(msgsOf(p)).includes('十月早餐桌上的原话'));
    assert.ok(withHistory.length >= 1, '恢复请求含选集历史');
    const msgs = msgsOf(withHistory[0]!);
    const textOf = (m: Record<string, unknown>): string => typeof m['content'] === 'string' ? m['content'] : JSON.stringify(m['content']);
    // DS wire 构建拍平 content 块并剥内部标记（guide 是信封内部标记、SDK 转换消费）——
    // API 投影按文本+位置判别引导语块
    const guideMsgs = msgs.filter((m) => m['role'] === 'system' && textOf(m).includes('这是你们'));
    assert.equal(guideMsgs.length, 2, '两段引导语以 system 块原位出现在信封消息流');
    const hist1Idx = msgs.findIndex((m) => textOf(m).includes('十月早餐桌上的原话'));
    const hist2Idx = msgs.findIndex((m) => textOf(m).includes('第二天我们确认了菜单'));
    assert.ok(msgs.findIndex((m) => m === guideMsgs[0]) < hist1Idx, '第一段引导语在其历史消息之前（原位）');
    assert.ok(msgs.findIndex((m) => m === guideMsgs[1]) < hist2Idx, '第二段引导语在其历史消息之前（原位）');
    const firstSystem = msgs.find((m) => m['role'] === 'system')!;
    assert.ok(!textOf(firstSystem).includes('这是你们'), 'A 段正本不含引导语（单一来源，无双注入）');
  } finally { d.db.close(); }
});

test('BD-3 (同时聊天×BIND): 聊天回合在途时午夜批照常处理——聊天不等待、任务零消息写入、窗口状态不被触碰、绑定真实写入', async () => {
  process.env.EST_TEST_GLM_KEY = 'test-glm-key';
  const root = tempRoot('bd-bind-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, reminders: { enabled: false } });
  const d = baseDeps(root, config);
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  const runner = new DeepSeekRunner({ retryMax: 0 }, (async (payload) => {
    void payload;
    await gate; // 聊天回合在途：模型响应未回
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody('bd-bind', '收到')) };
  }) as OrTransport);
  const supervisor = new TurnSupervisor({ db: d.db, config, messages: d.messages, events: d.events, identity: d.identity, windows: d.windows, trajectory: d.trajectory, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(d.db, d.events), usage: new UsageCollector(d.db), routing: d.routing, logger: d.logger, tools: d.tools, reviews: d.reviews, checkpoint: d.checkpoint, selections: d.selections });

  // BIND 夹具：边界前提交的 hold + 会话消息 + 同步收据（同 source-binding.test 口径）
  const boundary = SourceBindingService.lastBoundary();
  const committedAt = new Date(new Date(boundary).getTime() - 7200_000).toISOString();
  const convBd = 'conv_bd';
  d.db.prepare("INSERT INTO conversations(id, title, created_at) VALUES (?,NULL,?)").run(convBd, committedAt);
  d.db.prepare("INSERT INTO turns(id, conversation_id, state, trigger, input_message_id, created_at) VALUES (?,?,?, 'user_input', NULL, ?)").run('turn_bd', convBd, 'completed', committedAt);
  const bdMsgs: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const id = `msg_bd_${i}`;
    d.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, turn_id, kind, client_message_id, current_revision, published_at, created_at) VALUES (?,?,?,?,?,'text',NULL,1,?,?)")
      .run(id, convBd, i, i === 2 ? 'assistant' : 'owner', 'turn_bd', committedAt, committedAt);
    const content = i === 2 ? '我把落日的照片发给你了' : `第${i}句：海边的风好大`;
    d.db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,?,?,?,'user_input')").run(id, content, sha256Hex(content), committedAt, committedAt);
    d.db.prepare('INSERT INTO source_sync_receipts(id, origin_message_id, revision, source_message_id, source_conversation_id, content_hash, operation_id, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(genId('ssr'), id, 1, 'sm_' + id, 'sc_bd', sha256Hex(id), 'op_sync_bd', 'acked', committedAt);
    bdMsgs.push(id);
  }
  d.db.prepare('UPDATE turns SET input_message_id = ? WHERE id = ?').run(bdMsgs[2], 'turn_bd');
  d.db.prepare("INSERT INTO tool_side_effects(id, review_id, turn_id, window_id, kind, state, verified, memory_id, operation_id, tool_call_id, seen_sequence, created_at, updated_at) VALUES (?,?,?,NULL,'hold','committed',1,?,?,?,0,?,?)")
    .run(genId('tse'), null, 'turn_bd', 'mem_bd', 'op_mem_bd', 'call_bd', committedAt, committedAt);

  const bindCalls: Array<{ memoryId: string; members: string[] }> = [];
  const bindTransport: MariposaTransport = async (cap, payload) => {
    if (cap === 'memory.get') return { ok: true, result: { memory_id: 'mem_bd', version: 3, original_title: '海边的对话', text: '我们聊了在海边看落日的事。' } };
    if (cap === 'source.binding.bind') {
      // 模拟真实 M 会话解析：conversation_id 必须是收据会话（'sc_bd'），传 E 会话 id 一律 NOT_FOUND
      if (String((payload as { conversation_id?: string }).conversation_id ?? '') !== 'sc_bd') return { ok: false, code: 'NOT_FOUND', httpStatus: 404 };
      bindCalls.push({ memoryId: String((payload as { memory_id?: string }).memory_id), members: ((payload as { members?: Array<{ source_message_id: string }> }).members ?? []).map((m) => m.source_message_id) });
      return { ok: true, result: { binding_id: 'bnd_bd' } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const glm: GlmChatTransport = async () => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({ match: true, ranges: [{ start: bdMsgs[0], end: bdMsgs[3], basis: '海边落日对话的起止' }], confidence: 'high' }) } }] } });
  const bindConfig = buildConfig({ source_binding: { enabled: true, api_key_env: 'EST_TEST_GLM_KEY', base_url: 'http://synthetic', model: 'glm-test', max_batch: 10, max_candidates: 60 } });
  const bindSvc = new SourceBindingService({ db: d.db, config: bindConfig, mariposa: new MariposaClient({ transport: bindTransport }), glm: new GlmChatAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_GLM_KEY', model: 'glm-test', transport: glm }), log: () => {} });

  try {
    // 聊天回合发起并保持 在途（模型响应被门挡住）
    const sub = d.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '聊天进行中的一句', clientMessageId: 'bd-m1', occurredAt: new Date().toISOString() });
    supervisor.enqueue(sub.turnId);
    await new Promise<void>((resolve) => { const t = setInterval(() => { const att = d.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string } | undefined; if (att && att.state === 'running') { clearInterval(t); resolve(); } }, 10); });
    const messagesInFlight = (d.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
    const snapWindowState = JSON.stringify([
      d.db.prepare('SELECT * FROM window_toolsets ORDER BY window_id').all(),
      d.db.prepare('SELECT selection_id, status, items_json, updated_at FROM context_selections ORDER BY selection_id').all(),
      d.db.prepare('SELECT window_id, messages_json FROM window_trajectories ORDER BY window_id').all(),
    ]);

    // 聊天在途：维护批照常处理（B12——聊天不等待任务，任务不等聊天）
    const report = await bindSvc.runBatch();
    assert.equal(report.scope, 'est_tool_holds');
    assert.equal(report.counts['bound'], 1, '在途聊天不影响绑定批处理');
    assert.equal(bindCalls.length, 1);
    assert.equal(bindCalls[0]!.memoryId, 'mem_bd');
    assert.equal(bindCalls[0]!.members.length, 4, '范围含首尾之间全部双方消息');
    const job = d.db.prepare("SELECT status, memory_version FROM source_bind_jobs WHERE memory_id = 'mem_bd'").get() as { status: string; memory_version: number };
    assert.equal(job.status, 'bound');
    assert.equal(job.memory_version, 3);
    // 任务零聊天消息写入；窗口/选集/轨迹状态不被任务触碰（跨日不清窗口 coverage 的包2面）
    assert.equal((d.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, messagesInFlight, '批处理零消息写入');
    assert.equal(JSON.stringify([
      d.db.prepare('SELECT * FROM window_toolsets ORDER BY window_id').all(),
      d.db.prepare('SELECT selection_id, status, items_json, updated_at FROM context_selections ORDER BY selection_id').all(),
      d.db.prepare('SELECT window_id, messages_json FROM window_trajectories ORDER BY window_id').all(),
    ]), snapWindowState, 'window_toolsets/context_selections/window_trajectories 不被绑定任务修改');

    // 释放聊天：回合正常完成（聊天未被任务拖延/打断）
    release!();
    await supervisor.waitIdle();
    const turn = d.db.prepare('SELECT state FROM turns WHERE id = ?').get(sub.turnId) as { state: string };
    assert.equal(turn.state, 'completed', '聊天回合在批处理后正常完成');
    const convMsgs = (d.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = 'c1'").get() as { n: number }).n;
    assert.equal(convMsgs, 2, '聊天会话只含输入与回复（输入 1 + 助手回复 1）');
    const bdConvMsgs = (d.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?").get(convBd) as { n: number }).n;
    assert.equal(bdConvMsgs, 4, '绑定来源会话消息维持夹具 4 条（任务未追加）');
  } finally { delete process.env.EST_TEST_GLM_KEY; d.db.close(); }
});
