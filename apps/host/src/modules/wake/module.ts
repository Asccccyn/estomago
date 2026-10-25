// modules/wake/module.ts（P04.10）：wake 域 2 项能力登记（background_complete=silent 沿原值）。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import { WakeToolsService } from './service.ts';

/** wake_manage 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const WAKEMANAGE_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'wake_manage',
      description: '给自己预约未来的自主唤醒（一次性；可有多个并存任务）。schedule=新预约（at 带时区 RFC3339 或 delay_seconds 正整数秒，恰好一个；note=留给未来自己的话）；list=查看；update/cancel=修改/取消（需当前 revision）。独立开关：自主预约唤醒关闭时 schedule/update 返回 SELF_WAKE_DISABLED。要对宿主用户说话请走 chat_send_text；本工具只管理预约。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['schedule', 'list', 'update', 'cancel'] },
          operation_id: { type: 'string', minLength: 1, maxLength: 128, description: '写操作的幂等键：同键同参数重试返回原回执' },
          note: { type: 'string', minLength: 1, maxLength: 8000, description: '留给未来自己的话（到期原样递送给自己，不直接发给宿主用户）' },
          at: { type: 'string', description: '目标时间（RFC3339，必须带 Z 或 ±hh:mm 时区）' },
          delay_seconds: { type: 'integer', minimum: 1, description: '从现在起的秒数（首次受理时解析为绝对时间）' },
          task_id: { type: 'string', minLength: 1, maxLength: 64 },
          expected_revision: { type: 'integer', minimum: 1 },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['operation'], additionalProperties: false,
      },
    }
  };

/** background_complete 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const BACKGROUNDCOMPLETE_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'background_complete',
      description: '结束本次自主活动/心跳。outcome=noop 表示正常地什么都没做（不需要产出、消息或 hold）；done 表示本轮活动已完成。自主活动与心跳回合均可用。',
      parameters: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['done', 'noop'] },
        },
        required: ['outcome'], additionalProperties: false,
      },
    }
  };

export type WakeModuleDeps = {
  db: import('../../db/connection.ts').Db;
  taskService?: import('../../runtime/background-task-service.ts').BackgroundTaskService | null;
};

export function registerWakeCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: WakeModuleDeps): void {
  const service = new WakeToolsService(deps);
  registry.register(toolCapability({
    owner: 'wake',
    id: 'wake_manage', baselineOrder: 20, free: true, definition: () => WAKEMANAGE_DEFINITION, memoryOnlyAllowed: false, label: '给自己定唤醒', silent: false,
    run: (input: Record<string, unknown>, ctx) => Promise.resolve(service.wakeManage(input as never, ctx)),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    owner: 'wake',
    id: 'background_complete', baselineOrder: 21, free: true, definition: () => BACKGROUNDCOMPLETE_DEFINITION, memoryOnlyAllowed: false, label: '结束自主活动', silent: true,
    run: (input: Record<string, unknown>, ctx) => Promise.resolve(service.backgroundComplete(input as never, ctx)),
    toModel: (value) => value,
  }));
}
