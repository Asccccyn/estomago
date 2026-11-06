// 她批准 2026-10-17：许愿星（superposition）接入。
//  - 开窗注入：临近纪念日只在窗口内出现（快到了才提醒）；失败如实降级不阻塞
//  - char工具面：HTTP 转发（jiaming 身份）、幂等键派生、写操作回执瘦身、错误如实
import { test } from 'node:test';
import { assembleTestTools, readyRuntimePatch, tempRoot, validateToolArgs, writeApprovedIdentity } from '../helpers.ts';
import assert from 'node:assert/strict';
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
  const { tools, db } = makeTools(calls, () => ({ status: 200, body: { id: 'star_1', content: '不该回显的正文', visibility: 'visible', state: 'written', extra: 'x' } }));
  try {
    const checked = validateToolArgs('wishstar_write_star', { content: '许个愿', visibility: 'visible', idempotency_key: 'op-1' });
    assert.equal(checked.ok, true);
    const out = await tools.execute('wishstar_write_star', checked.value as Record<string, unknown>, CTX as never);
    assert.equal(out.ok, true);
    assert.deepEqual(out.output, { id: 'star_1', visibility: 'visible', state: 'written' }, '写回执投影只留 id/可见性/状态，不回显正文');
    const call = calls[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/api/stars');
    assert.deepEqual(call.body, { content: '许个愿', visibility: 'visible' });
    assert.match(call.idempotencyKey ?? '', /^ws:t1:req-1:op-1$/, '幂等键由宿主派生');
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
    const out2 = await bare.execute('wishstar_write_star', { content: 'x', visibility: 'visible', idempotency_key: 'k' }, CTX as never);
    assert.equal((out2.output as { error_code: string }).error_code, 'INTEGRATION_UNCONFIGURED');
  } finally { db2.close(); }
});

test('开窗注入：临近纪念日出现在 B 文本头段；无临近=无行；失败=降级警告不阻塞', async () => {
  // 直接调用 supervisor 的 windowBootstrap（同 bootstrap-pages.test 的 hostFor 模式太重——
  // 用最小宿主壳验证注入分支）
  const { TurnSupervisor } = await import('../../apps/host/src/runtime/supervisor.ts');
  const callBootstrap = (TurnSupervisor.prototype as unknown as { windowBootstrap: (id: string, signal?: AbortSignal) => Promise<string | null> }).windowBootstrap;

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
  const mkHost = (wishstar: unknown) => ({
    // windowBootstrap 经 this.toolCatalogSource() 取目录（S17b 批次3）——假 host 提供空目录
    toolCatalogSource: () => ({ currentCatalog: () => [] }),
    d: {
      // R1′ 夹具修复（2026-10-23）：e423220 起 windowBootstrap 需真实 db 读 runtime_settings
      db: initialToolsDb,
      bootstrap: mariposa, // S18：显式 BootstrapPort
      toolCatalog: { currentCatalog: () => [] }, // windowBootstrap 渲染 tools/initial 用（空=无该行）
      events: { publish: () => {} },
      alerts: null,
      wishstar,
      config: { wishstar: { upcoming_days: 3 } },
    },
    bootstrapByWindow: new Map<string, string>(),
  });

  // 1) 有临近：渲染提醒行（含天数）
  const withNear = await callBootstrap.call(mkHost({ upcoming: async () => ({ items: [{ name: '7.9 我们的结婚纪念日', date: '2026-07-09', days_until: 2 }] }) }), 'w-near');
  assert.ok(withNear?.includes('临近纪念日：7.9 我们的结婚纪念日（还有 2 天）'), withNear ?? '');

  // 2) 无临近：不带提醒行
  const none = await callBootstrap.call(mkHost({ upcoming: async () => ({ items: [] }) }), 'w-none');
  assert.ok(!none?.includes('临近纪念日'), none ?? '');
  assert.ok(none?.includes('I 前缀'), '有 I 资料时包照常（仅无提醒行）');

  // 3) 失败：警告一次、其余照常（不抛）
  const warned: unknown[] = [];
  const failHost = mkHost({ upcoming: async () => { throw new Error('WISHSTAR_500'); } });
  failHost.d.events = { publish: (kind: string) => { warned.push(kind); } };
  const degraded = await callBootstrap.call(failHost, 'w-fail');
  assert.ok(degraded?.includes('I 前缀'), '提醒失败不阻塞其余开窗资料');
  assert.equal(warned.filter((k) => k === 'context.warning').length, 1, '一次警告');
});

// —— RT02（复审 20261106）：body 取消纳入同一结果边界，不吞成成功空对象 ——

test('RT02：真实 200 头+部分 JSON 后取消——客户端返回未知，不是成功空对象', async () => {
  const http = await import('node:http');
  const { WishstarClient } = await import('../../apps/host/src/integrations/wishstar/client.ts');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
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
    const out = await tools.execute('wishstar_write_star', { content: '许个愿', visibility: 'visible', idempotency_key: 'op-rt02b' }, CTX as never);
    assert.equal(out.ok, false, '不成功');
    assert.equal(out.output.error_code, 'WISHSTAR_OUTCOME_UNKNOWN', '复审反例：曾 ok:true/output:{}——现为未知，沿幂等键核对');
  } finally { db.close(); }
});
