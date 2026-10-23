// WP3 回归：OR 工具循环（hold → 书签）+ 换窗评审流（一次提醒/零新增放行/书签后空范围跳过/
// 模型不完成则阻断）。假 OR transport + 假 Mariposa，零网络零真实模型。
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
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + DONE;
const toolBody = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
// Readable.from(uint8) 会把字节当数字迭代——必须按帧包成数组再 from（生产默认 transport 用 fromWeb 无此问题）
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

type ChatScript = { firstRound: 'text' | 'hold'; text?: string };
type ReviewScript = 'no_new_hold' | 'hold_then_complete' | 'incomplete';

function scriptedTransport(chat: ChatScript, review: ReviewScript, log: Array<{ purpose: string; roles: string[]; lastUser: string }>) {
  let gen = 0;
  const transport: OrTransport = async (payload) => {
    const messages = payload.messages as Array<{ role: string; content: unknown; tool_calls?: unknown[] }>;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const textOf = (m: { content: unknown }): string =>
      typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => (b as { text?: string }).text ?? '').join('\n') : '';
    const lastUserText = lastUser ? textOf(lastUser) : '';
    const isReview = lastUserText.includes('宿主运行事件');
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const purpose = isReview ? 'pre_rotate_review' : 'chat';
    log.push({ purpose, roles: messages.map((m) => m.role), lastUser: lastUserText.slice(0, 600) });
    gen++;
    const id = `gen-${gen}`;
    const reviewId = lastUserText.match(/review_id: (\S+)/)?.[1] ?? '';
    let body: string;
    if (isReview) {
      if (review === 'no_new_hold') body = toolBody(id, `rc-${gen}`, 'context_review_complete', { review_id: reviewId, decision: 'no_new_hold' });
      else if (review === 'hold_then_complete') body = hasToolResult
        ? toolBody(id, `rc-${gen}`, 'context_review_complete', { review_id: reviewId, decision: 'holds_completed' })
        : toolBody(id, `hc-${gen}`, 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: '合成 hold 内容' });
      else body = textBody(id, '（不调用完成工具的模型回复）');
    } else {
      body = chat.firstRound === 'hold' && !hasToolResult
        ? toolBody(id, `cc-${gen}`, 'memory_hold', { original_title: '测试记忆', creation_mode: 'contemporaneous', categories: ['daily'], text: '聊天中主动记一条' })
        : textBody(id, chat.text ?? `回复${gen}`);
    }
    return { status: 200, headers: new Map<string, string>(), body: frameStream(body) };
  };
  return transport;
}

const mariposaOk: MariposaTransport = async (capability, payload) => {
  if (capability === 'memory.hold') {
    const op = payload.operation_id as string;
    return { ok: true, result: { operation_id: op, memory_id: `mem-${op.slice(-6)}`, version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
  }
  return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
};

function compose(root: string, orTransport: OrTransport, mariposa: MariposaTransport, configOver: Record<string, unknown> = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: MODEL }, windows: { soft_limit_tokens: 1500 }, ...configOver });
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
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, orTransport);
  const trajectory = new WindowTrajectoryService(db); // 生产恒接线——原测试缺线，此前靠 12k 回退掩盖
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, windows, reviews, checkpoint, supervisor };
}

const H = 60 * 60 * 1000;
const T0 = '2026-10-01T08:00:00+08:00';

async function say(ctx: ReturnType<typeof compose>, content: string, clientMsgId: string, occurredAt: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: clientMsgId, occurredAt });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

