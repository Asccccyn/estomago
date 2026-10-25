// capabilities/domain-factory.ts（P04）：域能力条目通用工厂。
// 每迁一个能力的"六件事"中的声明面收在这里：定义/校验/费用/资格/label/silent 逐项声明，
// handler 与投影由所属域提供。宿主元数据（baselineOrder/memoryOnlyAllowed/label/silent）不进模型 schema。
// run 支持两种形态：CapabilityOutcome（新风格，oído 域）或既有 ToolExecResult 形状（逐字搬迁的
// 方法体）——工厂在边界适配（output=内部结果交给 toModel；失败 output=error 交失败投影），
// 保证搬迁正文零改写、投影输入与旧 execute() 外层投影一致。
import { quoteBackgroundTool } from '../runtime/background-tool-cost.ts';
import { validateArgsAgainstSchema } from './validation.ts';
import type { Db } from '../db/connection.ts';
import type { BackgroundToolQuote, CapabilityOutcome, HostToolSpec, ToolExecContext, ToolExecResult } from './contracts.ts';
import type { CapabilityDescriptor } from './registry.ts';

export type SimpleToolCapability<I extends Record<string, unknown>, O> = {
  id: string;
  baselineOrder: number;
  /** 定义或定义工厂（唯一来源；动态词表传工厂）。 */
  definition: HostToolSpec | (() => HostToolSpec);
  /** owner 由模块显式提供（S17b 批次3：删除按名前缀猜测）。 */
  owner: string;
  memoryOnlyAllowed: boolean;
  label: string;
  silent?: boolean;
  run: (input: I, ctx: ToolExecContext) => Promise<CapabilityOutcome<O> | ToolExecResult> | CapabilityOutcome<O> | ToolExecResult;
  /** 唯一模型投影（owner 拥有；输入=内部成功结果，与旧外层 modelResult(effectiveName,args,output) 同输入）。 */
  toModel: (value: O, input: I) => Record<string, unknown>;
  /** 免费资格声明（模块所有；仅现有已核免费事实，不按名字/只读/本地猜）。 */
  free?: boolean;
  quote?: (db: Db) => BackgroundToolQuote;
};

function isCapabilityOutcome<O>(r: CapabilityOutcome<O> | ToolExecResult): r is CapabilityOutcome<O> {
  return 'value' in r || ('ok' in r && (r as CapabilityOutcome<O>).ok === true && 'value' in (r as Record<string, unknown>)) || ('ok' in r && (r as CapabilityOutcome<O>).ok === false && !('output' in (r as Record<string, unknown>)));
}

export function toolCapability<I extends Record<string, unknown>, O>(o: SimpleToolCapability<I, O>): CapabilityDescriptor<I, O> {
  // S17b 批次3裁定：不在注册时提前执行并永久缓存动态定义——工厂原样保留
  const defFactory: () => HostToolSpec = typeof o.definition === 'function'
    ? o.definition
    : () => o.definition as HostToolSpec;
  return {
    id: o.id,
    owner: o.owner,
    baselineOrder: o.baselineOrder,
    definition: defFactory,
    memoryOnlyAllowed: o.memoryOnlyAllowed,
    label: o.label,
    silent: o.silent ?? false,
    quote: o.free
      ? (() => ({ toolName: o.id, maxCostMicroUsd: 0, verifiedFree: true }))
      : (o.quote ?? ((db) => quoteBackgroundTool(db, o.id))),
    parse: (raw, frozenSpec) => validateArgsAgainstSchema(raw, frozenSpec.function.parameters as { properties?: Record<string, never>; required?: string[] }) as { ok: true; value: I } | { ok: false; code: string; detail: string },
    run: async (input, ctx) => {
      const r = await o.run(input, ctx);
      if (isCapabilityOutcome<O>(r)) return r;
      // 旧 ToolExecResult 形状适配（逐字搬迁体；失败投影由执行外壳统一做）
      if (r.ok) return { ok: true, value: r.output as O, ...(r.seenAdditions !== undefined ? { seenAdditions: r.seenAdditions } : {}), ...(r.imageRefs !== undefined ? { imageRefs: r.imageRefs } : {}) };
      return { ok: false, error: r.output };
    },
    toModel: o.toModel,
  };
}
