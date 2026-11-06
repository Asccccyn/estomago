// C03（四仓合并审计 20261106）：工具已提交后续轮失败——已发协议与真实工具结果保留，
// 下一条普通输入从该前缀接续；未应答工具补显式未执行记录；不重放副作用。
// 复现口径：轮1 返回工具调用（真实执行）→ 轮2（续轮）503 → 回合失败；
// 下一条普通消息的首个请求 messages 必须含该 assistant tool_call 与真实 tool 结果。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { assembleTestTools } from '../helpers.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';

const sse = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textReply = (t: string) => sse({ choices: [{ delta: { content: t } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cost: 0.000001 } }) + DONE;
const toolReply = (id: string, name: string, args: unknown) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cost: 0.000001 } }) + DONE;

const T0 = '2026-11-06T10:00:00.000Z';

function compose(root: string, transport: OrTransport, mariposaCalls: string[]) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: 'anthropic/claude-test-1' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const trajectory = new WindowTrajectoryService(db);
  const mariposa = new MariposaClient({ transport: async (cap: string) => { mariposaCalls.push(cap); return { ok: true, result: {} }; } });
  const { tools } = assembleTestTools({ db, mariposa, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages });
  const supervisor = new TurnSupervisor({
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner: new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport) },
    reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows,
    logger: new Logger(null), tools, trajectory, now: () => Date.parse(T0),
  });
  return { db, messages, supervisor, windows, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('C03：工具轮后失败——下一普通输入接续已发协议与真实工具结果，不重放副作用', async () => {
  const mariposaCalls: string[] = [];
  const payloads: Array<{ messages: Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string; content: unknown }> }> = [];
  let req = 0;
  const transport: OrTransport = async (payload) => {
    payloads.push(structuredClone(payload) as never);
    req++;
    if (req === 1) {
      // 轮1：模型发起 plans_write（真实写工具，经 mariposa mock 落账）
      return { status: 200, headers: new Map(), body: Readable.from([toolReply('call-c03', 'memory_i_write', { action: 'create', content: '审计回归 I 条目' })]) };
    }
    if (req === 2) {
      // 轮2（工具结果续轮）：503 —— 回合失败
      return { status: 503, headers: new Map(), body: Readable.from(['retry']) };
    }
    // 回合2（下一条普通消息）：正常文本收尾
    return { status: 200, headers: new Map(), body: Readable.from([textReply('接上了')]) };
  };
  const root = tempRoot('c03-retain-');
  const ctx = compose(root, transport, mariposaCalls);
  try {
    const s1 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '帮我建个计划', clientMessageId: 'm1', occurredAt: T0 });
    ctx.supervisor.enqueue(s1.turnId);
    await ctx.supervisor.waitIdle();
    const att1 = ctx.db.prepare('SELECT state FROM attempts WHERE id=?').get(s1.attemptId) as { state: string };
    assert.equal(att1.state, 'failed', '续轮 503 → 回合失败（前置）');
      assert.ok(mariposaCalls.includes('i.item.create'), '工具真实执行过一次（前置）');
    const writesAfterTurn1 = mariposaCalls.filter((c) => c === 'i.item.create').length;
    assert.equal(writesAfterTurn1, 1, '工具恰好执行一次（前置）');

    // 下一条普通输入：其首个请求必须携带已发 assistant tool_call + 真实 tool 结果
    const s2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '继续', clientMessageId: 'm2', occurredAt: '2026-11-06T10:05:00.000Z' });
    ctx.supervisor.enqueue(s2.turnId);
    await ctx.supervisor.waitIdle();
    const att2 = ctx.db.prepare('SELECT state FROM attempts WHERE id=?').get(s2.attemptId) as { state: string };
    assert.equal(att2.state, 'completed', '回合2 正常完成');

    const next = payloads[2]!; // 回合2 的首个请求
    const assistantWithCall = next.messages.find((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
    assert.ok(assistantWithCall, 'C03：已发 assistant tool_call 保留在下一请求（旧实现消失）');
    const toolMsg = next.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call-c03');
    assert.ok(toolMsg, 'C03：真实工具结果随前缀接续（旧实现 task 回执消失）');
    assert.ok(!String(toolMsg?.content).includes('"executed":false'), '已执行工具不是未执行占位');
    assert.equal(mariposaCalls.filter((c) => c === 'i.item.create').length, 1, 'C03：不重放工具副作用');
  } finally { ctx.close(); }
});