test('容量触发（原 6h 静默触发，2026-10-08 晚间裁定改为软线唯一基线；现行 600k 兜底）：一次提醒 → 零新增放行 → CAS 换窗 → 本轮输入只进新窗一次', async () => {
  const log: Array<{ purpose: string; roles: string[]; lastUser: string }> = [];
  const root = tempRoot('orrot1-');
  const ctx = compose(root, scriptedTransport({ firstRound: 'text' }, 'no_new_hold', log), mariposaOk);
  await say(ctx, '早上的话', 'r1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  const sub2 = await say(ctx, `七小时后的新话题${'很长的容量触发内容。'.repeat(450)}`, 'r2', new Date(Date.parse(T0) + 7 * H).toISOString()); // 2026-10-08：静默不换窗——软线压低+长消息容量触发
  // 评审发生了（一次、零新增）并完成
    const reviewRow = ctx.db.prepare("SELECT * FROM rotation_reviews WHERE status = 'completed'").get() as { id: string; decision: string };
  assert.equal(reviewRow.decision, 'no_new_hold');
  assert.ok(log.some((l) => l.purpose === 'pre_rotate_review' && l.lastUser.includes(reviewRow.id)), '提醒携带宿主签发的 review_id');
  // 换窗：旧窗 CLOSED，新窗 ACTIVE，本轮 turn 在新窗
  const win2 = ctx.windows.activeWindow('c1')!;
  assert.notEqual(win2.id, win1.id);
  const att = ctx.db.prepare('SELECT window_id, state FROM attempts WHERE id = ?').get(sub2.attemptId) as { window_id: string; state: string };
  assert.equal(att.window_id, win2.id, '新输入只进新窗');
  assert.equal(att.state, 'completed');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM rotation_reviews').get().n, 1, '只有一次评审（不多收费）');
  ctx.db.close();
});

test('评审中 hold：收据落账本 → holds_completed 放行 → 书签推进；下次触发范围从书签后起算', async () => {
  const log: Array<{ purpose: string; roles: string[]; lastUser: string }> = [];
  const root = tempRoot('orrot2-');
  const ctx = compose(root, scriptedTransport({ firstRound: 'text' }, 'hold_then_complete', log), mariposaOk);
  await say(ctx, '第一天', 'h1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  await say(ctx, `第二天回来${'很长的容量触发内容。'.repeat(450)}`, 'h2', new Date(Date.parse(T0) + 25 * H).toISOString());
  // 评审：模型 hold（真实收据）→ holds_completed → 换窗
  const reviewRow = ctx.db.prepare("SELECT * FROM rotation_reviews WHERE status='completed'").get() as { decision: string; memory_ids_json: string };
  assert.equal(reviewRow.decision, 'holds_completed');
  assert.equal(JSON.parse(reviewRow.memory_ids_json).length, 1);
  // 书签落在旧窗（发起请求视野高水位）
  const cp = ctx.checkpoint.forWindow(win1.id);
  assert.ok(cp, '成功书签已记录');
  assert.ok(cp!.memoryId.startsWith('mem-'));
  // 工具循环的续请求：评审请求里有 assistant tool_calls + tool 结果（roles 含 tool）
  const reviewReqs = log.filter((l) => l.purpose === 'pre_rotate_review');
  assert.ok(reviewReqs.some((l) => l.roles.includes('tool')), 'hold 后的续请求携带工具结果（append-only）');
  ctx.db.close();
});

test('聊天中自主 hold：正常回合工具循环 + 书签推进 + 第二轮纯文本收口', async () => {
  const log: Array<{ purpose: string; roles: string[]; lastUser: string }> = [];
  const root = tempRoot('orrot3-');
  const ctx = compose(root, scriptedTransport({ firstRound: 'hold', text: '记好了' }, 'incomplete', log), mariposaOk);
  const sub = await say(ctx, '帮我记住这件事', 'c1m', T0);
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed');
  const msgs = ctx.messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 10 });
  assert.equal(msgs[1]!.revision.content, '记好了', '最终文本发布');
  const cp = ctx.checkpoint.forWindow(ctx.windows.activeWindow('c1')!.id);
  assert.ok(cp, '聊天中的 hold 也推进书签');
  const effects = ctx.db.prepare("SELECT COUNT(*) n FROM tool_side_effects WHERE kind='hold' AND state='committed'").get() as { n: number };
  assert.equal(effects.n, 1);
  // 第二轮请求包含第一轮的 assistant tool_calls 与 tool 结果
  const chatReqs = log.filter((l) => l.purpose === 'chat');
  assert.equal(chatReqs.length, 2);
  assert.ok(chatReqs[1]!.roles.includes('tool'));
  ctx.db.close();
});

