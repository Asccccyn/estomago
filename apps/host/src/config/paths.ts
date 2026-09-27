// 运行区路径解析（01 §2.2）。生产默认 ~/Library/Application Support/estomago；
// ESTOMAGO_HOME 覆盖用于测试/隔离（测试根必须与生产不同 —— 02 §7）。
import { homedir } from 'node:os';
import path from 'node:path';

export const APP_SLUG = 'estomago';

export type EstomagoPaths = {
  stateRoot: string;
  configDir: string;
  identityDir: string;
  dataDir: string;
  workspacesDir: string;
  sdkStateDir: string;
  mediaDir: string;
  handoffsDir: string;
  backupsDir: string;
  runDir: string; // pidfile
};

export function defaultStateRoot(): string {
  return path.join(homedir(), 'Library', 'Application Support', APP_SLUG);
}

export function resolveStateRoot(envHome?: string): string {
  return path.resolve(envHome && envHome.trim() !== '' ? envHome : defaultStateRoot());
}

export function buildPaths(stateRoot: string): EstomagoPaths {
  return {
    stateRoot,
    configDir: path.join(stateRoot, 'config'),
    identityDir: path.join(stateRoot, 'identity'),
    dataDir: path.join(stateRoot, 'data'),
    workspacesDir: path.join(stateRoot, 'workspaces'),
    sdkStateDir: path.join(stateRoot, 'sdk-state'),
    mediaDir: path.join(stateRoot, 'media'),
    handoffsDir: path.join(stateRoot, 'handoffs'),
    backupsDir: path.join(stateRoot, 'backups'),
    runDir: path.join(stateRoot, 'run'),
  };
}

export function defaultLogRoot(envHome?: string): string {
  // 测试/隔离根下日志收进 stateRoot，避免污染 ~/Library/Logs
  if (envHome && envHome.trim() !== '') return path.join(resolveStateRoot(envHome), 'logs');
  return path.join(homedir(), 'Library', 'Logs', APP_SLUG);
}

export function isProductionStateRoot(p: string): boolean {
  return path.resolve(p) === path.resolve(defaultStateRoot());
}
