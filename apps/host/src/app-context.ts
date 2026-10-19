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
import { MessageService } from './messages/service.ts';
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
import { contentClientFor, contentForward } from './integrations/content/client.ts';
import { SurfacingService } from './memory-surfacing/service.ts';

export const PRIMARY_CONVERSATION = 'primary';

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
    const surfacing = new SurfacingService(
      db,
      new MariposaClient({
        baseUrl: opts.config.integrations.mariposa.base_url ?? undefined,
        credentialEnv: surfaceCfg.surfacing_credential_ref,
      }),
      {
        enabled: surfaceCfg.enabled,
        policy_revision: 1,
        prompt_prepare_revision: 'surface_prepare_v1',
        delivery_deadline_ms: surfaceCfg.delivery_deadline_ms,
        max_added_tokens_per_turn: surfaceCfg.max_added_tokens_per_turn,
        max_packet_bytes: surfaceCfg.max_packet_bytes,
        worker_concurrency: surfaceCfg.worker_concurrency,
      },
      logger,
    );
    const messages = new MessageService(db, surfacing.enabled ? surfacing : null);
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
    const tools = new HostToolExecutor({ db, tz: opts.config.time.business_timezone, mariposa: modelMariposaClient, reviews, checkpoint, archiveSync, media, messages, contentClient, identity, events, wishstar });
    const supervisor = new TurnSupervisor({
      wishstar,
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
      surfacing: surfacing.enabled ? surfacing : undefined,
    });

    // EXEC_V1 WP4：后台设置+调度器（宿主内单实例；自主/保温模型执行器=接线批，交付期 readiness=false）
    const bgSettings = new BackgroundSettingsService(db, opts.config);
    const scheduler = new BackgroundScheduler({
      db, config: opts.config, settings: bgSettings, alerts,
      // §7.1 聊天优先：有活动/待处理回合即视为忙
      chatBusy: () => (db.prepare("SELECT COUNT(*) n FROM turns WHERE state IN ('pending','running','route_pending')").get() as { n: number }).n > 0,
      executor: {
        async executeRun(input) {
          if (input.kind === 'reminder') {
            // §04.13：预写提醒按时投递——零模型调用；system 消息走既有事实链+归档 outbox
            const text = typeof (input.payload as { text?: unknown }).text === 'string' ? String((input.payload as { text?: unknown }).text) : '[提醒]';
            const msg = messages.publishSystemNotice({ conversationId: input.conversationId, content: `[定时提醒] ${text}`, clientMessageId: `reminder:${input.taskId}:${input.runId}` });
            events.publish('message.persisted', { conversationId: input.conversationId, entityRef: msg.id, entityRevision: msg.sequence, scope: 'private', payload: { message: msg } });
            return { outcome: 'completed', result_code: 'delivered' };
          }
          // EXEC_V1 §04.10.2：付费模型预占须可信上界——价格未核验（runtime_settings 可配）→
          // BUDGET_ESTIMATE_UNAVAILABLE，不开后台付费请求（unknown 不当免费）
          const es = bgSettings.effective();
          const drvCfg = opts.config.runtime.provider;
          void drvCfg;
          const modelRow = db.prepare("SELECT value FROM runtime_settings WHERE key = 'or_model_price'").get() as { value: string } | undefined;
          const price = modelRow ? JSON.parse(modelRow.value) as { input_micro_per_token?: number; output_micro_per_token?: number } : null;
          if (!price || typeof price.input_micro_per_token !== 'number' || typeof price.output_micro_per_token !== 'number') {
            return { outcome: 'failed', result_code: 'BUDGET_ESTIMATE_UNAVAILABLE', result_detail: '模型价格未核验（or_model_price 未配置）——后台付费请求不开' };
          }
          const kindCfg: { max_output_tokens_per_run: number } = input.kind === 'keepwarm' ? es.keepwarm : es.autonomous;
          const r = await supervisor.runBackgroundTurn({
            kind: input.kind as 'autonomous' | 'keepwarm',
            runId: input.runId, conversationId: input.conversationId, payload: input.payload,
            isCancelRequested: input.isCancelRequested, registerAbort: input.registerAbort,
            recordDispatch: (info) => scheduler.recordDispatchStart({ runId: input.runId, logicalActionKey: info.logicalActionKey, attemptNo: info.attemptNo, dispatchKind: info.dispatchKind, capabilityName: null, reservedCostMicroUsd: info.reservedCostMicroUsd }),
            maxModelRequests: input.kind === 'keepwarm' ? 1 : es.autonomous.max_model_requests_per_run,
            maxOutputTokens: kindCfg.max_output_tokens_per_run,
          });
          return { outcome: r.outcome, result_code: r.result_code };
        },
      },
    });
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
      bgExecutorReady,
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
    // §9/§10：正式启动路径——恢复后重派 committed-but-not-dispatched（数据库是真源）
    const sched = TurnSupervisor.recoverSchedule({ db: this.db, config: this.config, messages: this.messages, events: this.events, identity: this.identity, capabilities: this.capabilities, runnerSelection: this.runnerSelection, reasoning: this.reasoning, usage: this.usage, routing: this.routing, windows: this.windows, supervisor: this.supervisor, logger: this.logger });
    // 启动恢复同步：崩溃遗留的 pending/unknown_outcome 按稳定 op 重放（未启用时 no-op）
    void this.archiveSync.drainOnce().catch((err) => {
      this.logger.warn('archive_sync_startup_failed', { code: stableErrorCode(err) });
    });
    // EXEC_V1 §04.9.2：调度器随宿主恢复一次（孤儿处置在 start() 内）——单一唤醒源
    this.scheduler?.start();
    // 自动浮现：恢复收口中断态（有界；无后台补扫历史）+ 唤醒 pending
    await this.surfacing?.start();
    this.logger.info('host_started', { bind: this.opts.bind, port: this.port, runner: this.runnerSelection.status, redispatched: sched.redispatched });
  }

  async stop(): Promise<void> {
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
