// 二轮回归：route-edit 后 fresh_session 不 resume 旧 session 并改绑；换窗安全检查内部化；backup 水位从快照读。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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
import type { AgentRunner } from '../../apps/host/src/runtime/runner.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

function compose(root: string, runner: AgentRunner) {
  writeApprovedIdentity(root);
  const config = buildConfig(readyRuntimePatch());
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, routing, windows, supervisor };
}

// 她 1024 裁定③落地：票据对**第二条未派发、依法可编辑的输入**消费（不违已发送不可改规则）；
// 原"编辑已完成消息"场景保留为拒绝测试；事务回滚后票据/修订/attempt 全部不变。
test('route-edit 重跑：不 resume 旧 session；完成后窗口改绑新 session', async () => {
  const seenResume: Array<string | null> = [];
  const runner: AgentRunner = {
    kind: 'mock', interruptSupport: 'claimed',
    async run(req) {
      seenResume.push(req.resumeSessionId ?? null);
      return { outcome: 'completed', errorClassified: null, errorCode: null, errorMessage: null, sessionId: `session-${seenResume.length}`, requestId: null };
    },
  };
  const root = tempRoot('fs-');
  const ctx = compose(root, runner);
  // 第一轮：建立 session-1（这轮完成后消息已冻结，不可再编辑——留作拒绝场景）
  const t1 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一轮', clientMessageId: 'fs1' });
  ctx.supervisor.enqueue(t1.turnId);
  await ctx.supervisor.waitIdle();
  const win1 = ctx.windows.activeWindow('c1')!;
  assert.equal(win1.sdk_session_id, 'session-1', '首轮绑定');
  // —— 拒绝场景（原夹具非法前提保留为测试）：对已完成消息建票据后 edit → 422 ROUTE_EDIT_REJECTED，
  //    且事务回滚=票据仍 pending、无新修订/attempt
  const msg1 = ctx.messages.getMessage(t1.message.id)!;
  const rowDone = ctx.routing.createPending({ conversationId: 'c1', turnId: t1.turnId, attemptId: t1.attemptId, inputHash: msg1.revision.content_hash, targetModel: null, evidenceCode: 'TEST', messageId: msg1.id, inputRevision: msg1.current_revision });
  const rejected = ctx.routing.validateAndConsume(rowDone.id, { choice: 'edit', content: '非法编辑已完成消息' });
  assert.equal(rejected.ok, false, '已完成消息的 edit 必须拒绝');
  if (!rejected.ok) assert.equal(rejected.code, 'ROUTE_EDIT_REJECTED', `真实原因（得到 ${rejected.code}/${rejected.reason}）——不再伪装成消费冲突`);
  const rowDoneAfter = ctx.routing.get(rowDone.id)!;
  assert.equal((rowDoneAfter as unknown as { state: string }).state, 'pending', '事务回滚：票据仍 pending');
  const rev1After = (ctx.db.prepare('SELECT current_revision FROM messages WHERE id=?').get(msg1.id) as { current_revision: number }).current_revision;
  assert.equal(rev1After, msg1.current_revision, '事务回滚：消息修订不变');
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM attempts WHERE turn_id=?").get(t1.turnId) as { n: number }).n, 1, '事务回滚：无新 attempt');
  // 拒绝场景的票据会残留 pending 占会话 gate（产品流由路由层过期收口；测试显式作废避免污染合法场景）
  ctx.db.prepare("UPDATE route_decisions SET state='expired' WHERE id=?").run(rowDone.id);
  // —— 合法场景（裁定③夹具）：第二条**未派发**输入（pending turn 从未进模型请求=未冻结）
  const t2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第二轮原始内容', clientMessageId: 'fs2' });
  // 不 enqueue——保持未派发；直接建票据并消费 edit
  const msg2 = ctx.messages.getMessage(t2.message.id)!;
  const row = ctx.routing.createPending({ conversationId: 'c1', turnId: t2.turnId, attemptId: t2.attemptId, inputHash: msg2.revision.content_hash, targetModel: null, evidenceCode: 'TEST', messageId: msg2.id, inputRevision: msg2.current_revision });
  const consumed = ctx.routing.validateAndConsume(row.id, { choice: 'edit', content: '修订后输入' });
  assert.ok(consumed.ok, JSON.stringify(consumed.ok === false ? consumed : {}));
  // 消费一次性：重复提交不得再造一份
  const again = ctx.routing.validateAndConsume(row.id, { choice: 'edit', content: '再来一次' });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, 'ROUTE_ALREADY_RESOLVED', '重复提交=已解决，不重复落地');
  // 编辑轮重跑（fresh_session）→ 不 resume 旧 session
  ctx.supervisor.requeueConversationQueuedTurns('c1');
  await ctx.supervisor.waitIdle();
  assert.ok(seenResume.length >= 2 && seenResume.slice(0, 2).every((r) => r === null), `首轮与编辑重跑零 resume（actual=${JSON.stringify(seenResume)}）`);
  const winAfter = ctx.windows.get(win1.id)!;
  assert.ok(/^session-\d+$/.test(winAfter.sdk_session_id ?? '') && winAfter.sdk_session_id !== 'session-1', `重跑后窗口改绑新 session（得到 ${winAfter.sdk_session_id}）`);
  // 下一轮（普通）resume 改绑后的新 session
  const t3 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第三轮', clientMessageId: 'fs3' });
  ctx.supervisor.enqueue(t3.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal(seenResume.at(-1), winAfter.sdk_session_id, '后续轮 resume 改绑后的新 session');
  ctx.db.close();
});

