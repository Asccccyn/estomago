// 联合审计 2026-10-06 B1 批回归（F-J-01/02/54）：
//  - F-J-02：监督器级三步序列——turn1 成功 → turn2 hold 已提交但回合失败 → 后续换窗不再死锁
//    （旧行为：selectReviewRange 抛 BOOKMARK_OUTSIDE_MANIFEST → ROTATION_RANGE_INVALID 阻断，
//     容量触发变体每个 turn 都被拦=永久死锁；修复后=合法空范围 skipped_empty）
//  - F-J-54：带选集而回执绑定数不符 → unknown 收口（恢复走原 op），不换 op 重写桶
//  - F-J-01 形状断言见 hold-quote.test.ts（source_msg: 前缀）；真实两端正例见 probes（R01/R02）。
// 假 OR transport + 假 Mariposa（单测层）；零网络零真实模型。
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
import { selectReviewRange, type ManifestEntry } from '../../apps/host/src/context/review-policy.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const holdToolBody = (id: string, callId: string) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'memory_hold', arguments: JSON.stringify({ original_title: '第二条要记的事', creation_mode: 'contemporaneous', categories: ['daily'], text: 'turn2 的 hold——随后本回合会失败' }) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

// —— F-J-02 纯函数：书签高于清单高水位=合法空范围；结构守卫不放松 ——
const m = (id: string, seq: number, revision = 1): ManifestEntry => ({ id, revision, seq, origin: 'dialogue', visible: true });

test('F-J-02 纯函数：已核实书签高于清单高水位（hold 成功但回合未落轨迹）→ 空范围而非 BOOKMARK_OUTSIDE_MANIFEST', () => {
  const manifest = [m('m1', 1)]; // 轨迹只含成功回合（turn2 失败，m2 未入清单）
  const range = selectReviewRange({ manifest, epochId: 'w1', lastHold: { epochId: 'w1', seenSequence: 2 } });
  assert.deepEqual(range, [], '清单全部 ≤ 书签 → 提醒范围为空（调用方记 skipped_empty，不叫模型）');
  // 结构守卫不放松（禁止 catch 一切错误返回空数组的替代写法）
  assert.throws(() => selectReviewRange({ manifest: [{ ...m('m1', 1), seq: -1 } as ManifestEntry], epochId: 'w1', lastHold: null }), /MANIFEST_INVALID/);
  assert.throws(() => selectReviewRange({ manifest: [m('m1', 1), m('m1', 1)], epochId: 'w1', lastHold: null }), /MANIFEST_DUPLICATE/);
  assert.throws(() => selectReviewRange({ manifest: null as never, epochId: 'w1', lastHold: null }), /MANIFEST_REQUIRED/);
  // 跨窗书签不生效（旧窗 floor 不进本窗范围计算）
  const cross = selectReviewRange({ manifest: [m('m1', 1), m('m2', 2)], epochId: 'w2', lastHold: { epochId: 'w1', seenSequence: 5 } });
  assert.deepEqual(cross.map((x) => x.seq), [1, 2], '旧窗书签对本窗范围无效');
});

