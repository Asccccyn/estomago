#!/usr/bin/env node
// 测试保险丝 v0.2.2（AUD-31 修复）：guardCheck 可被 run-tests/npm test 直接调用；
// CLI 独立运行时同样执行。凭据环境变量、生产 state root、生产配置出现即拒绝。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function guardCheck(env = process.env, home = os.homedir()) {
  const prodRoot = path.join(home, 'Library', 'Application Support', 'estomago');
  const issues = [];
  if (env.ESTOMAGO_HOME && path.resolve(env.ESTOMAGO_HOME) === path.resolve(prodRoot)) {
    issues.push(`ESTOMAGO_HOME 指向生产根：${prodRoot}`);
  }
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC|CLAUDE|OPENAI|GEMINI|GOOGLE)_(API_?KEY|TOKEN|AUTH|CREDENTIALS?)$/i.test(key) && String(env[key]).length > 0) {
      issues.push(`环境存在真实凭据变量 ${key}（测试不得携带生产凭据）`);
    }
    if (/^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN)$/i.test(key)) issues.push(`环境存在 ${key}（可能指向非官方网关）`);
  }
  const prodConfig = path.join(prodRoot, 'config', 'estomago.yaml');
  if (env.ESTOMAGO_HOME === undefined && fs.existsSync(prodConfig)) {
    issues.push(`生产配置已存在（${prodConfig}）：测试必须显式 ESTOMAGO_HOME 隔离`);
  }
  return { ok: issues.length === 0, issues };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`, 'file://').href || process.argv[1]?.endsWith('test-guard.mjs')) {
  const r = guardCheck();
  if (!r.ok) {
    console.error('[test-guard] 拒绝：\n  - ' + r.issues.join('\n  - '));
    process.exit(1);
  }
  console.log('[test-guard] OK：无生产根/凭据信号');
}
