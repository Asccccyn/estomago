// 单 State Root 单实例锁（AUD-32）：O_EXCL 锁文件 + PID 归属双因子校验（pid 存活 + 进程启动时刻匹配），
// 防止 PID 复用误判；stale 锁仅在确认原持有进程已死/非本产品时清理。不同 stateRoot 互不影响。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export type InstanceLock = { release: () => void; lockPath: string; nonce: string };

function processStartTime(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  } catch {
    return null; // 进程不存在
  }
}

function looksLikeEstomago(pid: number): boolean {
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return cmd.includes('main.ts') && cmd.includes('estomago');
  } catch {
    return false;
  }
}

export function acquireInstanceLock(stateRoot: string): InstanceLock {
  const runDir = path.join(stateRoot, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const lockPath = path.join(runDir, 'instance.lock');
  const nonce = randomBytes(16).toString('hex');
  const pid = process.pid;
  const startTime = processStartTime(pid);

  const tryAcquire = (): InstanceLock => {
    const fd = fs.openSync(lockPath, 'wx'); // O_EXCL
    fs.writeSync(fd, JSON.stringify({ pid, nonce, startTime, argv1: process.argv[1], stateRoot: fs.realpathSync(stateRoot), acquiredAt: new Date().toISOString() }));
    fs.closeSync(fd);
    let released = false;
    return {
      lockPath,
      nonce,
      release: () => {
        if (released) return;
        released = true;
        try {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { nonce: string };
          if (cur.nonce === nonce) fs.rmSync(lockPath, { force: true }); // CAS：只清自己的锁
        } catch {
          /* 尽力 */
        }
      },
    };
  };

  try {
    return tryAcquire();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // 已有锁：双因子校验持有者
    let holder: { pid: number; nonce: string; startTime: string | null };
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      fs.rmSync(lockPath, { force: true }); // 锁文件损坏：视为 stale
      return tryAcquire();
    }
    const currentStart = processStartTime(holder.pid);
    if (currentStart === null) {
      // 原持有进程不存在 → stale，清理重试
      fs.rmSync(lockPath, { force: true });
      return tryAcquire();
    }
    if (holder.startTime && currentStart !== holder.startTime) {
      // PID 复用：不是原持有者 → stale
      fs.rmSync(lockPath, { force: true });
      return tryAcquire();
    }
    if (!looksLikeEstomago(holder.pid)) {
      // 活着但不是 estomago（PID 复用到别的进程）→ stale
      fs.rmSync(lockPath, { force: true });
      return tryAcquire();
    }
    throw new Error(`INSTANCE_LOCK_HELD: stateRoot=${stateRoot} 已有实例运行（pid=${holder.pid}，启动于 ${holder.startTime}）。第二实例拒绝启动。`);
  }
}
