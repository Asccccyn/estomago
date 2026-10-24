// modules/context-review/module.ts（P04.10）：context-review 域能力登记（silent 沿原值）。
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import { ContextReviewService } from './service.ts';

/** context_review_complete 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const CONTEXTREVIEWCOMPLETE_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'context_review_complete',
      description: '完成当前活跃的换窗前记忆检查。decision=no_new_hold（本次没有新增 hold 且无未决写操作）或 holds_completed（本次已有核实的成功 hold）。',
      parameters: {
        type: 'object',
        properties: {
          review_id: { type: 'string', minLength: 1, maxLength: 256 },
          decision: { type: 'string', enum: ['no_new_hold', 'holds_completed'] },
        },
        required: ['review_id', 'decision'],
        additionalProperties: false,
      },
    },
  };

export type ContextReviewModuleDeps = {
  db: import('../../db/connection.ts').Db;
  reviews: import('../../context/rotation-review.ts').RotationReviewService;
  checkpoint: import('../../memory/hold-checkpoint.ts').HoldCheckpointService;
};

export function registerContextReviewCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: ContextReviewModuleDeps): void {
  const service = new ContextReviewService(deps);
  registry.register(toolCapability({
    id: 'context_review_complete', baselineOrder: 48, definition: CONTEXTREVIEWCOMPLETE_DEFINITION, memoryOnlyAllowed: true, label: 'context_review_complete', silent: true,
    run: (input: Record<string, unknown>, ctx) => Promise.resolve(service.reviewComplete(input as never, ctx)),
    toModel: (value) => value,
  }));
}