test('换窗安全检查内部化：running turn 或待决票据 → Manager.rotate（无回调）也拒绝', () => {
  const root = tempRoot('rot-');
  const ctx = compose(root, { kind: 'mock', interruptSupport: 'claimed', async run() { return { outcome: 'completed', errorClassified: null, errorCode: null, errorMessage: null, sessionId: 's', requestId: null }; } });
  const gate = ctx.db ? (() => { const svc = new IdentityService(ctx.config, ctx.paths); return svc.evaluateGate(ctx.db); })() : null;
  assert.equal(gate.state, 'READY');
  ctx.windows.createWindow({ conversationId: 'c1', gate });
  // running turn（不走 supervisor，直接造状态）
  ctx.db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES ('tr1','c1','user_message','running','2026-01-01T00:00:00Z')").run();
  const r1 = ctx.windows.rotate({ conversationId: 'c1', gate, maxSequence: 1, assembledOptions: null });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.ok(r1.reason.includes('FENCE_ACTIVE'), `实际：${r1.reason}`);
  ctx.db.prepare("UPDATE turns SET state='completed' WHERE id='tr1'").run();
  // 待决路由票据同样拒绝
  ctx.db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES ('tr2','c1','user_message','pending','2026-01-01T00:00:00Z')").run();
  ctx.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, state) VALUES ('at2','tr2',1,'pending')").run();
  ctx.db.prepare("INSERT INTO route_decisions(id, conversation_id, turn_id, attempt_id, input_hash, source_evidence, state, version, created_at) VALUES ('rd1','c1','tr2','at2','h','TEST','pending',1,'2026-01-01T00:00:00Z')").run();
  const r2 = ctx.windows.rotate({ conversationId: 'c1', gate, maxSequence: 1, assembledOptions: null });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.ok(r2.reason.includes('ROUTE_PENDING'), `实际：${r2.reason}`);
  // 空闲时正常
  ctx.db.prepare("UPDATE route_decisions SET state='consumed' WHERE id='rd1'").run();
  const r3 = ctx.windows.rotate({ conversationId: 'c1', gate, maxSequence: 1, assembledOptions: null });
  assert.equal(r3.ok, true, '空闲时轮转正常');
  ctx.db.close();
});

test('backup 水位从快照读：快照后向源库写入，manifest 仍与快照一致', () => {
  const root = tempRoot('bk-');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, title, created_at) VALUES ('c1','estomago','private',NULL,'2026-01-01T00:00:00Z')").run();
  const insertMsg = (i: number) => {
    db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES (?,?,?, 'owner','text',1,?)").run(`m${i}`, 'c1', i, '2026-01-01T00:00:00Z');
    db.prepare("INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,1,'text',?,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','client_submit')").run(`r${i}`, `m${i}`, `c${i}`, sha256Hex(`c${i}`));
  };
  insertMsg(1);
  db.close();
  const env = { ...process.env, ESTOMAGO_HOME: root, PATH: process.env.PATH };
  execFileSync(process.execPath, [path.resolve('scripts/backup.mjs')], { env, encoding: 'utf8' });
  // 快照完成后向源库追加一条消息（模拟并发写）
  const db2 = openDatabase(path.join(root, 'data'));
  db2.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES ('m2','c1',2,'owner','text',1,'2026-01-01T00:00:00Z')").run();
  db2.prepare("INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('r2b','m2',1,'text','c2',?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','client_submit')").run(sha256Hex('c2'));
  db2.close();
  const manifestFile = fs.readdirSync(path.join(root, 'backups')).find((f) => f.endsWith('.manifest.json'))!;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'backups', manifestFile), 'utf8')) as { message_count: number; message_sequence_watermark: number };
  assert.equal(manifest.message_count, 1, 'manifest 计数必须描述快照（=1），不受快照后源库写入影响');
  assert.equal(manifest.message_sequence_watermark, 1);
});
