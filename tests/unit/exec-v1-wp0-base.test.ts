// ESTOMAGO_CHAT_EXEC_V1 · WP0 验收（BASE-02 / BASE-03）
// BASE-02：旧配置升级不偷偷启用收费（auto/keepwarm 关、费用上限 null、纯函数零网络）
// BASE-03：fresh install / 历史库升级 / 迁移中断后重启——正文 hash 与 revision 不变
// BASE-01 为源码合同核对（preflight+IMPLEMENTATION_MAP），证据记录在验收执行副本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate, schemaVersion, SUPPORTED_SCHEMA_VERSION } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { validateConfig } from '../../apps/host/src/config/schema.ts';
import { POLICY_CONSTANTS } from '../../apps/host/src/config/policy-constants.ts';

test('BASE-02：旧配置升级——保留既有字段，auto/keepwarm 关闭、费用上限 null（零网络）', () => {
  // 典型 pre-EXEC_V1 配置：无 background/content/system_alerts/token_estimates/media 段
  const legacy = {
    project: { display_name: 'estómago', slug: 'estomago', spec_version: '0.2.1' },
    deployment: { port: 19999 },
    openrouter: { model: 'anthropic/claude-sonnet-4.5' },
    windows: { soft_limit_tokens: 64000 },
    reminders: { enabled: true },
  };
  const { config, issues } = validateConfig(structuredClone(legacy));
  assert.deepEqual(issues, []);
  // 既有字段保留（不重置模型/端口/窗口线）
  assert.equal(config.deployment.port, 19999);
  assert.equal(config.openrouter.model, 'anthropic/claude-sonnet-4.5');
  assert.equal(config.openrouter.cache_ttl, '1h');
  assert.equal(config.windows.soft_limit_tokens, 64000);
  // 新段默认：后台双开关关闭；费用上限 null=未配置（禁止该用途付费），不是无限、不是免费
  assert.equal(config.background.autonomous.enabled, false);
  assert.equal(config.background.keepwarm.enabled, false);
  assert.equal(config.background.autonomous.daily_cost_cap_usd, null);
  assert.equal(config.background.keepwarm.daily_cost_cap_usd, null);
  assert.equal(config.background.reminders.enabled, true); // 普通投递开关不受后台付费牵连
  assert.equal(config.content.enabled, false);
  assert.equal(config.system_alerts.usage_settlement_grace_ms, 60000);
  assert.equal(config.token_estimates.debounce_ms, 250);
  assert.equal(config.media.max_image_bytes, 20971520);
  // 升级路径零模型网络请求：validateConfig 为同步纯函数（无 fetch/计时器/IO 依赖）
  assert.equal(Object.keys(validateConfig(structuredClone(legacy)).config.background).length, 3);
});

test('BASE-02b：策略常量正本与配置硬规则（非法值拒绝，null≠0）', () => {
  // adjustable=false 常量（policy-defaults 唯一默认值表的常量面）
  // 2026-10-22（WAKE_KEEPWARM_V1 U02/U06）：keepwarm 单请求/零工具封锁与
  // autonomous 60min 冷却常量已按裁定退役——以下退役断言锁住不回流。
  assert.equal(POLICY_CONSTANTS.background.keepwarm.idle_after_cache_ms, 3_000_000); // 50min
  assert.equal(POLICY_CONSTANTS.background.keepwarm.allow_cold_start, false);
  assert.equal('max_model_requests_per_run' in POLICY_CONSTANTS.background.keepwarm, false, '心跳单请求封锁已退役');
  assert.equal('max_tool_calls_per_run' in POLICY_CONSTANTS.background.keepwarm, false, '心跳零工具封锁已退役');
  assert.equal('paid_tools_enabled' in POLICY_CONSTANTS.background.keepwarm, false, '心跳收费工具禁令已退役');
  assert.equal('autonomous' in POLICY_CONSTANTS.background, false, '60min 冷却常量已退役');
  assert.equal(POLICY_CONSTANTS.pagination.default_limit, 20);
  assert.equal(POLICY_CONSTANTS.pagination.max_limit, 100);
  assert.equal(POLICY_CONSTANTS.system_alerts.read_batch_max, 100);
  assert.equal(POLICY_CONSTANTS.content.bind_host, '127.0.0.1');
  // 硬规则：费用上限 0/负数拒绝（null 才是"未配置"，不能用 0 冒充）
  const badCap = validateConfig({ background: { autonomous: { daily_cost_cap_usd: 0 } } });
  assert.ok(badCap.issues.some((i) => i.path.startsWith('background.autonomous.daily_cost_cap_usd')));
  // 硬规则：时间初值必须 HH:MM
  const badTime = validateConfig({ background: { reminders: { default_local_time: '9:00' } } });
  assert.ok(badTime.issues.length > 0);
  // 硬规则：content 端口越界拒绝
  const badPort = validateConfig({ content: { port: 70000 } });
  assert.ok(badPort.issues.length > 0);
});

