// 进程入口：解析路径与配置 → 建 Host → 起 HTTP/SSE → 信号优雅退出。
// 不做的事：不复制凭据、不改旧项目、不加载未批准身份（身份 gate 会如实 BLOCKED）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStateRoot, buildPaths, defaultLogRoot } from './config/paths.ts';
import { loadConfig } from './config/load.ts';
import { Host } from './app-context.ts';

async function main(): Promise<void> {
  const stateRoot = resolveStateRoot(process.env.ESTOMAGO_HOME);
  const paths = buildPaths(stateRoot);
  const { config, sourcePath } = loadConfig({ paths });
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 && process.argv[portArg + 1] ? Number(process.argv[portArg + 1]) : process.env.ESTOMAGO_PORT ? Number(process.env.ESTOMAGO_PORT) : config.deployment.port;
  const bind = config.deployment.bind;

  const host = await Host.create({
    stateRoot,
    config,
    logDir: defaultLogRoot(process.env.ESTOMAGO_HOME),
    bind,
    port,
  });
  await host.start();

  const pidFile = path.join(paths.runDir, 'host.pid');
  fs.writeFileSync(pidFile, String(process.pid));
  const cleanup = (): void => {
    try {
      fs.rmSync(pidFile, { force: true });
    } catch { /* 尽力 */ }
  };
  process.on('SIGTERM', () => {
    cleanup();
    void host.stop().then(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    cleanup();
    void host.stop().then(() => process.exit(0));
  });

  console.log(`[estomago] listening http://${bind}:${host.port}`);
  console.log(`[estomago] config: ${sourcePath}`);
  console.log(`[estomago] state: ${stateRoot}`);
  console.log(`[estomago] 认证 token 文件: ${host.auth.tokenFilePath()}（内容不出现在日志；首次登录在页面粘贴一次）`);
  const gate = host.identity.evaluateGate();
  if (gate.state !== 'READY') {
    console.log(`[estomago] IDENTITY_BLOCKED（模型通道暂停；消息仍保存、时间线仍可看）：`);
    for (const r of gate.reasons) console.log(`  - ${r}`);
  }
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isEntry) {
  main().catch((err) => {
    console.error(`[estomago] 启动失败：${(err as Error).message}`);
    process.exit(1);
  });
}
