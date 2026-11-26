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
      description: '维护我们的记忆锚点。read 读全文及条目号；write 整版替换；add 追加；revise/remove 按 item 改/删。一行一条，旧版留档，下一新窗生效。写操作需 change_reason 和 idempotency_key；遗漏旧内容须真实 confirm_overwrite=true。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['read', 'write', 'add', 'revise', 'remove'], description: '必填且必须显式（缺省调用会被拒绝）：read 读；write 整版替换（覆盖全部现有条目）；add 追加一条；revise/remove 按 item 改/删单条。常规修改用 add/revise/remove，不覆盖其他条目' },
          text: { type: 'string', minLength: 1, maxLength: 65536, description: 'write=完整新版正文；add/revise=该条目新正文' },
          confirm_overwrite: { type: 'boolean', description: '仅 write：新正文未保留既有内容行时必须显式带 true（防误删她写的内容）；带 false/缺省将被拒绝并说明丢了哪些' },
          item: { type: 'integer', minimum: 1, description: 'revise/remove 的目标条目序号（read 结果里带）' },
          change_reason: { type: 'string', minLength: 1, maxLength: 500, description: '一句话说明这次更新了什么（进审计记录，她可见）' },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128, description: '幂等键：同键重试只写一版' },
        },
        required: ['operation'], additionalProperties: false,
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
    id: 'identity_milestone_write', baselineOrder: 34, free: true, definition: () => IDENTITYMILESTONEWRITE_DEFINITION, memoryOnlyAllowed: false, label: '我们的锚点',
    heartbeatAction: input => input.operation === 'read' ? undefined : 'anchor_write',
    run: (input: Record<string, unknown>, ctx) => Promise.resolve(service.identityMilestoneWrite(input as never, ctx)),
    toModel: (value) => value,
  }));
}
