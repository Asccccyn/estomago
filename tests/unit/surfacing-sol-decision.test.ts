// SOL_RECALL_REFACTOR（2026-10-30）离线合同验证：
// 旧 regex 门退役后——每条正式消息登记作业；Sol 三态各有终态与原因码；
// none/observe 零 Mariposa 调用；recall 计划真正进入 prepare 载荷；
// Sol 候选范围、缓存请求形态与模板同源。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, fakeSolJudge, solJudgeConfigForTest } from '../helpers.ts';
import { bindMessageLifecycle } from '../../apps/host/src/application/message-lifecycle.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { surfaceTransportMessage, type SurfaceItem } from '../../apps/host/src/memory-surfacing/contracts.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { buildRecentDialogue } from '../../apps/host/src/memory-surfacing/trigger.ts';
import { SolDecisionJudge, validateSolDecision, renderSolDynamicInput, type SolDecisionInput } from '../../apps/host/src/memory-surfacing/sol-provider.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';

function makeFixture(solDecisions: Parameters<typeof fakeSolJudge>[0], opts: { solResponse?: NonNullable<Parameters<typeof fakeSolJudge>[1]>['response']; mariposaThrows?: boolean; empty?: boolean; rejected?: boolean; windowBytes?: number; items?: SurfaceItem[] } = {}) {
  const { db } = makeDb();
  const caps: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const transport: MariposaTransport = async (cap, payload) => {
    caps.push(cap);
    payloads.push(payload as Record<string, unknown>);
    if (opts.mariposaThrows) return { ok: false, code: 'SURFACE_TRANSPORT', httpStatus: 502 };
    if (cap.endsWith('.prepare') && opts.rejected) return { ok: true, result: { status: 'rejected', reason_code: 'SURFACE_BODY_TOO_LARGE' } };
    if (cap.endsWith('.prepare') && opts.empty) return { ok: true, result: { status: 'empty', reason_code: null } };
    if (cap.endsWith('.prepare')) return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_t' } };
    if (cap.endsWith('.validate')) return { ok: true, result: { status: 'ready', validation_receipt: 'svr_t', items: opts.items ?? [], reason_code: null } };
    if (cap.endsWith('.check')) return { ok: true, result: { valid: true, accepted_detail_refs: (opts.items ?? []).map(item => item.detail_ref) } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const sol = fakeSolJudge(solDecisions, { response: opts.solResponse });
  const svc = new SurfacingService(db, new MariposaClient({ transport }), sol.judge, {
    enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v2',
    delivery_deadline_ms: 2000, max_added_tokens_per_turn: 4096, max_packet_bytes: 24576,
    worker_concurrency: 1, recent_user_messages: 3, recent_window_bytes: opts.windowBytes ?? 24576,
  }, null);
  const messages = new MessageService(db, bindMessageLifecycle({ surfacing: svc, activity: null }));
  messages.ensureConversation('c1');
  db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES('w1','c1','ACTIVE',?,?)")
    .run('2026-10-30T06:00:00Z', '2026-10-30T06:00:00Z');
  const say = (id: string, content: string) =>
    messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: '2026-10-30T06:00:00Z' });
  const judge = ({ message, turnId, attemptId }: ReturnType<typeof say>, approvedIdentityText?: string) => svc.augmentFor({
    conversationId: 'c1', windowId: 'w1', turnId, attemptId, approvedIdentityText,
    message: { id: message.id, revision: message.current_revision, sequence: message.sequence,
      content: message.revision.content, hash: message.revision.content_hash },
  });
  const jobOf = (id: string) => svc.repo.jobByLogicalKey('c1', id, 1, 1, 'surface_prepare_v2')!;
  const dynamic = (index: number) => (sol.requests[index].input as Array<{ content: string }>)[1].content;
  return { db, svc, sol, caps, payloads, say, judge, messages, jobOf, dynamic,
    close: async () => { await svc.stop(); db.close(); } };
}

