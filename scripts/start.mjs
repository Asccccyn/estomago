#!/usr/bin/env node
// 前台启动（开发用）：验证配置存在（缺失则从 example 复制并明示"含 null，模型通道保持阻断"），
// 然后直接运行 apps/host/src/main.ts。常驻请用 deploy/macos LaunchAgent（install-launchagent.mjs）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const stateRoot = process.env.ESTOMAGO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const configDir = path.join(stateRoot, 'config');
const configFile = path.join(configDir, 'estomago.yaml');

fs.mkdirSync(configDir, { recursive: true });
if (!fs.existsSync(configFile)) {
  fs.copyFileSync(path.join(REPO, 'config', 'estomago.example.yaml'), configFile);
  console.log(`[start] 已从 example 复制首份配置：${configFile}`);
  console.log('[start] 注意：example 含大量 null（现场未核实）。按规格，模型通道会保持 IDENTITY_BLOCKED，');
  console.log('[start] 消息保存/时间线/思考通道结构可用；请先跑 npm run doctor 并按现场核实填写配置。');
}

const args = [path.join(REPO, 'apps/host/src/main.ts'), ...process.argv.slice(2)];
console.log(`[start] node ${args.join(' ')} （前台；Ctrl-C 停止；常驻用 launchagent）`);
const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code ?? 1);
});
