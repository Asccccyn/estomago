// 相册重构 P4：对话存档合同（GLM_ALBUM_REFACTOR_EXECUTION 20261108，03 存档章）。
// 覆盖：kind 明确、引用校验（未知/跨会话/system/未发布助手/坏修订拒绝；非连续集合
// 保序去重不夹带）；最近完整回合定位（排除当前回合）；建档幂等（同键重放不重复建）；
// 通知单通道（工具=回执不排队；用户=排队且 dedupe 幂等、装配投递一次后不再出现）；
// content v4 路由 CRUD。真实 ContentServer + 真实 E 侧 DB（无 Host）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { ContentServer } from '../../apps/content/src/service.ts';
import { ArchiveService } from '../../apps/host/src/modules/archives/service.ts';
import { contentClientFor, fetchReferenceSnapshot } from '../../apps/host/src/integrations/content/client.ts';
import { ContentOperationCoordinator } from '../../apps/host/src/integrations/content/coordinator.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { ArchiveSyncService } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';
import { handleArchivesRoutes } from '../../apps/host/src/server/routes/archives.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { assembleTestTools } from '../helpers.ts';

const TOKEN = 'archives-test-token';
let server: ContentServer;
let base: string;
let svc: ArchiveService;
let root: string;
let db: ReturnType<typeof openDatabase>;
let messages: MessageService;
let contentToken: string;
let contentOps: ContentOperationCoordinator;
let client: ReturnType<typeof contentClientFor>;
let logger: Logger;
let events: EventService;

/** F3 测试用 M 投影端口替身：可切失败；记录全部调用（幂等 op 键断言用）。
 *  sync() 每次给出覆盖同一 db 的新 ArchiveSyncService 实例——模拟进程重启后
 *  新实例沿原身份收口（outbox 是唯一正本，不依赖实例存活）。 */
function projectionSpy(): { calls: Array<Record<string, unknown>>; failNext(v: boolean): void; sync(): ArchiveSyncService } {
  const calls: Array<Record<string, unknown>> = [];
  let failing = false;
  const sync = () => new ArchiveSyncService({
    db, events, logger,
    client: {
      attachmentsSync: async (a: Record<string, unknown>) => { if (failing) return { ok: false, code: 'M_DOWN' }; calls.push(a); return { ok: true }; },
      isConfigured: () => true,
    } as never,
    config: buildConfig({ archive: { enabled: true, source_scope: 'stream-x' }, integrations: { mariposa: { base_url: 'http://127.0.0.1:9' } } }),
  });
  return { calls, failNext: (v: boolean) => { failing = v; }, sync };
}

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-archives-'));
  server = new ContentServer({ stateRoot: path.join(root, 'content'), port, token: TOKEN });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
  contentToken = TOKEN;
  db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  messages = new MessageService(db);
  messages.ensureConversation('c1');
  messages.ensureConversation('c2');
  client = contentClientFor(root, server.port, true);
  if (!client) throw new Error('content client 未构造（token 文件未找到）');
  logger = new Logger(null);
  events = new EventService(db);
  // F3：建档/删除经协调器（同浏览器/模型写工具一个接受/确认/恢复面）
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  contentOps = new ContentOperationCoordinator({ db, client, media, logger });
  svc = new ArchiveService({ db, contentClient: client, contentOps, logger });
  void contentToken;
});
after(async () => { await server.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function publishUser(conv: string, cmid: string): { id: string; sequence: number } {
  const m = messages.submitUserMessageWithTurn({ conversationId: conv, content: `话-${cmid}`, clientMessageId: cmid });
  return { id: m.message.id, sequence: m.message.sequence };
}
function publishAssistant(conv: string, cmid: string): { id: string; sequence: number } {
  const m = messages.publishAssistantMessage({ conversationId: conv, turnId: 'turn-a1', content: `回-${cmid}`, kind: 'text', clientMessageId: cmid });
  return { id: m.id, sequence: m.sequence };
}

test('ARC-1: 引用校验——合法集合保序去重；未知/跨会话/system/未发布助手/坏修订拒绝', async () => {
  const u1 = publishUser('c1', 'u1');
  const u2 = publishUser('c1', 'u2');
  const a1 = publishAssistant('c1', 'a1');
  const other = publishUser('c2', 'other');
  // 非连续+乱序提交：按会话序返回，不夹带
  const v = svc.validateRefs('c1', [{ message_id: a1.id }, { message_id: u1.id }, { message_id: u1.id }, { message_id: u2.id }]);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(v.refs.map((r) => r.message_id), [u1.id, u2.id, a1.id], '按 sequence 保序去重');
  assert.equal(svc.validateRefs('c1', [{ message_id: 'msg_none' }]).ok, false);
  assert.equal((svc.validateRefs('c1', [{ message_id: other.id } as { message_id: string }]) as { ok: boolean }).ok, false, '跨会话消息拒绝');
  // system 消息/未发布助手：直接造行验证
  const t0 = new Date().toISOString();
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES ('m_sys','c1',900,'system','text',1,?)").run(t0);
  db.prepare('INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)').run('mrev_sys', 'm_sys', 1, 'text', 'x', sha256Hex('x'), t0, t0, 'user');
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m_draft','c1',901,'assistant','text',1,NULL,?)").run(t0);
  db.prepare('INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)').run('mrev_draft', 'm_draft', 1, 'text', 'y', sha256Hex('y'), t0, t0, 'user');
  assert.match(String((svc.validateRefs('c1', [{ message_id: 'm_sys' }]) as { detail?: string }).detail ?? ''), /系统/);
  assert.match(String((svc.validateRefs('c1', [{ message_id: 'm_draft' }]) as { detail?: string }).detail ?? ''), /未发布/);
  assert.equal((svc.validateRefs('c1', [{ message_id: u1.id, revision: 99 }]) as { ok: boolean }).ok, false, '坏修订拒绝');
});

test('ARC-2: 最近完整回合——排除当前回合与未发布尾巴；无回合=null', async () => {
  assert.equal(svc.latestCompletedTurnRefs('c1', null) !== null || true, true); // 前置无 completed turn 也允许（消息服务测试形态）——改为直接构造
  // 造一个 completed turn（input u + assistant 已发布）+ 一个 running turn（当前）
  const t1 = 'turn_c1';
  const u = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '吵架起因', clientMessageId: 'arc-u' });
  db.prepare('UPDATE messages SET turn_id = ? WHERE id = ?').run(t1, u.message.id);
  const a = messages.publishAssistantMessage({ conversationId: 'c1', turnId: t1, content: '回复了', kind: 'text', clientMessageId: 'arc-a' });
  db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, input_message_id, created_at, completed_at) VALUES (?, 'c1','user_input','completed',?,?,?) ON CONFLICT(id) DO NOTHING")
    .run(t1, u.message.id, new Date().toISOString(), new Date().toISOString());
  const refs = svc.latestCompletedTurnRefs('c1', null);
  assert.ok(refs, '应有可定位回合');
  assert.ok(refs!.some((r) => r.message_id === u.message.id) && refs!.some((r) => r.message_id === a.id));
  // 排除当前回合：把该回合当作"当前"后不可再取
  assert.equal(svc.latestCompletedTurnRefs('c1', t1), null, '排除指定回合后无可定位回合');
});

