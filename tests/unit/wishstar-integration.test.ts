// 她批准 2026-10-17：许愿星（superposition）接入。
//  - 开窗注入：临近纪念日只在窗口内出现（快到了才提醒）；失败如实降级不阻塞
//  - char工具面：HTTP 转发（jiaming 身份）、幂等键派生、写操作回执瘦身、错误如实
import { test } from 'node:test';
import { assembleTestTools, readyRuntimePatch, tempRoot, validateToolArgs, writeApprovedIdentity } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { freezeWindowTools } from '../../apps/host/src/runtime/tool-discovery.ts';
import type { HostToolSpec } from '../../apps/host/src/capabilities/contracts.ts';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-1' } as const;

type ForwardCall = { method: string; path: string; body?: Record<string, unknown>; idempotencyKey?: string };

function makeTools(calls: ForwardCall[], respond: (c: ForwardCall) => { status: number; body: Record<string, unknown> }) {
  const root = tempRoot('ws-');
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const wishstar = {
    forward: async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string) => {
      const call = { method, path, body, idempotencyKey };
      calls.push(call);
      return respond(call);
    },
  };
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), wishstar: wishstar });
  return { tools, db };
}

test('wishstar_write_star：转发形状+幂等键派生+写回执瘦身', async () => {
  const calls: ForwardCall[] = [];
  const { tools, db } = makeTools(calls, () => ({ status: 200, body: { id: 'star_1', content: '许个愿', visibility: 'visible', state: 'written', extra: 'x' } }));
  try {
    const checked = validateToolArgs('wishstar_write_star', { text: '许个愿', visibility: 'visible', idempotency_key: 'op-1' });
    assert.equal(checked.ok, true);
    const out = await tools.execute('wishstar_write_star', checked.value as Record<string, unknown>, CTX as never);
    assert.equal(out.ok, true);
    assert.deepEqual(out.output, { id: 'star_1', visibility: 'visible', state: 'written' }, '写回执投影只留 id/可见性/状态，不回显正文');
    const call = calls[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/api/stars');
    assert.deepEqual(call.body, { content: '许个愿', visibility: 'visible' });
    assert.match(call.idempotencyKey ?? '', /^ws:star:v1:[0-9a-f]{64}$/, '写星 HTTP 幂等键由宿主派生');
  } finally { db.close(); }
});

test('写星：合法长键可发 HTTP，响应未知后同回合跨请求重试只写一颗', async () => {
  const calls: ForwardCall[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const { tools, db } = makeTools(calls, (call) => {
    const key = new Headers({ 'Idempotency-Key': call.idempotencyKey! }).get('Idempotency-Key')!;
    if (key.length > 128) return { status: 422, body: { detail: 'Idempotency-Key 不合法' } };
    const existing = receipts.get(key);
    if (existing) return { status: 200, body: existing };
    const receipt = { ...call.body, id: 'star_' + (receipts.size + 1) };
    receipts.set(key, receipt);
    if (receipts.size === 1) return { status: 0, body: { error_code: 'WISHSTAR_BODY_UNREADABLE_UNKNOWN' } };
    return { status: 200, body: receipt };
  });
  try {
    const args = { text: '合成星', visibility: 'hidden', idempotency_key: '星🌟'.repeat(64) };
    const unknown = await tools.execute('wishstar_write_star', args, CTX);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.output.error_code, 'WISHSTAR_OUTCOME_UNKNOWN');
    assert.equal(calls.length, 1, '结果未知时不自动重发');

    const retry = await tools.execute('wishstar_write_star', args, { ...CTX, requestId: 'req-2', toolCallId: 'call-2' });
    assert.equal(retry.ok, true);
    assert.equal(retry.output.id, 'star_1');
    assert.equal(calls[0]!.idempotencyKey, calls[1]!.idempotencyKey);
    assert.equal(receipts.size, 1);

    const distinct = await tools.execute('wishstar_write_star', { ...args, idempotency_key: 'a'.repeat(128) }, { ...CTX, requestId: 'req-2' });
    assert.equal(distinct.ok, true);
    assert.equal(distinct.output.id, 'star_2', '同回合的不同键各自写入');
    const later = await tools.execute('wishstar_write_star', args, { ...CTX, turnId: 't2', requestId: 'req-3' });
    assert.equal(later.ok, true);
    assert.equal(later.output.id, 'star_1', '显式业务键也可在新回合找回原星');
    const conflict = await tools.execute('wishstar_write_star', { ...args, text: '不同参数' }, CTX);
    assert.equal(conflict.output.error_code, 'WISHSTAR_IDEMPOTENCY_CONFLICT');
    assert.equal(receipts.size, 2);
  } finally { db.close(); }
});

test('F08 写星新窗只认 text；已冻结旧窗仍按 content 原样写同一来源', async () => {
  const calls: ForwardCall[] = [];
  const text = '中："原话"\n第二行\\u4e2d';
  const { tools, db } = makeTools(calls, call => ({ status: 200, body: { ...call.body, id: 'star-f08' } }));
  try {
    const base = { visibility: 'visible', idempotency_key: 'old-star-f08' };
    assert.equal(validateToolArgs('wishstar_write_star', { ...base, text }).ok, true);
    assert.equal(validateToolArgs('wishstar_write_star', { ...base, content: text }).ok, false);
    const old = JSON.parse(fs.readFileSync(new URL('../fixtures/window-tools-before-autonomy.json', import.meta.url), 'utf8')) as { catalog: HostToolSpec[] };
    const messages = new MessageService(db);
    messages.ensureConversation(CTX.roomId);
    db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES('w1','c1','ACTIVE','now','now')").run();
    freezeWindowTools(db, CTX.windowId, old.catalog, 'legacy');
    const frozen = db.prepare('SELECT wire_tools_json,catalog_json FROM window_toolsets WHERE window_id=?').get(CTX.windowId);
    const wrong = await tools.execute('wishstar_write_star', { ...base, text }, CTX);
    assert.equal(wrong.ok, false);
    assert.equal(calls.length, 0);
    const saved = await tools.execute('wishstar_write_star', { ...base, content: text }, CTX);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(calls[0]?.body?.content, text);
    assert.deepEqual(db.prepare('SELECT wire_tools_json,catalog_json FROM window_toolsets WHERE window_id=?').get(CTX.windowId), frozen);
  } finally { db.close(); }
});

test('wishstar_start_session：路径绑定 special_date_id', async () => {
  const calls: ForwardCall[] = [];
  const { tools, db } = makeTools(calls, () => ({ status: 200, body: { id: 'sess_1', status: 'invited' } }));
  try {
    const out = await tools.execute('wishstar_start_session', { special_date_id: 'sd_79' }, CTX as never);
    assert.equal(out.ok, true);
    assert.equal(calls[0]!.path, '/api/sessions');
    assert.deepEqual(calls[0]!.body, { special_date_id: 'sd_79' });
    assert.equal(calls[0]!.idempotencyKey, 'ws:t1:req-1:ro');
  } finally { db.close(); }
});

test('读工具：GET 无幂等键、原样返回', async () => {
  const calls: ForwardCall[] = [];
  const { tools, db } = makeTools(calls, () => ({ status: 200, body: { items: [{ name: '7.9' }] } }));
  try {
    const out = await tools.execute('wishstar_special_dates', { }, CTX as never);
    assert.equal(out.ok, true);
    assert.deepEqual(out.output, { items: [{ name: '7.9' }] });
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.idempotencyKey, undefined, '读操作不带幂等键');
  } finally { db.close(); }
});

