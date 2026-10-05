// WP1 回归：openrouter 配置段与换窗预算初值；旧预算字段退役；硬规则不可放宽。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, buildConfig } from '../../apps/host/src/config/schema.ts';

test('默认值：OR 段 + 换窗预算初值（implementation-target.json）+ 零点换窗退役', () => {
  const { config, issues } = validateConfig({});
  assert.equal(issues.length, 0);
  assert.equal(config.runtime.provider, 'claude-agent-sdk', '默认仍 SDK：切 OR 是显式配置动作');
  assert.equal(config.openrouter.model, null, 'model=null 即"模型未配置"，不猜默认型号');
  assert.equal(config.openrouter.api_key_env, 'OPENROUTER_API_KEY');
  assert.equal(config.openrouter.max_output_tokens, 8192);
  assert.equal(config.openrouter.cache_ttl, '1h');
  assert.deepEqual(config.openrouter.provider_only, ['anthropic']);
  // §4.1 工程初值
  assert.equal(config.windows.rotate_on_business_date_change, false, '零点不触发换窗（旧默认 true 已退役）');
  assert.equal(config.windows.soft_limit_tokens, 64000);
  assert.equal(config.windows.warning_tokens, 56000);
  assert.equal(config.windows.idle_before_next_user_ms, 21600000);
  assert.equal(config.windows.tool_input_reserve_tokens, 8000);
  assert.equal(config.windows.review_reserve_tokens, 8000);
  assert.equal(config.windows.safety_reserve_tokens, 4000);
  assert.equal(config.windows.recent_dialogue_budget_tokens, 12000);
  assert.equal(config.windows.bootstrap_target_tokens, 32000);
  assert.equal(config.windows.model_context_capacity, null, 'C 未测量不假定');
});

test('provider 枚举：未知值拒绝（不静默落 SDK）；openrouter 合法', () => {
  assert.ok(validateConfig({ runtime: { provider: 'literally-anything' } }).issues.some((i) => i.path === 'runtime.provider'));
  assert.equal(validateConfig({ runtime: { provider: 'openrouter' } }).issues.length, 0);
});

test('退役字段：旧预算键现在是未知键（不忽略）', () => {
  for (const key of ['output_reserve_tokens', 'handoff_reserve_tokens', 'max_tool_result_tokens']) {
    assert.ok(validateConfig({ windows: { [key]: 1000 } }).issues.some((i) => i.path === `windows.${key}`), key);
  }
});

test('硬规则不可放宽：TTL/fallback/压缩/零点换窗', () => {
  // 硬规则 path 提取自带尾随空格（历史行为）——断言用 trim 后比较
  const hasIssue = (raw: Record<string, unknown>, path: string) => validateConfig(raw).issues.some((i) => i.path.trim() === path);
  assert.ok(hasIssue({ openrouter: { cache_ttl: '5m' } }, 'openrouter.cache_ttl'), '1h 是产品合同');
  assert.ok(hasIssue({ openrouter: { allow_fallbacks: true } }, 'openrouter.allow_fallbacks'));
  assert.ok(hasIssue({ openrouter: { disable_context_compression: false } }, 'openrouter.disable_context_compression'));
  assert.ok(hasIssue({ windows: { rotate_on_business_date_change: true } }, 'windows.rotate_on_business_date_change'));
  assert.ok(hasIssue({ openrouter: { provider_only: [] } }, 'openrouter.provider_only'));
  assert.ok(hasIssue({ openrouter: { base_url: 'http://insecure.example' } }, 'openrouter.base_url'));
});

test('型号形状门：auto/latest/数组拒；vendor/model 形态过（Claude 专属门在 payload 层）', () => {
  assert.ok(validateConfig({ openrouter: { model: 'auto' } }).issues.some((i) => i.path === 'openrouter.model'));
  assert.ok(validateConfig({ openrouter: { model: 'anthropic/claude-opus-latest' } }).issues.some((i) => i.path === 'openrouter.model'));
  assert.ok(validateConfig({ openrouter: { model: 'a,b,c' } }).issues.some((i) => i.path === 'openrouter.model'));
  assert.equal(validateConfig({ openrouter: { model: 'anthropic/claude-test-1' } }).issues.length, 0);
  // 非 Claude 形态在配置层合法（供未来扩展），但 buildOrPayload 发送门会拒——分层不矛盾
  assert.equal(validateConfig({ openrouter: { model: 'other-vendor/some-model' } }).issues.length, 0);
});

test('buildConfig 全链：合法 OR 配置可构造；reasoning 覆盖须是对象', () => {
  const cfg = buildConfig({ runtime: { provider: 'openrouter' }, openrouter: { model: 'anthropic/claude-test-1', max_output_tokens: 4096 } });
  assert.equal(cfg.openrouter.model, 'anthropic/claude-test-1');
  assert.equal(cfg.openrouter.max_output_tokens, 4096);
  assert.throws(() => buildConfig({ openrouter: { reasoning: 'high' } }), /reasoning/);
});
