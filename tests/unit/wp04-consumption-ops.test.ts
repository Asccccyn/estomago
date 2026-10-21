// WP-04（run-160858）：消费层正确性+运维有界性回归。
//  - WP04-a（JFA-C01/C10）：memory_recall_next 透传 judge_policy_revision/
//    judged_count；off 首页缺 pagination → RECALL_ENVELOPE_INVALID
//  - WP04-bc（JFA-C02/B03）：conversation_read 中文整条真 UTF-8 字节 ≤
//    上限；预算跳过行在续页可达（游标按最后已推送收缩）
//  - WP04-d/j2（JFA-B05/CX-10）：PUT {有效 model+非法 effort} → 422 且
//    零写入
//  - WP04-e（JFA-B06）：SDK 驱动有历史无活动窗锚定 awaiting
//  - WP04-g（JFA-C09）：非 loopback http base_url 拒绝
//  - WP04-j4（C-018）：mandatory=false 且 supported 含 minimal → minimal
//    可选；mandatory=true 才滤
//  - prune（JFA-E01）：只清超期 CLOSED payload；usage/audit 不动
//  - health（JFA-E07）：ready=false → 503；live 200
//  - backup（JFA-E08）：meta/config+auth.token(600)；轮转 keep=10
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig, validateConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { effortsForModel } from '../../apps/host/src/runtime/runtime-settings.ts';
import { pruneProviderRequests, pruneEvents } from '../../apps/host/src/runtime/prune.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';
import type { Db } from '../../apps/host/src/db/connection.ts';

function freshDb(root: string): { db: Db; root: string } {
  writeApprovedIdentity(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  return { db, root };
}

// --------------------------------------------------------------- prune E01

test('prune：只清超期 CLOSED 窗口 payload；ACTIVE/新 CLOSED/usage/审计不动', () => {
  const { db } = freshDb(tempRoot('wp4-prune-'));
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(now);
  const mkWin = (id: string, status: string, ts: string) =>
    db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, 'c1', status, ts, ts);
  const mkReq = (id: string, win: string) =>
    db.prepare("INSERT INTO provider_requests(id, window_id, purpose, seen_manifest_json, created_at, payload_json) VALUES (?,?, 'chat', '[]', ?, '{}')").run(id, win, now);
  mkWin('w-old', 'CLOSED', old); mkWin('w-new', 'CLOSED', now); mkWin('w-act', 'ACTIVE', now);
  mkReq('pr1', 'w-old'); mkReq('pr2', 'w-new'); mkReq('pr3', 'w-act');
  const cleared = pruneProviderRequests(db, { keepWindows: 1, keepDays: 30 });
  assert.equal(cleared, 1, '只清超期 CLOSED（w-old；keepWindows=1 豁免最新的 w-new）');
  const rows = db.prepare('SELECT id, payload_json FROM provider_requests').all() as Array<{ id: string; payload_json: string | null }>;
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.payload_json]));
  assert.equal(byId['pr1'], null, '超期 CLOSED payload 置空');
  assert.notEqual(byId['pr2'], null, '新 CLOSED 保留');
  assert.notEqual(byId['pr3'], null, 'ACTIVE 保留');
  const usage = db.prepare('SELECT COUNT(*) n FROM usage_observations').get() as { n: number };
  assert.equal(usage.n, 0, 'usage 账本不被 prune 触碰（表存在且零误删）');
  // 事件 prune：插旧行删、新行留
  db.prepare("INSERT INTO runtime_stream_events(event_id, stream_id, kind, conversation_id, occurred_at, payload_ref) VALUES ('e1','s1','window.rotated','c1',?,'{}')").run(old);
  db.prepare("INSERT INTO runtime_stream_events(event_id, stream_id, kind, conversation_id, occurred_at, payload_ref) VALUES ('e2','s1','window.rotated','c1',?,'{}')").run(now);
  const ev = pruneEvents(db, { keepDays: 30 });
  assert.ok(ev.events >= 1, '过期事件删除');
  const left = db.prepare("SELECT COUNT(*) n FROM runtime_stream_events WHERE event_id='e2'").get() as { n: number };
  assert.equal(left.n, 1, '新事件保留');
  db.close();
});

