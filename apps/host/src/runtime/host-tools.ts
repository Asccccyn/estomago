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
import { WISHSTARWRITESTAR_DEFINITION, WISHSTARHIDDENSTARS_DEFINITION, WISHSTARSPECIALDATES_DEFINITION, WISHSTARSTARTSESSION_DEFINITION, WISHSTARCONFIRMSESSION_DEFINITION, WISHSTARTAKESTAR_DEFINITION, WISHSTARFINISHSESSION_DEFINITION, WISHSTARREQUESTSTAR_DEFINITION, WISHSTARRESPONDREQUEST_DEFINITION, WISHSTAROFFERSTAR_DEFINITION, WISHSTARLISTOFFERS_DEFINITION, WISHSTARACCEPTOFFER_DEFINITION, WISHSTARNOTIFICATIONS_DEFINITION } from '../modules/wishstar/module.ts';
import { CONTENTPOSTCREATE_DEFINITION, CONTENTCOMMENTCREATE_DEFINITION, CONTENTPOSTSLIST_DEFINITION, CREATIONSAVEARTIFACT_DEFINITION } from '../modules/content/module.ts';
import { WAKEMANAGE_DEFINITION, BACKGROUNDCOMPLETE_DEFINITION } from '../modules/wake/module.ts';
import { MEDIAIMPORT_DEFINITION, MEDIASEARCH_DEFINITION } from '../modules/media/module.ts';
import { IDENTITYMILESTONEWRITE_DEFINITION } from '../modules/identity/module.ts';
import { CONTEXTREVIEWCOMPLETE_DEFINITION } from '../modules/context-review/module.ts';
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
  CONTENTPOSTCREATE_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  CONTENTCOMMENTCREATE_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  CONTENTPOSTSLIST_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  CREATIONSAVEARTIFACT_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  ];
}

function wakeDefinitions(): HostToolSpec[] {
  return [
  WAKEMANAGE_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  BACKGROUNDCOMPLETE_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  ];
}

function mediaDefinitions(): HostToolSpec[] {
  return [
  MEDIAIMPORT_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  MEDIASEARCH_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
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
  IDENTITYMILESTONEWRITE_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  ];
}

function wishstarDefinitions(): HostToolSpec[] {
  return [
  WISHSTARWRITESTAR_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARHIDDENSTARS_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARSPECIALDATES_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARSTARTSESSION_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARCONFIRMSESSION_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARTAKESTAR_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARFINISHSESSION_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARREQUESTSTAR_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARRESPONDREQUEST_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTAROFFERSTAR_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARLISTOFFERS_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARACCEPTOFFER_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  WISHSTARNOTIFICATIONS_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
  ];
}

function contextReviewDefinitions(): HostToolSpec[] {
  return [
  CONTEXTREVIEWCOMPLETE_DEFINITION,  // P04：唯一正本已迁 modules/（逐字搬迁，此处只读同源）,
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


// P01.1：SeenRef/ToolExecContext/ToolExecResult 叶类型正本已迁 capabilities/contracts.ts
//（字段逐一对照；历史语义注释随迁）。顶部纯 type 重导出保持旧消费者兼容。

export class HostToolExecutor {
  private db: Db;
  private tz: string | null;
  private mariposa: MariposaClient | null;
  private surfaceDetailClient: MariposaClient | null;
  private reviews: RotationReviewService;
  private checkpoint: HoldCheckpointService;
  private archiveSync: { drainOnce(): Promise<unknown> } | null;
  private lastMoodVocabRefreshAt = 0;

  constructor(deps: { db: Db; tz?: string | null; mariposa: MariposaClient | null; surfaceDetailClient?: MariposaClient | null; reviews: RotationReviewService; checkpoint: HoldCheckpointService; archiveSync?: { drainOnce(): Promise<unknown> } | null; media?: import('../media/assets.ts').MediaService | null; messages?: import('../messages/service.ts').MessageService | null; contentClient?: import('../integrations/content/client.ts').ContentClient | null; identity?: import('../identity/service.ts').IdentityService | null; events?: import('../events/service.ts').EventService | null; wishstar?: { forward(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<{ status: number; body: Record<string, unknown> }> } | null; taskService?: import('./background-task-service.ts').BackgroundTaskService | null; mediaIndex?: import('../media/index/service.ts').MediaIndexService | null; sirenCall?: import('../integrations/siren/adapter.ts').SirenAdapter | null }) {
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
  private sirenCall: import('../integrations/siren/adapter.ts').SirenAdapter | null;
  /** P02.6：已迁能力注册表（未注入=全部走旧路径，装配前零变化） */
  private capabilityRegistry: CapabilityRegistry | null = null;
  /** P02.6：装配根注入已迁能力注册表（显式创建，非自动发现）。 */
  setCapabilityRegistry(r: CapabilityRegistry | null): void { this.capabilityRegistry = r; }
  /** 架构检查/测试注入面：只读当前注册表快照（不授予执行权）。 */
  getCapabilityRegistry(): CapabilityRegistry | null { return this.capabilityRegistry; }

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
  /** EXEC_V1 §06.4.3（WP5）：模型工具调 content——actor 从受控执行上下文派生为 jiaming。 */
  /** §03.6.3（MEDIA-09/CREATION-03）：保存 SVG/HTML 小作品→持久资产。不执行代码；宿主无 eval/shell。 */
  /** EXEC_V1 §04.6.2 + WAKE_KEEPWARM_V1（2026-10-22）：结束后台回合——noop 是成功结果
   *  （§6.2），无产出不构成失败。自主唤醒与心跳回合均可用（C-13：心跳经 tool_invoke
   *  调用结束工具→正确收口，不再多发一轮无用模型请求）。 */
  /** EXEC_V1 §04.6.2 + WAKE_KEEPWARM_V1（05）：后台正式公开发言——心跳与自主共用；
   *  复用正式发布链（幂等键派生；重试只发一次）。普通最终回复不自动发布（E03）。 */
  /** WAKE_KEEPWARM_V1 §04：wake_manage——char自主预约的唯一工具面。
   *  conversation/actor 取可信 ToolExecContext（schema 不接受注入，W-19）；
   *  schedule/update 受自主开关门（SELF_WAKE_DISABLED）；list/cancel 关闭时仍可用。 */
  /** EXEC_V1 §03.6.3：外部图片持久导入（幂等键由 turn+请求稳定派生，模型不可指定他人操作）。 */
  /** 她批准 2026-10-17：char接入许愿星（superposition）全能力面。
   *  HTTP 转发（Bearer=jiaming 身份，操作归他名下）；幂等键由 turn+request 派生（模型不能自编）；
   *  写操作回执瘦身（不回显正文）；错误如实上抛状态码。 */
  /** 她授权 2026-10-17：char自维护长期记忆里程碑。写新版+manifest I 槽原子更新+审计；
   *  幂等键查 audit_events（同键重试只写一版）；I 槽不参与指纹——当前窗继续旧冻结副本，
   *  下一新窗自动带新版（她裁定，同 §7.1 桶/I 中途修改口径）。
   *  2026-10-22 她要求：条目化——read（带序号）/add/revise/remove（IdentityService 条目操作）。 */
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
    // P04 收尾：全部 48 静态业务工具已迁 registry——成功/失败投影在执行外壳内完成唯一一次；
    // 外层不再有第二投影点（model-results.ts 仅余通用失败映射，由外壳调用）。
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
    // P04 收尾：48 静态业务工具全部经 registry 执行（唯一生产路径；未接线=原 allowlist 拒绝语义）
    return { ok: false, output: { error_code: 'TOOL_NOT_IN_ALLOWLIST' } };
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

}