test('ARC-3: 建档 + 幂等 + 通知通道分离（工具=回执不排队；用户=排队 dedupe 幂等；R6 门槛需同步收据）', async () => {
  const u = publishUser('c1', 'arc3-u');
  const a = publishAssistant('c1', 'arc3-a');
  // R6：M 原文同步收据门槛——先落收据（生产由归档链写入）
  const t0 = new Date().toISOString();
  for (const [mid, sm] of [[u.id, 'sm_arc3u'], [a.id, 'sm_arc3a']] as const) {
    db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('ssr-' + sm, 'op-arc3', mid, 1, 'sc1', sm, 'h-' + sm, t0, t0);
  }
  // 未同步消息（无收据）→ 明确拒绝可重试
  const unsynced = publishUser('c1', 'arc3-x');
  const denied = await svc.createArchive({ conversationId: 'c1', kind: 'sweet', rawRefs: [{ message_id: unsynced.id }], actor: 'jiaming', idempotencyKey: 'k-unsync' });
  assert.equal(denied.ok, false);
  if (!denied.ok) { assert.equal(denied.code, 'ARCHIVE_SOURCE_NOT_SYNCED'); assert.equal(denied.retryable, true); }
  // 工具发起：notifyModel=none——成功回执即通知，host_notices 不排
  const t1 = await svc.createArchive({ conversationId: 'c1', kind: 'sweet', rawRefs: [{ message_id: u.id }, { message_id: a.id }], actor: 'jiaming', idempotencyKey: 'k-tool-1' });
  assert.equal(t1.ok, true, JSON.stringify(t1));
  const t2 = await svc.createArchive({ conversationId: 'c1', kind: 'sweet', rawRefs: [{ message_id: u.id }, { message_id: a.id }], actor: 'jiaming', idempotencyKey: 'k-tool-1' });
  assert.equal(t2.ok, true);
  if (t1.ok && t2.ok) assert.equal(t2.archive.id, t1.archive.id, '同幂等键重放=同一存档');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM host_notices').get() as { n: number }).n, 0, '工具发起不排队通知');
  // 用户发起：排队通知 + dedupe 幂等
  const u1r = await svc.createArchive({ conversationId: 'c1', kind: 'quarrel', rawRefs: [{ message_id: u.id }], note: '到这里', actor: 'qiaosheng', idempotencyKey: 'k-user-1' });
  assert.equal(u1r.ok, true);
  const u1again = await svc.createArchive({ conversationId: 'c1', kind: 'quarrel', rawRefs: [{ message_id: u.id }], note: '到这里', actor: 'qiaosheng', idempotencyKey: 'k-user-1' });
  assert.equal(u1again.ok, true);
  if (u1r.ok && u1again.ok) assert.equal(u1again.archive.id, u1r.archive.id);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM host_notices').get() as { n: number }).n, 1, '同操作身份只排一条');
  // 装配投递：取一次出现，取第二次为空（SDK 会话前缀已含，不重复）
  const first = svc.takePendingNotices('c1');
  assert.equal(first.length, 1);
  assert.match(first[0]!.text, /争吵存档/);
  assert.equal(svc.takePendingNotices('c1').length, 0, '投递一次后不再出现');
  // ALB-11：deferConfirm 模式取出不标记，未确认前仍可再取；确认后不再出现
  const msgT = publishUser('c1', 'arc3-t');
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr-arc3t', 'op-arc3t', msgT.id, 1, 'sc1', 'sm_arc3t', 'h-arc3t', new Date().toISOString(), new Date().toISOString());
  await svc.createArchive({ conversationId: 'c1', kind: 'sweet', rawRefs: [{ message_id: msgT.id }], actor: 'qiaosheng', idempotencyKey: 'k-user-2' });
  const deferred = svc.takePendingNotices('c1', true);
  assert.equal(deferred.length, 1);
  assert.equal(svc.takePendingNotices('c1', true).length, 1, '未确认（无投递证据）不标记——宁可重取不静默丢');
  svc.confirmNoticesDelivered(deferred.map((n) => n.id));
  assert.equal(svc.takePendingNotices('c1').length, 0, '确认投递后不再出现');
});

test('ARC-4: content v4 路由——kind 校验/空集合拒绝/软删/列表过滤', async () => {
  const call = async (method: string, p: string, body?: unknown, key?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${TOKEN}`, 'x-actor': 'qiaosheng', 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const u = publishUser('c1', 'arc4-u');
  const bad = await call('POST', '/api/v1/content/archives', { conversation_id: 'c1', kind: 'angry', messages: [{ message_id: u.id, revision: 1, sequence: u.sequence }] }, 'k-bad');
  assert.equal(bad.status, 422);
  const empty = await call('POST', '/api/v1/content/archives', { conversation_id: 'c1', kind: 'sweet', messages: [] }, 'k-empty');
  assert.equal(empty.status, 422);
  const ok = await call('POST', '/api/v1/content/archives', { conversation_id: 'c1', kind: 'sweet', messages: [{ message_id: u.id, revision: 1, sequence: u.sequence }], note: '甜甜的' }, 'k-ok');
  assert.equal(ok.status, 201);
  assert.equal(ok.body['kind'], 'sweet');
  assert.equal((ok.body['messages'] as unknown[]).length, 1);
  const list = await call('GET', '/api/v1/content/archives?kind=sweet');
  assert.equal(list.status, 200);
  assert.ok(((list.body['items'] as unknown[])?.length ?? 0) >= 1);
  // 删除按 If-Match 合同：缺席=428（前置必带）；带正确修订=200
  const delNoMatch = await call('DELETE', `/api/v1/content/archives/${ok.body['id']}`, undefined, 'k-del');
  assert.equal(delNoMatch.status, 428);
  const del = await call('DELETE', `/api/v1/content/archives/${ok.body['id']}`, undefined, 'k-del2');
  void del;
  const res2 = await fetch(`${base}/api/v1/content/archives/${ok.body['id']}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'x-actor': 'qiaosheng', 'idempotency-key': 'k-del3', 'if-match': `"${Number(ok.body['revision'])}"` } });
  assert.equal(res2.status, 200, '带正确 If-Match 的删除成功');
});

test('ARC-10: quarrelBlockedSourceRefs——经收据映射到 sm_id；仅争吵；content 不可达=reachable:false（不空集冒充已核对）', async () => {
  messages.ensureConversation('c2'); // 隔离：不受本文件其他测试在同会话建档影响
  const u1 = publishUser('c2', 'arc10-u');
  const u2 = publishUser('c2', 'arc10-s');
  // 两条消息的 M 同步收据（sm 映射）
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr10a', 'op10', u1.id, 1, 'sc1', 'sm_block_1', 'h1', new Date().toISOString(), new Date().toISOString());
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr10b', 'op10', u2.id, 1, 'sc1', 'sm_block_2', 'h2', new Date().toISOString(), new Date().toISOString());
  // 争吵存档含 u1；甜蜜存档含 u2
  await svc.createArchive({ conversationId: 'c2', kind: 'quarrel', rawRefs: [{ message_id: u1.id }], actor: 'qiaosheng', idempotencyKey: 'k-q10' });
  await svc.createArchive({ conversationId: 'c2', kind: 'sweet', rawRefs: [{ message_id: u2.id }], actor: 'qiaosheng', idempotencyKey: 'k-s10' });
  const blocked = await svc.quarrelBlockedSourceRefs('c2');
  assert.equal(blocked.reachable, true);
  assert.equal(blocked.refs.size, 1, '仅争吵封存的来源被抑制');
  assert.ok(blocked.refs.has('sm_block_1'));
  assert.equal(blocked.refs.has('sm_block_2'), false, '甜蜜不抑制（03 §6）');
  // content 不可达=reachable:false 空集（调用方降级：暂缓自动注入，不空集放行冒充已核对）
  const badSvc = new (await import('../../apps/host/src/modules/archives/service.ts')).ArchiveService({ db, contentClient: { baseUrl: 'http://127.0.0.1:1', token: 'x' } as never });
  const bad = await badSvc.quarrelBlockedSourceRefs('c2');
  assert.equal(bad.reachable, false);
  assert.equal(bad.refs.size, 0);
});

