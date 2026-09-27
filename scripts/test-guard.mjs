#!/usr/bin/env node
// 测试资源守卫（02 §7）：确认测试根与生产根不同、测试模式已开、未带生产凭据信号。
// 供 CI/开发在跑测试前单独调用；run-tests.mjs 内置同规则。
import os from 'node:os';
import path from 'node:path';

const prodRoot = path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const issues = [];
if (process.env.ESTOMAGO_HOME && path.resolve(process.env.ESTOMAGO_HOME) === path.resolve(prodRoot)) {
  issues.push(`ESTOMAGO_HOME 指向生产根：${prodRoot}`);
}
if (process.env.ESTOMAGO_TEST_MODE !== '1') {
  console.warn('[test-guard] 提示：ESTOMAGO_TEST_MODE 未开（mock runner 将不可用；单元测试不受影响）');
}
for (const key of Object.keys(process.env)) {
  if (/^(ANTHROPIC|CLAUDE|OPENAI)_(API_?KEY|TOKEN)$/i.test(key)) {
    issues.push(`环境里存在真实凭据变量 ${key}：测试不得携带生产凭据`);
  }
}
if (issues.length > 0) {
  console.error('[test-guard] 拒绝：\n  - ' + issues.join('\n  - '));
  process.exit(1);
}
console.log('[test-guard] OK：测试根与生产根隔离，无凭据泄漏信号');
