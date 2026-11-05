// application/background-execution.ts（P06.1）：后台执行用例（调度器→同一会话串行链）。
// 从 app-context 内联 executeRun 逐字迁移。依赖仅：任务设置读取、正式提醒发布、
// 单会话执行入口（enqueueBackground/runBackgroundTurn）、逐派发记录；不把整个 Host 传入。
// 价格校验与预占在每个实际派发时发生一次（P06.4）；用户停止/睡眠窗口/让位沿现行位置（P06.2）。
import { backgroundControl } from '../runtime/background-policy.ts';
import type { BackgroundScheduler } from '../runtime/background-scheduler.ts';
import type { BackgroundSettingsService } from '../runtime/background-settings.ts';
import type { MessageService } from '../messages/service.ts';
import type { EventService } from '../events/service.ts';

export type BackgroundExecutionDeps = {
  messages: MessageService;
  events: EventService;
  bgSettings: BackgroundSettingsService;
  /** 单会话串行执行入口（同一 runSerialized 链；不建第二队列）。 */
  supervisor: {
    enqueueBackground<T>(conversationId: string, run: () => Promise<T>): Promise<T>;
    runBackgroundTurn(input: Parameters<import('../runtime/supervisor.ts').TurnSupervisor['runBackgroundTurn']>[0]): Promise<{ outcome: 'completed' | 'noop' | 'failed' | 'unknown'; result_code?: string }>;
  };
  /** 调度器回写（recordDispatchStart 绑定；启动期装配，非循环依赖面）。 */
  scheduler: Pick<BackgroundScheduler, 'recordDispatchStart'>;
  /** F03：发布前消费任务/run 取消事实（只读查询） */
  db: import('../db/connection.ts').Db;
};

export function createBackgroundExecution(deps: BackgroundExecutionDeps): {
  executeRun(input: Parameters<import('../runtime/background-scheduler.ts').BackgroundExecutor['executeRun']>[0]): Promise<{ outcome: 'completed' | 'noop' | 'failed' | 'unknown' | 'cancelled'; result_code?: string }>;
} {
  const { messages, events, bgSettings, supervisor, scheduler, db } = deps;
  return {
    async executeRun(input) {
      if (input.kind === 'reminder') {
        // §04.13：预写提醒按时投递——零模型调用；system 消息走既有事实链+归档 outbox
        const text = typeof (input.payload as { text?: unknown }).text === 'string' ? String((input.payload as { text?: unknown }).text) : '[提醒]';
        // F03（四仓联合审计 20261104）：排队等待期间任务可能被取消（cancel 的
        // supersedeOpenRuns 已把零派发 run 置 cancelled）——**真正发布前**消费这份
        // 取消事实，不再发布已取消的提醒（旧实现：闭包无条件 publish + finish 用
        // completed 覆盖 cancelled，审计实测取消后仍新增系统消息 1 条）。
        const queued = await supervisor.enqueueBackground(input.conversationId, () => {
          // R1（复审 b137e98）：消费两个取消入口——任务取消（DB 事实）与 stop-run
          // （isCancelRequested 回调，stopRun 已写入 cancelRequested Set）。旧实现只查
          // 前者：停止本次执行后提醒仍在队列释放后照常发布（复审实测发布数=1）。
          if (input.isCancelRequested()) return Promise.resolve(null);
          const runCancelled = db.prepare('SELECT 1 FROM background_runs WHERE id = ? AND state = ?').get(input.runId, 'cancelled');
          const taskCancelled = db.prepare("SELECT 1 FROM background_tasks WHERE id = ? AND enabled = 0").get(input.taskId);
          if (runCancelled || taskCancelled) return Promise.resolve(null);
          return Promise.resolve(messages.publishSystemNotice({ conversationId: input.conversationId, content: `[定时提醒] ${text}`, clientMessageId: `reminder:${input.taskId}:${input.runId}` }));
        });
        if (queued === null) return { outcome: 'cancelled' as const, result_code: 'TASK_CANCELLED' };
        events.publish('message.persisted', { conversationId: input.conversationId, entityRef: queued.id, entityRevision: queued.sequence, scope: 'private', payload: { message: queued } });
        return { outcome: 'completed', result_code: 'delivered' };
      }
      return supervisor.enqueueBackground(input.conversationId, () => {
        // Recheck after acquiring the conversation's execution slot.
        // Price validation and reservation occur once at every actual dispatch.
        const kind = input.kind as 'autonomous' | 'keepwarm';
        const es = bgSettings.effective();
        const control=backgroundControl(kind,input.origin);
        if (!es[control].enabled) return Promise.resolve({ outcome: 'noop' as const, result_code: control==='keepwarm'?'KEEPWARM_DISABLED':control==='free_activity'?'FREE_ACTIVITY_DISABLED':'AUTONOMOUS_DISABLED' });
        if (es[control].daily_cost_cap_usd === null) return Promise.resolve({ outcome: 'failed' as const, result_code: 'BACKGROUND_BUDGET_NOT_CONFIGURED' });
        return supervisor.runBackgroundTurn({
          kind, runId: input.runId, conversationId: input.conversationId, payload: input.payload,
          isCancelRequested: input.isCancelRequested, registerAbort: input.registerAbort,
          recordDispatch: (info) => scheduler.recordDispatchStart({ runId: input.runId, ...info, capabilityName: info.capabilityName ?? null }),
          maxModelRequests: es.autonomous.max_model_requests_per_run,
        });
      });
    },
  };
}
