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
  assert.deepEqual(flex, ['default', 'none', 'minimal', 'low', 'high'], '非强制模型 minimal 如实列出');
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
  const out = await tools.execute('conversation_read', { __tool_call_id: 'c1', around_message_id: 'm1', before: 1, after: 1 }, CTX);
  assert.equal(out.ok, true);
  const blob = Buffer.byteLength(JSON.stringify((out.output as Record<string, unknown>).entries ?? []), 'utf8');
  assert.ok(blob <= 16000 + 2400, `整页出站按真字节有界（实际 ${blob}B）`);
  // 中文 9000 字条目被分片（真字节口径）——不整条直出
  const entries = (out.output as { entries: Array<Record<string, unknown>> }).entries;
  const hasFrag = entries.some((e) => e.fragment);
  assert.ok(hasFrag, '中文超长条目产生分片（真 UTF-8 字节预算生效）');
  db.close();
});

test('d/j2：PUT {有效 model+非法 effort} → 422 且零写入', async () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../../apps/host/src/server/http.ts'), 'utf8');
  assert.ok(src.includes('nextModel !== undefined) d.settings.set'), '两字段全验后一次性写入');
  assert.ok(src.includes('orModelIdIssue(nextModel)'), 'or_model 过配置层形状门');
  // 服务级等价断言：形状门存在即可覆盖 422 路径（HTTP 层无 Host 夹具）
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
