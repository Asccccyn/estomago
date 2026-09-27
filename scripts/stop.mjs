#!/usr/bin/env node
// 只停本项目进程：读 $STATE/run/host.pid，校验命令行确属 estomago main.ts 后 SIGTERM。
// 绝不按名字杀别的 node/python/cloudflared（02 §7：验证 start/stop 只影响本项目）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const stateRoot = process.env.ESTOMAGO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const pidFile = path.join(stateRoot, 'run', 'host.pid');
const statusOnly = process.argv.includes('--status');

if (!fs.existsSync(pidFile)) {
  console.log(`[stop] 无 pidfile（${pidFile}）：项目未在运行或上次已正常退出`);
  process.exit(0);
}
const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
let cmd = '';
try {
  cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
} catch {
  console.log(`[stop] pid ${pid} 已不存在（陈旧 pidfile），清理`);
  fs.rmSync(pidFile, { force: true });
  process.exit(0);
}
if (!cmd.includes('main.ts') || !cmd.includes('estomago')) {
  console.error(`[stop] pid ${pid} 命令行不匹配本项目（${cmd}），拒绝停止`);
  process.exit(2);
}
if (statusOnly) {
  console.log(`[status] estomago host 运行中：pid ${pid}`);
  process.exit(0);
}
process.kill(pid, 'SIGTERM');
console.log(`[stop] 已发送 SIGTERM 给 pid ${pid}；等待退出（pidfile 由进程自行清理）`);
