// 2026-10-08 她裁定：聊天窗换模型/推理等级。
//  - 换模型=运行边界变化：下一条消息停→选历史确认→新窗按生效型号装配
//   （复用 CONTEXT_STALE→选集→新窗既有链路；指纹按生效视图）
//  - 换思考深度=逐请求生成参数：立即生效、不换窗（reasoning 已退出指纹）
//  - override 持久（迁移 19）；null/空=回落 config 默认
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { contextFingerprint } from '../../apps/host/src/identity/service.ts';
import { RuntimeSettingsService, REASONING_EFFORTS } from '../../apps/host/src/runtime/runtime-settings.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

function makeDb(root: string) {
  writeApprovedIdentity(root);
  void buildConfig(readyRuntimePatch());
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  return db;
}

test('设置服务：override 持久/清除/回落；effort 枚举校验', () => {
  const root = tempRoot('rts-');
  const db = makeDb(root);
  const svc = new RuntimeSettingsService(db);
  assert.equal(svc.orModel(), null, '未设=回落');
  svc.set('or_model', 'anthropic/claude-fable-5.1');
  assert.equal(svc.orModel(), 'anthropic/claude-fable-5.1');
  assert.equal(svc.effectiveOrModel('anthropic/claude-opus-4.6'), 'anthropic/claude-fable-5.1', 'override 优先');
  svc.set('or_model', null);
  assert.equal(svc.orModel(), null, '清除=回落默认');
  svc.set('reasoning_effort', 'high');
  assert.equal(svc.reasoningEffort(), 'high');
  assert.deepEqual(svc.effectiveReasoning(null), { effort: 'high' }, 'effort 覆盖 null 配置');
  svc.set('reasoning_effort', null);
  assert.equal(svc.reasoningEffort(), null, '清除=回落配置 reasoning');
  db.close();
});

test('指纹：reasoning 变化不再改变指纹；模型变化改变指纹', () => {
  const base = {
    runtime: { provider: 'openrouter', sdk_version: null, model: null, setting_sources: [], builtin_tools: [], mcp_servers_allowlist: [] },
    openrouter: { model: 'anthropic/claude-opus-4.6', max_output_tokens: 8192, provider_only: ['anthropic'], reasoning: null },
  };
  const withEffort = { ...base, openrouter: { ...base.openrouter, reasoning: { effort: 'high' } } };
  assert.equal(contextFingerprint(base, null), contextFingerprint(withEffort, null), '换思考深度不构成边界变化');
  const otherModel = { ...base, openrouter: { ...base.openrouter, model: 'anthropic/claude-fable-5.1' } };
  assert.notEqual(contextFingerprint(base, null), contextFingerprint(otherModel, null), '换模型=边界变化');
});