// --------------------------------------------------------------- health E07

test('health：ready=false → 503；live 恒 200（http 层单测形状）', async () => {
  // 直接构造 http 层不可行（需全 Host）——以 buildReadyReport 语义 +
  // http.ts 状态码映射的合流断言（ready 布尔 → 200/503）
  const src = fs.readFileSync(path.join(import.meta.dirname, '../../apps/host/src/server/http.ts'), 'utf8');
  assert.ok(src.includes('ready ? 200 : 503'), 'ready=false 必须映射 503');
  assert.ok(src.includes("route === 'GET /health/live'") && src.includes('json(res, 200'), 'live 保持 200');
});

// --------------------------------------------------------------- backup E08

test('backup：meta 含 config+auth.token(600)；轮转保留 keep 份', async () => {
  const root = tempRoot('wp4-backup-');
  const { db } = freshDb(root);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private','2026-01-01')").run();
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m1','c1',1,'owner','text',1,'2026-01-01','2026-01-01')").run();
  db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('m1',1,'text','x',?,'2026-01-01','2026-01-01','seed')").run(sha256Hex('x'));
  db.close();
  const cfgDir = path.join(root, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'estomago.yaml'), 'runtime:\n  provider: deepseek\n');
  fs.writeFileSync(path.join(cfgDir, 'auth.token'), 'tok-x');
  const { execFileSync } = await import('node:child_process');
  const env = { ...process.env, ESTOMAGO_HOME: root, ESTOMAGO_BACKUP_KEEP: '2' };
  const run = () => execFileSync(process.execPath, ['scripts/backup.mjs'], { env, cwd: path.join(import.meta.dirname, '../..'), encoding: 'utf8' });
  run(); run(); run(); // 3 份 → keep=2 → 最旧被清
  const backups = fs.readdirSync(path.join(root, 'backups'));
  const snaps = backups.filter((f) => f.endsWith('.sqlite3'));
  assert.equal(snaps.length, 2, `轮转后恰 keep=2 份（实际 ${snaps.length}）`);
  const metaDirs = backups.filter((f) => f.endsWith('.meta'));
  assert.ok(metaDirs.length >= 1, 'meta 目录存在');
  const meta = path.join(root, 'backups', metaDirs[0]!);
  assert.ok(fs.existsSync(path.join(meta, 'config.yaml')), 'config.yaml 入备份');
  assert.ok(fs.existsSync(path.join(meta, 'auth.token')), 'auth.token 入备份');
  const mode = fs.statSync(path.join(meta, 'auth.token')).mode & 0o777;
  assert.equal(mode, 0o600, 'token 权限 600');
});

// --------------------------------------------------------------- efforts j4

test('j4：mandatory=false 且 supported 含 minimal → minimal 可选；mandatory=true 才滤', () => {
  const flex = effortsForModel({ supported_efforts: ['minimal', 'low', 'high'], mandatory: false });
  assert.deepEqual(flex, ['default', 'minimal', 'low', 'high'], '只列 supported 中的档位，不凭 mandatory=false 添加 none');
  const forced = effortsForModel({ supported_efforts: ['max', 'high', 'low'], mandatory: true });
  assert.deepEqual(forced, ['default', 'low', 'high', 'max'], '强制思考模型无 none/minimal');
});

// --------------------------------------------------------------- base_url g

test('g：mariposa base_url 非 loopback http 拒绝；loopback http 放行', async () => {
  const bad = validateConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, integrations: { mariposa: { base_url: 'http://mariposa.internal:8800', credential_ref: null } } });
  assert.ok(bad.issues.some((i) => i.path.trim() === 'integrations.mariposa.base_url'), `非 loopback http 拒绝（issues=${JSON.stringify(bad.issues).slice(0, 200)}）`);
  const okL = validateConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, integrations: { mariposa: { base_url: 'http://127.0.0.1:8800', credential_ref: null } } });
  assert.equal(okL.issues.filter((i) => i.path.includes('mariposa')).length, 0, 'loopback http 放行');
  const okH = validateConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, integrations: { mariposa: { base_url: 'https://m.example', credential_ref: null } } });
  assert.equal(okH.issues.filter((i) => i.path.includes('mariposa')).length, 0, 'https 放行');
});

