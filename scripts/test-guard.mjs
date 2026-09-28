#!/usr/bin/env node
// 测试保险丝 v0.2.2（AUD-31 修复）：guardCheck 可被 run-tests/npm test 直接调用；
// CLI 独立运行时同样执行。凭据环境变量、生产 state root、生产配置出现即拒绝。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// §27：凭据名模式 + 显式安全 allowlist（不写死一批就完）
const CREDENTIAL_NAME_PATTERNS = [
  /^(ANTHROPIC|CLAUDE|OPENAI|GEMINI|GOOGLE|AWS|AZURE|GCP)(_[A-Z0-9]+)*_(API_?KEY|AUTH_?TOKEN|TOKEN|OAUTH_TOKEN|SECRET_?(ACCESS)?_?KEY?|ACCESS_?KEY_?ID|CREDENTIALS?|APPLICATION_CREDENTIALS)$/i,
  /^(AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)$/i,
  /_(API_?KEY|SECRET|PASSWORD|PRIVATE_?KEY)$/i, // 通用后缀模式
];
const TEST_SAFE_ALLOWLIST = new Set([
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV', 'NODE_OPTIONS',
  'ESTOMAGO_HOME', 'ESTOMAGO_TEST_MODE', 'ESTOMAGO_MOCK_SCENARIO', 'ESTOMAGO_PORT', 'ESTOMAGO_CONFIG', 'ESTOMAGO_SSE_DRAIN_TIMEOUT_MS',
  'CI', 'NO_COLOR', 'FORCE_COLOR', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'XPC_FLAGS', 'XPC_SERVICE_NAME',
  '__CF_USER_TEXT_ENCODING', 'SECURITYSESSIONID', 'TERM_PROGRAM', 'TERM', 'SSH_AUTH_SOCK', 'Apple_PubSub_Socket_Render',
]);

export function guardCheck(env = process.env, home = os.homedir()) {
  const prodRoot = path.join(home, 'Library', 'Application Support', 'estomago');
  const issues = [];
  if (env.ESTOMAGO_HOME && path.resolve(env.ESTOMAGO_HOME) === path.resolve(prodRoot)) {
    issues.push(`ESTOMAGO_HOME 指向生产根：${prodRoot}`);
  }
  for (const key of Object.keys(env)) {
    if (TEST_SAFE_ALLOWLIST.has(key)) continue;
    const value = String(env[key] ?? '');
    if (CREDENTIAL_NAME_PATTERNS.some((re) => re.test(key)) && value.length > 0) {
      issues.push(`环境存在凭据类变量 ${key}（名称匹配凭据模式；测试不得携带——只报告名称，不打印值）`);
    }
    if (/^(ANTHROPIC_BASE_URL)$/i.test(key)) issues.push(`环境存在 ${key}（可能指向非官方网关）`);
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
