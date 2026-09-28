#!/usr/bin/env node
// 一致性备份（01 §18.2/T15）：SQLite VACUUM INTO 快照（等价在线备份，不忽略 WAL），
// 附 manifest（schema 版本、消息水位、时间）。只落本地 backups/；异机/外置备份另行配置。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const stateRoot = process.env.ESTOMAGO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const dbFile = path.join(stateRoot, 'data', 'chat.sqlite3');
const backupDir = path.join(stateRoot, 'backups');

if (!fs.existsSync(dbFile)) {
  console.error(`[backup] 数据库不存在：${dbFile}（还没有可备份的数据）`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(backupDir, `chat-${ts}.sqlite3`);

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
const schema = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
const watermark = db.prepare('SELECT COUNT(*) AS n, MAX(sequence) AS m FROM messages').get();
db.close();

const manifest = {
  created_at: new Date().toISOString(),
  schema_version: schema?.v ?? 0,
  message_count: watermark?.n ?? 0,
  message_sequence_watermark: watermark?.m ?? 0,
  source: dbFile,
  file: target,
  source_sha256: snapHash,
  contains_credentials: false,
  note: '本地恢复点；异机/外置备份需另行配置并加密（18.2）',
};
// §21：先快照后 hash（快照文件与 manifest 一致）
const { createHash } = await import('node:crypto');
const snapHash = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const manifestPath = target.replace(/\.sqlite3$/, '.manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[backup] ${target}`);
console.log(`[backup] ${manifestPath}`);