// —— F-J-02 监督器级：三步死锁序列回归 ——
const mariposaOk: MariposaTransport = async (capability, payload) => {
  if (capability === 'memory.hold') {
    const op = payload.operation_id as string;
    return { ok: true, result: { operation_id: op, memory_id: `mem-${op.slice(-6)}`, version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
  }
  return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
};

test('F-J-02 监督器级：turn1 成功 → turn2 hold 已提交但回合 500 失败 → 容量触发换窗不再被 ROTATION_RANGE_INVALID 阻断', async () => {
  const root = tempRoot('jab1-lock-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, windows: { soft_limit_tokens: 21_500 /* 裁定②1024 统一口径实测校准 */ } });
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
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposaOk }), reviews, checkpoint })
  wireOidoCapabilitiesForTest(tools, {});;
  const trajectory = new WindowTrajectoryService(db);
  // 脚本：turn1 文本成功；turn2 首轮 hold 工具调用、次轮（带工具结果）500 失败；turn3（新窗）文本成功
  let gen = 0;
  const transport: OrTransport = async () => {
    gen++;
    if (gen === 2) return { status: 200, headers: new Map<string, string>(), body: frameStream(holdToolBody(`g${gen}`, 'c2')) };
    if (gen === 3) return { status: 500, headers: new Map<string, string>(), body: frameStream(sse({ error: { message: '模拟上游瞬时故障' } })) };
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`g${gen}`, `回复${gen}`)) };
  };
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  const H = 60 * 60 * 1000;
  const T0 = '2026-10-03T08:00:00+08:00';
  const say = async (content: string, id: string, at: string) => {
    const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: at });
    supervisor.enqueue(sub.turnId);
    await supervisor.waitIdle();
    return sub;
  };
  // 第一步：turn1 成功（manifest=[m1]）
  const t1 = await say('第一条：今天聊点日常', 'j1', T0);
  const win1 = windows.activeWindow('c1')!;
  assert.equal((db.prepare('SELECT state FROM attempts WHERE id = ?').get(t1.attemptId) as { state: string }).state, 'completed');
  // 第二步：turn2 hold 成功（书签=2）但回合 500 失败（m2 不入轨迹 manifest）
  const t2 = await say('第二条：想记一件事', 'j2', new Date(Date.parse(T0) + 1 * H).toISOString());
  assert.equal((db.prepare('SELECT state FROM attempts WHERE id = ?').get(t2.attemptId) as { state: string }).state, 'failed', '回合确实失败（复现前提，不是只改期望值）');
  const cp = db.prepare('SELECT epoch_id, seen_sequence FROM hold_checkpoints WHERE room_id = ?').get('c1') as { epoch_id: string; seen_sequence: number };
  assert.equal(cp.epoch_id, win1.id, '书签在本窗');
  assert.equal(cp.seen_sequence, 3, 'hold 成功把书签推进到发起请求视野 seq=3（m1+助手回复后的第二条输入）');
  const trajRow = db.prepare('SELECT manifest_json FROM window_trajectories WHERE window_id = ?').get(win1.id) as { manifest_json: string | null };
  const manifest = JSON.parse(trajRow.manifest_json ?? '[]') as Array<{ seq: number }>;
  const manifestMax = manifest.reduce((mx, x) => Math.max(mx, x.seq), 0);
  assert.equal(manifestMax, 2, '失败回合输入不入清单——书签(3)高于清单高水位(2)，旧代码在此抛 BOOKMARK_OUTSIDE_MANIFEST');
  // 第三步：长消息越软线触发容量换窗（2026-10-08 晚间裁定：静默不再触发；时间仍隔 8h 以证明静默无关）——不再死锁
  const t3 = await say(`第三条：${'很长的容量触发内容。'.repeat(230) /* 2026-10-19 时间块瘦身——微调越线填充 */}`, 'j3', new Date(Date.parse(T0) + 8 * H).toISOString());
  const att3 = db.prepare('SELECT state, window_id FROM attempts WHERE id = ?').get(t3.attemptId) as { state: string; window_id: string };
  assert.equal(att3.state, 'completed', '换窗触发后本回合正常收口（旧代码：整 turn 被 ROTATION_RANGE_INVALID 阻断）');
  const win2 = windows.activeWindow('c1')!;
  assert.notEqual(win2.id, win1.id, '已切到新窗');
  assert.equal(att3.window_id, win2.id, '新输入只进新窗');
  const skip = db.prepare("SELECT window_id, status FROM rotation_reviews WHERE status = 'skipped_empty'").get() as { window_id: string; status: string } | undefined;
  assert.ok(skip, '空范围记 skipped_empty 凭证（不叫模型、不伪称全覆盖）');
  assert.equal(skip!.window_id, win1.id, '凭证属于旧窗');
  db.close();
});

