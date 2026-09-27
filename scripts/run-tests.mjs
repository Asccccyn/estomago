#!/usr/bin/env node
// 测试运行器：前台、串行、分目录批次（AGENTS.md 测试纪律）；每个文件独立进程 + 超时；
// 子进程环境注入 ESTOMAGO_TEST_MODE=1 与独立临时 ESTOMAGO_HOME（绝不指向生产根）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const PROD_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const PER_FILE_TIMEOUT_MS = 60_000;

if (process.env.ESTOMAGO_HOME && path.resolve(process.env.ESTOMAGO_HOME) === PROD_ROOT) {
  console.error(`[test] ESTOMAGO_HOME 指向生产根（${PROD_ROOT}），拒绝运行测试。`);
  process.exit(2);
}

const groups = process.argv.includes('--integration')
  ? ['integration']
  : process.argv.includes('--unit')
    ? ['unit']
    : ['unit', 'contract', 'integration'];

const files = groups.flatMap((g) => {
  const dir = path.join(REPO, 'tests', g);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => path.join(dir, f));
});

console.log(`[test] ${files.length} 个测试文件，串行执行：\n  ${files.map((f) => path.basename(path.dirname(f)) + '/' + path.basename(f)).join('\n  ')}`);

let failed = 0;
for (const file of files) {
  const label = path.relative(REPO, file);
  process.stdout.write(`\n=== ${label} ===\n`);
  const code = await runOne(file);
  if (code !== 0) failed++;
}

console.log(`\n[test] 结束：${files.length - failed}/${files.length} 个文件通过，${failed} 失败`);
if (failed > 0) process.exit(1);

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: REPO,
      stdio: 'inherit',
      env: {
        ...process.env,
        ESTOMAGO_TEST_MODE: '1',
        ESTOMAGO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'estomago-test-home-')),
      },
    });
    const timer = setTimeout(() => {
      console.error(`[test] 超时（${PER_FILE_TIMEOUT_MS}ms），终止：${file}`);
      child.kill('SIGKILL');
    }, PER_FILE_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}
