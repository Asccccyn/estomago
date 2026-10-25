// WP3（MANUAL_HANDOFF_JUDGE_SWITCH_V1，她裁定 2026-10-08）人工历史选集：
//  - H01：awaiting(items=NULL，未提交)≠空选；explicit_empty 才是空选
//  - H02：>500 条历史选旧消息/不连续片段/书签前消息均可选；间隙如实披露
//  - H03：选择只建立引用——messages/revisions/outbox 计数不变
//  - H04：待回答/排队输入不作历史；确认后原 input_message_id 恢复只发一次
//  - H05：超限 CONTEXT_SELECTION_TOO_LARGE（保留选择不裁剪）
//  - H06：preview 后编辑 → confirm 旧 hash = CONTEXT_SELECTION_STALE 定位冲突
//  - H07：手动/容量换窗无确认 → CONTEXT_SELECTION_REQUIRED + awaiting 持久
//  - H08：等待选择不占房间串行锁（confirm 可达）
//  - H09：幂等键重复只应用一次；expected_revision 冲突拒
//  - H13：已有历史无活动窗不擅自空选；真全新空房自动建窗
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
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, pollUntil } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'deepseek-chat';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

const mariposaOk: MariposaTransport = async () => ({ ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 });

function dsTransport(seen: Array<Record<string, unknown>>): OrTransport {
  let gen = 0;
  return async (payload) => {
    seen.push(payload as Record<string, unknown>);
    gen++;
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`gen-wp3-${gen}`, '好的')) };
  };
}

function compose(root: string, transport: OrTransport, configOver: Record<string, unknown> = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' },
    deepseek: { model: MODEL },
    reminders: { enabled: false }, // 集成流走提醒关闭捷径（确定性）；选集门不受该开关影响
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
  const selections = new ManualSelectionService(db);
  const windows = new WindowManager(db, events, identity, config, selections);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposaOk }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory, selections });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, selections, reviews };
}

const T0 = '2026-10-01T08:00:00+08:00';
const T1 = '2026-10-01T09:00:00+08:00';

async function say(ctx: ReturnType<typeof compose>, content: string, clientMsgId: string, occurredAt: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: clientMsgId, occurredAt });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

function seedHistorical(ctx: ReturnType<typeof compose>, id: string, content: string, seq: number, speaker: 'owner' | 'assistant' = 'owner') {
  ctx.db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES (?,'c1',?,?,'text',1,?,?)").run(id, seq, speaker, T0, T0);
  ctx.db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,?,?,?,'seed')").run(id, content, sha256Hex(content), T0, T0);
}

// ---------------------------------------------------------------- 服务单元

