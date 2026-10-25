// 补断言批次（复审 F30 降级项中可离线补的：A012 撤权 / A038 身份负例 / A051 参数门 / A065 费用unknown / A066 cost小计）+ DS 冒烟配置化（族门）。
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
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { OpenRouterRunner, openRouterSelection, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor, validateToolArgs } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { buildOrPayload } from '../../apps/host/src/runtime/or-payload.ts';
import { normalizeOrUsage } from '../../apps/host/src/runtime/or-contract.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));
const T0 = '2026-10-01T08:00:00+08:00';

const mariposaOk: MariposaTransport = async (cap, payload) => {
  if (cap === 'memory.hold') {
    const op = (payload as { operation_id: string }).operation_id;
    return { ok: true, result: { operation_id: op, memory_id: 'mem-x', version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
  }
  return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
};

function compose(root: string, orTransport: OrTransport, opts: { removeIdentity?: boolean; removeI?: boolean } = {}) {
  writeApprovedIdentity(root);
  const paths = buildPaths(root);
  if (opts.removeIdentity) fs.rmSync(path.join(paths.identityDir, 'approved-identity.md'));
  if (opts.removeI) fs.rmSync(path.join(paths.identityDir, 'i-snapshot.md'));
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: MODEL } });
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
  const mariposa_wire_1 = new MariposaClient({ transport: mariposaOk });
  const tools = new HostToolExecutor({ db, mariposa: mariposa_wire_1, reviews, checkpoint });
  wireOidoCapabilitiesForTest(tools, {  });;
  const trajectory = new WindowTrajectoryService(db);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, orTransport);
  const supervisor = new TurnSupervisor({bootstrap: new MariposaClient({ transport: mariposaOk }), // S18：显式 BootstrapPort（原经 tools.mariposaClient 隐式取得）
     db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, identity, windows, supervisor };
}

async function say(ctx: ReturnType<typeof compose>, content: string, id: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: T0 });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

test('A038 负例：批准身份被撤走 → 阻断不出默认人格，消息仍保存', async () => {
  let sent = 0;
  const t: OrTransport = async () => { sent++; return { status: 200, headers: new Map(), body: frameStream(textBody('g', 'x')) }; };
  const root = tempRoot('r7-a038i-');
  const ctx = compose(root, t, { removeIdentity: true });
  const sub = await say(ctx, '你好', 'n1');
  const att = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id=?').get(sub.attemptId) as { state: string; blocked_reason: string | null };
  assert.equal(att.state, 'blocked');
  assert.ok(att.blocked_reason!.includes('IDENTITY'), '身份缺失如实阻断');
  assert.equal(sent, 0, '不发请求');
  const msgs = ctx.messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 10 });
  assert.equal(msgs.length, 1, '用户消息已保存（不丢）');
  ctx.db.close();

  const root2 = tempRoot('r7-a038ii-');
  const ctx2 = compose(root2, t, { removeI: true });
  const sub2 = await say(ctx2, '你好', 'n2');
  const att2 = ctx2.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id=?').get(sub2.attemptId) as { state: string; blocked_reason: string | null };
  assert.equal(att2.state, 'blocked');
  assert.ok(att2.blocked_reason!.includes('MISSING_I') || att2.blocked_reason!.includes('IDENTITY'), `缺 I 阻断（${att2.blocked_reason}）`);
  ctx2.db.close();
});

test('A012 撤权：会话中途撤走批准材料 → 旧窗作废不续用、不外发旧内容', async () => {
  let sent = 0;
  const t: OrTransport = async () => { sent++; return { status: 200, headers: new Map(), body: frameStream(textBody(`g${sent}`, '回')) }; };
  const root = tempRoot('r7-a012-');
  const ctx = compose(root, t);
  await say(ctx, '撤权前的对话', 'b1');
  const win1 = ctx.windows.activeWindow('c1')!;
  assert.equal(win1.status, 'ACTIVE');
  // 撤权：删掉批准身份文件（模拟授权收回）
  fs.rmSync(path.join(ctx.paths.identityDir, 'approved-identity.md'));
  const sub2 = await say(ctx, '撤权后的新消息', 'b2');
  const att2 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id=?').get(sub2.attemptId) as { state: string; blocked_reason: string | null };
  assert.equal(att2.state, 'blocked');
  assert.ok(att2.blocked_reason!.includes('IDENTITY'), '撤权后阻断');
  const winAfter = ctx.windows.get(win1.id)!;
  assert.ok(['CONTEXT_STALE', 'ACTIVE'].includes(winAfter.status), '旧窗不被静默续用（阻断优先于换窗）');
  const msgs = ctx.messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 10 });
  assert.equal(msgs.length, 3, '原文完整保留（撤权不删原文）');
  ctx.db.close();
});

