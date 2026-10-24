import { oidoModelView } from '../integrations/oido/model-view.ts';
import { sliceByByteBudget, TRANSCRIPT_PAGE_BUDGET_BYTES } from '../media/model-input.ts';
import { modelResult, modelFailure } from './model-results.ts';
// 宿主固定工具集（§3.3/§8.2）：开窗即固定 allowlist，不临提醒才改工具集合。
//  - memory_hold：映射 Mariposa memory.hold（宿主自动化路径必须带 operation_id，§5 生命周期契约）。
//    operation_id 由宿主从 tool_call 派生（模型不能自编）；无 Mariposa 客户端 → 能力缺口，明确拒绝。
//    契约对齐 mariposa@75378ab（她的 1005 裁定）：original_title 必填≤30字、categories 数组九分类枚举、
//    creation_mode 枚举、memory_date+date_confidence。心情已随词表终版接入（她当晚冻结 7 大类）：
//    mood_tags=大类枚举（≤3 个）+ mood_note 自由文字（可写可不写），映射 mariposa hold 的
//    mood{tags,text}。词表正本=mariposa memory.mood.vocab；此处枚举只是形状门，域校验以服务端为准。
//  - our_words=模型指认（她的裁定）：模型只给 quotes（想逐字引用的片段）；网关在"发起请求实际看见的
//    原文"里逐字核对（对不上=拒绝，不替模型圆谎），说话人按消息来源自动映射（owner=qiaosheng/
//    assistant=jiaming），引用按 mariposa 现成机制钉住（source_selections：source_message_id+内容hash，
//    句内片段带 char offset）——our_words 逐字保真，模型零复述 token。
//  - context_review_complete：宿主本地验证（review/账本/收据），不依赖模型自报成功名单。
// 工具执行串行（写操作依赖顺序；review_complete 最后验证，不并发抢先放行）。
import { buildDeferredTools, DISCOVERY_NAMES, storedToolset, definitionId, definitionWasSeen } from './tool-discovery.ts';
import { initialDefinitionSeen, initialVisibleTools } from './tool-initial-visible.ts';
import { sha256Hex } from '../util/id.ts';
import { IdentityService as IdentityServiceStatic } from '../identity/service.ts';
import type { Db } from '../db/connection.ts';
import type { MariposaClient } from '../integrations/mariposa/client.ts';
import { SurfacingRepository } from '../memory-surfacing/repository.ts';
import { executeMemoryReadFull } from '../memory-surfacing/detail-tool.ts';
import type { RotationReviewService } from '../context/rotation-review.ts';
import type { HoldCheckpointService } from '../memory/hold-checkpoint.ts';
import { quoteBackgroundTool } from './background-tool-cost.ts';
import { OIDO_GET_DEFINITION, OIDO_ANALYZE_DEFINITION, OIDO_CAPABILITIES_DEFINITION, OIDO_VIEW_DEFINITION, OIDO_FIND_DEFINITION, OIDO_COMPARE_DEFINITION } from '../modules/oido/module.ts';
import { TRANSCRIPT_READ_DEFINITION, CALL_CONTROL_DEFINITION } from '../modules/voice/module.ts';
import { CONVERSATIONREAD_DEFINITION, CHATSENDTEXT_DEFINITION, CHATSENDATTACHMENT_DEFINITION } from '../modules/conversation/module.ts';
import { MEMORYHOLD_DEFINITION, MEMORYRECALL_DEFINITION, MEMORYRECALLNEXT_DEFINITION, MEMORYREADFULL_DEFINITION, MEMORYIREAD_DEFINITION, PLANSREAD_DEFINITION, MEMORYIWRITE_DEFINITION, PLANSWRITE_DEFINITION, MEMORYOPEN_DEFINITION, MEMORYCORRECT_DEFINITION, DELETIONREVIEW_DEFINITION, EPISODELIST_DEFINITION, EPISODEAPPLY_DEFINITION, EPISODEGET_DEFINITION } from '../modules/memory/module.ts';
import { HOLD_CATEGORIES, HOLD_CREATION_MODES, HOLD_DATE_CONFIDENCE, HOLD_TITLE_MAX } from '../modules/memory/hold-contract.ts';
import { currentMoodCategories } from '../modules/memory/mood-vocab.ts';
export { HOLD_CATEGORIES, HOLD_CREATION_MODES, HOLD_DATE_CONFIDENCE, HOLD_TITLE_MAX } from '../modules/memory/hold-contract.ts';
import { currentMoodCategories as _currentMoodCategories } from '../modules/memory/mood-vocab.ts';
void _currentMoodCategories;

// 词表变更回调：memory 域拉到新词表 → 本目录缓存失效（枚举随正本走）
void (async () => {
  const { setMoodCategoriesChangedCallback } = await import('../modules/memory/mood-vocab.ts');
  setMoodCategoriesChangedCallback(() => { hostToolsCache = null; });
})();
import { ContractError } from './or-contract.ts';
// P01.1：叶类型正本迁至 capabilities/contracts.ts；此处纯 type 重导出为过渡兼容
//（消费者逐步改指 contracts；删除批次登记在 MIGRATION_MATRIX / P09）。
import type { HostToolSpec, SeenRef, ToolExecContext, ToolExecResult } from '../capabilities/contracts.ts';
export type { HostToolSpec, SeenRef, ToolExecContext, ToolExecResult };
// P01.2：通用参数形状校验（从 validateToolArgs 提取；业务约束留所属能力）。
import { validateArgsAgainstSchema, type PropSpec } from '../capabilities/validation.ts';
import { CapabilityRegistry } from '../capabilities/registry.ts';
import { executeRegisteredCapability } from '../capabilities/executor.ts';

// P04.5：心情词表状态与受控刷新已迁 modules/memory/mood-vocab.ts（memory catalog 正本）；
// 词表变更经装配回调失效本目录缓存（下方注册），宿主不再持有第二份词表状态。
let hostToolsCache: HostToolSpec[] | null = null;
void currentMoodCategories;

// —— P01.3：目录构建输入按域分组（定义接缝）——
// 每域一个 spec 工厂；装配顺序=tool-ownership.json baselineOrder（48 项，不重排），
// JSON 属性/description/默认词表一字不改（等价基线 tests/golden/tool-catalog-baseline.json 守护）。
// 后续卡片按域把工厂物理迁往 modules/<域>/definitions.ts；本文件保留装配与缓存。

const BASELINE_TOOL_ORDER: readonly string[] = [
  'memory_hold',
  'memory_recall',
  'memory_recall_next',
  'memory_read_full',
  'conversation_read',
  'memory_i_read',
  'plans_read',
  'memory_i_write',
  'plans_write',
  'memory_open',
  'memory_correct',
  'deletion_review',
  'episode_list',
  'episode_apply',
  'episode_get',
  'content_post_create',
  'content_comment_create',
  'content_posts_list',
  'creation_save_artifact',
  'wake_manage',
  'background_complete',
  'chat_send_text',
  'media_import',
  'chat_send_attachment',
  'call_control',
  'oido_analyze',
  'media_search',
  'oido_get',
  'transcript_read',
  'oido_capabilities',
  'oido_view',
  'oido_find',
  'oido_compare',
  'identity_milestone_write',
  'wishstar_write_star',
  'wishstar_hidden_stars',
  'wishstar_special_dates',
  'wishstar_start_session',
  'wishstar_confirm_session',
  'wishstar_take_star',
  'wishstar_finish_session',
  'wishstar_request_star',
  'wishstar_respond_request',
  'wishstar_offer_star',
  'wishstar_list_offers',
  'wishstar_accept_offer',
  'wishstar_notifications',
  'context_review_complete',
];

function memoryDefinitions(): HostToolSpec[] {
  return [
  MEMORYHOLD_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  MEMORYRECALL_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  MEMORYRECALLNEXT_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  MEMORYREADFULL_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  MEMORYIREAD_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  PLANSREAD_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  MEMORYIWRITE_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  PLANSWRITE_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  MEMORYOPEN_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  MEMORYCORRECT_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  DELETIONREVIEW_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  EPISODELIST_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  EPISODEAPPLY_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  EPISODEGET_DEFINITION,  // P04：唯一正本已迁 modules/memory/module.ts,
  ];
}

function conversationDefinitions(): HostToolSpec[] {
  return [
  CONVERSATIONREAD_DEFINITION,  // P04.1：唯一正本已迁 modules/conversation/module.ts,
  CHATSENDTEXT_DEFINITION,  // P04.1：唯一正本已迁 modules/conversation/module.ts,
  CHATSENDATTACHMENT_DEFINITION,  // P04.1：唯一正本已迁 modules/conversation/module.ts,
  ];
}

