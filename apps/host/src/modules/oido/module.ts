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

/** oido_capabilities 定义唯一正本（原 host-tools oidoDefinitions 内该块逐字搬迁）。 */
export const OIDO_CAPABILITIES_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      // R5（2026-10-23）：补齐 oído 六工具 façade（此前仅 analyze/get）
      name: 'oido_capabilities',
      description: '查看 oído 声学分析服务当前能力状态（各分面开关）。仅诊断用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  };

/** oido_view 定义唯一正本（原 host-tools oidoDefinitions 内该块逐字搬迁）。 */
export const OIDO_VIEW_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'oido_view',
      description: '读取深听结果的测量图（波形+基频 PNG）。返回 base64 图与元数据；原生图块直送主模型的运输路径尚未接通（如实声明），图主要供界面展示。',
      parameters: {
        type: 'object',
        properties: {
          analysis_id: { type: 'string', minLength: 1, maxLength: 128 },
          range_ms: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        },
        required: ['analysis_id'], additionalProperties: false,
      },
    }
  };

/** oido_find 定义唯一正本（原 host-tools oidoDefinitions 内该块逐字搬迁）。 */
export const OIDO_FIND_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'oido_find',
      description: '在已分析的语音转写文字里找匹配片段（转写文字匹配，不是音频语义检索）。返回区间毫秒与命中文本；未对齐/无转写如实报。',
      parameters: {
        type: 'object',
        properties: {
          audio_ref: { type: 'string', pattern: '^est:[A-Za-z0-9_-]{1,128}$' },
          query: { type: 'string', minLength: 1, maxLength: 200 },
          mode: { type: 'string', enum: ['substring', 'fuzzy'] },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
          cursor: { type: 'string', minLength: 8, maxLength: 200 },
        },
        required: ['audio_ref', 'query'], additionalProperties: false,
      },
    }
  };

/** oido_compare 定义唯一正本（原 host-tools oidoDefinitions 内该块逐字搬迁）。 */
export const OIDO_COMPARE_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'oido_compare',
      description: '对比两次深听分析的声学测量（音高/时长等）。无已批准个人基线时明确 unavailable，不做"比平时"类判断。',
      parameters: {
        type: 'object',
        properties: {
          left: { type: 'object', properties: { audio_ref: { type: 'string' } }, required: ['audio_ref'], additionalProperties: false },
          right: { type: 'object', properties: { audio_ref: { type: 'string' } }, required: ['audio_ref'], additionalProperties: false },
        },
        required: ['left', 'right'], additionalProperties: false,
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

export type OidoModuleDeps = { db: Db; oido: OidoAdapter | null; sources: OidoSourceRepository; audio?: import('./service.ts').AudioContentReader | null; artifacts?: import('./service.ts').ArtifactSaver | null };

/** oido_get 能力条目（P02 只此一项；id/baselineOrder/owner 按 tool-ownership.json）。 */
export function oidoGetCapability(deps: OidoModuleDeps): CapabilityDescriptor<OidoGetInput, OidoGetEvidence> {
  const service = new OidoHearingService(deps);
  return {
    id: 'oido_get',
    owner: 'oido',
    baselineOrder: 28,
    definition: () => OIDO_GET_DEFINITION,
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
    definition: () => OIDO_ANALYZE_DEFINITION,
    memoryOnlyAllowed: true,
    label: '深听语音',
    silent: false,
    quote: (db) => quoteBackgroundTool(db, 'oido_analyze'),
    parse: (raw, frozenSpec) => validateArgsAgainstSchema(raw, frozenSpec.function.parameters as { properties?: Record<string, never>; required?: string[] }) as { ok: true; value: { audio_ref: string; range_ms?: [number, number] } } | { ok: false; code: string; detail: string },
    run: (input, ctx) => service.analyzeVoice(input, ctx),
    toModel: (value) => value.view,
  };
}

/** 轻量 oído 工具通用条目（capabilities/view/find/compare）：定义/校验/费用/资格逐项声明；
 *  投影=透传（这四项的模型面形状由 service 直接构造，现行无 model-results 分支）。 */
function oidoSimpleCapability<I extends Record<string, unknown>>(o: {
  id: string; baselineOrder: number; definition: HostToolSpec | (() => HostToolSpec); memoryOnlyAllowed: boolean;
  run: (input: I, ctx: import('../../capabilities/contracts.ts').ToolExecContext) => Promise<import('../../capabilities/contracts.ts').CapabilityOutcome<Record<string, unknown>>>;
}, deps: OidoModuleDeps): CapabilityDescriptor<I, Record<string, unknown>> {
  const service = new OidoHearingService(deps);
  void service;
  // 惰性保留工厂（不提前执行）；窄化用 cast 表达
  const defFactory: () => HostToolSpec = typeof o.definition === 'function'
    ? o.definition
    : () => o.definition as HostToolSpec;
  return {
    id: o.id,
    owner: 'oido',
    baselineOrder: o.baselineOrder,
    definition: defFactory,
    memoryOnlyAllowed: o.memoryOnlyAllowed,
    label: o.id,
    silent: false,
    quote: (db) => quoteBackgroundTool(db, o.id),
    parse: (raw, frozenSpec) => validateArgsAgainstSchema(raw, frozenSpec.function.parameters as { properties?: Record<string, never>; required?: string[] }) as { ok: true; value: I } | { ok: false; code: string; detail: string },
    run: o.run,
    toModel: (value) => value,
  };
}

/** 装配入口：把 oído 已迁能力登记进 registry（app-context 调用）。
 *  参数为注册表的最小结构面（register），避免装配依赖整个 registry 类。 */
export function registerOidoCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: OidoModuleDeps): void {
  registry.register(oidoGetCapability(deps));
  registry.register(oidoAnalyzeCapability(deps));
  const service = new OidoHearingService(deps);
  registry.register(oidoSimpleCapability({
    id: 'oido_capabilities', baselineOrder: 30, definition: () => OIDO_CAPABILITIES_DEFINITION, memoryOnlyAllowed: true,
    run: (_input: Record<string, unknown>, ctx) => service.capabilities(ctx),
  }, deps));
  registry.register(oidoSimpleCapability({
    id: 'oido_view', baselineOrder: 31, definition: () => OIDO_VIEW_DEFINITION, memoryOnlyAllowed: false,
    run: (input: { analysis_id: string; range_ms?: [number, number] }, ctx) => service.view(input, ctx),
  }, deps));
  registry.register(oidoSimpleCapability({
    id: 'oido_find', baselineOrder: 32, definition: () => OIDO_FIND_DEFINITION, memoryOnlyAllowed: false,
    run: (input: { audio_ref: string; query: string; mode?: string; limit?: number; cursor?: string }, ctx) => service.find(input, ctx),
  }, deps));
  registry.register(oidoSimpleCapability({
    id: 'oido_compare', baselineOrder: 33, definition: () => OIDO_COMPARE_DEFINITION, memoryOnlyAllowed: false,
    run: (input: { left: { audio_ref: string }; right: { audio_ref: string } }, ctx) => service.compare(input, ctx),
  }, deps));
}
