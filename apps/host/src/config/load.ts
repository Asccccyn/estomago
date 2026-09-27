// 配置加载：--config 参数 > ESTOMAGO_CONFIG 环境变量 > $STATE_ROOT/config/estomago.yaml。
// 读取失败/校验失败 → 抛错阻止启动（不静默用默认值冒充现场配置）。
import fs from 'node:fs';
import path from 'node:path';
import type { EstomagoPaths } from './paths.ts';
import { parseYaml } from './yaml.ts';
import { validateConfig, type Config } from './schema.ts';

export function candidateConfigPaths(argv: string[], env: NodeJS.ProcessEnv, paths: EstomagoPaths): string[] {
  const out: string[] = [];
  const idx = argv.indexOf('--config');
  if (idx >= 0 && argv[idx + 1]) out.push(path.resolve(argv[idx + 1]!));
  if (env.ESTOMAGO_CONFIG) out.push(path.resolve(env.ESTOMAGO_CONFIG));
  out.push(path.join(paths.configDir, 'estomago.yaml'));
  return out;
}

export function findConfigFile(argv: string[], env: NodeJS.ProcessEnv, paths: EstomagoPaths): string | null {
  for (const p of candidateConfigPaths(argv, env, paths)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(opts: { argv?: string[]; env?: NodeJS.ProcessEnv; paths: EstomagoPaths }): { config: Config; sourcePath: string } {
  const argv = opts.argv ?? [];
  const env = opts.env ?? process.env;
  const sourcePath = findConfigFile(argv, env, opts.paths);
  if (!sourcePath) {
    throw new Error(
      `未找到配置文件。候选：${candidateConfigPaths(argv, env, opts.paths).join(' ; ')}。` +
        `首次使用请复制 config/estomago.example.yaml 到 $STATE_ROOT/config/estomago.yaml 再按现场核实填写。`,
    );
  }
  const text = fs.readFileSync(sourcePath, 'utf8');
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`配置 YAML 解析失败（${sourcePath}）：${(err as Error).message}`);
  }
  const { config, issues } = validateConfig(raw);
  if (issues.length > 0) {
    const detail = issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`配置校验失败（${sourcePath}）：\n${detail}`);
  }
  return { config, sourcePath };
}