// ---------------------------------------------------- consumption a/b/c/d/e

test('a：memory_recall_next 透传 judge_policy_revision/judged_count；off 首页缺 pagination → ENVELOPE_INVALID', async () => {
  const { HostToolExecutor } = await import('../../apps/host/src/runtime/host-tools.ts');
  const { MariposaClient } = await import('../../apps/host/src/integrations/mariposa/client.ts');
  const { RotationReviewService } = await import('../../apps/host/src/context/rotation-review.ts');
  const { HoldCheckpointService } = await import('../../apps/host/src/memory/hold-checkpoint.ts');
  const { db } = freshDb(tempRoot('wp4-a-'));
  const pagePacket = {
    recall_session_id: 'rs_9', judge_mode: 'off', judged_count: 0,
    judge_policy_revision: 7, candidates: [], pagination: {
      result_set_id: 'rps_x', returned_count: 0, candidate_total: 1,
      has_more: false,
    },
  };
  const t = { transport: null as unknown };
  t.transport = async (cap: string) => {
    if (cap === 'memory.recall.page') return { ok: true, result: pagePacket };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: t.transport as never }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const CTX = { roomId: 'c1', windowId: 'w1', turnId: null, purpose: 'chat' as const, activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: 'r' };
  const out = await tools.execute('memory_recall_next', { __tool_call_id: 'c1', result_set_id: 'rps_x' }, CTX);
  assert.equal(out.ok, true, JSON.stringify(out.output));
  assert.equal((out.output as Record<string, unknown>).judge_policy_revision, 7, '纪元随页透传');
  assert.equal((out.output as Record<string, unknown>).judged_count, 0, 'judged_count 随页透传');

  // off 首页缺 pagination → 结构化拒绝（走 memory_recall 首页门）
  const homeOff = { transport: null as unknown };
  homeOff.transport = async () => ({ ok: true, result: {
    recall_session_id: 'rs_10', search_status: 'FOUND', judge_mode: 'off',
    candidates: [],
  } });
  const tools2 = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: homeOff.transport as never }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const out2 = await tools2.execute('memory_recall', { __tool_call_id: 'c2', query: 'q' }, CTX);
  assert.equal(out2.ok, false);
  assert.equal((out2.output as Record<string, unknown>).error_code, 'RECALL_ENVELOPE_INVALID');
  assert.deepEqual((out2.output as Record<string, unknown>).missing_fields, ['pagination'], 'off 首页缺 pagination 如实披露');
  db.close();
});