test('检索核对短近文：按用户消息计数，保留相邻回复', () => {
  const m = (i: number, role: 'owner' | 'assistant', text: string) => ({ message_id: `m${i}`, revision: 1, role, text, sequence: i });
  // u4 是当前消息（不入参）。此前有 4 条用户消息 + 助手回复，窗口只取最近 3 条用户消息
  const rows = [m(1, 'assistant', '问：今天怎么样？'), m(2, 'owner', 'u1'), m(3, 'assistant', 'a1'),
    m(4, 'owner', 'u2'), m(5, 'owner', 'u3'), m(6, 'assistant', 'a3'), m(7, 'owner', 'u4-candidate')];
  const w = buildRecentDialogue(rows, { priorUserMessages: 3, maxMessages: 16, budgetBytes: 24576 });
  assert.deepEqual(w.map(x => x.message_id), ['m3', 'm4', 'm5', 'm6', 'm7']);
  // u1 及其前的提问退出窗口（超出 3 条用户消息）
  assert.ok(!w.some(x => x.message_id === 'm1') && !w.some(x => x.message_id === 'm2'));
});

test('检索核对短近文：预算先移除最旧，不截断单条正文', () => {
  const m = (i: number, role: 'owner' | 'assistant', text: string) => ({ message_id: `m${i}`, revision: 1, role, text, sequence: i });
  const long = '很'.repeat(400);
  const rows = [m(1, 'owner', long), m(2, 'assistant', long), m(3, 'owner', long), m(4, 'assistant', long), m(5, 'owner', '短消息')];
  const w = buildRecentDialogue(rows, { priorUserMessages: 3, maxMessages: 16, budgetBytes: 1200 });
  // 全量超预算 → 移除最旧整轮后，每条正文仍完整
  assert.ok(w.every(x => x.text.length === 0 || x.text === long || x.text === '短消息'));
  assert.ok(w.length < rows.length);
});

test('正式消息一律登记作业：普通聊天不再被旧关键词门拦下', async () => {
  const f = makeFixture([{ decision: 'none' }]);
  try {
    const u = f.say('u1', '我去倒杯水，一会儿回来。');
    const job = f.jobOf(u.message.id);
    assert.ok(job, '无历史信号的普通消息也登记作业（语义判断交给 Sol）');
    assert.equal(f.sol.calls(), 0, '提交完成只登记，发起目标回合才判断');
    await f.judge(u);
    // none：Sol 调用一次，零 Mariposa 检索/JEV
    assert.equal(f.sol.calls(), 1);
    assert.equal(f.caps.length, 0, 'none 不得访问 M 检索/JEV');
    const after = f.jobOf(u.message.id);
    assert.equal(after.state, 'empty');
    assert.equal(after.reason_code, 'SURFACE_SOL_NONE');
    assert.equal(after.sol_decision, 'none');
  } finally { await f.close(); }
});

test('observe：不查库、保留线索传给下一条消息的判断输入', async () => {
  const f = makeFixture([{ decision: 'observe', basis: '出现"小浣熊"但不确定私人含义' }, { decision: 'none' }]);
  try {
    const u1 = f.say('u1', '小浣熊今天好像不太理我。');
    await f.judge(u1);
    const j1 = f.jobOf(u1.message.id);
    assert.equal(j1.state, 'empty');
    assert.equal(j1.reason_code, 'SURFACE_SOL_OBSERVE');
    assert.equal(f.caps.length, 0, 'observe 不得访问 M 检索/JEV');
    // 原始聊天仍在；第二请求不携带旧模型判定。
    await f.judge(f.say('u2', '就是小浣熊抱着水獭的那个。'));
    assert.equal(f.sol.calls(), 2);
    const dyn = JSON.stringify(f.sol.requests[1]);
    assert.ok(!dyn.includes('pending_judgment') && !dyn.includes('last_retrieval')
      && !dyn.includes('business_date') && !dyn.includes('already_in_context'),
      '后台状态字段不进 Sol 输入（F7）');
    assert.ok(dyn.includes('小浣熊'), '原话进入判断输入');
  } finally { await f.close(); }
});