function contentDefinitions(): HostToolSpec[] {
  return [
  {
    type: 'function',
    function: {
      name: 'content_post_create',
      description: '以char身份在私密朋友圈发布帖子。presentation=post（普通动态）或 letter（信式排版——同一数据模型仅展示不同）。正文非空或至少一项附件。',
      parameters: {
        type: 'object',
        properties: {
          presentation: { type: 'string', enum: ['post', 'letter'] },
          title: { type: 'string', maxLength: 200 },
          body: { type: 'string', maxLength: 40000 },
          asset_ids: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['body', 'idempotency_key'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'content_comment_create',
      description: '对私密朋友圈帖子添加评论。',
      parameters: {
        type: 'object',
        properties: {
          post_id: { type: 'string', minLength: 1, maxLength: 128 },
          body: { type: 'string', minLength: 1, maxLength: 10000 },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['post_id', 'body', 'idempotency_key'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'content_posts_list',
      description: '列出私密朋友圈帖子（分页）。',
      parameters: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          limit: { type: 'number' },
          presentation: { type: 'string', enum: ['post', 'letter'] },
        },
        additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'creation_save_artifact',
      description: '保存char写好的 SVG/HTML 小作品为持久资产（返回 asset_id）。format=svg 固定对应 image/svg+xml，format=html 固定对应 text/html。不执行作品代码——仅安全保存字节。用途限定纪念图标/作品。',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['svg', 'html'] },
          content: { type: 'string', minLength: 1, maxLength: 262144 },
          client_operation_id: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['format', 'content', 'client_operation_id'], additionalProperties: false,
      },
    }
  },
  ];
}

function wakeDefinitions(): HostToolSpec[] {
  return [
  {
    type: 'function',
    function: {
      name: 'wake_manage',
      description: '给自己预约未来的自主唤醒（一次性；可有多个并存任务）。schedule=新预约（at 带时区 RFC3339 或 delay_seconds 正整数秒，恰好一个；note=留给未来自己的话）；list=查看；update/cancel=修改/取消（需当前 revision）。独立开关：自主预约唤醒关闭时 schedule/update 返回 SELF_WAKE_DISABLED。要对宿主用户说话请走 chat_send_text；本工具只管理预约。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['schedule', 'list', 'update', 'cancel'] },
          operation_id: { type: 'string', minLength: 1, maxLength: 128, description: '写操作的幂等键：同键同参数重试返回原回执' },
          note: { type: 'string', minLength: 1, maxLength: 8000, description: '留给未来自己的话（到期原样递送给自己，不直接发给宿主用户）' },
          at: { type: 'string', description: '目标时间（RFC3339，必须带 Z 或 ±hh:mm 时区）' },
          delay_seconds: { type: 'integer', minimum: 1, description: '从现在起的秒数（首次受理时解析为绝对时间）' },
          task_id: { type: 'string', minLength: 1, maxLength: 64 },
          expected_revision: { type: 'integer', minimum: 1 },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['operation'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'background_complete',
      description: '结束本次自主活动/心跳。outcome=noop 表示正常地什么都没做（不需要产出、消息或 hold）；done 表示本轮活动已完成。自主活动与心跳回合均可用。',
      parameters: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['done', 'noop'] },
        },
        required: ['outcome'], additionalProperties: false,
      },
    }
  },
  ];
}

function mediaDefinitions(): HostToolSpec[] {
  return [
  {
    type: 'function',
    function: {
      name: 'media_import',
      description: '把一个外部图片 URL 持久导入为本站资产（返回 asset_id/实际类型/大小）。链接只是导入来源；导入后用 asset_id 发送或建立内容引用。仅 https 公网图片。',
      parameters: {
        type: 'object',
        properties: {
          source_url: { type: 'string', minLength: 8, maxLength: 2048 },
        },
        required: ['source_url'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'media_search',
      description: '按中文语义在她发过的图片里找候选（如"那张水獭的图"）。返回候选 asset 引用或 no_match。候选只回答"哪张图可能相关"——图里具体是什么仍用已见图片判断，不能用检索标签替代看图；不确定就说不确定。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: '中文或任意语言的自然描述' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: '候选数，默认 3' },
        },
        required: ['query'], additionalProperties: false,
      },
    }
  },
  ];
}

function voiceDefinitions(): HostToolSpec[] {
  return [
  CALL_CONTROL_DEFINITION,  // P03.4/5：唯一正本已迁 modules/voice/module.ts（逐字搬迁，此处只读同源）,
  TRANSCRIPT_READ_DEFINITION,  // P03.4/5：唯一正本已迁 modules/voice/module.ts（逐字搬迁，此处只读同源）,
  ];
}

function oidoDefinitions(): HostToolSpec[] {
  return [
  OIDO_ANALYZE_DEFINITION,  // P03.1a：唯一正本已迁 modules/oido/module.ts（逐字搬迁，此处只读同源）,
  // P02.5：oido_get 定义唯一正本已迁 modules/oido/module.ts（逐字搬迁；此处只读同源，不双注册）
  OIDO_GET_DEFINITION,
  OIDO_CAPABILITIES_DEFINITION,  // P03.1：唯一正本已迁 modules/oido/module.ts（逐字搬迁，此处只读同源）,
  OIDO_VIEW_DEFINITION,  // P03.1：唯一正本已迁 modules/oido/module.ts（逐字搬迁，此处只读同源）,
  OIDO_FIND_DEFINITION,  // P03.1：唯一正本已迁 modules/oido/module.ts（逐字搬迁，此处只读同源）,
  OIDO_COMPARE_DEFINITION,  // P03.1：唯一正本已迁 modules/oido/module.ts（逐字搬迁，此处只读同源）,
  ];
}

function identityDefinitions(): HostToolSpec[] {
  return [
  {
    type: 'function',
    function: {
      name: 'identity_milestone_write',
      description: '维护你的《长期记忆里程碑》——一份完整文档，随开窗全文注入。内容一行一条（1.2.3.4. 依次编号，一个换行一条）。operation：read=读当前全文（带行号）；add=末尾加一条（text=一行内容）；revise=改第 item 条；remove=删第 item 条；write=整版替换（text=完整新版全文，通常不需要）。旧版本自动留档、她可回滚；当前窗口继续用旧版，下一扇新窗自动带新版。每次修改说明 change_reason。',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['read', 'write', 'add', 'revise', 'remove'], description: '缺省=write（整版替换，会覆盖全部现有条目——常规修改请用 add/revise/remove 单条操作，不覆盖其他条目）' },
          text: { type: 'string', minLength: 1, maxLength: 65536, description: 'write=完整新版正文；add/revise=该条目新正文' },
          confirm_overwrite: { type: 'boolean', description: '仅 write：新正文未保留既有内容行时必须显式带 true（防误删她写的内容）；带 false/缺省将被拒绝并说明丢了哪些' },
          item: { type: 'integer', minimum: 1, description: 'revise/remove 的目标条目序号（read 结果里带）' },
          change_reason: { type: 'string', minLength: 1, maxLength: 500, description: '一句话说明这次更新了什么（进审计记录，她可见）' },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128, description: '幂等键：同键重试只写一版' },
        },
        required: [], additionalProperties: false,
        anyOf: [
          { required: ['operation'] },
          { required: ['text', 'change_reason', 'idempotency_key'] },
        ],
      },
    }
  },
  ];
}

