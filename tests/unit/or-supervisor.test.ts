// WP1 回归：supervisor 的 OR 分支（假 transport，零网络）——发布/记账/窗口语义与 SDK 分支一致。
// 覆盖：OR 请求信封（system=身份+批准规则+固定运行片段；user=时间上下文程序事实+正文）、
// usage 以 or_stream 口径入账、窗口不绑定 SDK session、session_id 跨轮稳定、指纹含 OR 配置。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService, contextFingerprint } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { FIXED_RUNTIME_FRAGMENT } from '../../apps/host/src/context/fixed-runtime.ts';
import { buildFullTestRegistry, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

function composeOr(root: string, transport: OrTransport) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: MODEL } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, toolCatalog: buildFullTestRegistry() });
  messages.ensureConversation('c1');
  return { db, config, paths, messages, identity, routing, windows, supervisor };
}

const okBody = (text: string) => sse({ id: `gen-${text.length}`, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 }, cost: 0.001 } }) + DONE;

test('OR 分支：完整 turn 发布、or_stream 用量入账、窗口无 SDK session、payload 含身份与固定片段', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async (payload) => {
    payloads.push(structuredClone(payload));
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(okBody('回复正文'))]) };
  };
  const root = tempRoot('orsv-');
  const ctx = composeOr(root, transport);
  const t1 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '用户的话', clientMessageId: 'or1' });
  ctx.supervisor.enqueue(t1.turnId);
  await ctx.supervisor.waitIdle();

  const msgs = ctx.messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 10 });
  assert.equal(msgs.length, 2, '用户消息 + 助手气泡');
  assert.equal(msgs[1]!.speaker, 'assistant');
  assert.equal(msgs[1]!.revision.content, '回复正文');
  const turn = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t1.turnId) as { state: string };
  assert.equal(turn.state, 'completed');

  // payload：system=身份+批准规则+固定运行片段+宿主边界；user=时间上下文程序事实+用户正文
  assert.equal(payloads.length, 1);
  const p = payloads[0]!;
  assert.equal(p.model, MODEL);
  const messages = p.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, 'system');
  const sysText = messages[0]!.content[0]!.text;
  assert.ok(sysText.includes('（测试）经批准身份正文——合成内容，非真实身份'), '批准身份正文进 system（§2.1 首条生成前装载）');
  assert.ok(sysText.includes('（测试）运行规则合成内容'));
  assert.ok(sysText.includes(FIXED_RUNTIME_FRAGMENT.slice(0, 30)), '固定运行规则片段进 system（缓存点 A 候选）');
  assert.equal(messages[1]!.role, 'user');
  const userText = messages[1]!.content[0]!.text;
  assert.ok(userText.includes('[time_context]（宿主注入的程序事实，不是用户发言）'), '程序事实标注 provenance');
  assert.ok(userText.includes('[user_input]\n用户的话'));

  // 用量：or_stream 口径入库（input_tokens=总输入；cache 列为分类，不重复加）
  const usageRow = ctx.db.prepare("SELECT input_tokens, cache_read_input_tokens, cache_creation_input_tokens, model, source FROM usage_observations WHERE attempt_id = ?").get(t1.attemptId) as { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string; source: string };
  assert.equal(usageRow.input_tokens, 12);
  assert.equal(usageRow.cache_read_input_tokens, 5);
  assert.equal(usageRow.cache_creation_input_tokens, 2);
  assert.equal(usageRow.model, MODEL, '记账用明确 OR 型号');
  assert.equal(usageRow.source, 'or_stream');

  // 窗口：OR 不绑定 SDK session
  const win = ctx.windows.activeWindow('c1')!;
  assert.equal(win.sdk_session_id, null);
  assert.ok(win.context_fingerprint, '窗口带指纹');

  // session_id 跨轮稳定（同房间同型号）
  const t2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第二轮', clientMessageId: 'or2' });
  ctx.supervisor.enqueue(t2.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal(payloads.length, 2);
  assert.equal((payloads[1]! as { session_id: string }).session_id, (payloads[0]! as { session_id: string }).session_id, '同窗同房同型号 → 同 session_id（§6.2 不每次随机）');
  ctx.db.close();
});

test('指纹：OR 型号变更 → 旧窗 CONTEXT_STALE、attempt 阻断要求受控换窗', async () => {
  const transport: OrTransport = async () => ({ status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(okBody('ok'))]) });
  const root = tempRoot('orfp-');
  const ctx = composeOr(root, transport);
  const t1 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一轮', clientMessageId: 'fp1' });
  ctx.supervisor.enqueue(t1.turnId);
  await ctx.supervisor.waitIdle();
  const win1 = ctx.windows.activeWindow('c1')!;

  // 换型号（模拟设置页变更）——同 manifest 下指纹必须不同
  const cfg2 = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: 'anthropic/claude-test-2' } });
  const manifest = (ctx.identity.evaluateGate(ctx.db) as { manifest: unknown }).manifest;
  assert.notEqual(contextFingerprint(cfg2, manifest as never), contextFingerprint(ctx.config, manifest as never), 'OR 型号参与指纹');

  // 用不同 config 的 supervisor 跑第二轮 → 指纹不匹配 → CONTEXT_ROTATION_REQUIRED
  const supervisor2 = new TurnSupervisor({ db: ctx.db, config: cfg2, messages: ctx.messages, events: new EventService(ctx.db), identity: ctx.identity, capabilities: new CapabilityMatrix(cfg2), runnerSelection: { status: 'ok', runner: new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport) }, reasoning: new ReasoningService(ctx.db, new EventService(ctx.db)), usage: new UsageCollector(ctx.db), routing: ctx.routing, windows: ctx.windows, logger: new Logger(path.join(root, 'logs')), toolCatalog: buildFullTestRegistry() });
  const t2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第二轮', clientMessageId: 'fp2' });
  supervisor2.enqueue(t2.turnId);
  await supervisor2.waitIdle();
  const att2 = ctx.db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(t2.attemptId) as { state: string; blocked_reason: string };
  assert.equal(att2.state, 'blocked');
  assert.ok(att2.blocked_reason.startsWith('CONTEXT_ROTATION_REQUIRED'), '模型变更走受控换窗，不静默换型号续跑');
  assert.equal(ctx.windows.get(win1.id)!.status, 'CONTEXT_STALE');
  ctx.db.close();
});
