// 模型通过此工具管理自己的预约。预约事实由 BackgroundTaskService 持有。
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';
import type { TaskSummary } from '../../runtime/background-task-service.ts';
import { wakeOperationIdentity, type WakeMutation } from './operation-id.ts';

function wakeSuccess(op: WakeMutation, task: TaskSummary): ToolExecResult {
  if (op === 'schedule') return { ok: true, output: { task_id: task.task_id, scheduled_at: task.scheduled_at, revision: task.revision } };
  if (op === 'update') return { ok: true, output: { task_id: task.task_id, revision: task.revision, scheduled_at: task.scheduled_at } };
  return { ok: true, output: { task_id: task.task_id, revision: task.revision, cancelled: true } };
}

export class WakeToolsService {
  private readonly taskService: import('../../runtime/background-task-service.ts').BackgroundTaskService | null;

  constructor(deps: { taskService?: import('../../runtime/background-task-service.ts').BackgroundTaskService | null }) {
    this.taskService = deps.taskService ?? null;
  }

  wakeManage(args: Record<string, unknown>, ctx: ToolExecContext): ToolExecResult {
    if (!this.taskService) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '预约服务未装配（能力缺口，如实拒绝）' } };
    const op = args.operation;
    const convId = ctx.roomId;
    const onAcceptedReceipt = (ctx.recordHeartbeatReceipt || ctx.recordCommittedToolReceipt) && ['schedule','update','cancel'].includes(String(op))
      ? (task: TaskSummary) => {
        ctx.recordHeartbeatReceipt?.({ operationId: wakeOperationIdentity(convId, op as WakeMutation, String(args.operation_id ?? '')),
          status: 'committed', source: { namespace: 'host:task', id: task.task_id, revision: task.revision } });
        ctx.recordCommittedToolReceipt?.(wakeSuccess(op as WakeMutation, task));
      } : undefined;
    const err = (code: string, detail?: string): ToolExecResult => ({ ok: false, output: { error_code: code, ...(detail ? { detail } : {}) } });
    if (op === 'schedule') {
      const r = this.taskService.schedule({
        actorId: 'jiaming', conversationId: convId, operationId: String(args.operation_id ?? ''),
        note: args.note as string, at: args.at ?? undefined, delaySeconds: args.delay_seconds ?? undefined, createdBy: 'jiaming',
        onAcceptedReceipt,
      });
      if (!r.ok) return { ok: false, output: { error_code: r.code, ...(r.serverNowIso ? { server_now: r.serverNowIso } : {}), ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}), ...(r.detail ? { detail: r.detail } : {}) } };
      return wakeSuccess('schedule', r.task);
    }
    if (op === 'list') {
      const r = this.taskService.list({ actorId: 'jiaming', conversationId: convId, cursor: args.cursor, limit: args.limit, selfScheduledOnly: true });
      if (!r.ok) return err(r.code, r.detail ?? '');
      return { ok: true, output: { tasks: r.tasks.map((t) => ({ task_id: t.task_id, revision: t.revision, scheduled_at: t.scheduled_at, status: t.status, created_by: t.created_by, ...(t.note_preview ? { note_preview: t.note_preview } : {}) })), ...(r.next_cursor ? { next_cursor: r.next_cursor } : {}) } };
    }
    if (op === 'update') {
      const r = this.taskService.update({
        actorId: 'jiaming', updatedBy: 'jiaming', conversationId: convId, operationId: String(args.operation_id ?? ''), taskId: String(args.task_id ?? ''),
        expectedRevision: Number(args.expected_revision ?? 0), note: args.note ?? undefined, at: args.at ?? undefined, delaySeconds: args.delay_seconds ?? undefined, selfScheduledOnly: true,
        onAcceptedReceipt,
      });
      if (!r.ok) return { ok: false, output: { error_code: r.code, ...(r.serverNowIso ? { server_now: r.serverNowIso } : {}), ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}), ...(r.detail ? { detail: r.detail } : {}) } };
      return wakeSuccess('update', r.task);
    }
    if (op === 'cancel') {
      const r = this.taskService.cancel({ actorId: 'jiaming', conversationId: convId, operationId: String(args.operation_id ?? ''), taskId: String(args.task_id ?? ''), expectedRevision: Number(args.expected_revision ?? 0), selfScheduledOnly: true, onAcceptedReceipt });
      if (!r.ok) return { ok: false, output: { error_code: r.code, ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}), ...(r.detail ? { detail: r.detail } : {}) } };
      return wakeSuccess('cancel', r.task);
    }
    return err('WAKE_REQUEST_INVALID', `未知操作：${String(op)}`);
  }

}
