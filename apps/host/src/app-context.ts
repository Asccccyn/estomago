import { supportsSurfacingTransport, SURFACE_HOST_NOTICE } from './memory-surfacing/contracts.ts';
// 组合根：把配置、DB 与各服务装配成一个可启动/可停止的 Host。
// 测试用 createHost({ stateRoot: 临时目录, config: buildConfig({...}) }) 直接构建。
import http from 'node:http';
import fs from 'node:fs';
import { buildPaths, type EstomagoPaths } from './config/paths.ts';
import type { Config } from './config/schema.ts';
import { openDatabase, type Db } from './db/connection.ts';
import { migrate, schemaVersion } from './db/migrations.ts';
import { sha256Hex } from './util/id.ts';
import { Logger } from './observability/logging.ts';
import { stableErrorCode } from './observability/errors.ts';
import { EventService } from './events/service.ts';
import { createOidoDeleteRetryLifecycle } from './modules/oido/lifecycle.ts';
import { MessageService } from './messages/service.ts';
import { PRIMARY_CONVERSATION } from './messages/constants.ts';
import { IdentityService } from './identity/service.ts';
import { CapabilityMatrix } from './runtime/capabilities.ts';
import { selectRunner, type RunnerSelection, type AgentRunner } from './runtime/runner.ts';
import { SubscriptionAccessRunner } from './runtime/subscription-access.ts';
import { ReasoningService } from './reasoning/service.ts';
import { UsageCollector } from './usage/collector.ts';
import { RoutingService } from './routing/service.ts';
import { WindowManager } from './windows/manager.ts';
import { TurnSupervisor } from './runtime/supervisor.ts';
import { recoveryPass, recoverSchedule } from './runtime/recovery.ts';
import { AuthService } from './auth/tokens.ts';
import { handleRequest, type RequestDeps } from './server/http.ts';
import { MariposaClient } from './integrations/mariposa/client.ts';
import { ArchiveSyncService } from './integrations/mariposa/archive-sync.ts';
import { RotationReviewService } from './context/rotation-review.ts';
import { ManualSelectionService } from './context/manual-selection.ts';
import { HoldCheckpointService } from './memory/hold-checkpoint.ts';
import { ModelToolBridge } from './capabilities/model-bridge.ts';
import { WindowTrajectoryService } from './runtime/window-trajectory.ts';
import { RuntimeSettingsService } from './runtime/runtime-settings.ts';
import { SystemAlertService } from './observability/system-alerts.ts';
import { MediaService } from './media/assets.ts';
import { VoiceService } from './media/voice.ts';
import { BackgroundSettingsService } from './runtime/background-settings.ts';
import { BackgroundScheduler } from './runtime/background-scheduler.ts';
import { runMediaBackfillTick } from './media/index/backfill.ts';
import { BackgroundTaskService } from './runtime/background-task-service.ts';
import { ConversationActivityService } from './runtime/wake-activity.ts';
import { contentClientFor, contentForward } from './integrations/content/client.ts';
import { ContentOperationCoordinator } from './integrations/content/coordinator.ts';
import { SurfacingService } from './memory-surfacing/service.ts';
import { SolDecisionJudge, SOL_DECISION_SCHEMA_VERSION } from './memory-surfacing/sol-provider.ts';

export type HostOptions = {
  stateRoot: string;
  config: Config;
  logDir: string | null;
  bind: string;
  port: number; // 0 = 随机端口（测试）
  /** 测试接缝：仅 provider=mock 且 ESTOMAGO_TEST_MODE=1 时生效——注入闸控 runner
   *  获得确定性派发时机。生产装配不传。 */
  runnerOverride?: AgentRunner;
};

