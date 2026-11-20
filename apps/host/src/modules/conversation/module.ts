// modules/conversation/module.ts（P04.1）：conversation 域能力登记。
// 定义逐字正本；投影=owner（projectConversationRead / 发布回执透传）；quote 沿既有证据；
// memoryOnly 按 MEMORY_ONLY_TOOLS 现行清单逐项声明；label 沿原 TOOL_LABELS。
import { quoteBackgroundTool } from '../../runtime/background-tool-cost.ts';
import { toolCapability } from '../../capabilities/domain-factory.ts';
import type { CapabilityDescriptor } from '../../capabilities/registry.ts';
import type { HostToolSpec } from '../../capabilities/contracts.ts';
import type { SpeakerLabels } from '../../identity/speaker-labels.ts';
import { projectConversationRead } from './projection.ts';
import { ConversationToolsService } from './service.ts';

/** conversation_read 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。
 *  包4无seq整改（2026-11-18，裁定7/8）：模型面不再出现消息序号——旧 around_seq/
 *  from_sequence/to_sequence 参数与条目 [N] 序号随新窗合同退役（旧冻结窗仍按其
 *  冻结 schema 走旧形状，服务端按参数形状分流，见 service.ts C3 注释）。首次定位
 *  旧材料用 locate（日期/说话人/关键词→最小边界候选）；明确重看用 anchor（说话人+
 *  逐字原话）；最新一页用 latest；续读用不透明 cursor（原样传回）。 */
export const CONVERSATIONREAD_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      // WP4（MANUAL_HANDOFF_JUDGE_SWITCH_V1 §7.2，2026-10-08）：主模型只读
      // 原文回读——不经判断器；房间由宿主派生（模型不能自填别的房间）；
      // 不含 UI 思考/草稿/system/tool；只读无副作用
      name: 'conversation_read',
      description: '读取本房间已发布的聊天原文（只读，无记录动作）。五种进入方式（选一）：①locate——按日期/说话人/关键词定位旧片段，返回最小边界候选（少量摘录+续读 cursor），不展开全文；②anchor——说话人+该消息正文中一段连续逐字原话，围绕那条消息读前后文（用于重看已知内容）；③latest=true——从最新已发布消息往回读一页；④archive_id——用搜索存档回执里的 ID 读取保存时的原文；⑤cursor——上一页或定位候选返回的游标，原样传回续读。长文自动分页。只返回真实用户消息与已正式发布的助手消息；不含思考、草稿或系统内容。已实际送达的片段返回短回执；用户明确要求重看时用 reread=true。当前上下文里已看到的对话不需要本工具——存档/写原话/跟踪事件直接在对应工具里给锚点即可。',
      parameters: {
        type: 'object',
        properties: {
          locate: {
            type: 'object', additionalProperties: false,
            description: '按线索定位旧片段（date 或 text 至少给一项）——只返回最小边界候选，不读全文',
            properties: {
              date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '那天的日期（本地时区 YYYY-MM-DD）；配 date_to 表区间' },
              date_to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '区间终日（含当天）；单日省略' },
              speaker: { type: 'string', enum: ['宿主用户', 'char'], description: '可选：限定说话人' },
              text: { type: 'string', minLength: 1, maxLength: 100, description: '原话中的连续逐字片段（1-100 字）' },
            },
          },
          anchor: {
            type: 'object', additionalProperties: false,
            description: '围绕一条已知消息读前后文（说话人+逐字原话定位；多处同字会返回候选）',
            properties: {
              speaker: { type: 'string', enum: ['宿主用户', 'char'], description: '该消息的说话人' },
              quote: { type: 'string', minLength: 1, maxLength: 300, description: '该消息正文中一段连续的逐字原话（1-300 字）' },
              revision: { type: 'integer', minimum: 1, description: '可选：按你曾见过的指定修订读（读不到如实报错，不以当前修订冒充）' },
            },
            required: ['speaker', 'quote'],
          },
          archive_id: { type: 'string', minLength: 1, maxLength: 128, description: 'archives_search 命中的 archive_id，读取该存档原样保留的版本' },
          latest: { type: 'boolean', const: true, description: '从最新已发布消息往回读一页，填 true' },
          before: { type: 'integer', minimum: 1, maximum: 50, description: 'anchor 模式：锚点之前读几条（默认 5）' },
          after: { type: 'integer', minimum: 1, maximum: 50, description: 'anchor 模式：锚点之后读几条（默认 5）' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '单页最多条数（默认 20）' },
          cursor: {
            type: 'object', additionalProperties: false, required: ['c'],
            properties: { c: { type: 'string', minLength: 1, maxLength: 2048, description: '上一页/定位候选返回的 cursor 原样传入' } },
          },
          reread: { type: 'boolean', description: '仅用户明确要求重看、逐字核对时，本次仍交付正文。' },
        },
        oneOf: ['locate', 'anchor', 'archive_id', 'latest', 'cursor'].map(key => ({ required: [key] })),
        additionalProperties: false,
      },
    }
  };