test('H01：awaiting items=NULL ≠ 空选；explicit_empty 才确认 items=[]', async () => {
  const root = tempRoot('wp3-h01-');
  writeApprovedIdentity(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const svc = new ManualSelectionService(db);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO windows(id, conversation_id, status, revision, created_at, updated_at) VALUES ('w1','c1','ACTIVE',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  const awaiting = svc.ensureAwaiting({ conversationId: 'c1', sourceWindowId: 'w1', expectedWindowRevision: 1, cutoffSequence: 5 });
  assert.equal(awaiting.status, 'awaiting');
  assert.equal(awaiting.items, null, 'awaiting 的 items 是 NULL（未提交≠空选）');
  // 缺 items 且未显式空选 → 拒绝
  const r0 = svc.confirm({ conversationId: 'c1', sourceWindowId: 'w1', expectedWindowRevision: 1, items: [], explicitEmpty: false, idempotencyKey: null, cutoffSequence: 5, estimate: { charsPerToken: 1.5, systemChars: 100, tailInputChars: 10 }, capacityBoundTokens: 1000 });
  assert.equal(r0.ok, false);
  assert.equal((r0 as { error: { code: string } }).error.code, 'CONTEXT_SELECTION_REVISION_CONFLICT');
  // 幂等 ensureAwaiting 不重复建行
  const again = svc.ensureAwaiting({ conversationId: 'c1', sourceWindowId: 'w1', expectedWindowRevision: 2, cutoffSequence: 6 });
  assert.equal(again.selection_id, awaiting.selection_id);
  db.prepare("UPDATE windows SET revision = 2 WHERE id = 'w1'").run(); // 与刷新后的期望修订对齐
  // 显式空选 → confirmed + items=[]
  const r1 = svc.confirm({ conversationId: 'c1', sourceWindowId: 'w1', expectedWindowRevision: 2, items: [], explicitEmpty: true, idempotencyKey: 'k-h01', cutoffSequence: 6, estimate: { charsPerToken: 1.5, systemChars: 100, tailInputChars: 10 }, capacityBoundTokens: 1000 });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const row = svc.get((r1 as { selection: { selection_id: string } }).selection.selection_id)!;
  assert.equal(row.status, 'confirmed');
  assert.deepEqual(row.items, [], '明确空选的 items 是 []（与 awaiting 的 NULL 严格区分）');
  db.close();
});

test('H02：>500 条历史选旧消息/不连续；间隙如实披露不限最近 N 条', async () => {
  const root = tempRoot('wp3-h02-');
  writeApprovedIdentity(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const svc = new ManualSelectionService(db);
  db.prepare("INSERT OR IGNORE INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private','2026-01-01T00:00:00Z')").run();
  for (let i = 1; i <= 520; i++) {
    db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES (?, 'c1', ?, 'owner', 'text', 1, ?, '2026-01-01T00:00:00Z')").run(`msg${i}`, i, '2026-01-01T00:00:00Z');
    db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?, 1, 'text', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'seed')").run(`msg${i}`, `历史消息${i}号`, sha256Hex(`历史消息${i}号`));
  }
  const v = svc.validateItems('c1', [{ message_id: 'msg7' }, { message_id: 'msg300' }, { message_id: 'msg519' }], 520);
  assert.equal(v.ok, true, JSON.stringify(v));
  const items = (v as { items: Array<{ sequence: number }> }).items;
  assert.deepEqual(items.map((i) => i.sequence), [7, 300, 519], '服务器按 sequence 排序，不限最近 N 条');
  const gaps = svc.gapsOf((v as { items: Array<{ sequence: number; message_id: string }> }).items as never);
  assert.equal(gaps.length, 2, '三段不相邻 → 两个间隙如实标注');
  assert.deepEqual(gaps.map((g) => g.skipped), [292, 218], '间隙略过条数=真实缺口');
  db.close();
});

test('H05：超限 CONTEXT_SELECTION_TOO_LARGE——保留选择、不裁剪、不代写', async () => {
  const root = tempRoot('wp3-h05-');
  writeApprovedIdentity(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const svc = new ManualSelectionService(db);
  db.prepare("INSERT OR IGNORE INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO windows(id, conversation_id, status, revision, created_at, updated_at) VALUES ('w1','c1','ACTIVE',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  const big = '很长的历史正文'.repeat(500);
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m1','c1',1,'owner','text',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('m1',1,'text',?,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','seed')").run(big, sha256Hex(big));
  const r = svc.confirm({ conversationId: 'c1', sourceWindowId: 'w1', expectedWindowRevision: 1, items: [{ message_id: 'm1' }], explicitEmpty: false, idempotencyKey: null, cutoffSequence: 1, estimate: { charsPerToken: 1.5, systemChars: 0, tailInputChars: 0 }, capacityBoundTokens: 100 });
  assert.equal(r.ok, false);
  const err = (r as { error: { code: string; deficit_tokens: number } }).error;
  assert.equal(err.code, 'CONTEXT_SELECTION_TOO_LARGE');
  assert.ok((err.deficit_tokens ?? 0) > 0, '缺口估计随错误给出');
  db.close();
});

test('H06：preview 后编辑所选消息 → 旧 hash/revision 确认 = STALE 并定位冲突', async () => {
  const root = tempRoot('wp3-h06-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: MODEL } });
  void config;
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const messages = new MessageService(db);
  const svc = new ManualSelectionService(db);
  messages.ensureConversation('c1');
  const m = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '旧正文', clientMessageId: 'c', occurredAt: T0 });
  await (async () => { /* 完成 turn 不必要——直接编辑 */ })();
  messages.editUserMessage(m.message.id, '新正文');
  // preview 时按旧修订 hash（模拟 preview 快照后发生编辑）
  const oldHash = sha256Hex('旧正文');
  const v = svc.validateItems('c1', [{ message_id: m.message.id, revision: 1, content_hash: oldHash }], 1);
  assert.equal(v.ok, false);
  const err = (v as { error: { code: string; conflicts: Array<{ message_id: string }> } }).error;
  assert.equal(err.code, 'CONTEXT_SELECTION_STALE');
  assert.deepEqual(err.conflicts.map((c) => c.message_id), [m.message.id], '冲突引用精确定位');
  db.close();
});

test('H09：幂等键重复只应用一次；expected_window_revision 仅留痕不比较（B11）', async () => {
  const root = tempRoot('wp3-h09-');
  writeApprovedIdentity(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO windows(id, conversation_id, status, revision, created_at, updated_at) VALUES ('w1','c1','ACTIVE',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  const svc = new ManualSelectionService(db);
  const a = svc.confirm({ conversationId: 'c1', sourceWindowId: 'w1', expectedWindowRevision: 1, items: [], explicitEmpty: true, idempotencyKey: 'idem-1', cutoffSequence: 0, estimate: { charsPerToken: 1.5, systemChars: 0, tailInputChars: 0 }, capacityBoundTokens: 1000 });
  assert.equal(a.ok, true);
  // 同键再提交不同内容 → 返回已生效方案（不二次应用）
  const b = svc.confirm({ conversationId: 'c1', sourceWindowId: 'w1', expectedWindowRevision: 1, items: [], explicitEmpty: true, idempotencyKey: 'idem-1', cutoffSequence: 0, estimate: { charsPerToken: 1.5, systemChars: 0, tailInputChars: 0 }, capacityBoundTokens: 1000 });
  assert.equal(b.ok, true);
  const rows = db.prepare("SELECT COUNT(*) n FROM context_selections WHERE status='confirmed'").get() as { n: number };
  assert.equal(rows.n, 1, '重复幂等请求不产生第二份方案');
  // WP-05（B11）：旧「expectedWindowRevision 冲突拒」恒真分支已删——
  // windows.revision 自建窗起从不递增（CAS 永真=假防护）；窗口被并发
  // 轮转的防护由恢复路径承担（旧窗 CLOSED→走 createWindow 分支）。
  // 期望修订参数保留在行上（审计留痕），confirm 不再比较。
  const c = svc.confirm({ conversationId: 'c1', sourceWindowId: 'w1', expectedWindowRevision: 99, items: [], explicitEmpty: true, idempotencyKey: 'idem-2', cutoffSequence: 0, estimate: { charsPerToken: 1.5, systemChars: 0, tailInputChars: 0 }, capacityBoundTokens: 1000 });
  // 已 confirmed 的方案再确认（异键）→ CX-08 结构化冲突（与期望修订
  // 无关——revision 比较已随恒真分支删除）
  assert.equal((c as { error: { code: string } }).error.code,
    'CONTEXT_SELECTION_ALREADY_CONFIRMED');
  db.close();
});

// ---------------------------------------------------------------- 集成（supervisor 链路）

test('H04/H07/H08/H13 集成：容量触发换窗→awaiting 阻断（锁释放）→确认选集→原输入恢复一次', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const root = tempRoot('wp3-int-');
  // 软线调小：第二条消息即触发换窗（走容量路径；warning_tokens 已退役不再配置）
  const ctx = compose(root, dsTransport(seen), { windows: { soft_limit_tokens: 21_500 /* 裁定②1024 统一口径实测校准 */ /* 2026-10-17 输出协议行；1024 裁定②+目录底座，相对位不变 */ } } as never);
  // H13 正例：真全新空房 → 首条消息自动建窗（不要求选集）
  // 历史在其后种行（模拟更早已归档的存量原文进入本房间）
  const s1 = await say(ctx, '今天聊点新的', 'm1', T0);
  seedHistorical(ctx, 'hist1', '很久以前的早餐对话内容', 10);
  seedHistorical(ctx, 'hist2', '后来的确认', 11, 'assistant');
  const att1 = ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(s1.attemptId) as { state: string };
  assert.equal(att1.state, 'completed');
  const win1 = ctx.windows.activeWindow('c1')!;
  // 第二轮：长输入越软线 → 换窗需要选集 → 阻断（H07 容量入口）
  const beforeCounts = {
    messages: (ctx.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n,
    revisions: (ctx.db.prepare('SELECT COUNT(*) n FROM message_revisions').get() as { n: number }).n,
    outbox: (ctx.db.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number }).n,
  };
  const longInput = `第二段很长的输入，用于越过软线触发换窗。${'内容填充。'.repeat(500)}`; // 2026-10-21 time_context 人话化再瘦——重标定——微调填充保证越旧窗软线且新窗预算仍装得下（触发语义不变）
  const s2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: longInput, clientMessageId: 'm2', occurredAt: T1 });
  ctx.supervisor.enqueue(s2.turnId);
  await ctx.supervisor.waitIdle();
  const att2 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(s2.attemptId) as { state: string; blocked_reason: string };
  assert.equal(att2.state, 'blocked', '待选集输入被阻断（不丢、不自动携带）');
  assert.ok(att2.blocked_reason.startsWith('CONTEXT_SELECTION_REQUIRED'), `阻断原因是选集等待：${att2.blocked_reason.slice(0, 60)}`);
  // awaiting 已持久（H07）；窗口未换
  const awaiting = ctx.selections.awaitingFor('c1')!;
  assert.ok(awaiting, 'awaiting 持久存在');
  assert.equal(ctx.windows.activeWindow('c1')!.id, win1.id, '等待选择期间旧窗保持 ACTIVE');
  // H03：选择建立前 messages/revisions/outbox 计数不变（选择只引用）
  const midCounts = {
    messages: (ctx.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n,
    revisions: (ctx.db.prepare('SELECT COUNT(*) n FROM message_revisions').get() as { n: number }).n,
  };
  assert.equal(midCounts.messages, beforeCounts.messages + 1, '只多了待回答输入本身');
  // H08：确认走 supervisor 面（房间锁已释放——若锁被占此调用会排队而非死锁）
  const preview = ctx.supervisor.selectionPreview('c1', win1.id, [{ message_id: 'hist1' }, { message_id: 'hist2' }]);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const pv = (preview as { result: { count: number; gaps: unknown[]; fits: boolean } }).result;
  assert.equal(pv.count, 2);
  assert.deepEqual(pv.gaps, [], 'seq 1、2 相邻无间隙');
  assert.equal(pv.fits, true);
  const confirm = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: win1.id, items: [{ message_id: 'hist1' }, { message_id: 'hist2' }], explicitEmpty: false, idempotencyKey: 'wp3-int-confirm' });
  assert.equal(confirm.ok, true, JSON.stringify(confirm));
  const conf = confirm as unknown as { rotated: boolean; windowId: string; resumed: number };
  assert.equal(conf.rotated, true, '确认后自动换窗');
  assert.equal(conf.resumed, 1, '恰好一条被阻断输入恢复');
  await ctx.supervisor.waitIdle();
  // H04：原 input_message_id 恢复、只发一次、消息不重复
  const turn2 = ctx.db.prepare('SELECT state, input_message_id FROM turns WHERE id = ?').get(s2.turnId) as { state: string; input_message_id: string };
  console.error('DBG-A:', JSON.stringify(ctx.db.prepare("SELECT id, state, blocked_reason FROM attempts WHERE turn_id = ?").all(s2.turnId)));
  console.error('DBG-B:', JSON.stringify(ctx.db.prepare("SELECT selection_id, source_window_id, status, source_cutoff_sequence FROM context_selections ORDER BY created_at").all()));
  console.error('DBG-W:', JSON.stringify(ctx.db.prepare("SELECT id, status, context_fingerprint IS NOT NULL as fp, blocked_reason FROM windows ORDER BY created_at").all()));
  assert.equal(turn2.state, 'completed', JSON.stringify(ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id=?').get(s2.attemptId)));
  assert.equal(turn2.input_message_id, s2.message.id, '原输入消息身份不变');
  const dupCount = (ctx.db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?').get('c1') as { n: number }).n;
  // = 之前 + 待回答输入 1 条 + 该回合的助手回复 1 条（选择本身零新增）
  assert.equal(dupCount, beforeCounts.messages + 2, '无重复消息/无"历史气泡"副本（只多输入与回复本身）');
  const outboxAfter = (ctx.db.prepare('SELECT COUNT(*) n FROM outbox').get() as { n: number }).n;
  assert.equal(outboxAfter, beforeCounts.outbox + 2, 'outbox 只多输入与回复的归档任务（选择零归档）');
  // 选集已消费并绑定目标窗；新窗轨迹含所选历史（引用装配，非自动 12k）
  const newWin = ctx.windows.activeWindow('c1')!;
  assert.notEqual(newWin.id, win1.id);
  const sel = ctx.selections.forTargetWindow(newWin.id);
  assert.ok(sel && sel.status === 'consumed', '选集 consumed 且绑定目标窗');
  const traj = ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(newWin.id) as { messages_json: string };
  assert.ok(traj.messages_json.includes('很久以前的早餐对话内容'), '新窗轨迹含所选历史正文（服务端按真实修订装配）');
  assert.ok(!traj.messages_json.includes('今天聊点新的'), '未选中的旧窗近期原话不再自动携带');
  // R04 合并（原 remediation-batch2/batch5 F06 退役）：①新窗 manifest 与库内消息/实际装载正文一一对应；
  // ②容量触发的换窗评审范围 ⊆ 旧窗实际已见清单（不登记未携带消息）
  const newTraj = new WindowTrajectoryService(ctx.db).forWindow(newWin.id)!;
  const newTrajText = JSON.stringify(newTraj.messages);
  const dbRows = ctx.db.prepare('SELECT m.id, m.current_revision, m.sequence, r.content FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision WHERE m.conversation_id = ?').all('c1') as Array<{ id: string; current_revision: number; sequence: number; content: string }>;
  for (const entry of newTraj.manifest!) {
    const row = dbRows.find((r) => r.id === entry.id && r.current_revision === entry.revision && r.sequence === entry.seq);
    assert.ok(row, `清单条目 ${entry.id} 能对上库内消息`);
    assert.ok(newTrajText.includes(row!.content), `清单条目 ${entry.id} 的正文确实在轨迹中`);
  }
  const review = ctx.db.prepare('SELECT range_keys_json FROM rotation_reviews ORDER BY created_at DESC LIMIT 1').get() as { range_keys_json: string } | undefined;
  assert.ok(review, '容量触发产生了换窗评审');
  const oldTraj = new WindowTrajectoryService(ctx.db).forWindow(win1.id)!;
  const rangeKeys = JSON.parse(review.range_keys_json) as string[];
  assert.ok(rangeKeys.every((k) => oldTraj.manifest!.some((m) => `${m.id}@${m.revision}` === k)), '评审范围 ⊆ 实际已见清单（不登记未携带消息）');
  // 未选的旧窗消息仍在库（原文保留）
  const kept = ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE id = ?").get(s1.message.id) as { n: number };
  assert.equal(kept.n, 1, '未选历史原文不被删除');
  ctx.db.close();
});

test('H13：已有历史但无活动窗 → awaiting 阻断；真全新空房自动建窗', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const root = tempRoot('wp3-h13-');
  const ctx = compose(root, dsTransport(seen));
  // 存量历史 + 无任何窗口
  seedHistorical(ctx, 'old1', '存量历史消息', 1);
  const s1 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '新输入', clientMessageId: 'm1', occurredAt: T0 });
  ctx.supervisor.enqueue(s1.turnId);
  await ctx.supervisor.waitIdle();
  const att = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(s1.attemptId) as { state: string; blocked_reason: string };
  assert.equal(att.state, 'blocked');
  assert.ok(att.blocked_reason.startsWith('CONTEXT_SELECTION_REQUIRED'), '已有历史无活动窗：不擅自空选');
  // WP-03（JFA-009/B02）：preview 也认哨兵源——无活动窗不核验就确认的前端
  // 死锁路径不存在了
  const awaiting = ctx.selections.awaitingFor('c1')!;
  assert.ok(awaiting.source_window_id.startsWith('csel-src-'), '无活动窗的 awaiting 源是哨兵');
  const pre = ctx.supervisor.selectionPreview('c1', awaiting.source_window_id, [{ message_id: 'old1' }]);
  assert.equal(pre.ok, true, JSON.stringify(pre));
  // 确认（哨兵源）→ 建窗恢复
  const confirm = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: awaiting.source_window_id, items: [{ message_id: 'old1' }], explicitEmpty: false, idempotencyKey: 'h13' });
  assert.equal(confirm.ok, true, JSON.stringify(confirm));
  await ctx.supervisor.waitIdle();
  const turn = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(s1.turnId) as { state: string };
  assert.equal(turn.state, 'completed', '确认后建窗并恢复输入');
  const win = ctx.windows.activeWindow('c1')!;
  const traj = ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id = ?').get(win.id) as { messages_json: string };
  assert.ok(traj.messages_json.includes('存量历史消息'), '新窗按选集装配存量历史');
  ctx.db.close();
});