export class Host {
  readonly paths: EstomagoPaths;
  readonly config: Config; // F-J-31：构造器赋值的字段补声明（typecheck 基线）
  readonly opts: HostOptions;
  readonly db: Db;
  readonly logger: Logger;
  readonly events: EventService;
  readonly messages: MessageService;
  readonly identity: IdentityService;
  readonly capabilities: CapabilityMatrix;
  readonly runnerSelection: RunnerSelection;
  readonly reasoning: ReasoningService;
  readonly usage: UsageCollector;
  readonly routing: RoutingService;
  readonly windows: WindowManager;
  readonly supervisor: TurnSupervisor;
  readonly auth: AuthService;
  readonly alerts: SystemAlertService | null; // EXEC_V1 WP1：系统异常红点（最小装配可为 null）
  readonly scheduler: import('./runtime/background-scheduler.ts').BackgroundScheduler | null; // EXEC_V1 WP4
  /** R8′（2026-10-23）：媒体索引后台补全——独立定时器/单飞门/批次中止（不经调度器与会话串行链） */
  private mediaBackfillTimer: ReturnType<typeof setInterval> | null = null;
  private mediaBackfillTicking = false;
  private mediaBackfillAbort: AbortController | null = null;
  private mediaIndexRef: import('./media/index/service.ts').MediaIndexService | null = null;
  /** 相册重构 P2：M 落正待同步批次的后台一跳（单飞门；无模型执行） */
  private mediaSyncTimer: ReturnType<typeof setInterval> | null = null;
  private mediaSyncTicking = false;
  private mediaSyncStore: import('./integrations/mariposa/media-store.ts').MariposaMediaStore | null = null;
  private mediaServiceRef: import('./media/assets.ts').MediaService | null = null;
  /** 同步失败退避（进程内；重启归零重试一轮，与 media/index/backfill.ts 同款如实记录） */
  private readonly mediaMSyncRetryNotBefore = new Map<string, number>();
  private oidoRef: import('./integrations/oido/adapter.ts').OidoAdapter | null = null;
  private sirenCallRef: import('./integrations/siren/adapter.ts').SirenAdapter | null = null;
  /** P03.8：oído 接入模块生命周期（删除传播重试 timer 的 start/stop 包装；行为逐字保持） */
  private oidoLifecycle: import('./modules/oido/lifecycle.ts').OidoModuleLifecycle | null = null;
  readonly surfacing: SurfacingService | null; // 自动浮现（默认 disabled；未启用=零作业零网络）
  readonly archiveSync: ArchiveSyncService;
  private readonly voiceObservations: import('./modules/oido/observations.ts').VoiceObservationService | null;
  private readonly callReplyLinks: import('./modules/voice/call-links.ts').CallReplyLinkService | null;
  /** P1（F06/F07 20261106）：内容写协调器——意图/pin/确认/恢复；浏览器、模型与启动恢复共用 */
  private readonly contentOps: ContentOperationCoordinator | null;
  private callReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private callReconcileWork: Promise<void> | null = null;
  private readonly callReconcileAbort = new AbortController();
  readonly server: http.Server;
  port = 0;

  private constructor(
    config: Config,
    opts: HostOptions,
    server: http.Server,
    deps: Omit<RequestDeps, 'config'>,
    archiveSync: ArchiveSyncService,
  ) {
    this.config = config;
    this.opts = opts;
    this.paths = deps.paths;
    this.db = deps.db;
    this.logger = deps.logger;
    this.events = deps.events;
    this.messages = deps.messages;
    this.identity = deps.identity;
    this.capabilities = deps.capabilities;
    this.runnerSelection = deps.runnerSelection;
    this.reasoning = deps.reasoning;
    this.usage = deps.usage;
    this.routing = deps.routing;
    this.windows = deps.windows;
    this.supervisor = deps.supervisor;
    this.auth = deps.auth;
    this.alerts = deps.alerts ?? null;
    this.scheduler = deps.scheduler ?? null;
    this.mediaIndexRef = deps.mediaIndex ?? null; // R8′：后台补索引独立循环
    this.mediaServiceRef = deps.media ?? null; // 相册重构 P2：M 落正待同步循环
    this.mediaSyncStore = deps.mediaMasterStore ?? null;
    this.oidoRef = deps.oido ?? null;
    this.oidoLifecycle = createOidoDeleteRetryLifecycle(deps.db, () => this.oidoRef);
    this.surfacing = deps.surfacing ?? null;
    this.sirenCallRef = deps.sirenCall ?? null; // JV-04：启动对账用（Siren 正本查询）
    this.archiveSync = archiveSync;
    this.voiceObservations = deps.voiceObservations ?? null;
    this.callReplyLinks = deps.callReplyLinks ?? null;
    this.contentOps = deps.contentOps ?? null;
    this.server = server;
  }