test('observe 跨过固定轮数保留双方正式原话，下一条从明确 none 之后开始', async () => {
  const f = makeFixture([
    ...Array.from({ length: 5 }, () => ({ decision: 'observe' as const })),
    { decision: 'none' }, { decision: 'none' },
  ]);
  try {
    for (let index = 1; index <= 6; index++) {
      const user = f.say(`u${index}`, `用户原话-${index}`);
      await f.judge(user);
      f.messages.publishAssistantMessage({ conversationId: 'c1', turnId: user.turnId, content: `助手原话-${index}` });
    }
    await f.judge(f.say('u7', '新话题原话'));
    const accumulated = f.dynamic(5);
    for (let index = 1; index <= 5; index++) {
      assert.match(accumulated, new RegExp(`用户原话-${index}[\\s\\S]*助手原话-${index}`));
    }
    assert.equal(accumulated.split('用户原话-6').length, 2);
    assert.match(f.dynamic(6), /助手原话-6[\s\S]*新话题原话/);
    assert.doesNotMatch(f.dynamic(6), /用户原话-|助手原话-5/);
    assert.equal(f.caps.length, 0);
  } finally { await f.close(); }
});

test('未确认浮现不收口，成功保留后从触发消息之后读取', async () => {
  const item: SurfaceItem = { event_id: 'ev_1', memory_id: 'fixture-memory', memory_version: '1',
    memory_date: '2026-07-09', date_confidence: 'exact', event_text: '过去的合成事件正文。',
    body_hash: 'b'.repeat(64), detail_ref: 'sdr_test' };
  const f = makeFixture([{ decision: 'recall' }, { decision: 'recall' }, { decision: 'none' }], { items: [item] });
  try {
    const first = f.say('u1', '第一次尝试回忆合成往事');
    assert.ok(await f.judge(first));
    f.svc.markDispatched(first.attemptId);
    const second = f.say('u2', '然后具体做了什么');
    const augmentation = await f.judge(second);
    assert.ok(augmentation);
    assert.match(f.dynamic(1), /第一次尝试回忆合成往事/);
    f.svc.markDispatched(second.attemptId);
    new WindowTrajectoryService(f.db).init('w1', [surfaceTransportMessage('openrouter', augmentation.text)], []);
    f.svc.markRetained(augmentation);
    f.messages.publishAssistantMessage({ conversationId: 'c1', turnId: second.turnId, content: '浮现之后的助手原话' });
    await f.judge(f.say('u3', '此刻的用户原话'));
    assert.match(f.dynamic(2), /浮现之后的助手原话[\s\S]*此刻的用户原话/);
    assert.doesNotMatch(f.dynamic(2), /第一次尝试回忆合成往事|然后具体做了什么/);
  } finally { await f.close(); }
});

test('Sol 仅接收当前有效身份中与原话相关的片段', async () => {
  const f = makeFixture([{ decision: 'none' }]);
  const identity = '甲方今年27岁。甲方的猫昵称：小麦。另有一段与本次无关的合成资料。';
  try {
    new WindowTrajectoryService(f.db).init('w1', [{ role: 'system', content: `${identity}\n\n内部运行规则` }], []);
    await f.judge(f.say('u1', '小麦今天问我几岁了'), identity);
    assert.match(f.dynamic(0), /有效身份资料：甲方今年27岁。/);
    assert.match(f.dynamic(0), /有效身份资料：甲方的猫昵称：小麦。/);
    assert.doesNotMatch(f.dynamic(0), /内部运行规则|合成资料/);
    await f.judge(f.say('u2', '小麦又问我年龄'), identity.replace('27岁', '28岁'));
    assert.doesNotMatch(f.dynamic(1), /27岁|28岁|昵称/);
  } finally { await f.close(); }
});

