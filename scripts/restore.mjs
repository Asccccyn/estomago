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

const prodRoot = path.resolve(`${process.env.HOME ?? ''}/Library/Application Support/estomago`);
// §21：父目录链 realpath 检查——不能通过 symlink 父目录绕过隔离规则
const destParentReal = fs.realpathSync(path.dirname(destDirInput));
const destReal = path.resolve(destParentReal, path.basename(destDirInput));
if (destReal === prodRoot || destReal.startsWith(prodRoot + path.sep)) fail('DEST_IS_PRODUCTION', '--into 不得指向（或经 symlink 指向）生产状态根');
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

// 备份有效性
let db;
try {
  db = new DatabaseSync(src, { readOnly: true });
} catch (e) {
  fail('BACKUP_NOT_SQLITE', `无法以 SQLite 打开备份：${String(e.message).slice(0, 80)}`);
}
try {
  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (String(integrity?.integrity_check ?? integrity ?? '') !== 'ok') fail('BACKUP_CORRUPT', `integrity_check 未通过：${JSON.stringify(integrity).slice(0, 80)}`);
  const version = db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations").get()?.v ?? 0;
  const walMode = db.prepare('PRAGMA journal_mode').get();
  console.log(`[restore] 备份校验 OK：schema v${version}，journal=${JSON.stringify(walMode)}`);
  const CURRENT_SCHEMA = 10; // 与 apps/host/src/db/migrations.ts 最新版本同步
  if (version > CURRENT_SCHEMA) fail('BACKUP_INCOMPATIBLE', `备份 schema v${version} 高于当前代码支持的版本`);
  db.close();
} catch (e) {
  if (String(e.message).includes('拒绝') || String(e.message).includes('BACKUP')) throw e;
  fail('BACKUP_INVALID', `备份校验失败：${String(e.message).slice(0, 80)}`);
}

// 拷贝 + 校验和
const { createHash } = await import('node:crypto');
const hashOf = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const srcHash = hashOf(src);
const dest = path.join(destDirInput, 'data');
fs.mkdirSync(dest, { recursive: true });
const destFile = path.join(dest, 'chat.sqlite3');
fs.copyFileSync(src, destFile);
if (hashOf(destFile) !== srcHash) {
  fs.rmSync(destFile, { force: true });
  fail('COPY_MISMATCH', '拷贝后校验和不一致，已删除半成品');
}
fs.writeFileSync(destFile.replace(/\.sqlite3$/, '') + '.restore-manifest.json', JSON.stringify({
  restored_at: new Date().toISOString(), source: src, source_sha256: srcHash,
  side_effects: 'DISABLED', promote: '正式启用需单独显式流程（本脚本不 promote）',
}, null, 2));
console.log(`[restore] 已恢复到隔离目录：${destFile}`);
console.log('[restore] 副作用默认关闭：验证时不要配置推送/归档/模型凭据；promote 生产是独立显式流程。');
