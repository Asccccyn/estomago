#!/usr/bin/env node
// restore v0.2.2（AUD-16 修复）：只允许恢复到"新的空隔离目录"。
// 校验链：源存在 → 是 SQLite → integrity_check → schema 兼容 → 目标 realpath 非生产根/非空 →
// 无活动实例占用目标 → 拷贝 + 校验和。无效备份 non-zero exit。正式 promote 到生产根是独立显式流程，本脚本不做。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const fileIdx = args.findIndex((a) => !a.startsWith('--'));
const intoIdx = args.indexOf('--into');
const fail = (code, msg) => { console.error(`[restore] 拒绝（${code}）：${msg}`); process.exit(2); };

if (fileIdx < 0 || intoIdx < 0 || !args[intoIdx + 1]) {
  console.error('用法: node scripts/restore.mjs <backup.sqlite3> --into <新的空隔离目录>');
  process.exit(2);
}
const src = path.resolve(args[fileIdx]);
const destDirInput = path.resolve(args[intoIdx + 1]);
if (!fs.existsSync(src)) fail('SOURCE_MISSING', `备份不存在：${src}`);

// WP-09（CX-14/C-024）：两侧同 canonical 空间——prodRoot 与目标侧都过
// realpath（父目录链+最终分量），HOME 别名/尾分量 symlink 不再绕过。
// RRA-023（2026-10-09 复审）：生产根**不存在**时也 canonical 化——
// 取最近存在祖先 realpath+剩余后缀（新机/末段未建场景下 HOME 别名
// 不再使 lexical 逃逸比较）
function canonicalize(p) {
  let cur = path.resolve(p);
  const suffix = [];
  while (!fs.existsSync(cur)) {
    suffix.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    cur = fs.realpathSync(cur);
  } catch { /* 保持 resolve */ }
  return suffix.length > 0 ? path.join(cur, ...suffix) : cur;
}
const prodRoot = path.resolve(`${process.env.HOME ?? ''}/Library/Application Support/estomago`);
const prodReal = canonicalize(prodRoot);
// §21：父目录链 realpath 检查——不能通过 symlink 父目录绕过隔离规则
const destParentReal = fs.realpathSync(path.dirname(destDirInput));
// 最终分量存在（含其本身是 symlink 的情形）也要解析进同一命名空间
const destReal = canonicalize(destDirInput);
if (destReal === prodReal || destReal.startsWith(prodReal + path.sep)) fail('DEST_IS_PRODUCTION', '--into 不得指向（或经 symlink 指向）生产状态根');
// manifest hash 校验（§21）：backup.manifest.json / *.manifest.json 若提供 sha256 则必须匹配
const manifestCandidate = src.replace(/\.sqlite3$/, '') + '.manifest.json';
if (fs.existsSync(manifestCandidate)) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestCandidate, 'utf8'));
    if (typeof m.source_sha256 === 'string') {
      const actual = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(src)).digest('hex');
      if (actual !== m.source_sha256) fail('BACKUP_HASH_MISMATCH', `manifest sha256 与备份文件不符（期望 ${m.source_sha256.slice(0, 12)}… / 实际 ${actual.slice(0, 12)}…）`);
      console.log('[restore] manifest sha256 校验 OK');
    }
  } catch (e) {
    if (String(e.message).includes('拒绝')) throw e;
    fail('BACKUP_MANIFEST_INVALID', `manifest 读取失败：${String(e.message).slice(0, 60)}`);
  }
}
if (fs.existsSync(destDirInput)) {
  const entries = fs.readdirSync(destDirInput);
  if (entries.some((e) => e !== '.DS_Store')) fail('DEST_NOT_EMPTY', '目标目录必须不存在或为空（隔离恢复目录）');
} else {
  fs.mkdirSync(destDirInput, { recursive: true });
}
// 活动实例检查：目标若含 instance.lock 且持有者存活 → 拒绝
const existingLock = path.join(destDirInput, 'run/instance.lock');
if (fs.existsSync(existingLock)) fail('DEST_IN_USE', '目标目录存在实例锁（可能有活动实例）');

