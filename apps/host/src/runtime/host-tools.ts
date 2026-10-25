import { oidoModelView } from '../integrations/oido/model-view.ts';
import { sliceByByteBudget, TRANSCRIPT_PAGE_BUDGET_BYTES } from '../media/model-input.ts';
import { modelFailure } from './model-results.ts'; // 成功投影正本已随域（modules/*/projection）；此处仅通用失败映射
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
import { memoryHoldDefinition, MEMORYRECALL_DEFINITION, MEMORYRECALLNEXT_DEFINITION, MEMORYREADFULL_DEFINITION, MEMORYIREAD_DEFINITION, PLANSREAD_DEFINITION, MEMORYIWRITE_DEFINITION, PLANSWRITE_DEFINITION, MEMORYOPEN_DEFINITION, MEMORYCORRECT_DEFINITION, DELETIONREVIEW_DEFINITION, EPISODELIST_DEFINITION, EPISODEAPPLY_DEFINITION, EPISODEGET_DEFINITION } from '../modules/memory/module.ts';
import { HOLD_CATEGORIES, HOLD_CREATION_MODES, HOLD_DATE_CONFIDENCE, HOLD_TITLE_MAX } from '../modules/memory/hold-contract.ts';
import { WISHSTARWRITESTAR_DEFINITION, WISHSTARHIDDENSTARS_DEFINITION, WISHSTARSPECIALDATES_DEFINITION, WISHSTARSTARTSESSION_DEFINITION, WISHSTARCONFIRMSESSION_DEFINITION, WISHSTARTAKESTAR_DEFINITION, WISHSTARFINISHSESSION_DEFINITION, WISHSTARREQUESTSTAR_DEFINITION, WISHSTARRESPONDREQUEST_DEFINITION, WISHSTAROFFERSTAR_DEFINITION, WISHSTARLISTOFFERS_DEFINITION, WISHSTARACCEPTOFFER_DEFINITION, WISHSTARNOTIFICATIONS_DEFINITION } from '../modules/wishstar/module.ts';
import { CONTENTPOSTCREATE_DEFINITION, CONTENTCOMMENTCREATE_DEFINITION, CONTENTPOSTSLIST_DEFINITION, CREATIONSAVEARTIFACT_DEFINITION } from '../modules/content/module.ts';
import { WAKEMANAGE_DEFINITION, BACKGROUNDCOMPLETE_DEFINITION } from '../modules/wake/module.ts';
import { MEDIAIMPORT_DEFINITION, MEDIASEARCH_DEFINITION } from '../modules/media/module.ts';
import { IDENTITYMILESTONEWRITE_DEFINITION } from '../modules/identity/module.ts';
import { CONTEXTREVIEWCOMPLETE_DEFINITION } from '../modules/context-review/module.ts';
export { HOLD_CATEGORIES, HOLD_CREATION_MODES, HOLD_DATE_CONFIDENCE, HOLD_TITLE_MAX } from '../modules/memory/hold-contract.ts';
import { DISCOVERY_META, isDiscoveryFree } from '../capabilities/model-bridge.ts';

import { ContractError } from './or-contract.ts';
// P01.1：叶类型正本迁至 capabilities/contracts.ts；此处纯 type 重导出为过渡兼容
//（消费者逐步改指 contracts；删除批次登记在 MIGRATION_MATRIX / P09）。
import type { HostToolSpec, SeenRef, ToolExecContext, ToolExecResult } from '../capabilities/contracts.ts';
export type { HostToolSpec, SeenRef, ToolExecContext, ToolExecResult };
import { CapabilityRegistry } from '../capabilities/registry.ts';
import { executeRegisteredCapability } from '../capabilities/executor.ts';

// P04.5：心情词表状态与受控刷新已迁 modules/memory/mood-vocab.ts（memory catalog 正本）；
// 词表变更经装配回调失效本目录缓存（下方注册），宿主不再持有第二份词表状态。

// S17b 批次3：目录装配双正本删除——目录唯一来源=CapabilityRegistry.currentCatalog()
// （modules/*/module.ts 定义工厂 + baselineOrder）。BASELINE_TOOL_ORDER/域工厂聚合/
// hostToolsCache/mood 回调全部移除。


// P01.1：SeenRef/ToolExecContext/ToolExecResult 叶类型正本已迁 capabilities/contracts.ts
//（字段逐一对照；历史语义注释随迁）。顶部纯 type 重导出保持旧消费者兼容。

