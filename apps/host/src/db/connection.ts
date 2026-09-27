// SQLite 连接：node:sqlite（Node 22 内置，实验性警告如实保留）。
// WAL 模式（01 §16/T14）：本地磁盘、短事务、单写者；不在持锁期间调用模型或远端服务。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function openDatabase(dataDir: string, filename = 'chat.sqlite3'): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, filename);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA synchronous=NORMAL');
  return db;
}

// 事务包裹：同步回调内全部成功才提交（node:sqlite 同步执行，天然单写者）。
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 连接已坏时 ROLLBACK 可能失败，保留原始错误
    }
    throw err;
  }
}
