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
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { renderAugmentation, PRIMARY_MEMORY_NOTICE, memoryRefFor } from '../../apps/host/src/memory-surfacing/contracts.ts';
import { fixedSystemCount } from '../../apps/host/src/runtime/cache-plan.ts';
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'deepseek-chat';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((s) => s.length > 0).map((s) => enc.encode(`${s}\n\n`)));

function dsTransport(seen: Array<Record<string, unknown>>, failOnce = false): OrTransport & { fails: { left: number } } {
  const state = { left: failOnce ? 1 : 0 };
  let gen = 0;
  const t: OrTransport & { fails: { left: number } } = async (payload) => {
    if (state.left > 0) {
      state.left -= 1;
      return { status: 500, headers: new Map<string, string>(), body: frameStream('') };
    }
    seen.push(payload as Record<string, unknown>);
    gen++;
    return { status: 200, headers: new Map<string, string>(), body: frameStream(textBody(`gen-wp7-${gen}`, '好的')) };
  };
  t.fails = state;
  return t;
}

const T0 = '2026-10-01T08:00:00+08:00';
const T1 = '2026-10-01T09:00:00+08:00';

function compose(root: string, transport: OrTransport, mariposa: MariposaTransport | null = null, configOver: Record<string, unknown> = {}) {
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' },
    deepseek: { model: MODEL },
    reminders: { enabled: false },
    ...configOver,
  });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const selections = new ManualSelectionService(db);
  const trajectory = new WindowTrajectoryService(db);
  // WP-07：WindowManager 接线 trajectory（初始轨迹写切换事务）
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config, selections, trajectory);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const mc = mariposa ? new MariposaClient({ transport: mariposa }) : null;
  const tools = new HostToolExecutor({ db, mariposa: mc ?? new MariposaClient({ transport: async () => ({ ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 }) }), reviews, checkpoint });
  const runner = config.runtime.provider === 'openrouter' ? new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport) : new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory, selections });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, selections, trajectory };
}

async function say(ctx: ReturnType<typeof compose>, content: string, clientMsgId: string, occurredAt: string) {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: clientMsgId, occurredAt });
  ctx.supervisor.enqueue(sub.turnId);
  await ctx.supervisor.waitIdle();
  return sub;
}

function payloadTexts(payload: Record<string, unknown>): string {
  return JSON.stringify((payload as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? []);
}



test('synthetic baseline manual rotation request count', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async payload => {
    seen.push(structuredClone(payload));
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    const tail = JSON.stringify([...messages].reverse().find(m => m.role === 'user')?.content);
    const reviewId = tail.match(/review_id: ([^\\\s"]+)/)?.[1];
    let body = textBody('g', 'reply');
    if (reviewId && messages.at(-1)?.role !== 'tool') body = sse({ id: 'g', choices: [{ delta: { tool_calls: [{ index: 0, id: 'complete', type: 'function', function: { name: 'context_review_complete', arguments: JSON.stringify({ review_id: reviewId, decision: 'no_new_hold' }) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
    return { status: 200, headers: new Map(), body: frameStream(body) };
  };
  const ctx = compose(tempRoot('root-baseline-'), transport, null, { reminders: { enabled: true } });
  await say(ctx, 'first synthetic', 'a', T0);
  const old = ctx.windows.activeWindow('c1')!;
  const n = seen.length;
  const confirmed = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: old.id, items: [], explicitEmpty: true, idempotencyKey: 'baseline' });
  assert.ok(confirmed.ok);
  const result = await ctx.supervisor.manualRotate('c1');
  assert.ok(result.ok, JSON.stringify(result));
  console.log(JSON.stringify({ synthetic_manual_extra_requests: seen.length - n, rotation_ok: result.ok }));
  assert.equal(seen.length - n, 1);
  ctx.db.close();
});