test('BASE-03：fresh / 升级 / 迁移中断后重启——正文 hash 与 revision 不变', () => {
  // (1) fresh install：全新库一次迁移到当前版本（隔离临时根，绝不指向生产）
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-v1-base03a-'));
  const dbA = openDatabase(rootA);
  const fresh = migrate(dbA, sha256Hex);
  assert.equal(schemaVersion(dbA), SUPPORTED_SCHEMA_VERSION);
  assert.equal(fresh.applied.length, SUPPORTED_SCHEMA_VERSION); // v1..v20 连续应用
  assert.ok(rootA.startsWith(os.tmpdir())); // 隔离临时根，不在生产路径
  dbA.close();

  // (2) 历史库升级：构造 v19 库（= v20 迁移中断/未提交时的真实状态），写入正文后重启补迁
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-v1-base03b-'));
  const dbB = openDatabase(rootB);
  migrate(dbB, sha256Hex, 19);
  assert.equal(schemaVersion(dbB), 19);
  const now = new Date().toISOString();
  const body = '正文内容 base03——升级前后 hash 不变';
  const bodyHash = sha256Hex(body);
  dbB.prepare(`INSERT INTO conversations(id, created_at) VALUES (?,?)`).run('conv-base03', now);
  dbB.prepare(
    `INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at)
     VALUES (?,?,?,?,?,1,?)`,
  ).run('msg-base03', 'conv-base03', 1, 'owner', 'text', now);
  dbB.prepare(
    `INSERT INTO message_revisions(id, message_id, revision, kind, content, content_hash, occurred_at, received_at, source)
     VALUES (?,?,1,'text',?,?,?,?,?)`,
  ).run('rev-base03', 'msg-base03', body, bodyHash, now, now, 'test');
  dbB.close();

  // 重启：同一文件重开，完成剩余迁移——只补缺失版本，旧数据不动
  const dbB2 = openDatabase(rootB);
  const resumed = migrate(dbB2, sha256Hex);
  assert.deepEqual(resumed.applied, Array.from({ length: SUPPORTED_SCHEMA_VERSION - 19 }, (_, i) => 20 + i)); // 只补缺失（v20..当前链尾）
  assert.equal(schemaVersion(dbB2), SUPPORTED_SCHEMA_VERSION);
  const row = dbB2
    .prepare(
      `SELECT r.content, r.content_hash, r.revision, m.current_revision
       FROM messages m JOIN message_revisions r ON r.message_id = m.id WHERE m.id = ?`,
    )
    .get('msg-base03') as { content: string; content_hash: string; revision: number; current_revision: number };
  assert.equal(row.content, body);
  assert.equal(row.content_hash, bodyHash); // 正文 hash 不变
  assert.equal(row.revision, 1);
  assert.equal(row.current_revision, 1); // revision 链不变

  // (3) 再次重启幂等：已应用版本不重复执行
  const again = migrate(dbB2, sha256Hex);
  assert.deepEqual(again.applied, []);
  const count = dbB2.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
  assert.equal(count.n, SUPPORTED_SCHEMA_VERSION); // 每版本只登记一次
  dbB2.close();
});
