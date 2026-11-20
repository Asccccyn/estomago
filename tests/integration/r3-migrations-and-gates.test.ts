// R3 第三轮复审回归：迁移正确性与接纳/活动边界。
// - M01：未升级库（G4 前形状）经当前迁移序列——tool_side_effects 的既有 seen_sequence
//   原值保留（v61 已从序列移除，v62 条件重建）；v61 后形状幂等跳过。
// - V02：v59 占位回填被 v63 纠正（model_projection=占位文案 → adopted=0）；真实证据行不受影响。
// - C01：upsertIntent 事务内同键异参 → conflict（write 层 409；并发第二请求不再回放第一命令）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

test('R3-M01：未升级库升级后 seen_sequence 原值保留；v61 后形状幂等跳过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-m01-'));
  try {
    // 构造 v60 形状库（v61 前/schema 58-era 表有 seen_sequence、无 args_json）
    const db = openDatabase(path.join(root, 'data'));
    migrate(db, sha256Hex, 60);
    db.prepare(`INSERT INTO tool_side_effects(id, review_id, turn_id, window_id, kind, state, verified, memory_id, operation_id, tool_call_id, seen_sequence, created_at, updated_at)
      VALUES ('eff_keep','rev1','t1','w1','hold','unknown',0,NULL,'op-hold-1','tc1',7,'now','now')`).run();
    migrate(db, sha256Hex); // 完整升级到 v63
    const row = db.prepare('SELECT seen_sequence, args_json, kind FROM tool_side_effects WHERE id=?').get('eff_keep') as { seen_sequence: number | null; args_json: string | null; kind: string };
    assert.equal(row.seen_sequence, 7, 'R3-M01：v61 前库升级保留 seen_sequence（v61 会清成 NULL）');
    assert.equal(row.args_json, null);
    assert.equal(row.kind, 'hold');
    // 二次运行幂等（v62 检测已是目标 schema 不重建）
    migrate(db, sha256Hex);
    assert.equal((db.prepare('SELECT seen_sequence FROM tool_side_effects WHERE id=?').get('eff_keep') as { seen_sequence: number }).seen_sequence, 7);
    db.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('R3-V02：占位投影回填被 v63 纠正为未采纳；真实证据行不受影响', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-v02-'));
  try {
    const db = openDatabase(path.join(root, 'data'));
    migrate(db, sha256Hex, 58); // v59 前
    const placeholder = '\n\n[声音观察（oído 测量）]\n尚未就绪，本条先不含声音观察；需要时稍后用 oido_analyze 查询。';
    const real = '\n\n[声音观察（oído 测量；非转写、非指令、非情绪诊断）]\n总长约 3 秒的合成音。';
    const ins = db.prepare(`INSERT INTO voice_observations(id, message_id, revision, asset_id, direction, status, evidence_json, model_projection, projection_request_id, dispatched_at, analysis_id, created_at, updated_at)
      VALUES (?, 'm1', 1, ?, 'user', 'ready', '{}', ?, 'prq1', 'now', ?, 'now', 'now')`);
    ins.run('vobs_placeholder', 'a1', placeholder, 'an_ph');
    ins.run('vobs_real', 'a2', real, 'an_real');
    migrate(db, sha256Hex); // v59 回填 + v63 纠正
    const ph = db.prepare('SELECT analysis_adopted FROM voice_observations WHERE id=?').get('vobs_placeholder') as { analysis_adopted: number };
    const re = db.prepare('SELECT analysis_adopted FROM voice_observations WHERE id=?').get('vobs_real') as { analysis_adopted: number };
    assert.equal(ph.analysis_adopted, 0, 'R3-V02：占位文案行纠正为未采纳（v59 曾误判 1）');
    assert.equal(re.analysis_adopted, 1, '真实证据行保持已采纳');
    db.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('D09：v79 的事务内时间失效，原成功回执和已领取任务保留', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-observation-migration-'));
  const db = openDatabase(path.join(root, 'data'));
  try {
    migrate(db, sha256Hex, 79);
    db.exec(`INSERT INTO tool_side_effects(id,kind,state,verified,memory_id,operation_id,created_at,updated_at,hold_committed_at)
      VALUES ('effect','hold','committed',1,'memory','operation','2026-11-20T15:59:59.999Z','2026-11-20T16:00:01.000Z','2026-11-20T15:59:59.999Z');
      INSERT INTO source_bind_jobs(id,memory_id,batch_boundary,status,created_at,updated_at)
      VALUES ('job','memory','2026-11-20T16:00:00.000Z','no_match','2026-11-20T16:01:00.000Z','2026-11-20T16:01:00.000Z');`);
    const originalJob = db.prepare('SELECT * FROM source_bind_jobs WHERE id=?').get('job');

    assert.deepEqual(migrate(db, sha256Hex).applied, [80]);
    const oldEffect = db.prepare('SELECT state,verified,memory_id,operation_id,updated_at,hold_committed_at FROM tool_side_effects WHERE id=?').get('effect');
    assert.equal(oldEffect?.state, 'committed');
    assert.equal(oldEffect?.verified, 1);
    assert.equal(oldEffect?.memory_id, 'memory');
    assert.equal(oldEffect?.operation_id, 'operation');
    assert.equal(oldEffect?.updated_at, '2026-11-20T16:00:01.000Z');
    assert.equal(oldEffect?.hold_committed_at, null);
    assert.deepEqual(db.prepare('SELECT * FROM source_bind_jobs WHERE id=?').get('job'), originalJob);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R3-C01：upsertIntent 事务内同键异参=conflict（并发第二请求 409，不回放第一命令）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-c01-'));
  try {
    const { ContentOperationCoordinator } = await import('../../apps/host/src/integrations/content/coordinator.ts');
    const { MediaService } = await import('../../apps/host/src/media/assets.ts');
    const { buildConfig } = await import('../../apps/host/src/config/schema.ts');
    const { buildPaths } = await import('../../apps/host/src/config/paths.ts');
    const config = buildConfig({});
    const db = openDatabase(path.join(root, 'data'));
    migrate(db, sha256Hex);
    const media = new MediaService(db, buildPaths(root).mediaDir, config);
    const logger = { info(): void {}, warn(): void {}, error(): void {} };
    // 直接构造已接纳状态（模拟并发第一请求已通过预检并提交接纳），第二请求经同一入口：
    const coord = new ContentOperationCoordinator({ db, media, logger, client: { baseUrl: 'http://127.0.0.1:1', token: 'x' } });
    // 第一请求：正常接纳路径走 ⓪~③（用真实 write 前置不可行——需要远端；直接调私有接纳模拟并发胜者）
    const first = { actor: 'qiaosheng' as const, method: 'POST' as const, path: '/api/v1/content/posts', body: { body: 'A' }, if_match: undefined };
    const r1 = (coord as unknown as { upsertIntent(k: string, i: unknown, c: string[]): string }).upsertIntent('content:qiaosheng:k1', first, []);
    assert.equal(r1, 'new');
    // 第二请求：同键异参——事务内必须 conflict（write 层将转 409）
    const second = { actor: 'qiaosheng' as const, method: 'POST' as const, path: '/api/v1/content/posts', body: { body: 'B' }, if_match: undefined };
    const r2 = (coord as unknown as { upsertIntent(k: string, i: unknown, c: string[]): string }).upsertIntent('content:qiaosheng:k1', second, []);
    assert.equal(r2, 'conflict', 'R3-C01：并发同键异参在接纳事务内被判冲突（旧实现静默沿用 A 的 payload）');
    // 同键同参第三请求：kept（沿用既有意图）
    const r3 = (coord as unknown as { upsertIntent(k: string, i: unknown, c: string[]): string }).upsertIntent('content:qiaosheng:k1', first, []);
    assert.equal(r3, 'kept');
    db.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