test('recall：Sol 计划真正进入 prepare 载荷（无 event_hypotheses）', async () => {
  const f = makeFixture([{ decision: 'recall', plan: { purpose: '找湖边牵手约定的原话', route: 'words', breadth: 'single', queries: [{ need_kind: 'words', need: '找到湖边牵手约定的原话', semantic: '湖边出门约定', keywords: ['牵手', '约定'], time_hint: '去年夏天', speaker: '助手', source_mode: 'words_only' }] } }]);
  try {
    await f.judge(f.say('u1', '找去年夏天那个约定，只要记过的原话，不查聊天原文。'));
    assert.equal(f.caps.filter(c => c.endsWith('.prepare')).length, 1);
    const prepare = f.payloads[0]!;
    assert.ok('plan' in prepare, 'plan 字段存在');
    assert.ok(!('event_hypotheses' in prepare), '旧 event_hypotheses 不再发送');
    const plan = prepare.plan as Record<string, unknown>;
    assert.equal(plan.route, 'words');
    assert.equal((plan.queries as Array<{ speaker?: string }>)[0].speaker, 'jiaming', '显示名"助手"映射为查询级 M 内部说话人枚举');
    assert.equal((plan.queries as Array<{ semantic: string }>)[0].semantic, '湖边出门约定');
    assert.equal((plan.queries as Array<{ source_mode: string }>)[0].source_mode, 'words_only');
  } finally { await f.close(); }
});

test('同轮检索和复核使用相同的有界上下文，保留较早的已核实日期原话', async () => {
  const earlier = '我想的是前年那次出游。';
  const basePlan = needPlan(earlier);
  const f = makeFixture([
    { decision: 'none' }, ...Array.from({ length: 5 }, () => ({ decision: 'observe' as const })),
    { decision: 'recall', plan: { ...basePlan, queries: [{ ...basePlan.queries[0], time_hint: '前年' }] } },
  ]);
  try {
    await f.judge(f.say('u0', '已结束的话题'));
    await f.judge(f.say('u1', earlier));
    for (let index = 2; index <= 5; index++) await f.judge(f.say(`u${index}`, `线索-${index}`));
    await f.judge(f.say('u6', '帮我找那时候的经过'));
    const prep = f.payloads[f.caps.indexOf('memory.surfacing.prepare')];
    const validate = f.payloads[f.caps.indexOf('memory.surfacing.validate')];
    assert.deepEqual(prep.recent_dialogue, validate.recent_dialogue);
    assert.match(JSON.stringify(prep.recent_dialogue), /前年那次出游/);
    assert.doesNotMatch(JSON.stringify(prep.recent_dialogue), /已结束的话题/);
  } finally { await f.close(); }
});

test('Sol 技术失败：blocked + 独立原因码，绝不回填 none', async () => {
  const notConfigured = new SolDecisionJudge(solJudgeConfigForTest({ apiKeyEnv: 'EST_TEST_SOL_KEY_MISSING' }));
  assert.equal(notConfigured.isConfigured(), false);
  const f = makeFixture([{ decision: 'none' }]);
  try {
    // 直接构造一个拒绝答复的判断器替换（service 持有的 judge 无法注入，改用专用断言）
    // F8：官方 refusal 形状位于 message.content[] 内
    const refusal = new SolDecisionJudge(solJudgeConfigForTest(), async () => ({
      status: 200,
      json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] },
    }));
    const r1 = await refusal.decide(solInputFixture(), new AbortController().signal);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.code, 'SURFACE_SOL_REFUSAL');

    const incomplete = new SolDecisionJudge(solJudgeConfigForTest(), async () => ({
      status: 200, json: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    }));
    const r2 = await incomplete.decide(solInputFixture(), new AbortController().signal);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, 'SURFACE_SOL_INCOMPLETE');

    const badJson = new SolDecisionJudge(solJudgeConfigForTest(), async () => ({
      status: 200, json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '不是 JSON' }] }] },
    }));
    const r3 = await badJson.decide(solInputFixture(), new AbortController().signal);
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.equal(r3.code, 'SURFACE_SOL_INVALID_OUTPUT');

    const http401 = new SolDecisionJudge(solJudgeConfigForTest(), async () => ({ status: 401, json: { error: {} } }));
    const r4 = await http401.decide(solInputFixture(), new AbortController().signal);
    assert.equal(r4.ok, false);
    if (!r4.ok) assert.equal(r4.code, 'SURFACE_SOL_HTTP_401');

    const http400 = new SolDecisionJudge(solJudgeConfigForTest(), async () => ({ status: 400, json: {
      error: { param: 'prompt_cache_key', code: 'string_above_max_length', message: '有私人内容的上游错误正文' },
    } }));
    const r5 = await http400.decide(solInputFixture(), new AbortController().signal);
    assert.equal(r5.ok, false);
    if (!r5.ok) assert.deepEqual(r5.diagnostic, { http_status: 400, provider_parameter: 'prompt_cache_key', provider_reason: 'string_above_max_length' });
    assert.doesNotMatch(JSON.stringify(r5), /有私人内容/);
  } finally { await f.close(); }
});

