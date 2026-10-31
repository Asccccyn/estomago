// SOL_RECALL_REFACTOR（2026-10-30）离线合同验证：
// 旧 regex 门退役后——每条正式消息登记作业；Sol 三态各有终态与原因码；
// none/observe 零 Mariposa 调用；recall 计划真正进入 prepare 载荷；
// 近文按用户消息计数；缓存请求形态（断点/ttl/稳定 key）；模板与请求同源。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, fakeSolJudge, solJudgeConfigForTest, pollUntil } from '../helpers.ts';
import { bindMessageLifecycle } from '../../apps/host/src/application/message-lifecycle.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { buildRecentDialogue } from '../../apps/host/src/memory-surfacing/trigger.ts';
import { SolDecisionJudge, validateSolDecision, renderSolDynamicInput, SOL_DECISION_TEMPLATE_DEFAULT, type SolDecisionInput } from '../../apps/host/src/memory-surfacing/sol-provider.ts';

function makeFixture(solDecisions: Parameters<typeof fakeSolJudge>[0], opts: { mariposaThrows?: boolean; empty?: boolean; rejected?: boolean; windowBytes?: number } = {}) {
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
    if (cap.endsWith('.validate')) return { ok: true, result: { status: 'ready', validation_receipt: 'svr_t', items: [], reason_code: null } };
    if (cap.endsWith('.check')) return { ok: true, result: { valid: true, accepted_detail_refs: [] } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const sol = fakeSolJudge(solDecisions);
  const svc = new SurfacingService(db, new MariposaClient({ transport }), sol.judge, {
    enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v2',
    delivery_deadline_ms: 2000, max_added_tokens_per_turn: 4096, max_packet_bytes: 24576,
    worker_concurrency: 1, recent_user_messages: 3, recent_window_bytes: opts.windowBytes ?? 24576,
  }, null);
  const messages = new MessageService(db, bindMessageLifecycle({ surfacing: svc, activity: null }));
  messages.ensureConversation('c1');
  const say = (id: string, content: string) =>
    messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: '2026-10-30T06:00:00Z' });
  const jobOf = (id: string) => svc.repo.jobByLogicalKey('c1', id, 1, 1, 'surface_prepare_v2')!;
  return { db, svc, sol, caps, payloads, say, jobOf,
    close: async () => { await svc.stop(); await new Promise(r => setTimeout(r, 20)); db.close(); } };
}

test('近文窗口：按用户消息计数，含其间助手回复与依赖提问；不按混合条数切', () => {
  const m = (i: number, role: 'owner' | 'assistant', text: string) => ({ message_id: `m${i}`, revision: 1, role, text, sequence: i });
  // u4 是当前消息（不入参）。此前有 4 条用户消息 + 助手回复，窗口只取最近 3 条用户消息
  const rows = [m(1, 'assistant', '问：今天怎么样？'), m(2, 'owner', 'u1'), m(3, 'assistant', 'a1'),
    m(4, 'owner', 'u2'), m(5, 'owner', 'u3'), m(6, 'assistant', 'a3'), m(7, 'owner', 'u4-candidate')];
  const w = buildRecentDialogue(rows, { priorUserMessages: 3, maxMessages: 16, budgetBytes: 24576 });
  assert.deepEqual(w.map(x => x.message_id), ['m3', 'm4', 'm5', 'm6', 'm7']);
  // u1 及其前的提问退出窗口（超出 3 条用户消息）
  assert.ok(!w.some(x => x.message_id === 'm1') && !w.some(x => x.message_id === 'm2'));
});

test('近文窗口：预算先按整轮移除最旧，不截断单条正文', () => {
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
    await new Promise(r => setTimeout(r, 80));
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
    await new Promise(r => setTimeout(r, 80));
    const j1 = f.jobOf(u1.message.id);
    assert.equal(j1.state, 'empty');
    assert.equal(j1.reason_code, 'SURFACE_SOL_OBSERVE');
    assert.equal(f.caps.length, 0, 'observe 不得访问 M 检索/JEV');
    // 原始聊天仍在；第二请求不携带旧模型判定。
    f.say('u2', '就是小浣熊抱着水獭的那个。');
    await new Promise(r => setTimeout(r, 80));
    assert.equal(f.sol.calls(), 2);
    const dyn = JSON.stringify(f.sol.requests[1]);
    assert.ok(!dyn.includes('pending_judgment') && !dyn.includes('last_retrieval')
      && !dyn.includes('business_date') && !dyn.includes('already_in_context'),
      '后台状态字段不进 Sol 输入（F7）');
    assert.ok(dyn.includes('小浣熊'), '原话进入判断输入');
  } finally { await f.close(); }
});

test('recall：Sol 计划真正进入 prepare 载荷（无 event_hypotheses）', async () => {
  const f = makeFixture([{ decision: 'recall', plan: { purpose: '找湖边牵手约定的原话', route: 'words', breadth: 'single', queries: [{ semantic: '湖边出门约定', keywords: ['牵手', '约定'] }], time_hint: '去年夏天', speaker: '助手' } }]);
  try {
    f.say('u1', '老公！今天我们也要一起牵手手。');
    await new Promise(r => setTimeout(r, 120));
    assert.equal(f.caps.filter(c => c.endsWith('.prepare')).length, 1);
    const prepare = f.payloads[0]!;
    assert.ok('plan' in prepare, 'plan 字段存在');
    assert.ok(!('event_hypotheses' in prepare), '旧 event_hypotheses 不再发送');
    const plan = prepare.plan as Record<string, unknown>;
    assert.equal(plan.route, 'words');
    assert.equal(plan.speaker, 'jiaming', '显示名"助手"映射为 M 内部说话人枚举');
    assert.equal((plan.queries as Array<{ semantic: string }>)[0].semantic, '湖边出门约定');
    const job = f.svc.repo.pendingJobs(10);
    assert.equal(job.length, 0, 'recall 后作业离开 pending');
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
  } finally { await f.close(); }
});

