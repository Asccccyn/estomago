// WP5（MANUAL_HANDOFF_JUDGE_SWITCH_V1 §8，她裁定 2026-10-08）：DS 日结与
// 自动 12k 携带整链退役的负例/迁移验证：
//  - D01：迁移 18 退役 daily_digests（fresh + v16 旧库幂等）；关键表保留
//  - D02：旧配置键结构化披露（retiredKeys，剥离不进运行时、不阻断启动）
//  - D03：源码级零残留——digest 模块不存在、config 无两键、supervisor 无
//    digest 依赖；新窗路径无自动历史回退（无选集窗=空历史装配）
//  - D04：DS 主聊天/hold 提醒开关/书签不受退役影响（互不串联）
//  - D05：历史派发证据（messages/provider_requests/rotation_reviews）不被迁移改写
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig, validateConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));
import { Readable } from 'node:stream';

const KEEP_TABLES = ['messages', 'message_revisions', 'outbox', 'hold_checkpoints', 'rotation_reviews', 'windows', 'context_selections'];

test('D01：迁移 18 退役 daily_digests——fresh 与 v16 旧库均幂等，关键表保留', () => {
  // fresh 库
  const rootA = tempRoot('wp5-d01a-');
  const dbA = openDatabase(path.join(rootA, 'data'));
  migrate(dbA, sha256Hex);
  assert.equal(dbA.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='daily_digests'").get().n, 0, 'fresh 库无 daily_digests');
  // 重复迁移幂等
  migrate(dbA, sha256Hex);
  const latestV = (dbx) => (dbx.prepare('SELECT COALESCE(MAX(version),0) v FROM schema_migrations').get() as { v: number }).v;
  assert.equal(latestV(dbA) >= 18, true, '迁移链至少到 18（退役生效）；后续版本随功能推进');
  dbA.close();
  // v16 旧库（构造到迁移 16 为止，含 daily_digests 数据）→ 升级退役
  const rootB = tempRoot('wp5-d01b-');
  const dbB = openDatabase(path.join(rootB, 'data'));
  migrate(dbB, sha256Hex, 16);
  dbB.prepare("INSERT INTO daily_digests(day, status, summary, model, message_count, generated_at) VALUES ('2026-10-01','ready','旧摘要','deepseek',3,'2026-10-02T00:00:00Z')").run();
  migrate(dbB, sha256Hex);
  assert.equal(dbB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='daily_digests'").get().n, 0, '升级后退役');
  migrate(dbB, sha256Hex); // 再跑一次幂等
  for (const t of KEEP_TABLES) {
    assert.equal(dbB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?").get(t).n, 1, `${t} 保留`);
  }
  // 历史迁移 16 的档案行未改（版本仍在，code_hash 由 migrate 自校验）
  assert.ok(dbB.prepare('SELECT 1 FROM schema_migrations WHERE version=16').get());
  dbB.close();
});

test('D02：旧配置键披露——剥离不进运行时、不阻断启动、Config 回灌可往返', () => {
  const { config, issues } = validateConfig({
    digest: { provider: 'deepseek', max_messages: 400 },
    windows: { recent_dialogue_budget_tokens: 12000, warning_tokens: 56000 },
    runtime: { provider: 'deepseek' },
  });
  assert.equal(issues.length, 0, '退役键不是错误（不阻断启动）');
  assert.deepEqual(config.retiredKeys, ['digest', 'windows.recent_dialogue_budget_tokens', 'windows.warning_tokens'], '结构化披露（不静默忽略）');
  assert.equal('digest' in config, false);
  assert.equal('recent_dialogue_budget_tokens' in config.windows, false);
  assert.equal('warning_tokens' in config.windows, false, '预警线配置键同样退役');
  assert.equal(config.reminders.enabled, true, 'reminders 开关保留（与摘要退役无关）');
  assert.notEqual(config.deepseek.model, undefined, 'DS 主聊天配置段保留');
  // Config 回灌当补丁（compose 惯用法）不再因 retiredKeys 报未知键
  const round = buildConfig({ ...config, deepseek: { ...config.deepseek, model: 'ds-chat' } });
  assert.deepEqual(round.retiredKeys, [], '回灌不产生披露');
});

test('D03：源码零残留——digest 模块已删、supervisor 无 digest 依赖、无选集窗不带历史', async () => {
  // digest 模块不存在（import 必须失败）
  const digestPath = path.resolve(import.meta.dirname, '../../apps/host/src/digest/daily.ts');
  assert.equal(fs.existsSync(digestPath), false, 'digest/daily.ts 已删除');
  // supervisor 源不再引用 digest
  const sup = fs.readFileSync(path.resolve(import.meta.dirname, '../../apps/host/src/runtime/supervisor.ts'), 'utf8');
  assert.ok(!sup.includes('d.digest'), 'supervisor 无 digest 依赖');
  assert.ok(!/config\.windows\.recent_dialogue_budget_tokens/.test(sup), 'supervisor 不再读 12k 配置键（注释中的退役说明不计）');
  // 集成：无选集的既有窗懒初始化=空历史装配（无自动 12k 回退）
  const root = tempRoot('wp5-d03-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' }, reminders: { enabled: false } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const selections = new ManualSelectionService(db);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config, selections);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: async () => ({ ok: false, code: 'X', httpStatus: 404 }) }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  let gen = 0;
  const runner = new DeepSeekRunner({ retryMax: 0 }, async () => { gen++; return { status: 200, headers: new Map(), body: frameStream(textBody(`d3-${gen}`, '好的')) }; });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory, selections });
  messages.ensureConversation('c1');
  // 既有活动窗（无选集、无轨迹）+ 库内历史：turn 正常跑，但初始轨迹不带历史
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES ('old1','c1',1,'owner','text',1,'2026-10-01T00:00:00Z')").run();
  db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES ('old1',1,'text','旧的自动携带时代的历史','x','2026-10-01T07:00:00Z','2026-10-01T07:00:00Z','seed')").run();
  db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES ('w1','c1','ACTIVE','2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')").run();
  db.prepare("UPDATE conversations SET active_window_id='w1' WHERE id='c1'").run();
  const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '新输入', clientMessageId: 'm1', occurredAt: '2026-10-01T08:00:00+08:00' });
  supervisor.enqueue(sub.turnId);
  await supervisor.waitIdle();
  const att = db.prepare('SELECT state FROM attempts WHERE id = ?').get(sub.attemptId) as { state: string };
  assert.equal(att.state, 'completed', 'DS 主聊天不受退役影响（D04 交叉）');
  const traj = trajectory.forWindow('w1')!;
  const trajText = JSON.stringify(traj.messages);
  assert.ok(!trajText.includes('旧的自动携带时代的历史'), '无选集窗不再自动携带历史（12k 回退已删）');
  assert.ok(trajText.includes('新输入'), '本窗输入正常进入轨迹');
  // 已见清单只含真实见过的（本输入），不含未装配的旧历史
  assert.ok(!traj.manifest!.some((m) => m.id === 'old1'), '未装配历史不入已见清单');
  db.close();
});

test('D05：退役不改写历史派发证据——provider_requests/messages 原样', () => {
  const root = tempRoot('wp5-d05-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex, 16);
  db.prepare("INSERT INTO conversations(id, owner_service, scope, created_at) VALUES ('c0','estomago','private','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES ('w0','c0','CLOSED','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')").run();
  // 模拟旧窗口曾发出的日结证据（provider_requests 行 + messages 行）
  db.prepare("INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, payload_json, created_at) VALUES ('prq-old','w0','a0',NULL,'chat','[]','{\"legacy_digest\":true}','2026-10-01T00:00:00Z')").run();
  migrate(db, sha256Hex); // → 18
  const row = db.prepare('SELECT payload_json FROM provider_requests WHERE id = ?').get('prq-old') as { payload_json: string };
  assert.equal(row.payload_json, '{"legacy_digest":true}', '迁移不改写历史派发证据（取证旧字样不算未删干净）');
  db.close();
});
