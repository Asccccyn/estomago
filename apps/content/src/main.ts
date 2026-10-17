// content 服务进程入口（EXEC_V1 §06 WP5 生产接线）：独立于 host、仅 loopback。
// 服务凭据在 <stateRoot>/content/service.token 自生成/复用（host 侧 contentClientFor 读取同一路径）。
import path from 'node:path';

import { ContentServer } from './service.ts';

const stateRoot = process.env.ESTOMAGO_HOME
  ?? path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'estomago');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 && process.argv[portArg + 1]
  ? Number(process.argv[portArg + 1])
  : process.env.ESTOMAGO_CONTENT_PORT ? Number(process.env.ESTOMAGO_CONTENT_PORT) : 18788;

const server = new ContentServer({ stateRoot: path.join(stateRoot, 'content'), port });

const shutdown = (): void => {
  void server.stop().catch(() => undefined).finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.start()
  .then(() => {
    console.log(`[estomago-content] listening http://127.0.0.1:${server.port}`);
    console.log(`[estomago-content] state: ${path.join(stateRoot, 'content')}`);
  })
  .catch((err) => {
    console.error(`[estomago-content] 启动失败: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    process.exit(1);
  });