test('结构合格但语义矛盾（recall 无 plan / none 带 plan）= 判断失败', () => {
  assert.equal(validateSolDecision({ decision: 'recall', topic: 'new', basis: 'b', plan: null }), null);
  assert.equal(validateSolDecision({ decision: 'none', topic: 'new', basis: 'b', plan: { purpose: 'x', route: 'event', breadth: 'single', queries: [{ semantic: 's', keywords: [] }], time_hint: null, speaker: null } }), null);
  assert.equal(validateSolDecision({ decision: 'observe', topic: 'same', basis: 'b', plan: null })?.decision, 'observe');
});

test('缓存请求形态：12h explicit + 唯一断点在模板块末尾 + 稳定 cache key', () => {
  const judge = new SolDecisionJudge(solJudgeConfigForTest());
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
    f.say('u1', '随便聊聊');
    await new Promise(r2 => setTimeout(r2, 60));
    const req = f.sol.requests[0]!;
    const dev = (req.input as Array<{ role: string; content: Array<Record<string, unknown>> }>)[0]!.content[0]!;
    assert.equal(dev.text, (after.sol as Record<string, unknown>).effective_template);
    // 重置回默认
    const reset = f.svc.updateSettings({ decision_template: null });
    assert.equal(reset.ok, true);
    assert.equal((f.svc.settingsView().sol as Record<string, unknown>).template_source, 'default');
  } finally { await f.close(); }
});

test('Sol 动态输入渲染（F7 瘦身）：只含原话/角色；当前消息只出现一次；无后台状态', () => {
  const text = renderSolDynamicInput({
    currentMessage: { text: '当前原话' },
    recentDialogue: [{ role: 'owner', text: '先前原话' }, { role: 'assistant', text: '助手回复' }],
  });
  assert.equal(text.split('当前原话').length, 2, '当前消息只出现一次');
  assert.ok(text.includes('用户：先前原话') && text.includes('助手：助手回复'), '近文按角色有序');
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

const needPlan = (quote: string, userTurn = 1, purpose = '核对湖边约定') => ({
  purpose, route: 'event', breadth: 'single',
  queries: [{ semantic: '寻找湖边约定的记录', keywords: ['湖边', '约定'] }],
  time_hint: null, speaker: null, evidence: [{ user_turn: userTurn, quote }],
});

test('已完成空查询：同一原话依据换用途措辞不重查；新日期/原句/明确重查仍可查', async () => {
  const original = '帮我找7月9日在湖边的约定。';
  const correction = '不是7月9日，是8月9日。';
  const words = '当时你具体怎么说的？';
  const f = makeFixture([
    { decision: 'recall', plan: needPlan(original) },
    { decision: 'recall', plan: { ...needPlan(original, 1, '找回那晚我们约好的事情'), breadth: 'related' } },
    { decision: 'recall', plan: { ...needPlan(correction, 3), time_hint: '8月9日' } },
    { decision: 'recall', plan: { ...needPlan(words, 4), route: 'words' } },
    { decision: 'recall', plan: { ...needPlan('请再查一次', 4), route: 'words' } },
  ], { empty: true });
  const send = async (id: string, text: string) => {
    const u = f.say(id, text);
    await pollUntil(() => ['empty', 'blocked'].includes(f.jobOf(u.message.id).state));
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
      await pollUntil(() => f.jobOf(u.message.id).state === 'blocked');
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
      await pollUntil(() => f.jobOf(u.message.id).state === 'rejected');
      assert.equal(f.jobOf(u.message.id).reason_code, 'SURFACE_BODY_TOO_LARGE');
      assert.equal(JSON.parse(f.jobOf(u.message.id).sol_plan_json!).need_outcome, undefined);
    }
    assert.equal(f.caps.length, 2, '未检索完成不能抑制仍未满足的需要');
  } finally { await f.close(); }
});

test('当前原话超窗口预算不调用Sol；旧长消息整条退出近文，不截断正文', async () => {
  const f = makeFixture([{ decision: 'none' }], { windowBytes: 64 });
  try {
    const text = '合成'.repeat(20);
    const long = f.say('long', text);
    await pollUntil(() => f.jobOf(long.message.id).state === 'blocked');
    assert.equal(f.jobOf(long.message.id).reason_code, 'SURFACE_BODY_TOO_LARGE');
    assert.equal(long.message.revision.content, text);
    assert.equal(f.sol.calls(), 0);
    const short = f.say('short', '现在正常聊聊。');
    await pollUntil(() => f.jobOf(short.message.id).state === 'empty');
    assert.equal(f.sol.calls(), 1);
    const input = f.sol.requests[0].input as Array<{ content: unknown }>;
    assert.equal(input[1].content, '用户：现在正常聊聊。');
    assert.equal(f.caps.length, 0);
  } finally { await f.close(); }
});
