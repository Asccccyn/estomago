import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { makeDb, makePaths, writeApprovedIdentity, readyRuntimePatch, fakeSolJudge, assembleTestTools } from '../helpers.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { bindMessageLifecycle } from '../../apps/host/src/application/message-lifecycle.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { RuntimeSettingsService } from '../../apps/host/src/runtime/runtime-settings.ts';
import { SubscriptionAccessRunner } from '../../apps/host/src/runtime/subscription-access.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import type { AgentRunner } from '../../apps/host/src/runtime/runner.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import { SURFACE_HOST_NOTICE } from '../../apps/host/src/memory-surfacing/contracts.ts';

const ITEM = {
  kind: 'event' as const, event_id: 'ev_1', memory_id: '00001', memory_version: '1',
  memory_date: '2026-07-09', date_confidence: 'exact',
  event_text: '合成记录：7月9日我们把记忆库建成了。', body_hash: 'b'.repeat(64),
  detail_ref: 'sdr_sdk1', resource_ref: 'memory:00001',
};

test('SDK uses the same first-request ledger, detail tools, frozen continuation and coverage as API turns', async () => {
  let forbiddenSdkLoads = 0; let forbiddenNetwork = 0;
  const hooks = registerHooks({ load(url, context, next) {
    if (url.includes('/node_modules/@anthropic-ai/claude-agent-sdk/')) {
      forbiddenSdkLoads++; throw Error('SDK_LOADING_FORBIDDEN');
    }
    return next(url, context);
  } });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { forbiddenNetwork++; throw Error('NETWORK_FORBIDDEN'); };
  const { db, root } = makeDb(); writeApprovedIdentity(root);
  const paths = makePaths(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime,
    provider: 'openrouter', access_policy: 'subscription-first', model: 'claude-sonnet-4-6',
    subscription_proxy_url: 'http://127.0.0.1:1082' }, openrouter: { model: 'anthropic/claude-sonnet-4.6' } });
  const events = new EventService(db); const caps: string[] = [];
  const transport: MariposaTransport = async (cap, args) => {
    caps.push(cap);
    if (cap.endsWith('.prepare')) return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_sdk' } };
    if (cap.endsWith('.validate')) return { ok: true, result: { status: 'ready', validation_receipt: 'svr_sdk', items: [ITEM] } };
    if (cap.endsWith('.check')) return { ok: true, result: { valid: true, accepted_detail_refs: [ITEM.detail_ref] } };
    if (cap === 'memory.detail.read') {
      assert.equal(args.detail_ref, ITEM.detail_ref);
      return { ok: true, result: { memory_id: ITEM.memory_id, text: ITEM.event_text, next_cursor: null } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const client = new MariposaClient({ transport });
  const firstText = '请查我们7月9日建成记忆库的经历。';
  const nextText = '再找一些其他共同建设的经历。';
  const plan = { purpose: '共同项目的真实记录', route: 'event', breadth: 'single',
    queries: [{ semantic: '记忆库建设', keywords: ['记忆库'] }], time_hint: null, speaker: null };
  const sol = fakeSolJudge([
    { decision: 'recall', plan: { ...plan, evidence: [{ user_turn: 1, quote: firstText }] } },
    { decision: 'recall', plan: { ...plan, breadth: 'related', evidence: [{ user_turn: 2, quote: nextText }] } },
    { decision: 'recall', plan: { ...plan, purpose: '想起当时共同完成的事情', evidence: [{ user_turn: 1, quote: firstText }] } },
  ]);
  const svc = new SurfacingService(db, client, sol.judge, {
    enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v2',
    delivery_deadline_ms: 4000, max_added_tokens_per_turn: 4096, max_packet_bytes: 24576,
    worker_concurrency: 1, recent_user_messages: 3, recent_window_bytes: 24576,
  }, null);
  const messages = new MessageService(db, bindMessageLifecycle({ surfacing: svc, activity: null }));
  messages.ensureConversation('c1');
  const identity = new IdentityService(config, paths); const trajectory = new WindowTrajectoryService(db);
  const reviews = new RotationReviewService(db); const checkpoint = new HoldCheckpointService(db);
  const settings = new RuntimeSettingsService(db); settings.set('access_policy', 'subscription-first');
  const { tools, registry } = assembleTestTools({ db, messages, events, mariposa: client, surfaceDetailClient: client, reviews, checkpoint });
  const captures: OrMessage[][] = []; const factories: string[] = [];
  let calls = 0; let modelDetail: unknown;
  const fakeRunner: AgentRunner = {
    kind: 'claude-agent-sdk', interruptSupport: 'unknown',
    async run(req) {
      assert.ok(req.host, 'SDK must enter its canonical host envelope, not the legacy prompt-only path');
      const host = req.host; calls++;
      let sent = structuredClone(host.envelope.messages);
      await host.beforeModel(sent, 0); host.modelStarted(`synthetic-${calls}-0`, 0, config.runtime.model!);
      captures.push(structuredClone(sent));
      if (calls === 1) {
        const block = sent.flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.map(b => b.text ?? ''))
          .find(text => text.startsWith('{"memories":'))!;
        assert.ok(block); const ref = JSON.parse(block).memories[0].memory_ref;
        const read = await host.executeTool('memory_read_full', { memory_ref: ref }, 'synthetic-read', 0);
        assert.equal(read.ok, true, 'first-request ref must be usable before retained state'); modelDetail = read.output;
        sent = [...sent, { role: 'assistant', content: '', tool_calls: [{ id: 'synthetic-read', type: 'function', function: { name: 'memory_read_full', arguments: JSON.stringify({ memory_ref: ref }) } }] },
          { role: 'tool', tool_call_id: 'synthetic-read', content: JSON.stringify(read.output) }];
        await host.beforeModel(sent, 1); host.modelStarted('synthetic-1-1', 1, config.runtime.model!);
        captures.push(structuredClone(sent));
      }
      req.onEvent({ kind: 'text_delta', sdk_message_id: `synthetic-${calls}`, block_index: 0, text: '合成受控回复。', channel: 'main' });
      return { outcome: 'completed', errorClassified: null, errorCode: null, errorMessage: null,
        sessionId: 'synthetic-sdk', requestId: null, activityStarted: true,
        finalMessages: [...sent, { role: 'assistant', content: '合成受控回复。' }], lastSentMessages: sent };
    },
  };
  const runner = new SubscriptionAccessRunner(config, settings, async cfg => {
    factories.push(cfg.runtime.provider); assert.equal(cfg.runtime.provider, 'claude-agent-sdk');
    return { status: 'ok', runner: fakeRunner };
  });
  const windows = new WindowManager(db, events, identity, config, undefined, trajectory);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, windows, trajectory, settings,
    capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner },
    reasoning: new ReasoningService(db, events), usage: new UsageCollector(db),
    routing: new RoutingService(db, events, messages), logger: new Logger(null),
    tools, toolCatalog: registry, reviews, checkpoint, surfacing: svc });
  try {
    const a = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: firstText, clientMessageId: 'sdk-1' });
    supervisor.enqueue(a.turnId); await supervisor.waitIdle();
    assert.equal(db.prepare('SELECT state FROM turns WHERE id=?').get(a.turnId)?.state, 'completed');
    assert.deepEqual(factories, ['claude-agent-sdk']);
    assert.equal(sol.calls(), 1, 'tool continuation does not repeat Sol');
    assert.equal(caps.filter(c => c.endsWith('.prepare')).length, 1);
    assert.ok(JSON.stringify(captures[0]).includes(SURFACE_HOST_NOTICE));
    assert.ok(JSON.stringify(captures[0]).includes(ITEM.event_text));
    assert.deepEqual(captures[1].slice(0, captures[0].length), captures[0], 'continuation preserves the exact earlier request');
    assert.equal((modelDetail as { text: string }).text, ITEM.event_text);
    assert.equal(db.prepare("SELECT state FROM surfacing_deliveries").get()?.state, 'retained');
    const visible = svc.visibleMemoriesForTurn('c1', a.turnId); assert.equal(visible.length, 1);
    assert.equal((await svc.readMemoryForTurn('c1', a.turnId, visible[0].memory_ref)).ok, true);
    assert.equal(db.prepare('SELECT count(*) n FROM provider_requests WHERE sent_at IS NOT NULL').get()?.n, 2);
    const b = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: nextText, clientMessageId: 'sdk-2' });
    supervisor.enqueue(b.turnId); await supervisor.waitIdle();
    assert.equal(db.prepare('SELECT state FROM turns WHERE id=?').get(b.turnId)?.state, 'completed');
    assert.equal(sol.calls(), 2); assert.equal(caps.filter(c => c.endsWith('.prepare')).length, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM surfacing_deliveries WHERE retained=1').get()?.n, 1, 'already-visible evidence is not appended again');
    const memoryBlocks = captures[2].flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.map(b => b.text ?? '')).filter(text => text.startsWith('{\"memories\":'));
    assert.equal(memoryBlocks.length, 1, 'new SDK turn preserves the original memory block without appending it again');
    const c = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '嗯，我就是想到那天。', clientMessageId: 'sdk-3' });
    supervisor.enqueue(c.turnId); await supervisor.waitIdle();
    assert.equal(sol.calls(), 3);
    assert.equal(caps.filter(cap => cap.endsWith('.prepare')).length, 2, '实际已送达同需换purpose措辞不重查');
    assert.equal(db.prepare('SELECT reason_code FROM surfacing_jobs WHERE source_message_id=?').get(c.message.id)?.reason_code,
      'SURFACE_NEED_ALREADY_DELIVERED');
    assert.equal(forbiddenNetwork, 0); assert.equal(forbiddenSdkLoads, 0);
  } finally {
    await svc.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true });
    globalThis.fetch = savedFetch; hooks.deregister();
  }
});