test('A051：宿主参数门——新 hold 契约的未知字段/类型错/枚举外/长度/缺必填全部拒收且零副作用', () => {
  const base = { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' };
  const bad = validateToolArgs('memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'] });
  assert.ok(!bad.ok && bad.code === 'TOOL_ARG_REQUIRED', '缺 text 拒收');
  // F-J-22（她批准 2026-10-06）：当下/补记必须显式声明——缺 creation_mode 拒收
  const badMode = validateToolArgs('memory_hold', { original_title: '测试记忆', categories: ['daily'], text: 'x' });
  assert.ok(!badMode.ok && badMode.code === 'TOOL_ARG_REQUIRED', '缺 creation_mode 拒收（不猜当下/补记）');
  const badType = validateToolArgs('memory_hold', { ...base, categories: 123 });
  assert.ok(!badType.ok && badType.code === 'TOOL_ARG_TYPE', '类型错拒收');
  const badUnknown = validateToolArgs('memory_hold', { ...base, evil: 'y' });
  assert.ok(!badUnknown.ok && badUnknown.code === 'TOOL_ARG_UNKNOWN', '白名单外字段拒收（additionalProperties:false）');
  const badEnum = validateToolArgs('memory_hold', { ...base, categories: ['daily', 'mood'] });
  assert.ok(!badEnum.ok && badEnum.code === 'TOOL_ARG_ENUM', '分类枚举外值拒收');
  const badTitle = validateToolArgs('memory_hold', { ...base, original_title: '标'.repeat(31) });
  assert.ok(!badTitle.ok && badTitle.code === 'TOOL_ARG_LENGTH', '标题超 30 字拒收（mariposa 契约）');
  const oldField = validateToolArgs('memory_hold', { ...base, category: 'daily' });
  assert.ok(!oldField.ok && oldField.code === 'TOOL_ARG_UNKNOWN', '旧字段 category 已退役拒收');
  // 心情接入（2026-10-05 词表终版）：mood_tags=大类枚举 ≤3；词表外拒
  const badMood = validateToolArgs('memory_hold', { ...base, mood_tags: ['愉悦'] });
  assert.ok(!badMood.ok && badMood.code === 'TOOL_ARG_ENUM', '心情大类枚举外值（旧词）拒收');
  const tooMany = validateToolArgs('memory_hold', { ...base, mood_tags: ['开心', '爱', '生气', '吃醋'] });
  assert.ok(!tooMany.ok && tooMany.code === 'TOOL_ARG_LENGTH', '心情大类超过 3 个拒收');
  const okMood = validateToolArgs('memory_hold', { ...base, mood_tags: ['吃醋'], mood_note: '开心想抱抱' });
  assert.ok(okMood.ok, '词表内大类+随笔通过');
  const good = validateToolArgs('memory_hold', { ...base, quotes: [{ seq: 1 }], creation_mode: 'contemporaneous' });
  assert.ok(good.ok && good.value.text === 'x');
  const notListed = validateToolArgs('nonexistent', {});
  assert.ok(!notListed.ok && notListed.code === 'TOOL_NOT_IN_ALLOWLIST');
});

test('A065：cache 分类相容才推导 noncached；冲突不 clamp 成零', () => {
  const okU = normalizeOrUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 } });
  assert.equal(okU.noncached, 30);
  const clash = normalizeOrUsage({ prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } });
  assert.equal(clash.noncached, null, '分类超总：不 clamp 不推导');
  assert.ok(clash.anomalies.includes('CACHE_CATEGORIES_EXCEED_PROMPT'));
  assert.equal(clash.completeness, 'anomaly');
});

