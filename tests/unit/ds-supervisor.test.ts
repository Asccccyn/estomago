// DS 直连驱动 × 宿主管线回归（2026-10-05）：驱动分发/身份映射隔离在 supervisor 层落地 +
// 评审失败重试上限（审计 P2-1）+ 评审请求停止键（审计 P2-2）。假 DS transport + 假 Mariposa，零网络。
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
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { buildRecordSnapshot } from '../../apps/host/src/server/records.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, pollUntil } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'deepseek-chat';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6, prompt_cache_hit_tokens: 16 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

const mariposaOk: MariposaTransport = async (capability, payload) => {
  if (capability === 'memory.hold') {
    const op = payload.operation_id as string;
    return { ok: true, result: { operation_id: op, memory_id: `mem-${op.slice(-6)}`, version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
  }
  return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
};

type Seen = Array<{ payload: Record<string, unknown>; roleShape: string }>;

/** 假 DS transport：评审轮（提醒文本）回纯文本不调 complete（模拟失控模型）；聊天轮回文本。
 *  同时做字段自检：任何 OR/Anthropic 字段泄漏直接抛错（P1-1 回归防线）。 */
function neverCompleteTransport(seen: Seen): OrTransport {
  let gen = 0;
  return async (payload) => {
    for (const k of ['session_id', 'provider', 'plugins', 'cache_control']) {
      if (payload[k] !== undefined) throw new Error(`DS 字段自检失败：泄漏 ${k}`);
    }
    if (JSON.stringify(payload.messages ?? []).includes('cache_control')) throw new Error('DS 字段自检失败：块级 cache_control');
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.map((b) => (b as { text?: string }).text ?? '').join('\n') : '';
    seen.push({ payload, roleShape: messages.map((m) => m.role).join(',') });
    gen++;
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`gen-ds-${gen}`, '（不调用完成工具的回复）')) };
  };
}

function compose(root: string, transport: OrTransport, configOver: Record<string, unknown> = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' },
    deepseek: { model: MODEL },
    ...configOver,
  });
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
  const tools = new HostToolExecutor({ mariposa: new MariposaClient({ transport: mariposaOk }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, windows, reviews, checkpoint, supervisor, runnerSelection: { status: 'ok' as const, runner } };
}

const T0 = '2026-10-01T08:00:00+08:00';

async function say(ctx: ReturnType<typeof compose>, content: string, clientMsgId: string, occurredAt: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: clientMsgId, occurredAt });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

test('DS 直连端到端：turn 完成、payload 干净、usage=ds_stream、记录快照 driver=deepseek', async () => {
  const seen: Seen = [];
  const root = tempRoot('dssup1-');
  const ctx = compose(root, neverCompleteTransport(seen));
  const sub = await say(ctx, '你好，记一下今天心情不错', 'd1', T0);
  const att = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed');
  assert.ok(seen.length >= 1, '至少一次真实发送');
  // usage 归集：ds_stream 口径 + DS 缓存命中观测
  const usage = ctx.db.prepare("SELECT source, model, input_tokens, cache_read_input_tokens FROM usage_observations WHERE attempt_id = ?").all(sub.attemptId) as Array<{ source: string; model: string; input_tokens: number; cache_read_input_tokens: number }>;
  assert.ok(usage.length > 0 && usage.every((u) => u.source === 'ds_stream'), 'usage 按 ds_stream 口径归集');
  assert.equal(usage[0]!.model, MODEL, '记账用 DS 明确型号');
  assert.equal(usage[0]!.cache_read_input_tokens, 16, 'prompt_cache_hit_tokens 落 cache_read');
  // 轨迹已建立（信封驱动共用管线）
  const win = ctx.windows.activeWindow('c1')!;
  assert.ok(ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id));
  // 记录快照：driver=deepseek、型号、TTL=auto、无假过期线
  const snap = buildRecordSnapshot({ db: ctx.db, config: ctx.config, windows: ctx.windows, runnerSelection: ctx.runnerSelection }, 'c1', null);
  assert.equal(snap.driver, 'deepseek');
  assert.equal(snap.exactModel, MODEL);
  assert.equal(snap.cache.requestedTtl, 'auto', 'DS 自动缓存：无显式 TTL 参数');
  assert.equal(snap.cache.estimatedExpiresAt, null, '不画 1h 估计线（OR 专属）');
  assert.equal(snap.cache.lastRead, 16, '缓存命中观测可见');
  ctx.db.close();
});

