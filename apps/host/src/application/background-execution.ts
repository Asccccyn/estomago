// application/background-execution.ts（P06.1）：后台执行用例（调度器→同一会话串行链）。
// 从 app-context 内联 executeRun 逐字迁移。依赖仅：任务设置读取、正式提醒发布、
// 单会话执行入口（enqueueBackground/runBackgroundTurn）、逐派发记录；不把整个 Host 传入。
// 价格校验与预占在每个实际派发时发生一次（P06.4）；用户停止/睡眠窗口/让位沿现行位置（P06.2）。
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
};

export function createBackgroundExecution(deps: BackgroundExecutionDeps): {
  executeRun(input: Parameters<import('../runtime/background-scheduler.ts').BackgroundExecutor['executeRun']>[0]): Promise<{ outcome: 'completed' | 'noop' | 'failed' | 'unknown'; result_code?: string }>;
} {
  const { messages, events, bgSettings, supervisor, scheduler } = deps;
  return {
    async executeRun(input) {
      if (input.kind === 'reminder') {
        // §04.13：预写提醒按时投递——零模型调用；system 消息走既有事实链+归档 outbox
        const text = typeof (input.payload as { text?: unknown }).text === 'string' ? String((input.payload as { text?: unknown }).text) : '[提醒]';
        const msg = await supervisor.enqueueBackground(input.conversationId, () => Promise.resolve(messages.publishSystemNotice({ conversationId: input.conversationId, content: `[定时提醒] ${text}`, clientMessageId: `reminder:${input.taskId}:${input.runId}` })));
        events.publish('message.persisted', { conversationId: input.conversationId, entityRef: msg.id, entityRevision: msg.sequence, scope: 'private', payload: { message: msg } });
        return { outcome: 'completed', result_code: 'delivered' };
      }
      return supervisor.enqueueBackground(input.conversationId, () => {
        // Recheck after acquiring the conversation's execution slot.
        // Price validation and reservation occur once at every actual dispatch.
        const kind = input.kind as 'autonomous' | 'keepwarm';
        const es = bgSettings.effective();
        if (!es[kind].enabled) return Promise.resolve({ outcome: 'noop' as const, result_code: kind === 'keepwarm' ? 'KEEPWARM_DISABLED' : 'AUTONOMOUS_DISABLED' });
        if (es[kind].daily_cost_cap_usd === null) return Promise.resolve({ outcome: 'failed' as const, result_code: 'BACKGROUND_BUDGET_NOT_CONFIGURED' });
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