test('结构合格但语义矛盾（recall 无 plan / none 带 plan）= 判断失败', () => {
  assert.equal(validateSolDecision({ decision: 'recall', topic: 'new', basis: 'b', plan: null }), null);
  assert.equal(validateSolDecision({ decision: 'none', topic: 'new', basis: 'b', plan: { purpose: 'x', route: 'event', breadth: 'single', queries: [{ need_kind: 'event', need: 'n', semantic: 's', keywords: [], time_hint: null, speaker: null }] } }), null);
  assert.equal(validateSolDecision({ decision: 'observe', topic: 'same', basis: 'b', plan: null })?.decision, 'observe');
});

test('缓存请求形态：12h explicit + 唯一断点在模板块末尾 + 稳定 cache key', () => {
  const judge = new SolDecisionJudge(solJudgeConfigForTest({ cacheKeySeed: 'a'.repeat(16) }));
  const a = judge.buildRequest(solInputFixture('第一条动态内容'));
  const b = judge.buildRequest(solInputFixture('完全不同的第二条动态内容'));
  // ttl 与模式
  assert.deepEqual((a.payload.prompt_cache_options as Record<string, unknown>), { mode: 'explicit', ttl: '12h' });
  // 唯一断点：developer 模板块有，动态 user 块没有
  const input = a.payload.input as Array<{ role: string; content: unknown }>;
  const dev = input[0]!.content as Array<Record<string, unknown>>;
  assert.deepEqual(dev[0]!.prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(typeof input[1]!.content, 'string');
  assert.ok(!(input[1]!.content as string).includes('prompt_cache_breakpoint'));
  // 断点后才是动态内容
  assert.ok((input[1]!.content as string).includes('第一条动态内容'));
  assert.ok(!JSON.stringify(dev[0]!.text).includes('第一条动态内容'), '固定前缀不含动态正文');
  // 稳定 key：不同动态输入同一 key
  assert.equal(a.payload.prompt_cache_key, b.payload.prompt_cache_key);
  assert.ok(typeof a.payload.prompt_cache_key === 'string' && a.payload.prompt_cache_key.length <= 64);
  assert.notEqual(a.payload.prompt_cache_key, new SolDecisionJudge(solJudgeConfigForTest({ cacheKeySeed: '另一个工作区' })).cacheKey());
  judge.applyOverrides({ decision_template: '变更后的判断模板' });
  assert.notEqual(a.payload.prompt_cache_key, judge.cacheKey());
  // store:false + 模板占位已替换
  assert.equal(a.payload.store, false);
  assert.ok(!judge.effectiveTemplate().includes('{{'));
});

test('模板同源：设置面保存/预览/重置与实际请求正文一致', async () => {
  const f = makeFixture([{ decision: 'none' }]);
  try {
    const before = f.svc.settingsView();
    assert.equal((before.sol as Record<string, unknown>).template_source, 'default');
    const r = f.svc.updateSettings({ decision_template: '测试覆盖模板：{{user_display_name}} 与 {{assistant_display_name}}' });
    assert.equal(r.ok, true);
    const after = f.svc.settingsView();
    assert.equal((after.sol as Record<string, unknown>).template_source, 'override');
    // 预览 = 判断器生效模板 = 实际请求 developer 块
    assert.equal((after.sol as Record<string, unknown>).effective_template, f.sol.judge.effectiveTemplate());
    await f.judge(f.say('u1', '随便聊聊'));
    const req = f.sol.requests[0]!;
    const dev = (req.input as Array<{ role: string; content: Array<Record<string, unknown>> }>)[0]!.content[0]!;
    assert.equal(dev.text, (after.sol as Record<string, unknown>).effective_template);
    // 重置回默认
    const reset = f.svc.updateSettings({ decision_template: null });
    assert.equal(reset.ok, true);
    assert.equal((f.svc.settingsView().sol as Record<string, unknown>).template_source, 'default');
  } finally { await f.close(); }
});

test('Sol 动态输入用配置姓名和上海日期，当前正文仅一次且无内部状态', () => {
  const text = renderSolDynamicInput({
    currentMessage: { text: '当前原话', occurred_at: '2026-10-30T16:07:00Z' },
    recentDialogue: [{ role: 'owner', text: '先前原话', occurred_at: '2026-10-30T15:59:00Z' }, { role: 'assistant', text: '助手回复' }],
  }, { userDisplayName: '甲方', assistantDisplayName: '乙方' });
  assert.equal(text.split('当前原话').length, 2, '当前消息只出现一次');
  assert.match(text, /2026-10-30（Asia\/Shanghai）\]\n甲方：先前原话\n乙方：助手回复\n.*2026-10-31（Asia\/Shanghai）\]\n甲方：当前原话/);
  for (const banned of ['message_id', 'body_hash', 'revision', 'business_date', 'pending_judgment', 'last_retrieval', 'already_in_context']) {
    assert.ok(!text.includes(banned), `后台/信封字段 ${banned} 不进 Sol 输入`);
  }
});