test('评审失败重试上限（审计 P2-1）：同窗 3 次失败后不再自动付费评审，消息仍保存', async () => {
  const seen: Seen = [];
  const root = tempRoot('dssup2-');
  // 容量配置压低软线（C=40000 → 安全输入≈11808；soft=3000）：长输入每条都触发换窗评审
  const ctx = compose(root, neverCompleteTransport(seen), { windows: { model_context_capacity: 40000, soft_limit_tokens: 3000, warning_tokens: 2500 } });
  // 第 1 条：短输入不触发换窗，正常完成（给窗口留轨迹底）
  const s1 = await say(ctx, '开头。'.repeat(100), 'r1', T0);
  assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(s1.attemptId) as { state: string }).state, 'completed');
  // 第 2-4 条：长输入每条触发一次评审，模型都不调 complete → 失败 → turn blocked
  for (let i = 2; i <= 4; i++) {
    const sub = await say(ctx, `话题${i}。`.repeat(1500), `r${i}`, new Date(Date.parse(T0) + i * 60_000).toISOString());
    const att = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string; blocked_reason: string };
    assert.equal(att.state, 'blocked', `第 ${i} 条：评审失败如实阻断`);
    assert.ok(att.blocked_reason!.startsWith('ROTATION_REVIEW_FAILED'), `第 ${i} 条阻断原因（得到 ${att.blocked_reason}）`);
  }
  const failed = ctx.db.prepare("SELECT COUNT(*) n FROM rotation_reviews WHERE status = 'failed'").get() as { n: number };
  assert.equal(failed.n, 3, '恰好 3 次失败评审（每次 1 个付费请求）');
  const reviewReqsBefore = (ctx.db.prepare("SELECT COUNT(*) n FROM provider_requests WHERE purpose = 'pre_rotate_review'").get() as { n: number }).n;
  assert.equal(reviewReqsBefore, 3, '评审请求数=3（有界）');
  // 第 5 条：达上限 → 不再发评审，ROTATION_REVIEW_RETRY_EXHAUSTED
  const s5 = await say(ctx, '话题5。'.repeat(1500), 'r5', new Date(Date.parse(T0) + 5 * 60_000).toISOString());
  const att5 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(s5.attemptId) as { state: string; blocked_reason: string };
  assert.equal(att5.state, 'blocked');
  assert.ok(att5.blocked_reason!.startsWith('ROTATION_REVIEW_RETRY_EXHAUSTED'), `上限后给出恢复指引（得到 ${att5.blocked_reason}）`);
  const reviewReqsAfter = (ctx.db.prepare("SELECT COUNT(*) n FROM provider_requests WHERE purpose = 'pre_rotate_review'").get() as { n: number }).n;
  assert.equal(reviewReqsAfter, 3, '不再新增评审请求（钱不再烧）');
  // 消息本体仍保存（原文全存）
  const saved = ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE speaker = 'owner'").get() as { n: number };
  assert.equal(saved.n, 5);
  ctx.db.close();
});

test('评审请求可被停止键中断（审计 P2-2）：abort 生效、评审失败收口、不发布正文', async () => {
  const root = tempRoot('dssup3-');
  // 评审轮挂住直到 abort（模拟长生成的评审请求）；聊天轮正常回文本
  let enteredReview = false;
  let sawAbort = false;
  let gen = 0;
  const hangTransport: OrTransport = async (payload, signal) => {
    for (const k of ['session_id', 'provider', 'plugins', 'cache_control']) {
      if (payload[k] !== undefined) throw new Error(`DS 字段自检失败：泄漏 ${k}`);
    }
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.map((b) => (b as { text?: string }).text ?? '').join('\n') : '';
    const isReview = text.includes('宿主运行事件');
    if (!isReview) {
      gen++;
      return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`gen-ds-${gen}`, '收到')) };
    }
    enteredReview = true;
    // 挂住：帧发完后等 abort，以错误终止（真实 fetch 的 abort 行为）
    const frames = [enc.encode(sse({ id: 'gen-review', choices: [{ delta: { content: '评审' } }] }) + '\n\n')];
    return new Promise((resolve) => {
      let i = 0;
      const stream = new Readable({
        read() {
          if (i < frames.length) { this.push(frames[i]!); i++; return; }
          const t = setInterval(() => {
            if (signal.aborted) { sawAbort = true; clearInterval(t); this.destroy(new Error('The operation was aborted')); }
          }, 5);
        },
      });
      resolve({ status: 200, headers: new Map<string, string>(), body: stream });
    });
  };
  const ctx = compose(root, hangTransport, { windows: { model_context_capacity: 40000, soft_limit_tokens: 3000, warning_tokens: 2500 } });
  await say(ctx, '开头。'.repeat(100), 'h1', T0); // 短输入：正常完成（给窗口留轨迹底）
  // 第二条长输入触发评审：不等待完成，进入评审后按停止键
  const sub2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '长话题。'.repeat(1500), clientMessageId: 'h2', occurredAt: new Date(Date.parse(T0) + 120_000).toISOString() });
  ctx.supervisor.enqueue(sub2.turnId);
  await pollUntil(() => enteredReview, 5000, 10);
  const stop = ctx.supervisor.stop(sub2.turnId);
  assert.equal(stop.stopped, true, '评审期停止键生效（此前 active 表查无此键→永远停不下来）');
  await ctx.supervisor.waitIdle();
  const att2 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(sub2.attemptId) as { state: string; blocked_reason: string };
  assert.equal(att2.state, 'blocked');
  assert.ok(att2.blocked_reason!.startsWith('ROTATION_REVIEW_FAILED'), '评审被中断=未完成，如实阻断');
  assert.ok(sawAbort, 'abort 信号送达 transport（上游真的停了）');
  const review = ctx.db.prepare("SELECT status FROM rotation_reviews ORDER BY created_at DESC LIMIT 1").get() as { status: string };
  assert.equal(review.status, 'failed');
  ctx.db.close();
});