test('bc：conversation_read 中文整条真字节预算；跳过行续页可达', async () => {
  const { HostToolExecutor } = await import('../../apps/host/src/runtime/host-tools.ts');
  const { MariposaClient } = await import('../../apps/host/src/integrations/mariposa/client.ts');
  const { RotationReviewService } = await import('../../apps/host/src/context/rotation-review.ts');
  const { HoldCheckpointService } = await import('../../apps/host/src/memory/hold-checkpoint.ts');
  const { db } = freshDb(tempRoot('wp4-bc-'));
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private','2026-01-01')").run();
  // 中文整条：5000 字（旧字符口径 ≈5000 单位 <16000 会误过；真字节 15000+400 边界内）
  const zh = '窗'.repeat(5000);
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m1','c1',1,'owner','text',1,'2026-01-01','2026-01-01')").run();
  db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('m1',1,'text',?,?,'2026-01-01','2026-01-01','seed')").run(zh, sha256Hex(zh));
  // 第二条中文整条：9000 字=27000B > 16000 → 必分片/顺延（旧口径 9000<16000 会误整条）
  const zh2 = '帘'.repeat(9000);
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES ('m2','c1',2,'owner','text',1,'2026-01-01','2026-01-01')").run();
  db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('m2',1,'text',?,?,'2026-01-01','2026-01-01','seed')").run(zh2, sha256Hex(zh2));
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: async () => ({ ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 }) }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const CTX = { roomId: 'c1', windowId: 'w1', turnId: null, purpose: 'chat' as const, activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: 'r' };
  const out = await tools.execute('conversation_read', { __tool_call_id: 'c1', around_seq: 1, before: 1, after: 1 }, CTX);
  assert.equal(out.ok, true);
  const blob = Buffer.byteLength(JSON.stringify((out.output as Record<string, unknown>).entries ?? []), 'utf8');
  assert.ok(blob <= 16000 + 2400, `整页出站按真字节有界（实际 ${blob}B）`);
  // 二次回访（字节单口径）：5000 字≈15.2KB 能整装空页 → 首页整条交付
  // m1；9000 字≈27KB 超整页 → 顺延后在续页分片（真字节口径生效）
  const entries = (out.output as { entries: Array<Record<string, unknown>>; newer_cursor?: Record<string, unknown> }).entries;
  const m1e = entries.find((e) => e.seq === 1) as { fragment?: unknown; text?: string } | undefined;
  assert.ok(m1e, '锚点 m1（seq 1）在首页（预留优先）');
  assert.equal(m1e.fragment, undefined, '5000 字整条交付（≤整页预算）');
  const fragPage = await tools.execute('conversation_read', { __tool_call_id: 'c2', cursor: (out.output as { newer_cursor: Record<string, unknown> }).newer_cursor }, CTX);
  assert.equal(fragPage.ok, true);
  const fragEntries = (fragPage.output as { entries: Array<Record<string, unknown>> }).entries;
  assert.ok(fragEntries.some((e) => e.fragment), '9000 字条目超整页预算在续页分片（真 UTF-8 字节口径）');
  db.close();
});

test('d/j2：PUT 形状门——invalid auto/latest 422；有效 model 零写入', async () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../../apps/host/src/server/http.ts'), 'utf8');
  // FU-002（回访 2026-10-09）：两字段单事务提交（setMany）——形状接线
  // 检查；真实 HTTP/事务原子断言在下方 FU-001/FU-002 测试
  assert.ok(src.includes('d.settings.setMany(writes)'), '两字段单事务写入（setMany）');
  assert.ok(src.includes('orModelIdIssue(nextModel)'), 'or_model 过配置层形状门');
  // RRA-016：真实判定行为断言（不依赖 HTTP Host 夹具——直测形状函数
  // 与 PUT 等价；orModelIdIssue 即 PUT 的 422 判据）
  const { orModelIdIssue } = await import('../../apps/host/src/config/schema.ts');
  assert.ok(orModelIdIssue('auto'), 'auto 拒（PUT→422 invalid_model）');
  assert.ok(orModelIdIssue('anthropic/claude-opus-latest'), 'latest 拒');
  assert.ok(orModelIdIssue('a,b,c'), '逗号拼单拒');
  assert.equal(orModelIdIssue('anthropic/claude-test-1'), null, '合法 ID 放行');
});

// ----------------- FU-001/FU-002（回访 run-035424）：设置 PUT 真实 HTTP/事务

async function hostWithSettings(driver = 'mock', orOver: Record<string, unknown> = {}) {
  const { Host } = await import('../../apps/host/src/app-context.ts');
  const { setModelMetaForTests, clearModelMetaCache } = await import('../../apps/host/src/runtime/runtime-settings.ts');
  clearModelMetaCache();
  const root = tempRoot('fu-settings-');
  writeApprovedIdentity(root);
  process.env.FU_AUDIT_OR_KEY = 'synthetic-not-real';
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: driver },
    openrouter: { model: 'anthropic/claude-audit-a', api_key_env: 'FU_AUDIT_OR_KEY', ...orOver },
  });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const url = `http://127.0.0.1:${host.port}/api/v1/runtime-settings`;
  return { host, url, headers, setModelMetaForTests, clearModelMetaCache };
}

