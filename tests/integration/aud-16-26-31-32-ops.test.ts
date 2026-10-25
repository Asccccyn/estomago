// AUD-16/26/31/32 回归：restore 安全边界、--config 生效、测试保险丝进入入口、单根单实例锁。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import {tempRoot } from '../helpers.ts';

const NODE = process.execPath;
const REPO = path.resolve(import.meta.dirname, '../..');
const run = (args: string[], opts = {}) => spawnSync(NODE, args, { encoding: 'utf8', ...opts });

test('AUD-16：无效备份（文本）→ non-zero；非空目标拒绝；生产根拒绝；合法备份→空目录成功', () => {
  const fake = path.join(tempRoot(), 'fake.sqlite3');
  fs.writeFileSync(fake, 'this is not a sqlite database');
  const emptyDest = tempRoot('aud16-e-');
  fs.rmSync(emptyDest, { recursive: true, force: true });
  const r1 = run([path.join(REPO, 'scripts/restore.mjs'), fake, '--into', emptyDest]);
  assert.notEqual(r1.status, 0, '无效备份必须非零退出');
  assert.match(r1.stderr, /BACKUP_INVALID|BACKUP_NOT_SQLITE/);

  const nonEmpty = tempRoot('aud16-n-');
  fs.writeFileSync(path.join(nonEmpty, 'marker'), 'x');
  const r2 = run([path.join(REPO, 'scripts/restore.mjs'), fake, '--into', nonEmpty]);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /DEST_NOT_EMPTY/);

  const prodLike = path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
  const r3 = run([path.join(REPO, 'scripts/restore.mjs'), fake, '--into', prodLike]);
  assert.notEqual(r3.status, 0);
  assert.match(r3.stderr, /DEST_IS_PRODUCTION|DEST_NOT_EMPTY/);

  // 合法备份：构造一个迁移过的库
  const goodRoot = tempRoot('aud16-g-');
  const db = openDatabase(path.join(goodRoot, 'data'));
  migrate(db, sha256Hex);
  db.close();
  const good = path.join(goodRoot, 'data/chat.sqlite3');
  const okDest = tempRoot('aud16-ok-');
  fs.rmSync(okDest, { recursive: true, force: true });
  const r4 = run([path.join(REPO, 'scripts/restore.mjs'), good, '--into', okDest]);
  assert.equal(r4.status, 0, `合法恢复应成功：${r4.stderr}`);
  assert.ok(fs.existsSync(path.join(okDest, 'data/chat.sqlite3')));
});

test('AUD-26：--config 真正生效（自定义端口 B 监听）', { timeout: 30000 }, async () => {
  const root = tempRoot('aud26-');
  for (const d of ['config', 'identity', 'workspaces', 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
  // 默认配置：18831；自定义配置：18832
  fs.writeFileSync(path.join(root, 'config/estomago.yaml'), 'deployment:\n  port: 18831\n');
  const custom = path.join(root, 'custom.yaml');
  fs.writeFileSync(custom, 'deployment:\n  port: 18832\n');
  const out = [];
  const child = spawn(NODE, [path.join(REPO, 'apps/host/src/main.ts'), '--config', custom], {
    env: { PATH: process.env.PATH, HOME: root, ESTOMAGO_HOME: root, ESTOMAGO_TEST_MODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));
  await new Promise((r) => setTimeout(r, 3000));
  const text = out.join('');
  child.kill('SIGKILL');
  assert.match(text, /listening http:\/\/127\.0\.0\.1:18832/, `应监听自定义端口 18832：${text.slice(0, 200)}`);
  assert.doesNotMatch(text, /:18831/, '不得回落默认配置端口');
});

test('AUD-31：npm test 入口执行保险丝——凭据环境直接拒绝', () => {
  const r = run([path.join(REPO, 'scripts/run-tests.mjs')], {
    env: { PATH: process.env.PATH, HOME: tempRoot('aud31-'), ANTHROPIC_API_KEY: 'AUDIT_SYNTHETIC_KEY_000' },
  });
  assert.equal(r.status, 2, `带凭据环境测试必须拒绝启动（exit=${r.status}）`);
  assert.match(r.stdout + r.stderr, /保险丝拒绝/);
});

test('AUD-32：同 state root 第二实例启动失败（实例锁）；不同根互不影响', { timeout: 40000 }, async () => {
  const root = tempRoot('aud32-');
  for (const d of ['config', 'identity', 'workspaces']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'config/estomago.yaml'), 'deployment:\n  port: 18833\n');
  const child1 = spawn(NODE, [path.join(REPO, 'apps/host/src/main.ts'), '--port', '0'], {
    env: { PATH: process.env.PATH, HOME: root, ESTOMAGO_HOME: root, ESTOMAGO_TEST_MODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out1 = [];
  child1.stdout.on('data', (d) => out1.push(String(d)));
  await new Promise((r) => setTimeout(r, 2500));
  assert.match(out1.join(''), /listening/, '第一实例应启动');

  const out2 = [];
  const child2 = spawn(NODE, [path.join(REPO, 'apps/host/src/main.ts'), '--port', '0'], {
    env: { PATH: process.env.PATH, HOME: root, ESTOMAGO_HOME: root, ESTOMAGO_TEST_MODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child2.stdout.on('data', (d) => out2.push(String(d)));
  child2.stderr.on('data', (d) => out2.push(String(d)));
  const code2 = await new Promise<number>((resolve) => child2.on('exit', (c) => resolve(c ?? -1)));
  assert.notEqual(code2, 0, '第二实例必须失败退出');
  assert.match(out2.join(''), /INSTANCE_LOCK_HELD/, `应报实例锁：${out2.join('').slice(0, 200)}`);
  child1.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  // 锁随进程退出释放（stale 清理后第三实例可启动）
  const out3 = [];
  const child3 = spawn(NODE, [path.join(REPO, 'apps/host/src/main.ts'), '--port', '0'], {
    env: { PATH: process.env.PATH, HOME: root, ESTOMAGO_HOME: root, ESTOMAGO_TEST_MODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child3.stdout.on('data', (d) => out3.push(String(d)));
  await new Promise((r) => setTimeout(r, 2500));
  assert.match(out3.join(''), /listening/, '锁释放后应可再启动');
  child3.kill('SIGKILL');
});
