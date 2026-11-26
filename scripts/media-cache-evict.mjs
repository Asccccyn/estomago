// 相册整改 ALB-01：E 本地媒体缓存一次性逐出（运维脚本，需单独授权执行）。
// 二轮返修 P1-4（2026-11-15）：与后台 evictCacheOverBudget 共用同一套物理文件规则
// （planCacheEviction/deleteCacheFiles）——按 storage_key 去重计量、保护仍需本地字节
// 的有效引用（pending/out_of_scope；missing 标删行不算）、LRU 按文件各引用最近使用。
// 读取经 readContentResolvingMaster 按需从 M 回源重建缓存。
// 用法：node --experimental-strip-types scripts/media-cache-evict.mjs [--home <root>] --prod [--apply] [--to-budget]
//   默认 dry-run 清点；--apply 才删文件；--to-budget=只逐到配置预算内（默认逐全部候选）。
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
// 共用唯一正本：同一计量/保护/顺序，预演与实际执行同一批候选。
// 反例3（2026-11-16）：实占=含受保护文件的全部现存文件（它们占预算）；可逐=排除受保护后的删除候选。
const { planCacheEviction, deleteCacheFiles } = await import('../apps/host/src/media/assets.ts');
const { candidates, totalBytes, protectedCount, protectedBytes } = planCacheEviction(db, paths.mediaDir);
const budget = config.media.cache_budget_bytes;
const targets = toBudget
  ? (() => { let acc = totalBytes; const t = []; for (const f of candidates) { if (acc <= budget) break; acc -= f.size; t.push(f); } return t; })()
  : candidates;
const targetBytes = targets.reduce((n, f) => n + f.size, 0);
console.log(`[cache-evict] 磁盘实占（按物理文件去重）${(totalBytes / 1024).toFixed(1)}KiB（受保护 ${protectedCount} 个/${(protectedBytes / 1024).toFixed(1)}KiB 不可删，计入占用）；预算 ${(budget / 1024).toFixed(0)}KiB；可逐候选 ${candidates.length} 个/${(candidates.reduce((n, f) => n + f.size, 0) / 1024).toFixed(1)}KiB；模式=${apply ? `APPLY${toBudget ? '(至预算)' : '(全部候选)'}` : 'DRY-RUN'}；目标 ${targets.length} 个/${(targetBytes / 1024).toFixed(1)}KiB`);

if (!apply) {
  for (const f of targets) console.log(`[dry] ${f.storageKey} ${f.size}B lastUsed=${f.lastUsed ?? '从未读取'}`);
  db.close();
  console.log('[cache-evict] 预演完成：未删除任何文件；行全部保留。');
} else {
  const { evicted, freedBytes, failed } = deleteCacheFiles(paths.mediaDir, targets);
  db.close();
  console.log(`[cache-evict] 完成：删除 ${evicted} 个文件，释放 ${(freedBytes / 1024).toFixed(1)}KiB；失败 ${failed}。行全部保留；后续读取从 M 回源重建。`);
  if (failed > 0) process.exit(2);
}
