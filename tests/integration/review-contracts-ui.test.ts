// 复审 R16/R18/R20（2026-10-07）真 HTTP 层回归：
//  R16：编辑后有自己的接线——message.edited 事件发布（SSE 可见）+ 触发
//      既有归档（编辑修订真实同步到远端；归档失败不撤销本地编辑）
//  R18：费用日累计按**上海自然日**（昨日午后的费用不算进今天）+ usageDay 口径披露
//  R20：首屏=最新一页（order=latest）+ before= 向前游标可达（>500 条历史可翻）
import '../helpers.ts'; // 首先启用 ESTOMAGO_TEST_MODE
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

const root = tempRoot('estomago-rc-');
writeApprovedIdentity(root);

// —— 迷你 mariposa 桩：按契约回 source.ingest ACK（证明编辑修订真的出站）——
const stubSeen: Array<{ cap: string; body: Record<string, any> }> = [];
let stubPort = 0;
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) as Record<string, any> : {};
    const cap = (req.url ?? '').split('/').pop() ?? '';
    stubSeen.push({ cap, body });
    if (cap === 'source.ingest') {
      const msgs = (body.arguments?.messages ?? []) as Array<Record<string, any>>;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        data: {
          operation_id: body.arguments?.operation_id,
          committed_at: new Date().toISOString(),
          messages: msgs.map((m) => ({
            origin_message_id: m.origin_message_id, revision: m.revision,
            source_conversation_id: 'mc-stub', source_message_id: `msrc-${m.origin_message_id}-r${m.revision}`,
            content_hash: m.content_hash })),
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: { code: 'CAPABILITY_NOT_FOUND' } }));
  });
});

let host: Host;
let base = '';
let token = '';

test.before(async () => {
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => { stubPort = (stub.address() as { port: number }).port; r(); }));
  const config = buildConfig({
    runtime: { provider: 'mock', ...(readyRuntimePatch().runtime as Record<string, unknown>) },
    deployment: { port: 0 },
    archive: { enabled: true, source_scope: 'test-live' },
    integrations: { mariposa: { base_url: `http://127.0.0.1:${stubPort}`, credential_ref: 'NONE' } },
  });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  base = `http://127.0.0.1:${host.port}`;
  token = fs.readFileSync(path.join(root, 'config', 'auth.token'), 'utf8').trim();
});
test.after(async () => { await host.stop(); stub.close(); });

// token 在 test.before 才就绪——headers 必须用时取值（模块加载时固化=空 token）
const authHeaders = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });

