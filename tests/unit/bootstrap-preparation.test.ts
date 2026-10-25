import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase, type Db } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
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
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { buildFullTestRegistry, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const now = '2026-10-15T00:00:00Z';
const initial = [{ role: 'system' as const, content: [{ type: 'text' as const, text: 'UNSENT_BOOTSTRAP_DRAFT' }] }];
function windowFixture() {
  const db = openDatabase(tempRoot('bootstrap-draft-')); migrate(db, sha256Hex);
  db.prepare("INSERT INTO conversations(id,created_at) VALUES('c1',?)").run(now);
  for (const id of ['w1', 'w2']) db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES(?,'c1','ACTIVE',?,?)").run(id, now, now);
  const trajectory = new WindowTrajectoryService(db);
  trajectory.init('w1', initial, []);
  return { db, trajectory };
}
function request(db: Db, options: { id?: string; window?: string; purpose?: string; dispatch?: string | null; sent?: string | null; outcome?: string | null } = {}) {
  db.prepare('INSERT INTO provider_requests(id,window_id,purpose,seen_manifest_json,created_at,dispatch_started_at,sent_at,outcome) VALUES(?,?,?,?,?,?,?,?)')
    .run(options.id ?? 'req1', options.window ?? 'w1', options.purpose ?? 'chat', '[]', now, options.dispatch ?? null, options.sent ?? null, options.outcome ?? null);
}

test('unpublished initial trajectory can be discarded and rebuilt; absence is an idempotent no-op', () => {
  const { db, trajectory } = windowFixture();
  try {
    assert.equal(trajectory.discardUnsent('w1'), true);
    assert.equal(trajectory.forWindow('w1'), null);
    assert.equal(trajectory.discardUnsent('w1'), false);
    trajectory.init('w1', [{ role: 'system', content: [{ type: 'text', text: 'FRESH_BOOTSTRAP' }] }], []);
    assert.equal(JSON.stringify(trajectory.forWindow('w1')).includes('UNSENT_BOOTSTRAP_DRAFT'), false);
    assert.ok(JSON.stringify(trajectory.forWindow('w1')).includes('FRESH_BOOTSTRAP'));
  } finally { db.close(); }
});

test('a request registered but rejected before dispatch does not freeze the draft; its audit row stays', () => {
  const { db, trajectory } = windowFixture();
  try {
    request(db, { outcome: 'CAPACITY_REJECTED_BEFORE_DISPATCH' });
    assert.equal(trajectory.discardUnsent('w1'), true);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM provider_requests').get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test('sent failures, unknown dispatches, legacy send evidence and every request purpose freeze the original prefix', async t => {
  const cases = [
    { name: 'sent failure', dispatch: now, sent: now, outcome: 'failed' },
    { name: 'unconfirmed network failure', dispatch: now, sent: null, outcome: 'failed' },
    { name: 'unknown outcome', dispatch: now, sent: null, outcome: null },
    { name: 'legacy sent evidence', dispatch: null, sent: now, outcome: 'failed' },
    ...['pre_rotate_review', 'proactive_turn', 'cache_keepalive'].map(purpose => ({ name: purpose, purpose, dispatch: now, sent: null, outcome: 'unknown' })),
  ];
  for (const scenario of cases) await t.test(scenario.name, () => {
    const { db, trajectory } = windowFixture();
    try {
      request(db, scenario);
      const before = JSON.stringify(trajectory.forWindow('w1'));
      assert.equal(trajectory.discardUnsent('w1'), false);
      assert.equal(JSON.stringify(trajectory.forWindow('w1')), before);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM provider_requests').get() as { n: number }).n, 1);
    } finally { db.close(); }
  });
});

test('an existing sent boundary freezes a trajectory even if request history is absent', () => {
  const { db, trajectory } = windowFixture();
  try {
    trajectory.replace('w1', initial, { messageIndex: 0, contentIndex: 0 }, []);
    const before = JSON.stringify(trajectory.forWindow('w1'));
    assert.equal(trajectory.discardUnsent('w1'), false);
    assert.equal(JSON.stringify(trajectory.forWindow('w1')), before);
  } finally { db.close(); }
});

test('all requests of the target window count; another window does not prevent its first preparation', () => {
  const { db, trajectory } = windowFixture();
  try {
    request(db, { id: 'other', window: 'w2', dispatch: now });
    assert.equal(trajectory.discardUnsent('w1'), true);
    trajectory.init('w1', initial, []);
    request(db, { id: 'old_sent', dispatch: now });
    request(db, { id: 'new_unsent' });
    assert.equal(trajectory.discardUnsent('w1'), false, 'A later unsent record cannot hide earlier dispatch evidence');
  } finally { db.close(); }
});

// Full supervisor execution with injected transports only. No provider, real
// user message, real identity or external service is contacted by these tests.
function compose(mariposa: MariposaTransport) {
  const root = tempRoot('bootstrap-prep-supervisor-'); writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root), db = openDatabase(path.join(root, 'data')); migrate(db, sha256Hex);
  const events = new EventService(db), messages = new MessageService(db), identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages), trajectory = new WindowTrajectoryService(db);
  const windows = new WindowManager(db, events, identity, config);
  const seen: string[] = [];
  const runner = new DeepSeekRunner({ retryMax: 0 }, async payload => {
    seen.push(JSON.stringify(payload.messages));
    const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
    const body = frame({ id: 'synthetic-response', choices: [{ delta: { content: '合成答复' } }] })
      + frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + 'data: [DONE]\n\n';
    return { status: 200, headers: new Map(), body: Readable.from([Buffer.from(body)]) };
  });
  const client = new MariposaClient({ transport: mariposa });
  const supervisor = new TurnSupervisor({bootstrap: new MariposaClient({ transport: mariposa }), // S18：显式 BootstrapPort（原经 tools.mariposaClient 隐式取得）
     db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows,
    logger: new Logger(path.join(root, 'logs')), trajectory, toolCatalog: buildFullTestRegistry() });
  messages.ensureConversation('c1');
  return { db, messages, windows, identity, supervisor, trajectory, seen };
}
const packet = (text: string) => ({ snapshot_id: 'snap_test', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none', memory_days: { items: [{ memory_id: 'm1', original_title: text, event_text: text }] }, plans: { items: [] }, i: { content: '合成I' } });

test('Stop during first preparation leaves no frozen draft; a later same-window attempt loads fresh bootstrap', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let reads = 0;
  const ctx = compose(async capability => {
    assert.equal(capability, 'bootstrap.get'); reads++;
    if (reads === 1) { entered(); await held; return { ok: true, result: packet('LATE_CANCELLED_BOOTSTRAP') }; }
    return { ok: true, result: packet('FRESH_BOOTSTRAP_AFTER_STOP') };
  });
  try {
    const first = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '合成输入一', clientMessageId: 'prep-stop-1' });
    ctx.supervisor.enqueue(first.turnId); await started;
    assert.equal(ctx.supervisor.stop(first.turnId).stopped, true); release(); await ctx.supervisor.waitIdle();
    const windowId = ctx.windows.activeWindow('c1')!.id;
    assert.equal(ctx.trajectory.forWindow(windowId), null, 'Cancellation before dispatch cannot freeze an empty/partial B');
    assert.equal(ctx.seen.length, 0);
    assert.equal((ctx.db.prepare('SELECT COUNT(*) AS n FROM provider_requests').get() as { n: number }).n, 0);
    const second = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '合成输入二', clientMessageId: 'prep-stop-2' });
    ctx.supervisor.enqueue(second.turnId); await ctx.supervisor.waitIdle();
    assert.equal(reads, 2); assert.equal(ctx.seen.length, 1);
    assert.ok(ctx.seen[0].includes('FRESH_BOOTSTRAP_AFTER_STOP'));
    assert.ok(!ctx.seen[0].includes('LATE_CANCELLED_BOOTSTRAP'));
    assert.equal(ctx.trajectory.discardUnsent(windowId), false, 'The later real mock dispatch now freezes its prefix');
  } finally { release(); await ctx.supervisor.waitIdle(); ctx.db.close(); }
});

