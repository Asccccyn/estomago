#!/usr/bin/env node
// F-J-11（联合审计 2026-10-06）：outbox 受控恢复入口（默认 dry-run）。
//
// 背景：归档批被判 dead 后无任何重排队路径——一条 dead 级联卡死同流后续消息
// （前驱缺失 SOURCE_NOT_READY 循环至 attempts 耗尽）。本脚本只改本地 outbox
// 状态（failed/dead → pending），不直连 mariposa、不碰凭据/消息顺序/原文修订；
// 恢复后的实际重发走既有 drainOnce（冻结 payload+同 op，服务端幂等）。
//
// 用法：
//   node scripts/outbox-requeue.mjs                       # dry-run：列出各房间 failed/dead/unknown
//   node scripts/outbox-requeue.mjs --apply --conversation primary
//   ESTOMAGO_HOME=<根> node scripts/outbox-requeue.mjs --apply --conversation primary [--limit 20]
//
// 边界：
//   - unknown_outcome 行**不自动重排**（结果不明须按原 op 核实，脚本只列出）
//   - attempt ≥ 10（有界上限）的行跳过并醒目列出——不重置计数掩盖故障
//   - 按房间分组、created_at 升序重排（先解最早阻断的前驱，后续顺序恢复）
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
  SELECT o.id, o.operation_key, o.state, o.attempt, o.last_error, o.created_at,
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
for (const [conv, list] of byConv) {
  const failed = list.filter((r) => r.state === 'failed');
  const unknown = list.filter((r) => r.state === 'unknown_outcome');
  console.log(`房间 ${conv}：failed ${failed.length}、unknown_outcome ${unknown.length}`);
  for (const r of failed.slice(0, 5)) console.log(`  ${r.state} attempt=${r.attempt} ${r.operation_key} 最后错误=${r.last_error ?? ''} ${r.created_at}`);
  if (unknown.length > 0) console.log(`  ⚠ unknown_outcome ${unknown.length} 行不自动重排（结果不明，按原 op 核实或由 drain 恢复路径处理）`);
}

if (!apply) {
  console.log('\n[outbox-requeue] dry-run 结束（未改动）。执行：--apply --conversation <房间id>');
  process.exit(0);
}
if (!convArg) { console.error('[outbox-requeue] --apply 需要 --conversation <房间id>'); process.exit(2); }
const list = (byConv.get(convArg) ?? []).filter((r) => r.state === 'failed').sort((a, b) => a.created_at < b.created_at ? -1 : 1);
const skipped = list.filter((r) => r.attempt >= MAX_ATTEMPTS);
const targets = list.filter((r) => r.attempt < MAX_ATTEMPTS).slice(0, Number.isFinite(limitArg) ? limitArg : Infinity);
for (const r of skipped) console.log(`  ⏭ 跳过（attempt=${r.attempt} 已达上限）：${r.operation_key}——需人工处理，不重置计数掩盖故障`);
if (targets.length === 0) { console.log('  无可重排行。'); process.exit(0); }
const tx = db.prepare('BEGIN IMMEDIATE');
tx.run();
try {
  const upd = db.prepare("UPDATE outbox SET state = 'pending', updated_at = ? WHERE id = ? AND state = 'failed'");
  let n = 0;
  for (const r of targets) n += upd.run(new Date().toISOString(), r.id).changes;
  db.prepare('COMMIT').run();
  console.log(`\n[outbox-requeue] 已重排 ${n} 行（${convArg}，created_at 升序；attempt 计数保留）。`);
  console.log('  恢复发送由既有 drain 触发（下次消息提交或服务重启）；冻结 payload+同 op，服务端幂等。');
} catch (err) {
  db.prepare('ROLLBACK').run();
  console.error('[outbox-requeue] 事务失败已回滚：', err.message);
  process.exit(1);
}