test('R16：PUT 编辑 → message.edited 事件 + 编辑修订真实归档出站', async () => {
  const post = await fetch(`${base}/api/v1/conversations/primary/messages`, {
    method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ content: '编辑前正文', client_message_id: 'r16-k1' }),
  });
  const postText = await post.text();
  assert.equal(post.status, 201, postText);
  const created = (JSON.parse(postText) as { message: { id: string } }).message;
  const put = await fetch(`${base}/api/v1/conversations/primary/messages/${encodeURIComponent(created.id)}`, {
    method: 'PUT', headers: { ...authHeaders(), 'content-type': 'application/json', 'if-match': `"${(JSON.parse(postText).message).current_revision ?? 1}"` },
    body: JSON.stringify({ content: '编辑后正文（R16）' }),
  });
  assert.equal(put.status, 200, await put.text());
  // 事件已发布（runtime_stream_events 落档，SSE 订阅者可见）
  const evFound = await (async () => {
    for (let i = 0; i < 20; i++) {
      const rows = (host as unknown as { db: import('../../apps/host/src/db/connection.ts').Db }).db
        .prepare("SELECT COUNT(*) n FROM runtime_stream_events WHERE kind='message.edited'").get() as { n: number };
      if (rows.n >= 1) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  assert.ok(evFound, 'message.edited 事件落档（SSE 可见）');
  // 归档真实出站：编辑修订（r2）到达 mariposa 桩并拿到有效 ACK
  const acked = await (async () => {
    for (let i = 0; i < 30; i++) {
      const hits = stubSeen.filter((s) => s.cap === 'source.ingest'
        && JSON.stringify(s.body).includes('编辑后正文（R16）'));
      if (hits.length >= 1) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  assert.ok(acked, '编辑修订真实同步出站（反例：远端 0 请求、只有重启才恢复）');
});

test('R18：费用日累计按上海自然日（昨日午后不算今天）+ usageDay 披露', async (t) => {
  // 固定上海10:00：昨日13:00仍在滚动24h内，但不属于今天。
  // 避免真实午夜附近 now-30min 也落入昨日而导致错误失败。
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-13T02:00:00Z') });
  const db = (host as unknown as { db: import('../../apps/host/src/db/connection.ts').Db }).db;
  const win = db.prepare('SELECT id FROM windows LIMIT 1').get() as { id: string } | undefined;
  const attempt = db.prepare('SELECT id, turn_id FROM attempts LIMIT 1').get() as { id: string; turn_id: string } | undefined;
  if (!win || !attempt) { assert.ok(false, '前置：窗口/attempt 存在'); return; }
  const mk = (id: string, purpose: string, observedAt: string) => {
    db.prepare("INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, outcome, created_at) VALUES (?,?,?,?,?,'[]','sent',?)").run(id, win.id, attempt.id, attempt.turn_id, purpose, observedAt);
    db.prepare("INSERT INTO usage_observations(id, request_id, attempt_id, turn_id, scope, source, cost_usd, observed_at) VALUES (?,? ,?,'turn','request','report',?,?)").run(`uo-${id}`, id, attempt.id, 0.01, observedAt);
  };
  // 上海"昨天"13:00（=UTC 前一天 05:00）——滚动 24h 口径会把它算进今天
  const now = Date.now();
  const yesterdayShanghai1300 = '2026-10-12T05:00:00.000Z';
  mk('pr-yd', 'chat', yesterdayShanghai1300);
  mk('pr-td', 'chat', new Date(now - 30 * 60 * 1000).toISOString());
  const res = await fetch(`${base}/api/v1/conversations/primary/context-records`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const snap = await res.json() as { usageDay: string; usageByPurpose: Array<{ purpose: string; count: number }> };
  assert.match(snap.usageDay ?? '', /^\d{4}-\d{2}-\d{2}$/, '日累计口径=上海自然日（披露日期）');
  const chat = snap.usageByPurpose.find((u) => u.purpose === 'chat');
  assert.ok(chat, 'chat 分列在场');
  assert.equal(chat!.count, 1, '只计今天：昨日午后（上海）的费用不进今天（此前滚动 24h 会算 2）');
});

test('R20：首屏最新一页 + before=向前游标可达（>500 条历史可翻）', async () => {
  const db = (host as unknown as { db: import('../../apps/host/src/db/connection.ts').Db }).db;
  // 直接种入 510 条（绕过 510 次 HTTP；服务语义不变）
  const svc = (host as unknown as { messages: { submitUserMessageWithTurn(a: Record<string, unknown>): unknown } }).messages;
  for (let i = 0; i < 510; i++) {
    svc.submitUserMessageWithTurn({ conversationId: 'primary', content: `历史消息 ${i}`, clientMessageId: `r20-${i}` });
  }
  const first = await (await fetch(`${base}/api/v1/conversations/primary/messages?limit=500&order=latest`, { headers: authHeaders() })).json() as { messages: Array<{ sequence: number }> };
  const seqs = first.messages.map((m) => m.sequence);
  assert.ok(seqs.length > 0);
  const maxSeq = db.prepare('SELECT MAX(sequence) s FROM messages').get() as { s: number };
  assert.ok(seqs.includes(maxSeq.s), '首屏含最新一条（反例：默认取最早 500 条）');
  const oldest = Math.min(...seqs);
  const earlier = await (await fetch(`${base}/api/v1/conversations/primary/messages?limit=200&before=${oldest}`, { headers: authHeaders() })).json() as { messages: Array<{ sequence: number }> };
  assert.ok(earlier.messages.length > 0, 'before=最早序号能翻到更早历史（反例：返回 0 条）');
  assert.ok(Math.max(...earlier.messages.map((m) => m.sequence)) < oldest, '翻页方向正确（更早）');
});
