// capabilities/model-bridge.ts（S17b 批次3）：三个 discovery 协议入口的自身元数据与
// 免费政策（fee 归 discovery 所有，不藏业务名单）。catalog/define/invoke 的
// 冻结目录/已见校验在批次4 迁入本文件。
export type DiscoveryMeta = { memoryOnlyAllowed: boolean; label: string; silent: boolean };

/** 三个协议入口的元数据（D39 允许 discovery 自身元数据；不含任何业务工具名）。 */
export const DISCOVERY_META: Record<string, DiscoveryMeta> = {
  tool_catalog: { memoryOnlyAllowed: true, label: 'tool_catalog', silent: false },
  tool_define: { memoryOnlyAllowed: true, label: 'tool_define', silent: false },
  tool_invoke: { memoryOnlyAllowed: true, label: 'tool_invoke', silent: false },
};

/** discovery 免费政策（原 VERIFIED_FREE_HANDLERS 中 catalog/define 两项；fee=discovery 所有）。 */
export function isDiscoveryFree(name: string): boolean {
  return name === 'tool_catalog' || name === 'tool_define';
}
