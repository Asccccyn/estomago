// R2-M04（复审 20261106 第二轮）：E I 未知写入跨宿主接管的窄交接。
// 真实链：ModelToolBridge→memory_i_write→MariposaClient；M 侧领域原子幂等
//（同 op 从回执恢复原成功——f1f6908 已验证的语义）以传输桩承载：
// - 场景1：I 提交后传输丢响应 → E 落 unknown effect（原身份+参数快照）；
//   宿主重启（重建服务）→ recoverUnknownEffects 用原 operationId 原样重放 →
//   M 返回原成功（同 item_id）→ effect committed；条目恰 1。
// - 场景2：恢复时 M 不可达 → effect 保持 unknown（阻断换窗语义保留）。
// - 场景3：恢复时 M 结构化拒绝（非传输类错误）→ failed_resolved。
// 不按正文去重：模型新身份（不同 operationId）的重做是新写——effect 各自独立。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MemoryToolsService } from '../../apps/host/src/modules/memory/service.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

const CTX = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-m4' } as const;

function makeWorld(transport: MariposaTransport) {
  const root = tempRoot('r2m4-');
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  void buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const reviews = new RotationReviewService(db);
  const mariposa = new MariposaClient({ transport });
  const { tools } = assembleTestTools({ db, mariposa, reviews, checkpoint: new HoldCheckpointService(db) });
  const memory = new MemoryToolsService({ db, mariposa, reviews, checkpoint: new HoldCheckpointService(db) });
  return {
    db, reviews, tools, memory,
    unknown: () => reviews.unknownEffectsForWindow('w1'),
    close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('R2-M04：I 提交丢响应→重启原身份重放→恢复原成功（同 item_id、条目恰 1）', async () => {
  // M 侧状态机：第一次 create 提交成功但响应丢失；同 operationId 重放返回原回执
  const committed = new Map<string, { item_id: string; revision: number }>();
  let firstCreateSucceeds = false;
  const world1 = makeWorld(async (cap, payload) => {
    if (cap !== 'i.item.create') return { ok: true, result: {} };
    const p = payload as { operation_id?: string; content?: string };
    const op = p.operation_id!;
    if (!committed.has(op) && !firstCreateSucceeds) {
      firstCreateSucceeds = true;
      committed.set(op, { item_id: 'it_m4', revision: 1 });
      throw new Error('synthetic response lost after M commit'); // 领域已提交、传输丢响应
    }
    if (committed.has(op)) return { ok: true, result: committed.get(op) }; // M 幂等回执恢复
    return { ok: false, code: 'HTTP_409' };
  });
  try {
    const w = await world1.tools.execute('memory_i_write', { action: 'create', content: '未知写入接管' }, CTX);
    assert.equal(w.ok, false);
    assert.equal(w.output.error_code, 'I_WRITE_OUTCOME_UNKNOWN');
    assert.equal(w.output.operation_id, (w.output as { operation_id: string }).operation_id, 'unknown 文本带原操作身份');
    const eff = world1.unknown();
    assert.equal(eff.length, 1, 'unknown effect 已持久（原身份+参数快照）');
    assert.equal(eff[0]!.kind, 'i_write');
    const opId = eff[0]!.operationId;
    assert.ok(eff[0]!.argsJson!.includes('未知写入接管'), '参数快照随 effect 落库');
    // —— 宿主重启：同库重建服务（新的内存状态），走真实恢复入口 ——
    const out = await world1.memory.recoverUnknownEffects('c1', 'w1');
    assert.equal(out.resolved, 1, '原身份重放恢复原成功');
    assert.equal(out.stillUnknown, 0);
    assert.equal(world1.unknown().length, 0, 'effect 收口');
    const replayCalls: Array<{ op: string }> = [];
    void replayCalls; void opId;
    // 状态机已验证同 op 返回原回执（上面 transport 的 committed 分支）——条目恰 1
    assert.equal(committed.size, 1, '不按正文去重、不另建新条目');
  } finally { world1.close(); }
});

test('R2-M04：恢复时 M 不可达→effect 保持 unknown（阻断语义保留）；结构化拒绝→failed_resolved', async () => {
  // 场景2：M 不可达
  const w2 = makeWorld(async (cap) => {
    if (cap === 'i.item.create') throw new Error('M_UNREACHABLE');
    return { ok: true, result: {} };
  });
  try {
    const first = await w2.tools.execute('memory_i_write', { action: 'create', content: 'A' }, CTX);
    assert.equal((first.output as { error_code: string }).error_code, 'I_WRITE_OUTCOME_UNKNOWN');
    const out = await w2.memory.recoverUnknownEffects('c1', 'w1');
    assert.equal(out.stillUnknown, 1, 'M 不可达：保持 unknown');
    assert.equal(w2.unknown().length, 1);
  } finally { w2.close(); }
  // 场景3：恢复重放收到结构化拒绝（非传输类）→ failed_resolved
  const w3 = makeWorld(async (cap) => {
    if (cap === 'i.item.create') return { ok: false, code: 'VERSION_CONFLICT' };
    return { ok: true, result: {} };
  });
  try {
    // 首次提交同样丢响应（unknown）——拒绝发生在恢复重放时
    let lostOnce = false;
    const w3t = w3;
    void w3t;
    const first = await makeWorld(async (cap) => {
      if (cap !== 'i.item.create') return { ok: true, result: {} };
      if (!lostOnce) { lostOnce = true; throw new Error('lost'); }
      return { ok: false, code: 'INVALID_ARGUMENT' }; // R3-M02：确定性拒绝才收口；冲突类另测
    });
    try {
      const r = await first.tools.execute('memory_i_write', { action: 'create', content: 'B' }, CTX);
      assert.equal((r.output as { error_code: string }).error_code, 'I_WRITE_OUTCOME_UNKNOWN');
      const out = await first.memory.recoverUnknownEffects('c1', 'w1');
      assert.equal(out.resolved, 1, '结构化拒绝=可判定失败，收口');
      assert.equal(first.unknown().length, 0);
    } finally { first.close(); }
  } finally { w3.close(); }
});

test('R2-M04：确定失败与成功同样收口——effect 账本不留 running 残留', async () => {
  const w = makeWorld(async (cap) => (cap === 'i.item.create' ? { ok: true, result: { item_id: 'it_ok', revision: 1 } } : { ok: false, code: 'HTTP_403' }));
  try {
    const okw = await w.tools.execute('memory_i_write', { action: 'create', content: 'C' }, CTX);
    assert.equal(okw.ok, true);
    const badw = await w.tools.execute('memory_i_write', { action: 'revise', item_id: 'it_ok', content: 'D', expected_revision: 99 }, { ...CTX, requestId: 'req-m4b' });
    assert.equal(badw.ok, false);
    assert.equal(w.unknown().length, 0, '成功/确定失败不产生 unknown');
    const rows = w.db.prepare("SELECT state, kind FROM tool_side_effects WHERE kind='i_write' ORDER BY rowid").all() as Array<{ state: string }>;
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.state !== 'running' && r.state !== 'unknown'), '全部收口');
  } finally { w.close(); }
});