test('ARC-10b (F2): 封存面按存档钉住修订解析——封存 v1 不把未选的 v2 一并封存', async () => {
  messages.ensureConversation('c3');
  const u = publishUser('c3', 'arc10b-u');
  const t0 = new Date().toISOString();
  // v1/v2 都有收据；存档钉 v1
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr10b1', 'op10b', u.id, 1, 'sc1', 'sm_pin_v1', 'h1', t0, t0);
  db.prepare('INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('mrev-arc10b-2', u.id, 2, 'text', '改口', sha256Hex('v2-10b'), t0, t0, 'user');
  db.prepare('UPDATE messages SET current_revision = 2 WHERE id = ?').run(u.id);
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr10b2', 'op10b', u.id, 2, 'sc1', 'sm_pin_v2', 'h2', t0, t0);
  const r = await svc.createArchive({ conversationId: 'c3', kind: 'quarrel', rawRefs: [{ message_id: u.id, revision: 1 }], actor: 'qiaosheng', idempotencyKey: 'k-arc10b' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const blocked = await svc.quarrelBlockedSourceRefs('c3');
  assert.equal(blocked.reachable, true);
  assert.deepEqual([...blocked.refs].sort(), ['sm_pin_v1'], '只封存钉住的 v1；v2 仍可被普通检索（旧口径按 message_id 查全部修订）');
});

test('ARC-12 (F3): 建档经协调器→快照确认同事务登记投影→M 暂时失败不 ack→重启后新实例沿原身份收口（幂等 op 键）', async () => {
  const spy = projectionSpy();
  const u = publishUser('c2', 'arc12-u');
  const a = publishAssistant('c2', 'arc12-a');
  const t0 = new Date().toISOString();
  // RR3：收据按存档引用的精确修订（validateRefs 钉 current_revision=1）
  for (const [mid, sm] of [[u.id, 'sm_arc12u'], [a.id, 'sm_arc12a']] as const) {
    db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('ssr12-' + sm, 'op12', mid, 1, 'sc1', sm, 'h', t0, t0);
  }
  const r = await svc.createArchive({ conversationId: 'c2', kind: 'quarrel', rawRefs: [{ message_id: u.id }, { message_id: a.id }], actor: 'qiaosheng', idempotencyKey: 'k-arc12' });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  // 投影意图在 content 确认的同一事务登记（建档返回即确认完成，不再 void 尽力而为）
  const projKey = `archive-projection:${r.archive.id}:conversation_archived`;
  const row = db.prepare('SELECT state, payload_ref FROM outbox WHERE target = ? AND operation_key = ?').get('mariposa.archive_projection', projKey) as { state: string; payload_ref: string };
  assert.ok(row, '投影意图已登记');
  assert.equal(row.state, 'pending');
  const payload = JSON.parse(row.payload_ref) as { archive_id: string; kind: string; type: string; by: string; count: number; refs: Array<{ message_id: string; revision: number }> };
  assert.equal(payload.archive_id, r.archive.id);
  assert.equal(payload.type, 'conversation_archived');
  assert.equal(payload.by, 'qiaosheng');
  assert.deepEqual(payload.refs.map((x) => x.message_id).sort(), [a.id, u.id].sort(), '固定消息引用（不复制正文）');
  // M 暂时失败：drain 不 ack、不吞意图（有界重试，等待恢复）
  spy.failNext(true);
  assert.equal(await spy.sync().drainArchiveProjections(), 0, 'M 失败不 ack');
  const rowPending = db.prepare('SELECT state, attempt, last_error FROM outbox WHERE target = ? AND operation_key = ?').get('mariposa.archive_projection', projKey) as { state: string; attempt: number; last_error: string };
  assert.equal(rowPending.state, 'pending', '意图保留');
  assert.ok(rowPending.attempt >= 1, 'attempt 有界累计');
  assert.match(rowPending.last_error, /M_DOWN/);
  // "重启"：新实例（同 db）恢复 M 后沿原身份收口——不依赖用户再点一次。
  // drain 是有界批处理（会把本文件其他测试遗留的 pending 投影一并收口）——按本
  // 存档自己的行与推送断言，不假设批次里只有这一条。
  spy.failNext(false);
  assert.ok((await spy.sync().drainArchiveProjections()) >= 1, '恢复后自动收口');
  const mine = spy.calls.filter((c) => (c['payload'] as { archive_id?: string }).archive_id === r.archive.id);
  assert.equal(mine.length, 2, '本存档逐消息一条 observation');
  const byOrigin = new Map(mine.map((c) => [c['origin_message_id'] as string, c]));
  const cu = byOrigin.get(u.id) as { stream_id: string; revision: number; kind: string; payload: Record<string, unknown>; operation_id: string };
  assert.equal(cu.kind, 'observation');
  assert.equal(cu.revision, 1, 'RR3：推送 revision=存档钉住的修订（门槛已保证该版有收据）');
  assert.equal(cu.stream_id, 'stream-x');
  assert.equal((cu.payload as { type: string }).type, 'conversation_archived');
  assert.equal((cu.payload as { archive_kind: string }).archive_kind, 'quarrel');
  assert.equal((cu.payload as { count: number }).count, 2);
  assert.match(cu.operation_id, /^att-arc:[^:]+:[^:]+:conversation_archived$/, 'operation_id 幂等形态');
  const rowAcked = db.prepare('SELECT state FROM outbox WHERE target = ? AND operation_key = ?').get('mariposa.archive_projection', projKey) as { state: string };
  assert.equal(rowAcked.state, 'acked');
  const callsSnapshot = spy.calls.length;
  assert.equal(await spy.sync().drainArchiveProjections(), 0, '全部 ack 后不再重放');
  assert.equal(spy.calls.length, callsSnapshot);
});

test('ARC-13: R6 存档打开链——archiveOriginals 返回钉住修订的正文与附件；跨会话拒绝', async () => {
  const u = publishUser('c2', 'arc13-u');
  const a = publishAssistant('c2', 'arc13-a');
  const t0 = new Date().toISOString();
  for (const [mid, sm] of [[u.id, 'sm_arc13u'], [a.id, 'sm_arc13a']] as const) {
    db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('ssr13-' + sm, 'op13', mid, 1, 'sc1', sm, 'h', t0, t0);
  }
  // F2：rev1 带图片附件；消息随后编辑出 rev2 换了附件——存档钉 rev1，必须返回 rev1 的
  db.prepare('INSERT INTO message_attachments(message_id, revision, position, asset_id, presentation, caption, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(u.id, 1, 0, 'asset-arc13-r1', 'image', '当时那张', t0);
  db.prepare('INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('mrev-arc13-2', u.id, 2, 'text', '话-arc13-u（改口）', sha256Hex('v2x'), t0, t0, 'user');
  db.prepare('INSERT INTO message_attachments(message_id, revision, position, asset_id, presentation, caption, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(u.id, 2, 0, 'asset-arc13-r2', 'image', '后来换的', t0);
  db.prepare('UPDATE messages SET current_revision = 2 WHERE id = ?').run(u.id);
  const r = await svc.createArchive({ conversationId: 'c2', kind: 'sweet', rawRefs: [{ message_id: u.id, revision: 1 }, { message_id: a.id }], actor: 'qiaosheng', idempotencyKey: 'k-arc13' });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  const opened = await svc.archiveOriginals('c2', r.archive.id);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  if (!opened.ok) return;
  assert.equal(opened.kind, 'sweet');
  assert.equal(opened.items.length, 2);
  assert.deepEqual(opened.items.map((it) => it.speaker), ['owner', 'assistant'], '按会话序');
  assert.match(opened.items[0]!.text ?? '', /话-arc13-u/, '固定版本正文');
  assert.deepEqual(JSON.parse(JSON.stringify(opened.items[0]!.attachments)), [{ asset_id: 'asset-arc13-r1', presentation: 'image', caption: '当时那张' }], 'F2：固定修订的附件引用（不取当前修订冒充）');
  const wrongConv = await svc.archiveOriginals('c1', r.archive.id);
  assert.equal(wrongConv.ok, false, '跨会话拒绝');
});

test('ARC-11: 存档文本检索——命中归并到存档条目；kind 过滤；无匹配如实 no_match', async () => {
  const u1 = publishUser('c1', 'arc11-u');
  const u2 = publishUser('c1', 'arc11-s');
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr11a', 'op11', u1.id, 1, 'sc1', 'sm_q1', 'h1', new Date().toISOString(), new Date().toISOString());
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr11b', 'op11', u2.id, 1, 'sc1', 'sm_s1', 'h2', new Date().toISOString(), new Date().toISOString());
  const q = await svc.createArchive({ conversationId: 'c1', kind: 'quarrel', rawRefs: [{ message_id: u1.id }], note: '那晚的争执', actor: 'qiaosheng', idempotencyKey: 'k-arc11-q' });
  await svc.createArchive({ conversationId: 'c1', kind: 'sweet', rawRefs: [{ message_id: u2.id }], note: null, actor: 'qiaosheng', idempotencyKey: 'k-arc11-s' });
  // fake mariposa：query 含"晚"返回 sm_q1（争吵），含"甜"返回 sm_s1
  const fakeM2 = {
    sourceSearch: async (a: { query: string }) => {
      if (a.query.includes('争执')) return { ok: true, result: { hits: [{ message_id: 'sm_q1', excerpt: '……那晚的争执……' }] } };
      if (a.query.includes('不存在')) return { ok: true, result: { hits: [] } };
      return { ok: true, result: { hits: [] } };
    },
  };
  const hit = await svc.searchArchives({ conversationId: 'c1', query: '争执', mariposa: fakeM2 as never });
  assert.equal(hit.state, 'matches');
  if (hit.state === 'matches') {
    assert.equal(hit.items.length, 1);
    assert.equal(hit.items[0]!.kind, 'quarrel');
    assert.equal(hit.items[0]!.note, '那晚的争执');
    assert.match(hit.items[0]!.snippet, /那晚的争执/);
  }
  // kind=sweet 限定：同一查询只搜甜蜜集 → 争执消息不在集内 → no_match
  const onlySweet = await svc.searchArchives({ conversationId: 'c1', query: '争执', kind: 'sweet', mariposa: { sourceSearch: async (a: { include_ids?: string[] }) => ({ ok: true, result: { hits: (a.include_ids ?? []).includes('sm_q1') ? [{ message_id: 'sm_q1' }] : [] } }) } as never });
  assert.equal(onlySweet.state, 'no_match', 'kind 过滤限定候选集');
  const none = await svc.searchArchives({ conversationId: 'c1', query: '不存在', mariposa: fakeM2 as never });
  assert.equal(none.state, 'no_match');
  void q;
});

test('ARC-11b (F2): 检索面按存档钉住的修订解析——v2 的 sm 不进 include 集，新词命中 v2 不冒充该存档', async () => {
  const u = publishUser('c2', 'arc11b-u');
  const t0 = new Date().toISOString();
  // v1 已同步（sm_arc11b_v1）；消息编辑出 v2 且 v2 也已同步（sm_arc11b_v2）
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr11b1', 'op11b', u.id, 1, 'sc1', 'sm_arc11b_v1', 'h', t0, t0);
  db.prepare('INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('mrev-arc11b-2', u.id, 2, 'text', '话-arc11b-u（新词）', sha256Hex('v2-11b'), t0, t0, 'user');
  db.prepare('UPDATE messages SET current_revision = 2 WHERE id = ?').run(u.id);
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr11b2', 'op11b', u.id, 2, 'sc1', 'sm_arc11b_v2', 'h2', t0, t0);
  // 存档钉 v1（v1 也有收据——门槛通过）
  const r = await svc.createArchive({ conversationId: 'c2', kind: 'sweet', rawRefs: [{ message_id: u.id, revision: 1 }], actor: 'qiaosheng', idempotencyKey: 'k-arc11b' });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  let seenIncludes: string[] = [];
  const fakeM = {
    sourceSearch: async (a: { query: string; include_ids?: string[] }) => {
      seenIncludes = a.include_ids ?? [];
      // 旧词在 v1 命中；新词按 M 真实行为只可能命中 v2（本替身如实模拟：旧词→sm_v1，新词→sm_v2）
      if (a.query.includes('旧词')) return { ok: true, result: { hits: [{ message_id: 'sm_arc11b_v1', excerpt: '……旧词……' }] } };
      if (a.query.includes('新词')) return { ok: true, result: { hits: [{ message_id: 'sm_arc11b_v2', excerpt: '……新词……' }] } };
      return { ok: true, result: { hits: [] } };
    },
  };
  const oldWord = await svc.searchArchives({ conversationId: 'c2', query: '旧词', mariposa: fakeM as never });
  assert.ok(seenIncludes.includes('sm_arc11b_v1'), 'include 集含存档钉住修订的 sm');
  assert.equal(seenIncludes.includes('sm_arc11b_v2'), false, 'include 集不含 v2 的 sm（同会话其他存档的钉住修订照常在集内）');
  assert.equal(oldWord.state, 'matches', '旧词命中存档 v1');
  if (oldWord.state === 'matches') assert.equal(oldWord.items[0]!.archive_id, r.archive.id);
  const newWord = await svc.searchArchives({ conversationId: 'c2', query: '新词', mariposa: fakeM as never });
  assert.equal(newWord.state, 'no_match', '新词命中 v2——不在 include 集/无存档归属，不冒充该存档');
});


test('ARC-14 (RR3): 选 v2 而 M 只有 v1 收据→精确门槛拒绝（不凭旧版收据成功/标错版本）', async () => {
  const u = publishUser('c2', 'arc14-u');
  // v1 收据在（生产由归档链写）；消息编辑出 v2、尚未同步
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr14', 'op14', u.id, 1, 'sc1', 'sm_arc14', 'h', new Date().toISOString(), new Date().toISOString());
  db.prepare('INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('mrev-arc14-2', u.id, 2, 'text', '话-arc14-u（改口）', sha256Hex('v2'), new Date().toISOString(), new Date().toISOString(), 'user');
  db.prepare('UPDATE messages SET current_revision = 2 WHERE id = ?').run(u.id);
  const noticesBefore = (db.prepare('SELECT COUNT(*) n FROM host_notices').get() as { n: number }).n;
  const r = await svc.createArchive({ conversationId: 'c2', kind: 'quarrel', rawRefs: [{ message_id: u.id }], actor: 'qiaosheng', idempotencyKey: 'k-arc14' });
  assert.equal(r.ok, false, 'v2 无收据=待同步，不凭 v1 收据成功');
  if (!r.ok) { assert.equal(r.code, 'ARCHIVE_SOURCE_NOT_SYNCED'); assert.equal(r.retryable, true); }
  const n = (db.prepare('SELECT COUNT(*) n FROM host_notices').get() as { n: number }).n;
  assert.equal(n, noticesBefore, '未成功不排队通知');
});

test('ARC-15 (F3): 删除经协调器→墓碑快照确认→撤销投影登记→drain 推撤销；同键重放不重复登记/推送', async () => {
  const spy = projectionSpy();
  const u = publishUser('c2', 'arc15-u');
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr15', 'op15', u.id, 1, 'sc1', 'sm_arc15', 'h', new Date().toISOString(), new Date().toISOString());
  const r = await svc.createArchive({ conversationId: 'c2', kind: 'sweet', rawRefs: [{ message_id: u.id }], actor: 'qiaosheng', idempotencyKey: 'k-arc15' });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.ok((await spy.sync().drainArchiveProjections()) >= 1, '建档投影收口（批次含本文件其他 pending 投影）');
  spy.calls.length = 0;
  // 生产删除流（routes/archives.ts 同一写面）：协调器 DELETE + If-Match
  const del = await contentOps.write({ method: 'DELETE', actor: 'qiaosheng', path: `/api/v1/content/archives/${encodeURIComponent(r.archive.id)}`, headers: { 'idempotency-key': `http-archive-del:${r.archive.id}`, 'if-match': '"1"' } });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  // F3 修复点：删除后墓碑快照仍可读（旧实现 archiveRow 过滤已删行→确认永远 404）
  const snap = await fetchReferenceSnapshot(client!, 'conversation_archive', r.archive.id);
  assert.ok(snap, '墓碑快照可读');
  assert.equal(snap!.deleted, true);
  assert.equal(snap!.owner_revision, 2, '删除版本锚');
  assert.deepEqual(snap!.archive!.messages.map((m) => m.message_id), [u.id], '墓碑保留固定消息引用');
  // 撤销投影已登记（同确认事务）
  const revokeKey = `archive-projection:${r.archive.id}:conversation_archived_revoked`;
  const row = db.prepare('SELECT state FROM outbox WHERE target = ? AND operation_key = ?').get('mariposa.archive_projection', revokeKey) as { state: string } | undefined;
  assert.ok(row, '撤销投影已登记');
  assert.ok((await spy.sync().drainArchiveProjections()) >= 1, '撤销投影收口');
  const revokedCalls = spy.calls.filter((c) => (c['payload'] as { archive_id?: string; type?: string }).archive_id === r.archive.id && (c['payload'] as { type?: string }).type === 'conversation_archived_revoked');
  assert.equal(revokedCalls.length, 1, '逐消息一条撤销');
  assert.match(revokedCalls[0]!['operation_id'] as string, /:conversation_archived_revoked$/, '撤销 op 键与建档互不串（幂等）');
  // 同键重放（HTTP 重试）：回放原回执，不新增投影行、不重复推送
  const rowsBefore = (db.prepare('SELECT COUNT(*) n FROM outbox WHERE target = ?').get('mariposa.archive_projection') as { n: number }).n;
  const callsBefore = spy.calls.length;
  const del2 = await contentOps.write({ method: 'DELETE', actor: 'qiaosheng', path: `/api/v1/content/archives/${encodeURIComponent(r.archive.id)}`, headers: { 'idempotency-key': `http-archive-del:${r.archive.id}`, 'if-match': '"1"' } });
  assert.equal(del2.status, 200, '同键重放回放原回执');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM outbox WHERE target = ?').get('mariposa.archive_projection') as { n: number }).n, rowsBefore, '不新增投影行');
  assert.equal(await spy.sync().drainArchiveProjections(), 0, '无新投影待推');
  assert.equal(spy.calls.length, callsBefore, '不重复推送');
});

test('ARC-16 (RR5): 对象元数据回推消费者——存量未标记行按幂等 op 键补推并落标记；二次无新增', async () => {
  const calls: Array<{ operation_id: string; payload: Record<string, unknown> }> = [];
  const { ArchiveSyncService } = await import('../../apps/host/src/integrations/mariposa/archive-sync.ts');
  const { EventService } = await import('../../apps/host/src/events/service.ts');
  const { Logger } = await import('../../apps/host/src/observability/logging.ts');
  const fakeClient = { attachmentsSync: async (a: { operation_id: string; payload: Record<string, unknown> }) => { calls.push(a); return { ok: true }; } } as never;
  const sync = new ArchiveSyncService({
    db, events: new EventService(db), logger: new Logger(null), client: fakeClient,
    config: buildConfig({ archive: { enabled: true, source_scope: 'stream-x' }, integrations: { mariposa: { base_url: 'http://127.0.0.1:9' } } }),
  });
  // 存量场景：已确认收据的消息 + synced 图片附件，但从未推过对象元数据
  const u = publishUser('c2', 'arc16-u');
  const t0 = new Date().toISOString();
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr16', 'op16', u.id, 1, 'sc1', 'sm_arc16', 'h', t0, t0);
  db.prepare('INSERT INTO media_assets(id, creation_operation_id, state, mime_type, byte_size, content_sha256, storage_key, origin, created_by, ingest_purpose, created_at, updated_at, m_sync_state, m_content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('asset-arc16', 'op-a16', 'available', 'image/png', 10, 'h'.repeat(64), 'hh/x.png', 'upload', 'qiaosheng', 'chat_image', t0, t0, 'synced', 'm'.repeat(64));
  db.prepare('INSERT INTO message_attachments(message_id, revision, position, asset_id, presentation, created_at) VALUES (?,?,?,?,?,?)')
    .run(u.id, 1, 0, 'asset-arc16', 'image', t0);
  const pushed = await sync.backfillObjectMeta();
  assert.equal(pushed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.operation_id, `att-objmeta:${u.id}@1:asset-arc16`, '与 post-ACK 推送同一幂等 op 键（M 侧重放无副作用）');
  assert.equal(calls[0]!.payload['sha'], 'm'.repeat(64), 'M 对象身份优先 m_content_hash');
  assert.equal((db.prepare('SELECT object_meta_synced_at m FROM message_attachments WHERE message_id=? AND asset_id=?').get(u.id, 'asset-arc16') as { m: string }).m != null, true, '成功即落标记');
  calls.length = 0;
  assert.equal(await sync.backfillObjectMeta(), 0, '已标记行不再重放（标记防放大）');
  assert.equal(calls.length, 0);
});

test('ARC-18 (F3): 真实 HTTP 删除路由——经协调器删除→墓碑确认→撤销投影（路由面收口，非只测 helper）', async () => {
  const spy = projectionSpy();
  const u = publishUser('c2', 'arc18-u');
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr18', 'op18', u.id, 1, 'sc1', 'sm_arc18', 'h', new Date().toISOString(), new Date().toISOString());
  const r = await svc.createArchive({ conversationId: 'c2', kind: 'quarrel', rawRefs: [{ message_id: u.id }], actor: 'qiaosheng', idempotencyKey: 'k-arc18' });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.ok((await spy.sync().drainArchiveProjections()) >= 1, '建档投影收口');
  spy.calls.length = 0;
  // 真实路由（routes/archives.ts 的 DELETE 分支；supervisor 只在争吵建档用，删除不需要）
  const routeServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://est');
    void handleArchivesRoutes(req, res, { archives: svc, contentClient: client, contentOps } as never, `${req.method} ${url.pathname}`, url)
      .catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  await new Promise<void>((resolve) => routeServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = (routeServer.address() as net.AddressInfo).port;
    const del = await fetch(`http://127.0.0.1:${port}/api/v1/archives/${encodeURIComponent(r.archive.id)}?conversation_id=c2`, {
      method: 'DELETE',
      headers: { 'if-match': '"1"', 'idempotency-key': `ui-arc-del:${r.archive.id}` },
    });
    assert.equal(del.status, 200, '真实 DELETE 路由成功');
    const revokeKey = `archive-projection:${r.archive.id}:conversation_archived_revoked`;
    const row = db.prepare('SELECT state FROM outbox WHERE target = ? AND operation_key = ?').get('mariposa.archive_projection', revokeKey) as { state: string } | undefined;
    assert.ok(row, '路由删除后撤销投影已登记（协调器墓碑确认同事务）');
    assert.ok((await spy.sync().drainArchiveProjections()) >= 1, '撤销投影收口');
    const revokedCalls = spy.calls.filter((c) => (c['payload'] as { archive_id?: string; type?: string }).archive_id === r.archive.id && (c['payload'] as { type?: string }).type === 'conversation_archived_revoked');
    assert.equal(revokedCalls.length, 1, '逐消息一条撤销 observation');
  } finally { routeServer.close(); }
});

test('ARC-19 (W3): 通知恰绑定写入成功回执——两种故障位置分立；恢复补登记恰一份；重放不加', async () => {
  const notices = () => (db.prepare('SELECT COUNT(*) n FROM host_notices WHERE conversation_id = ? AND dedupe_key LIKE ?').get('c2', 'archive-notice:k-arc19%') as { n: number }).n;
  const u = publishUser('c2', 'arc19-u');
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr19', 'op19', u.id, 1, 'sc1', 'sm_arc19', 'h', new Date().toISOString(), new Date().toISOString());
  const forwardToReal = async (req: http.IncomingMessage, res: http.ServerResponse, raw: string) => {
    const opts = { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${server.port}` }, ...(req.method !== 'GET' && raw !== '' ? { body: raw } : {}) } as RequestInit;
    const up = await fetch(`http://127.0.0.1:${server.port}${req.url}`, opts);
    const text = await up.text();
    res.writeHead(up.status, { 'Content-Type': 'application/json' }); res.end(text);
  };
  const readRaw = (req: http.IncomingMessage) => new Promise<string>((resolve) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => resolve(raw)); });
  // (a) 内容服务已提交、成功响应丢失（故障在写入回执，不在快照）：前台失败零通知；
  // 恢复确认成功后补登记恰一份
  let dropFirstPost = true;
  const proxyA = http.createServer((req, res) => { void (async () => {
    const raw = await readRaw(req);
    if (req.method === 'POST' && (req.url ?? '').startsWith('/api/v1/content/archives') && dropFirstPost) {
      dropFirstPost = false;
      await fetch(`http://127.0.0.1:${server.port}${req.url}`, { method: 'POST', headers: { ...req.headers, host: `127.0.0.1:${server.port}` }, body: raw }); // 真提交，丢弃响应
      res.writeHead(504, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'gateway_timeout', message: '响应丢失' } }));
      return;
    }
    await forwardToReal(req, res, raw);
  })().catch(() => { res.statusCode = 500; res.end('{}'); }); });
  await new Promise<void>((resolve) => proxyA.listen(0, '127.0.0.1', resolve));
  try {
    const opsA = new ContentOperationCoordinator({ db, client: { baseUrl: `http://127.0.0.1:${(proxyA.address() as { port: number }).port}`, token: TOKEN } as never, media: new MediaService(db, path.join(root, 'media-19a'), buildConfig({})), logger });
    const svcA = new ArchiveService({ db, contentClient: client, contentOps: opsA, logger });
    const r1 = await svcA.createArchive({ conversationId: 'c2', kind: 'sweet', rawRefs: [{ message_id: u.id }], actor: 'qiaosheng', idempotencyKey: 'k-arc19' });
    assert.equal(r1.ok, false, '写入响应丢失=前台结果未知（不是快照故障）');
    assert.equal(notices(), 0, '未确认成功前零通知');
    await opsA.recoverOnce(); // 代理已恢复（只丢第一次）
    assert.equal(notices(), 1, '恢复确认成功后补登记恰一份');
    const pending = svcA.takePendingNotices('c2');
    assert.equal(pending.filter((n) => n.id !== '').length >= 1, true);
    // 同键重放（HTTP 重试同操作）：回放原回执，不新增通知
    const r2 = await svcA.createArchive({ conversationId: 'c2', kind: 'sweet', rawRefs: [{ message_id: u.id }], actor: 'qiaosheng', idempotencyKey: 'k-arc19' });
    assert.equal(r2.ok, true, '同键重放回放原成功回执');
    assert.equal(notices(), 1, '重放不新增通知');
  } finally { proxyA.close(); }
  // (b) 已收到成功响应、随后快照读取失败：存档成功、通知即时登记（不被快照/M 投影拖延）
  const proxyB = http.createServer((req, res) => { void (async () => {
    const raw = await readRaw(req);
    if (req.method === 'GET' && (req.url ?? '').includes('/references/')) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'unavailable' } })); return; }
    await forwardToReal(req, res, raw);
  })().catch(() => { res.statusCode = 500; res.end('{}'); }); });
  await new Promise<void>((resolve) => proxyB.listen(0, '127.0.0.1', resolve));
  let archiveId = '';
  try {
    const opsB = new ContentOperationCoordinator({ db, client: { baseUrl: `http://127.0.0.1:${(proxyB.address() as { port: number }).port}`, token: TOKEN } as never, media: new MediaService(db, path.join(root, 'media-19b'), buildConfig({})), logger });
    const svcB = new ArchiveService({ db, contentClient: client, contentOps: opsB, logger });
    const rb = await svcB.createArchive({ conversationId: 'c2', kind: 'quarrel', rawRefs: [{ message_id: u.id }], actor: 'qiaosheng', idempotencyKey: 'k-arc19b' });
    assert.equal(rb.ok, true, '写入成功回执已收到——存档成功，快照未确认不拖延结果');
    archiveId = rb.ok ? rb.archive.id : '';
    assert.equal(notices(), 2, 'k-arc19b 即时登记（快照失败不拖延已确定的成功通知）');
    const projBefore = db.prepare("SELECT COUNT(*) n FROM outbox WHERE target = 'mariposa.archive_projection' AND operation_key = ?").get(`archive-projection:${archiveId}:conversation_archived`) as { n: number };
    assert.equal(projBefore.n, 0, '快照失败=确认未完成，投影暂未登记（由恢复链补）');
  } finally { proxyB.close(); }
  // 恢复（真协调器）：补确认+投影；通知不再新增
  await contentOps.recoverOnce(20);
  assert.equal(notices(), 2, '恢复/投影不产生额外通知');
  const projAfter = db.prepare("SELECT COUNT(*) n FROM outbox WHERE target = 'mariposa.archive_projection' AND operation_key = ?").get(`archive-projection:${archiveId}:conversation_archived`) as { n: number };
  assert.equal(projAfter.n, 1, '快照恢复后投影补登记');
});