/** chat_send_text 定义唯一正本（原 host-tools 域工厂内该块逐字搬迁）。 */
export const CHATSENDTEXT_DEFINITION: HostToolSpec = {
    type: 'function',
    function: {
      name: 'chat_send_text',
      description: '以你的身份向当前私聊正式发送一条文字消息。仅用于自主活动场景需要主动公开说话时（如预约到点、后台活动的主动汇报）；普通对话的最终回复由发布链自动发出，不需要、也不要用本工具重复发送。同一幂等键重试只发一次。',
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
      description: '以你当前房间身份正式发布附件消息（图片/表情/语音/SVG·HTML 代码作品）。只向当前授权私聊投递；同一工具调用重试只发一次。asset_id 必须是已存在的资产；SVG/HTML 作品用 presentation=work（隔离预览交付），普通位图用 image。',
      parameters: {
        type: 'object',
        properties: {
          asset_id: { type: 'string', minLength: 1, maxLength: 128 },
          presentation: { type: 'string', enum: ['image', 'sticker', 'voice', 'work'] },
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
  /** 包4 §6.2：conversation_read 的 speaker 标签投影用（身份配置的双方姓名）。 */
  speakerLabels?: SpeakerLabels;
  archives?: Pick<import('../archives/service.ts').ArchiveService, 'archiveOriginals'>;
};

/** 装配入口：conversation 域已迁能力（conversation_read/chat_send_text/chat_send_attachment）。 */
export function registerConversationCapabilities(registry: { register(d: CapabilityDescriptor<any, any>): void }, deps: ConversationModuleDeps): void {
  const service = new ConversationToolsService(deps);
  const labels = deps.speakerLabels;
  registry.register(toolCapability({
    owner: 'conversation',
    id: 'conversation_read', baselineOrder: 5, free: true, definition: () => CONVERSATIONREAD_DEFINITION, memoryOnlyAllowed: true, label: '读聊天原文',
    run: async (input: Record<string, unknown>, ctx) => (await service.conversationReadArchive(input, ctx)) ?? service.conversationRead(input, ctx),
    toModel: (value) => projectConversationRead(value, labels),
  }));
  registry.register(toolCapability({
    owner: 'conversation',
    id: 'chat_send_text', baselineOrder: 22, free: true, definition: () => CHATSENDTEXT_DEFINITION, memoryOnlyAllowed: false, label: '发消息',
    run: (input: { text: string; idempotency_key: string }, ctx) => Promise.resolve(service.chatSendText(input, ctx)),
    toModel: (value) => value,
  }));
  registry.register(toolCapability({
    owner: 'conversation',
    id: 'chat_send_attachment', baselineOrder: 24, free: true, definition: () => CHATSENDATTACHMENT_DEFINITION, memoryOnlyAllowed: false, label: '发附件',
    run: (input: { asset_id: string; presentation: 'image' | 'sticker' | 'voice' | 'work'; content?: string }, ctx) => service.chatSendAttachment(input, ctx),
    toModel: (value) => value,
  }));
}
