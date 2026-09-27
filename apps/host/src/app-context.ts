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
  readonly server: http.Server;
  port = 0;

  private constructor(
    config: Config,
    opts: HostOptions,
    server: http.Server,
    deps: Omit<RequestDeps, 'config'>,
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
    const routing = new RoutingService(db, events);
    const windows = new WindowManager(db, events, identity, paths.handoffsDir);
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
    });
    const auth = new AuthService(paths);
    messages.ensureConversation(PRIMARY_CONVERSATION, '私聊');

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
    };
    const server = http.createServer((req, res) => {
      handleRequest(req, res, { ...deps, config: opts.config }).catch((err) => {
        logger.error('request_unhandled', { error: (err as Error).message, url: req.url ?? null });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { code: 'internal', message: '内部错误（详情见日志，不含敏感内容）' } }));
        } else {
          res.end();
        }
      });
    });

    const host = new Host(opts.config, opts, server, deps);
    return host;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.opts.port, this.opts.bind, () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr !== null ? addr.port : this.opts.port;
    this.logger.info('host_started', { bind: this.opts.bind, port: this.port, runner: this.runnerSelection.status });
  }

  async stop(): Promise<void> {
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