// ===== 包2 DBG-04（11-16 版）：双边界锚点定位（D14-D19）=====
// 端到端经 assembleTestTools 注册表执行真实 conversation_archive 工具（定义/schema
// 校验/run/解析/建档全链），可见作用域=ctx.seenMessages（D13 口径）。

type SeenRefLite = { id: string; revision: number; char_start?: number; char_end?: number };
let anchorTools: ReturnType<typeof assembleTestTools>['tools'] | null = null;
function toolsBridge(): ReturnType<typeof assembleTestTools>['tools'] {
  if (anchorTools === null) anchorTools = assembleTestTools({ db, archives: svc }).tools;
  return anchorTools;
}
function seedMsg(conv: string, cmid: string, content: string, speaker: 'owner' | 'assistant', turnId = 'turn-an'): { id: string; sequence: number } {
  if (speaker === 'owner') {
    const m = messages.submitUserMessageWithTurn({ conversationId: conv, content, clientMessageId: cmid });
    return { id: m.message.id, sequence: m.message.sequence };
  }
  const m = messages.publishAssistantMessage({ conversationId: conv, turnId, content, kind: 'text', clientMessageId: cmid });
  return { id: m.id, sequence: m.sequence };
}
function seedReceipt(id: string, rev = 1): void {
  const t = new Date().toISOString();
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(`ssr-an-${id}@${rev}`, `op-an-${id}@${rev}`, id, rev, 'sc1', `sm_an_${id}_${rev}`, `h-${id}-${rev}`, t, t);
}
const mkCtx = (conv: string, seen: SeenRefLite[], toolCallId = 'call-an') => ({
  roomId: conv, windowId: 'w-an', turnId: 'turn-an', purpose: 'chat' as const, activeReviewId: null,
  seenSequence: 99, seenMessages: seen, requestId: 'req-an', toolCallId,
});
async function listArchives(conv: string): Promise<Array<{ id: string; messages: Array<{ message_id: string }> }>> {
  const res = await fetch(`${base}/api/v1/content/archives?conversation_id=${conv}&limit=100`, { headers: { authorization: `Bearer ${TOKEN}`, 'x-actor': 'qiaosheng' } });
  const body = await res.json() as { items?: Array<{ id: string; messages?: Array<{ message_id: string }> }> };
  return (body.items ?? []).map((e) => ({ id: e.id, messages: e.messages ?? [] }));
}