test('真实 HTTP：Opus 4.6 元数据不可用仍只有四档，拒绝多余档位且零写入', async () => {
  const c = await hostWithSettings('openrouter', { model: 'anthropic/claude-opus-4.6' });
  try {
    c.setModelMetaForTests('anthropic/claude-opus-4.6', null);
    const view = await (await fetch(c.url, { headers: c.headers })).json();
    assert.deepEqual(view.effort_options, ['default', 'low', 'medium', 'high', 'max']);
    for (const effort of ['none', 'minimal', 'xhigh']) {
      const res = await fetch(c.url, { method: 'PUT', headers: c.headers, body: JSON.stringify({ reasoning_effort: effort }) });
      assert.equal(res.status, 422);
      assert.equal((await res.json()).error.code, 'effort_not_supported');
      assert.equal((await (await fetch(c.url, { headers: c.headers })).json()).reasoning_effort.override, null);
    }
    const valid = await fetch(c.url, { method: 'PUT', headers: c.headers, body: JSON.stringify({ reasoning_effort: 'medium' }) });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).reasoning_effort.override, 'medium');
  } finally { await c.host.stop(); c.clearModelMetaCache(); }
});

test('FU 对照：语法非法 effort 422 且 model 保持', async () => {
  const c = await hostWithSettings();
  try {
    const r = await fetch(c.url, { method: 'PUT', headers: c.headers, body: JSON.stringify({ or_model: 'anthropic/claude-audit-b', reasoning_effort: 'invalid-effort' }) });
    const after = await (await fetch(c.url, { headers: c.headers })).json();
    assert.equal(r.status, 422);
    assert.equal(after.or_model.effective, 'anthropic/claude-audit-a', '非法输入零写入');
  } finally {
    await c.host.stop();
    delete process.env.FU_AUDIT_OR_KEY;
  }
});

test('FU-001：组合换模型+档位按候选模型元数据校验（旧 A 支持不代表新 B 支持）', async () => {
  const c = await hostWithSettings('openrouter');
  try {
    c.setModelMetaForTests('anthropic/claude-audit-a', { supported_efforts: ['high'], mandatory: true });
    c.setModelMetaForTests('anthropic/claude-audit-b', { supported_efforts: ['low'], mandatory: true });
    const r = await fetch(c.url, { method: 'PUT', headers: c.headers, body: JSON.stringify({ or_model: 'anthropic/claude-audit-b', reasoning_effort: 'high' }) });
    assert.equal(r.status, 422, 'high 对候选模型 B 不支持——按候选配置拒绝');
    const after = await (await fetch(c.url, { headers: c.headers })).json();
    assert.equal(after.or_model.effective, 'anthropic/claude-audit-a', '拒绝后零写入（model 仍是 A）');
    const ok = await fetch(c.url, { method: 'PUT', headers: c.headers, body: JSON.stringify({ or_model: 'anthropic/claude-audit-b', reasoning_effort: 'low' }) });
    assert.equal(ok.status, 200, '对照：B+low（候选支持）通过');
  } finally {
    await c.host.stop();
    delete process.env.FU_AUDIT_OR_KEY;
    c.clearModelMetaCache();
  }
});

test('FU-002：第二字段写失败（trigger 拒绝）整体回滚——无半提交', async () => {
  const c = await hostWithSettings();
  try {
    c.host.db.exec("CREATE TRIGGER audit_reject_effort BEFORE INSERT ON runtime_settings WHEN NEW.key='reasoning_effort' BEGIN SELECT RAISE(ABORT,'AUDIT_SYNTHETIC_WRITE_FAILURE'); END;");
    const r = await fetch(c.url, { method: 'PUT', headers: c.headers, body: JSON.stringify({ or_model: 'anthropic/claude-audit-b', reasoning_effort: 'low' }) });
    assert.equal(r.status, 500, '写入失败如实 500');
    const after = await (await fetch(c.url, { headers: c.headers })).json();
    assert.equal(after.or_model.effective, 'anthropic/claude-audit-a', 'effort 写失败不得提交已换的 model（单事务回滚）');
  } finally {
    await c.host.stop();
    delete process.env.FU_AUDIT_OR_KEY;
  }
});

// --------------------------------------------------- B15 迁移 upTo 回归

