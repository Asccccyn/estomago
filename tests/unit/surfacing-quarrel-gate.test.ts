// RR4 复审（2026-11-11 ALBUM_RR4_REAUDIT）三处补修的验收：
// F1 封存清单不可核对→prepare 阶段暂缓（不发没有完整排除依据的候选包）；
//    两阶段时序：准备时失败→终检前恢复——第一次零 prepare 调用+作业 blocked，
//    第二条消息（新作业）正常 prepare 且排除集完整下推。
// 已同步但未送达的历史不能冒充覆盖；触发原话仍作为自证排除传给 M。
// F4 集合检索取消贯穿分页：第一页响应时取消→不再请求第二页、不进入编码/搜索。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { tempRoot, fakeSolJudge } from '../helpers.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { bindMessageLifecycle as bindForTest } from '../../apps/host/src/application/message-lifecycle.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { ContentServer } from '../../apps/content/src/service.ts';
import { contentForward } from '../../apps/host/src/integrations/content/client.ts';
import { MediaToolsService } from '../../apps/host/src/modules/media/service.ts';

const T0 = '2026-10-19T09:00:00+08:00';

function makeDb(root: string) {
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  return db;
}

type QuarrelPort = (conversationId: string) => Promise<{ refs: Set<string>; reachable: boolean; complete: boolean }>;

function makeService(root: string, sol: Parameters<typeof fakeSolJudge>[0], quarrel: QuarrelPort | null) {
  const db = makeDb(root);
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  const transport: MariposaTransport = async (cap, payload) => {
    calls.push({ cap, payload: payload as Record<string, unknown> });
    if (cap === 'memory.surfacing.prepare') return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_1', selected_count: 1, reason_code: null, policy_revision: 7, prompt_revision: 'surface_prepare_v5' } };
    if (cap === 'memory.surfacing.validate') return { ok: true, result: { status: 'ready', validation_receipt: 'svr_1', items: [{ event_id: 'ev_1', memory_id: '00001', memory_version: '1', memory_date: '2026-07-09', date_confidence: 'exact', event_text: '7月9日我们把记忆库建成了', body_hash: 'b'.repeat(64), detail_ref: 'sdr_abc' }], reason_code: null } };
    if (cap === 'memory.surfacing.check') return { ok: true, result: { valid: true, accepted_detail_refs: ['sdr_abc'] } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const svc = new SurfacingService(db, new MariposaClient({ transport }), fakeSolJudge(sol).judge, {
    enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v1',
    delivery_deadline_ms: 2000, max_added_tokens_per_turn: 4096,
    max_packet_bytes: 24576, worker_concurrency: 2, recent_user_messages: 3, recent_window_bytes: 24576,
  }, null, null, quarrel);
  const messages = new MessageService(db, bindForTest({ surfacing: svc, activity: null }));
  messages.ensureConversation('c1');
  return { db, svc, messages, calls };
}

test('F1：封存清单不可核对→prepare 暂缓（零 M 检索）；恢复后新作业完整下推排除集', async () => {
  let phase = 0;
  const quarrel: QuarrelPort = async () => {
    if (phase === 0) return { refs: new Set(['sm_q1', 'sm_q2']), reachable: false, complete: false };
    return { refs: new Set(['sm_q1', 'sm_q2']), reachable: true, complete: true };
  };
  const { db, svc, messages, calls } = makeService(tempRoot('sfqgate-'), [{ decision: 'recall' }, { decision: 'recall' }], quarrel);
  try {
    const u1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '还记得那次争吵吗', clientMessageId: 'qg1', occurredAt: T0 });
    const aug1 = await svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: u1.turnId, attemptId: 'a1', message: { id: u1.message.id, revision: 1, sequence: u1.message.sequence, content: '还记得那次争吵吗', hash: 'h1' } });
    assert.equal(aug1, null, '清单不可核对=本轮无注入（不是一包缺排除依据的候选）');
    assert.equal(calls.filter((c) => c.cap.endsWith('.prepare')).length, 0, 'F1 核心：不发 prepare——派生桶（无 source_ref）不能靠终检兜底');
    const job1 = db.prepare('SELECT state, reason_code FROM surfacing_jobs ORDER BY created_at LIMIT 1').get() as { state: string; reason_code: string };
    assert.equal(job1.state, 'blocked');
    assert.equal(job1.reason_code, 'QUARREL_SCOPE_UNREACHABLE');
    // 终检前清单恢复：下一条消息的新作业照常 prepare，排除集完整下推（含 quarrel 全集）
    phase = 1;
    const u2 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '聊点别的花园', clientMessageId: 'qg2', occurredAt: T0 });
    const aug2 = await svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: u2.turnId, attemptId: 'a2', message: { id: u2.message.id, revision: 1, sequence: u2.message.sequence, content: '聊点别的花园', hash: 'h2' } });
    const prep = calls.find((c) => c.cap.endsWith('.prepare'))!.payload as { excluded_source_ids?: string[] };
    assert.ok(prep.excluded_source_ids?.includes('sm_q1') && prep.excluded_source_ids?.includes('sm_q2'), '恢复后排除集完整下推');
    void aug2;
  } finally { await svc.stop(); await new Promise((r) => setImmediate(r)); db.close(); }
});