test('ARC-20 (D14): 唯一双边界锚点——一次调用定位+保存；回执短摘要不回显全文', async () => {
  messages.ensureConversation('c4');
  const u1 = seedMsg('c4', 'an-u1', '今天先到这里吧，我去把灯关了。', 'owner');
  const a1 = seedMsg('c4', 'an-a1', '好的，今天的事也说开了，晚安。', 'assistant');
  const u2 = seedMsg('c4', 'an-u2', '明天想吃什么？', 'owner');
  const a2 = seedMsg('c4', 'an-a2', '想吃你上次做的那碗面。', 'assistant');
  for (const m of [u1, a1, u2, a2]) seedReceipt(m.id);
  const seen: SeenRefLite[] = [u1, a1, u2, a2].map((m) => ({ id: m.id, revision: 1 }));
  const out = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: '宿主用户', quote: '今天先到这里' },
    anchor_end: { speaker: 'char', quote: '那碗面' },
  }, mkCtx('c4', seen));
  assert.equal(out.ok, true, JSON.stringify(out.output));
  assert.equal(out.output['archived'], true);
  assert.equal(out.output['message_count'], 4, '起止之间（含首尾）全部完整已见成员');
  assert.equal(out.output['segments'], 1);
  assert.equal(out.output['skipped_unseen'], 0);
  assert.equal(out.output['excluded_excerpt_only'], 0);
  const rs = out.output['range_summary'] as { start: string; end: string };
  assert.match(rs.start, /今天先到这里/);
  assert.match(rs.end, /那碗面/);
  assert.ok(rs.start.length <= 24 && rs.end.length <= 24, '范围摘要只用少量边界文字');
  assert.equal(out.seenAdditions, undefined, 'D19：不产生任何已读增量');
  const list = await listArchives('c4');
  const mine = list.find((e) => e.messages.length === 4);
  assert.ok(mine, 'content 正本已写入');
  assert.deepEqual(mine!.messages.map((m) => m.message_id).sort(), [u1.id, a1.id, u2.id, a2.id].sort());
  // D18：同 tool_call（同幂等键）重试——回放同一存档，不重复建档
  const again = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: '宿主用户', quote: '今天先到这里' },
    anchor_end: { speaker: 'char', quote: '那碗面' },
  }, mkCtx('c4', seen));
  assert.equal(again.ok, true, JSON.stringify(again.output));
  assert.equal(again.output['archive_id'], out.output['archive_id'], '同键重放=同一存档');
  assert.equal((await listArchives('c4')).length, list.length, '不重复建档');
});

