// modules/oido/module.ts（P02.5）：oído 能力模块注册条目。
// 本卡只登记 oido_get（baselineOrder=28）；其余 oído 工具尚未迁，不顺手迁整个项目。
// 定义从原 catalog 逐字搬迁（唯一正本；host-tools 的域工厂改为引用本导出）。
// 费用：oido_get 不在 verified-free 名单——沿 quoteBackgroundTool 可信配置上界
//（BUDGET_ESTIMATE_UNAVAILABLE 规则不变；非背景调用不查价——D40）。
// memoryOnlyAllowed=true：已批准的轻量通话能力（D39 精确清单；不是所有 oído 都 true）。
import type { Db } from '../../db/connection.ts';
import type { OidoAdapter } from '../../integrations/oido/adapter.ts';
import { quoteBackgroundTool } from '../../runtime/background-tool-cost.ts';
import { validateArgsAgainstSchema } from '../../capabilities/validation.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import { OidoSourceRepository } from './source-repository.ts';
import { OidoHearingService, type OidoGetEvidence, type OidoGetInput } from './service.ts';

export const OIDO_ANALYZE_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'oido_analyze',
      description: '深听一条语音消息的声音证据（停顿、语速、音高走势、逐字韵律）。她明确要你听语气、或转写不足以判断她的状态时调用。audio_ref 形如 est:<asset_id>（语音消息投影里带）。返回概览观察（带时间定位）或任务票据；逐字谱用 oido_get。证据只描述可测得的声学现象，不是情绪结论。',
      parameters: {
        type: 'object',
        properties: {
          audio_ref: { type: 'string', pattern: '^est:[A-Za-z0-9_-]{1,128}$', description: '语音引用（est:asset_id，投影中给出）' },
          range_ms: {
            type: 'array', minItems: 2, maxItems: 2,
            items: { type: 'integer', minimum: 0 },
            description: '可选：只听 [start,end) 毫秒区间',
          },
        },
        required: ['audio_ref'], additionalProperties: false,
      },
    }
  };

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

export type OidoModuleDeps = { db: Db; oido: OidoAdapter | null; sources: OidoSourceRepository; audio?: import('./service.ts').AudioContentReader | null };

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
    // 唯一投影边界：投影已在 service 内恰一次执行（原 try 语义保持）；此处为正式边界透传
    toModel: (value) => value.view,
  };
}

/** oido_analyze 能力条目（P03.1a：已批准轻量通话能力；组合用例=service.analyzeVoice）。 */
export function oidoAnalyzeCapability(deps: OidoModuleDeps): CapabilityDescriptor<{ audio_ref: string; range_ms?: [number, number] }, { view: Record<string, unknown> }> {
  const service = new OidoHearingService(deps);
  return {
    id: 'oido_analyze',
    owner: 'oido',
    baselineOrder: 26,
    definition: OIDO_ANALYZE_DEFINITION,
    memoryOnlyAllowed: true,
    label: '深听语音',
    silent: false,
    quote: (db) => quoteBackgroundTool(db, 'oido_analyze'),
    parse: (raw, frozenSpec) => validateArgsAgainstSchema(raw, frozenSpec.function.parameters as { properties?: Record<string, never>; required?: string[] }) as { ok: true; value: { audio_ref: string; range_ms?: [number, number] } } | { ok: false; code: string; detail: string },
    run: (input, ctx) => service.analyzeVoice(input, ctx),
    toModel: (value) => value.view,
  };
}

/** 装配入口：把 oído 已迁能力登记进 registry（app-context 调用；本批=oido_get+oido_analyze）。
 *  参数为注册表的最小结构面（register），避免装配依赖整个 registry 类。 */
export function registerOidoCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: OidoModuleDeps): void {
  registry.register(oidoGetCapability(deps));
  registry.register(oidoAnalyzeCapability(deps));
}
