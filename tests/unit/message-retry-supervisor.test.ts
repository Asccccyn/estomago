// Retry integration uses synthetic identity, isolated SQLite and injected transports only.
// Prefix equality is evidence of reuse eligibility, not a claim of provider cache hits.
import { test } from 'node:test';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
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
import { MessageRetryService } from '../../apps/host/src/messages/retry.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';

const initialInput = 'synthetic-failed-input';
const editedInput = 'synthetic-edited-input\nsecond line';
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

function fixture() {
  const root = tempRoot('message-retry-supervisor-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: 'anthropic/claude-test-1' } });
  const paths = buildPaths(root), db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db), messages = new MessageService(db), identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages), trajectory = new WindowTrajectoryService(db);
  const windows = new WindowManager(db, events, identity, config);
  const reviews = new RotationReviewService(db), checkpoint = new HoldCheckpointService(db);
  let bootstrapCalls = 0;
  const mariposa = new MariposaClient({ transport: async () => {
    bootstrapCalls++;
    return { ok: true, result: { snapshot_id: 'synthetic-snapshot', state_hash: 'synthetic-hash', profile: 'estomago', memory_days: { items: [], count: 0 }, plans: { items: [], count: 0 }, i: { content: 'synthetic-bootstrap', note: '' } } };
  } });
  const { tools: tools } = assembleTestTools({ db: db, mariposa: mariposa, reviews: reviews, checkpoint: checkpoint });
  const payloads: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async payload => {
    payloads.push(structuredClone(payload));
    if (payloads.length === 2) throw new Error('fetch failed: synthetic network error');
    const body = frame({ id: `synthetic-${payloads.length}`, choices: [{ delta: { content: 'synthetic answer' } }] })
      + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
    return { status: 200, headers: new Map(), body: Readable.from([Buffer.from(body)]) };
  };
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({bootstrap: mariposa, // S18：显式 BootstrapPort（原经 tools.mariposaClient 隐式取得）
     db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db),
    routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  const retry = new MessageRetryService(db, messages, 'openrouter');
  const say = async (content: string, clientMessageId: string) => {
    const result = messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId });
    supervisor.enqueue(result.turnId);
    await supervisor.waitIdle();
    return result;
  };
  const prepareFailure = async () => {
    await say('synthetic baseline', 'baseline');
    const window = windows.activeWindow('c1')!;
    const baseline = JSON.stringify(trajectory.forWindow(window.id));
    const failed = await say(initialInput, 'failed');
    assert.equal((db.prepare('SELECT state FROM attempts WHERE id=?').get(failed.attemptId) as { state: string }).state, 'failed');
    assert.equal(JSON.stringify(trajectory.forWindow(window.id)), baseline, 'failed input must not advance canonical history');
    const request = db.prepare('SELECT sent_at, generation_id FROM provider_requests WHERE attempt_id=?').get(failed.attemptId) as { sent_at: string | null; generation_id: string | null };
    assert.deepEqual({ ...request }, { sent_at: null, generation_id: null });
    return { window, failed, baseline };
  };
  return { db, config, messages, trajectory, windows, supervisor, retry, payloads, prepareFailure, bootstrapCalls: () => bootstrapCalls };
}