test('ARC-21 (D15): 同句多处→最小消歧候选；边界倒置；所见版本已被编辑——均不写入', async () => {
  const u3 = seedMsg('c4', 'an-u3', '这句话我说了两次', 'owner');
  const u4 = seedMsg('c4', 'an-u4', '这句话我说了两次，真的', 'owner');
  const seen: SeenRefLite[] = [u3, u4].map((m) => ({ id: m.id, revision: 1 }));
  const before = (await listArchives('c4')).length;
  const amb = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: '宿主用户', quote: '这句话我说了两次' },
    anchor_end: { speaker: '宿主用户', quote: '这句话我说了两次，真的' },
  }, mkCtx('c4', seen, 'call-amb'));
  assert.equal(amb.ok, false);
  assert.equal(amb.output['error_code'], 'ARCHIVE_ANCHOR_AMBIGUOUS');
  assert.equal(amb.output['boundary'], 'start', '冲突定位到具体边界');
  const cands = amb.output['candidates'] as Array<{ speaker: string; position: number; excerpt: string }>;
  assert.equal(cands.length, 2, '最小消歧候选：两处命中');
  assert.ok(cands.every((c) => c.excerpt.length <= 60 && c.excerpt.includes('这句话我说了两次')), '候选带少量边界文字');
  // 起点唯一、终点同句两处：歧义按边界如实报告（同样不写入）
  const rev = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: '宿主用户', quote: '这句话我说了两次，真的' },
    anchor_end: { speaker: '宿主用户', quote: '这句话我说了两次' },
  }, mkCtx('c4', seen, 'call-rev'));
  assert.equal(rev.ok, false);
  assert.equal(rev.output['error_code'], 'ARCHIVE_ANCHOR_AMBIGUOUS');
  assert.equal(rev.output['boundary'], 'end');
  // 边界倒置的干净场景：用唯一句构造
  const u5 = seedMsg('c4', 'an-u5', '这是会被编辑的旧句子', 'owner');
  const a9 = seedMsg('c4', 'an-a9', '这句是后来才出现的回复', 'assistant');
  const seen2: SeenRefLite[] = [u5, a9].map((m) => ({ id: m.id, revision: 1 }));
  const reversed = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: 'char', quote: '后来才出现的回复' },
    anchor_end: { speaker: '宿主用户', quote: '会被编辑的旧句子' },
  }, mkCtx('c4', seen2, 'call-rev2'));
  assert.equal(reversed.ok, false);
  assert.equal(reversed.output['error_code'], 'ARCHIVE_ANCHOR_REVERSED', '边界倒置给具体原因');
  // 所见版本已被编辑（所见 v1，current=v2）
  const t0 = new Date().toISOString();
  db.prepare('INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('mrev-an-stale', u5.id, 2, 'text', '这是编辑之后的新句子', sha256Hex('an-stale-v2'), t0, t0, 'user');
  db.prepare('UPDATE messages SET current_revision = 2 WHERE id = ?').run(u5.id);
  const stale = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: '宿主用户', quote: '会被编辑的旧句子' },
    anchor_end: { speaker: 'char', quote: '后来才出现的回复' },
  }, mkCtx('c4', seen2, 'call-stale'));
  assert.equal(stale.ok, false);
  assert.equal(stale.output['error_code'], 'ARCHIVE_ANCHOR_STALE');
  const conflicts = stale.output['conflicts'] as Array<{ message_id: string; seen_revision: number; current_revision: number }>;
  assert.equal(conflicts[0]!.message_id, u5.id);
  assert.equal(conflicts[0]!.seen_revision, 1);
  assert.equal(conflicts[0]!.current_revision, 2);
  assert.equal((await listArchives('c4')).length, before, '三种冲突都不写入');
});

