// modules/wake/service.ts（P04.10）：wake_manage/background_complete 定义与 handler 归属迁移。
// 回合编排在 P06 收口；本卡不改评审或唤醒政策。BackgroundTaskService 正本不变。
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';

export class WakeToolsService {
  private readonly db: import('../../db/connection.ts').Db;
  private readonly taskService: import('../../runtime/background-task-service.ts').BackgroundTaskService | null;

  constructor(deps: { db: import('../../db/connection.ts').Db; taskService?: import('../../runtime/background-task-service.ts').BackgroundTaskService | null }) {
    this.db = deps.db;
    this.taskService = deps.taskService ?? null;
  }

  wakeManage(args: Record<string, unknown>, ctx: ToolExecContext): ToolExecResult {
    if (!this.taskService) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '预约服务未装配（能力缺口，如实拒绝）' } };
    const op = args.operation;
    const convId = ctx.roomId;
    const err = (code: string, detail?: string): ToolExecResult => ({ ok: false, output: { error_code: code, ...(detail ? { detail } : {}) } });
    if (op === 'schedule') {
      const r = this.taskService.schedule({
        actorId: 'jiaming', conversationId: convId, operationId: String(args.operation_id ?? ''),
        note: args.note as string, at: args.at ?? undefined, delaySeconds: args.delay_seconds ?? undefined, createdBy: 'jiaming',
      });
      if (!r.ok) return { ok: false, output: { error_code: r.code, ...(r.serverNowIso ? { server_now: r.serverNowIso } : {}), ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}), ...(r.detail ? { detail: r.detail } : {}) } };
      return { ok: true, output: { task_id: r.task.task_id, scheduled_at: r.task.scheduled_at, revision: r.task.revision } };
    }
    if (op === 'list') {
      const r = this.taskService.list({ actorId: 'jiaming', conversationId: convId, cursor: args.cursor, limit: args.limit, selfScheduledOnly: true });
      if (!r.ok) return err(r.code, r.detail ?? '');
      return { ok: true, output: { tasks: r.tasks.map((t) => ({ task_id: t.task_id, revision: t.revision, scheduled_at: t.scheduled_at, status: t.status, ...(t.note_preview ? { note_preview: t.note_preview } : {}) })), ...(r.next_cursor ? { next_cursor: r.next_cursor } : {}) } };
    }
    if (op === 'update') {
      const r = this.taskService.update({
        actorId: 'jiaming', conversationId: convId, operationId: String(args.operation_id ?? ''), taskId: String(args.task_id ?? ''),
        expectedRevision: Number(args.expected_revision ?? 0), note: args.note ?? undefined, at: args.at ?? undefined, delaySeconds: args.delay_seconds ?? undefined, selfScheduledOnly: true,
      });
      if (!r.ok) return { ok: false, output: { error_code: r.code, ...(r.serverNowIso ? { server_now: r.serverNowIso } : {}), ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}), ...(r.detail ? { detail: r.detail } : {}) } };
      return { ok: true, output: { task_id: r.task.task_id, revision: r.task.revision, scheduled_at: r.task.scheduled_at } };
    }
    if (op === 'cancel') {
      const r = this.taskService.cancel({ actorId: 'jiaming', conversationId: convId, operationId: String(args.operation_id ?? ''), taskId: String(args.task_id ?? ''), expectedRevision: Number(args.expected_revision ?? 0), selfScheduledOnly: true });
      if (!r.ok) return { ok: false, output: { error_code: r.code, ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}), ...(r.detail ? { detail: r.detail } : {}) } };
      return { ok: true, output: { task_id: r.task.task_id, revision: r.task.revision, cancelled: true } };
    }
    return err('WAKE_REQUEST_INVALID', `未知操作：${String(op)}`);
  }


  backgroundComplete(args: { outcome: 'done' | 'noop' }, ctx: ToolExecContext): ToolExecResult {
    if (ctx.purpose !== 'proactive_turn' && ctx.purpose !== 'cache_keepalive') return { ok: false, output: { error_code: 'TOOL_PURPOSE_INVALID', detail: 'background_complete 仅后台回合（自主唤醒/心跳）可用' } };
    if (ctx.backgroundRunId) {
      this.db.prepare("UPDATE background_runs SET result_code = ?, updated_at = ? WHERE id = ?").run(`complete:${args.outcome}`, new Date().toISOString(), ctx.backgroundRunId);
    }
    return { ok: true, output: { completed: true, outcome: args.outcome } };
  }

}
