// modules/identity/module.ts（P04.8）：identity 域能力登记。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import { IdentityMilestoneService } from './milestone-service.ts';

/** identity_milestone_write 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const IDENTITYMILESTONEWRITE_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'identity_milestone_write',
      description: '维护你的《长期记忆里程碑》——一份完整文档，随开窗全文注入。内容一行一条（1.2.3.4. 依次编号，一个换行一条）。operation：read=读当前全文（带行号）；add=末尾加一条（text=一行内容）；revise=改第 item 条；remove=删第 item 条；write=整版替换（text=完整新版全文，通常不需要）。旧版本自动留档、她可回滚；当前窗口继续用旧版，下一扇新窗自动带新版。每次修改说明 change_reason。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['read', 'write', 'add', 'revise', 'remove'], description: '缺省=write（整版替换，会覆盖全部现有条目——常规修改请用 add/revise/remove 单条操作，不覆盖其他条目）' },
          text: { type: 'string', minLength: 1, maxLength: 65536, description: 'write=完整新版正文；add/revise=该条目新正文' },
          confirm_overwrite: { type: 'boolean', description: '仅 write：新正文未保留既有内容行时必须显式带 true（防误删她写的内容）；带 false/缺省将被拒绝并说明丢了哪些' },
          item: { type: 'integer', minimum: 1, description: 'revise/remove 的目标条目序号（read 结果里带）' },
          change_reason: { type: 'string', minLength: 1, maxLength: 500, description: '一句话说明这次更新了什么（进审计记录，她可见）' },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128, description: '幂等键：同键重试只写一版' },
        },
        required: [], additionalProperties: false,
        anyOf: [
          { required: ['operation'] },
          { required: ['text', 'change_reason', 'idempotency_key'] },
        ],
      },
    }
  };

export type IdentityModuleDeps = {
  db: import('../../db/connection.ts').Db;
  identity?: import('../../identity/service.ts').IdentityService | null;
};

export function registerIdentityCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: IdentityModuleDeps): void {
  const service = new IdentityMilestoneService(deps);
  registry.register(toolCapability({
    owner: 'identity',
    id: 'identity_milestone_write', baselineOrder: 34, free: true, definition: () => IDENTITYMILESTONEWRITE_DEFINITION, memoryOnlyAllowed: false, label: '更新长期记忆里程碑',
    run: (input: Record<string, unknown>, ctx) => Promise.resolve(service.identityMilestoneWrite(input as never, ctx)),
    toModel: (value) => value,
  }));
}
