// tests/helpers/probe-module.ts（P08 演练A / A26）：只读探针模块。
// 架构兼容性探针：在测试目录（不进生产目录/默认工具集合）声明一个新只读能力，
// 只改"模块声明+处理器+测试装配"接入真实 registry 与 Host fixture——证明新增能力
// 不需要修改 supervisor/消息核心/通用执行器的任何业务分支（A26 局部化证据）。
// 该探针读取既有已发布资产读面（OidoSourceRepository.sourceAllowed 同源谓词），
// 不创建新生产端口、不宣称情绪/媒体新功能。
import type { CapabilityDescriptor } from '../../apps/host/src/capabilities/registry.ts';
import { toolCapability } from '../../apps/host/src/capabilities/domain-factory.ts';
import type { HostToolSpec } from '../../apps/host/src/capabilities/contracts.ts';
import type { Db } from '../../apps/host/src/db/connection.ts';

export const PROBE_TOOL_NAME = 'probe_published_voice_check';

/** 探针定义（测试专属；不进 buildHostTools 基线顺序）——只读：给定 audio_ref 报告
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

export type ProbeModuleDeps = { db: Db };

/** 探针能力条目——与生产条目同一声明面（定义/校验/费用/资格/投影五件事一次声明）。 */
export function registerProbeModule(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: ProbeModuleDeps): void {
  registry.register(toolCapability({
    id: PROBE_TOOL_NAME,
    baselineOrder: 99, // 测试专属；不进生产基线顺序
    definition: PROBE_DEFINITION,
    memoryOnlyAllowed: false,
    label: PROBE_TOOL_NAME,
    silent: false,
    quote: () => ({ toolName: PROBE_TOOL_NAME, maxCostMicroUsd: 0, verifiedFree: true }), // 本地 SQL 只读
    run: (input: { audio_ref: string }, ctx) => {
      const assetId = input.audio_ref.slice('est:'.length);
      // 复用既有已发布资产可见性谓词（同一 SQL 条件，不放宽）——只读 SELECT
      const row = deps.db.prepare(`SELECT a.content_sha256 FROM media_assets a
        JOIN message_attachments ma ON ma.asset_id=a.id
        JOIN messages msg ON msg.id=ma.message_id AND msg.current_revision=ma.revision
        WHERE a.id=? AND a.state='available' AND ma.presentation='voice'
          AND msg.conversation_id=? LIMIT 1`).get(assetId, ctx.roomId);
      return Promise.resolve({ ok: true, value: { bound: Boolean(row) } as Record<string, unknown> });
    },
    toModel: (value) => value,
  }));
}
