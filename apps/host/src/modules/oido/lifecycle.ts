// modules/oido/lifecycle.ts（P03.8）：oído 接入模块生命周期——删除传播重试 timer 的 start/stop 包装。
// 行为逐字保持：独立定时器 30s 一跳（不经调度器/会话串行链）、每跳 ≤1 条意图、指数退避按
// attempts 计（逻辑在 integrations/oido/delete-retry.ts retryOneOidoDelete）、表即状态重启恢复。
// Host 的实际启动/取消点（app-context.start/stop）调用本生命周期的 start/stop；不留下旧 timer。
import type { Db } from '../../db/connection.ts';
import type { OidoAdapter } from '../../integrations/oido/adapter.ts';
import { retryOneOidoDelete } from '../../integrations/oido/delete-retry.ts';

export interface OidoModuleLifecycle {
  start(): void;
  stop(): void;
}

export function createOidoDeleteRetryLifecycle(db: Db, oidoRef: () => OidoAdapter | null): OidoModuleLifecycle {
  let timer: ReturnType<typeof setInterval> | null = null;
  let abort: AbortController | null = null;
  return {
    start(): void {
      // R6′：oído 删除传播重试——独立定时器（≤1 条/跳，指数退避；表即状态，重启恢复）
      timer = setInterval(() => {
        const oido = oidoRef();
        if (!oido) return;
        abort = abort ?? new AbortController();
        void retryOneOidoDelete(db, oido, abort.signal).catch(() => {});
      }, 30_000);
      timer.unref?.();
    },
    stop(): void {
      if (timer) { clearInterval(timer); timer = null; }
      abort?.abort(); // R6′：停删除传播重试
    },
  };
}