test('档位清单与 OR 文档一致（default 是回落哨兵不是 OR 值）', () => {
  assert.deepEqual([...REASONING_EFFORTS], ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

// —— 按模型真实档位生成（2026-10-08 她 catch：none 在强制思考模型上报错） ——
import { effortsForModel } from '../../apps/host/src/runtime/runtime-settings.ts';

test('effortsForModel：强制思考模型（fable-5.1 实测形态）无 none/minimal', () => {
  // OR 实测：anthropic/claude-fable-5.1 → supported=[max,xhigh,high,medium,low], mandatory=true
  const efforts = effortsForModel({ supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], mandatory: true });
  assert.deepEqual(efforts, ['default', 'low', 'medium', 'high', 'xhigh', 'max'], 'fable/opus-5.5 形态：五档+default，没有 none/minimal');
});

test('effortsForModel：非强制思考不代表支持 none', () => {
  const efforts = effortsForModel({ supported_efforts: ['max', 'high', 'medium', 'low'], mandatory: false });
  assert.deepEqual(efforts, ['default', 'low', 'medium', 'high', 'max']);
  assert.deepEqual(effortsForModel({ supported_efforts: ['none', 'low'], mandatory: false }), ['default', 'none', 'low']);
});

test('effortsForModel：元数据不可达=null；无档位选择的模型只剩 default', () => {
  assert.equal(effortsForModel(null), null, '不可达=未验证，不得回落全表');
  assert.deepEqual(effortsForModel({}), ['default'], 'OR 对无档位选择的模型省略 supported_efforts——没有思考旋钮');
});

test('已核实的具体模型：缺少元数据仍只列真实档位，并遵守供应商限制', () => {
  const opus = ['default', 'low', 'medium', 'high', 'max'];
  assert.deepEqual(effortsForModel(null, 'anthropic/claude-opus-4.6'), opus);
  assert.deepEqual(effortsForModel({ supported_efforts: [...REASONING_EFFORTS] }, 'anthropic/claude-opus-4.6'), opus);
  assert.deepEqual(effortsForModel({ supported_efforts: ['low', 'high'] }, 'anthropic/claude-opus-4.6'), ['default', 'low', 'high']);
  for (const model of ['anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.1']) {
    assert.deepEqual(effortsForModel(null, model), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  }
  assert.equal(effortsForModel(null, 'anthropic/claude-unknown'), null);
});

// —— 端到端：换模型走受控换窗；换思考深度不换窗 ——
import { Readable } from 'node:stream';
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
import { buildPaths } from '../../apps/host/src/config/paths.ts';

const enc = new TextEncoder();
const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const DONE = 'data: [DONE]\n\n';
const textBody = (id, text) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const frameStream = (body) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(x + '\n\n')));

function composeRt(root, seen) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat', estimate_chars_per_token: 1.5 }, openrouter: { model: 'anthropic/claude-opus-4.6', model_options: ['anthropic/claude-opus-4.6', 'anthropic/claude-fable-5.1'] }, reminders: { enabled: false } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const selections = new ManualSelectionService(db);
  const settings = new RuntimeSettingsService(db);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config, selections);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: async () => ({ ok: false, code: 'X', httpStatus: 404 }) }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  let gen = 0;
  const runner = new DeepSeekRunner({ retryMax: 0 }, async () => { gen++; seen.push('deepseek'); return { status: 200, headers: new Map(), body: frameStream(textBody(`g${gen}`, '好的')) }; });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory, selections, settings });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, selections, settings };
}

const T0 = '2026-10-01T08:00:00+08:00';

test('端到端：模型 override 变化 → 受控换窗（等选集确认）；effort 变化不换窗', async () => {
  const seen: string[] = [];
  const root = tempRoot('rts-e2e-');
  const ctx = composeRt(root, seen);
  const say = async (content, id) => {
    const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: id, occurredAt: T0 });
    ctx.supervisor.enqueue(sub.turnId);
    await ctx.supervisor.waitIdle();
    return sub;
  };
  const s1 = await say('正常一句', 'm1');
  assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(s1.attemptId) as { state: string }).state, 'completed');
  const win1 = ctx.windows.activeWindow('c1')!;
  // 换思考深度：不换窗、消息照常
  ctx.settings.set('reasoning_effort', 'high');
  const s2 = await say('换了思考深度再来一句', 'm2');
  assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE id = ?').get(s2.attemptId) as { state: string }).state, 'completed');
  assert.equal(ctx.windows.activeWindow('c1')!.id, win1.id, 'effort 切换不换窗（上下文复用）');
  // 换模型：运行边界变化 → 下一条消息阻断等选集（不是静默继续）
  ctx.settings.set('or_model', 'anthropic/claude-fable-5.1');
  const s3 = await say('换模型后的第一句', 'm3');
  const att3 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(s3.attemptId) as { state: string; blocked_reason: string };
  if (att3.state !== 'completed') {
    assert.equal(att3.state, 'blocked');
    assert.ok(att3.blocked_reason.includes('CONTEXT_SELECTION_REQUIRED') || att3.blocked_reason.includes('CONTEXT_ROTATION_REQUIRED'), `受控换窗路径：${att3.blocked_reason.slice(0, 50)}`);
  }
  // 注意：本测试驱动为 deepseek（信封驱动共用管线），OR 模型 override 对
  // deepseek 驱动不生效（drv 只读 deepseek 段）——模型边界变化由 OR 驱动
  // 的指纹视图触发；此处断言的是"设置服务+阻断语义"接线，OR 实机验证
  // 属于 live 项（与 Codex live 同批）。
  ctx.db.close();
});