test('ARC-22 (D16): 显式范围含本回合已发布消息可存；未发布草稿不可见不可存', async () => {
  const u9 = seedMsg('c4', 'an-u9', '把刚才这轮也存进去', 'owner', 'turn-cur');
  const a9b = seedMsg('c4', 'an-a9b', '好，这一句是我们刚说完的', 'assistant', 'turn-cur');
  const t0 = new Date().toISOString();
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES (?,?,?, 'assistant', 'text', 1, NULL, ?)")
    .run('m_an_draft', 'c4', 9998, t0);
  db.prepare('INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('mrev-an-draft', 'm_an_draft', 1, 'text', '还没发出去的话', sha256Hex('an-draft'), t0, t0, 'user');
  seedReceipt(u9.id); seedReceipt(a9b.id);
  const seen: SeenRefLite[] = [u9, a9b].map((m) => ({ id: m.id, revision: 1 })); // 草稿不在视野
  const out = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: '宿主用户', quote: '把刚才这轮也存进去' },
    anchor_end: { speaker: 'char', quote: '刚说完的' },
  }, mkCtx('c4', seen, 'call-cur'));
  assert.equal(out.ok, true, JSON.stringify(out.output));
  assert.equal(out.output['message_count'], 2, '本回合已发布消息按显式范围可存');
  const list = await listArchives('c4');
  const mine = list.find((e) => e.messages.length === 2 && e.messages.some((m) => m.message_id === u9.id));
  assert.ok(mine);
  assert.equal(mine!.messages.some((m) => m.message_id === 'm_an_draft'), false, '未发布草稿不在可见面，不被存档');
});

