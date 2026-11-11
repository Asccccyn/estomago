// RR4 复审（2026-11-11 ALBUM_RR4_REAUDIT）三处补修的验收：
// F1 封存清单不可核对→prepare 阶段暂缓（不发没有完整排除依据的候选包）；
//    两阶段时序：准备时失败→终检前恢复——第一次零 prepare 调用+作业 blocked，
//    第二条消息（新作业）正常 prepare 且排除集完整下推。
// F2 in_context_source_ids 按 M 合同 maxItems=128 有界（128 消息+1 编辑=129 来源
//    曾致整请求被入口校验拒绝）；excluded（正确性）同场景不截断。
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

const CALLS = new WeakMap<object, Array<{ cap: string; payload: Record<string, unknown> }>>();

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
  CALLS.set(svc, calls);
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

test('F2：128 消息+1 编辑=129 来源——in_context 按合同 128 有界；excluded（正确性）不截断', async () => {
  const { db, svc } = makeService(tempRoot('sfqctx-'), [{ decision: 'recall' }], null);
  const calls = (svc as unknown as { _t?: never }, null); void calls;
  try {
    const t0 = new Date().toISOString();
    // 种子消息用不挂 surfacing 的服务提交（每条用户消息都会注册浮现作业——种子若注册，
    // 后台 drain 会把触发作业提前收敛成 covered，测不到目标路径）
    const seed = new MessageService(db, bindForTest({ surfacing: null, activity: null }));
    seed.ensureConversation('c1');
    let lastId = '';
    for (let i = 1; i <= 128; i++) {
      const u = seed.submitUserMessageWithTurn({ conversationId: 'c1', content: `上下文消息${i}`, clientMessageId: `ctx${i}`, occurredAt: T0 });
      if (i === 128) lastId = u.message.id;
      db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(`ssr-ctx-${i}`, `op-ctx`, u.message.id, 1, 'sc1', `sm_ctx_${i}`, `h${i}`, t0, t0);
    }
    // 末条上下文消息编辑出 v2 并同步（多修订→同消息两个来源：窗口来源 > 合同 128）
    db.prepare('INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('mrev-ctx-2', lastId, 2, 'text', '上下文消息128（改）', sha256Hex('v2'), t0, t0, 'user');
    db.prepare('UPDATE messages SET current_revision = 2 WHERE id = ?').run(lastId);
    db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('ssr-ctx-v2', 'op-ctx', lastId, 2, 'sc1', 'sm_ctx_128_v2', 'hv2', t0, t0);
    // in_context 读取当前活动窗——种子补 ACTIVE 窗行（无窗=如实空集，测不到该字段）
    db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES ('w1', 'c1', 'ACTIVE', ?, ?)").run(t0, t0);
    // 触发消息走真实 surfacing 绑定（唯一作业）
    const live = new MessageService(db, bindForTest({ surfacing: svc, activity: null }));
    const trig = live.submitUserMessageWithTurn({ conversationId: 'c1', content: '还记得那件事吗', clientMessageId: 'trig', occurredAt: T0 });
    db.prepare('INSERT INTO source_sync_receipts(id, operation_id, origin_message_id, revision, source_conversation_id, source_message_id, content_hash, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('ssr-trig', 'op-trig', trig.message.id, 1, 'sc1', 'sm_trig', 'ht', t0, t0);
    const aug = await svc.augmentFor({ conversationId: 'c1', windowId: 'w1', turnId: trig.turnId, attemptId: 'a1', message: { id: trig.message.id, revision: 1, sequence: trig.message.sequence, content: '还记得那件事吗', hash: 'h1' } });
    assert.ok(aug, '合法路径 prepare 正常发出（F2 修复不破坏正常流）');
    const callsArr = CALLS.get(svc)!;
    const prep = callsArr.find((c) => c.cap.endsWith('.prepare'))!.payload as { in_context_source_ids?: string[]; excluded_source_ids?: string[] };
    assert.equal(prep.in_context_source_ids?.length, 128, 'in_context 按合同 maxItems=128 有界（129 来源曾被 M 入口整单拒绝）');
    assert.equal(new Set(prep.in_context_source_ids).size, 128, '切片去重后仍 128');
    assert.equal(prep.excluded_source_ids?.length, 1, 'excluded（正确性）全量（触发消息收据在集）');
  } finally { await svc.stop(); await new Promise((r) => setImmediate(r)); db.close(); }
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