test('同步过但没送出的历史不是覆盖，只有触发原话进入自证排除', async () => {
  const { db, svc, messages, calls } = makeService(tempRoot('sfqctx-'), [{ decision: 'recall' }], null);
  try {
    const seed = new MessageService(db);
    const earlier = seed.submitUserMessageWithTurn({ conversationId: 'c1', content: '较早历史', clientMessageId: 'ctx-old', occurredAt: T0 });
    const trigger = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '还记得那件事吗', clientMessageId: 'ctx-trigger', occurredAt: T0 });
    db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES ('w1', 'c1', 'ACTIVE', ?, ?)").run(T0, T0);
    db.prepare("UPDATE conversations SET active_window_id='w1' WHERE id='c1'").run();
    for (const [name, msg] of [['old', earlier.message], ['trig', trigger.message]] as const) {
      db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(`ssr-${name}`, `op-${name}`, msg.id, 1, 'sc1', `sm_${name}`, msg.revision.content_hash, T0, T0);
    }
    const result = await svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: trigger.turnId,
      attemptId: trigger.attemptId, message: { id: trigger.message.id, revision: 1, sequence: trigger.message.sequence,
        content: trigger.message.revision.content, hash: trigger.message.revision.content_hash } });
    assert.ok(result);
    const payload = calls.find(call => call.cap === 'memory.surfacing.prepare')!.payload;
    assert.deepEqual(payload.excluded_source_ids, ['sm_trig']);
    assert.equal(payload.covered_ranges, undefined);
    assert.equal(Object.hasOwn(payload, 'in_context_source_ids'), false);
  } finally { await svc.stop(); db.close(); }
});

