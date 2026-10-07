#!/usr/bin/env node
// F-J-11（联合审计 2026-10-06）+ R04（复审 2026-10-07 根因返修）：outbox 受控恢复入口。
//
// 背景：归档批被判 dead 后无恢复路径——一条 dead 级联卡死同流后续消息。
// R04 反例：真实失败同时留下 failed outbox 行**和** dead ingest_batch；旧脚本只把
// outbox 行改 pending，批仍 dead——下次 drain 在冻结批恢复阶段看见 dead 批直接把行
// 打回 failed（BATCH_DEAD），连远端请求都不发（"已重排 1 行"复活了个寂寞）。
//
// 根因修复：**以冻结 batch 为恢复一致性单位**——批 dead→in_flight 与其全部成员行
// failed→pending 在同一事务原子生效；校验死因/成员集合完整性；保留原 operation_id、
// payload、来源顺序与尝试计数（不重置计数掩盖故障、不清 batch_id 不换 key 绕幂等）。
// 恢复后的实际重发走既有 drainOnce（冻结 payload+同 op，服务端幂等）。
//
// 用法：
//   node scripts/outbox-requeue.mjs                       # dry-run：列出各房间 failed/dead/unknown 与 dead 批
//   node scripts/outbox-requeue.mjs --apply --conversation primary
//   ESTOMAGO_HOME=<根> node scripts/outbox-requeue.mjs --apply --conversation primary [--limit 3]
//                                                          # --limit=最多复活的批数（不含散行）
//
// 边界：
//   - unknown_outcome 行**不自动重排**（结果不明须按原 op 核实，脚本只列出）
//   - attempt ≥ 10 的行 / attempts ≥ 10 的批跳过并醒目列出——复活也会立即再次
//     TRANSIENT_EXHAUSTED/dead，需人工处理
//   - 批成员状态混合（含 sent/unknown_outcome/acked）→ 跳过：结果不明须对账，不冒充可恢复
//   - 批 state=acked → 跳过：服务端已确认，drain 对账路径自会把行标 acked，不重发
//   - 孤儿行（batch_id 指向不存在的批记录）→ 跳过并醒目列出（本地证据不完整）
//   - 散行（无 batch_id，如手工修复残留）按行重排，走 drain 新批阶段
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const convArg = (() => { const i = args.indexOf('--conversation'); return i >= 0 ? args[i + 1] : null; })();
const limitArg = (() => { const i = args.indexOf('--limit'); return i >= 0 ? Number(args[i + 1]) : Infinity; })();
const home = process.env.ESTOMAGO_HOME ?? path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const dbPath = path.join(home, 'data', 'chat.sqlite3');
if (!fs.existsSync(dbPath)) {
  console.error(`[outbox-requeue] 找不到库：${dbPath}（用 ESTOMAGO_HOME 指定根）`);
  process.exit(2);
}
const MAX_ATTEMPTS = 10; // 与 archive-sync INGEST_BATCH_MAX_ATTEMPTS 同值（有界重试）
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL;');

const rows = db.prepare(`
  SELECT o.id, o.operation_key, o.state, o.attempt, o.last_error, o.created_at, o.batch_id,
         CASE WHEN json_valid(o.payload_ref) THEN json_extract(o.payload_ref, '$.message_id') END AS message_id
  FROM outbox o
  LEFT JOIN messages m ON m.id = CASE WHEN json_valid(o.payload_ref) THEN json_extract(o.payload_ref, '$.message_id') END
  WHERE o.target = 'mariposa.archive' AND o.state IN ('failed','unknown_outcome')
  ORDER BY m.conversation_id, o.created_at
`).all();

const byConv = new Map();
for (const r of rows) {
  const conv = (db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(r.message_id)?.conversation_id) ?? '(未知房间)';
  if (!byConv.has(conv)) byConv.set(conv, []);
  byConv.get(conv).push(r);
}

console.log(`[outbox-requeue] ${apply ? 'APPLY' : 'DRY-RUN'} 根=${home}`);
if (byConv.size === 0) { console.log('  无 failed/dead/unknown 行。'); process.exit(0); }
const deadBatches = db.prepare(`
  SELECT b.operation_id, b.conversation_id, b.attempts, b.last_error,
         (SELECT COUNT(*) FROM outbox o WHERE o.batch_id = b.operation_id) AS members,
         (SELECT COUNT(*) FROM outbox o WHERE o.batch_id = b.operation_id AND o.state = 'failed') AS failed_members
  FROM ingest_batches b WHERE b.state = 'dead' ORDER BY b.created_at
`).all();
for (const [conv, list] of byConv) {
  const failed = list.filter((r) => r.state === 'failed');
  const unknown = list.filter((r) => r.state === 'unknown_outcome');
  console.log(`房间 ${conv}：failed ${failed.length}、unknown_outcome ${unknown.length}`);
  for (const r of failed.slice(0, 5)) console.log(`  ${r.state} attempt=${r.attempt} ${r.operation_key} 批=${r.batch_id ?? '（散行）'} 最后错误=${r.last_error ?? ''} ${r.created_at}`);
  const convDead = deadBatches.filter((b) => b.conversation_id === conv);
  for (const b of convDead) console.log(`  dead 批 ${b.operation_id.slice(0, 24)}… attempts=${b.attempts} 成员=${b.members}（failed ${b.failed_members}）死因=${b.last_error ?? ''}`);
  if (unknown.length > 0) console.log(`  ⚠ unknown_outcome ${unknown.length} 行不自动重排（结果不明，按原 op 核实或由 drain 恢复路径处理）`);
}