  static async create(opts: HostOptions): Promise<Host> {
    const paths = buildPaths(opts.stateRoot);
    for (const dir of [paths.stateRoot, paths.configDir, paths.identityDir, paths.dataDir, paths.workspacesDir, paths.sdkStateDir, paths.mediaDir, paths.backupsDir, paths.runDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const logger = new Logger(opts.logDir);
    const db = openDatabase(paths.dataDir);
    const applied = migrate(db, sha256Hex);
    if (applied.applied.length > 0) logger.info('db_migrated', { versions: applied.applied.join(','), schema_version: schemaVersion(db) });

    const events = new EventService(db);
    // 自动浮现（SOL_RECALL_REFACTOR 2026-10-30）：M 走专用受限 service binding
    // （surfacing_credential_ref，不回退聊天/归档凭据）；Sol 判断走独立 OpenAI
    // Responses key（sol.api_key_env，凭据职责分离）。enabled=false 时服务仍装配
    // （表结构就绪）但零作业/零网络/零凭据读取。缺 key 不禁用功能——作业照常
    // 登记并以 SURFACE_SOL_NOT_CONFIGURED 收口（真实原因可诊断，不伪装 none）。
    const surfaceCfg = opts.config.memory_surfacing;
    if (surfaceCfg.enabled && !supportsSurfacingTransport(opts.config.runtime.provider)) {
      logger.warn('surface_transport_unsupported', { provider: opts.config.runtime.provider, code: 'SURFACE_PROFILE_UNSUPPORTED' });
    }
    const surfaceMariposaClient = new MariposaClient({
      baseUrl: opts.config.integrations.mariposa.base_url ?? undefined,
      credentialEnv: surfaceCfg.surfacing_credential_ref,
    });
    const solJudge = new SolDecisionJudge({
      apiKeyEnv: surfaceCfg.sol.api_key_env,
      baseUrl: surfaceCfg.sol.base_url,
      model: surfaceCfg.sol.model,
      reasoningEffort: surfaceCfg.sol.reasoning_effort,
      verbosity: surfaceCfg.sol.verbosity,
      maxOutputTokens: surfaceCfg.sol.max_output_tokens,
      cacheTtl: surfaceCfg.sol.cache_ttl,
      cacheKeySeed: sha256Hex(`surface-sol:${opts.stateRoot}`).slice(0, 16),
      userDisplayName: surfaceCfg.sol.user_display_name,
      assistantDisplayName: surfaceCfg.sol.assistant_display_name,
      templateOverride: surfaceCfg.sol.decision_template,
      templateRevision: SOL_DECISION_SCHEMA_VERSION,
    });
    const surfacing = new SurfacingService(
      db,
      surfaceMariposaClient,
      solJudge,
      {
        enabled: surfaceCfg.enabled && supportsSurfacingTransport(opts.config.runtime.provider),
        transport_overhead_text: SURFACE_HOST_NOTICE,
        // R9（裁定 2026-11-03）：调度身份来自配置（E 自身版本，不再是
        // 冒充 M 的硬编码 1/surface_prepare_v2）；M 实际执行版本由
        // prepare 响应读取落盘（surfacing_jobs.m_policy_revision 等）
        policy_revision: surfaceCfg.job_policy_revision,
        prompt_prepare_revision: surfaceCfg.job_prompt_revision,
        delivery_deadline_ms: surfaceCfg.delivery_deadline_ms,
        max_added_tokens_per_turn: surfaceCfg.max_added_tokens_per_turn,
        max_packet_bytes: surfaceCfg.max_packet_bytes,
        worker_concurrency: surfaceCfg.worker_concurrency,
        recent_user_messages: surfaceCfg.recent_user_messages,
        recent_window_bytes: surfaceCfg.recent_window_bytes,
      },
      logger,
      events,
    );
    // 保存的模板/模型/开关覆盖与配置文件合并，仍由同一服务消费。
    surfacing.restoreSavedSettings();
    // WAKE_KEEPWARM_V1 §05：真实活动锚点投影（L/维护回执 CAS）——消息服务与
    // supervisor/调度器共用同一实例；未迁移旧库行=如实空（unknown），不猜。
    const activity = new ConversationActivityService(db);
    // 相册重构 P2（GLM_ALBUM_REFACTOR_EXECUTION 20261108）：M 媒体间落正客户端——
    // mariposa base_url + 主凭据引用配置齐备才装配；M 未配置时保存仍走本地（同步状态如实 pending）。
    const mediaStore = opts.config.integrations.mariposa.base_url && opts.config.integrations.mariposa.credential_ref
      ? new (await import('./integrations/mariposa/media-store.ts')).MariposaMediaStore({
        baseUrl: opts.config.integrations.mariposa.base_url,
        credentialEnv: opts.config.integrations.mariposa.credential_ref,
      })
      : null;
    const media = new MediaService(db, paths.mediaDir, opts.config, mediaStore);
    const oido = opts.config.integrations.oido.base_url
      ? new (await import('./integrations/oido/adapter.ts')).OidoAdapter(opts.config.integrations.oido)
      : null;
    const oidoSources = new (await import('./modules/oido/source-repository.ts')).OidoSourceRepository(db);
    const archiveCredRef = opts.config.integrations.mariposa.archive_credential_ref
      ?? (process.env.ESTOMAGO_TEST_MODE === '1' ? opts.config.integrations.mariposa.credential_ref : null);
    const archiveMariposaClient = new MariposaClient({
      baseUrl: opts.config.integrations.mariposa.base_url ?? undefined,
      credentialEnv: archiveCredRef,
    });
    const voiceObsService = new (await import('./modules/oido/observations.ts')).VoiceObservationService(db, {
      hearing: oido ? new (await import('./modules/oido/service.ts')).OidoHearingService({ db, oido, sources: oidoSources, audio: media, artifacts: media }) : null,
      archiveClient: opts.config.archive.enabled ? archiveMariposaClient : null,
      streamId: opts.config.archive.source_scope ?? 'estomago-primary-live',
      logger,
      // P2（V01）：资格终结时取消 O 在途分析（fence 落 cancelled；取消失败不阻塞收口）
      cancelAnalysis: (analysisId) => oido!.cancelAnalysis(analysisId),
    });
    const messages = new MessageService(db,
      // P05.3：生命周期消费者装配（浮现登记/编辑撤销 + 活动锚点保持原端口 + 语音观察登记）
      (await import('./application/message-lifecycle.ts')).bindMessageLifecycle({
        surfacing,
        activity,
        voiceObservations: {
          ensureForMessage: (messageId, revision, conversationId) => voiceObsService.ensureForMessage(messageId, revision, conversationId, voiceObsService.configured),
          wake: () => voiceObsService.wake(),
          // RV01（复审 20261106）：修订被取代/派发前取消＝观察资格终结（abandoned）
          abandonRevision: (messageId, revision) => voiceObsService.decideQualification({ messageId, revision }, 'abandoned'),
        },
      }),
      activity);
    // EXEC_V1 WP1：系统异常红点（一套表+现有 SSE；未装配任何后台，纯观测面）
    const alerts = new SystemAlertService(db, events);
    const identity = new IdentityService(opts.config, paths);
    const capabilities = new CapabilityMatrix(opts.config);
    const settings = new RuntimeSettingsService(db);
    const runnerSelection: RunnerSelection = opts.config.runtime.provider === 'mock'
      ? await selectRunner(opts.config)
      : { status: 'ok', runner: new SubscriptionAccessRunner(opts.config, settings) };
    // 测试接缝（仅 provider=mock 且 TEST_MODE）：注入闸控 runner 以获得确定性的
    // 派发时机（编辑/取消类用例不再与 mock 的毫秒级完成竞速）。生产不传此参数。
    const runnerOverride = opts.config.runtime.provider === 'mock' && process.env.ESTOMAGO_TEST_MODE === '1' ? opts.runnerOverride : undefined;
    const effectiveRunnerSelection: RunnerSelection = runnerOverride ? { status: 'ok', runner: runnerOverride } : runnerSelection;
    // EXEC_V1 02 §4.1（ALERT-07）：SDK 无 TTL 装配证据——显示面经 records.ttlVerification
    // 分离 desired/effective/verification（不得显示"已生效 1h"）。聚合告警在 WP2 核最终
    // options 时按真实证据观察（开机观测会污染事件序列，不是证据点）。
    const reasoning = new ReasoningService(db, events);
    const usage = new UsageCollector(db, alerts); // EXEC_V1 WP1：矛盾终值→USAGE_INCONSISTENT 告警
    const routing = new RoutingService(db, events, messages);
    // WP3（2026-10-08）：人工历史选集——新窗历史携带的唯一来源；窗口
    // 切换事务与 supervisor 共用同一服务实例（选集消费原子性）
    const selections = new ManualSelectionService(db);
    // 2026-10-08 她裁定：运行时换模型/推理等级——override 持久正本；
    // WindowManager 经 provider 读生效视图（新窗按生效型号存指纹）
    // WP-07（CX-09）：初始轨迹写入切换事务所需（先于 WindowManager 构造）
    const trajectory = new WindowTrajectoryService(db);
    const windows = new WindowManager(db, identity, opts.config, selections, trajectory);
    const auth = new AuthService(paths);
    // EXEC_V1 WP3：媒体服务（同进程；文件进 paths.mediaDir——不另起服务）
    const voice = new VoiceService(db, media, opts.config);
    messages.ensureConversation(PRIMARY_CONVERSATION, '私聊');
    // 原文归档同步：archive.enabled 且 mariposa base_url 已配置才实际发送。
    // 审计 F11（LC-050）：归档 worker 与主模型使用不同凭据引用（archive_credential_ref
    // 未配置时回退共用——仅限开发；生产必须给归档签发受限 stream token）。凭据值只在
    // 各自 transport 请求头构造处读取，绝不进日志。
    const modelMariposaClient = new MariposaClient({
      baseUrl: opts.config.integrations.mariposa.base_url ?? undefined,
      credentialEnv: opts.config.integrations.mariposa.credential_ref,
    });
    // 审计 F11：受限归档凭据缺失时——测试模式允许回退共用（联调）；生产形态直接不给归档客户端
    // 发凭据（ArchiveSyncService 发送将 401，如实 failed），不允许 worker 静默持有主模型业务凭据。
    const archiveSync = new ArchiveSyncService({ db, events, logger, client: archiveMariposaClient, config: opts.config, alerts });
    // §3/§8.2：hold 书签、换窗评审、宿主固定工具集（memory.hold 经主模型凭据的客户端；
    // 端到端在 Mariposa 接口上线前 BLOCKED——客户端错误如实回给模型，不伪造成功）
    const reviews = new RotationReviewService(db);
    const checkpoint = new HoldCheckpointService(db);
    // 工具执行器需要 db（引用逐字核对/来源收据查询）与 archiveSync（被引消息缺收据时先补一发同步）
    // EXEC_V1 WP5：content 薄代理（content.enabled=true 且凭据文件存在才装配）
    const contentClient = contentClientFor(paths.stateRoot, opts.config.content.port, opts.config.content.enabled);
    // P1（F06/F07 20261106）：内容写协调器——先解析原操作、HTTP 前持久意图+pin、
    // 成功后按权威快照确认映射、未知结果由恢复消费者按原身份收口。同一实例装给
    // 浏览器代理、模型写工具与 Host 启动恢复。
    const contentOps = contentClient ? new ContentOperationCoordinator({ db, client: contentClient, media, logger }) : null;
    // 许愿星接入（她 2026-10-17 批准）：开窗临近纪念日提醒 + char全能力工具面
    const { WishstarClient } = await import('./integrations/wishstar/client.ts');
    const wishstar = opts.config.wishstar.enabled ? new WishstarClient(opts.config.wishstar) : null;
    // WAKE_KEEPWARM_V1（2026-10-22）：后台设置与预约管理正本——HTTP 管理面、
    // wake_manage 工具、调度器共用同一实例（单一正本，不另写第二套业务）。
    const bgSettings = new BackgroundSettingsService(db, opts.config);
    const taskService = new BackgroundTaskService(db, bgSettings);
    // S-06：心跳让位检查经可变引用接线（scheduler 在 supervisor 之后构造）
    let schedulerRef: import('./runtime/background-scheduler.ts').BackgroundScheduler | null = null;
    // JOINT-VOICE-20261022：oído 深听适配（HTTP 叶子；base_url 未配=不装配，工具/门控如实降级）
    // JOINT-VOICE-20261022（07）：媒体语义索引（worker 未配置=null，检索能力如实不可用）
    const mediaIndex = opts.config.media_embedding.base_url
      ? new (await import('./media/index/service.ts')).MediaIndexService(db, media, new (await import('./media/index/service.ts')).MediaEmbedWorkerClient(opts.config.media_embedding))
      : null;
    // 协议①②（2026-10-24）：Siren 通话面适配器（邀请/接听/拒接/原声取回；loopback 内部凭据）
    const sirenCallCfg = opts.config.integrations.siren;
    const sirenCall = sirenCallCfg.base_url && sirenCallCfg.credential_ref && process.env[sirenCallCfg.credential_ref]
      ? new (await import('./integrations/siren/adapter.ts')).SirenAdapter(sirenCallCfg.base_url, process.env[sirenCallCfg.credential_ref]!)
      : null;
    // A04（联合审计 2026-10-27）：通话回复媒体关联 worker——Siren turn-audio 拉取→est 助手
    // 消息持久绑定→deep_listen assistant 观察→source.attachments.sync 补同步（幂等/可恢复）
    const callReplyLinks = new (await import('./modules/voice/call-links.ts')).CallReplyLinkService({
      db, sirenCall, media,
      voiceObservations: voiceObsService,
      attachmentsClient: opts.config.archive.enabled ? archiveMariposaClient : null,
      streamId: opts.config.archive.source_scope ?? 'estomago-primary-live',
      logger,
      // B2（2026-11-04）：附件绑定成功→message.media.updated（复用 EventService 持久/分发/回放链）
      events,
      getMessage: (id: string) => messages.getMessage(id) as unknown as Record<string, unknown> | null,
    });
    // P02.6：显式能力注册表装配（非自动发现）。本批只登记 oído 已迁能力（oido_get）；
    // 未迁工具继续走 HostToolExecutor 旧路径（集合不相交），旧路径不作为新路径回退。
    const capabilityRegistry = new (await import('./capabilities/registry.ts')).CapabilityRegistry();
    // P04.2-4：memory 域（14 工具；同一服务实例供换窗评审恢复窄委托）
    const memoryService = (await import('./modules/memory/module.ts')).registerMemoryCapabilities(capabilityRegistry, {
      db, tz: opts.config.time.business_timezone, mariposa: modelMariposaClient, surfaceDetailClient: surfaceMariposaClient, reviews, checkpoint, archiveSync,
    });
    (await import('./modules/oido/module.ts')).registerOidoCapabilities(capabilityRegistry, {
      db, oido, sources: oidoSources, audio: media, artifacts: media,
    });
    const tools = new ModelToolBridge({ db, events });
    tools.setCapabilityRegistry(capabilityRegistry);
    tools.setMemoryRecovery(memoryService);
    // P04.6-10：剩余域全部登记（wishstar/content/wake/media/identity/context-review）
    (await import('./modules/wishstar/module.ts')).registerWishstarCapabilities(capabilityRegistry, { wishstar });
    (await import('./modules/content/module.ts')).registerContentCapabilities(capabilityRegistry, { contentClient, media, contentOps });
    (await import('./modules/wake/module.ts')).registerWakeCapabilities(capabilityRegistry, { db, taskService });
    const mediaTools = (await import('./modules/media/module.ts')).registerMediaCapabilities(capabilityRegistry, { db, media, mediaIndex, contentClient });
    (await import('./modules/identity/module.ts')).registerIdentityCapabilities(capabilityRegistry, { db, identity });
    (await import('./modules/context-review/module.ts')).registerContextReviewCapabilities(capabilityRegistry, { db, reviews, checkpoint });
    tools.setMemoryRecovery(memoryService);
    const supervisor = new TurnSupervisor({
      mediaTools,
      wishstar,
      voiceObservations: voiceObsService,
      // JOINT-VOICE：听觉可用=配置声明（adapter 凭据就绪），不在发送关键路径探测
      oidoHearing: oido?.configured === true,
      db,
      config: opts.config,
      messages,
      events,
      identity,
      capabilities,
      runnerSelection: effectiveRunnerSelection,
      reasoning,
      usage,
      routing,
      windows,
      logger,
      archiveSync,
      tools,
      reviews,
      checkpoint,
      trajectory,
      selections,
      contentClient, // 相册重构 P5：携带集合读取/消费（未启用=null=如实无携带）
      settings,
      alerts,
      media,
      activity,
      keepwarmYieldCheck: (runId) => schedulerRef?.isYieldRequested(runId) ?? false,
      surfacing: surfacing.enabled ? surfacing : undefined,
      // S18 口径：未接线=如实无 B。base_url 未配置（仅开发/测试态）时不装配
      // bootstrap 端口——装一个必然抛错的客户端只会制造 BOOTSTRAP_INCOMPLETE 噪声。
      bootstrap: opts.config.integrations.mariposa.base_url ? modelMariposaClient : null,
      // 宿主用户 2026-11-07 裁定：开窗"运行中事项"片段随开窗包冻结（3 条、近期引用热度排序）
      episodes: opts.config.integrations.mariposa.base_url ? { list: (a: { scopeId: string; states?: string[]; limit?: number }, signal?: AbortSignal) => modelMariposaClient.episodeList(a, signal) } : null,
      toolCatalog: capabilityRegistry,
    });
    // voice 域能力与同一消息/媒体服务装配。
    (await import('./modules/voice/module.ts')).registerVoiceCapabilities(capabilityRegistry, {
      db, sirenCall, media, messages, events,
      // RB01（复审 20261106）：accept_call 建呼也走统一 Sol 作业失效触发
      surfacing: surfacing.enabled ? surfacing : null,
    });
    // P04.1：conversation 域（conversation_read/chat_send_text/chat_send_attachment）
    (await import('./modules/conversation/module.ts')).registerConversationCapabilities(capabilityRegistry, {
      db, tz: opts.config.time.business_timezone, messages, media, events, archiveSync,
    });

    // EXEC_V1 WP4 + WAKE_KEEPWARM_V1（2026-10-22）：后台设置+调度器（宿主内单实例）。
    // 调度器只做 SQL 到期检查与领取；模型执行经 supervisor.enqueueBackground 进入同一
    // 会话串行链（03 统一执行入口——chatBusy 用户在场门已删，排队与让位在执行位内处理）。
    const scheduler: import('./runtime/background-scheduler.ts').BackgroundScheduler = new BackgroundScheduler({
      db, config: opts.config, settings: bgSettings, alerts,
      executor: (await import('./application/background-execution.ts')).createBackgroundExecution({
        db, messages, events, bgSettings, supervisor,
        // 构造期 scheduler 尚未就绪——经 schedulerRef 惰性转发（调用发生在 tick 之后）
        scheduler: { recordDispatchStart: (...args: Parameters<BackgroundScheduler['recordDispatchStart']>) => schedulerRef!.recordDispatchStart(...args) },
      }),
    });
    schedulerRef = scheduler;
    const bgExecutorReady = { autonomous: true, keepwarm: true }; // 执行器已接线；付费请求另受价格门（BUDGET_ESTIMATE_UNAVAILABLE 如实挡)
    // AUD-02 P1：注入关闭→终止回调
    bgSettings.onDisable = (kind) => scheduler.disableKind(kind);
    const deps: Omit<RequestDeps, 'config'> = {
      paths,
      db,
      logger,
      events,
      messages,
      identity,
      capabilities,
      runnerSelection: effectiveRunnerSelection,
      reasoning,
      usage,
      routing,
      windows,
      supervisor,
      auth,
      archiveSync,
      selections,
      settings,
      alerts,
      media,
      bgSettings,
      scheduler,
      mediaIndex: mediaIndex ?? undefined,
      mediaMasterStore: mediaStore ?? undefined,
      oido: oido ?? undefined,
      voiceObservations: voiceObsService,
      callReplyLinks,
      sirenCall: sirenCall ?? undefined,
      tools,
      bgExecutorReady,
      taskService,
      activity,
      contentClient,
      contentOps,
      voice,
      surfacing,
    };
    const server = http.createServer((req, res) => {
      handleRequest(req, res, { ...deps, config: opts.config }).catch((err) => {
        // §26（AUD-28）：不记录 req.url（query 可能带秘密）——只记方法与 pathname
        let pathname: string | null = null;
        try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { pathname = null; }
        logger.error('request_unhandled', { code: stableErrorCode(err), method: req.method, pathname });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { code: 'internal', message: '内部错误（详情见日志，不含敏感内容）' } }));
        } else {
          res.end();
        }
      });
    });

    const host = new Host(opts.config, opts, server, deps, archiveSync);
    return host;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.opts.port, this.opts.bind, () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr !== null ? addr.port : this.opts.port;
    // AUD-10（2026-10-24 接线修复）：崩溃清残必须先于重派——running 悬挂 turns/attempts/
    // streaming/PREPARING 窗/孤儿票据 owner 落确定终态，waiting_route_gate 无票释放回
    // pending 后正好被下方 recoverSchedule 接管。此前 recoveryPass 仅被测试直接调用，
    // 生产启动从未执行（AUD-10 验收实际未生效——F25 同款"测试绿但未接线"模式）。
    this.voiceObservations?.start();
    this.callReplyLinks?.start();
    const recovered = recoveryPass(this.db, this.logger);
    // §9/§10：正式启动路径——恢复后重派 committed-but-not-dispatched（数据库是真源）
    const sched = recoverSchedule({ db: this.db, config: this.config, messages: this.messages, events: this.events, identity: this.identity, capabilities: this.capabilities, runnerSelection: this.runnerSelection, reasoning: this.reasoning, usage: this.usage, routing: this.routing, windows: this.windows, supervisor: this.supervisor, logger: this.logger });
    void recovered; // 清残计数经 recovery_pass warn 日志留痕（RECOVERY_HOST_RESTART）
    // 启动恢复同步：崩溃遗留的 pending/unknown_outcome 按稳定 op 重放（未启用时 no-op）
    void this.archiveSync.drainOnce().catch((err) => {
      this.logger.warn('archive_sync_startup_failed', { code: stableErrorCode(err) });
    });
    // 生死仍以 Siren 为正本；Host 只拥有这个可取消的对账任务。
    this.reconcileCalls();
    if (this.sirenCallRef) {
      this.callReconcileTimer = setInterval(() => this.reconcileCalls(), 60_000);
      this.callReconcileTimer.unref?.();
    }
    // EXEC_V1 §04.9.2：调度器随宿主恢复一次（孤儿处置在 start() 内）——单一唤醒源
    this.scheduler?.start();
    // R8′（2026-10-23）：媒体索引后台补全——独立任务边界（不经调度器/会话串行链：
    // scheduler 的模型执行经 enqueueBackground 进 runSerialized，搬进去只是换入口排队）。
    // 有界批次（≤5 图/tick）+ 单飞门 + 每批独立 AbortController；worker 60s 请求边界不变。
    this.mediaBackfillTimer = setInterval(() => { void this.mediaBackfillTick(); }, 15_000);
    this.mediaBackfillTimer.unref?.();
    // 相册重构 P2：M 落正待同步推进——同 backfill 的独立任务边界（单飞、有界批次、
    // 不进调度器串行链）。指数退避按行上 attempts 计算（30s·2^min(n,5)）。
    this.mediaSyncTimer = setInterval(() => { void this.mediaMSyncTick(); }, 15_000);
    this.mediaSyncTimer.unref?.();
    // R6′（P03.8 起经模块生命周期）：oído 删除传播重试——独立定时器行为不变
    this.oidoLifecycle?.start();
    // P1（F06/F07）：内容写恢复消费者——启动清一遍崩溃遗留的 pending/unknown 意图，
    // 运行中有界重试；不调用模型、不碰消息归档消费者。
    this.contentOps?.start();
    // 自动浮现：恢复收口中断态（有界；无后台补扫历史）+ 唤醒 pending
    await this.surfacing?.start();
    this.logger.info('host_started', { bind: this.opts.bind, port: this.port, runner: this.runnerSelection.status, redispatched: sched.redispatched });
  }

  /** R8′（2026-10-23）：后台补索引一跳——单飞+独立中止（逻辑在 media/index/backfill.ts） */
  private async mediaBackfillTick(): Promise<void> {
    if (this.mediaBackfillTicking) return;
    const mediaIndex = this.mediaIndexRef;
    if (!mediaIndex) return;
    this.mediaBackfillTicking = true;
    this.mediaBackfillAbort = new AbortController();
    try { await runMediaBackfillTick(mediaIndex, this.mediaBackfillAbort.signal); }
    finally { this.mediaBackfillTicking = false; this.mediaBackfillAbort = null; }
  }

  /** 相册重构 P2：M 落正待同步一跳（≤5 资产/跳；进程内指数退避 30s·2^min(n,5)，
   *  与 media/index/backfill.ts 同款——重启后退避归零重试一轮，如实记录） */
  private async mediaMSyncTick(): Promise<void> {
    if (this.mediaSyncTicking) return;
    const media = this.mediaServiceRef;
    if (!media || !this.mediaSyncStore) return;
    this.mediaSyncTicking = true;
    try {
      const now = Date.now();
      for (const item of media.pendingMSyncBatch(5)) {
        if ((this.mediaMSyncRetryNotBefore.get(item.id) ?? 0) > now) continue; // 退避期：跳过不占批次
        const before = item.m_sync_attempts;
        const synced = await media.attemptMSync(item.id);
        if (synced) this.mediaMSyncRetryNotBefore.delete(item.id);
        else this.mediaMSyncRetryNotBefore.set(item.id, Date.now() + 30_000 * 2 ** Math.min(before + 1, 5));
      }
    } finally { this.mediaSyncTicking = false; }
  }

  private reconcileCalls(): void {
    if (!this.sirenCallRef || this.callReconcileWork || this.callReconcileAbort.signal.aborted) return;
    const sirenRef = this.sirenCallRef;
    this.callReconcileWork = import('./integrations/siren/reconcile.ts')
      .then(({ reconcileVoiceCallsOnStartup }) => reconcileVoiceCallsOnStartup(this.db, sirenRef, this.callReconcileAbort.signal))
      .then(result => {
        if (result.ended || result.skipped) this.logger.warn('voice_calls_reconciled', { ...result });
      })
      // A08（联合审计 2026-10-27）：自然未接的一次可选留言机会——同一对账周期消费，
      // 幂等身份收敛重复事件/重启；串行入口（submitProgramFactTurn）提交，不等待后继轮
      .then(() => import('./integrations/siren/missed-calls.ts'))
      .then(({ consumeMissedCallOpportunities }) => consumeMissedCallOpportunities(this.db, sirenRef,
        (kind, factText, dedupeKey) => { this.supervisor.submitProgramFactTurn('primary', kind, factText, dedupeKey); },
        this.callReconcileAbort.signal))
      .then(r => { if (r.submitted > 0 || r.skipped_superseded > 0) this.logger.info('missed_call_opportunities', { ...r }); })
      .catch(error => this.logger.warn('voice_calls_reconcile_failed', { code: stableErrorCode(error) }))
      .finally(() => { this.callReconcileWork = null; });
  }

  async stop(): Promise<void> {
    // 先停止接纳，已有请求的 close 会取消其准备/模型工作，再关闭各自拥有的资源。
    const serverStopped = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
      this.server.close(() => { clearTimeout(timer); resolve(); });
      this.server.closeAllConnections?.();
    });
    if (this.mediaBackfillTimer) { clearInterval(this.mediaBackfillTimer); this.mediaBackfillTimer = null; }
    if (this.mediaSyncTimer) { clearInterval(this.mediaSyncTimer); this.mediaSyncTimer = null; }
    this.mediaBackfillAbort?.abort(); // R8′：停后台补索引（在途 encode 由 worker 60s 边界自终）
    const oidoStopped = this.oidoLifecycle?.stop(); // R6′：停删除传播重试（模块生命周期）
    if (this.callReconcileTimer) { clearInterval(this.callReconcileTimer); this.callReconcileTimer = null; }
    this.callReconcileAbort.abort();
    const observationsStopped = this.voiceObservations?.stop();
    const linksStopped = this.callReplyLinks?.stop();
    const contentOpsStopped = this.contentOps?.stop(); // P1：停内容写恢复（在途轮收口，不再派新）
    this.scheduler?.stop(); // §04.9.2：先停领取与可取消任务，再收口模型执行
    await this.surfacing?.stop(); // 自动浮现：停 worker（在途 M 请求不中断，只不再派新）
    await this.supervisor.stopAll(8000); // AUD-10：有界停止所有活动代
    await this.supervisor.waitIdle();
    await Promise.all([serverStopped, oidoStopped, observationsStopped, linksStopped, contentOpsStopped, this.callReconcileWork, this.archiveSync.stop()]);
    this.db.close();
    this.logger.close();
  }
}