test('wishstar_read(what=shared)：转发共同瓶列表，对方写的可见星带正文投影', async () => {
  const calls: ForwardCall[] = [];
  const { tools, db } = makeTools(calls, () => ({ status: 200, body: { items: [
    { id: 'star_21545ae0d3a4', content: '今天超级幸福', visibility: 'visible', state: 'SHARED', author_id: 'qiaosheng', author_name: '宿主用户', shared_origin: 'visible_from_start', shared_at: '2026-11-25T22:10:09', secret_internal: 'x' },
    { id: 'star_5e0ca4f32ef9', content: '一起看机械姬', visibility: 'hidden', state: 'SHARED', author_id: 'qiaosheng', author_name: '宿主用户', shared_origin: 'revealed_by_offer', opened_by: 'jiaming' },
  ] } }));
  try {
    const out = await tools.execute('wishstar_read', { what: 'shared' }, CTX as never);
    assert.equal(out.ok, true);
    assert.equal(calls[0]!.path, '/api/stars/shared', 'shared 枚举转发共同瓶列表接口');
    assert.equal(calls[0]!.idempotencyKey, undefined, '读操作不带幂等键');
    const items = (out.output as { items: Array<Record<string, unknown>> }).items;
    assert.equal(items.length, 2);
    assert.equal(items[0]!.content, '今天超级幸福', '共同瓶星正文对助手可见');
    assert.equal(items[0]!.secret_internal, undefined, '投影白名单外的字段不透传');
    assert.equal(items[1]!.opened_by, 'jiaming');
  } finally { db.close(); }
});