test('an existing unsent preparation is rebuilt before its first dispatch, including its in-memory B cache', async () => {
  let reads = 0;
  const ctx = compose(async capability => {
    assert.equal(capability, 'bootstrap.get'); reads++;
    return { ok: true, result: packet('FRESH_REPREPARED_BOOTSTRAP') };
  });
  try {
    const gate = ctx.identity.evaluateGate(ctx.db, { driver: 'deepseek' });
    const created = ctx.windows.createWindow({ conversationId: 'c1', gate });
    ctx.trajectory.init(created.window.id, initial, []);
    (ctx.supervisor as any).bootstrapByWindow.set(created.window.id, 'OLD_UNSENT_CACHED_BOOTSTRAP');
    const turn = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '合成首次派发', clientMessageId: 'reprep-1' });
    ctx.supervisor.enqueue(turn.turnId); await ctx.supervisor.waitIdle();
    assert.equal(reads, 1); assert.equal(ctx.seen.length, 1);
    assert.ok(ctx.seen[0].includes('FRESH_REPREPARED_BOOTSTRAP'));
    assert.ok(!ctx.seen[0].includes('UNSENT_BOOTSTRAP_DRAFT') && !ctx.seen[0].includes('OLD_UNSENT_CACHED_BOOTSTRAP'));
  } finally { await ctx.supervisor.waitIdle(); ctx.db.close(); }
});
