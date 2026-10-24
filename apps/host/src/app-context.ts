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
import { selectRunner, type RunnerSelection } from './runtime/runner.ts';
import { ReasoningService } from './reasoning/service.ts';
import { UsageCollector } from './usage/collector.ts';
import { RoutingService } from './routing/service.ts';
import { WindowManager } from './windows/manager.ts';
import { TurnSupervisor } from './runtime/supervisor.ts';
import { AuthService } from './auth/tokens.ts';
import { handleRequest, type RequestDeps } from './server/http.ts';
import { MariposaClient } from './integrations/mariposa/client.ts';
import { ArchiveSyncService } from './integrations/mariposa/archive-sync.ts';
import { RotationReviewService } from './context/rotation-review.ts';
import { ManualSelectionService } from './context/manual-selection.ts';
import { HoldCheckpointService } from './memory/hold-checkpoint.ts';
import { HostToolExecutor } from './runtime/host-tools.ts';
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
import { SurfacingService } from './memory-surfacing/service.ts';

export type HostOptions = {
  stateRoot: string;
  config: Config;
  logDir: string | null;
  bind: string;
  port: number; // 0 = 随机端口（测试）
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
  private oidoRef: import('./integrations/oido/adapter.ts').OidoAdapter | null = null;
  /** P03.8：oído 接入模块生命周期（删除传播重试 timer 的 start/stop 包装；行为逐字保持） */
  private oidoLifecycle: import('./modules/oido/lifecycle.ts').OidoModuleLifecycle | null = null;
  readonly surfacing: SurfacingService | null; // 自动浮现（默认 disabled；未启用=零作业零网络）
  readonly archiveSync: ArchiveSyncService;
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
    this.oidoRef = deps.oido ?? null;
    this.oidoLifecycle = createOidoDeleteRetryLifecycle(deps.db, () => this.oidoRef);
    this.surfacing = deps.surfacing ?? null;
    this.archiveSync = archiveSync;
    this.server = server;
  }

  static async create(opts: HostOptions): Promise<Host> {
    const paths = buildPaths(opts.stateRoot);
    for (const dir of [paths.stateRoot, paths.configDir, paths.identityDir, paths.dataDir, paths.workspacesDir, paths.sdkStateDir, paths.mediaDir, paths.handoffsDir, paths.backupsDir, paths.runDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const logger = new Logger(opts.logDir);
    const db = openDatabase(paths.dataDir);
    const applied = migrate(db, sha256Hex);
    if (applied.applied.length > 0) logger.info('db_migrated', { versions: applied.applied.join(','), schema_version: schemaVersion(db) });

    const events = new EventService(db);
    // 自动浮现（EST_MARIPOSA_AUTO_SURFACING_V1）：专用受限 service binding
    // （surfacing_credential_ref，不回退聊天/归档凭据；docs/06）；enabled=false
    // 时服务仍装配（表结构就绪）但零作业/零网络/零凭据读取。
    const surfaceCfg = opts.config.memory_surfacing;
    if (surfaceCfg.enabled && !supportsSurfacingTransport(opts.config.runtime.provider)) {
      logger.warn('surface_transport_unsupported', { provider: opts.config.runtime.provider, code: 'SURFACE_PROFILE_UNSUPPORTED' });
    }
    const surfaceMariposaClient = new MariposaClient({
      baseUrl: opts.config.integrations.mariposa.base_url ?? undefined,
      credentialEnv: surfaceCfg.surfacing_credential_ref,
    });
    const surfacing = new SurfacingService(
      db,
      surfaceMariposaClient,
      {
        enabled: surfaceCfg.enabled && supportsSurfacingTransport(opts.config.runtime.provider),
        transport_overhead_text: SURFACE_HOST_NOTICE,
        policy_revision: 1,
        prompt_prepare_revision: 'surface_prepare_v1',
        delivery_deadline_ms: surfaceCfg.delivery_deadline_ms,
        max_added_tokens_per_turn: surfaceCfg.max_added_tokens_per_turn,
        max_packet_bytes: surfaceCfg.max_packet_bytes,
        worker_concurrency: surfaceCfg.worker_concurrency,
      },
      logger,
      events,
    );
    // WAKE_KEEPWARM_V1 §05：真实活动锚点投影（L/维护回执 CAS）——消息服务与
    // supervisor/调度器共用同一实例；未迁移旧库行=如实空（unknown），不猜。
    const activity = new ConversationActivityService(db);
    const messages = new MessageService(db,
      // P05.3：生命周期消费者装配（浮现登记/编辑撤销 + 活动锚点保持原端口）
      (await import('./application/message-lifecycle.ts')).bindMessageLifecycle({ surfacing: surfacing.enabled ? surfacing : null, activity }),
      activity);
    // EXEC_V1 WP1：系统异常红点（一套表+现有 SSE；未装配任何后台，纯观测面）
    const alerts = new SystemAlertService(db, events);
    const identity = new IdentityService(opts.config, paths);
    const capabilities = new CapabilityMatrix(opts.config);
    const runnerSelection = await selectRunner(opts.config);
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
    const settings = new RuntimeSettingsService(db);
    // WP-07（CX-09）：初始轨迹写入切换事务所需（先于 WindowManager 构造）
    const trajectory = new WindowTrajectoryService(db);
    const windows = new WindowManager(db, events, identity, paths.handoffsDir, () => {
      const effModel = settings.effectiveOrModel(opts.config.openrouter.model);
      return effModel === opts.config.openrouter.model ? opts.config : { ...opts.config, openrouter: { ...opts.config.openrouter, model: effModel } };
    }, selections, trajectory);
    const auth = new AuthService(paths);
    // EXEC_V1 WP3：媒体服务（同进程；文件进 paths.mediaDir——不另起服务）
    const media = new MediaService(db, paths.mediaDir, opts.config);
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
    const archiveCredRef = opts.config.integrations.mariposa.archive_credential_ref
      ?? (process.env.ESTOMAGO_TEST_MODE === '1' ? opts.config.integrations.mariposa.credential_ref : null);
    const archiveMariposaClient = new MariposaClient({
      baseUrl: opts.config.integrations.mariposa.base_url ?? undefined,
      credentialEnv: archiveCredRef,
    });
    const archiveSync = new ArchiveSyncService({ db, events, logger, client: archiveMariposaClient, config: opts.config, alerts });
    // §3/§8.2：hold 书签、换窗评审、宿主固定工具集（memory.hold 经主模型凭据的客户端；
    // 端到端在 Mariposa 接口上线前 BLOCKED——客户端错误如实回给模型，不伪造成功）
    const reviews = new RotationReviewService(db);
    const checkpoint = new HoldCheckpointService(db);
    // 工具执行器需要 db（引用逐字核对/来源收据查询）与 archiveSync（被引消息缺收据时先补一发同步）
    // EXEC_V1 WP5：content 薄代理（content.enabled=true 且凭据文件存在才装配）
    const contentClient = contentClientFor(paths.stateRoot, opts.config.content.port, opts.config.content.enabled);
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
    const oido = opts.config.integrations.oido.base_url
      ? new (await import('./integrations/oido/adapter.ts')).OidoAdapter(opts.config.integrations.oido)
      : null;
    // JOINT-VOICE-20261022（07）：媒体语义索引（worker 未配置=null，检索能力如实不可用）
    const mediaIndex = opts.config.media_embedding.base_url
      ? new (await import('./media/index/service.ts')).MediaIndexService(db, media, new (await import('./media/index/service.ts')).MediaEmbedWorkerClient(opts.config.media_embedding))
      : null;
    // 协议①②（2026-10-24）：Siren 通话面适配器（邀请/接听/拒接/原声取回；loopback 内部凭据）
    const sirenCallCfg = opts.config.integrations.siren;
    const sirenCall = sirenCallCfg.base_url && sirenCallCfg.credential_ref && process.env[sirenCallCfg.credential_ref]
      ? new (await import('./integrations/siren/adapter.ts')).SirenAdapter(sirenCallCfg.base_url, process.env[sirenCallCfg.credential_ref]!)
      : null;
    // P02.6：显式能力注册表装配（非自动发现）。本批只登记 oído 已迁能力（oido_get）；
    // 未迁工具继续走 HostToolExecutor 旧路径（集合不相交），旧路径不作为新路径回退。
    const capabilityRegistry = new (await import('./capabilities/registry.ts')).CapabilityRegistry();
    // P04.2-4：memory 域（14 工具；同一服务实例供换窗评审恢复窄委托）
    const memoryService = (await import('./modules/memory/module.ts')).registerMemoryCapabilities(capabilityRegistry, {
      db, tz: opts.config.time.business_timezone, mariposa: modelMariposaClient, surfaceDetailClient: surfaceMariposaClient, reviews, checkpoint, archiveSync,
    });
    (await import('./modules/oido/module.ts')).registerOidoCapabilities(capabilityRegistry, {
      db, oido, sources: new (await import('./modules/oido/source-repository.ts')).OidoSourceRepository(db), audio: media, artifacts: media,
    });
    const tools = new HostToolExecutor({ db, tz: opts.config.time.business_timezone, mariposa: modelMariposaClient, surfaceDetailClient: surfaceMariposaClient, reviews, checkpoint, archiveSync, media, messages, contentClient, identity, events, wishstar, taskService, oido, mediaIndex, sirenCall });
    tools.setCapabilityRegistry(capabilityRegistry);
    tools.setMemoryRecovery(memoryService);
    // P04.6-10：剩余域全部登记（wishstar/content/wake/media/identity/context-review）
    (await import('./modules/wishstar/module.ts')).registerWishstarCapabilities(capabilityRegistry, { wishstar });
    (await import('./modules/content/module.ts')).registerContentCapabilities(capabilityRegistry, { contentClient, media });
    (await import('./modules/wake/module.ts')).registerWakeCapabilities(capabilityRegistry, { db, taskService });
    (await import('./modules/media/module.ts')).registerMediaCapabilities(capabilityRegistry, { media, mediaIndex });
    (await import('./modules/identity/module.ts')).registerIdentityCapabilities(capabilityRegistry, { db, identity });
    (await import('./modules/context-review/module.ts')).registerContextReviewCapabilities(capabilityRegistry, { db, reviews, checkpoint });
    tools.setMemoryRecovery(memoryService);
    const supervisor = new TurnSupervisor({
      wishstar,
      // JOINT-VOICE：听觉可用=配置声明（adapter 凭据就绪），不在发送关键路径探测
      oidoHearing: oido?.configured === true,
      db,
      config: opts.config,
      messages,
      events,
      identity,
      capabilities,
      runnerSelection,
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
      settings,
      alerts,
      media,
      activity,
      keepwarmYieldCheck: (runId) => schedulerRef?.isYieldRequested(runId) ?? false,
      surfacing: surfacing.enabled ? surfacing : undefined,
      bootstrap: modelMariposaClient,
    });
    // P03.5/P03.6：voice 域能力（transcript_read/call_control）在 supervisor 就绪后登记——
    // ProgramFactsPort=supervisor 的窄结构面（只提交事实请求，不暴露整个 Supervisor、不等待后继轮）
    (await import('./modules/voice/module.ts')).registerVoiceCapabilities(capabilityRegistry, {
      db, sirenCall, programFacts: supervisor,
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
      executor: {
        async executeRun(input: Parameters<import('./runtime/background-scheduler.ts').BackgroundExecutor['executeRun']>[0]): Promise<{ outcome: 'completed' | 'noop' | 'failed' | 'unknown'; result_code?: string }> {
          if (input.kind === 'reminder') {
            // §04.13：预写提醒按时投递——零模型调用；system 消息走既有事实链+归档 outbox
            const text = typeof (input.payload as { text?: unknown }).text === 'string' ? String((input.payload as { text?: unknown }).text) : '[提醒]';
            const msg = await supervisor.enqueueBackground(input.conversationId, () => Promise.resolve(messages.publishSystemNotice({ conversationId: input.conversationId, content: `[定时提醒] ${text}`, clientMessageId: `reminder:${input.taskId}:${input.runId}` })));
            events.publish('message.persisted', { conversationId: input.conversationId, entityRef: msg.id, entityRevision: msg.sequence, scope: 'private', payload: { message: msg } });
            return { outcome: 'completed', result_code: 'delivered' };
          }
          return supervisor.enqueueBackground(input.conversationId, () => {
            // Recheck after acquiring the conversation's execution slot.
            // Price validation and reservation occur once at every actual dispatch.
            const kind = input.kind as 'autonomous' | 'keepwarm';
            const es = bgSettings.effective();
            if (!es[kind].enabled) return Promise.resolve({ outcome: 'noop' as const, result_code: kind === 'keepwarm' ? 'KEEPWARM_DISABLED' : 'AUTONOMOUS_DISABLED' });
            if (es[kind].daily_cost_cap_usd === null) return Promise.resolve({ outcome: 'failed' as const, result_code: 'BACKGROUND_BUDGET_NOT_CONFIGURED' });
            return supervisor.runBackgroundTurn({
              kind, runId: input.runId, conversationId: input.conversationId, payload: input.payload,
              isCancelRequested: input.isCancelRequested, registerAbort: input.registerAbort,
              recordDispatch: (info) => scheduler.recordDispatchStart({ runId: input.runId, ...info, capabilityName: info.capabilityName ?? null }),
              maxModelRequests: es.autonomous.max_model_requests_per_run,
            });
          });
        },
      },
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
      runnerSelection,
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
      oido: oido ?? undefined,
      sirenCall: sirenCall ?? undefined,
      tools,
      bgExecutorReady,
      taskService,
      activity,
      contentClient,
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
    const recovered = TurnSupervisor.recoveryPass(this.db, this.logger);
    // §9/§10：正式启动路径——恢复后重派 committed-but-not-dispatched（数据库是真源）
    const sched = TurnSupervisor.recoverSchedule({ db: this.db, config: this.config, messages: this.messages, events: this.events, identity: this.identity, capabilities: this.capabilities, runnerSelection: this.runnerSelection, reasoning: this.reasoning, usage: this.usage, routing: this.routing, windows: this.windows, supervisor: this.supervisor, logger: this.logger });
    void recovered; // 清残计数经 recovery_pass warn 日志留痕（RECOVERY_HOST_RESTART）
    // 启动恢复同步：崩溃遗留的 pending/unknown_outcome 按稳定 op 重放（未启用时 no-op）
    void this.archiveSync.drainOnce().catch((err) => {
      this.logger.warn('archive_sync_startup_failed', { code: stableErrorCode(err) });
    });
    // EXEC_V1 §04.9.2：调度器随宿主恢复一次（孤儿处置在 start() 内）——单一唤醒源
    this.scheduler?.start();
    // R8′（2026-10-23）：媒体索引后台补全——独立任务边界（不经调度器/会话串行链：
    // scheduler 的模型执行经 enqueueBackground 进 runSerialized，搬进去只是换入口排队）。
    // 有界批次（≤5 图/tick）+ 单飞门 + 每批独立 AbortController；worker 60s 请求边界不变。
    this.mediaBackfillTimer = setInterval(() => { void this.mediaBackfillTick(); }, 15_000);
    this.mediaBackfillTimer.unref?.();
    // R6′（P03.8 起经模块生命周期）：oído 删除传播重试——独立定时器行为不变
    this.oidoLifecycle?.start();
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

  async stop(): Promise<void> {
    if (this.mediaBackfillTimer) { clearInterval(this.mediaBackfillTimer); this.mediaBackfillTimer = null; }
    this.mediaBackfillAbort?.abort(); // R8′：停后台补索引（在途 encode 由 worker 60s 边界自终）
    this.oidoLifecycle?.stop(); // R6′：停删除传播重试（模块生命周期）
    this.scheduler?.stop(); // §04.9.2：先停领取与可取消任务，再收口模型执行
    await this.surfacing?.stop(); // 自动浮现：停 worker（在途 M 请求不中断，只不再派新）
    await this.supervisor.stopAll(8000); // AUD-10：有界停止所有活动代
    await this.supervisor.waitIdle();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      const timer = setTimeout(() => resolve(), 2000);
      timer.unref?.();
    });
    this.db.close();
    this.logger.close();
  }
}
