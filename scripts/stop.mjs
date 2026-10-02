#!/usr/bin/env node
// stop/status v0.3（AUD-32 §28）：以 instance.lock 元数据为归属真源（nonce/pid/startTime/stateRoot realpath），
// pidfile 只是辅助；A 根 pidfile 指向 B 根实例 → STALE_OR_INVALID_LOCK，不误报运行中、绝不杀错实例。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const stateRoot = process.env.ESTOMAGO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const runDir = path.join(stateRoot, 'run');
const lockPath = path.join(runDir, 'instance.lock');
const pidFile = path.join(runDir, 'host.pid');
const statusOnly = process.argv.includes('--status');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidStart = (pid) => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(); } catch { return null; } };
// 归属与 instance-lock 同规则：锁元数据（stateRoot realpath + pid + 进程启动时刻）三因子，
// 绝不用命令行 substring 猜测——检出目录名不含 estomago 时曾因此误判 STALE 并拒停

const lock = readJson(lockPath);
const pidfilePid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : null;

// 归属判定：优先 lock 元数据；无锁时退回 pidfile + 双因子校验
function resolveInstance() {
  if (lock && typeof lock.pid === 'number') {
    if (!pidAlive(lock.pid)) return { status: 'STALE_LOCK', pid: lock.pid };
    const start = pidStart(lock.pid);
    if (lock.startTime && start && start !== lock.startTime) return { status: 'STALE_LOCK', pid: lock.pid };
    if (lock.stateRoot !== undefined && lock.stateRoot !== fs.realpathSync(stateRoot)) {
      return { status: 'STALE_OR_INVALID_LOCK', pid: lock.pid, note: 'lock 属于其他 stateRoot 实例' };
    }
    return { status: 'RUNNING', pid: lock.pid };
  }
  // 无锁文件：锁是归属唯一真源，pidfile 无归属信息——不可确认即不视为本根实例（不降级猜测）
  return { status: 'NOT_RUNNING' };
}

const inst = resolveInstance();

if (statusOnly) {
  if (inst.status === 'RUNNING') console.log(`[status] estomago host 运行中：pid ${inst.pid}${inst.note ? `（${inst.note}）` : ''}`);
  else if (inst.status === 'NOT_RUNNING') console.log('[status] 未运行');
  else console.log(`[status] ${inst.status}：pidfile/lock 与实际实例不符（pid ${inst.pid ?? '?'}），不视为本根实例`);
  process.exit(0);
}

if (inst.status === 'NOT_RUNNING') {
  console.log(`[stop] 无可用实例（pidfile=${pidfilePid ?? '无'}，lock=${lock ? '有' : '无'}）`);
  fs.rmSync(pidFile, { force: true });
  process.exit(0);
}
if (inst.status !== 'RUNNING') {
  console.error(`[stop] ${inst.status}：拒绝按失效标识发信号（${inst.note ?? ''}）`);
  process.exit(2);
}
process.kill(inst.pid, 'SIGTERM');
console.log(`[stop] 已发送 SIGTERM 给 pid ${inst.pid}（归属校验通过：lock stateRoot + pid + 进程启动时刻）`);