test('enabling surfacing in the existing settings activates the already-bound formal message lifecycle', async () => {
  const { Host } = await import('../../apps/host/src/app-context.ts');
  const { tempRoot, pollUntil } = await import('../helpers.ts');
  const root = tempRoot('surface-enable-');
  const savedFetch = globalThis.fetch; let solCalls = 0; let otherCalls = 0;
  globalThis.fetch = async input => {
    if (String(input) !== 'https://sol.test/v1/responses') { otherCalls++; throw Error('NETWORK_FORBIDDEN'); }
    solCalls++;
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify({ decision: 'none', topic: 'new', basis: '合成当下分享', plan: null }) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const host = await Host.create({ stateRoot: root, logDir: null, bind: '127.0.0.1', port: 0,
    config: buildConfig({ runtime: { provider: 'mock' }, memory_surfacing: { enabled: false,
      sol: { api_key_env: 'EST_TEST_SOL_KEY', base_url: 'https://sol.test/v1' } } }) });
  try {
    host.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '合成：功能尚未开启。', clientMessageId: 'disabled' });
    assert.equal(host.db.prepare('SELECT count(*) n FROM surfacing_jobs').get()?.n, 0);
    assert.equal(solCalls, 0);
    assert.equal(host.surfacing!.updateSettings({ enabled: true }).ok, true);
    const next = host.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '合成：我去倒杯水。', clientMessageId: 'enabled' });
    await pollUntil(() => host.db.prepare("SELECT 1 FROM surfacing_jobs WHERE source_message_id=? AND state='empty' AND reason_code='SURFACE_SOL_NONE'").get(next.message.id) !== undefined);
    assert.equal(solCalls, 1); assert.equal(otherCalls, 0);
  } finally {
    await host.stop(); globalThis.fetch = savedFetch; fs.rmSync(root, { recursive: true, force: true });
  }
});