test('模型不完成评审：如实阻断（不伪造完成凭证、不换窗），旧窗保持', async () => {
  const log: Array<{ purpose: string; roles: string[]; lastUser: string }> = [];
  const root = tempRoot('orrot4-');
  const ctx = compose(root, scriptedTransport({ firstRound: 'text' }, 'incomplete', log), mariposaOk);
  await say(ctx, '第一句', 'b1', T0);
  const win1 = ctx.windows.activeWindow('c1')!;
  const sub2 = await say(ctx, `第二句${'很长的容量触发内容。'.repeat(450)}`, 'b2', new Date(Date.parse(T0) + 8 * H).toISOString());
  const att = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(sub2.attemptId) as { state: string; blocked_reason: string };
  assert.equal(att.state, 'blocked');
  assert.ok(att.blocked_reason.startsWith('ROTATION_REVIEW_FAILED'), '评审未完成不绕过');
  assert.equal(ctx.windows.activeWindow('c1')!.id, win1.id, '旧窗保持 ACTIVE');
  const reviewRow = ctx.db.prepare("SELECT status FROM rotation_reviews").get() as { status: string };
  assert.equal(reviewRow.status, 'failed', '失败如实记录');
  ctx.db.close();
});

test('无已见原话的容量触发：零范围 → skipped_empty 直接换窗（不叫模型评审）', async () => {
  const log: Array<{ purpose: string; roles: string[]; lastUser: string }> = [];
  const root = tempRoot('orrot5-');
  // 容量配置：C=100000，硬容量包含完整冻结工具；软线仍保持测试触发值；软线压到 5000（<安全输入）→ 长输入触发 rotate（非 blocked_hard）
  const ctx = compose(root, scriptedTransport({ firstRound: 'text' }, 'incomplete', log), mariposaOk, { windows: { model_context_capacity: 100000, soft_limit_tokens: 5000 } });
  const big = '长话题。'.repeat(4000); // ~20000 字符 → 粗估 ≈8000 token：≥软线 5000、≤安全输入 11808
  const sub = await say(ctx, big, 's1', T0);
  const att = ctx.db.prepare('SELECT state, blocked_reason, window_id FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string; blocked_reason: string | null; window_id: string };
  assert.equal(att.state, 'completed', '换窗后本轮照常完成');
  const skipped = ctx.db.prepare("SELECT COUNT(*) n FROM rotation_reviews WHERE status='skipped_empty'").get() as { n: number };
  assert.equal(skipped.n, 1, '空范围记录 skipped_empty');
  assert.equal(log.filter((l) => l.purpose === 'pre_rotate_review').length, 0, '零新增范围不收费叫模型（§3.2.5）');
  const win2 = ctx.windows.activeWindow('c1')!;
  assert.equal(att.window_id, win2.id, '输入只进新窗一次');
  ctx.db.close();
});

test('跨窗继承：旧窗书签前内容焦点豁免，不重复评审（§3.2.4）', async () => {
  const log: Array<{ purpose: string; roles: string[]; lastUser: string }> = [];
  const root = tempRoot('orrot6-');
  const ctx = compose(root, scriptedTransport({ firstRound: 'text' }, 'hold_then_complete', log), mariposaOk);
  await say(ctx, '第一段话', 'k1', T0);
  // 2026-10-08 晚间：静默不换窗——长消息容量触发（时间间隔保留证明与静默无关）
  await say(ctx, `触发并 hold${'很长的容量触发内容。'.repeat(450)}`, 'k2', new Date(Date.parse(T0) + 25 * H).toISOString());
  assert.equal(log.filter((l) => l.purpose === 'pre_rotate_review').length, 2, '评审#1：hold + complete 两轮');
  await say(ctx, `再触发${'很长的容量触发内容。'.repeat(450)}`, 'k3', new Date(Date.parse(T0) + 51 * H).toISOString());
  // 评审#2 焦点只含未检查内容；k1/a1（书签之前/已检查）不重复出现
  const secondReview = log.filter((l) => l.purpose === 'pre_rotate_review')[2];
  assert.ok(secondReview, '评审#2 发生（有新未检查内容 k2/a2）');
  const focusOf = (l: { lastUser: string }): string => l.lastUser.match(/focus_message_refs: (.+)/)?.[1] ?? '';
  const focus2 = focusOf(secondReview);
  assert.ok(focus2.includes('msg_'), '焦点为具体消息引用');
  assert.ok(log.filter((l) => l.purpose === 'pre_rotate_review').length === 4, '评审#2 也是两轮（hold+complete）');
  ctx.db.close();
});