test('same-turn retries preserve the actual wire prefix and frozen cache boundaries', async t => {
  for (const edit of [false, true]) await t.test(edit ? 'edited retry' : 'unchanged retry', async () => {
    const ctx = fixture();
    try {
      const { window, failed, baseline } = await ctx.prepareFailure();
      const bootCalls = ctx.bootstrapCalls();
      if (edit) {
        // Latest contract: dispatched inputs stay immutable even when the response is unknown.
        assert.throws(() => ctx.retry.retry({ conversationId: 'c1', messageId: failed.message.id, content: editedInput, expectedRevision: 1, operationKey: 'retry-1' }), (error: any) => error.code === 'MESSAGE_ALREADY_DISPATCHED');
        assert.equal(ctx.messages.getMessage(failed.message.id)!.current_revision, 1);
        assert.equal(JSON.stringify(ctx.trajectory.forWindow(window.id)), baseline);
        assert.equal(ctx.payloads.length, 2);
        return;
      }
      const result = ctx.retry.retry({ conversationId: 'c1', messageId: failed.message.id, content: initialInput, expectedRevision: 1, operationKey: 'retry-1' });
      assert.equal(result.turn_id, failed.turnId);
      assert.notEqual(result.attempt_id, failed.attemptId);
      assert.equal(result.message.current_revision, edit ? 2 : 1);
      assert.equal(JSON.stringify(ctx.trajectory.forWindow(window.id)), baseline, 'accepting a retry must not rewrite history');
      ctx.supervisor.enqueue(result.turn_id);
      ctx.supervisor.enqueue(result.turn_id); // A duplicate dispatch cannot create a second provider call.
      await ctx.supervisor.waitIdle();
      assert.equal(ctx.payloads.length, 3);
      assert.equal(ctx.windows.activeWindow('c1')!.id, window.id);
      assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM windows').get() as { n: number }).n, 1);
      assert.equal(ctx.bootstrapCalls(), bootCalls, 'retry must not rebuild the bootstrap snapshot');
      const before = ctx.payloads[1]!, after = ctx.payloads[2]!;
      for (const key of ['model', 'session_id', 'tools', 'cache_control', 'provider']) assert.deepEqual(after[key], before[key], key);
      const oldMessages = before.messages as Array<Record<string, unknown>>;
      const newMessages = after.messages as Array<Record<string, unknown>>;
      assert.equal(JSON.stringify(newMessages.slice(0, -1)), JSON.stringify(oldMessages.slice(0, -1)), 'history and every prefix cache marker stay byte-identical');
      const tail = JSON.stringify(newMessages.at(-1));
      assert.equal(tail.split(edit ? 'synthetic-edited-input' : initialInput).length - 1, 1, 'the current input appears exactly once');
      if (edit) assert.equal(JSON.stringify(newMessages).includes(initialInput), false, 'the superseded input must not enter the retry payload');
      const manifest = ctx.trajectory.forWindow(window.id)!.manifest!;
      assert.deepEqual(manifest.filter(entry => entry.id === failed.message.id).map(entry => entry.revision), [edit ? 2 : 1]);
      const attempts = ctx.db.prepare('SELECT state FROM attempts WHERE turn_id=? ORDER BY attempt_no').all(failed.turnId) as Array<{ state: string }>;
      assert.deepEqual(attempts.map(attempt => attempt.state), ['failed', 'completed']);
      assert.equal(ctx.messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 20 }).filter(message => message.id === failed.message.id).length, 1);
    } finally { ctx.db.close(); }
  });
});

test('a window switch after retry acceptance blocks dispatch and preserves both windows', async () => {
  const ctx = fixture();
  try {
    const { window, failed } = await ctx.prepareFailure();
    const result = ctx.retry.retry({ conversationId: 'c1', messageId: failed.message.id, content: initialInput, expectedRevision: 1, operationKey: 'retry-switch' });
    // Simulate a separately authorized window switch before the queued task starts.
    ctx.db.prepare("INSERT INTO windows(id,conversation_id,status,context_fingerprint,created_at,updated_at) SELECT 'replacement-window',conversation_id,'ACTIVE',context_fingerprint,created_at,updated_at FROM windows WHERE id=?").run(window.id);
    ctx.db.prepare("UPDATE windows SET status='CLOSED' WHERE id=?").run(window.id);
    ctx.db.prepare("UPDATE conversations SET active_window_id='replacement-window' WHERE id='c1'").run();
    const windowsBefore = JSON.stringify(ctx.db.prepare('SELECT * FROM windows ORDER BY id').all());
    const trajectoryBefore = JSON.stringify(ctx.trajectory.forWindow(window.id));
    ctx.supervisor.enqueue(result.turn_id);
    await ctx.supervisor.waitIdle();
    assert.equal(ctx.payloads.length, 2, 'no provider dispatch into the new window');
    assert.equal(JSON.stringify(ctx.db.prepare('SELECT * FROM windows ORDER BY id').all()), windowsBefore);
    assert.equal(JSON.stringify(ctx.trajectory.forWindow(window.id)), trajectoryBefore);
    const attempt = ctx.db.prepare('SELECT state,blocked_reason FROM attempts WHERE id=?').get(result.attempt_id) as { state: string; blocked_reason: string };
    assert.equal(attempt.state, 'blocked');
    assert.match(attempt.blocked_reason, /^RETRY_CONTEXT_CHANGED:/);
  } finally { ctx.db.close(); }
});

