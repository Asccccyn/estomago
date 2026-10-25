// capabilities/registry.ts（P02.1）：最小显式能力注册表。
// 做（04 §H）：确定性枚举（按 baselineOrder）、名称唯一、已配置实现查找、显式缺失拒绝、
// 可替换测试实现（构造即可换）、架构检查用的声明清单。
// 不做：业务数据库查询、跨服务重试、动态刷新旧窗口、自动发现并授权新工具、
// 万能 fetch、自动降级到旧 handler、通用 DAG 执行。不访问远端、不动态授予新能力。
import type { Db } from '../db/connection.ts';
import type { BackgroundToolQuote, CapabilityOutcome, HostToolSpec, ToolExecContext } from './contracts.ts';

export type CapabilityParseResult<I> = { ok: true; value: I } | { ok: false; code: string; detail: string };

/** 一个已登记能力 = 定义 + 校验 + handler + 唯一模型投影 + 费用声明 + 模式资格（04 §A）。 */
export type CapabilityDescriptor<I = Record<string, unknown>, O = unknown> = {
  /** 与原工具名一致（oido_get 等）；也是定义 function.name。 */
  readonly id: string;
  readonly owner: string;
  /** host-only 装配顺序（tool-ownership baselineOrder）；不进入工具定义。 */
  readonly baselineOrder: number;
  /** 定义工厂（唯一来源；04 §J definition() 口径）：每次目录装配调用，动态词表随正本；
   *  静态能力返回现有定义常量。旧窗仍读冻结 spec，本工厂仅供新窗目录装配。 */
  readonly definition: () => HostToolSpec;
  /** D39：已批准的通话 memory_only 资格，按现行清单逐项声明；注册表不自动扩权。 */
  readonly memoryOnlyAllowed: boolean;
  /** turn.tool 事件身份（原 TOOL_LABELS 值）。 */
  readonly label: string;
  /** 内部协议工具不发事件（原 SILENT_TOOLS 语义）。 */
  readonly silent: boolean;
  /** 可信费用政策（照搬 quoteBackgroundTool 证据；不以名称推断免费——D40 非背景不强加报价）。 */
  readonly quote: (db: Db) => BackgroundToolQuote;
  /** 参数校验：用请求窗口的冻结 schema（旧窗原 spec），不用当前新定义替代。 */
  readonly parse: (rawArgs: Record<string, unknown>, frozenSpec: HostToolSpec) => CapabilityParseResult<I>;
  /** 实际 handler；产出内部结果，不直接作为模型 output。 */
  readonly run: (input: I, ctx: ToolExecContext) => Promise<CapabilityOutcome<O>>;
  /** 唯一模型投影边界（每调用恰一次）。 */
  readonly toModel: (value: O, input: I) => Record<string, unknown>;
};

/** 注册表内存储的类型擦除形态：parse 产出后按条目自身合同流转，跨条目互不调用；
 *  类型安全由条目声明处的泛型（CapabilityDescriptor<I,O>）承担，擦除仅在注册表边界。 */
type ErasedDescriptor = {
  readonly id: string;
  readonly owner: string;
  readonly baselineOrder: number;
  readonly definition: () => HostToolSpec;
  readonly memoryOnlyAllowed: boolean;
  readonly label: string;
  readonly silent: boolean;
  readonly quote: (db: Db) => BackgroundToolQuote;
  readonly parse: (rawArgs: Record<string, unknown>, frozenSpec: HostToolSpec) => CapabilityParseResult<any>;
  readonly run: (input: any, ctx: ToolExecContext) => Promise<CapabilityOutcome<any>>;
  readonly toModel: (value: any, input: any) => Record<string, unknown>;
};

export interface CatalogProvider {
  /** 窄目录接口：按 baselineOrder 排序、逐条目调用定义工厂（Supervisor 消费同一 Registry）。 */
  currentCatalog(): HostToolSpec[];
}

export class CapabilityRegistry {
  private caps = new Map<string, ErasedDescriptor>();

  /** 显式登记；重复名/缺件/定义名不符/顺序非法一律拒绝（fail-fast，不静默）。 */
  register(descriptor: CapabilityDescriptor<any, any>): void {
    const id = descriptor?.id;
    if (typeof id !== 'string' || id.length === 0) throw new Error('CAPABILITY_ID_INVALID');
    if (this.caps.has(id)) throw new Error(`CAPABILITY_ALREADY_REGISTERED:${id}`);
    for (const key of ['parse', 'run', 'toModel', 'quote'] as const) {
      if (typeof descriptor[key] !== 'function') throw new Error(`CAPABILITY_INCOMPLETE:${id}:${key}`);
    }
    let defName: string | undefined;
    try { defName = descriptor.definition?.().function?.name; } catch { /* 非法工厂按 mismatch 处理 */ }
    if (typeof descriptor.definition !== 'function' || defName !== id) {
      throw new Error(`CAPABILITY_DEFINITION_MISMATCH:${id}`);
    }
    if (!Number.isInteger(descriptor.baselineOrder) || descriptor.baselineOrder < 1) {
      throw new Error(`CAPABILITY_ORDER_INVALID:${id}`);
    }
    if (typeof descriptor.memoryOnlyAllowed !== 'boolean' || typeof descriptor.silent !== 'boolean') {
      throw new Error(`CAPABILITY_FLAG_INVALID:${id}`);
    }
    this.caps.set(id, descriptor);
  }

  has(id: string): boolean {
    return this.caps.has(id);
  }

  /** 显式缺失拒绝：未登记返回 null，由调用方沿现行"未迁移集合"路由，不得回退旧实现。 */
  get(id: string): ErasedDescriptor | null {
    return this.caps.get(id) ?? null;
  }

  /** 架构检查/装配清单用：按 baselineOrder 确定性枚举。 */
  listByBaselineOrder(): ErasedDescriptor[] {
    return [...this.caps.values()].sort((a, b) => a.baselineOrder - b.baselineOrder);
  }

  /** S17b 批次3：目录唯一来源——按 baselineOrder 排序、逐条目调用定义工厂。
   *  不缓存（动态词表随正本）；重复 ID/定义名一致在 register 时已检查。 */
  currentCatalog(): HostToolSpec[] {
    return this.listByBaselineOrder().map((d) => d.definition());
  }

  get size(): number {
    return this.caps.size;
  }
}
