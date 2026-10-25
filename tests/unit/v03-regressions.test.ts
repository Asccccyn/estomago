// §32 覆盖补充：指纹失效禁 resume、exact-limit、空思考 omitted、完整 text、effort 贯通、guard 矩阵、锁归属。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SdkEventNormalizer } from '../../apps/host/src/runtime/sdk-event-normalizer.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { buildSdkOptions } from '../../apps/host/src/runtime/build-options.ts';
import { IdentityService, contextFingerprint } from '../../apps/host/src/identity/service.ts';
import { buildConfig, THINKING_EFFORT_ENUM } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { MockRunner } from '../../apps/host/src/runtime/runner-mock.ts';
import { tempRoot, makeDb, makePaths, writeApprovedIdentity, readyRuntimePatch, seedProbes } from '../helpers.ts';

test('§7 身份变化 → 旧窗 CONTEXT_STALE 且下一轮不 resume（CONTEXT_ROTATION_REQUIRED）', async () => {
  const root = tempRoot('fp-');
  writeApprovedIdentity(root);
  const { db } = makeDb(root);
  const paths = makePaths(root);
  const config = buildConfig(readyRuntimePatch());
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new MockRunner() }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(null) });
  messages.ensureConversation('c1');
  const t1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一轮', clientMessageId: 'fp1' });
  supervisor.enqueue(t1.turnId);
  await supervisor.waitIdle();
  const win1 = windows.activeWindow('c1')!;
  assert.ok(win1.sdk_session_id, '首轮绑定 session');

  // 模拟"批准材料升级"：规则槽版本变化（F04 后伪 hash 已无法保持 READY——那是被消灭的逃逸口）。
  // 期望不锁版本（expected_*=null）→ gate 仍 READY，但指纹参与字段已变。
  // 2026-10-17 她裁定后：I 槽（i_version/i_hash）不再参与指纹（里程碑自维护演进≠人格偷换），
  // 故本测试改用规则槽触发；I 槽演进不 stale 的断言见 milestone-self-maintain.test.ts
  const mf = path.join(root, 'config/identity-manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.runtime_rules_version = 'test-rules-2';
  fs.writeFileSync(mf, JSON.stringify(m));
  const config2 = buildConfig({ ...readyRuntimePatch(), identity: { expected_identity_version: null, expected_i_version: null, expected_rules_version: null } });
  const identity2 = new IdentityService(config2, paths); // gate 必须按新期望评估（旧服务锁着 test-i-1 会先阻断）
  const supervisor2 = new TurnSupervisor({ db, config: config2, messages, events, identity: identity2, capabilities: new CapabilityMatrix(config2), runnerSelection: { status: 'ok', runner: new MockRunner() }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(null) });
  const t2 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第二轮', clientMessageId: 'fp2' });
  supervisor2.enqueue(t2.turnId);
  await supervisor2.waitIdle();
  const winAfter = windows.get(win1.id)!;
  assert.equal(winAfter.status, 'CONTEXT_STALE', '旧窗必须 CONTEXT_STALE');
  const att2 = db.prepare("SELECT state, blocked_reason FROM attempts WHERE turn_id = ?").get(t2.turnId) as { state: string; blocked_reason: string };
  assert.equal(att2.state, 'blocked');
  assert.ok(att2.blocked_reason!.startsWith('CONTEXT_ROTATION_REQUIRED'), '不得继续 resume 旧 session');
  db.close();
});

test('§13 exact-limit：恰好==MAX 后再来 1 字符必标 truncated（不得静默）', () => {
  const root = tempRoot('lim-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  seedProbes(db);
  const events = new EventService(db);
  const r = new ReasoningService(db, events);
  const LIMIT = 256 * 1024;
  r.appendDelta({ conversationId: 'c', turnId: 't', attemptId: 'a', sdkMessageId: 'm', blockIndex: 0, text: 'x'.repeat(LIMIT), generation: 1 });
  let row = db.prepare('SELECT received_text, state FROM reasoning_blocks').get() as { received_text: string; state: string };
  assert.equal(row.received_text.length, LIMIT);
  assert.equal(row.state, 'streaming', '恰好==MAX 尚未溢出');
  r.appendDelta({ conversationId: 'c', turnId: 't', attemptId: 'a', sdkMessageId: 'm', blockIndex: 0, text: 'y', generation: 1 });
  row = db.prepare('SELECT received_text, state FROM reasoning_blocks').get() as { received_text: string; state: string };
  assert.equal(row.state, 'truncated', '溢出 1 字符也必须留 truncation 证据');
  assert.equal(row.received_text.length, LIMIT, '持久文本仍守限额');
  const ev = db.prepare("SELECT payload_ref FROM runtime_stream_events WHERE kind='reasoning.status_changed' ORDER BY sequence DESC LIMIT 1").get() as { payload_ref: string };
  assert.ok(ev && (JSON.parse(ev.payload_ref) as { payload: { state?: string } }).payload.state === 'truncated', '必须发 truncation 事件');
  db.close();
});

test('§15 空思考：streaming 块 + 完整 thinking 为空 → omitted', () => {
  const root = tempRoot('om-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  seedProbes(db);
  const events = new EventService(db);
  const r = new ReasoningService(db, events);
  r.startBlock({ conversationId: 'c', turnId: 't', attemptId: 'a', sdkMessageId: 'm', blockIndex: 0, generation: 1 });
  r.reconcileCompleteMessage({ conversationId: 'c', turnId: 't', attemptId: 'a', sdkMessageId: 'm', matched: [{ block_index: 0, block_type: 'thinking', text: '', tool_id: null, tool_name: null }], unmatched: [], generation: 1 });
  const row = db.prepare('SELECT visibility, state FROM reasoning_blocks').get() as { visibility: string; state: string };
  assert.equal(row.visibility, 'omitted', '空完整块=没有可读摘要（≠没有思考）');
  assert.equal(row.state, 'complete');
  db.close();
});

test('§16 完整 text 无流式 delta：唯一候选正常进正文', () => {
  const n = new SdkEventNormalizer();
  const out = [
    ...n.normalize({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, session_id: 's', parent_tool_use_id: null }),
    ...n.normalize({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, session_id: 's', parent_tool_use_id: null }),
    ...n.normalize({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '只有完整块正文' }] }, session_id: 's', parent_tool_use_id: null }),
  ];
  const cm = out.find((e) => e.kind === 'complete_message')!;
  assert.ok(cm.kind === 'complete_message' && cm.matched.length === 1 && cm.matched[0]!.block_index === 0);
});

