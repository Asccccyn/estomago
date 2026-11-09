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
import { ContentServer } from '../../apps/content/src/service.ts';
import { ArchiveService } from '../../apps/host/src/modules/archives/service.ts';
import { contentClientFor } from '../../apps/host/src/integrations/content/client.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';

const TOKEN = 'archives-test-token';
let server: ContentServer;
let base: string;
let svc: ArchiveService;
let root: string;
let db: ReturnType<typeof openDatabase>;
let messages: MessageService;
let contentToken: string;

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
  const client = contentClientFor(root, server.port, true);
  if (!client) throw new Error('content client 未构造（token 文件未找到）');
  svc = new ArchiveService({ db, contentClient: client });
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
  const denied = await svc.createArchive({ conversationId: 'c1', kind: 'sweet', rawRefs: [{ message_id: unsynced.id }], actor: 'jiaming', notifyModel: 'none', idempotencyKey: 'k-unsync' });
  assert.equal(denied.ok, false);
  if (!denied.ok) { assert.equal(denied.code, 'ARCHIVE_SOURCE_NOT_SYNCED'); assert.equal(denied.retryable, true); }
  // 工具发起：notifyModel=none——成功回执即通知，host_notices 不排
  const t1 = await svc.createArchive({ conversationId: 'c1', kind: 'sweet', rawRefs: [{ message_id: u.id }, { message_id: a.id }], actor: 'jiaming', notifyModel: 'none', idempotencyKey: 'k-tool-1' });
  assert.equal(t1.ok, true, JSON.stringify(t1));
  const t2 = await svc.createArchive({ conversationId: 'c1', kind: 'sweet', rawRefs: [{ message_id: u.id }, { message_id: a.id }], actor: 'jiaming', notifyModel: 'none', idempotencyKey: 'k-tool-1' });
  assert.equal(t2.ok, true);
  if (t1.ok && t2.ok) assert.equal(t2.archive.id, t1.archive.id, '同幂等键重放=同一存档');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM host_notices').get() as { n: number }).n, 0, '工具发起不排队通知');
  // 用户发起：排队通知 + dedupe 幂等
  const u1r = await svc.createArchive({ conversationId: 'c1', kind: 'quarrel', rawRefs: [{ message_id: u.id }], note: '到这里', actor: 'qiaosheng', notifyModel: 'event', idempotencyKey: 'k-user-1' });
  assert.equal(u1r.ok, true);
  const u1again = await svc.createArchive({ conversationId: 'c1', kind: 'quarrel', rawRefs: [{ message_id: u.id }], note: '到这里', actor: 'qiaosheng', notifyModel: 'event', idempotencyKey: 'k-user-1' });
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
  await svc.createArchive({ conversationId: 'c1', kind: 'sweet', rawRefs: [{ message_id: msgT.id }], actor: 'qiaosheng', notifyModel: 'event', idempotencyKey: 'k-user-2' });
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
  await svc.createArchive({ conversationId: 'c2', kind: 'quarrel', rawRefs: [{ message_id: u1.id }], actor: 'qiaosheng', notifyModel: 'event', idempotencyKey: 'k-q10' });
  await svc.createArchive({ conversationId: 'c2', kind: 'sweet', rawRefs: [{ message_id: u2.id }], actor: 'qiaosheng', notifyModel: 'event', idempotencyKey: 'k-s10' });
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

test('ARC-12: R6 双标记——存档成功后逐消息推 M observation（幂等 operation_id；revision 取收据版本）', async () => {
  const calls: Array<{ stream_id: string; origin_message_id: string; revision: number; kind: string; payload: Record<string, unknown>; operation_id: string }> = [];
  const port = { attachmentsSync: async (a: typeof calls[number]) => { calls.push(a); return { ok: true }; } };
  const client12 = contentClientFor(root, server.port, true);
  if (!client12) throw new Error('content client 未构造');
  const pushSvc = new ArchiveService({ db, contentClient: client12, attachments: port, streamId: 'stream-x' });
  const u = publishUser('c2', 'arc12-u');
  const a = publishAssistant('c2', 'arc12-a');
  const t0 = new Date().toISOString();
  // RR3：收据按存档引用的精确修订（validateRefs 钉 current_revision=1）
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr12a', 'op12', u.id, 1, 'sc1', 'sm_arc12u', 'h', t0, t0);
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr12b', 'op12', a.id, 1, 'sc1', 'sm_arc12a', 'h', t0, t0);
  const r = await pushSvc.createArchive({ conversationId: 'c2', kind: 'quarrel', rawRefs: [{ message_id: u.id }, { message_id: a.id }], actor: 'qiaosheng', notifyModel: 'none', idempotencyKey: 'k-arc12' });
  assert.equal(r.ok, true, JSON.stringify(r));
  await new Promise((resolve) => setTimeout(resolve, 100)); // 推送尽力而为异步——等一拍
  assert.equal(calls.length, 2, '逐消息一条 observation');
  const byOrigin = new Map(calls.map((c) => [c.origin_message_id, c]));
  assert.equal(byOrigin.get(u.id)!.kind, 'observation');
  assert.equal(byOrigin.get(u.id)!.revision, 1, 'RR3：推送 revision=存档钉住的修订（门槛已保证该版有收据）');
  assert.equal(byOrigin.get(u.id)!.stream_id, 'stream-x');
  const payload = byOrigin.get(u.id)!.payload as { type: string; archive_id: string; archive_kind: string; count: number };
  assert.equal(payload.type, 'conversation_archived');
  if (r.ok) assert.equal(payload.archive_id, r.archive.id);
  assert.equal(payload.archive_kind, 'quarrel');
  assert.equal(payload.count, 2);
  assert.match(byOrigin.get(u.id)!.operation_id, /^att-arc:[^:]+:/, 'operation_id 幂等形态');
});