// 备份有效性 + D24（审计 3655d60）：校验读的是"主库+WAL"视图，拷贝若只拿主文件会静默丢 WAL 提交——
// 存在未 checkpoint 的 WAL 边车时，先把 (主库+wal+shm) 复制到临时目录做 checkpoint 收拢出**一致性独立快照**，
// 再以该快照为恢复源（原备份文件一个字节都不动）。
import os from 'node:os';
let restoreSource = src;
let tempSnapshotDir = null;
const walSide = src + '-wal';
if (fs.existsSync(walSide) && fs.statSync(walSide).size > 0) {
  tempSnapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'estomago-restore-wal-'));
  const tMain = path.join(tempSnapshotDir, 'chat.sqlite3');
  fs.copyFileSync(src, tMain);
  fs.copyFileSync(walSide, tMain + '-wal');
  const shmSide = src + '-shm';
  if (fs.existsSync(shmSide)) fs.copyFileSync(shmSide, tMain + '-shm');
  try {
    const tdb = new DatabaseSync(tMain); // 读写打开副本（不动原件）
    tdb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const integrity = tdb.prepare('PRAGMA integrity_check').get();
    tdb.close();
    if (String(integrity?.integrity_check ?? integrity ?? '') !== 'ok') {
      fs.rmSync(tempSnapshotDir, { recursive: true, force: true });
      fail('BACKUP_CORRUPT', `WAL 收拢快照 integrity_check 未通过：${JSON.stringify(integrity).slice(0, 80)}`);
    }
    restoreSource = tMain;
    console.log('[restore] 源含未 checkpoint 的 WAL——已收拢为一致性快照（原备份未修改）');
  } catch (e) {
    fs.rmSync(tempSnapshotDir, { recursive: true, force: true });
    fail('BACKUP_WAL_FOLD_FAILED', `WAL 收拢失败：${String(e.message).slice(0, 80)}`);
  }
}
let db;
try {
  db = new DatabaseSync(restoreSource, { readOnly: true });
} catch (e) {
  fail('BACKUP_NOT_SQLITE', `无法以 SQLite 打开备份：${String(e.message).slice(0, 80)}`);
}
try {
  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (String(integrity?.integrity_check ?? integrity ?? '') !== 'ok') fail('BACKUP_CORRUPT', `integrity_check 未通过：${JSON.stringify(integrity).slice(0, 80)}`);
  const version = db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations").get()?.v ?? 0;
  const walMode = db.prepare('PRAGMA journal_mode').get();
  console.log(`[restore] 备份校验 OK：schema v${version}，journal=${JSON.stringify(walMode)}`);
  // 单一口径：支持版本从迁移模块推导（v20 死表清退批改——此前硬编码 19
  // 与迁移链分叉，备份高于手写值即误拒 BACKUP_INCOMPATIBLE）
  const { SUPPORTED_SCHEMA_VERSION } = await import('../apps/host/src/db/migrations.ts');
  if (version > SUPPORTED_SCHEMA_VERSION) fail('BACKUP_INCOMPATIBLE', `备份 schema v${version} 高于当前代码支持的版本 v${SUPPORTED_SCHEMA_VERSION}`);
  db.close();
} catch (e) {
  if (String(e.message).includes('拒绝') || String(e.message).includes('BACKUP')) throw e;
  fail('BACKUP_INVALID', `备份校验失败：${String(e.message).slice(0, 80)}`);
}

// 拷贝 + 校验和（D24：拷的是收拢后的一致性快照 restoreSource，不是带活跃 WAL 的原始主文件）
const { createHash } = await import('node:crypto');
const hashOf = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const srcHash = hashOf(restoreSource);
const dest = path.join(destDirInput, 'data');
fs.mkdirSync(dest, { recursive: true });
const destFile = path.join(dest, 'chat.sqlite3');
fs.copyFileSync(restoreSource, destFile);
if (hashOf(destFile) !== srcHash) {
  fs.rmSync(destFile, { force: true });
  fail('COPY_MISMATCH', '拷贝后校验和不一致，已删除半成品');
}
if (tempSnapshotDir) fs.rmSync(tempSnapshotDir, { recursive: true, force: true });
fs.writeFileSync(destFile.replace(/\.sqlite3$/, '') + '.restore-manifest.json', JSON.stringify({
  restored_at: new Date().toISOString(), source: src, source_sha256: srcHash,
  side_effects: 'DISABLED', promote: '正式启用需单独显式流程（本脚本不 promote）',
}, null, 2));
// WP-09（E08 收口）：备份同组 meta/ 恢复配置引用到隔离根（token 保持 600）；
// plist/launchd env 仍需人工（restore-manifest 如实声明）
const metaDir = src.replace(/\.sqlite3$/, '') + '.meta';
if (fs.existsSync(metaDir)) {
  const cfgDest = path.join(destDirInput, 'config');
  fs.mkdirSync(cfgDest, { recursive: true });
  // RRA-019（2026-10-09 复审）：归档名→应用恢复名映射——备份里的
  // config.yaml 映射为 config/estomago.yaml（loadConfig 只认此名，
  // 此前原样拷 config.yaml 导致恢复后无法自动读取原配置）
  for (const [srcName, destName] of [['config.yaml', 'estomago.yaml'], ['auth.token', 'auth.token']]) {
    const from = path.join(metaDir, srcName);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(cfgDest, destName));
      if (destName === 'auth.token') fs.chmodSync(path.join(cfgDest, destName), 0o600);
      console.log(`[restore] meta/${srcName} 已恢复为隔离根 config/${destName}`);
    }
  }
}
console.log(`[restore] 已恢复到隔离目录：${destFile}`);
console.log('[restore] 副作用默认关闭：验证时不要配置推送/归档/模型凭据；promote 生产是独立显式流程。');