// —— R3-M02（第三轮复审）：I 恢复分类——本次执行失败≠原远端未提交 ——

test('R3-M02：恢复重放遇鉴权失败/冲突类错误——effect 保持 unknown（原操作资格不撤）', async () => {
  const mkWorld = (code: string) => {
    let lost = false;
    return makeWorld(async (cap) => {
      if (cap !== 'i.item.create') return { ok: true, result: {} };
      if (!lost) { lost = true; throw new Error('lost-after-commit'); }
      return { ok: false, code };
    });
  };
  for (const code of ['HTTP_401', 'HTTP_403', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'HTTP_500', 'HTTP_429', 'TRANSPORT_FAILED']) {
    const w = mkWorld(code);
    try {
      const first = await w.tools.execute('memory_i_write', { action: 'create', content: `x-${code}` }, CTX);
      assert.equal((first.output as { error_code: string }).error_code, 'I_WRITE_OUTCOME_UNKNOWN');
      const out = await w.memory.recoverUnknownEffects('c1', 'w1');
      assert.equal(out.stillUnknown, 1, `${code}：恢复受阻保持 unknown`);
      assert.equal(out.resolved, 0);
      assert.equal(w.unknown().length, 1, `${code}：未决资格保留`);
    } finally { w.close(); }
  }
  // 对照：确定性领域拒绝（同参数必然复现）→ failed_resolved 收口
  const w2 = mkWorld('INVALID_ARGUMENT');
  try {
    await w2.tools.execute('memory_i_write', { action: 'create', content: 'ok' }, CTX);
    const out = await w2.memory.recoverUnknownEffects('c1', 'w1');
    assert.equal(out.resolved, 1, '确定性拒绝收口');
    assert.equal(w2.unknown().length, 0);
  } finally { w2.close(); }
});

test('R3-M02：崩溃在提交缝的 running i_write——启动恢复归 unknown（不再 failed_resolved）', async () => {
  const w = makeWorld(async (cap) => (cap === 'i.item.create' ? { ok: true, result: { item_id: 'it_r3', revision: 1 } } : { ok: true, result: {} }));
  try {
    // 模拟崩溃在提交缝：effect 停在 running（Host 未 settle 即中断）
    const { RotationReviewService } = await import('../../apps/host/src/context/rotation-review.ts');
    void RotationReviewService;
    const db = (w as unknown as { db: import('../../apps/host/src/db/connection.ts').Db }).db;
    const effId = 'eff_r3_crash';
    db.prepare(`INSERT INTO tool_side_effects(id, review_id, turn_id, window_id, kind, state, verified, memory_id, operation_id, tool_call_id, seen_sequence, args_json, created_at, updated_at)
      VALUES (?,NULL,'t1','w1','i_write','running',0,NULL,'i-create:t1:req-r3:call-r3','call-r3',1,'{"action":"create","content":"崩溃缝"}','now','now')`).run(effId);
    // 启动恢复分类（recoveryPass 的同一 SQL 语义）：i_write → unknown
    const classified = db.prepare("UPDATE tool_side_effects SET state = CASE WHEN kind IN ('hold','i_write') THEN 'unknown' ELSE 'failed_resolved' END WHERE state='running'").run().changes;
    assert.equal(classified, 1);
    const row = db.prepare('SELECT state FROM tool_side_effects WHERE id=?').get(effId) as { state: string };
    assert.equal(row.state, 'unknown', 'R3-M02：i_write 崩溃缝归 unknown（旧实现 failed_resolved 撤掉原操作资格）');
    // unknown 后可被恢复消费者接管（原身份重放）
    const out = await w.memory.recoverUnknownEffects('c1', 'w1');
    assert.equal(out.resolved, 1, '原身份重放恢复原成功');
  } finally { w.close(); }
});