test('configuration drift after retry acceptance blocks without invalidating the active window', async () => {
  const ctx = fixture();
  try {
    const { window, failed } = await ctx.prepareFailure();
    const result = ctx.retry.retry({ conversationId: 'c1', messageId: failed.message.id, content: initialInput, expectedRevision: 1, operationKey: 'retry-config' });
    const windowBefore = JSON.stringify(ctx.windows.activeWindow('c1'));
    const trajectoryBefore = JSON.stringify(ctx.trajectory.forWindow(window.id));
    ctx.config.openrouter.model = 'anthropic/different-synthetic-model';
    ctx.supervisor.enqueue(result.turn_id);
    await ctx.supervisor.waitIdle();
    assert.equal(ctx.payloads.length, 2);
    assert.equal(JSON.stringify(ctx.windows.activeWindow('c1')), windowBefore);
    assert.equal(JSON.stringify(ctx.trajectory.forWindow(window.id)), trajectoryBefore);
    const attempt = ctx.db.prepare('SELECT state,blocked_reason FROM attempts WHERE id=?').get(result.attempt_id) as { state: string; blocked_reason: string };
    assert.equal(attempt.state, 'blocked');
    assert.match(attempt.blocked_reason, /^RETRY_CONTEXT_CHANGED:/);
  } finally { ctx.db.close(); }
});

test('a retry requiring capacity rotation blocks without rebuilding its pinned context', async () => {
  const ctx = fixture();
  try {
    const { window, failed } = await ctx.prepareFailure();
    const result = ctx.retry.retry({ conversationId: 'c1', messageId: failed.message.id, content: initialInput, expectedRevision: 1, operationKey: 'retry-capacity' });
    const windowBefore = JSON.stringify(ctx.windows.activeWindow('c1'));
    const trajectoryBefore = JSON.stringify(ctx.trajectory.forWindow(window.id));
    const bootstrapCalls = ctx.bootstrapCalls();
    ctx.config.windows.soft_limit_tokens = 1;
    ctx.supervisor.enqueue(result.turn_id);
    await ctx.supervisor.waitIdle();
    assert.equal(ctx.payloads.length, 2, 'no chat or rotation-review provider request');
    assert.equal(ctx.bootstrapCalls(), bootstrapCalls);
    assert.equal(JSON.stringify(ctx.windows.activeWindow('c1')), windowBefore);
    assert.equal(JSON.stringify(ctx.trajectory.forWindow(window.id)), trajectoryBefore);
    assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM windows').get() as { n: number }).n, 1);
    assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM rotation_reviews').get() as { n: number }).n, 0);
    const attempt = ctx.db.prepare('SELECT state,blocked_reason FROM attempts WHERE id=?').get(result.attempt_id) as { state: string; blocked_reason: string };
    assert.equal(attempt.state, 'blocked');
    assert.match(attempt.blocked_reason, /^RETRY_CONTEXT_CAPACITY:/);
  } finally { ctx.db.close(); }
});