function solInputFixture(current = '当前消息内容'): SolDecisionInput {
  return {
    currentMessage: { text: current },
    recentDialogue: [{ role: 'owner', text: '近文' }],
  };
}

const needPlan = (quote: string, userTurn = 1, purpose = '核对湖边约定', route: 'event' | 'words' = 'event') => ({
  purpose, route, breadth: 'single',
  queries: [{ need_kind: route, need: route === 'words' ? '找到当时原话' : '找到相关历史事件证据', semantic: '寻找湖边约定的记录', keywords: ['湖边', '约定'], time_hint: null, speaker: null }],
  evidence: [{ user_turn: userTurn, quote }],
});

test('已完成空查询：同一原话依据换用途措辞不重查；新日期/原句/明确重查仍可查', async () => {
  const original = '帮我找7月9日在湖边的约定。';
  const correction = '不是7月9日，是8月9日。';
  const words = '当时你具体怎么说的？';
  const f = makeFixture([
    { decision: 'recall', plan: needPlan(original) },
    { decision: 'recall', plan: { ...needPlan(original, 1, '找回那晚我们约好的事情'), breadth: 'related' } },
    { decision: 'recall', plan: { ...needPlan(correction, 3), queries: [{ ...needPlan(correction, 3).queries[0], time_hint: '8月9日' }] } },
    { decision: 'recall', plan: { ...needPlan(words, 4, '找回当时的原话', 'words') } },
    { decision: 'recall', plan: { ...needPlan('请再查一次', 5, '再核对一次原话', 'words') } },
  ], { empty: true });
  const send = async (id: string, text: string) => {
    const u = f.say(id, text);
    await f.judge(u);
    return f.jobOf(u.message.id);
  };
  try {
    await send('u1', original);
    const ack = await send('u2', '嗯，我就是想到那晚。');
    assert.equal(ack.reason_code, 'SURFACE_NEED_ALREADY_SEARCHED');
    assert.equal(f.caps.length, 1);
    await send('u3', correction);
    assert.equal(f.caps.length, 2, '相同purpose的新日期必须放行');
    await send('u4', words);
    assert.equal(f.caps.length, 3, '找事件不等于已查准确原话');
    await send('u5', '请再查一次');
    assert.equal(f.caps.length, 4, '新窗口里的明确重查有新的真实消息身份');
    assert.ok(!JSON.stringify(f.sol.requests).includes('message_id'));
    const last = f.payloads.at(-1)!;
    assert.ok(!('evidence' in (last.plan as Record<string, unknown>)), 'Sol原话依据仅由宿主消费，不复制给M');
    assert.ok((last.recent_dialogue as Array<Record<string, unknown>>).every(x => typeof x.occurred_at === 'string'));
  } finally { await f.close(); }
});