test('错误如实：403 拒绝原样上抛；未配置=INTEGRATION_UNCONFIGURED', async () => {
  const { tools, db } = makeTools([], () => ({ status: 403, body: { detail: '纪念日只能在当天发起' } }));
  try {
    const out = await tools.execute('wishstar_start_session', { special_date_id: 'sd_x' }, CTX as never);
    assert.equal(out.ok, false);
    assert.equal((out.output as { error_code: string }).error_code, 'WISHSTAR_403');
  } finally { db.close(); }
  const root2 = tempRoot('ws2-');
  writeApprovedIdentity(root2);
  const db2 = openDatabase(path.join(root2, 'data'));
  migrate(db2, sha256Hex);
  try {
    const { tools: bare } = assembleTestTools({ db: db2, mariposa: null, reviews: new RotationReviewService(db2), checkpoint: new HoldCheckpointService(db2) });
    const out2 = await bare.execute('wishstar_write_star', { text: 'x', visibility: 'visible', idempotency_key: 'k' }, CTX as never);
    assert.equal((out2.output as { error_code: string }).error_code, 'INTEGRATION_UNCONFIGURED');
  } finally { db2.close(); }
});

test('开窗注入：临近纪念日出现在 B 文本头段；无临近=无行；失败=降级警告不阻塞', async () => {
  // 直接调用 supervisor 的 windowBootstrap（同 bootstrap-pages.test 的 hostFor 模式太重——
  // 用最小宿主壳验证注入分支）
  // R3（2026-11-07）：分页机已迁 window-bootstrap.ts——对机器原型取方法
  const { WindowBootstrapMachine } = await import('../../apps/host/src/runtime/window-bootstrap.ts');
  const callBootstrap = (host: WindowBootstrapMachine, id: string) => (host as unknown as { windowBootstrap: (id: string) => Promise<string | null> }).windowBootstrap.call(host, id);

  // 最小 mariposa mock：单页完整包（I 一段、无桶无计划）——让 windowBootstrap 走完渲染
  const packet = { snapshot_id: 'snap_ws', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none', i: { content: 'I 前缀' }, plans: null };
  const mariposa = {
    bootstrapGet: async () => ({ ok: true, result: packet }),
    bootstrapNext: async () => ({ ok: true, result: {} }),
    bootstrapValidate: async () => ({ ok: true, result: { unchanged: true, snapshot_id: 'snap_ws', profile: 'estomago' } }),
  };
  // R1′ 夹具修复（2026-10-23）：e423220 起 windowBootstrap 需真实 db 读 runtime_settings
  const initialToolsDb = openDatabase(path.join(tempRoot('ws-initdb-'), 'data'));
  migrate(initialToolsDb, sha256Hex);
  // R4b/episode 批：机器新增编排方法——假宿主改真机器实例（deps 直接注入）
  const mkHost = (wishstar: unknown) => new WindowBootstrapMachine({
    bootstrap: mariposa, // S18：显式 BootstrapPort
    events: { publish: () => {} },
    alerts: null,
    wishstar: wishstar as never,
    config: { wishstar: { upcoming_days: 3 } } as never,
  });

  // 1) 有临近：渲染提醒行（含天数）
  const withNear = await callBootstrap(mkHost({ upcoming: async () => ({ items: [{ name: '7.9 我们的结婚纪念日', date: '2026-07-09', days_until: 2 }] }) }), 'w-near');
  assert.ok(withNear?.includes('临近纪念日：7.9 我们的结婚纪念日（还有 2 天）'), withNear ?? '');

  // 2) 无临近：不带提醒行
  const none = await callBootstrap(mkHost({ upcoming: async () => ({ items: [] }) }), 'w-none');
  assert.ok(!none?.includes('临近纪念日'), none ?? '');
  assert.ok(none?.includes('I 前缀'), '有 I 资料时包照常（仅无提醒行）');

  // 3) 失败：警告一次、其余照常（不抛）
  const warned: unknown[] = [];
  const failHost = mkHost({ upcoming: async () => { throw new Error('WISHSTAR_500'); } });
  failHost.d.events = { publish: (kind: string) => { warned.push(kind); } };
  const degraded = await callBootstrap(failHost, 'w-fail');
  assert.ok(degraded?.includes('I 前缀'), '提醒失败不阻塞其余开窗资料');
  assert.equal(warned.filter((k) => k === 'context.warning').length, 1, '一次警告');
});

// —— RT02（复审 20261106）：body 取消纳入同一结果边界，不吞成成功空对象 ——

test('RT02：真实 200 头+部分 JSON 后取消——客户端返回未知，不是成功空对象', async () => {
  const http = await import('node:http');
  const { WishstarClient } = await import('../../apps/host/src/integrations/wishstar/client.ts');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET') {
      res.end('not-json-at-all'); // 完整到达但不可解析：读取失败≠成功空对象（响应正常结束，不悬挂）
      return;
    }
    res.write('{"id":"star_1","con');
    req.on('close', () => { try { res.destroy(); } catch { /* 已断 */ } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.WS_RT02_TOKEN = 'synthetic-rt02';
  try {
    const client = new WishstarClient({ base_url: `http://127.0.0.1:${port}`, readonly_token_env: 'WS_RT02_RO', jiaming_token_env: 'WS_RT02_TOKEN' });
    const controller = new AbortController();
    const promise = client.forward('POST', '/api/stars', { content: 'x' }, 'op-rt02', controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const r = await promise;
    assert.equal(r.status, 0, '已发写的 body 取消=未知（不是 200）');
    assert.equal(r.body.error_code, 'WISHSTAR_CANCELLED_UNKNOWN');
    // 对照：GET body 不可读=本次读取不可用（可重试），不冒充成功
    const r2 = await client.forward('GET', '/api/stars', undefined, undefined);
    assert.equal(r2.status, 0);
    assert.equal(r2.body.error_code, 'WISHSTAR_BODY_UNREADABLE');
  } finally {
    delete process.env.WS_RT02_TOKEN;
    server.close();
  }
});

test('RT02：服务层把 body 取消未知映射为 WISHSTAR_OUTCOME_UNKNOWN（模型不见成功空对象）', async () => {
  const calls: ForwardCall[] = [];
  const { tools, db } = makeTools(calls, () => ({ status: 0, body: { error_code: 'WISHSTAR_CANCELLED_UNKNOWN', detail: '响应体未读完' } }));
  try {
    const out = await tools.execute('wishstar_write_star', { text: '许个愿', visibility: 'visible', idempotency_key: 'op-rt02b' }, CTX as never);
    assert.equal(out.ok, false, '不成功');
    assert.equal(out.output.error_code, 'WISHSTAR_OUTCOME_UNKNOWN', '复审反例：曾 ok:true/output:{}——现为未知，沿幂等键核对');
  } finally { db.close(); }
});
