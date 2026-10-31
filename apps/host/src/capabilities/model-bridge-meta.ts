// capabilities/model-bridge-meta.ts（S17b 批次3/4）：discovery 协议入口元数据与免费政策。
// 三个协议入口可有自身元数据（D39），不再藏业务名单；免费政策属 discovery 所有。
export type DiscoveryMeta = { memoryOnlyAllowed: boolean; label: string; silent: boolean };

/** 三个协议入口的元数据（不含任何业务工具名）。 */
export const DISCOVERY_META: Record<string, DiscoveryMeta> = {
  tool_catalog: { memoryOnlyAllowed: true, label: '查看工具目录', silent: false },
  tool_define: { memoryOnlyAllowed: true, label: '读取工具定义', silent: false },
  tool_invoke: { memoryOnlyAllowed: true, label: '调用工具', silent: false },
};

/** Presentation only: resolving a requested name grants no execution permission. */
export function toolPresentation(registry: import('./registry.ts').CapabilityRegistry | null, wireName: string, args: Record<string, unknown>) {
  const target = (wireName === 'tool_define' || wireName === 'tool_invoke') && typeof args.name === 'string' ? args.name : wireName;
  const descriptor = registry?.get(target);
  return {
    effective_tool: descriptor ? target : wireName,
    label: descriptor ? (wireName === 'tool_define' ? '读取工具定义 · ' : '') + descriptor.label : DISCOVERY_META[wireName]?.label ?? wireName,
  };
}

/** discovery 免费政策（原 VERIFIED_FREE_HANDLERS 中 catalog/define 两项）。 */
export function isDiscoveryFree(name: string): boolean {
  return name === 'tool_catalog' || name === 'tool_define';
}
