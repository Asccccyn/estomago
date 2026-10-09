#!/usr/bin/env node
// WP-04（JFA-E01）：本地库增长有界化——手动维护入口（默认手动/她批的
// 定时执行，不新建常驻服务）。prune 是破坏性维护动作：生产首次执行
// 列她批准清单。
// 用法：ESTOMAGO_HOME=<state> node scripts/prune.mjs [--keep-days 30] [--keep-windows 5] [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] && /^\d+$/.test(args[i + 1]) ? Number(args[i + 1]) : d;
};
const keepWindows = opt('keep-windows', 5);
const keepDays = opt('keep-days', 30);

const stateRoot = process.env.ESTOMAGO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const dbFile = path.join(stateRoot, 'data', 'chat.sqlite3');
if (!fs.existsSync(dbFile)) {
  console.error(`[prune] 数据库不存在：${dbFile}`);
  process.exit(1);
}
const db = new DatabaseSync(dbFile);

// 与 apps/host/src/runtime/prune.ts 同判（脚本独立实现——不拉 TS 运行时）
// RRA-022（2026-10-09 复审）：dry-run 与真实执行同一筛选谓词（同一
// cutoff）——预览=将执行集合，只差写入；此前 dryRun 用 0 天夸大清理
const cutoff = new Date(Date.now() - keepDays * 24 * 3600 * 1000).toISOString();
const fresh = db.prepare('SELECT id FROM windows ORDER BY updated_at DESC LIMIT ?').all(keepWindows) || [];
const freshIds = fresh.map((r) => r.id);
const ph = freshIds.length > 0 ? freshIds.map(() => '?').join(',') : "''";

const payloadTargetRow = db.prepare(
  `SELECT COUNT(*) AS n FROM provider_requests WHERE payload_json IS NOT NULL
     AND window_id IN (SELECT id FROM windows WHERE status = 'CLOSED' AND updated_at < ?)
     AND window_id NOT IN (${ph})`,
).get(cutoff, ...freshIds);
const payloadTarget = payloadTargetRow ? (payloadTargetRow.n ?? 0) : 0;
const eventRows = db.prepare('SELECT COUNT(*) AS n FROM runtime_stream_events WHERE occurred_at < ?').get(new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString());
const eventRowsN = eventRows ? (eventRows.n ?? 0) : 0;
void payloadTarget;

if (dryRun) {
  console.log(`[prune] dry-run：将清 payload_json ${payloadTarget ?? 0} 行；删事件 ~${eventRowsN} 行（keep_windows=${keepWindows}, keep_days=${keepDays}；事件固定 90 天）`);
  db.close();
  process.exit(0);
}

db.exec('BEGIN IMMEDIATE');
let cleared = 0;
try {
  const cur = db.prepare(
    `UPDATE provider_requests SET payload_json = NULL WHERE payload_json IS NOT NULL
       AND window_id IN (SELECT id FROM windows WHERE status = 'CLOSED' AND updated_at < ?)
       AND window_id NOT IN (${ph})`,
  ).run(cutoff, ...freshIds);
  cleared = Number(cur.changes);
  const evCut = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const ev = db.prepare('DELETE FROM runtime_stream_events WHERE occurred_at < ?').run(evCut);
  const rb = db.prepare('DELETE FROM reasoning_blocks WHERE created_at < ?').run(evCut);
  db.prepare(
    "INSERT INTO audit_events(id, who, what, scope, result, detail_ref, created_at) VALUES (?, 'system', 'maintenance.prune', 'local_db', ?, NULL, ?)",
  ).run(`apr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    JSON.stringify({ payload_cleared: cleared, events_deleted: Number(ev.changes), reasoning_deleted: Number(rb.changes), opts: { keepWindows, keepDays } }),
    new Date().toISOString());
  db.exec('COMMIT');
  console.log(`[prune] payload_json 置空 ${cleared} 行；事件删 ${Number(ev.changes)}；reasoning 删 ${Number(rb.changes)}（audit 已留痕）`);
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`[prune] 失败回滚：${String(err && err.message ? err.message : err).slice(0, 120)}`);
  process.exit(1);
}
db.close();
