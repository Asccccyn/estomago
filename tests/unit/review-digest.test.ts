// 昨天日结（她裁定 2026-10-07）回归：
//  - 只做昨天（上海自然日）；hold 书签之后未归档的闲聊才进日结
//  - DS 写（complete 可注入）；千问本地接口预留未安装（显式拒）
//  - 空日（hold 覆盖全/无闲聊）=不注入不花钱；失败不伪造待重试
//  - 与换窗 hold 提醒共用一个开关：reminders.enabled=false → 不发评审提醒
//    （skipped 凭证如实定位）也不做日结
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { DailyDigestService, prevShanghaiDay } from '../../apps/host/src/digest/daily.ts';
import { tempRoot } from '../helpers.ts';

const SH = 8 * 60 * 60 * 1000;

function setup(complete?: (p: string) => Promise<string>, remindersEnabled = true, provider: 'deepseek' | 'qwen-local' = 'deepseek') {
  const root = tempRoot('digest-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const config = {
    reminders: { enabled: remindersEnabled },
    digest: { provider, max_messages: 400 },
    deepseek: { base_url: 'https://example.invalid', model: 'ds-test', api_key_env: 'DS_KEY_NONE' },
  } as const;
  const svc = new DailyDigestService({ db, config: config as never, ...(complete ? { complete } : {}) });
  return { db, svc };
}

function seedMsg(db: ReturnType<typeof openDatabase>, id: string, speaker: 'owner' | 'assistant', content: string, occurredAt: string, seq: number) {
  db.prepare("INSERT OR IGNORE INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES (?,'c1',?,?,'text',1,?)").run(id, seq, speaker, occurredAt);
  db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,? ,? ,?,'user')").run(id, content, sha256Hex(content), occurredAt, occurredAt);
}

const yesterday = prevShanghaiDay();
const yDayStartUtc = Date.parse(`${yesterday}T00:00:00Z`) - SH;
const at = (h: number, m = 0) => new Date(yDayStartUtc + h * 3600e3 + m * 60e3).toISOString();

test('日结：昨天未归档闲聊 → 一行一话题索引；同日幂等只写一次', async () => {
  let calls = 0;
  const { db, svc } = setup(async (p) => { calls++; assert.ok(p.includes('昨天没归档的闲聊甲'), '提示词含昨天未归档原文'); return '10:00 她 · 聊了假期计划\n11:30 他 · 确认了车票'; });
  seedMsg(db, 'm1', 'owner', '昨天没归档的闲聊甲', at(10), 1);
  seedMsg(db, 'm2', 'assistant', '好的确认', at(11, 30), 2);
  const s1 = await svc.yesterdaySection();
  assert.ok(s1 && s1.includes('昨天闲聊索引'), '注入段在场');
  assert.ok(s1!.includes('假期计划'), '摘要内容注入');
  await svc.yesterdaySection();
  assert.equal(calls, 1, '同日幂等（每日一次，不重复花钱）');
  const row = db.prepare('SELECT status, message_count FROM daily_digests WHERE day=?').get(yesterday) as { status: string; message_count: number };
  assert.equal(row.status, 'ready');
  assert.equal(row.message_count, 2);
  db.close();
});

