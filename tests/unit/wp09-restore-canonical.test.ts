// WP-09（run-160858）：restore 两侧同 canonical 空间（CX-14/C-024）。
// 四例 probe（基线红=Codex 复现：HOME 别名/尾分量 symlink 把库写进
// "生产根别名"）+ 两对照；每例独立 HOME+finally 清理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

import { DatabaseSync } from 'node:sqlite';

function makeBackup(root: string): { db: string } {
  const f = path.join(root, 'backup.sqlite3');
  const db = new DatabaseSync(f);
  db.exec('CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES (1);');
  db.close();
  return { db: f };
}

function runRestore(db: string, into: string, home: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ['scripts/restore.mjs', db, '--into', into], {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, HOME: home, ESTOMAGO_TEST_MODE: '1' },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('四例 probe：合法新根成功 / canonical 生产根拒 / HOME 别名拒 / 尾分量 symlink 拒', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wp9-probe-'));
  try {
    // 「生产根」以独立 HOME 模拟（restore 以 HOME 推 prodRoot）
    const homeA = path.join(t, 'homeA');
    const prodRoot = path.join(homeA, 'Library/Application Support/estomago');
    fs.mkdirSync(prodRoot, { recursive: true });
    const { db } = makeBackup(t);

    // ① 合法新根（对照正例）：成功
    const fresh = path.join(t, 'restore-ok');
    const r1 = runRestore(db, fresh, homeA);
    assert.equal(r1.code, 0, `合法新根应成功（${r1.out.slice(0, 160)}）`);
    assert.ok(fs.existsSync(path.join(fresh, 'data/chat.sqlite3')));

    // ② canonical 生产根本体：拒
    const r2 = runRestore(db, prodRoot, homeA);
    assert.equal(r2.code, 2);
    assert.ok(r2.out.includes('DEST_IS_PRODUCTION'), '生产根本体拒');

    // ③ HOME 别名：aliasHome（symlink→homeA）——prodRoot 解析后同一真实根，拒
    const aliasHome = path.join(t, 'aliasHome');
    fs.symlinkSync(homeA, aliasHome);
    const aliasProd = path.join(aliasHome, 'Library/Application Support/estomago');
    const r3 = runRestore(db, aliasProd, aliasHome);
    assert.equal(r3.code, 2, `HOME 别名下的生产根必须拒（输出 ${r3.out.slice(0, 120)}）`);
    assert.ok(r3.out.includes('DEST_IS_PRODUCTION'));

    // ④ 尾分量 symlink：freshRoot2/slink → 生产根：拒（基线红——曾写进别名）
    const slinkParent = path.join(t, 'via-link');
    fs.mkdirSync(slinkParent, { recursive: true });
    fs.symlinkSync(prodRoot, path.join(slinkParent, 'slink'));
    const r4 = runRestore(db, path.join(slinkParent, 'slink'), homeA);
    assert.equal(r4.code, 2, '尾分量 symlink 指向生产根必须拒');
    assert.ok(r4.out.includes('DEST_IS_PRODUCTION'));
    // 且没有把库写进"生产根"（alias 穿透未发生）
    assert.ok(!fs.existsSync(path.join(prodRoot, 'data/chat.sqlite3')), '生产根未被写入');

    // ⑤ 对照：别名空间下的全新目录（不在生产根内）——成功
    const aliasFresh = path.join(aliasHome, 'restore-alias-fresh');
    const r5 = runRestore(db, aliasFresh, aliasHome);
    assert.equal(r5.code, 0, '别名空间下非生产目录的恢复不受影响');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test('meta 恢复：备份同组 meta/ 的 config+token 进隔离根（600）', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wp9-meta-'));
  try {
    const homeA = path.join(t, 'homeA');
    fs.mkdirSync(path.join(homeA, 'Library/Application Support/estomago'), { recursive: true });
    const { db } = makeBackup(t);
    const meta = db.replace(/\.sqlite3$/, '') + '.meta';
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, 'config.yaml'), 'runtime:\n  provider: mock\n');
    fs.writeFileSync(path.join(meta, 'auth.token'), 'tok-9');
    const fresh = path.join(t, 'restore-meta');
    const r = runRestore(db, fresh, homeA);
    assert.equal(r.code, 0, r.out.slice(0, 160));
    assert.ok(fs.existsSync(path.join(fresh, 'config/config.yaml')), 'config 恢复');
    assert.ok(fs.existsSync(path.join(fresh, 'config/auth.token')), 'token 恢复');
    const mode = fs.statSync(path.join(fresh, 'config/auth.token')).mode & 0o777;
    assert.equal(mode, 0o600, 'token 600');
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