// —— F-J-54：回执绑定数与选集数不符 → unknown（不重写桶） ——
function seedReceipt(db: ReturnType<typeof openDatabase>, messageId: string, revision: number, content: string, srcMsg: string): void {
  db.prepare(
    `INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at)
     VALUES (?, 'op-seed', ?, ?, 'src-c-j54', ?, ?, ?, ?)`,
  ).run(`ssr-${messageId}-${revision}`, messageId, revision, srcMsg, sha256Hex(content), new Date().toISOString(), new Date().toISOString());
}

async function execHoldWithBindingCount(db: ReturnType<typeof openDatabase>, bindingCount: number, messageId: string, content: string) {
  const reviews = new RotationReviewService(db);
  const transport: MariposaTransport = async (capability, payload) => {
    if (capability === 'memory.hold') {
      return { ok: true, result: { operation_id: payload.operation_id, memory_id: 'mem-j54', version: 1, binding_ids: Array.from({ length: bindingCount }, (_, i) => `msb-x-${i}`), committed_at: new Date().toISOString() } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport }), reviews, checkpoint: new HoldCheckpointService(db) })
  wireOidoCapabilitiesForTest(tools, {});;
  const out = await tools.execute('memory_hold', {
    __tool_call_id: 'call-j54',
    original_title: '回执完整性', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x',
    // R1′（2026-10-23）：60c6998 起 F-J-54 绑定核对按事件选集（source_ranges）算；
    // quotes 走我们的话勾选链路（1018 批），不再计入本核对。驱动改为 source_ranges。
    source_ranges: [{ start_seq: 1, end_seq: 1 }],
  }, { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [{ id: messageId, revision: 1 }], requestId: 'req-j54' });
  return { out, reviews };
}

test('F-J-54：带 1 条选集而回执 0 个绑定 → HOLD_RECEIPT_BINDING_MISMATCH + 账本 unknown（恢复走原 op）', async () => {
  const root = tempRoot('jab1-b54-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(new Date().toISOString());
  const content = '这是包含引用一句真实原话的完整消息';
  const msg = db.prepare(
    "INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES ('msg-j54','c1',1,'owner','text',1,?) RETURNING id",
  ).get(new Date().toISOString()) as { id: string };
  db.prepare(
    "INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('msg-j54',1,'text',?,?,'2026-10-03T08:00:00+08:00','2026-10-03T08:00:01+08:00','user')",
  ).run(content, sha256Hex(content));
  seedReceipt(db, msg.id, 1, content, 'sm-j54-real');
  const { out, reviews } = await execHoldWithBindingCount(db, 0, msg.id, content);
  assert.equal(out.ok, false);
  assert.equal(out.output.error_code, 'HOLD_RECEIPT_BINDING_MISMATCH');
  // R1′（2026-10-23）：expected/got 诊断数字按模型输出合同（bd677ed+docs/contracts/
  // model-result-whitelist.md）不进普通投影——错误码即失败信号，恢复由宿主按原 op
  // 核实。业务反例（可疑回执=unknown 账本、不换 op 重写桶）保留在下方账本断言。
  const effects = db.prepare('SELECT state FROM tool_side_effects').all() as Array<{ state: string }>;
  assert.ok(effects.some((e) => e.state === 'unknown'), '可疑回执=结果不明（换窗前 recoverUnknownEffects 按原 op 核实，不重写桶）');
  db.close();
});

test('F-J-54 对照：绑定数与选集数一致（1:1）→ 正常 committed', async () => {
  const root = tempRoot('jab1-b54ok-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(new Date().toISOString());
  const content = '这是包含引用一句真实原话的完整消息（对照）';
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES ('msg-j54b','c1',1,'owner','text',1,?)").run(new Date().toISOString());
  db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('msg-j54b',1,'text',?,?,'2026-10-03T08:00:00+08:00','2026-10-03T08:00:01+08:00','user')").run(content, sha256Hex(content));
  seedReceipt(db, 'msg-j54b', 1, content, 'sm-j54b-real');
  const { out } = await execHoldWithBindingCount(db, 1, 'msg-j54b', content);
  assert.equal(out.ok, true, `1 选集 1 绑定应通过（得到 ${JSON.stringify(out.output).slice(0, 200)}）`);
  db.close();
});
