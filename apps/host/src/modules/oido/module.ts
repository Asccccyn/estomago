// modules/oido/module.ts（P02.5）：oído 能力模块注册条目。
// 本卡只登记 oido_get（baselineOrder=28）；其余 oído 工具尚未迁，不顺手迁整个项目。
// 定义从原 catalog 逐字搬迁（唯一正本；host-tools 的域工厂改为引用本导出）。
// 费用：oido_get 不在 verified-free 名单——沿 quoteBackgroundTool 可信配置上界
//（BUDGET_ESTIMATE_UNAVAILABLE 规则不变；非背景调用不查价——D40）。
// memoryOnlyAllowed=true：已批准的轻量通话能力（D39 精确清单；不是所有 oído 都 true）。
import type { Db } from '../../db/connection.ts';
import type { OidoAdapter } from '../../integrations/oido/adapter.ts';
import { oidoModelView } from '../../integrations/oido/model-view.ts';
import { quoteBackgroundTool } from '../../runtime/background-tool-cost.ts';
import { validateArgsAgainstSchema } from '../../capabilities/validation.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import { OidoSourceRepository } from './source-repository.ts';
import { OidoHearingService, type OidoGetEvidence, type OidoGetInput } from './service.ts';

/** oido_get 定义唯一正本（原 host-tools oidoDefinitions 内该块逐字搬迁；属性顺序不变）。 */
export const OIDO_GET_DEFINITION: HostToolSpec = {
  type: 'function',
  function: {
    name: 'oido_get',
    description: '读取深听结果：默认概览；detail=prosody_page 看逐字韵律谱（每页≤32音节，带 next_cursor 翻页）。analysis_id 来自 oido_analyze。',
    parameters: {
      type: 'object',
      properties: {
        analysis_id: { type: 'string', minLength: 1, maxLength: 128 },
        detail: { type: 'string', enum: ['overview', 'prosody_page'] },
        cursor: { type: 'string', minLength: 1, maxLength: 160, description: '翻页游标（上页 next_cursor）' },
      },
      required: ['analysis_id'], additionalProperties: false,
    },
  },
};

export type OidoModuleDeps = { db: Db; oido: OidoAdapter | null; sources: OidoSourceRepository };

/** oido_get 能力条目（P02 只此一项；id/baselineOrder/owner 按 tool-ownership.json）。 */
export function oidoGetCapability(deps: OidoModuleDeps): CapabilityDescriptor<OidoGetInput, OidoGetEvidence> {
  const service = new OidoHearingService(deps);
  return {
    id: 'oido_get',
    owner: 'oido',
    baselineOrder: 28,
    definition: OIDO_GET_DEFINITION,
    memoryOnlyAllowed: true,
    label: '读声音证据',
    silent: false,
    quote: (db) => quoteBackgroundTool(db, 'oido_get'),
    parse: (raw, frozenSpec) => validateArgsAgainstSchema(raw, frozenSpec.function.parameters as { properties?: Record<string, never>; required?: string[] }) as { ok: true; value: OidoGetInput } | { ok: false; code: string; detail: string },
    run: (input, ctx) => service.getEvidence(input, ctx),
    toModel: (value) => oidoModelView(value.raw, value.page),
  };
}

/** 装配入口：把 oído 已迁能力登记进 registry（P02.6 由 app-context 调用）。
 *  参数为注册表的最小结构面（register），避免装配依赖整个 registry 类。 */
export function registerOidoCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: OidoModuleDeps): void {
  registry.register(oidoGetCapability(deps));
}
