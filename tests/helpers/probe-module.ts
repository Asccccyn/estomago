// tests/helpers/probe-module.ts（P08 演练A / A26·A03·A27 重做版）：只读探针模块。
// 架构兼容性探针：测试目录中声明一个新只读能力，只改"模块声明+处理器+测试装配"。
// S17 裁定：probe 只拿**现有资产授权读取方法的窄结构端口**（PublishedVoiceReader），
// 由装配处提供实现（复用 OidoSourceRepository 既有谓词）——不拿完整 DB、不复制授权 SQL。
// probe 不进生产默认目录/基线顺序；本文件位于测试目录。
import type { CapabilityDescriptor } from '../../apps/host/src/capabilities/registry.ts';
import { toolCapability } from '../../apps/host/src/capabilities/domain-factory.ts';
import type { HostToolSpec, ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';

export const PROBE_TOOL_NAME = 'probe_published_voice_check';

/** 窄结构端口：现有资产授权读取方法的只读面（装配处用 OidoSourceRepository 实现）。 */
export interface PublishedVoiceReader {
  isPublishedVoiceInRoom(assetId: string, roomId: string): boolean;
}

/** 探针定义（测试专属；不进生产基线顺序）——只读：给定 audio_ref 报告
 *  "该资产是否当前会话已发布语音"。 */
export const PROBE_DEFINITION: HostToolSpec = {
  type: 'function',
  function: {
    name: PROBE_TOOL_NAME,
    description: '只读探针（架构验证用）：检查 audio_ref 是否指向本会话已发布的语音资产。返回 { bound: boolean }。',
    parameters: {
      type: 'object',
      properties: {
        audio_ref: { type: 'string', minLength: 5, maxLength: 133, description: '语音引用，形如 est:<asset_id>' },
      },
      required: ['audio_ref'], additionalProperties: false,
    },
  },
};

export type ProbeModuleDeps = { publishedVoiceReader: PublishedVoiceReader };

/** 探针能力条目——与生产条目同一声明面（定义/校验/费用/资格/投影一次声明）。 */
export function registerProbeModule(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: ProbeModuleDeps): void {
  registry.register(toolCapability({
    id: PROBE_TOOL_NAME,
    owner: 'probe',
    baselineOrder: 99, // 测试专属；不进生产基线顺序
    definition: PROBE_DEFINITION,
    memoryOnlyAllowed: false,
    label: PROBE_TOOL_NAME,
    silent: false,
    free: true, // 本地只读（装配处声明，非按名猜测）
    run: (input: { audio_ref: string }, ctx: ToolExecContext) => {
      const assetId = input.audio_ref.slice('est:'.length);
      return Promise.resolve({ ok: true, value: { bound: deps.publishedVoiceReader.isPublishedVoiceInRoom(assetId, ctx.roomId) } as Record<string, unknown> });
    },
    toModel: (value) => value,
  }));
}