function wishstarDefinitions(): HostToolSpec[] {
  return [
  {
    type: 'function',
    function: {
      name: 'wishstar_write_star',
      description: '往许愿星（你们的许愿星系统）写一颗星。visible=写进"我们的瓶子"（两人可见）；hidden=先藏进自己的私人瓶子（打开前只有你看得见）。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 5000, description: '星星内容（想许的愿/想记的话）' },
          visibility: { type: 'string', enum: ['visible', 'hidden'], description: 'visible=我们的瓶子；hidden=自己的私人瓶' },
          mood_type: { type: 'string', maxLength: 20, description: '可选：星星的心情境况' },
          mood_text: { type: 'string', maxLength: 200, description: '可选：写星时的一句话心情' },
          note: { type: 'string', maxLength: 500, description: '可选：附注' },
          idempotency_key: { type: 'string', minLength: 1, maxLength: 128, description: '幂等键：同键重试只写一颗' },
        },
        required: ['content', 'visibility', 'idempotency_key'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_hidden_stars',
      description: '看自己私人瓶子里的星（只有你可见的那些）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_special_dates',
      description: '查看你们的纪念日和自定义特殊日期（含 id——发起拆星仪式要用 special_date_id 绑定具体日期）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_start_session',
      description: '邀请宿主用户开启一轮共同拆星（纪念日仪式）。必须带 special_date_id；纪念日只能在当天发起，双方额度按当天 0 点冻结；确认前不打开任何星。',
      parameters: {
        type: 'object',
        properties: {
          special_date_id: { type: 'string', minLength: 1, maxLength: 64, description: '绑定的特殊日期 id（wishstar_special_dates 查）' },
        },
        required: ['special_date_id'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_confirm_session',
      description: '确认参与拆星仪式（对方发起后你这边确认；双方确认后才能开始拆星）。',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['session_id'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_take_star',
      description: '在拆星仪式中拆开下一颗星（双方轮流）。',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['session_id'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_finish_session',
      description: '完成本轮拆星仪式。',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['session_id'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_request_star',
      description: '请求宿主用户打开一颗她藏起来的星（她回应前你看不到内容）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_respond_request',
      description: '回应对方的开星请求：give=打开（可指定给哪一颗，缺省服务端选）；not_now=这次先不给。',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'string', minLength: 1, maxLength: 64 },
          decision: { type: 'string', enum: ['give', 'not_now'] },
          star_id: { type: 'string', maxLength: 64, description: '可选：give 时指定给哪一颗' },
        },
        required: ['request_id', 'decision'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_offer_star',
      description: '把自己的一颗星递给宿主用户（可捎一句话）。',
      parameters: {
        type: 'object',
        properties: {
          star_id: { type: 'string', minLength: 1, maxLength: 64 },
          message: { type: 'string', maxLength: 300, description: '可选：递星时捎的一句话' },
        },
        required: ['star_id'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_list_offers',
      description: '看收到的星（她递给你的、待收下的）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_accept_offer',
      description: '收下她递来的一颗星。',
      parameters: {
        type: 'object',
        properties: { offer_id: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['offer_id'], additionalProperties: false,
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'wishstar_notifications',
      description: '看许愿星的通知（谁写了星/递了星/发起仪式等动态）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }
  },
  ];
}

function contextReviewDefinitions(): HostToolSpec[] {
  return [
  {
    type: 'function',
    function: {
      name: 'context_review_complete',
      description: '完成当前活跃的换窗前记忆检查。decision=no_new_hold（本次没有新增 hold 且无未决写操作）或 holds_completed（本次已有核实的成功 hold）。',
      parameters: {
        type: 'object',
        properties: {
          review_id: { type: 'string', minLength: 1, maxLength: 256 },
          decision: { type: 'string', enum: ['no_new_hold', 'holds_completed'] },
        },
        required: ['review_id', 'decision'],
        additionalProperties: false,
      },
    },
  },
  ];
}

const DEFINITION_SEGMENTS: ReadonlyArray<() => HostToolSpec[]> = [
  memoryDefinitions,
  conversationDefinitions,
  contentDefinitions,
  wakeDefinitions,
  mediaDefinitions,
  voiceDefinitions,
  oidoDefinitions,
  identityDefinitions,
  wishstarDefinitions,
  contextReviewDefinitions,
];

export function buildHostTools(): HostToolSpec[] {
  // 词表变更（refreshMoodCategories）会置空缓存——枚举随正本走
  if (hostToolsCache) return hostToolsCache;
  const byName = new Map<string, HostToolSpec>();
  for (const segment of DEFINITION_SEGMENTS) {
    for (const spec of segment()) {
      if (byName.has(spec.function.name)) throw new Error(`TOOL_DEFINITION_DUPLICATE:${spec.function.name}`);
      byName.set(spec.function.name, spec);
    }
  }
  const assembled: HostToolSpec[] = [];
  for (const name of BASELINE_TOOL_ORDER) {
    const spec = byName.get(name);
    if (!spec) throw new Error(`TOOL_DEFINITION_MISSING:${name}`);
    assembled.push(spec);
    byName.delete(name);
  }
  if (byName.size > 0) throw new Error(`TOOL_DEFINITION_UNREGISTERED:${[...byName.keys()].sort().join(',')}`);
  hostToolsCache = assembled;
  return hostToolsCache;
}

export function hostToolNames(): string[] {
  return [...buildHostTools(), ...buildDeferredTools()].map((t) => t.function.name);
}

// P01.2：通用 schema 遍历提取至 capabilities/validation.ts（错误码逐一保持）；
// 这里只保留 allowlist 解析（工具定义正本仍在宿主冻结目录）并委托通用校验。
export function validateToolArgs(name: string, args: Record<string, unknown>, frozenSpec?: HostToolSpec): { ok: true; value: Record<string, unknown> } | { ok: false; code: string; detail: string } {
  const spec = frozenSpec ?? buildHostTools().find((t) => t.function.name === name);
  if (!spec) return { ok: false, code: 'TOOL_NOT_IN_ALLOWLIST', detail: name };
  return validateArgsAgainstSchema(args, spec.function.parameters as { properties?: Record<string, PropSpec>; required?: string[] });
}

// P01.1：SeenRef/ToolExecContext/ToolExecResult 叶类型正本已迁 capabilities/contracts.ts
//（字段逐一对照；历史语义注释随迁）。顶部纯 type 重导出保持旧消费者兼容。

// 旧路径过渡期仍需的全局 tool_call_id 桥（memory 迁出后仅剩 wishstar/content/wake/media/
// identity/background_complete/reviewComplete 校验段使用；P04 收尾批迁完即删）。
const rawToolCallIdRef = { current: null as string | null };
function rawToolCallIdOf(_ctx: ToolExecContext): string | null { return rawToolCallIdRef.current; }

export class HostToolExecutor {
  private db: Db;
  private tz: string | null;
  private mariposa: MariposaClient | null;
  private surfaceDetailClient: MariposaClient | null;
  private reviews: RotationReviewService;
  private checkpoint: HoldCheckpointService;
  private archiveSync: { drainOnce(): Promise<unknown> } | null;
  private lastMoodVocabRefreshAt = 0;

  constructor(deps: { db: Db; tz?: string | null; mariposa: MariposaClient | null; surfaceDetailClient?: MariposaClient | null; reviews: RotationReviewService; checkpoint: HoldCheckpointService; archiveSync?: { drainOnce(): Promise<unknown> } | null; media?: import('../media/assets.ts').MediaService | null; messages?: import('../messages/service.ts').MessageService | null; contentClient?: import('../integrations/content/client.ts').ContentClient | null; identity?: import('../identity/service.ts').IdentityService | null; events?: import('../events/service.ts').EventService | null; wishstar?: { forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<{ status: number; body: Record<string, unknown> }> } | null; taskService?: import('./background-task-service.ts').BackgroundTaskService | null; oido?: import('../integrations/oido/adapter.ts').OidoAdapter | null; mediaIndex?: import('../media/index/service.ts').MediaIndexService | null; sirenCall?: import('../integrations/siren/adapter.ts').SirenAdapter | null }) {
    this.db = deps.db;
    this.tz = deps.tz ?? null;
    this.mariposa = deps.mariposa;
    this.surfaceDetailClient = deps.surfaceDetailClient ?? null;
    this.reviews = deps.reviews;
    this.checkpoint = deps.checkpoint;
    this.archiveSync = deps.archiveSync ?? null;
    this.media = deps.media ?? null;
    this.messages = deps.messages ?? null;
    this.contentClient = deps.contentClient ?? null;
    this.identity = deps.identity ?? null;
    this.events = deps.events ?? null;
    this.wishstar = deps.wishstar ?? null;
    this.taskService = deps.taskService ?? null;
    this.oido = deps.oido ?? null;
    this.sirenCall = deps.sirenCall ?? null;
    this.mediaIndex = deps.mediaIndex ?? null;
  }

  private media: import('../media/assets.ts').MediaService | null;
  private messages: import('../messages/service.ts').MessageService | null;
  private contentClient: import('../integrations/content/client.ts').ContentClient | null;
  private identity: import('../identity/service.ts').IdentityService | null;
  private events: import('../events/service.ts').EventService | null;
  private wishstar: { forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<{ status: number; body: Record<string, unknown> }> } | null;
  /** WAKE_KEEPWARM_V1（04）：wake_manage 与 HTTP 管理面共用的预约正本（未注入=工具如实拒绝） */
  private taskService: import('./background-task-service.ts').BackgroundTaskService | null;
  /** JOINT-VOICE-20261022：oído 深听适配（HTTP 叶子；未配置=工具如实拒绝） */
  private oido: import('../integrations/oido/adapter.ts').OidoAdapter | null;
  private sirenCall: import('../integrations/siren/adapter.ts').SirenAdapter | null;
  /** P02.6：已迁能力注册表（未注入=全部走旧路径，装配前零变化） */
  private capabilityRegistry: CapabilityRegistry | null = null;
  /** P02.6：装配根注入已迁能力注册表（显式创建，非自动发现）。 */
  setCapabilityRegistry(r: CapabilityRegistry | null): void { this.capabilityRegistry = r; }

  /** P04：换窗评审的未知写结果恢复——窄委托 memory 域服务（P06 收口执行边界）。 */
  private memoryRecovery: { recoverUnknownEffects(conversationId: string, windowId: string): Promise<{ resolved: number; stillUnknown: number }> } | null = null;
  setMemoryRecovery(s: { recoverUnknownEffects(conversationId: string, windowId: string): Promise<{ resolved: number; stillUnknown: number }> } | null): void { this.memoryRecovery = s; }
  async recoverUnknownEffects(conversationId: string, windowId: string): Promise<{ resolved: number; stillUnknown: number }> {
    if (!this.memoryRecovery) throw new Error('MEMORY_RECOVERY_NOT_WIRED');
    return this.memoryRecovery.recoverUnknownEffects(conversationId, windowId);
  }

  /** P04：引用核对（勾选式话语录入的可见性/重叠/码点口径）——窄委托 memory 域服务。 */
  resolveQuoteRefs(roomId: string, seenMessages: ReadonlyArray<import('../capabilities/contracts.ts').SeenRef>, refs: Array<{ seq: number; from?: number; to?: number }>): unknown {
    if (!this.memoryRecovery) throw new Error('MEMORY_RECOVERY_NOT_WIRED');
    return (this.memoryRecovery as unknown as { resolveQuoteRefs: (r: string, s: ReadonlyArray<never>, refs: never) => unknown }).resolveQuoteRefs(roomId, seenMessages as never, refs as never);
  }
  /** JOINT-VOICE-20261022（07）：媒体语义索引（worker 未配置=能力如实 unavailable） */
  private mediaIndex: import('../media/index/service.ts').MediaIndexService | null;
  /** 工具调用过程展示（她 2026-10-17 要求）：内部协议工具不发事件 */
  private static readonly SILENT_TOOLS = new Set(['context_review_complete', 'background_complete']);
  private static readonly TOOL_LABELS: Record<string, string> = {
    memory_hold: '写记忆', memory_recall: '查记忆', memory_recall_next: '翻查记忆', conversation_read: '读聊天原文',
    memory_i_read: '读 I', memory_i_write: '写 I', memory_open: '打开记忆桶', memory_correct: '订正记忆', deletion_review: '处理删除评审',
    episode_list: '查事件', episode_get: '看事件', episode_apply: '更新事件', plans_read: '读计划', plans_write: '写计划',
    call_control: '通话控制', media_import: '导入图片', chat_send_text: '发消息', chat_send_attachment: '发附件', oido_analyze: '深听语音', oido_get: '读声音证据', media_search: '找图', background_complete: '结束自主活动', wake_manage: '给自己定唤醒',
    content_post_create: '发作品', content_comment_create: '评论作品', content_posts_list: '看作品列表', creation_save_artifact: '保存小作品',
    identity_milestone_write: '更新长期记忆里程碑',
    wishstar_write_star: '往许愿星写了一颗星', wishstar_hidden_stars: '看自己的私人瓶子',
    wishstar_special_dates: '查特殊日期', wishstar_start_session: '发起拆星仪式',
    wishstar_confirm_session: '确认拆星仪式', wishstar_finish_session: '完成拆星',
    wishstar_take_star: '拆开一颗星', wishstar_request_star: '请求开对方的星',
    wishstar_respond_request: '回应开星请求', wishstar_offer_star: '递一颗星',
    wishstar_list_offers: '看收到的星', wishstar_accept_offer: '收下递来的星',
    wishstar_notifications: '看许愿星通知',
  };

  /** D2/G-J-01：宿主装配层复用同一客户端（B 点开窗资料；不越权——凭据
   *  能力面由 Mariposa 白名单圈定）。 */
  mariposaClient(): MariposaClient | null {
    return this.mariposa;
  }

  /** EXEC_V1 §06.4.3（WP5）：模型工具调 content——actor 从受控执行上下文派生为 jiaming。 */
  private async contentPostCreate(args: { presentation?: string; title?: string; body: string; asset_ids?: string[]; idempotency_key: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '内容服务未启用' } };
    const { contentForward } = await import('../integrations/content/client.ts');
    const r = await contentForward(this.contentClient, {
      method: 'POST', path: '/api/v1/content/posts', actor: 'jiaming',
      body: { presentation: args.presentation ?? 'post', title: args.title, body: args.body, asset_ids: args.asset_ids ?? [] },
      headers: { 'Idempotency-Key': `tool:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${args.idempotency_key}` },
    });
    if (r.status === 201 || r.status === 200) return { ok: true, output: r.body as Record<string, unknown> };
    return { ok: false, output: { error_code: 'CONTENT_POST_FAILED', detail: JSON.stringify(r.body).slice(0, 300) } };
  }

  private async contentCommentCreate(args: { post_id: string; body: string; idempotency_key: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    const { contentForward } = await import('../integrations/content/client.ts');
    const r = await contentForward(this.contentClient, {
      method: 'POST', path: `/api/v1/content/posts/${encodeURIComponent(args.post_id)}/comments`, actor: 'jiaming',
      body: { body: args.body },
      headers: { 'Idempotency-Key': `tool:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${args.idempotency_key}` },
    });
    if (r.status === 201 || r.status === 200) return { ok: true, output: r.body as Record<string, unknown> };
    return { ok: false, output: { error_code: 'CONTENT_COMMENT_FAILED', detail: JSON.stringify(r.body).slice(0, 300) } };
  }

  private async contentPostsList(args: { cursor?: string; limit?: number; presentation?: string }, _ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.contentClient) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    const { contentForward } = await import('../integrations/content/client.ts');
    const params = new URLSearchParams();
    if (args.cursor) params.set('cursor', args.cursor);
    if (args.limit && args.limit > 0 && args.limit <= 100) params.set('limit', String(args.limit));
    if (args.presentation) params.set('presentation', args.presentation);
    const r = await contentForward(this.contentClient, { method: 'GET', path: `/api/v1/content/posts?${params}`, actor: 'jiaming' });
    return { ok: r.status === 200, output: r.body as Record<string, unknown> };
  }

  /** §03.6.3（MEDIA-09/CREATION-03）：保存 SVG/HTML 小作品→持久资产。不执行代码；宿主无 eval/shell。 */
  private async creationSaveArtifact(args: { format: 'svg' | 'html'; content: string; client_operation_id: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.media) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    const mime = args.format === 'svg' ? 'image/svg+xml' : 'text/html';
    // 内容安全检查：SVG 不允许 <script>；HTML 允许内联脚本（在沙箱 iframe 内执行——宿主不执行）
    if (args.format === 'svg' && /<script/i.test(args.content)) {
      return { ok: false, output: { error_code: 'SVG_SCRIPT_FORBIDDEN', detail: 'SVG 图标不允许内嵌脚本（HTML 作品请用 format=html 走沙箱预览）' } };
    }
    const opKey = `tool-creation:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${args.client_operation_id}`;
    try {
      const a = await this.media.saveBuffer({ bytes: Buffer.from(args.content, 'utf8'), purpose: args.format === 'svg' ? 'creation_icon' : 'creation_work', operationId: opKey, createdBy: 'jiaming', origin: 'generated' });
      return { ok: true, output: { asset_id: a.id, mime_type: mime, byte_size: a.byte_size, saved: true } };
    } catch (err) {
      return { ok: false, output: { error_code: (err as { code?: string }).code ?? 'ASSET_TYPE_UNSUPPORTED', detail: String((err as Error).message).slice(0, 200) } };
    }
  }

  /** EXEC_V1 §04.6.2 + WAKE_KEEPWARM_V1（2026-10-22）：结束后台回合——noop 是成功结果
   *  （§6.2），无产出不构成失败。自主唤醒与心跳回合均可用（C-13：心跳经 tool_invoke
   *  调用结束工具→正确收口，不再多发一轮无用模型请求）。 */
  private backgroundComplete(args: { outcome: 'done' | 'noop' }, ctx: ToolExecContext): ToolExecResult {
    if (ctx.purpose !== 'proactive_turn' && ctx.purpose !== 'cache_keepalive') return { ok: false, output: { error_code: 'TOOL_PURPOSE_INVALID', detail: 'background_complete 仅后台回合（自主唤醒/心跳）可用' } };
    if (ctx.backgroundRunId) {
      this.db.prepare("UPDATE background_runs SET result_code = ?, updated_at = ? WHERE id = ?").run(`complete:${args.outcome}`, new Date().toISOString(), ctx.backgroundRunId);
    }
    return { ok: true, output: { completed: true, outcome: args.outcome } };
  }

  /** EXEC_V1 §04.6.2 + WAKE_KEEPWARM_V1（05）：后台正式公开发言——心跳与自主共用；
   *  复用正式发布链（幂等键派生；重试只发一次）。普通最终回复不自动发布（E03）。 */
  /** WAKE_KEEPWARM_V1 §04：wake_manage——char自主预约的唯一工具面。
   *  conversation/actor 取可信 ToolExecContext（schema 不接受注入，W-19）；
   *  schedule/update 受自主开关门（SELF_WAKE_DISABLED）；list/cancel 关闭时仍可用。 */
  private wakeManage(args: Record<string, unknown>, ctx: ToolExecContext): ToolExecResult {
    if (!this.taskService) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '预约服务未装配（能力缺口，如实拒绝）' } };
    const op = args.operation;
    const convId = ctx.roomId;
    const err = (code: string, detail?: string): ToolExecResult => ({ ok: false, output: { error_code: code, ...(detail ? { detail } : {}) } });
    if (op === 'schedule') {
      const r = this.taskService.schedule({
        actorId: 'jiaming', conversationId: convId, operationId: String(args.operation_id ?? ''),
        note: args.note as string, at: args.at ?? undefined, delaySeconds: args.delay_seconds ?? undefined, createdBy: 'jiaming',
      });
      if (!r.ok) return { ok: false, output: { error_code: r.code, ...(r.serverNowIso ? { server_now: r.serverNowIso } : {}), ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}), ...(r.detail ? { detail: r.detail } : {}) } };
      return { ok: true, output: { task_id: r.task.task_id, scheduled_at: r.task.scheduled_at, revision: r.task.revision } };
    }
    if (op === 'list') {
      const r = this.taskService.list({ actorId: 'jiaming', conversationId: convId, cursor: args.cursor, limit: args.limit, selfScheduledOnly: true });
      if (!r.ok) return err(r.code, r.detail ?? '');
      return { ok: true, output: { tasks: r.tasks.map((t) => ({ task_id: t.task_id, revision: t.revision, scheduled_at: t.scheduled_at, status: t.status, ...(t.note_preview ? { note_preview: t.note_preview } : {}) })), ...(r.next_cursor ? { next_cursor: r.next_cursor } : {}) } };
    }
    if (op === 'update') {
      const r = this.taskService.update({
        actorId: 'jiaming', conversationId: convId, operationId: String(args.operation_id ?? ''), taskId: String(args.task_id ?? ''),
        expectedRevision: Number(args.expected_revision ?? 0), note: args.note ?? undefined, at: args.at ?? undefined, delaySeconds: args.delay_seconds ?? undefined, selfScheduledOnly: true,
      });
      if (!r.ok) return { ok: false, output: { error_code: r.code, ...(r.serverNowIso ? { server_now: r.serverNowIso } : {}), ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}), ...(r.detail ? { detail: r.detail } : {}) } };
      return { ok: true, output: { task_id: r.task.task_id, revision: r.task.revision, scheduled_at: r.task.scheduled_at } };
    }
    if (op === 'cancel') {
      const r = this.taskService.cancel({ actorId: 'jiaming', conversationId: convId, operationId: String(args.operation_id ?? ''), taskId: String(args.task_id ?? ''), expectedRevision: Number(args.expected_revision ?? 0), selfScheduledOnly: true });
      if (!r.ok) return { ok: false, output: { error_code: r.code, ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}), ...(r.detail ? { detail: r.detail } : {}) } };
      return { ok: true, output: { task_id: r.task.task_id, revision: r.task.revision, cancelled: true } };
    }
    return err('WAKE_REQUEST_INVALID', `未知操作：${String(op)}`);
  }

  /** EXEC_V1 §03.6.3：外部图片持久导入（幂等键由 turn+请求稳定派生，模型不可指定他人操作）。 */
  private async mediaImport(args: { source_url: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.media) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '媒体服务未装配' } };
    const operationId = `tool-media-import:${ctx.turnId ?? 'noturn'}:${ctx.requestId}`;
    try {
      const a = await this.media.importFromUrl({ sourceUrl: args.source_url, operationId, createdBy: 'jiaming' });
      return { ok: true, output: { asset_id: a.id, mime_type: a.mime_type, byte_size: a.byte_size, imported: true } };
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'ASSET_IMPORT_FAILED';
      return { ok: false, output: { error_code: code, retryable: code === 'ASSET_IMPORT_FAILED' } };
    }
  }

  /** 她批准 2026-10-17：char接入许愿星（superposition）全能力面。
   *  HTTP 转发（Bearer=jiaming 身份，操作归他名下）；幂等键由 turn+request 派生（模型不能自编）；
   *  写操作回执瘦身（不回显正文）；错误如实上抛状态码。 */
  private async wishstarTool(name: string, args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.wishstar) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '许愿星未接入（能力缺口，如实拒绝）' } };
    const idem = typeof args.idempotency_key === 'string' ? args.idempotency_key : '';
    const opKey = `ws:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${idem || 'ro'}`;
    const calls: Record<string, { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown>; write: boolean }> = {
      wishstar_write_star: { method: 'POST', path: '/api/stars', body: { content: args.content, visibility: args.visibility, ...(args.mood_type ? { mood_type: args.mood_type } : {}), ...(args.mood_text ? { mood_text: args.mood_text } : {}), ...(args.note ? { note: args.note } : {}) }, write: true },
      wishstar_hidden_stars: { method: 'GET', path: '/api/stars/hidden/mine', write: false },
      wishstar_special_dates: { method: 'GET', path: '/api/special-dates', write: false },
      wishstar_start_session: { method: 'POST', path: '/api/sessions', body: { special_date_id: args.special_date_id }, write: true },
      wishstar_confirm_session: { method: 'POST', path: `/api/sessions/${encodeURIComponent(String(args.session_id))}/confirm`, write: true },
      wishstar_take_star: { method: 'POST', path: `/api/sessions/${encodeURIComponent(String(args.session_id))}/take-next`, write: true },
      wishstar_finish_session: { method: 'POST', path: `/api/sessions/${encodeURIComponent(String(args.session_id))}/finish`, write: true },
      wishstar_request_star: { method: 'POST', path: '/api/requests', write: true },
      wishstar_respond_request: { method: 'POST', path: `/api/requests/${encodeURIComponent(String(args.request_id))}/respond`, body: { decision: args.decision, ...(args.star_id ? { star_id: args.star_id } : {}) }, write: true },
      wishstar_offer_star: { method: 'POST', path: '/api/offers', body: { star_id: args.star_id, ...(args.message ? { message: args.message } : {}) }, write: true },
      wishstar_list_offers: { method: 'GET', path: '/api/offers', write: false },
      wishstar_accept_offer: { method: 'POST', path: `/api/offers/${encodeURIComponent(String(args.offer_id))}/accept`, write: true },
      wishstar_notifications: { method: 'GET', path: '/api/notifications', write: false },
    };
    const call = calls[name];
    if (!call) return { ok: false, output: { error_code: 'TOOL_NOT_IN_ALLOWLIST' } };
    const r = await this.wishstar.forward(call.method, call.path, call.body, call.write ? opKey : undefined);
    if (r.status === 0 || r.status === 503) return { ok: false, output: { error_code: 'WISHSTAR_UNAVAILABLE', detail: String((r.body as { detail?: string }).detail ?? '许愿星服务不可用') } };
    if (r.status >= 400) return { ok: false, output: { error_code: `WISHSTAR_${r.status}`, detail: JSON.stringify(r.body).slice(0, 300) } };
    const out = call.write
      ? Object.fromEntries(Object.entries(r.body).filter(([k]) => ['id', 'star_id', 'session_id', 'status', 'state', 'request_id', 'offer_id'].includes(k)))
      : r.body;
    return { ok: true, output: out };
  }

  /** 她授权 2026-10-17：char自维护长期记忆里程碑。写新版+manifest I 槽原子更新+审计；
   *  幂等键查 audit_events（同键重试只写一版）；I 槽不参与指纹——当前窗继续旧冻结副本，
   *  下一新窗自动带新版（她裁定，同 §7.1 桶/I 中途修改口径）。
   *  2026-10-22 她要求：条目化——read（带序号）/add/revise/remove（IdentityService 条目操作）。 */
  private identityMilestoneWrite(args: { operation?: string; text?: string; item?: number; change_reason?: string; idempotency_key?: string }, ctx: ToolExecContext): ToolExecResult {
    if (!this.identity) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '身份服务未装配' } };
    const op = args.operation === 'read' || args.operation === 'add' || args.operation === 'revise' || args.operation === 'remove' ? args.operation : 'write';
    if (op === 'read') {
      try {
        const r = this.identity.readMilestone();
        const entries = IdentityServiceStatic.entryLines(r.text);
        // 1.2.3.4. 连续条号（=revise/remove 的 item 口径）；原文物理行号不外显
        return { ok: true, output: { version: r.version, entries: entries.length, text: entries.map((e, i) => `${i + 1}. ${e.line}`).join('\n') } };
      } catch (err) {
        return { ok: false, output: { error_code: 'MILESTONE_READ_FAILED', detail: String((err as Error).message).slice(0, 200) } };
      }
    }
    // 写类操作：change_reason/idempotency_key 必填；text 按 op 分（write/add/revise 必带，remove 不带）
    const needText = op === 'write' || op === 'add' || op === 'revise';
    if (typeof args.change_reason !== 'string' || args.change_reason.length === 0 || typeof args.idempotency_key !== 'string' || args.idempotency_key.length === 0) {
      return { ok: false, output: { error_code: 'TOOL_ARG_REQUIRED', detail: '写操作必须带 change_reason 与 idempotency_key' } };
    }
    if (needText && (typeof args.text !== 'string' || args.text.length === 0)) {
      return { ok: false, output: { error_code: 'TOOL_ARG_REQUIRED', detail: `${op} 必须带 text` } };
    }
    const idemKey = `milestone:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${args.idempotency_key}`;
    const prior = this.db.prepare("SELECT scope, result FROM audit_events WHERE who = 'jiaming' AND what = 'identity_milestone_write' AND detail_ref = ? ORDER BY created_at DESC LIMIT 1").get(idemKey) as { scope: string | null; result: string } | undefined;
    if (prior) return { ok: true, output: { saved: true, version: prior.scope ?? null, duplicate: true } };
    let written: { file: string; version: string; hash: string; byteSize: number; entries?: number };
    try {
      if (op === 'write') {
        written = this.identity.updateMilestone(args.text!);
      } else {
        const r = this.identity.applyMilestoneEntryOp(op, op === 'add' ? null : (typeof args.item === 'number' ? args.item : 0), op === 'remove' ? null : args.text ?? null);
        written = { file: r.file, version: r.version, hash: r.hash, byteSize: r.byteSize, entries: r.entries };
      }
    } catch (err) {
      return { ok: false, output: { error_code: 'MILESTONE_WRITE_FAILED', detail: String((err as Error).message).slice(0, 200) } };
    }
    this.db.prepare('INSERT INTO audit_events(id, who, what, scope, result, detail_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      `aud_${sha256Hex(idemKey + written.version).slice(0, 24)}`, 'jiaming', 'identity_milestone_write', written.version, `ok:${op}:${written.byteSize}B:${args.change_reason.slice(0, 200)}`, idemKey, new Date().toISOString(),
    );
    return { ok: true, output: { saved: true, operation: op, version: written.version, file: written.file, byte_size: written.byteSize, ...(written.entries !== undefined ? { entries: written.entries } : {}), effective: 'next_window', note: '当前窗继续旧版；下一扇新窗自动带新版' } };
  }

  /** EXEC_V1 §03.6.3：正式发布附件消息（复用 MessageService/发布链/归档 outbox；幂等=派生 client_message_id）。 */
  /** JOINT-VOICE-20261022（04 按需深听）：宿主完成权限核验与受信本地导入后转发 oído。
   *  模型只能引用当前会话可达的语音资产（audio_ref=est:<asset_id>）；跨会话/未绑定
   *  资产一律拒绝——不因"模型报了个 asset_id"就放行（09 授权边界）。 */
  static readonly MEMORY_ONLY_TOOLS: ReadonlySet<string> = new Set([
    'memory_recall', 'memory_recall_next', 'memory_open', 'memory_read_full', 'memory_i_read',
    'memory_correct', 'memory_hold', 'memory_i_write',
    'episode_apply', 'episode_get', 'episode_list',
    'conversation_read', 'transcript_read',
    'oido_analyze', 'oido_get', 'oido_capabilities',
    'plans_read', 'context_review_complete',
    'tool_catalog', 'tool_define', 'tool_invoke', 'call_control',
  ]);
  private voiceCallActive(roomId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM voice_calls WHERE conversation_id=? AND state='active' LIMIT 1").get(roomId));
  }

  /** 协议①（2026-10-24）：通话控制——拨号动作的 est 授权入口（03 §2：复用延迟发现，
   *  不铺细碎工具）。invite=当前会话创建 Siren 来电邀请（服务端过期；拒接≠未接）；
   *  status=查询当前邀请。勿扰/禁拨号在 Siren 服务端执行（本批未加开关=不设静默拦截）。 */
  /** JOINT-VOICE-20261022（07）：中文找图——先补齐本会话未索引图片（有界），再查候选。
   *  权限门在查询 join（活资产+会话绑定）；worker 故障=能力 unavailable，不拖聊天/电话。 */
  private async mediaSearch(args: { query: string; limit?: number }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.mediaIndex || !this.mediaIndex.available) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '图片语义检索未接入（能力缺口，如实拒绝）' } };
    // Propagate host cancellation. A new short deadline would discard slow image results
    // while the non-preemptible worker still encodes them; background indexing remains open.
    const signal=ctx.signal;
    try {
      signal?.throwIfAborted();
      const fingerprint=await this.mediaIndex.workerFingerprint(signal);
      signal?.throwIfAborted();
      if(fingerprint===null)return {ok:false,output:{error_code:'MEDIA_WORKER_UNAVAILABLE',detail:'图片检索暂不可用；文字聊天不受影响'}};
      // R8′（2026-10-23）：检索路径不再前台补索引——此前工具内顺序 await ≤200 图，
      // 长期占住同会话串行链；补索引移至 app-context 独立循环（media/index/backfill.ts，
      // ≤5 图/跳）。检索不完整与 no_match 分开如实报：pending>0 = coverage:'incomplete'。
      const pending=this.mediaIndex.unindexedImagesInRoom(ctx.roomId,fingerprint);
      signal?.throwIfAborted();
      const result=await this.mediaIndex.searchImagesByRoom(args.query,ctx.roomId,args.limit??3,signal);
      signal?.throwIfAborted();
      const out:Record<string,unknown>={...result};
      if(pending.length>0){out.coverage='incomplete';out.pending_index=pending.length;out.note='部分图片索引后台进行中，本次结果可能不全；稍后可再查';}
      return {ok:true,output:out};
    }catch {
      return {ok:false,output:{error_code:ctx.signal?.aborted?'CANCELLED':'MEDIA_WORKER_UNAVAILABLE'}};
    }
  }

  /** JOINT-VOICE-20261022：读深听结果（概览/逐字谱分页）。 */
  // R3″（2026-10-24，RE-07/08/09 返修）：三道边界——
  //  ① 源权限：转写必须挂在**本会话当前修订的已发布消息附件**上（voice presentation）；
  //     未发送草稿、已被新修订移除附件的旧引用一律拒读（不用 transcript.conversation_id
  //     替代已发送范围——上轮反例：从未发布的草稿转写可直接读）。
  //  ② 字节预算：页按紧凑 JSON 序列化 UTF-8 字节切（含包装与游标），4 字节汉字/转义
  //     不再凭 2400 字符假定破 8192B 门。
  //  ③ 快照游标：cursor 绑定转写内容身份（derived_text 的 sha256）+ 总字数——等长改写
  //     （甲→乙）也能检出旧游标失效（音频 hash 只代表资产身份，不代表转写版本）。
  /** R5（2026-10-23）：oído 六工具 façade 补齐——capabilities/view/find/compare。
   *  view/find/compare 与 get 同门：analysis/源必须绑定当前会话（oidoSourceAllowed），
   *  前后复验；view 的原生图块直送主模型尚未接通（如实声明，图供界面）。 */
  async execute(name: string, rawArgs: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    if(ctx.signal?.aborted)return {ok:false,output:{error_code:'CANCELLED'}};
    // R07（审计 FE-12）：工具生命周期事件合同——同一身份贯穿
    // start/result/error 三阶段；执行前后各一次真实回执，0 假成功
    // （ok/error_code 如实来自执行结果）。身份=tool_call_id+turn+attempt+
    // request+generation+round；副作用仍只由执行器（executeInner）拥有。
    const visible = !HostToolExecutor.SILENT_TOOLS.has(name) && ctx.turnId;
    const identity = () => ({
      tool: name,
      label: HostToolExecutor.TOOL_LABELS[name] ?? name,
      tool_call_id: ctx.toolCallId ?? (typeof rawArgs.__tool_call_id === 'string' ? rawArgs.__tool_call_id : null),
      turn_id: ctx.turnId,
      attempt_id: ctx.attemptId ?? null,
      request_id: ctx.requestId,
      generation_id: ctx.generationId ?? null,
      round: ctx.round ?? null,
    });
    if (visible) {
      this.events?.publish('turn.tool', {
        conversationId: ctx.roomId, turnId: ctx.turnId, scope: 'private',
        payload: { ...identity(), phase: 'start' },
      });
    }
    // A04（2026-10-24）：通话 memory_only——catalog/define/invoke/直接执行/执行前最后边界
    // 同一策略（effective name 判定）；仅约束模型发起的调用（ctx.turnId 非空），UI/宿主内部调用不受限
    if (ctx.turnId) {
      const effectiveName0 = name === 'tool_invoke' ? String(rawArgs.name ?? '') : name;
      if (this.voiceCallActive(ctx.roomId) && !HostToolExecutor.MEMORY_ONLY_TOOLS.has(effectiveName0)) {
        return { ok: false, output: modelFailure({ error_code: 'TOOL_UNAVAILABLE_IN_CALL', detail: '通话期间非记忆业务工具已关闭（memory_only）；挂断后恢复' }) };
      }
    }
    let result: ToolExecResult;
    try {
      result = await this.executeInner(name, rawArgs, ctx);
    } catch (err) {
      if (visible) {
        this.events?.publish('turn.tool', {
          conversationId: ctx.roomId, turnId: ctx.turnId, scope: 'private',
          payload: { ...identity(), phase: 'error', error: String((err as Error).message ?? err).slice(0, 160) },
        });
      }
      throw err;
    }
    if (visible) {
      this.events?.publish('turn.tool', {
        conversationId: ctx.roomId, turnId: ctx.turnId, scope: 'private',
        payload: { ...identity(), phase: 'result', ok: Boolean(result.ok), error_code: (result.output as { error_code?: string }).error_code ?? null },
      });
    }
    // P02.6：已迁能力的成功/失败投影在 registry 执行外壳内完成唯一一次；
    // 外层投影只作用于尚未迁移集合（同名不双投影）。tool_invoke 的真实能力名沿现行解析。
    const effectiveName = name === 'tool_invoke' ? String(rawArgs.name ?? '') : name;
    const migrated = this.capabilityRegistry !== null && this.capabilityRegistry.has(effectiveName);
    if (result.ok && !migrated) {
      const effectiveArgs = name === 'tool_invoke' ? (rawArgs.arguments as Record<string, unknown> ?? {}) : rawArgs;
      result = { ...result, output: modelResult(effectiveName, effectiveArgs, result.output as Record<string, unknown>) };
    }
    if (!result.ok && !migrated) result = { ...result, output: modelFailure(result.output as Record<string, unknown>) };
    return result;
  }

  private async executeDiscovery(name: string, args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    const set = storedToolset(this.db, ctx.windowId);
    const deny = (code: string): ToolExecResult => ({ok:false,output:{error_code:code}});
    if (set?.protocol !== 'deferred') return deny('TOOL_PROTOCOL_NOT_ACTIVE');
    const allowed = name === 'tool_catalog' ? ['__tool_call_id'] : name === 'tool_define' ? ['name','__tool_call_id'] : ['name','definition_id','arguments','__tool_call_id'];
    if (Object.keys(args).some(k=>!allowed.includes(k))) return deny('TOOL_ARG_UNKNOWN');
    if (name === 'tool_catalog') {
      this.admitBackgroundTool(name, ctx); // 保温批（3aa0164）：后台工具准入记账
      // A04/D39：通话内**新生成**的 catalog 只列记忆与必要通话控制；冻结目录/历史结果不变。
      // 资格判定统一为"已迁能力查条目元数据 + 未迁名查现行清单"（迁移期共存；P09 收口后只剩元数据）。
      const listing = this.voiceCallActive(ctx.roomId) && ctx.turnId
        ? set.catalog.filter(t => this.isMemoryOnlyAllowed(t.function.name))
        : set.catalog;
      return {ok:true,output:{tools:listing.map(t=>({name:t.function.name,description:t.function.description.split(/[。\n]/)[0]}))}};
    }
    const spec = set.catalog.find(t=>t.function.name===args.name);
    if (!spec) return deny('TOOL_NOT_IN_ALLOWLIST');
    if (name === 'tool_define') {
      this.admitBackgroundTool(name, ctx);
      if (definitionWasSeen(this.db,ctx,spec)) return {ok:true,output:{name:spec.function.name,definition_id:definitionId(spec),already_available:true}};
      return {ok:true,output:{definition_id:definitionId(spec),...spec.function}};
    }
    const initialSeen = initialVisibleTools(this.db).includes(spec.function.name) && initialDefinitionSeen(this.db, ctx.windowId, spec);
    if (args.definition_id !== definitionId(spec) || (!definitionWasSeen(this.db,ctx,spec) && !initialSeen)) return deny('TOOL_DEFINITION_NOT_SEEN');
    if (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) return deny('TOOL_ARG_TYPE');
    if (Object.keys(args.arguments).some(k=>k.startsWith('__'))) return deny('TOOL_ARG_UNKNOWN');
    return this.executeInner(spec.function.name, {...args.arguments as Record<string,unknown>,__tool_call_id:args.__tool_call_id},ctx,spec);
  }

  /** D39：通话 memory_only 资格统一判定——已迁能力读条目元数据（capabilities/registry），
   *  未迁名沿现行 MEMORY_ONLY_TOOLS 清单；两者对同一名称结论一致（迁移期共存，集合不相交）。 */
  private isMemoryOnlyAllowed(name: string): boolean {
    const d = this.capabilityRegistry?.get(name);
    if (d) return d.memoryOnlyAllowed;
    return HostToolExecutor.MEMORY_ONLY_TOOLS.has(name);
  }

  private admitBackgroundTool(name: string, ctx: ToolExecContext): void {
    if (ctx.backgroundRunId && !ctx.beforeBackgroundTool) throw new ContractError('BACKGROUND_TOOL_ADMISSION_MISSING');
    if (ctx.beforeBackgroundTool) ctx.beforeBackgroundTool(quoteBackgroundTool(this.db, name));
  }

  private async executeInner(name: string, rawArgs: Record<string, unknown>, ctx: ToolExecContext, frozenSpec?: HostToolSpec): Promise<ToolExecResult> {
    if ((DISCOVERY_NAMES as readonly string[]).includes(name)) return this.executeDiscovery(name,rawArgs,ctx);
    if (!frozenSpec) {
      const set = storedToolset(this.db,ctx.windowId);
      if (set?.protocol === 'deferred') return {ok:false,output:{error_code:'USE_TOOL_INVOKE'}};
      if (set) {
        frozenSpec = set.catalog.find(t=>t.function.name===name);
        if (!frozenSpec) return {ok:false,output:{error_code:'TOOL_NOT_IN_WINDOW'}};
      }
    }
    // P02.6：名称属于已迁集合 → registry 执行外壳（旧业务分支已删，绝不在新路径失败时回退）。
    // 集合不相交：未迁名显式走下方旧路径。同一定义/handler 只有一个来源。
    if (this.capabilityRegistry?.has(name)) {
      return executeRegisteredCapability(this.capabilityRegistry.get(name)!, rawArgs, ctx, frozenSpec, {
        db: this.db,
        isVoiceCallActive: (roomId: string) => this.voiceCallActive(roomId),
      });
    }
    if (name !== 'call_control' && name !== 'context_review_complete' && name !== 'media_import' && name !== 'media_search' && name !== 'background_complete' && name !== 'wake_manage' && name !== 'content_post_create' && name !== 'content_comment_create' && name !== 'content_posts_list' && name !== 'creation_save_artifact' && name !== 'identity_milestone_write' && !name.startsWith('wishstar_')) return { ok: false, output: { error_code: 'TOOL_NOT_IN_ALLOWLIST' } };
    // 审计 A051：参数完整校验后才执行（§8.2）——schema 拒绝不产生副作用
    rawToolCallIdRef.current = typeof rawArgs.__tool_call_id === 'string' ? rawArgs.__tool_call_id : null;
    const checked = validateToolArgs(name, rawArgs, frozenSpec);
    if (!checked.ok) return { ok: false, output: { error_code: checked.code, error: checked.detail } };
    if (rawToolCallIdRef.current !== null) checked.value.__tool_call_id = rawToolCallIdRef.current;
    this.admitBackgroundTool(name, ctx); // 保温批：后台工具准入记账
    if (name === 'content_post_create') return await this.contentPostCreate(checked.value as { presentation?: string; title?: string; body: string; asset_ids?: string[]; idempotency_key: string }, ctx);
    if (name === 'content_comment_create') return await this.contentCommentCreate(checked.value as { post_id: string; body: string; idempotency_key: string }, ctx);
    if (name === 'content_posts_list') return await this.contentPostsList(checked.value as { cursor?: string; limit?: number; presentation?: string }, ctx);
    if (name === 'creation_save_artifact') return await this.creationSaveArtifact(checked.value as { format: 'svg' | 'html'; content: string; client_operation_id: string }, ctx);
    if (name === 'background_complete') return this.backgroundComplete(checked.value as { outcome: 'done' | 'noop' }, ctx);
    if (name === 'wake_manage') return this.wakeManage(checked.value as Record<string, unknown>, ctx);
    if (name === 'media_import') return await this.mediaImport(checked.value as { source_url: string }, ctx);
    if (name === 'media_search') return await this.mediaSearch(checked.value as { query: string; limit?: number }, ctx);
    if (name === 'identity_milestone_write') return this.identityMilestoneWrite(checked.value as { text: string; change_reason: string; idempotency_key: string }, ctx);
    if (name.startsWith('wishstar_')) return await this.wishstarTool(name, checked.value as Record<string, unknown>, ctx);
    return this.reviewComplete(checked.value, ctx);
  }

  /** EST_MARIPOSA_AUTO_SURFACING_V1（docs/05）：已见 ref 门+E 侧 ref→
   *  detail_ref 解析+M detail 快照读取。绝不 recall；不建 view_receipt；
   *  结构化错误码原样作为工具结果返回（错误不吞）。 */
  /** 模型指认的引用核对（她的裁定 2026-10-05 + 审计 D13/D16）：
   *  - 只在**发起请求实际装载的 (消息,修订) 清单**里核对（seenMessages），按该修订的正文逐字匹配——
   *    预算裁剪掉的旧文、请求发出后才编辑的新修订，都不在视野内，引用它们=QUOTE_MATCH_FAILED；
   *  - 每条引述独立定位（倒序指认合法）：从最新可见消息向旧搜索，取不与已消费区间重叠的首个出现；
   *    同一消息允许多个互不重叠片段；同一段文字重复引用（区间重叠）会被拒——不产生重复出处；
   *  - 任一条对不上 → 整单拒绝（不替模型圆谎、不静默丢弃）。
   *  匹配用 indexOf（UTF-16 一致，无碍）；发出的 start/end 换算成码点口径（见 MatchedQuote 注释）。 */
  /** 勾选式话语录入（她 2026-10-18 裁定）：模型只报消息序号（可细到句），
   *  宿主从已见原文直接抄录——一字不差是构造出来的，不再做逐字比对。
   *  可见性门保留 D13/O06 语义：只能选真正见过（所见修订号）的内容；
   *  片段级已见（conversation_read 部分阅读）时，勾选必须整段落在已读
   *  码点范围内。重复/重叠勾选拒绝（防同一句录两次）。 */
  /** G-J-01：主模型按需召回——request_ref 由宿主从回合+调用派生（幂等，
   *  模型不能自编）；同 tool_call 重试同 ref（网络重试返回原逻辑结果）。
   *  结果原样有界透传（服务端安全信封/字段投影已在其内）。 */
  /** 召回包统一装配（start/refine/round2 共用）：形状门（R01/WP-04）、
   *  目标回显（找话第一批）、翻页/续查/深搜提示（P12/R02/找话二批）。 */
  /** WP2（MANUAL_HANDOFF_JUDGE_SWITCH_V1）：同结果集翻页——只消费
   *  memory.recall.page 的冻结结果集；不修改查询（refine 是独立动作，
   *  两类引用分槽不互换）；RECALL_POLICY_CHANGED 如实上抛不自动重查。 */
  /** WP4（§7.2，2026-10-08）：主模型只读原文回读。房间从 ToolExecContext
   *  派生（模型不能自填别的房间）；只返回真实 owner 消息与已正式发布的
   *  assistant；system/tool/草稿/UI 思考不在读取面；长单条按码点分片；
   *  sync_state 如实（本地原话可读，不伪造来源身份）；只读零副作用（不推
   *  进 hold 书签、不制造气泡、不触发明开续期）。seenAdditions 供宿主在
   *  片段**实际进入下一模型请求**后并入已见清单（整条/片段范围）。 */
  /** I/计划只读批（2026-10-10）：memory_i_read——I 的当前话/条目/历史
   *  主动读取（此前只有开窗摘要）。M 端 i.get/i.items.list/i.item.get/
   *  i.item.history/i.versions.read 透传；错误如实上抛不吞。 */
  /** I/计划只读批：plans_read——plan.list（列表，可筛状态）与
   *  plan.get（明细，M 薄实现入口）。写操作属下一批。 */
  /** 明确打开/回忆/留链批（2026-10-10）：memory_open——M 的
   *  open→view.confirm→recollections（keep_wide）→keeps 链透传。
   *  语义铁律：召回/回读返回正文 ≠ 明确打开（回温与"留"只经本链）；
   *  confirm/recollect 必须带 open 签发的 view_receipt；谁留谁撤。 */
  /** 纠错批（2026-10-10）：memory_correct——关系/话语来源/原文绑定三族
   *  纠错 + 关系链接/列表 + 纠错台账。写动作宿主派生 es-cor-* 幂等 op；
   *  M 侧按既有合同核验（word_source 的 CAS expected_source_version、
   *  relation/binding 的闭集动作）；错误如实上抛。
   *  2026-10-18 并入：word_add/word_revise——勾选式话语新增/修改，走
   *  mariposa memory.update（就地改入口；expected_version 由宿主先读
   *  memory.get 取当前值；说话人服务端按出处推导）。 */
  /** 删除审批批（2026-10-10）：deletion_review——decide=jiaming 独占
   *  （M 侧权限门保持双层）；模型面只有审批+读（request/withdraw 是
   *  她的权利，经网页提交）。宿主派生 es-del-* 幂等 op。 */
  /** I/计划写入批（2026-10-10）：memory_i_write——I 条目新增/修订/恢复。
   *  M 侧 jiaming 权限+CAS（expected_revision）核验；冲突/校验错误如实
   *  上抛不吞；无物理删除（修订链语义）。 */
  /** I/计划写入批：plans_write——计划创建/修改/完成/放弃。
   *  create/update 宿主派生 es-pw-* 幂等 operation_id；complete/cancel
   *  走 M 薄实现入口；CAS（expected_version）冲突如实上抛。 */
  /** episode_list：模型按需查事件（蓝图 §6.3——scope 内分页，预算内少量）。 */
  /** episode_get：按 ID 读详情。 */
  /** episode_apply（R05 复审 2026-10-07）：五动作写入口。operation_id 宿主
   *  派生（同 tool_call 重试同 op——业务提交后传输回执未完成时，重试回放
   *  原结果不重复建事件）；scope_id=当前房间（模型不能自编范围）。 */
  /** 审计 F08：换窗评审前的有界恢复探测——按原 operation_id 查 hold.status；
   *  有真实回执 → 落 committed + 迟到书签（只补原窗口记录）；completed=false（服务端明确
   *  无提交证据）→ failed_resolved（不是没发生，是可判定的未提交）；查询失败 → 保持 unknown。 */
  private reviewComplete(args: Record<string, unknown>, ctx: ToolExecContext): ToolExecResult {
    const reviewId = typeof args.review_id === 'string' ? args.review_id : '';
    const decision = args.decision === 'no_new_hold' || args.decision === 'holds_completed' ? args.decision : null;
    if (!reviewId || !decision) return { ok: false, output: { error_code: 'REVIEW_ARGS_INVALID' } };
    if (!ctx.activeReviewId || ctx.activeReviewId !== reviewId) {
      return { ok: false, output: { error_code: 'REVIEW_NOT_ACTIVE', error: '没有活跃的换窗检查（原文仿写不生效）' } };
    }
    const r = this.reviews.complete(reviewId, { review_id: reviewId, decision }, {
      purpose: 'pre_rotate_review', roomId: ctx.roomId, epochId: ctx.windowId,
      epochRevision: this.reviews.get(reviewId)?.epochRevision ?? -1,
    });
    if (!r.ok) return { ok: false, output: { error_code: r.code, error: '宿主核验未通过（真实收据/未决写操作检查）' } };
    const effectId = this.reviews.openEffect({ reviewId, turnId: ctx.turnId, windowId: ctx.windowId, kind: 'review_complete', operationId: null, toolCallId: `${reviewId}:${decision}`, seenSequence: ctx.seenSequence });
    this.reviews.settleEffect(effectId, 'committed', true, null);
    return { ok: true, output: { review_id: reviewId, decision, memory_ids: r.review.memoryIds ?? [] } };
  }
}
