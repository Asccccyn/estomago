// modules/conversation/module.ts（P04.1）：conversation 域能力登记。
// 定义逐字正本；投影=owner（projectConversationRead / 发布回执透传）；quote 沿既有证据；
// memoryOnly 按 MEMORY_ONLY_TOOLS 现行清单逐项声明；label 沿原 TOOL_LABELS。
import { quoteBackgroundTool } from '../../runtime/background-tool-cost.ts';
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import { projectConversationRead } from './projection.ts';
import { ConversationToolsService } from './service.ts';

/** conversation_read 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const CONVERSATIONREAD_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      // WP4（MANUAL_HANDOFF_JUDGE_SWITCH_V1 §7.2，2026-10-08）：主模型只读
      // 原文回读——已知消息/范围的直接展开，不经判断器；房间由宿主派生
      //（模型不能自填别的房间）；不含 UI 思考/草稿/system/tool；只读无副作用
      //（不推进 hold 书签、不制造气泡、不触发明开续期）
      name: 'conversation_read',
      description: '读取本房间已保存的聊天原文（只读）。围绕某条已知消息读前后文，或按序号范围读，长文自动分页。只返回真实用户消息与已正式发布的助手消息；不含思考、草稿或系统内容。读取不产生任何记录动作。',
      parameters: {
        type: 'object',
        properties: {
          around_seq: { type: 'integer', minimum: 1, description: '定位锚点序号（对话里每条消息开头的 [N]）：读它前后各若干条' },
          revision: { type: 'integer', minimum: 1, description: '可选：锚点消息的指定修订号（读不到如实报错，不以当前修订冒充）' },
          before: { type: 'integer', minimum: 1, maximum: 50, description: '锚点之前读几条（默认 5）' },
          after: { type: 'integer', minimum: 1, maximum: 50, description: '锚点之后读几条（默认 5）' },
          from_sequence: { type: 'integer', minimum: 1, description: '范围模式：起始序号（含）' },
          to_sequence: { type: 'integer', minimum: 1, description: '范围模式：结束序号（含）' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '单页最多条数（默认 20）' },
          cursor: { type: 'object', description: '续页游标（上一页返回的 next_cursor 原样传入）' },
        },
        additionalProperties: false,
      },
    }
  };

/** chat_send_text 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const CHATSENDTEXT_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'chat_send_text',
      description: '以char身份向当前私聊正式发送一条文字消息（自主活动中唯一公开发言途径；普通最终回复不会自动发布）。同一幂等键重试只发一次。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 8000 },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['text', 'idempotency_key'], additionalProperties: false,
      },
    }
  };

/** chat_send_attachment 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const CHATSENDATTACHMENT_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'chat_send_attachment',
      description: '以char当前房间身份正式发布附件消息（图片/表情/语音）。只向当前授权私聊投递；同一工具调用重试只发一次。asset_id 必须是已存在的资产。',
      parameters: {
        type: 'object',
        properties: {
          asset_id: { type: 'string', minLength: 1, maxLength: 128 },
          presentation: { type: 'string', enum: ['image', 'sticker', 'voice'] },
          content: { type: 'string', maxLength: 4000 },
        },
        required: ['asset_id', 'presentation'], additionalProperties: false,
      },
    }
  };

export type ConversationModuleDeps = {
  db: import('../../db/connection.ts').Db;
  tz?: string | null;
  messages?: import('../../messages/service.ts').MessageService | null;
  media?: import('../../media/assets.ts').MediaService | null;
  events?: import('../../events/service.ts').EventService | null;
  archiveSync?: { drainOnce(): Promise<unknown> } | null;
};

/** 装配入口：conversation 域已迁能力（conversation_read/chat_send_text/chat_send_attachment）。 */
export function registerConversationCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: ConversationModuleDeps): void {
  const service = new ConversationToolsService(deps);
  registry.register(toolCapability({
    id: 'conversation_read', baselineOrder: 5, definition: CONVERSATIONREAD_DEFINITION, memoryOnlyAllowed: true, label: '读聊天原文',
    run: (input: Record<string, unknown>, ctx) => Promise.resolve(service.conversationRead(input, ctx)),
    toModel: (value) => projectConversationRead(value),
  }));
  registry.register(toolCapability({
    id: 'chat_send_text', baselineOrder: 22, definition: CHATSENDTEXT_DEFINITION, memoryOnlyAllowed: false, label: '发消息',
    run: (input: { text: string; idempotency_key: string }, ctx) => Promise.resolve(service.chatSendText(input, ctx)),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    id: 'chat_send_attachment', baselineOrder: 24, definition: CHATSENDATTACHMENT_DEFINITION, memoryOnlyAllowed: false, label: '发附件',
    run: (input: { asset_id: string; presentation: 'image' | 'sticker' | 'voice'; content?: string }, ctx) => service.chatSendAttachment(input, ctx),
    toModel: (value) => value,
  }));
}
