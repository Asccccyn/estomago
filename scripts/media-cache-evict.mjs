// 相册整改 ALB-01：E 本地媒体缓存一次性逐出（运维脚本，需单独授权执行）。
// 对象=state=available 且 m_sync_state='synced' 的资产（M 已有同 hash 正本）——删除
// 本地文件、保留行；读取经 readContentResolvingMaster 按需从 M 回源重建缓存。
// 语音(out_of_scope)/未 synced(pending) 的文件永不逐（无 M 正本，删=丢字节）。
// 用法：node --experimental-strip-types scripts/media-cache-evict.mjs [--home <root>] --prod [--apply] [--to-budget]
//   默认 dry-run 清点；--apply 才删文件；--to-budget=只逐到配置预算内（默认逐全部候选）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const homeIdx = args.indexOf('--home');
const home = homeIdx >= 0 ? args[homeIdx + 1] : path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const isProd = home === path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
if (isProd && !args.includes('--prod')) { console.error('生产根必须 --prod'); process.exit(1); }
const apply = args.includes('--apply');
const toBudget = args.includes('--to-budget');

const { loadConfig } = await import('../apps/host/src/config/load.ts');
const { buildPaths, resolveStateRoot } = await import('../apps/host/src/config/paths.ts');
const paths = buildPaths(resolveStateRoot(home));
const { config } = loadConfig({ argv: [], paths });
const { openDatabase } = await import('../apps/host/src/db/connection.ts');
const db = openDatabase(paths.dataDir);

const rows = db.prepare(
  `SELECT id, storage_key, byte_size, ingest_purpose FROM media_assets
   WHERE state = 'available' AND m_sync_state = 'synced' ORDER BY created_at ASC`,
).all() as Array<{ id: string; storage_key: string; byte_size: number; ingest_purpose: string }>;

const eligible = rows.filter((r) => fs.existsSync(path.join(paths.mediaDir, r.storage_key)));
const totalBytes = eligible.reduce((n, r) => n + r.byte_size, 0);
const budget = config.media.cache_budget_bytes;
const targets = toBudget
  ? (() => { let acc = totalBytes; const t = []; for (const r of eligible) { if (acc <= budget) break; acc -= r.byte_size; t.push(r); } return t; })()
  : eligible;
console.log(`[cache-evict] synced 候选 ${eligible.length} 个/${(totalBytes / 1048576).toFixed(1)}MiB（预算 ${(budget / 1048576).toFixed(0)}MiB）；模式=${apply ? `APPLY${toBudget ? '(至预算)' : '(全部候选)'}` : 'DRY-RUN'}；目标 ${targets.length} 个`);

let freed = 0, failed = 0;
for (const r of targets) {
  const abs = path.join(paths.mediaDir, r.storage_key);
  if (!apply) { console.log(`[dry] ${r.id} ${r.ingest_purpose} ${r.byte_size}B`); continue; }
  try { fs.rmSync(abs); freed += r.byte_size; }
  catch (err) { failed += 1; console.error(`[fail] ${r.id}: ${String((err as Error).message).slice(0, 80)}`); }
}
db.close();
console.log(`[cache-evict] 完成：${apply ? `删除 ${targets.length - failed} 个文件，释放 ${(freed / 1048576).toFixed(1)}MiB` : '未删除任何文件'}；失败 ${failed}。行全部保留；后续读取从 M 回源重建。`);
if (failed > 0) process.exit(2);