if (!apply) {
  console.log('\n[outbox-requeue] dry-run 结束（未改动）。执行：--apply --conversation <房间id>');
  process.exit(0);
}
if (!convArg) { console.error('[outbox-requeue] --apply 需要 --conversation <房间id>'); process.exit(2); }

const failedRows = (byConv.get(convArg) ?? []).filter((r) => r.state === 'failed').sort((a, b) => a.created_at < b.created_at ? -1 : 1);
const skippedRows = failedRows.filter((r) => r.attempt >= MAX_ATTEMPTS);
const candidates = failedRows.filter((r) => r.attempt < MAX_ATTEMPTS);
for (const r of skippedRows) console.log(`  ⏭ 跳过（attempt=${r.attempt} 已达上限）：${r.operation_key}——需人工处理，不重置计数掩盖故障`);

const unbound = candidates.filter((r) => !r.batch_id);
const boundByBatch = new Map();
for (const r of candidates) {
  if (!r.batch_id) continue;
  const list = boundByBatch.get(r.batch_id) ?? [];
  list.push(r);
  boundByBatch.set(r.batch_id, list);
}

// 逐批校验并收集原子复活动作（按批内最早成员 created_at 升序——先解最早阻断）
const batchActions = [];
const orphanRows = [];
for (const [bid, list] of [...boundByBatch.entries()].sort((a, b) => {
  const ta = a[1][0] ? a[1][0].created_at : '';
  const tb = b[1][0] ? b[1][0].created_at : '';
  return ta < tb ? -1 : ta > tb ? 1 : 0;
})) {
  const b = db.prepare('SELECT operation_id, state, attempts, last_error FROM ingest_batches WHERE operation_id = ?').get(bid);
  if (!b) { orphanRows.push(...list); continue; }
  if (b.state === 'acked') { console.log(`  ⏭ 批 ${bid.slice(0, 24)}… state=acked：服务端已确认，行由 drain 对账标 acked，不重发`); continue; }
  if (b.state === 'in_flight') { batchActions.push({ bid, reviveBatch: false, rows: list }); continue; }
  const members = db.prepare('SELECT state FROM outbox WHERE batch_id = ?').all(bid).map((m) => m.state);
  const mixed = members.filter((s) => s !== 'failed');
  if (mixed.length > 0) {
    console.log(`  ⏭ 批 ${bid.slice(0, 24)}… 成员状态混合（${mixed.join(',')}）：结果不明须人工对账，不冒充可恢复`);
    continue;
  }
  if (b.attempts >= MAX_ATTEMPTS) {
    console.log(`  ⏭ 批 ${bid.slice(0, 24)}… attempts=${b.attempts} 已达上限（死因=${b.last_error ?? ''}）：复活也会立即再次 dead，需人工处理`);
    continue;
  }
  batchActions.push({ bid, reviveBatch: true, rows: list, reason: b.last_error ?? '' });
}
for (const r of orphanRows) console.log(`  ⏭ 孤儿行（批记录缺失）：${r.operation_key}——本地证据不完整，跳过`);

const revivedBatches = batchActions.filter((a) => a.reviveBatch);
const batchLimited = Number.isFinite(limitArg) ? batchActions.slice(0, limitArg) : batchActions;
const limitedOut = batchActions.length - batchLimited.length;
if (limitedOut > 0) console.log(`  ⏭ --limit=${limitArg}：留待下次 ${limitedOut} 批`);
if (batchLimited.length === 0 && unbound.length === 0) { console.log('  无可恢复项。'); process.exit(0); }

const tx = db.prepare('BEGIN IMMEDIATE');
tx.run();
try {
  const updRow = db.prepare("UPDATE outbox SET state = 'pending', updated_at = ? WHERE id = ? AND state = 'failed'");
  const reviveBatch = db.prepare("UPDATE ingest_batches SET state = 'in_flight', updated_at = ? WHERE operation_id = ? AND state = 'dead'");
  const now = new Date().toISOString();
  let rowN = 0;
  for (const r of unbound) rowN += updRow.run(now, r.id).changes;
  let batchN = 0, batchRowN = 0;
  for (const a of batchLimited) {
    if (a.reviveBatch && reviveBatch.run(now, a.bid).changes !== 1) throw new Error(`批 ${a.bid} 复活失败（state 已变）`);
    if (a.reviveBatch) batchN++;
    for (const r of a.rows) { const c = updRow.run(now, r.id).changes; rowN += c; batchRowN += c; }
  }
  db.prepare('COMMIT').run();
  if (batchN > 0) console.log(`\n[outbox-requeue] 已原子复活批 ${batchN} 个（批 dead→in_flight + 成员行 ${batchRowN} 条 failed→pending，同事务；operation_id/payload/顺序/attempt 计数全保留）。`);
  if (rowN - batchRowN > 0) console.log(`[outbox-requeue] 已重排散行 ${rowN - batchRowN} 行（无批次归属，走 drain 新批阶段）。`);
  console.log('  恢复发送由既有 drain 触发（下次消息提交或服务重启）；冻结 payload+同 op，服务端幂等。');
} catch (err) {
  db.prepare('ROLLBACK').run();
  console.error('[outbox-requeue] 事务失败已回滚：', err.message);
  process.exit(1);
}