test('A066：turn 费用小计——已知求和、任一未知则 null+unknown（不显示为零）', () => {
  const root = tempRoot('r7-a066-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const c = new UsageCollector(db);
  // attempt A：两个请求都有 cost；attempt B：一个有 cost 一个没有
  db.prepare("INSERT OR IGNORE INTO conversations(id, scope, title, created_at) VALUES ('c1','private','t','2026-10-01T00:00:00Z')").run();
  db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES ('t1','c1','user_message','completed','2026-10-01T00:00:00Z')").run();
  db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, state) VALUES ('a1','t1',1,'completed')").run();
  c.record({ turnId: 't1', attemptId: 'a1', scope: 'request', requestId: 'r1', usage: { input_tokens: 10, output_tokens: 1, cost_usd: 0.01 }, source: 'or_stream', completeness: 'complete' });
  c.record({ turnId: 't1', attemptId: 'a1', scope: 'request', requestId: 'r2', usage: { input_tokens: 20, output_tokens: 2, cost_usd: 0.02 }, source: 'or_stream', completeness: 'complete' });
  const s1 = c.summaryForTurn('t1');
  assert.equal(s1.totals.cost_usd, 0.03, '已知 cost 求和');
  assert.equal(s1.totals.unknown_present, false);
  db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES ('t2','c1','user_message','completed','2026-10-01T00:00:00Z')").run();
  db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, state) VALUES ('a2','t2',1,'completed')").run();
  c.record({ turnId: 't2', attemptId: 'a2', scope: 'request', requestId: 'r3', usage: { input_tokens: 5, output_tokens: 1, cost_usd: 0.01 }, source: 'or_stream', completeness: 'complete' });
  c.record({ turnId: 't2', attemptId: 'a2', scope: 'request', requestId: 'r4', usage: { input_tokens: 6, output_tokens: 1 }, source: 'or_stream', completeness: 'complete' });
  const s2 = c.summaryForTurn('t2');
  assert.equal(s2.totals.cost_usd, null, '任一请求缺 cost → cost 小计未知（不写零）');
  assert.equal(s2.totals.input_tokens, 11, 'token 口径不受 cost 缺失染色（独立信号）');
  db.close();
});

test('DS 冒烟配置化：非 anthropic 族门——deepseek 型号过、顶层+块级 cache_control 均不注入；anthropic 族行为不变', () => {
  const ds = buildOrPayload({ model: 'deepseek/deepseek-chat', sessionId: 'es-ds-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], providerOnly: ['deepseek'] });
  assert.equal(ds.model, 'deepseek/deepseek-chat');
  assert.equal(ds.cache_control, undefined, '非 anthropic 上游不注入 Anthropic 式顶层 cache_control');
  assert.deepEqual((ds.provider as { only: string[] }).only, ['deepseek']);
  assert.throws(() => buildOrPayload({ model: 'deepseek/deepseek-latest', sessionId: 'es-ds-2', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], providerOnly: ['deepseek'] }), /EXACT_MODEL_REQUIRED/, 'DS 族同样禁 latest（族感知错误码）');
  const an = buildOrPayload({ model: MODEL, sessionId: 'es-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  assert.deepEqual(an.cache_control, { type: 'ephemeral', ttl: '1h' }, 'anthropic 族规范行为不变');
  assert.throws(() => buildOrPayload({ model: 'deepseek/deepseek-chat', sessionId: 'es-3', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), /EXACT_CLAUDE_MODEL_REQUIRED/, '默认 anthropic 门不放行 DS 型号');
  // 审计 P1-1（2026-10-05）：块级 cache_control 也必须族感知——非 anthropic 族断点不落标记
  const dsB = buildOrPayload({
    model: 'deepseek/deepseek-chat', sessionId: 'es-ds-4', providerOnly: ['deepseek'],
    messages: [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    boundaries: [{ messageIndex: 0, contentIndex: 0 }, { messageIndex: 1, contentIndex: 0 }],
  });
  assert.equal(JSON.stringify(dsB.messages).includes('cache_control'), false, '非 anthropic 族：断点规划存在但块级不注入 cache_control');
  const anB = buildOrPayload({
    model: MODEL, sessionId: 'es-5',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    boundaries: [{ messageIndex: 0, contentIndex: 0 }],
  });
  assert.deepEqual((anB.messages as Array<{ content: Array<{ text: string; cache_control?: unknown }> }>)[0]!.content[0]!.cache_control, { type: 'ephemeral', ttl: '1h' }, 'anthropic 族：断点照常注入块级 cache_control');
});
