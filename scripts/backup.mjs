#!/usr/bin/env node
// 一致性备份（01 §18.2/T15）：SQLite VACUUM INTO 快照（等价在线备份，不忽略 WAL），
// 附 manifest（schema 版本、消息水位、时间）。只落本地 backups/；异机/外置备份另行配置。
// WP-04（JFA-E08）：备份恢复集补全——同批复制 config/auth.token 到 meta/（token 600）；
// 轮转保留最近 N 份（backup.keep，默认 10）；报告列出人工恢复缺口（plist/env）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const stateRoot = process.env.ESTOMAGO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const dbFile = path.join(stateRoot, 'data', 'chat.sqlite3');
const backupDir = path.join(stateRoot, 'backups');
const KEEP = Number(process.env.ESTOMAGO_BACKUP_KEEP || 10);

if (!fs.existsSync(dbFile)) {
  console.error(`[backup] 数据库不存在：${dbFile}（还没有可备份的数据）`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const stamp = `chat-${ts}`;
const target = path.join(backupDir, `${stamp}.sqlite3`);

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

// §21：先快照后 hash（快照文件与 manifest 一致）——F02 修复：声明必须在引用之前
const { createHash } = await import('node:crypto');
const snapHash = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
// 水位修复：schema/计数/水位一律从快照本身读取（VACUUM 后源库可能已被并发写入改掉，
// 快照元数据必须描述快照，而不是描述"读取时刻的源库"）
const snap = new DatabaseSync(target, { readOnly: true });
const schema = snap.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
const watermark = snap.prepare('SELECT COUNT(*) AS n, MAX(sequence) AS m FROM messages').get();
snap.close();

// WP-04（E08）：恢复集补全——config 与 auth.token 进 meta/（token 600）
const metaDir = path.join(backupDir, `${stamp}.meta`);
fs.mkdirSync(metaDir, { recursive: true });
const metaFiles = [];
const configSrc = path.join(stateRoot, 'config', 'estomago.yaml');
if (fs.existsSync(configSrc)) {
  fs.copyFileSync(configSrc, path.join(metaDir, 'config.yaml'));
  metaFiles.push('config.yaml');
}
const tokenSrc = path.join(stateRoot, 'config', 'auth.token');
if (fs.existsSync(tokenSrc)) {
  fs.copyFileSync(tokenSrc, path.join(metaDir, 'auth.token'));
  fs.chmodSync(path.join(metaDir, 'auth.token'), 0o600);
  metaFiles.push('auth.token');
}

const manifest = {
  created_at: new Date().toISOString(),
  schema_version: schema?.v ?? 0,
  message_count: watermark?.n ?? 0,
  message_sequence_watermark: watermark?.m ?? 0,
  source: dbFile,
  file: target,
  source_sha256: snapHash,
  contains_credentials: metaFiles.includes('auth.token'),
  meta_files: metaFiles,
  manual_restore_gaps: [
    'LaunchAgent plist 与其 env 引用不在备份集（部署文件，人工核对 deploy/macos/）',
    '外部凭据（OR/DS/Mariposa key）只在环境变量引用，值不落备份——恢复需重新注入',
  ],
  note: '本地恢复点；异机/外置备份需另行配置并加密（18.2）',
};
const manifestPath = path.join(backupDir, `${stamp}.manifest.json`);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[backup] ${target}`);
console.log(`[backup] ${manifestPath}`);

// AUD-05 P1 修复：content SQLite + 媒体文件纳入备份集
const contentDb = path.join(stateRoot, 'content', 'content.sqlite3');
if (fs.existsSync(contentDb)) {
  const contentTarget = path.join(backupDir, `${stamp}.content.sqlite3`);
  const cdb = new DatabaseSync(contentDb, { readOnly: true });
  cdb.exec(`VACUUM INTO '${contentTarget.replace(/'/g, "''")}'`);
  cdb.close();
  console.log(`[backup] content: ${contentTarget}`);
}
const mediaDir2 = path.join(stateRoot, 'media');
if (fs.existsSync(mediaDir2)) {
  const { execSync } = await import('node:child_process');
  const mediaTarget = path.join(backupDir, `${stamp}.media.tar.gz`);
  try {
    execSync(`tar -czf '${mediaTarget}' -C '${mediaDir2}' .`, { stdio: 'pipe' });
    console.log(`[backup] media: ${mediaTarget}`);
  } catch (e) {
    console.error(`[backup] 媒体归档失败（不阻断 DB 备份）：${e.message}`);
  }
}
if (metaFiles.length > 0) console.log(`[backup] meta/: ${metaFiles.join(', ')}`);

// WP-04（E08）：轮转——按创建时间保留最近 KEEP 份（快照+meta+manifest 同组）
const groups = new Set(fs.readdirSync(backupDir).filter((f) => f.startsWith('chat-')).map((f) => f.replace(/\.(sqlite3|manifest\.json|meta)$/, '')));
const sorted = [...groups].sort(); // 时间戳字典序=时间序
let removed = 0;
for (const g of sorted.slice(0, Math.max(0, sorted.length - KEEP))) {
  for (const suffix of ['.sqlite3', '.manifest.json']) {
    const f = path.join(backupDir, g + suffix);
    if (fs.existsSync(f)) { fs.rmSync(f); removed++; }
  }
  const m = path.join(backupDir, g + '.meta');
  if (fs.existsSync(m)) { fs.rmSync(m, { recursive: true }); removed++; }
}
console.log(`[backup] 轮转：保留最近 ${KEEP} 份，本轮清理 ${removed} 个文件`);