test('B15：migrate(db, h, 17) 应用到 17 为止（迁移数组按版本升序）', async () => {
  const { migrate } = await import('../../apps/host/src/db/migrations.ts');
  const root = tempRoot('wp5-b15-');
  const db = openDatabase(path.join(root, 'data'));
  const r = migrate(db, sha256Hex, 17);
  assert.equal(r.applied.at(-1), 17, '最后应用=17');
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
  assert.equal(v.v, 17, 'schema 停在 17');
  // 表形状：17 有 context_selections、无 18 daily_digests DROP/19 runtime_settings
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  assert.ok(has('context_selections'), 'v17 表在');
  assert.ok(!has('runtime_settings'), 'v19 表不在');
  db.close();
});


// ------------------------------------------- RRA-014 回读交付前沿

test('RRA-014：range 尾页跳过行续页可达；older 交付前沿不重复', async () => {
  const { HostToolExecutor } = await import('../../apps/host/src/runtime/host-tools.ts');
  const { MariposaClient } = await import('../../apps/host/src/integrations/mariposa/client.ts');
  const { RotationReviewService } = await import('../../apps/host/src/context/rotation-review.ts');
  const { HoldCheckpointService } = await import('../../apps/host/src/memory/hold-checkpoint.ts');
  const { db } = freshDb(tempRoot('rra014-'));
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private','2026-01-01')").run();
  // 10 条 ~3000 中文：range 10 装不完整页（真字节预算），跳过行须续页可达
  for (let i = 1; i <= 10; i++) {
    const body = `消息${i}号正文` + '长内容'.repeat(750);
    db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, published_at, created_at) VALUES (?,?,?,'owner','text',1,'2026-01-01','2026-01-01')").run(`m${i}`, 'c1', i);
    db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,?,'2026-01-01','2026-01-01','seed')").run(`m${i}`, body, sha256Hex(body));
  }
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: async () => ({ ok: false, code: 'X', httpStatus: 404 }) }), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const CTX = { roomId: 'c1', windowId: 'w1', turnId: null, purpose: 'chat' as const, activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: 'r' };
  // range 1..10 翻尽：全部 10 条都到
  const seenIds = new Set<string>();
  let cursor: Record<string, unknown> | null = null;
  let pages = 0;
  do {
    const out = await tools.execute('conversation_read', {
      __tool_call_id: `c${pages}`,
      ...(cursor ? { cursor } : { from_sequence: 1, to_sequence: 10 }) } as never, CTX);
    assert.equal(out.ok, true, JSON.stringify(out.output).slice(0, 200));
    for (const e of (out.output as { entries: Array<{ seq?: number }> }).entries) {
      if (e.seq) seenIds.add(e.seq);
    }
    const o = out.output as { has_more?: boolean; next_cursor?: Record<string, unknown> | null };
    cursor = o.has_more ? o.next_cursor! : null;
    pages += 1;
    assert.ok(pages < 30, 'range 不收敛');
  } while (cursor);
  assert.equal(seenIds.size, 10, `range 翻尽须覆盖全部 10 条（实际 ${seenIds.size}）——跳过行续页可达（RRA-014）`);
  // older 交付前沿：向更早翻页不重复交付（RRA-014 回访 2026-10-09 语义：
  // 长行可分片跨页续取——同消息多片=渐进交付，非重复；断言片区间
  // 不重叠 + 拼回覆盖全文）
  const bodies = new Map<string, string>();
  for (let i = 1; i <= 10; i++) bodies.set(`m${i}`, `消息${i}号正文` + '长内容'.repeat(750));
  const olderParts = new Map<string, Array<{ start: number; end: number; text: string }>>();
  const addRange = (id: string, start: number, end: number, text: string) => {
    const parts = olderParts.get(id) ?? [];
    for (const p of parts) {
      assert.ok(start >= p.end || end <= p.start, `older 翻页重叠交付 ${id}（${start}-${end} 与 ${p.start}-${p.end}）`);
    }
    parts.push({ start, end, text });
    olderParts.set(id, parts);
  };
  let oc: Record<string, unknown> | null = { older_than: 11 };
  pages = 0;
  do {
    const out = await tools.execute('conversation_read', {
      __tool_call_id: `o${pages}`, cursor: oc } as never, CTX);
    assert.equal(out.ok, true);
    for (const e of (out.output as { entries: Array<{ seq?: number; text?: string; fragment?: { start_char?: number; end_char?: number } }> }).entries) {
      if (!e.seq) continue;
      const fr = e.fragment;
      if (fr && typeof fr.start_char === 'number' && typeof fr.end_char === 'number') {
        addRange(`m${e.seq}`, fr.start_char, fr.end_char, e.text ?? '');
      } else {
        addRange(`m${e.seq}`, 0, [...(e.text ?? '')].length, e.text ?? '');
      }
    }
    const o = out.output as { has_more?: unknown; next_cursor?: Record<string, unknown> | null };
    oc = o.has_more ? o.next_cursor! : null;
    pages += 1;
    assert.ok(pages < 30, 'older 不收敛');
  } while (oc);
  assert.equal(olderParts.size, 10, 'older 翻尽覆盖全部');
  for (const [id, parts] of olderParts) {
    parts.sort((a, b) => a.start - b.start);
    const body = bodies.get(id)!;
    assert.equal(parts[0].start, 0, `${id} 从 0 起`);
    for (let k = 1; k < parts.length; k++) {
      assert.equal(parts[k - 1].end, parts[k].start, `${id} 分片区间首尾相接（无缺无重）`);
    }
    assert.equal(parts[parts.length - 1].end, [...body].length, `${id} 末片抵达全文长度`);
    assert.equal(parts.map((p) => p.text).join(''), body, `${id} 实际正文逐字精确拼回（非等长覆盖）`);
  }
  db.close();
});