test('编造或错指用户原话依据是无效输出；技术失败不消费后续同需', async () => {
  const original = '帮我找湖边那天的约定。';
  const f = makeFixture([
    { decision: 'recall', plan: needPlan('对话里不存在的原句') },
    { decision: 'recall', plan: needPlan(original) },
    { decision: 'recall', plan: needPlan(original) },
  ], { mariposaThrows: true });
  try {
    for (let i = 1; i <= 3; i++) {
      const u = f.say('u'+i, i===1 ? original : '我还在想那次。');
      await f.judge(u);
      assert.equal(f.jobOf(u.message.id).state, 'blocked');
      if (i===1) assert.equal(f.jobOf(u.message.id).reason_code, 'SURFACE_SOL_INVALID_OUTPUT');
    }
    assert.equal(f.caps.length, 2, '未实际完成的需要不能按已消费抑制');
  } finally { await f.close(); }
});

test('M接纳或容量拒绝不登记为正常查完空结果', async () => {
  const original = '帮我查湖边那晚的约定。';
  const f = makeFixture([{ decision: 'recall', plan: needPlan(original) }], { rejected: true });
  try {
    for (const [id, text] of [['a', original], ['b', '嗯，就是那个约定。']]) {
      const u = f.say(id, text);
      await f.judge(u);
      assert.equal(f.jobOf(u.message.id).state, 'rejected');
      assert.equal(f.jobOf(u.message.id).reason_code, 'SURFACE_BODY_TOO_LARGE');
      assert.equal(JSON.parse(f.jobOf(u.message.id).sol_plan_json!).need_outcome, undefined);
    }
    assert.equal(f.caps.length, 2, '未检索完成不能抑制仍未满足的需要');
  } finally { await f.close(); }
});

test('单条和候选池总量超预算都如实阻断，旧长消息不被悄悄截丢', async () => {
  const f = makeFixture([{ decision: 'none' }], { windowBytes: 64 });
  try {
    const text = '合成'.repeat(20);
    const long = f.say('long', text);
    await f.judge(long);
    assert.equal(f.jobOf(long.message.id).state, 'blocked');
    assert.equal(f.jobOf(long.message.id).reason_code, 'SURFACE_BODY_TOO_LARGE');
    assert.equal(long.message.revision.content, text);
    assert.equal(f.sol.calls(), 0);
    const short = f.say('short', '现在正常聊聊。');
    await f.judge(short);
    assert.equal(f.jobOf(short.message.id).reason_code, 'SURFACE_BODY_TOO_LARGE');
    assert.equal(f.sol.calls(), 0);
    assert.equal(f.caps.length, 0);
  } finally { await f.close(); }
});

test('Sol 重试分别记录已知用量和无用量的超时', async () => {
  let calls = 0;
  const f = makeFixture([], { solResponse: () => {
    if (++calls === 1) return { status: 503, json: { usage: { input_tokens: 100, output_tokens: 5 } } };
    throw Error('transport timeout');
  } });
  try {
    const turn = f.say('retry', '查一下那条合成记录。');
    await f.judge(turn);
    const job = f.jobOf(turn.message.id);
    assert.equal(job.reason_code, 'SURFACE_SOL_TIMEOUT');
    const ledger = JSON.parse(job.sol_usage_json!);
    assert.equal(ledger.request_count, 2);
    assert.equal(ledger.unknown_usage_count, 1);
    assert.equal(ledger.input_tokens, 100);
    assert.equal(ledger.output_tokens, 5);
    assert.equal(ledger.attempts[1], null);
  } finally { await f.close(); }
});