test('日结：hold 书签之后的才算未归档；空日不花钱；失败不伪造', async () => {
  let calls = 0;
  const { db, svc } = setup(async () => { calls++; return 'x'; });
  seedMsg(db, 'm1', 'owner', '已被书签覆盖的昨日闲聊', at(10), 1);
  // 书签覆盖到 seq 1 → 昨天无未归档 → empty
  db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES ('w1','c1','ACTIVE','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO hold_checkpoints(window_id, room_id, epoch_id, seen_sequence, request_id, receipt_id, memory_id, operation_id, updated_at) VALUES ('w1','c1','w1',1,'rq','rc','m','op',?)").run(at(23));
  const empty = await svc.yesterdaySection();
  assert.equal(empty, null, 'hold 覆盖全=不注入');
  assert.equal(calls, 0, '空日不叫模型');
  const row = db.prepare('SELECT status FROM daily_digests WHERE day=?').get(yesterday) as { status: string };
  assert.equal(row.status, 'empty');
  db.close();

  // 失败路径：新的一天没有 ready 时 complete 抛错 → failed 记录、不伪造
  const root2 = setup(async () => { throw new Error('模拟 DS 不可用'); });
  seedMsg(root2.db, 'x1', 'owner', '昨天没归档的闲聊乙', at(9), 1);
  const failed = await root2.svc.yesterdaySection();
  assert.equal(failed, null, '失败不伪造摘要');
  const frow = root2.db.prepare('SELECT status, last_error FROM daily_digests WHERE day=?').get(yesterday) as { status: string; last_error: string };
  assert.equal(frow.status, 'failed');
  assert.match(frow.last_error, /模拟 DS 不可用/);
  root2.db.close();
});

test('日结：千问本地接口预留未安装（显式拒）；开关关=不做日结', async () => {
  const qwen = setup(undefined, true, 'qwen-local');
  seedMsg(qwen.db, 'q1', 'owner', '昨天没归档的闲聊丙', at(8), 1);
  const out = await qwen.svc.yesterdaySection();
  assert.equal(out, null, 'qwen-local 未安装=无日结（不伪造）');
  const qrow = qwen.db.prepare('SELECT status, last_error FROM daily_digests WHERE day=?').get(yesterday) as { status: string; last_error: string };
  assert.equal(qrow.status, 'failed');
  assert.match(qrow.last_error, /QWEN_LOCAL_NOT_INSTALLED/);
  qwen.db.close();

  // 开关关 → ensureYesterday 直接 null（不查库不叫模型）
  const off = setup(async () => { throw new Error('不应被调用'); }, false);
  const none = await off.svc.yesterdaySection();
  assert.equal(none, null);
  assert.equal(off.db.prepare('SELECT COUNT(*) n FROM daily_digests').get().n, 0, '开关关=零副作用');
  off.db.close();
});

// —— 开关统管：reminders.enabled=false → 换窗不发 hold 提醒（skipped 凭证如实） ——
import { Readable } from 'node:stream';
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
import { writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';

const enc2 = new TextEncoder();
const sse2 = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE2 = 'data: [DONE]\n\n';
const textBody2 = (id: string, text: string) => sse2({ id, choices: [{ delta: { content: text } }] }) + sse2({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE2;
const frame2 = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc2.encode(`${x}\n\n`)));

test('开关：reminders.enabled=false → 换窗不发评审提醒（不付费），消息照常', async () => {
  const root = tempRoot('digest-sw-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'ds' }, reminders: { enabled: false } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: (async () => ({ ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 })) as MariposaTransport }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  const chatLog: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async () => { chatLog.push({}); return { status: 200, headers: new Map(), body: frame2(textBody2('g', '回')) }; };
  const runner = new DeepSeekRunner({ retryMax: 0 }, async (payload) => { chatLog.push({ messages: payload.messages }); return transport(payload); });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing: new RoutingService(db, events, messages), windows, logger: new Logger(path.join(root, 'logs')), tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  const T0 = '2026-10-07T09:00:00+08:00';
  const say = async (id: string, at: string) => {
    const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `话${id}`, clientMessageId: id, occurredAt: at });
    supervisor.enqueue(sub.turnId);
    await supervisor.waitIdle();
  };
  await say('a', T0);
  await say('b', new Date(Date.parse(T0) + 8 * 3600e3).toISOString()); // 8h 静默 → idle 换窗
  const skipped = db.prepare("SELECT status, basis_json FROM rotation_reviews WHERE basis_json LIKE '%reminders_disabled%' ORDER BY created_at DESC LIMIT 1").get() as { status: string; basis_json: string } | undefined;
  assert.ok(skipped, '换窗记录 skipped 凭证（reason=reminders_disabled，如实定位不伪造覆盖）');
  assert.equal(skipped.status, 'skipped_empty');
  // 未发评审提醒：每条消息恰好一次 chat 请求（评审会额外产生请求）
  const chatRequests = chatLog.filter((e) => Array.isArray(e.messages));
  assert.equal(chatRequests.length, 2, '只有两次聊天请求，无评审请求（关=不提醒不付费）');
  const att = db.prepare("SELECT state FROM attempts ORDER BY id").all() as Array<{ state: string }>;
  assert.ok(att.every((a) => a.state === 'completed' || a.state === 'completed_partial' || a.state === 'completed'), '消息照常完成');
  db.close();
});