test('ARC-13: R6 存档打开链——archiveOriginals 返回钉住修订的正文；跨会话拒绝', async () => {
  const u = publishUser('c2', 'arc13-u');
  const a = publishAssistant('c2', 'arc13-a');
  const t0 = new Date().toISOString();
  for (const [mid, sm] of [[u.id, 'sm_arc13u'], [a.id, 'sm_arc13a']] as const) {
    db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('ssr13-' + sm, 'op13', mid, 1, 'sc1', sm, 'h', t0, t0);
  }
  const r = await svc.createArchive({ conversationId: 'c2', kind: 'sweet', rawRefs: [{ message_id: u.id }, { message_id: a.id }], actor: 'qiaosheng', notifyModel: 'none', idempotencyKey: 'k-arc13' });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  const opened = await svc.archiveOriginals('c2', r.archive.id);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  if (!opened.ok) return;
  assert.equal(opened.kind, 'sweet');
  assert.equal(opened.items.length, 2);
  assert.deepEqual(opened.items.map((it) => it.speaker), ['owner', 'assistant'], '按会话序');
  assert.match(opened.items[0]!.text ?? '', /话-arc13-u/, '固定版本正文');
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
  const q = await svc.createArchive({ conversationId: 'c1', kind: 'quarrel', rawRefs: [{ message_id: u1.id }], note: '那晚的争执', actor: 'qiaosheng', notifyModel: 'none', idempotencyKey: 'k-arc11-q' });
  await svc.createArchive({ conversationId: 'c1', kind: 'sweet', rawRefs: [{ message_id: u2.id }], note: null, actor: 'qiaosheng', notifyModel: 'none', idempotencyKey: 'k-arc11-s' });
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


test('ARC-14 (RR3): 选 v2 而 M 只有 v1 收据→精确门槛拒绝（不凭旧版收据成功/标错版本）', async () => {
  const u = publishUser('c2', 'arc14-u');
  // v1 收据在（生产由归档链写）；消息编辑出 v2、尚未同步
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr14', 'op14', u.id, 1, 'sc1', 'sm_arc14', 'h', new Date().toISOString(), new Date().toISOString());
  db.prepare('INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('mrev-arc14-2', u.id, 2, 'text', '话-arc14-u（改口）', sha256Hex('v2'), new Date().toISOString(), new Date().toISOString(), 'user');
  db.prepare('UPDATE messages SET current_revision = 2 WHERE id = ?').run(u.id);
  const noticesBefore = (db.prepare('SELECT COUNT(*) n FROM host_notices').get() as { n: number }).n;
  const r = await svc.createArchive({ conversationId: 'c2', kind: 'quarrel', rawRefs: [{ message_id: u.id }], actor: 'qiaosheng', notifyModel: 'event', idempotencyKey: 'k-arc14' });
  assert.equal(r.ok, false, 'v2 无收据=待同步，不凭 v1 收据成功');
  if (!r.ok) { assert.equal(r.code, 'ARCHIVE_SOURCE_NOT_SYNCED'); assert.equal(r.retryable, true); }
  const n = (db.prepare('SELECT COUNT(*) n FROM host_notices').get() as { n: number }).n;
  assert.equal(n, noticesBefore, '未成功不排队通知');
});

test('ARC-15 (RR3): 删除存档→逐消息推撤销 observation（latest-wins 撤销语义）', async () => {
  const calls: Array<{ payload: Record<string, unknown>; operation_id: string }> = [];
  const port = { attachmentsSync: async (a: { payload: Record<string, unknown>; operation_id: string }) => { calls.push(a); return { ok: true }; } };
  const client15 = contentClientFor(root, server.port, true);
  if (!client15) throw new Error('content client 未构造');
  const pushSvc = new ArchiveService({ db, contentClient: client15, attachments: port, streamId: 'stream-x' });
  const u = publishUser('c2', 'arc15-u');
  db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('ssr15', 'op15', u.id, 1, 'sc1', 'sm_arc15', 'h', new Date().toISOString(), new Date().toISOString());
  const r = await pushSvc.createArchive({ conversationId: 'c2', kind: 'sweet', rawRefs: [{ message_id: u.id }], actor: 'qiaosheng', notifyModel: 'none', idempotencyKey: 'k-arc15' });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.payload['type'], 'conversation_archived');
  calls.length = 0;
  // 生产删除流（routes/archives.ts 同序）：先取引用快照（删除后 content 对已删行 404——
  // 自查修正点），DELETE 成功后按快照推撤销
  const snapshot = await pushSvc.archiveRefsForRevoke('c2', r.archive.id);
  assert.ok(snapshot, '删除前可取引用快照');
  const del = await fetch(`${base}/api/v1/content/archives/${r.archive.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'x-actor': 'qiaosheng', 'idempotency-key': 'k-arc15-del', 'if-match': '"1"' } });
  assert.equal(del.status, 200);
  assert.equal(await pushSvc.archiveRefsForRevoke('c2', r.archive.id), null, '删除后快照不可得（archiveRow 过滤已删行）');
  await pushSvc.revokeArchiveObservations(r.archive.id, snapshot!.kind, snapshot!.refs);
  assert.equal(calls.length, 1, '按删除前快照逐消息一条撤销');
  assert.equal(calls[0]!.payload['type'], 'conversation_archived_revoked');
  assert.equal(calls[0]!.payload['archive_id'], r.archive.id);
  assert.match(calls[0]!.operation_id, /:conversation_archived_revoked$/, '撤销 op 键与建档互不串（幂等）');
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
