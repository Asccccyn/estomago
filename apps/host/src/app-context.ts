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
import { HoldCheckpointService } from './memory/hold-checkpoint.ts';
import { HostToolExecutor } from './runtime/host-tools.ts';
import { WindowTrajectoryService } from './runtime/window-trajectory.ts';

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
    const messages = new MessageService(db);
    const identity = new IdentityService(opts.config, paths);
    const capabilities = new CapabilityMatrix(opts.config);
    const runnerSelection = await selectRunner(opts.config);
    const reasoning = new ReasoningService(db, events);
    const usage = new UsageCollector(db);
    const routing = new RoutingService(db, events, messages);
    const windows = new WindowManager(db, events, identity, paths.handoffsDir, opts.config);
    const auth = new AuthService(paths);
    messages.ensureConversation(PRIMARY_CONVERSATION, '私聊');
    // 原文归档同步：archive.enabled 且 mariposa base_url 已配置才实际发送；
    // credential_ref 只是环境变量名（值由 transport 读取，不进日志）。未启用 → no-op，outbox 保持 pending（待同步）。
    const mariposaClient = new MariposaClient({
      baseUrl: opts.config.integrations.mariposa.base_url ?? undefined,
      credentialEnv: opts.config.integrations.mariposa.credential_ref,
    });
    const archiveSync = new ArchiveSyncService({ db, events, logger, client: mariposaClient, config: opts.config });
    // §3/§8.2：hold 书签、换窗评审、宿主固定工具集（memory.hold 经 Mariposa 客户端；
    // 端到端在 Mariposa 接口上线前 BLOCKED——客户端错误如实回给模型，不伪造成功）
    const reviews = new RotationReviewService(db);
    const checkpoint = new HoldCheckpointService(db);
    const tools = new HostToolExecutor({ mariposa: mariposaClient, reviews, checkpoint });
    const trajectory = new WindowTrajectoryService(db);
    const supervisor = new TurnSupervisor({
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
    });

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
    this.logger.info('host_started', { bind: this.opts.bind, port: this.port, runner: this.runnerSelection.status, redispatched: sched.redispatched });
  }

  async stop(): Promise<void> {
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
