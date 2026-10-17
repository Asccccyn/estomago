// 进程入口 v0.2.2：--config 真正生效（AUD-26）、实例锁（AUD-32）、
// 启动 recovery pass（AUD-10）、pidfile 在完全停止后才清理（AUD-10）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStateRoot, buildPaths, defaultLogRoot } from './config/paths.ts';
import { loadConfig } from './config/load.ts';
import { Host } from './app-context.ts';
import { acquireInstanceLock } from './runtime/instance-lock.ts';

async function main(): Promise<void> {
  const stateRoot = resolveStateRoot(process.env.ESTOMAGO_HOME);
  const paths = buildPaths(stateRoot);
  const lock = acquireInstanceLock(stateRoot); // 同根第二实例在此失败
  const { config, sourcePath } = loadConfig({ argv: process.argv.slice(2), paths });
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 && process.argv[portArg + 1] ? Number(process.argv[portArg + 1]) : process.env.ESTOMAGO_PORT ? Number(process.env.ESTOMAGO_PORT) : config.deployment.port;
  const bind = config.deployment.bind;

  const host = await Host.create({ stateRoot, config, logDir: defaultLogRoot(process.env.ESTOMAGO_HOME), bind, port });
  await host.start();

  const pidFile = path.join(paths.runDir, 'host.pid');
  fs.writeFileSync(pidFile, String(process.pid));
  const shutdown = (signal: string): void => {
    // AUD-10：先完全停止（含 stopAll deadline），成功后才清 pidfile 与锁
    void host
      .stop()
      .catch(() => undefined)
      .finally(() => {
        try { fs.rmSync(pidFile, { force: true }); } catch { /* 尽力 */ }
        lock.release();
        process.exit(0);
      });
    setTimeout(() => process.exit(1), 15000).unref(); // 停止超时兜底
    void signal;
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log(`[estomago] listening http://${bind}:${host.port}`);
  console.log(`[estomago] config: ${sourcePath}`);
  console.log(`[estomago] state: ${stateRoot}`);
  // WP-03（2026-10-09，JFA-B08）：配置含退役键时启动即披露（example.yaml
  // 承诺成真——不再功能上静默接受）；键被剥离不进运行时
  if (config.retiredKeys?.length) {
    console.warn(`[estomago] retired_config_keys: ${config.retiredKeys.join(', ')}（已剥离，不进运行时；请从配置文件移除）`);
  }
  console.log(`[estomago] 认证 token 文件: ${host.auth.tokenFilePath()}（内容不出现在日志；首次登录在页面粘贴一次）`);
  // 审计 F29 同口径：横幅按当前真实驱动判别——OR/DS 不被 SDK 前提误报阻断
  const rk = host.runnerSelection.status === 'ok' ? host.runnerSelection.runner.kind : null;
  const gateDriver = rk === 'openrouter' || rk === 'deepseek' ? rk : 'claude-agent-sdk';
  const gate = host.identity.evaluateGate(host.db, { driver: gateDriver });
  if (gate.state !== 'READY') {
    console.log(`[estomago] IDENTITY_BLOCKED（模型通道暂停；消息仍保存、时间线仍可看）：`);
    for (const r of gate.reasons.slice(0, 8)) console.log(`  - ${r}`);
  }
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isEntry) {
  main().catch((err) => {
    console.error(`[estomago] 启动失败：${String((err as Error)?.message ?? err).slice(0, 200)}`);
    process.exit(1);
  });
}