test('§29 effort：枚举校验 + buildOptions → runner options.effort 全贯通', async () => {
  assert.deepEqual([...THINKING_EFFORT_ENUM], ['low', 'medium', 'high', 'xhigh', 'max']);
  // 非法 effort 由 validateConfig 拒绝（下面直接断言；buildConfig 对非法补丁会 throw 是预期行为）
  const { validateConfig } = await import('../../apps/host/src/config/schema.ts');
  assert.ok(validateConfig({ runtime: { thinking: { effort: 'banana' } } }).issues.some((i) => i.path.includes('effort')));
  const base = readyRuntimePatch();
  const config = buildConfig({ identity: (base as { identity?: Record<string, unknown> }).identity, runtime: { ...(base.runtime as Record<string, unknown>), thinking: { mode: 'adaptive', display: 'summarized', effort: 'xhigh', require_capability_probe: true } } });
  const root = tempRoot('eff-');
  writeApprovedIdentity(root);
  const paths = makePaths(root);
  const identity = new IdentityService(config, paths);
  const { db } = makeDb(root);
  const gate = identity.evaluateGate(db);
  const built = buildSdkOptions({ config, gate, identityText: 'x', approvedRulesText: 'rules', cwd: paths.workspacesDir });
  assert.ok(built.status === 'ok' && (built.assembled.options as Record<string, unknown>).effort === 'xhigh'); // F07：顶层
  const captured: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const runner = new ClaudeSdkRunner((p) => {
    captured.push(p as { prompt: string; options: Record<string, unknown> });
    return (async function* () { yield { type: 'result', subtype: 'success' }; })();
  });
  await runner.run({ prompt: 'p', options: built.assembled!, resumeSessionId: null, abortController: new AbortController(), onEvent: () => {} });
  assert.equal((captured[0]!.options as Record<string, unknown>).effort, 'xhigh', 'SDK options.effort 必须收到（F07 顶层）');
  db.close();
});

test('§27 guard 矩阵：模式化凭据名全拒（矩阵样本）', async () => {
  const { guardCheck } = await import('../../scripts/test-guard.mjs') as { guardCheck: (env: Record<string, string>, home?: string) => { ok: boolean; issues: string[] } };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  const matrix = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'MY_SERVICE_API_KEY', 'DB_PASSWORD'];
  for (const key of matrix) {
    const r = guardCheck({ PATH: '/usr/bin', HOME: home, [key]: 'synthetic' });
    assert.ok(!r.ok, `${key} 必须被凭据模式拒绝`);
  }
  const safe = guardCheck({ PATH: '/usr/bin', HOME: home, ESTOMAGO_HOME: home, ESTOMAGO_TEST_MODE: '1', CI: '1', TZ: 'Asia/Shanghai' });
  assert.ok(safe.ok, `安全 allowlist 不得误报：${safe.issues.join(';')}`);
});

test('§28 锁归属：A 根 pidfile 指向别根进程 → STALE_OR_INVALID_LOCK 拒绝', () => {
  const rootA = tempRoot('lockA-');
  fs.mkdirSync(path.join(rootA, 'run'), { recursive: true });
  // 找一个存活但非 estomago 的进程（本测试进程自身）
  fs.writeFileSync(path.join(rootA, 'run/host.pid'), String(process.pid));
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../scripts/stop.mjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ESTOMAGO_HOME: rootA },
  });
  const out = r.stdout + r.stderr;
  assert.match(out, /STALE_OR_INVALID_LOCK|无可用实例/, `失效归属不得声称运行中：${out.slice(0, 120)}`);
  assert.equal(r.status, 0, '无本根实例 → 正常退出 0（不是错误，但绝不发信号）');
  assert.doesNotMatch(out, /运行中/, '不得声称本根运行中');
  void execFileSync;
});