test('FU-001（二次回访）：null/default 清除回落配置默认的组合也按候选生效对校验', async () => {
  // 配置：默认模型 A（仅 high）、默认档位 high；B 仅 low。
  const c = await hostWithSettings('openrouter', { reasoning: { effort: 'high' } });
  try {
    c.setModelMetaForTests('anthropic/claude-audit-a', { supported_efforts: ['high'], mandatory: true });
    c.setModelMetaForTests('anthropic/claude-audit-b', { supported_efforts: ['low'], mandatory: true });
    // 建立状态：override B+low（合法组合 200）
    const setup = await fetch(c.url, { method: 'PUT', headers: c.headers, body: JSON.stringify({ or_model: 'anthropic/claude-audit-b', reasoning_effort: 'low' }) });
    assert.equal(setup.status, 200);
    // 红例1：or_model:null（清模型回落 A）+ 保留 low —— (A,low) 不支持 → 422 零写入
    const r1 = await fetch(c.url, { method: 'PUT', headers: c.headers, body: JSON.stringify({ or_model: null }) });
    assert.equal(r1.status, 422, '清模型回落 A 后候选对 (A,low) 不支持——必须拒绝（此前 200）');
    const after1 = await (await fetch(c.url, { headers: c.headers })).json();
    assert.equal(after1.or_model.override, 'anthropic/claude-audit-b', '拒绝后零写入（override 保持 B）');
    assert.equal(after1.reasoning_effort.override, 'low');
    // 红例2：reasoning_effort:null（清档位回落配置默认 high）+ override B —— (B,high) 不支持 → 422 零写入
    const r2 = await fetch(c.url, { method: 'PUT', headers: c.headers, body: JSON.stringify({ reasoning_effort: null }) });
    assert.equal(r2.status, 422, '清档位回落配置默认 high 后候选对 (B,high) 不支持——必须拒绝（此前 200）');
    const after2 = await (await fetch(c.url, { headers: c.headers })).json();
    assert.equal(after2.reasoning_effort.override, 'low', '拒绝后零写入（override 保持 low）');
    // 对照：双清（回落 A+high，配置原生组合）→ 200
    const okBoth = await fetch(c.url, { method: 'PUT', headers: c.headers, body: JSON.stringify({ or_model: null, reasoning_effort: null }) });
    assert.equal(okBoth.status, 200, '双清回落配置默认 (A,high) 合法');
  } finally {
    await c.host.stop();
    delete process.env.FU_AUDIT_OR_KEY;
    c.clearModelMetaCache();
  }
});