test('F4：集合检索第一页期间取消→不请求第二页、不进入编码/搜索', async () => {
  const port = await new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-f4-'));
  const content = new ContentServer({ stateRoot: path.join(root, 'content'), port, token: 'f4-token' });
  await content.start();
  const direct = { baseUrl: `http://127.0.0.1:${content.port}`, token: content.token };
  for (let i = 1; i <= 150; i++) {
    const r = await contentForward(direct, { method: 'POST', actor: 'qiaosheng', path: '/api/v1/content/albums/stickers/entries', body: { asset_id: `asset-f4-${i}` }, headers: { 'idempotency-key': `f4-${i}` } });
    assert.equal(r.status, 201);
  }
  let listRequests = 0;
  const controller = new AbortController();
  const proxy = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      listRequests += 1;
      void fetch(`http://127.0.0.1:${content.port}${req.url}`, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${content.port}` }, ...(req.method !== 'GET' ? { body: raw } : {}) }).then(async (up) => {
        const text = await up.text();
        if (listRequests === 1) controller.abort(); // 第一页响应到达时调用方取消（复审同款时序）
        res.writeHead(up.status, { 'Content-Type': 'application/json' }); res.end(text);
      }).catch(() => { res.statusCode = 500; res.end('{}'); });
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const tools = new MediaToolsService({ contentClient: { baseUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, token: 'f4-token' } as never, mediaIndex: { available: true } as never });
    const r = await tools.mediaSearch({ query: '猫猫', scope: 'stickers' }, { roomId: 'c1', signal: controller.signal } as never);
    assert.equal(r.ok, false, JSON.stringify(r.output));
    assert.equal(listRequests, 1, 'F4 核心：第一页取消后不再请求第二页');
    assert.match(String((r.output as { detail?: string }).detail), /取消/, '取消语义如实返回');
  } finally { proxy.close(); await content.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

// —— RR4 复审 2026-11-12 两处收口（A 正文传输失败 / B 自动浮现取消贯穿）的验收 ——

import { ArchiveService } from '../../apps/host/src/modules/archives/service.ts';

async function seedQuarrelArchives(content: ContentServer, conversationId: string, n: number, db: ReturnType<typeof makeDb>): Promise<void> {
  const { contentForward } = await import('../../apps/host/src/integrations/content/client.ts');
  const direct = { baseUrl: `http://127.0.0.1:${content.port}`, token: content.token };
  const t0 = new Date().toISOString();
  for (let i = 1; i <= n; i++) {
    const r = await contentForward(direct, { method: 'POST', actor: 'qiaosheng', path: '/api/v1/content/archives', body: { conversation_id: conversationId, kind: 'quarrel', messages: [{ message_id: `qam${i}`, revision: 1, sequence: i }] }, headers: { 'idempotency-key': `ab-qa-${i}` } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(`ssr-ab-${i}`, 'op-ab', `qam${i}`, 1, 'sc1', `sm_ab_${i}`, 'h', t0, t0);
  }
}

/** 转发真实 content，但对 pathPrefix 的第 N 次 GET：回 200 头 + 一半正文后断开（复审 A 同款传输故障）。 */
function truncatingProxy(content: ContentServer, breakOnPage: number, pathPrefix = '/api/v1/content/archives'): { url: string; listRequests: number } {
  let listRequests = 0;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const isList = (req.url ?? '').startsWith(pathPrefix) && req.method === 'GET';
      if (isList) listRequests += 1;
      void fetch(`http://127.0.0.1:${content.port}${req.url}`, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${content.port}` }, ...(req.method !== 'GET' ? { body: raw } : {}) }).then(async (up) => {
        const text = await up.text();
        if (isList && listRequests === breakOnPage) {
          // 200 头+一半正文+干净 FIN（去 Content-Length 走 chunked）——fetch 可解析完成
          // 但 JSON.parse 失败，走 bodyFailed 分支（连接销毁 flavor 由 reject 表达，
          // 两种表现消费者都必须接住；A 测试同时覆盖两 flavor：quarrel 用 destroy 版）
          const headers = Object.fromEntries(Object.entries(up.headers).filter(([k]) => k.toLowerCase() !== 'content-length'));
          res.writeHead(up.status, headers);
          res.end(text.slice(0, Math.max(1, Math.floor(text.length / 2))));
          return;
        }
        res.writeHead(up.status, { 'Content-Type': 'application/json' }); res.end(text);
      }).catch(() => { res.statusCode = 500; res.end('{}'); });
    });
  });
  return {
    listen: () => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
    url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => server.close(),
  } as never;
}

test('A：200 头后正文截断=读取失败——封存 unreachable（非完整空集）；搜索 unavailable（非 no_match 且不调 M）；空列表/多页正例不受影响', async () => {
  const port = await new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-abfix-'));
  const content = new ContentServer({ stateRoot: path.join(root, 'content'), port, token: 'ab-token' });
  await content.start();
  const db = makeDb(path.join(root, 'data'));
  await seedQuarrelArchives(content, 'c1', 150, db); // 150 份争吵存档 → 2 页
  const proxy = truncatingProxy(content, 1);
  await (proxy as unknown as { listen: () => Promise<void> }).listen();
  let mSearchCalls = 0;
  try {
    const healthy = new ArchiveService({ db, contentClient: { baseUrl: `http://127.0.0.1:${content.port}`, token: 'ab-token' } as never });
    // 正例 1：合法空列表（无存档会话）仍是 reachable+complete 的空集
    const empty = await healthy.quarrelBlockedSourceRefs('c-none');
    assert.equal(empty.reachable, true); assert.equal(empty.complete, true); assert.equal(empty.refs.size, 0);
    // 正例 2：完整响应翻页到底（150 条 → 2 页全收）
    const full = await healthy.quarrelBlockedSourceRefs('c1');
    assert.equal(full.reachable, true); assert.equal(full.complete, true);
    assert.equal(full.refs.size, 150, '两页去重后全集');
    // 故障：第一页 200 头后正文截断
    const viaProxy = new ArchiveService({ db, contentClient: { baseUrl: (proxy as unknown as { url: () => string }).url(), token: 'ab-token' } as never });
    const broken = await viaProxy.quarrelBlockedSourceRefs('c1');
    assert.equal(broken.reachable, false, '正文截断≠完整核对');
    assert.equal(broken.complete, false, '不得冒充完整空排除集');
    assert.equal(broken.refs.size, 0);
    // 搜索自己的读取也被截断（独立代理，复现报告场景：搜索页正文丢失）
    const proxy2 = truncatingProxy(content, 1);
    await (proxy2 as unknown as { listen: () => Promise<void> }).listen();
    const searchSvc = new ArchiveService({ db, contentClient: { baseUrl: (proxy2 as unknown as { url: () => string }).url(), token: 'ab-token' } as never });
    const searched = await searchSvc.searchArchives({ conversationId: 'c1', query: '任何词', mariposa: { sourceSearch: async () => { mSearchCalls += 1; return { ok: true, result: { hits: [] } }; } } as never });
    assert.equal(searched.state, 'unavailable', '传输失败→unavailable，不是 no_match');
    assert.equal(mSearchCalls, 0, '未完成读取不发起 M 检索');
    (proxy2 as unknown as { close: () => void }).close();
  } finally {
    (proxy as unknown as { close: () => void }).close();
    await content.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('B：自动浮现真实链第一页期间取消→零后续页、零 M prepare、作业 cancelled；正例：多页读完+完整排除集下推', async () => {
  const port = await new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-bfix-'));
  const content = new ContentServer({ stateRoot: path.join(root, 'content'), port, token: 'b-token' });
  await content.start();
  const harness = makeService(tempRoot('sfb-'), [{ decision: 'recall' }, { decision: 'recall' }], null);
  const { db, svc, calls } = harness;
  await seedQuarrelArchives(content, 'c1', 150, db);
  // 挂起代理：第一页请求到达后先通知测试、等放行再回真实响应
  let listRequests = 0;
  let firstPageSeen: (() => void) | null = null;
  const seenPromise = new Promise<void>((resolve) => { firstPageSeen = resolve; });
  let release: (() => void) | null = null;
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const proxy = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const isList = (req.url ?? '').startsWith('/api/v1/content/archives') && req.method === 'GET';
      if (isList) listRequests += 1;
      void fetch(`http://127.0.0.1:${content.port}${req.url}`, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${content.port}` }, ...(req.method !== 'GET' ? { body: raw } : {}) }).then(async (up) => {
        const text = await up.text();
        if (isList && listRequests === 1) { firstPageSeen!(); await releasePromise; }
        res.writeHead(up.status, { 'Content-Type': 'application/json' }); res.end(text);
      }).catch(() => { res.statusCode = 500; res.end('{}'); });
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const archives = new ArchiveService({ db, contentClient: { baseUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, token: 'b-token' } as never });
  // 真实端口接线（同 Host 装配形态）：signal 传到封存分页
  (svc as unknown as { quarrelSourceRefs: unknown }).quarrelSourceRefs = (cid: string, signal?: AbortSignal) => archives.quarrelBlockedSourceRefs(cid, signal);
  try {
    // —— 取消场景：第一页在途时取消回合 ——
    const live = new MessageService(db, bindForTest({ surfacing: svc, activity: null }));
    const trig = live.submitUserMessageWithTurn({ conversationId: 'c1', content: '还记得那次争吵吗', clientMessageId: 'b-trig', occurredAt: T0 });
    const augPromise = svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: trig.turnId, attemptId: 'b1', message: { id: trig.message.id, revision: 1, sequence: trig.message.sequence, content: '还记得那次争吵吗', hash: 'h1' } });
    await seenPromise; // 第一页请求已到达
    svc.cancelForTurn(trig.turnId); // 公开取消入口（复审同款）
    release!(); // 放行第一页真实响应
    const aug = await augPromise;
    assert.equal(aug, null, '取消后零注入');
    assert.equal(listRequests, 1, 'B 核心：取消后不再请求第二页');
    assert.equal(calls.filter((c) => c.cap.endsWith('.prepare')).length, 0, 'B 核心：取消后不再发 M prepare');
    const job = db.prepare('SELECT state, reason_code FROM surfacing_jobs WHERE source_message_id=?').get(trig.message.id) as { state: string; reason_code: string | null };
    assert.equal(job.state, 'cancelled');
    // —— 正例：不取消——多页读完、prepare 携带完整排除集（含第二页成员）——
    const trig2 = live.submitUserMessageWithTurn({ conversationId: 'c1', content: '聊点别的花园', clientMessageId: 'b-trig2', occurredAt: T0 });
    const aug2 = await svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: trig2.turnId, attemptId: 'b2', message: { id: trig2.message.id, revision: 1, sequence: trig2.message.sequence, content: '聊点别的花园', hash: 'h2' } });
    assert.ok(aug2, '正常链路照常注入（取消修复不破坏正例）');
    assert.equal(listRequests, 3, '正例两页读完（1+2）');
    const prep = calls.find((c) => c.cap.endsWith('.prepare'))!.payload as { excluded_source_ids?: string[] };
    assert.equal(prep.excluded_source_ids?.length, 150, '完整排除集（两页全集）下推');
  } finally { proxy.close(); await svc.stop(); await content.stop(); await new Promise((r) => setImmediate(r)); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('C（残留收口）：截断不冒充——工具读相册报错（非空列表）；media_view 授权查报 503（非误判不可读）', async () => {
  const port = await new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-cfix-'));
  const content = new ContentServer({ stateRoot: path.join(root, 'content'), port, token: 'c-token' });
  await content.start();
  const { contentForward } = await import('../../apps/host/src/integrations/content/client.ts');
  const direct = { baseUrl: `http://127.0.0.1:${content.port}`, token: 'c-token' };
  // 本地正本资产（readImage 先查本地；无收据不在房间 → 走 content 授权反查）
  const { MediaService } = await import('../../apps/host/src/media/assets.ts');
  const { buildConfig } = await import('../../apps/host/src/config/schema.ts');
  const dbC = makeDb(path.join(root, 'data'));
  const mediaSvc = new MediaService(dbC, path.join(root, 'media'), buildConfig({}));
  const asset = await mediaSvc.saveBuffer({ bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 3)]), purpose: 'chat_sticker', operationId: 'c-op-1', createdBy: 'qiaosheng', origin: 'upload' });
  const seed = await contentForward(direct, { method: 'POST', actor: 'qiaosheng', path: '/api/v1/content/albums/stickers/entries', body: { asset_id: asset.id }, headers: { 'idempotency-key': 'c-1' } });
  assert.equal(seed.status, 201);
  const { ContentToolsService } = await import('../../apps/host/src/modules/content/service.ts');
  const ctxTool = { roomId: 'c1', turnId: 't', requestId: 'r', purpose: 'chat' as const, activeReviewId: null, seenSequence: 0, seenMessages: [] };
  try {
    // ① content_albums_read 工具：条目列表 GET 截断 → 报读失败，不返回空列表
    const proxyAlbums = truncatingProxy(content, 1, '/api/v1/content/albums/stickers/entries');
    await (proxyAlbums as unknown as { listen: () => Promise<void> }).listen();
    const toolsBad = new ContentToolsService({ contentClient: { baseUrl: (proxyAlbums as unknown as { url: () => string }).url(), token: 'c-token' } as never, media: null, contentOps: null });
    const r = await toolsBad.contentAlbumsRead({ album: 'stickers' }, ctxTool as never);
    assert.equal(r.ok, false, JSON.stringify(r.output));
    assert.equal((r.output as { error_code: string }).error_code, 'ALBUM_READ_FAILED', '截断≠空相册');
    (proxyAlbums as unknown as { close: () => void }).close();
    // ② media_view 授权查（相册成员反查）截断 → 503 CONTENT_UNREACHABLE，不是 ASSET_NOT_READABLE
    const { MediaToolsService } = await import('../../apps/host/src/modules/media/service.ts');
    const proxyAlbums2 = truncatingProxy(content, 1, '/api/v1/content/albums?');
    await (proxyAlbums2 as unknown as { listen: () => Promise<void> }).listen();
    const mediaTools = new MediaToolsService({ contentClient: { baseUrl: (proxyAlbums2 as unknown as { url: () => string }).url(), token: 'c-token' } as never, media: mediaSvc });
    const view = await mediaTools.mediaView({ asset_ref: `est:${asset.id}` }, { roomId: 'c1' } as never);
    assert.equal(view.ok, false);
    assert.equal((view.output as { error_code: string }).error_code, 'CONTENT_UNREACHABLE', '传输失败不得误判为无权读');
    (proxyAlbums2 as unknown as { close: () => void }).close();
  } finally { await content.stop(); dbC.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