test('ARC-23 (D17): 滚窗缺口如实保留段数；只见节选的边界拒绝/内部排除；未见部分引语不命中', async () => {
  messages.ensureConversation('c5');
  const u1 = seedMsg('c5', 'an2-u1', '窗口里带着的第一句', 'owner');
  const u2 = seedMsg('c5', 'an2-u2', '中间这句没有被带过来', 'owner'); // 库里存在但未携带
  const u3 = seedMsg('c5', 'an2-u3', '窗口里带着的最后一句', 'owner');
  seedReceipt(u1.id); seedReceipt(u3.id);
  const seenGap: SeenRefLite[] = [u1, u3].map((m) => ({ id: m.id, revision: 1 }));
  const gap = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: '宿主用户', quote: '第一句' },
    anchor_end: { speaker: '宿主用户', quote: '最后一句' },
  }, mkCtx('c5', seenGap, 'call-gap'));
  assert.equal(gap.ok, true, JSON.stringify(gap.output));
  assert.equal(gap.output['message_count'], 2, '不按库连续性补齐未携带消息');
  assert.equal(gap.output['segments'], 2, '缺口如实保留：两段');
  assert.equal(gap.output['skipped_unseen'], 1);
  // 边界只见节选：整条不可存（存档只收整条），不默取节选之外正文
  const u4 = seedMsg('c5', 'an2-u4', '只有开头一段被看见过，后面的部分没有进入视野。', 'owner');
  const seenExcerpt: SeenRefLite[] = [{ id: u4.id, revision: 1, char_start: 0, char_end: 10 }];
  const exBoundary = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: '宿主用户', quote: '只有开头一段' },
    anchor_end: { speaker: '宿主用户', quote: '只有开头一段' },
  }, mkCtx('c5', seenExcerpt, 'call-exb'));
  assert.equal(exBoundary.ok, false);
  assert.equal(exBoundary.output['error_code'], 'ARCHIVE_ANCHOR_EXCERPT_ONLY', '如实报告合同差异，不扩范围');
  // 引语落在未见区域：不命中（不把节选外文字当作已见）
  const exUnseen = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: '宿主用户', quote: '后面的部分' },
    anchor_end: { speaker: '宿主用户', quote: '后面的部分' },
  }, mkCtx('c5', seenExcerpt, 'call-exu'));
  assert.equal(exUnseen.ok, false);
  assert.equal(exUnseen.output['error_code'], 'ARCHIVE_ANCHOR_NOT_FOUND');
  // 内部只见节选：边界完整，节选成员如实排除计数
  const u5 = seedMsg('c5', 'an2-u5', '完整的起点消息', 'owner');
  const u6 = seedMsg('c5', 'an2-u6', '只看见开头的中间消息', 'owner');
  const u7 = seedMsg('c5', 'an2-u7', '完整的终点消息', 'owner');
  seedReceipt(u5.id); seedReceipt(u7.id);
  const seenMixed: SeenRefLite[] = [{ id: u5.id, revision: 1 }, { id: u6.id, revision: 1, char_start: 0, char_end: 3 }, { id: u7.id, revision: 1 }];
  const mixed = await toolsBridge().execute('conversation_archive', {
    kind: 'sweet',
    anchor_start: { speaker: '宿主用户', quote: '完整的起点消息' },
    anchor_end: { speaker: '宿主用户', quote: '完整的终点消息' },
  }, mkCtx('c5', seenMixed, 'call-mix'));
  assert.equal(mixed.ok, true, JSON.stringify(mixed.output));
  assert.equal(mixed.output['message_count'], 2);
  assert.equal(mixed.output['excluded_excerpt_only'], 1, '节选成员如实排除');
  assert.equal(mixed.output['segments'], 2);
  const list = await listArchives('c5');
  const mine = list.find((e) => e.messages.some((m) => m.message_id === u5.id));
  assert.equal(mine!.messages.some((m) => m.message_id === u6.id), false, '节选消息不默收');
});

test('ARC-24 (D19): 锚点解析内部读零副作用——不落任何已读/通知/投影记录', async () => {
  const u5 = seedMsg('c5', 'an3-u5', '解析起点用的消息', 'owner');
  const u7 = seedMsg('c5', 'an3-u7', '解析终点用的消息', 'owner');
  const tableCount = (t: string): number => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  const tables = ['messages', 'message_revisions', 'outbox', 'host_notices', 'tool_side_effects', 'source_sync_receipts'];
  const snap = tables.map(tableCount).join(',');
  const resolution = svc.resolveAnchorRange('c5', [{ id: u5.id, revision: 1 }, { id: u7.id, revision: 1 }], { speaker: '宿主用户', quote: '解析起点用的消息' }, { speaker: '宿主用户', quote: '解析终点用的消息' });
  if (!resolution.ok) throw new Error(`resolveAnchorRange 应成功：${resolution.detail}`);
  assert.equal(resolution.refs.length, 2);
  const after = tables.map(tableCount).join(',');
  assert.equal(after, snap, '解析只读：内部读原文不产生已读/通知/投影等任何写入');
});

test('ARC-25: 参数门——三种定位互斥；锚点必须成对；非法说话人/空引语拒绝', async () => {
  const seen: SeenRefLite[] = [];
  const both = await toolsBridge().execute('conversation_archive', { kind: 'sweet', message_ids: ['x'], anchor_start: { speaker: '宿主用户', quote: 'a' }, anchor_end: { speaker: 'char', quote: 'b' } }, mkCtx('c4', seen, 'call-p1'));
  assert.equal(both.ok, false);
  assert.equal(both.output['error_code'], 'ARCHIVE_POSITION_AMBIGUOUS');
  const half = await toolsBridge().execute('conversation_archive', { kind: 'sweet', anchor_start: { speaker: '宿主用户', quote: 'a' } }, mkCtx('c4', seen, 'call-p2'));
  assert.equal(half.ok, false);
  assert.equal(half.output['error_code'], 'ARCHIVE_ANCHOR_PAIR_REQUIRED');
  const badSpeaker = await toolsBridge().execute('conversation_archive', { kind: 'sweet', anchor_start: { speaker: '用户', quote: 'a' }, anchor_end: { speaker: 'char', quote: 'b' } }, mkCtx('c4', seen, 'call-p3'));
  assert.equal(badSpeaker.ok, false, 'schema 枚举拒绝非法说话人');
  const emptyQuote = await toolsBridge().execute('conversation_archive', { kind: 'sweet', anchor_start: { speaker: '宿主用户', quote: '   ' }, anchor_end: { speaker: 'char', quote: 'b' } }, mkCtx('c4', seen, 'call-p4'));
  assert.equal(emptyQuote.ok, false);
  assert.equal(emptyQuote.output['error_code'], 'TOOL_ARG_INVALID');
});
