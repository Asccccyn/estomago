import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Readable } from 'node:stream';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import type { MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { WishstarClient } from '../../apps/host/src/integrations/wishstar/client.ts';
import { HeartbeatCards, type HeartbeatSource } from '../../apps/host/src/modules/heartbeat/service.ts';
import { heartbeatBusinessDate } from '../../apps/host/src/modules/heartbeat/runtime.ts';
import { HeartbeatSources, type CardPayload } from '../../apps/host/src/modules/heartbeat/sources.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { lastCacheEvidence } from '../../apps/host/src/runtime/cache-observation.ts';
import { tailBoundaryOf } from '../../apps/host/src/runtime/cache-plan.ts';
import type { OrMessage, OrTool } from '../../apps/host/src/runtime/or-payload.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { decorateMomentResponse } from '../../apps/host/src/server/routes/content-moments.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { readHeartbeatProjection } from '../../packages/contracts/src/heartbeat.ts';
import { makeFixtureToolsResident, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';

const MODEL = 'anthropic/claude-fixture-exact';
const CARDS = Array.from({ length: 10 }, (_, index): HeartbeatSource => ({
  kind: 'moments', namespace: 'content', id: `fixture-${index + 1}`, revision: 2,
  identity: `content:moments:fixture-${index + 1}`, permissionScope: 'primary',
}));
const REVEAL = '这是一段只属于已揭牌工具结果的合成内容';
const usage = {
  prompt_tokens: 2100, completion_tokens: 7,
  prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 600 }, cost: 0.001,
};
type WireMessage = { role: string; content: unknown; tool_call_id?: string };
type Wire = { messages: WireMessage[]; tools: unknown[] };
type Reply = { text: string } | { tool: string; id: string; args: Record<string, unknown>; speech?: string } | { disconnect: true } | { crash: true };
const asMessage = (text: string): Reply => ({ text });
const draw = (number: number): Reply => ({ tool: 'heartbeat_draw', id: `draw-${number}`, args: { card_number: number } });
const noop = (): Reply => ({ tool: 'background_complete', id: 'decline-no-text', args: { outcome: 'noop' } });

function text(message: WireMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
}

async function fixture(t: TestContext, candidates: HeartbeatSource[] = CARDS, sourceStatus: CardPayload['status'] = 'available', retryMax = 0,
  startup?: { root?: string; reopen?: boolean; maxModelRequests?: number; wishstar?: boolean }) {
  t.mock.method(HeartbeatSources.prototype, 'choose', async () => candidates);
  t.mock.method(HeartbeatSources.prototype, 'resolve', async (source: HeartbeatSource): Promise<CardPayload> =>
    sourceStatus === 'available'
      ? { status: 'available', text: `${REVEAL}/${source.id}`, imageIds: [], assetIds: [] }
      : { status: sourceStatus });
  const replies: Reply[] = [];
  const wire: Wire[] = [];
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax }, async payload => {
    wire.push(payload as Wire);
    const response = replies.shift();
    assert.ok(response, 'unexpected model dispatch');
    if ('crash' in response) process.kill(process.pid, 'SIGKILL');
    if ('crash' in response) throw Error('fixture crash did not interrupt the process');
    if ('disconnect' in response) throw Object.assign(new Error('ECONNRESET after fixture receives request'), { code: 'ECONNRESET' });
    const delta = 'text' in response ? { content: response.text } : {
      ...(response.speech ? { content: response.speech } : {}),
      tool_calls: [{ index: 0, id: response.id, type: 'function', function: { name: response.tool, arguments: JSON.stringify(response.args) } }],
    };
    const body = Readable.from([
      `data: ${JSON.stringify({ id: `generation-${wire.length}`, choices: [{ delta }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'text' in response ? 'stop' : 'tool_calls' }], usage })}\n\n`,
      'data: [DONE]\n\n',
    ].map(chunk => Buffer.from(chunk, 'utf8')));
    return { status: 200, headers: new Headers({ 'x-generation-id': `generation-${wire.length}` }), body };
  });
  const root = startup?.root ?? tempRoot('heartbeat-v12-');
  if (!startup?.reopen) writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime as object, provider: 'mock', tool_schema_mode: 'direct' },
    openrouter: { model: MODEL },
    background: { keepwarm: { sleep_window: { enabled: false } },
      ...(startup?.maxModelRequests === undefined ? {} : { autonomous: { max_model_requests_per_run: startup.maxModelRequests } }) },
    ...(startup?.wishstar ? { wishstar: { enabled: true } } : {}),
    windows: { model_context_capacity: 150_000 },
  });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0, runnerOverride: runner });
  if (!startup?.reopen) makeFixtureToolsResident(host.db, ['heartbeat_draw', 'background_complete']);
  const scheduler = host.scheduler!;
  t.after(async () => { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  // Observe the real capacity guard without changing its returned decision.
  const capacity = host.supervisor as unknown as {
    requestCapacity(messages: OrMessage[], tools: OrTool[], output: number): { estimate: number } | null;
  };
  const actualCapacity = capacity.requestCapacity.bind(capacity);
  const capacityEstimates: Array<{ current: number; withAckRemoved: number }> = [];
  t.mock.method(capacity, 'requestCapacity', (messages: OrMessage[], tools: OrTool[], output: number) => {
    const actual = actualCapacity(messages, tools, output);
    const invite = messages.findIndex(message => message.role === 'user' && text(message).includes('请回复 1 保温'));
    if (actual && invite >= 0 && messages[invite + 1]?.role === 'assistant' && text(messages[invite + 1]) === '1'
      && messages.some(message => message.role === 'user' && text(message).includes('下一条自然输入'))) {
      const withoutAck = actualCapacity(messages.filter((_, index) => index !== invite + 1), tools, output);
      if (withoutAck) capacityEstimates.push({ current: actual.estimate, withAckRemoved: withoutAck.estimate });
    }
    return actual;
  });
  const activity = () => host.db.prepare('SELECT * FROM conversation_activity WHERE conversation_id=?')
    .get('primary') as { activity_revision: number; last_real_activity_at: string; maintenance_request_id: string | null; maintenance_dispatch_started_at: string | null };
  if (!startup?.reopen) {
    const settings = new BackgroundSettingsService(host.db, config);
    settings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 5 } });
    host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,?)")
      .run(JSON.stringify({ input_micro_per_token: 0.000003, output_micro_per_token: 0.000015 }), new Date().toISOString());
  }
  const cards = new HeartbeatCards(host.db);
  const date = heartbeatBusinessDate();
  const trajectory = new WindowTrajectoryService(host.db);
  const windowId = () => host.windows.activeWindow('primary')!.id;
  async function chat(content: string, replyText = '合成聊天回复') {
    replies.push(asMessage(replyText));
    const input = host.messages.submitUserMessageWithTurn({
      conversationId: 'primary', content, clientMessageId: `fixture-chat-${startup?.reopen ? 'reopened-' : ''}${wire.length}`,
    });
    host.supervisor.enqueue(input.turnId);
    await host.supervisor.waitIdle();
    const turn = host.db.prepare('SELECT state FROM turns WHERE id=?').get(input.turnId) as { state: string };
    assert.equal(turn.state, 'completed');
  }
  let elapsedCalls = 0;
  function elapsed() {
    // Advance fixture timestamps enough to hit the original 50-minute due
    // boundary while retaining evidence inside its 60-minute warm window.
    const evidence = lastCacheEvidence(host.db, windowId());
    assert.ok(evidence, 'fake usage should supply the normal cache gate');
    const dueAnchor = new Date(Date.now() - 3_030_000 + (++elapsedCalls * 2000)).toISOString();
    host.db.prepare('UPDATE provider_requests SET dispatch_started_at=? WHERE id=?').run(dueAnchor, evidence.requestId);
    if (activity().maintenance_request_id) {
      host.db.prepare("UPDATE conversation_activity SET maintenance_dispatch_started_at=?, last_effective_heartbeat_at=CASE WHEN last_effective_heartbeat_at IS NOT NULL THEN ? ELSE NULL END WHERE conversation_id='primary'").run(dueAnchor, dueAnchor);
    } else {
      host.db.prepare("UPDATE conversation_activity SET last_real_activity_at=?, last_effective_heartbeat_at=CASE WHEN last_effective_heartbeat_at IS NOT NULL THEN ? ELSE NULL END WHERE conversation_id='primary'").run(dueAnchor, dueAnchor);
    }
  }
  function seedNineCards() {
    // Represent earlier settled heartbeats by exercising the real deck and
    // evidence ledger. This test then drives the tenth selection via the host.
    const at = new Date(Date.now() - 3_100_000).toISOString();
    for (let number = 2; number <= 10; number++) {
      const runId = `history-heartbeat-${number}`;
      const operationId = `history-card-${number}`;
      const providerRequestId = `history-request-${number}`;
      host.db.prepare(`
        INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at)
        VALUES(?,'fixture-history','primary','jiaming','keepwarm',1,?,'running',?,?)
      `).run(runId, runId, at, at);
      const op = { runId, operationId };
      assert.equal(cards.begin({ runId, businessDate: date, candidates: CARDS })?.mode, 'draw');
      assert.equal(cards.claim({ ...op, cardNumber: number }).status, 'claimed');
      assert.equal(cards.recordSource({ ...op, result: 'ready' }).status, 'prepared');
      const payload = JSON.stringify({ messages: [{ role: 'tool', tool_call_id: operationId,
        content: JSON.stringify({ heartbeat_card: { operation_id: operationId } }) }] });
      host.db.prepare(`
        INSERT INTO provider_requests(id,window_id,purpose,seen_manifest_json,payload_json,background_run_id,dispatch_started_at,created_at)
        VALUES(?,?,'cache_keepalive','[]',?,?,?,?)
      `).run(providerRequestId, windowId(), payload, runId, at, at);
      assert.equal(cards.startDispatch({ ...op, providerRequestId }), true);
      host.db.prepare('UPDATE provider_requests SET sent_at=? WHERE id=?').run(at, providerRequestId);
      assert.equal(cards.recordDelivery({ ...op, outcome: 'delivered', providerRequestId }), true);
      host.db.prepare("UPDATE background_runs SET state='completed' WHERE id=?").run(runId);
    }
  }
  function latestRun() {
    const row = host.db.prepare(`
      SELECT b.id,b.result_code,b.state,b.turn_id,h.mode FROM background_runs b
      LEFT JOIN heartbeat_runs h ON h.run_id=b.id
      WHERE b.kind='keepwarm' AND b.task_id!='fixture-history' ORDER BY b.rowid DESC LIMIT 1
    `).get() as { id: string; result_code: string; state: string; turn_id: string | null; mode: string } | undefined;
    assert.ok(row, 'scheduler creates one heartbeat run');
    return row;
  }
  function runtimeMessages(runId: string) {
    return host.db.prepare(`
      SELECT m.id,m.speaker,r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision
      WHERE m.client_message_id LIKE ? ORDER BY m.sequence
    `).all(`heartbeat:${runId}:%`) as Array<{ id: string; speaker: string; content: string }>;
  }
  const projections = () => host.db.prepare("SELECT COUNT(*) n FROM outbox WHERE target='content_heartbeat_projection'")
    .get() as { n: number };
  if (!startup?.reopen) scheduler.start();
  return { host, scheduler, cards, date, trajectory, windowId, replies, wire, chat, elapsed, seedNineCards, latestRun, runtimeMessages, projections, activity, capacityEstimates };
}

const ACK_CRASH_TEST = 'T38: exhausted maintenance reply survives only an atomic local commit';
const ACK_CRASH_CHILD = '--t38-crash-child';
const ACK_CRASH_FILE = 't38-crash-point.json';
type CrashSeam = 'before_manifest' | 'after_commit';
type CrashCheckpoint = { runId: string; windowId: string; messageId: string; requestId: string; lastActivity: string };

async function crashAtMaintenanceAck(t: TestContext, root: string, seam: CrashSeam) {
  const ctx = await fixture(t, CARDS, 'available', 0, { root });
  await ctx.chat('建立现有聊天窗');
  ctx.seedNineCards();
  ctx.elapsed();
  ctx.replies.push(draw(1), asMessage('最后一张的普通回复'));
  await ctx.scheduler.tick();
  assert.equal(ctx.cards.getDeliveredDraw(ctx.latestRun().id)?.cardNumber, 1);
  ctx.elapsed();
  const lastActivity = ctx.activity().last_real_activity_at;
  let checkpoint: CrashCheckpoint | undefined;
  const crash = (point: CrashCheckpoint) => {
    fs.writeFileSync(path.join(root, ACK_CRASH_FILE), JSON.stringify(point));
    process.kill(process.pid, 'SIGKILL');
  };
  const { db } = ctx.host;
  const prepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql: string) => {
    if (sql === 'UPDATE window_trajectories SET manifest_json=? WHERE window_id=?') {
      assert.ok(db.isTransaction, 'ack and manifest must be in the active writer transaction');
      const run = ctx.latestRun();
      assert.equal(run.mode, 'exhausted_keepwarm');
      const ack = ctx.runtimeMessages(run.id).find(message => message.speaker === 'assistant');
      assert.equal(ack?.content, '1');
      assert.ok(ctx.host.events.replayPage(0, 'primary').some(event => event.kind === 'message.published' && event.entity_ref === ack!.id));
      const windowId = ctx.windowId();
      const trajectory = ctx.trajectory.forWindow(windowId)!;
      assert.equal(text(trajectory.messages.at(-1)), '1', 'fixture is after the canonical message write');
      assert.ok(!trajectory.manifest?.some(entry => entry.id === ack!.id), 'fixture is before the manifest association');
      const request = prepare("SELECT id,outcome FROM provider_requests WHERE background_run_id=? AND sent_at IS NOT NULL").get(run.id);
      assert.equal(request?.outcome, 'completed');
      checkpoint = { runId: run.id, windowId, messageId: ack!.id, requestId: String(request!.id), lastActivity };
      if (seam === 'before_manifest') crash(checkpoint);
    }
    return prepare(sql);
  });
  const exec = db.exec.bind(db);
  t.mock.method(db, 'exec', (sql: string) => {
    exec(sql);
    if (seam === 'after_commit' && sql === 'COMMIT' && checkpoint) {
      assert.ok(!db.isTransaction);
      assert.equal(ctx.latestRun().state, 'running', 'fixture is before scheduler finalization');
      assert.equal(ctx.trajectory.forWindow(checkpoint.windowId)?.manifest?.filter(entry => entry.id === checkpoint!.messageId).length, 1);
      crash(checkpoint);
    }
  });
  ctx.replies.push(asMessage('1'));
  await ctx.scheduler.tick();
  assert.fail('fixture did not reach the requested SQLite crash seam');
}

test(ACK_CRASH_TEST, async t => {
  if (process.argv[2] === ACK_CRASH_CHILD) {
    const seam = process.argv[4];
    assert.ok(seam === 'before_manifest' || seam === 'after_commit');
    await crashAtMaintenanceAck(t, process.argv[3]!, seam);
    return;
  }
  for (const seam of ['before_manifest', 'after_commit'] as const) await t.test(seam, async st => {
    const root = tempRoot('heartbeat-t38-');
    let reopened = false;
    try {
      const child = spawnSync(process.execPath, [`--test-name-pattern=^${ACK_CRASH_TEST}$`, import.meta.filename, ACK_CRASH_CHILD, root, seam], {
        env: { ...process.env, ESTOMAGO_HOME: root }, encoding: 'utf8', timeout: 15_000,
      });
      assert.equal(child.signal, 'SIGKILL', child.stdout + child.stderr);
      const checkpoint = JSON.parse(fs.readFileSync(path.join(root, ACK_CRASH_FILE), 'utf8')) as CrashCheckpoint;
      const committed = seam === 'after_commit';
      const count = committed ? 1 : 0;
      const before = openDatabase(path.join(root, 'data'));
      try {
        const trajectory = new WindowTrajectoryService(before).forWindow(checkpoint.windowId)!;
        assert.equal(before.prepare('SELECT count(*) AS n FROM messages WHERE id=?').get(checkpoint.messageId)?.n, count);
        assert.equal(trajectory.manifest?.filter(entry => entry.id === checkpoint.messageId).length, count);
        assert.equal(trajectory.messages.filter(message => message.role === 'assistant' && text(message) === '1').length, count);
        const run = before.prepare('SELECT state,trajectory_committed_at FROM background_runs WHERE id=?').get(checkpoint.runId);
        assert.equal(run?.state, 'running');
        assert.equal(Boolean(run?.trajectory_committed_at), committed);
      } finally {
        before.close();
      }

      const ctx = await fixture(st, CARDS, 'available', 0, { root, reopen: true });
      reopened = true;
      // Exercise the complete real startup and recovery path without opening a test socket.
      const server = (ctx.host as unknown as { server: { listen(port: number, bind: string, ready: () => void): void } }).server;
      st.mock.method(server, 'listen', (_port, _bind, ready) => ready());
      await ctx.host.start();
      await ctx.scheduler.tick();
      assert.equal(ctx.wire.length, 0, 'restart must not regenerate or redispatch the exhausted reply');
      const run = ctx.host.db.prepare('SELECT state,result_code FROM background_runs WHERE id=?').get(checkpoint.runId);
      assert.equal(ctx.activity().last_real_activity_at, checkpoint.lastActivity);
      assert.equal(ctx.activity().maintenance_request_id === checkpoint.requestId, committed);
      if (committed) {
        const target = new ConversationActivityService(ctx.host.db).nextKeepwarmTarget({
          conversationId: 'primary', windowId: checkpoint.windowId,
        });
        const recorded = ctx.host.db.prepare('SELECT dispatch_started_at FROM provider_requests WHERE id=?').get(checkpoint.requestId);
        assert.ok(target.scheduled && target.basis === 'maintenance');
        assert.equal(target.dueAtMs, Date.parse(String(recorded?.dispatch_started_at)) + 50 * 60_000);
      }
      assert.equal(ctx.runtimeMessages(checkpoint.runId).filter(message => message.speaker === 'assistant' && message.content === '1').length, count);
      assert.equal(ctx.runtimeMessages(checkpoint.runId).filter(message => message.speaker === 'system' && message.content.includes('请回复 1 保温')).length, 1);
      assert.equal(ctx.host.events.replayPage(0, 'primary').filter(event => event.kind === 'message.published' && event.entity_ref === checkpoint.messageId).length, count);
      assert.equal(ctx.host.db.prepare('SELECT count(*) AS n FROM provider_requests WHERE background_run_id=? AND sent_at IS NOT NULL').get(checkpoint.runId)?.n, 1);
      assert.equal(ctx.projections().n, 1, 'only the earlier draw has a Moments projection');

      await ctx.chat('下一条自然输入');
      assert.equal(ctx.wire.length, 1);
      assert.equal(ctx.windowId(), checkpoint.windowId);
      const request = ctx.host.db.prepare("SELECT seen_manifest_json FROM provider_requests WHERE purpose='chat' ORDER BY rowid DESC LIMIT 1")
        .get() as { seen_manifest_json: string };
      assert.equal((JSON.parse(request.seen_manifest_json) as Array<{ id: string }>).filter(entry => entry.id === checkpoint.messageId).length, count);
      assert.equal(ctx.wire[0]!.messages.filter(message => message.role === 'user' && text(message).includes('请回复 1 保温')).length, 1);
      assert.equal(ctx.wire[0]!.messages.filter(message => message.role === 'assistant' && text(message) === '1').length, count);
      if (committed) {
        const invite = ctx.wire[0]!.messages.findIndex(message => message.role === 'user' && text(message).includes('请回复 1 保温'));
        assert.equal(text(ctx.wire[0]!.messages[invite + 1]), '1');
        assert.ok(ctx.capacityEstimates.every(estimate => estimate.current > estimate.withAckRemoved));
        assert.ok(ctx.capacityEstimates.length);
      }
      assert.deepEqual({ ...run }, committed
        ? { state: 'completed', result_code: 'ack_only' }
        : { state: 'unknown', result_code: 'HOST_RESTART_MID_RUN' });
    } finally {
      if (!reopened) fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('heartbeat publishes mixed-packet text and a final reply around a real tool send in order', async t => {
  const ctx = await fixture(t);
  await ctx.chat('建立当前会话');
  ctx.elapsed();
  const speech = ['先去查工具。', '查好后再说一句。', '这句经工具发送。', '最后再说一句。'];
  ctx.replies.push(
    { tool: 'tool_define', id: 'define-chat', args: { name: 'chat_send_text' }, speech: speech[0] },
    { tool: 'chat_send_text', id: 'send-text', args: { text: speech[2], idempotency_key: 'send-once' }, speech: speech[1] },
    asMessage(speech[3]!),
  );
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.result_code, 'complete:done');
  assert.equal(ctx.cards.getDeliveredDraw(run.id), null);
  const { db, messages } = ctx.host;
  const ids = db.prepare("SELECT id FROM messages WHERE turn_id=? AND speaker='assistant' ORDER BY sequence").all(run.turn_id);
  assert.deepEqual(ids.map(row => messages.getMessage(String(row.id))?.revision.content), speech);
  const projection = readHeartbeatProjection(JSON.parse(String(db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get()?.payload_ref)));
  assert.equal(projection?.state, 'talked');
  assert.deepEqual(projection?.messages.filter(ref => ids.some(row => row.id === ref.messageId)).map(ref => ref.messageId), ids.map(row => row.id));
  await ctx.chat('接着说');
  const replayed = ctx.wire.at(-1)!.messages.filter(message => message.role === 'assistant').map(text);
  for (const ordinary of [speech[0], speech[1], speech[3]]) assert.equal(replayed.filter(line => line === ordinary).length, 1);
});

for (const outcome of ['done', 'noop'] as const) {
  test(`heartbeat: a chat-tool send on its own counts as speech when the turn completes with ${outcome}`, async t => {
    const ctx = await fixture(t);
    makeFixtureToolsResident(ctx.host.db, ['heartbeat_draw', 'background_complete', 'chat_send_text']);
    await ctx.chat('建立当前会话');
    ctx.elapsed();
    const speech = '只经聊天工具发出的一句。';
    ctx.replies.push({ tool: 'chat_send_text', id: 'send-text', args: { text: speech, idempotency_key: 'send-once' } },
      { tool: 'background_complete', id: 'complete', args: { outcome } });
    await ctx.scheduler.tick();
    const run = ctx.latestRun();
    assert.equal(run.result_code, `complete:${outcome}`);
    assert.equal(ctx.cards.getDeliveredDraw(run.id), null);
    const { db, messages, heartbeat } = ctx.host;
    const projection = readHeartbeatProjection(JSON.parse(String(db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get()?.payload_ref)));
    assert.equal(projection?.state, 'talked');
    assert.deepEqual(projection?.terminal, { status: 'completed' });
    const feed = await decorateMomentResponse(new URL('http://est.test/api/v1/content/posts?include_references=1'),
      { items: [{ id: 'heartbeat-test', kind: 'reference', revision: 1, reference: projection }] },
      { db, messages, heartbeat }) as { items: Array<{ blocks: Array<{ source_label: string; text: string }> }> };
    assert.deepEqual(feed.items[0]?.blocks.map(block => [block.source_label, block.text]), [
      ['心跳状态', ctx.runtimeMessages(run.id)[0]!.content], ['本轮聊天', speech], ['结束状态', '本轮只说了话。']]);
    await ctx.chat('接着说');
    // The next turn neither republishes the send nor needs a second copy of it.
    assert.equal(db.prepare("SELECT count(*) AS n FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=1 WHERE r.content=?")
      .get(speech)?.n, 1);
  });
}

test('T40: an incomplete candidate set ends without a request or a fake reply', async t => {
  const ctx = await fixture(t, CARDS.slice(0, 9));
  await ctx.chat('1');
  ctx.elapsed();
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.mode, 'unprepared');
  assert.equal(run.result_code, 'HEARTBEAT_DECK_UNPREPARED');
  assert.equal(ctx.wire.length, 1);
  assert.equal(ctx.cards.getDeck('primary', ctx.date), null);
  assert.deepEqual(ctx.runtimeMessages(run.id), []);
});

test('T09/T16/T21: structured draw of 1 can be the last delivery; the later exhaust reply is visible and retained once', async t => {
  const ctx = await fixture(t);
  await ctx.chat('普通聊天里的数字 1');
  ctx.seedNineCards();
  ctx.elapsed();
  ctx.replies.push(draw(1), asMessage('1'));
  await ctx.scheduler.tick();
  const drawn = ctx.latestRun();
  assert.equal(drawn.mode, 'draw');
  assert.equal(ctx.cards.getDeliveredDraw(drawn.id)?.cardNumber, 1);
  assert.equal(ctx.cards.getDeliveredDraw(drawn.id)?.source.id, 'fixture-1');
  assert.doesNotMatch(text(ctx.wire[1]!.messages.findLast(message => message.role === 'user')), /请回复 1/);
  assert.ok(ctx.wire[2]!.messages.some(message => message.role === 'tool' && message.tool_call_id === 'draw-1' && text(message).includes(REVEAL)));
  assert.deepEqual(ctx.runtimeMessages(drawn.id).filter(message => message.speaker === 'assistant').map(message => message.content), ['1']);
  assert.equal(ctx.projections().n, 1);

  ctx.elapsed();
  const lBefore = ctx.activity().last_real_activity_at;
  ctx.replies.push(asMessage('1'));
  await ctx.scheduler.tick();
  const warm = ctx.latestRun();
  assert.notEqual(warm.id, drawn.id);
  assert.equal(warm.mode, 'exhausted_keepwarm');
  assert.equal(warm.result_code, 'ack_only');
  assert.match(text(ctx.wire[3]!.messages.findLast(message => message.role === 'user')), /请回复 1/);
  const ack = ctx.runtimeMessages(warm.id).filter(message => message.speaker === 'assistant');
  assert.deepEqual(ack.map(message => message.content), ['1']);
  assert.equal(ctx.activity().last_real_activity_at, lBefore);
  assert.equal(ctx.projections().n, 1);
  const trajectory = ctx.trajectory.forWindow(ctx.windowId())!;
  assert.equal(trajectory.manifest?.filter(entry => entry.id === ack[0]!.id).length, 1);
  const replay = ctx.host.events.replayPage(0, 'primary').filter(event => event.kind === 'message.published' && event.entity_ref === ack[0]!.id);
  assert.equal(replay.length, 1);

  await ctx.chat('下一条自然输入');
  const next = ctx.wire[4]!;
  const warmInput = next.messages.findIndex(message => message.role === 'user' && text(message).includes('请回复 1 保温'));
  assert.ok(warmInput >= 0);
  assert.equal(next.messages.filter(message => message.role === 'user' && text(message).includes('请回复 1 保温')).length, 1);
  assert.equal(text(next.messages[warmInput + 1]), '1');
  assert.equal(next.messages[warmInput + 1]?.role, 'assistant');
  assert.equal(next.messages.slice(warmInput).filter(message => message.role === 'assistant' && text(message) === '1').length, 1);
  const nextRequest = ctx.host.db.prepare("SELECT seen_manifest_json FROM provider_requests WHERE purpose='chat' ORDER BY rowid DESC LIMIT 1")
    .get() as { seen_manifest_json: string };
  assert.equal((JSON.parse(nextRequest.seen_manifest_json) as Array<{ id: string }>).filter(entry => entry.id === ack[0]!.id).length, 1);
  assert.ok(ctx.capacityEstimates.length);
  assert.ok(ctx.capacityEstimates.every(estimate => estimate.current > estimate.withAckRemoved));
});

test('T24: ambiguous continuation never retries the same card or keeps its body in the next input', async t => {
  const ctx = await fixture(t, CARDS, 'available', 1);
  await ctx.chat('建立现有聊天窗');
  ctx.seedNineCards();
  ctx.elapsed();
  ctx.replies.push(draw(1), { disconnect: true });
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.mode, 'draw');
  assert.equal(ctx.wire.length, 3, 'the runner cannot retransmit an ambiguous card');
  assert.equal(ctx.cards.getDraw({ runId: run.id, operationId: 'draw-1' })?.status, 'unknown');
  const confirmed = ctx.host.db.prepare(`
    SELECT payload_json FROM provider_requests WHERE background_run_id=? AND sent_at IS NOT NULL
    ORDER BY sent_at DESC,rowid DESC LIMIT 1
  `).get(run.id) as { payload_json: string };
  assert.deepEqual(ctx.trajectory.forWindow(ctx.windowId())?.lastBoundary,
    tailBoundaryOf((JSON.parse(confirmed.payload_json) as { messages: OrMessage[] }).messages));
  assert.equal(ctx.cards.getDeck('primary', ctx.date)?.exhausted, false);
  assert.deepEqual(ctx.cards.getDeck('primary', ctx.date)?.availableNumbers, []);
  assert.equal(ctx.projections().n, 1, 'the observed invitation and uncertain selection are one honest reference, not a revealed card');
  const projection = JSON.parse(String(ctx.host.db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get()?.payload_ref));
  assert.equal(projection.card, null);
  assert.equal(projection.state, 'interrupted');
  assert.equal(projection.terminal.status, 'unknown');
  assert.equal(projection.actions[0].status, 'unknown');
  assert.doesNotMatch(JSON.stringify(projection), new RegExp(REVEAL));
  await ctx.chat('继续对话');
  const next = ctx.wire[3]!;
  assert.doesNotMatch(JSON.stringify(next.messages), new RegExp(REVEAL));
  assert.equal(next.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'draw-1').length, 1);
  ctx.elapsed();
  await ctx.scheduler.tick();
  assert.equal(ctx.latestRun().mode, 'source_unavailable');
  assert.equal(ctx.wire.length, 4);
});

test('heartbeat feed preserves a memory creation and reports its edits by outcome', async t => {
  const ctx = await fixture(t, CARDS, 'available', 0, { maxModelRequests: 7 });
  await ctx.chat('建立现有聊天窗');
  const { db, messages, heartbeat } = ctx.host;
  const memoryId = 'fixture-memory-to-edit';
  const privateText = '合成记忆正文，仅供隔离复验。';
  let version = 0;
  const attemptedVersions: unknown[] = [];
  const remote = (heartbeat!.sources as unknown as { external: { memory: { transport: MariposaTransport } } }).external.memory;
  remote.transport = async (name, args) => {
    if (name === 'memory.hold') {
      version = 1;
      return { ok: true, result: { operation_id: args.operation_id, memory_id: memoryId, version,
        binding_ids: [], committed_at: new Date().toISOString(), commit_observed_at: new Date().toISOString() } };
    }
    assert.equal(name, 'memory.update');
    assert.equal(args.memory_id, memoryId);
    attemptedVersions.push(args.expected_version);
    if (args.expected_version !== version) return { ok: false, code: 'VERSION_CONFLICT', httpStatus: 409 };
    if (version === 2) return { ok: false, code: 'HTTP_503', httpStatus: 503 };
    return { ok: true, result: { memory_id: memoryId, version: ++version } };
  };
  db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('background_tool_prices',?,?)")
    .run(JSON.stringify({ memory_hold: { max_cost_micro_usd: 1 }, memory_update: { max_cost_micro_usd: 1 } }), new Date().toISOString());
  const edit = (id: string, expected_version: number): Reply => ({ tool: 'memory_update', id,
    args: { memory_id: memoryId, expected_version, text: privateText } });
  ctx.elapsed();
  ctx.replies.push(draw(1),
    { tool: 'memory_hold', id: 'new-memory', args: {
      original_title: '合成写入', text: privateText, categories: ['daily'], creation_mode: 'contemporaneous',
    } },
    { tool: 'tool_define', id: 'define-edit', args: { name: 'memory_update' } },
    edit('edit-memory', 1), edit('stale-edit', 1), edit('uncertain-edit', 2), noop());
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.state, 'noop', run.result_code);
  assert.deepEqual(attemptedVersions, [1, 1, 2]);

  const receipts = new Map(ctx.wire.at(-1)!.messages.filter(message => message.role === 'tool')
    .map(message => [message.tool_call_id, JSON.parse(text(message))]));
  assert.equal(receipts.get('new-memory')?.memory_id, memoryId);
  assert.equal(receipts.get('new-memory')?.version, 1);
  assert.equal(receipts.get('edit-memory')?.memory_id, memoryId);
  assert.equal(receipts.get('edit-memory')?.version, 2);
  assert.equal(receipts.get('stale-edit')?.error_code, 'UPDATE_VERSION_CONFLICT');
  assert.equal(receipts.get('uncertain-edit')?.error_code, 'UPDATE_OUTCOME_UNKNOWN');

  const outbox = db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get();
  assert.ok(outbox);
  assert.equal(String(outbox.payload_ref).includes(privateText), false);
  const projection = readHeartbeatProjection(JSON.parse(String(outbox.payload_ref)));
  assert.ok(projection);
  assert.deepEqual(projection.actions?.filter(action => action.kind === 'memory_hold' || action.kind === 'memory_update')
    .map(action => [action.kind, action.status, action.source?.id, action.source?.revision]), [
    ['memory_hold', 'committed', memoryId, 1],
    ['memory_update', 'committed', memoryId, 2],
    ['memory_update', 'failed', memoryId, undefined],
    ['memory_update', 'unknown', memoryId, undefined],
  ]);
  const feed = await decorateMomentResponse(new URL('http://est.test/api/v1/content/posts?include_references=1'),
    { items: [{ id: 'heartbeat-test', kind: 'reference', revision: 1, reference: projection }] },
    { db, messages, heartbeat }) as { items: Array<{ blocks: Array<{ source_label: string; text: string }> }> };
  assert.deepEqual(feed.items[0]?.blocks.filter(block => ['写记忆', '修订记忆'].includes(block.source_label)).map(block => block.text),
    ['修订记忆 · 已完成。']);
});

test('silent heartbeat projects four committed domain actions and omits anchor read and replay', async t => {
  const root = tempRoot('heartbeat-domain-actions-');
  const privateText = '合成私有正文';
  const requestedAt = '2026-11-22T02:00:00Z';
  const starCalls = t.mock.method(WishstarClient.prototype, 'forward', async (method: string, path: string) => {
    assert.equal(method, 'POST');
    assert.equal(path, '/api/requests');
    return { status: 200, body: { id: 'req-fixture', requester_id: 'jiaming', owner_id: 'qiaosheng', status: 'pending', requested_at: requestedAt } };
  });
  const ctx = await fixture(t, CARDS, 'available', 0, { root, maxModelRequests: 8, wishstar: true });
  const { db, identity, messages, heartbeat } = ctx.host;
  const manifestPath = identity.manifestPath();
  const { manifest } = identity.loadManifest();
  const anchorFile = 'memory-anchors-v1.md';
  fs.writeFileSync(path.join(root, 'identity', anchorFile), '既有合成锚点');
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, memory_anchors_ref: anchorFile, memory_anchors_hash: sha256Hex('既有合成锚点') }));
  makeFixtureToolsResident(db, ['heartbeat_draw', 'background_complete', 'identity_milestone_write', 'plans_write', 'memory_i_write']);
  await ctx.chat('建立现有聊天窗');

  const remote = (heartbeat!.sources as unknown as { external: { memory: { transport: MariposaTransport } } }).external.memory;
  remote.transport = async (name, args) => {
    assert.equal(args.content, privateText);
    assert.ok(args.operation_id);
    if (name === 'plan.create') return { ok: true, result: { plan_id: 'plan-fixture', version: 1, state: 'planned' } };
    assert.equal(name, 'i.item.create');
    return { ok: true, result: { item_id: 'i-fixture', revision: 1 } };
  };
  const prices = Object.fromEntries(['plans_write', 'memory_i_write', 'wishstar_request_star'].map(name => [name, { max_cost_micro_usd: 1 }]));
  db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('background_tool_prices',?,?)")
    .run(JSON.stringify(prices), new Date().toISOString());
  const anchor = { operation: 'add', text: privateText, change_reason: '合成记录', idempotency_key: 'fixture-anchor' };
  ctx.elapsed();
  ctx.replies.push(draw(1),
    { tool: 'identity_milestone_write', id: 'anchor-read', args: { operation: 'read' } },
    { tool: 'identity_milestone_write', id: 'anchor-write', args: anchor },
    { tool: 'identity_milestone_write', id: 'anchor-replay', args: anchor },
    { tool: 'plans_write', id: 'plan-write', args: { action: 'create', title: '合成计划', text: privateText } },
    { tool: 'memory_i_write', id: 'i-write', args: { action: 'create', text: privateText } },
    { tool: 'wishstar_request_star', id: 'star-request', args: {} }, noop());
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.state, 'noop', run.result_code);
  assert.equal(starCalls.mock.callCount(), 1);
  assert.equal(identity.readMilestone().version, 'memory-anchors-v2');
  const outbox = db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get();
  const payload = String(outbox?.payload_ref);
  assert.equal(payload.includes(privateText), false);
  const projection = readHeartbeatProjection(JSON.parse(payload));
  assert.ok(projection);
  assert.deepEqual(projection.actions?.map(action => [action.kind, action.status, action.source?.namespace, action.source?.id, action.source?.revision]), [
    ['selection', 'committed', undefined, undefined, undefined],
    ['anchor_write', 'committed', 'host:identity', 'memory-anchors', 'memory-anchors-v2'],
    ['plan_write', 'committed', 'mariposa:plan', 'plan-fixture', 1],
    ['i_write', 'committed', 'mariposa:i_item', 'i-fixture', 1],
    ['star_request', 'committed', 'superposition:request', 'req-fixture', requestedAt],
  ]);
  const feed = await decorateMomentResponse(new URL('http://est.test/api/v1/content/posts?include_references=1'),
    { items: [{ id: 'heartbeat-test', kind: 'reference', revision: 1, reference: projection }] },
    { db, messages, heartbeat }) as { items: Array<{ blocks: Array<{ source_label: string; text: string }> }> };
  assert.deepEqual(feed.items[0]?.blocks.filter(block => block.text.endsWith(' · 已完成。')).map(block => block.source_label),
    ['更新我们的锚点', '写计划', '更新 I', '请求对方开星']);
});

test('silent heartbeat projects star and relation writes by their source receipts and keeps reads, replays and failures apart', async t => {
  const respondedAt = '2026-11-23T02:00:01Z', openedAt = '2026-11-23T02:00:02Z', offeredAt = '2026-11-23T02:00:03Z';
  const opened = { id: 'star-opened', content: '合成递来的星正文', visibility: 'hidden', state: 'SHARED', opened_at: openedAt, opened_by: 'jiaming' };
  let accepted = 0;
  t.mock.method(WishstarClient.prototype, 'forward', async (method: string, path: string) => {
    if (path === '/api/requests/req-incoming/respond') return { status: 200, body: { request: {
      id: 'req-incoming', requester_id: 'qiaosheng', owner_id: 'jiaming', status: 'rejected', responded_at: respondedAt }, note: '现在先不给' } };
    if (path === '/api/offers') return { status: 201, body: { id: 'off-outgoing', star_id: 'star-own', sender_id: 'jiaming',
      recipient_id: 'qiaosheng', status: 'offered', offered_at: offeredAt } };
    if (path === '/api/offers/off-odd/accept') return { status: 200, body: { ...opened, id: 'star-odd', opened_by: 'qiaosheng' } };
    if (++accepted > 1) return { status: 409, body: { detail: '这颗星星已经被接住了' } };
    return { status: 200, body: opened };
  });
  const ctx = await fixture(t, CARDS, 'available', 0, { maxModelRequests: 11, wishstar: true });
  const { db, messages, heartbeat } = ctx.host;
  makeFixtureToolsResident(db, ['heartbeat_draw', 'background_complete', 'wishstar_respond_request', 'wishstar_offer_star', 'wishstar_accept_offer',
    'memory_relations', 'memory_correct']);
  await ctx.chat('建立现有聊天窗');
  let linked = 0, correctionOperation = '';
  const remote = (heartbeat!.sources as unknown as { external: { memory: { transport: MariposaTransport } } }).external.memory;
  remote.transport = async (name, args) => {
    if (name === 'memory.relations.link') return { ok: true, result: { relation_id: 'rel-fixture', from: args.from_memory, to: args.to_memory,
      relation_type: args.relation_type, ...(linked++ ? { deduplicated: true } : {}) } };
    if (name === 'memory.relations.list') return { ok: true, result: { relations: [] } };
    assert.equal(name, 'memory.relations.correct');
    correctionOperation = String(args.operation_id);
    return { ok: true, result: { correction_id: 'cor-fixture', removed_relation_id: args.relation_id, replacement_relation_id: null, action: 'remove_wrong_binding' } };
  };
  db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('background_tool_prices',?,?)")
    .run(JSON.stringify(Object.fromEntries(['wishstar_respond_request', 'wishstar_offer_star', 'wishstar_accept_offer', 'memory_correct']
      .map(name => [name, { max_cost_micro_usd: 1 }]))), new Date().toISOString());
  const link = { action: 'link', from_memory: 'mem-a', to_memory: 'mem-b', relation_type: 'related_to' };
  ctx.elapsed();
  ctx.replies.push(
    { tool: 'wishstar_respond_request', id: 'respond', args: { request_id: 'req-incoming', decision: 'not_now' } },
    { tool: 'wishstar_accept_offer', id: 'accept', args: { offer_id: 'off-incoming' } },
    { tool: 'wishstar_offer_star', id: 'offer', args: { star_id: 'star-own' } },
    { tool: 'memory_relations', id: 'link', args: link },
    { tool: 'memory_relations', id: 'link-again', args: link },
    { tool: 'memory_relations', id: 'list', args: { action: 'list', memory_id: 'mem-a' } },
    { tool: 'memory_correct', id: 'correct', args: { action: 'relation', relation_id: 'rel-fixture', correction_action: 'remove_wrong_binding' } },
    { tool: 'wishstar_accept_offer', id: 'accept-again', args: { offer_id: 'off-incoming' } },
    { tool: 'wishstar_accept_offer', id: 'accept-odd', args: { offer_id: 'off-odd' } },
    noop());
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.state, 'noop', run.result_code);
  assert.equal(accepted, 2);
  const payload = String(db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get()?.payload_ref);
  assert.equal(payload.includes(opened.content), false);
  const projection = readHeartbeatProjection(JSON.parse(payload));
  assert.ok(projection);
  assert.equal(projection.state, 'declined', 'no card and no speech keep the decline');
  assert.match(correctionOperation, /^es-cor-/);
  assert.deepEqual(projection.actions?.map(action => [action.kind, action.status, action.operationId,
    action.source?.namespace, action.source?.id, action.source?.revision, action.source?.parentId]), [
    ['star_respond', 'committed', 'superposition:request:req-incoming', 'superposition:request', 'req-incoming', respondedAt, undefined],
    ['star_accept', 'committed', 'superposition:offer:off-incoming', 'superposition:star', 'star-opened', openedAt, 'off-incoming'],
    ['star_offer', 'committed', 'superposition:offer:off-outgoing', 'superposition:offer', 'off-outgoing', offeredAt, 'star-own'],
    ['relation_link', 'committed', 'mariposa:relation:rel-fixture', 'mariposa:relation', 'rel-fixture', undefined, undefined],
    ['relation_correct', 'committed', correctionOperation, 'mariposa:relation', 'rel-fixture', 'cor-fixture', undefined],
    ['star_accept', 'failed', 'accept-again', undefined, undefined, undefined, undefined],
    ['star_accept', 'unknown', 'accept-odd', undefined, undefined, undefined, undefined],
  ]);
  // A deduplicated link names an existing relation and a list is a read: neither keeps a row.
  assert.deepEqual(db.prepare("SELECT json_extract(action_json,'$.kind') AS kind FROM heartbeat_actions WHERE run_id=? ORDER BY rowid")
    .all(run.id).map((row: { kind: string }) => row.kind),
    ['star_respond', 'star_accept', 'star_offer', 'relation_link', 'relation_correct', 'star_accept', 'star_accept']);
  const feed = await decorateMomentResponse(new URL('http://est.test/api/v1/content/posts?include_references=1'),
    { items: [{ id: 'heartbeat-test', kind: 'reference', revision: 1, reference: projection }] },
    { db, messages, heartbeat }) as { items: Array<{ blocks: Array<{ id: string; source_label: string; text: string }> }> };
  assert.deepEqual(feed.items[0]?.blocks.filter(block => block.id.startsWith('action:')).map(block => block.text), [
    '回应开星请求 · 已完成。', '收下递来的星 · 已完成。', '递一颗星 · 已完成。', '建立记忆关系 · 已完成。', '订正记忆关系 · 已完成。',
    '收下递来的星 · 未成功。', '收下递来的星 · 结果待核，暂不能确认成功。']);
});

const ACTION_CRASH_TEST = 'heartbeat: a committed memory action is projected on restart without replaying the model';
const ACTION_CRASH_CHILD = '--heartbeat-action-crash';
test(ACTION_CRASH_TEST, async t => {
  if (process.argv[2] === ACTION_CRASH_CHILD) {
    const root = process.argv[3]!;
    const ctx = await fixture(t, CARDS, 'available', 0, { root });
    await ctx.chat('建立现有聊天窗');
    const { db } = ctx.host;
    const remote = (ctx.host.heartbeat!.sources as unknown as { external: { memory: { transport: unknown } } }).external.memory;
    remote.transport = async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, 'memory.hold');
      return { ok: true, result: { operation_id: args.operation_id, memory_id: 'fixture-crash-memory', version: 1,
        binding_ids: [], committed_at: new Date().toISOString(), commit_observed_at: new Date().toISOString() } };
    };
    db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('background_tool_prices',?,?)")
      .run(JSON.stringify({ memory_hold: { max_cost_micro_usd: 1 } }), new Date().toISOString());
    ctx.elapsed();
    const exec = db.exec.bind(db);
    t.mock.method(db, 'exec', (sql: string) => {
      exec(sql);
      if (sql !== 'COMMIT') return;
      const fact = db.prepare(`SELECT run_id, action_json FROM heartbeat_actions
        WHERE json_extract(action_json,'$.kind')='memory_hold' AND json_extract(action_json,'$.status')='committed'`).get();
      if (!fact) return;
      assert.equal(ctx.projections().n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM tool_side_effects WHERE memory_id='fixture-crash-memory' AND state='committed' AND verified=1").get()?.n, 1);
      process.kill(process.pid, 'SIGKILL');
    });
    ctx.replies.push(draw(1), { tool: 'memory_hold', id: 'crash-hold', args: {
      original_title: '合成写入', text: '合成记忆，仅供隔离复验。', categories: ['daily'], creation_mode: 'contemporaneous',
    } });
    await ctx.scheduler.tick();
    assert.fail('fixture did not reach the committed action seam');
    return;
  }
  const root = tempRoot('heartbeat-action-crash-');
  let reopened = false;
  try {
    const child = spawnSync(process.execPath, [`--test-name-pattern=^${ACTION_CRASH_TEST}$`, import.meta.filename, ACTION_CRASH_CHILD, root], {
      env: { ...process.env, ESTOMAGO_HOME: root }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(child.signal, 'SIGKILL', child.stdout + child.stderr);
    const ctx = await fixture(t, CARDS, 'available', 0, { root, reopen: true });
    reopened = true;
    const server = (ctx.host as unknown as { server: { listen(port: number, bind: string, ready: () => void): void } }).server;
    t.mock.method(server, 'listen', (_port, _bind, ready) => ready());
    await ctx.host.start();
    assert.equal(ctx.wire.length, 0);
    const run = ctx.latestRun();
    assert.equal(run.state, 'unknown');
    assert.equal(ctx.cards.getDeliveredDraw(run.id)?.cardNumber, 1);
    const projection = JSON.parse(String(ctx.host.db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get()?.payload_ref));
    assert.equal(projection.terminal.status, 'unknown');
    assert.equal(projection.actions.find((action: { kind: string }) => action.kind === 'memory_hold').source.id, 'fixture-crash-memory');
    assert.deepEqual(ctx.runtimeMessages(run.id).map(message => message.speaker), ['system','system']);
    const retained = ctx.trajectory.forWindow(ctx.windowId())!;
    const confirmed = ctx.host.db.prepare("SELECT payload_json FROM provider_requests WHERE background_run_id=? AND sent_at IS NOT NULL ORDER BY sent_at DESC,rowid DESC LIMIT 1").get(run.id);
    const confirmedMessages = JSON.parse(String(confirmed?.payload_json)).messages;
    assert.deepEqual(retained.messages.slice(0,confirmedMessages.length),confirmedMessages);
    assert.deepEqual(retained.lastBoundary,tailBoundaryOf(confirmedMessages));
    const assertProtocol = (messages: Array<{role:string;content?:unknown;tool_call_id?:string;tool_calls?:Array<{id:string}>}>) => {
      assert.equal(messages.flatMap(m=>m.tool_calls??[]).filter(c=>c.id==='draw-1').length,1);
      const cards = messages.filter(m=>m.role==='tool'&&m.tool_call_id==='draw-1');
      assert.equal(cards.length,1); assert.match(JSON.stringify(cards[0]?.content),new RegExp(REVEAL));
      assert.equal(messages.flatMap(m=>m.tool_calls??[]).filter(c=>c.id==='crash-hold').length,1);
      const receipts = messages.filter(m=>m.role==='tool'&&m.tool_call_id==='crash-hold');
      assert.equal(receipts.length,1);
      assert.deepEqual(JSON.parse(String(receipts[0]?.content)),{saved:true,memory_id:'fixture-crash-memory',version:1,source_status:'unbound'});
    };
    assertProtocol(retained.messages as never);
    assert.ok(!confirmedMessages.some((m:{tool_call_id?:string})=>m.tool_call_id==='crash-hold'),'hold receipt is retained but was never sent before the interruption');
    ctx.host.supervisor.recoverAcceptedCompletions(ctx.scheduler.finishRecoveredCompletion.bind(ctx.scheduler));
    assert.deepEqual(ctx.trajectory.forWindow(ctx.windowId()),retained);
    ctx.host.heartbeat!.recoverClosedRuns();
    assert.equal(ctx.projections().n, 1);
    assert.equal(ctx.wire.length, 0);
    const wireBeforeNext = ctx.wire.length;
    await ctx.chat('恢复后自然聊天');
    assert.equal(ctx.wire.length,wireBeforeNext+1);
    assertProtocol(ctx.wire.at(-1)!.messages as never);
    assert.equal(ctx.host.db.prepare("SELECT count(*) n FROM tool_side_effects WHERE memory_id='fixture-crash-memory' AND state='committed' AND verified=1").get()?.n,1);
    assert.equal(ctx.cards.getDeliveredDraw(run.id)?.cardNumber,1);
  } finally {
    if (!reopened) fs.rmSync(root, { recursive: true, force: true });
  }
});

const DELIVERY_CRASH_TEST = 'heartbeat: recovery distinguishes the confirmed card prefix from an uncertain continuation';
const DELIVERY_CRASH_CHILD = '--heartbeat-delivery-crash';
test(DELIVERY_CRASH_TEST, async t => {
  if (process.argv[2] === DELIVERY_CRASH_CHILD) {
    const root = process.argv[3]!, seam = process.argv[4];
    const ctx = await fixture(t,CARDS,'available',0,{root});
    await ctx.chat('建立现有聊天窗');
    ctx.elapsed();
    if (seam === 'confirmed') {
      const runtime = ctx.host.heartbeat!;
      const observe = runtime.observeDelivery.bind(runtime);
      t.mock.method(runtime,'observeDelivery',(runId:string,requestId:string,messages:OrMessage[],hostText?:string)=>{
        if (messages.some(m=>m.role==='tool'&&m.tool_call_id==='draw-1'&&JSON.stringify(m.content).includes(REVEAL))) {
          assert.ok(ctx.host.db.prepare('SELECT sent_at FROM provider_requests WHERE id=?').get(requestId)?.sent_at);
          assert.equal(ctx.cards.getDraw({runId,operationId:'draw-1'})?.status,'dispatching');
          process.kill(process.pid,'SIGKILL');
        }
        observe(runId,requestId,messages,hostText);
      });
    }
    ctx.replies.push(draw(1), seam==='confirmed'?asMessage('合成未完成回复'):{crash:true});
    await ctx.scheduler.tick();
    assert.fail('fixture did not reach the selected transport seam');
    return;
  }
  for (const seam of ['confirmed','unknown']) await t.test(seam,async st=>{
    const root = tempRoot('heartbeat-delivery-crash-');
    let reopened = false;
    try {
      const child = spawnSync(process.execPath,[`--test-name-pattern=^${DELIVERY_CRASH_TEST}$`,import.meta.filename,DELIVERY_CRASH_CHILD,root,seam],
        {env:{...process.env,ESTOMAGO_HOME:root},encoding:'utf8',timeout:15000});
      assert.equal(child.signal,'SIGKILL',child.stdout+child.stderr);
      const ctx = await fixture(st,CARDS,'available',0,{root,reopen:true}); reopened=true;
      const server = (ctx.host as unknown as { server: { listen(port:number,bind:string,ready:()=>void):void } }).server;
      st.mock.method(server,'listen',(_port,_bind,ready)=>ready());
      await ctx.host.start();
      assert.equal(ctx.wire.length,0);
      const run=ctx.latestRun();
      const delivered = seam==='confirmed';
      assert.equal(ctx.cards.getDraw({runId:run.id,operationId:'draw-1'})?.status,delivered?'delivered':'unknown');
      const assertHistory=(messages:Array<{role:string;tool_call_id?:string;content?:unknown;tool_calls?:Array<{id:string}>}>)=>{
        assert.equal(messages.flatMap(m=>m.tool_calls??[]).filter(c=>c.id==='draw-1').length,1);
        const receipt=messages.filter(m=>m.role==='tool'&&m.tool_call_id==='draw-1');
        assert.equal(receipt.length,1);
        assert.equal(JSON.stringify(receipt[0]?.content).includes(REVEAL),delivered);
        if(!delivered)assert.equal(JSON.parse(String(receipt[0]?.content)).delivery,'unknown');
      };
      const retained=ctx.trajectory.forWindow(ctx.windowId())!;
      assertHistory(retained.messages as never);
      const latest=ctx.host.db.prepare("SELECT payload_json FROM provider_requests WHERE background_run_id=? AND sent_at IS NOT NULL ORDER BY sent_at DESC,rowid DESC LIMIT 1").get(run.id);
      const sent=JSON.parse(String(latest?.payload_json)).messages;
      assert.deepEqual(retained.messages.slice(0,sent.length),sent);
      assert.equal(ctx.projections().n,1);
      const p=JSON.parse(String(ctx.host.db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get()?.payload_ref));
      assert.equal(p.card?.number??null,delivered?1:null);
      await ctx.chat('恢复后自然输入');
      assert.equal(ctx.wire.length,1);
      assertHistory(ctx.wire[0]!.messages as never);
    } finally{if(!reopened)fs.rmSync(root,{recursive:true,force:true});}
  });
});

test('T26: an edited-away fixed revision invalidates the original number without prompting for 1', async t => {
  const ctx = await fixture(t, CARDS, 'revision_unavailable');
  await ctx.chat('建立现有聊天窗');
  ctx.seedNineCards();
  ctx.elapsed();
  ctx.replies.push(draw(1));
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.mode, 'draw');
  assert.equal(ctx.wire.length, 2, 'none of the remaining numbers is selectable');
  assert.doesNotMatch(text(ctx.wire[1]!.messages.findLast(message => message.role === 'user')), /请回复 1/);
  assert.deepEqual(ctx.cards.getDeck('primary', ctx.date)?.availableNumbers, []);
  assert.equal(ctx.cards.getDeck('primary', ctx.date)?.exhausted, false);
  assert.equal(ctx.cards.getDraw({ runId: run.id, operationId: 'draw-1' })?.status, 'rejected');
});

test('T48: tool-only rejection closes with no additional request and its once-retained receipt reaches the next chat', async t => {
  const ctx = await fixture(t);
  await ctx.chat('建立现有聊天窗');
  ctx.elapsed();
  ctx.replies.push(noop());
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.mode, 'draw');
  assert.equal(ctx.wire.length, 2);
  assert.equal(run.result_code, 'complete:noop');
  assert.equal(ctx.runtimeMessages(run.id).some(message => message.speaker === 'assistant'), false);
  assert.ok(ctx.runtimeMessages(run.id).some(message => message.content === '[心跳唤醒] 本轮未抽卡'));
  assert.equal(ctx.cards.getDeck('primary', ctx.date)?.deliveredNumbers.length, 0);
  const trajectory = ctx.trajectory.forWindow(ctx.windowId())!;
  assert.equal(trajectory.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'decline-no-text').length, 1);
  assert.equal(ctx.wire[1]!.messages.some(message => message.role === 'tool' && message.tool_call_id === 'decline-no-text'), false);

  await ctx.chat('下一条自然输入');
  const next = ctx.wire[2]!.messages;
  const receipts = next.filter(message => message.role === 'tool' && message.tool_call_id === 'decline-no-text');
  assert.equal(receipts.length, 1);
  assert.deepEqual(JSON.parse(text(receipts[0])), { completed: true, outcome: 'noop' });
  assert.equal(next.filter(message => message.role === 'user' && text(message).includes('[心跳唤醒]')).length, 1);
  assert.equal(next.some(message => message.role === 'assistant' && text(message) === '1'), false);
});

test('the invitation is short, carries the clock of this run and only the numbers still available', async t => {
  const ctx = await fixture(t);
  await ctx.chat('建立聊天窗');
  const shanghaiMinute = (date: Date) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };
  const invite = async () => {
    ctx.elapsed();
    const openedAt = new Date();
    ctx.replies.push(noop());
    await ctx.scheduler.tick();
    const prompt = text(ctx.wire.at(-1)?.messages.findLast(message => message.role === 'user'));
    const minutes = [shanghaiMinute(openedAt), shanghaiMinute(new Date())];
    assert.ok(minutes.some(minute => prompt.startsWith(`[心跳唤醒] ${minute}`)), `clock is read when the run is prepared: ${prompt.slice(0, 40)}`);
    return prompt;
  };
  const first = await invite();
  ctx.seedNineCards();
  const second = await invite();
  for (const prompt of [first, second]) {
    // Speaking, drawing and ending quietly are parallel choices; the rule
    // text about the fixed deck and the per-turn limit is no longer repeated.
    // Whatever the frozen window appends (task definition) follows the host event.
    assert.match(prompt, /^\[心跳唤醒\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} \w{3} UTC\+8\n醒了。可以直接找乔乔说话，也可以先抽一张，再决定要不要找她；也可以安静结束。\n可抽号码：[\d、]+。\n这一轮的聊天正文会直接发给乔乔。(?:\n\[tools\/task:[^\n]+\])?$/);
    assert.doesNotMatch(prompt, /还是抽|这轮不抽卡|先查看工具定义|当天固定同一副|最多抽一张|user_gap|\[time_context\]/);
  }
  assert.match(first, /\n可抽号码：1、2、3、4、5、6、7、8、9、10。\n/);
  assert.match(second, /\n可抽号码：1。\n/);

  // A dispatched invitation is history: the next ordinary request carries it
  // once, unchanged, and the frozen system prefix is not rebuilt for the clock.
  const systemBefore = JSON.stringify(ctx.wire.at(-1)?.messages.filter(message => message.role === 'system'));
  await ctx.chat('下一条自然输入');
  const next = ctx.wire.at(-1)!.messages;
  assert.equal(JSON.stringify(next.filter(message => message.role === 'system')), systemBefore);
  assert.equal(next.filter(message => message.role === 'user' && text(message).startsWith(first)).length, 1);
});

test('T18: invalid number types receive two real corrections through the frozen integer tool', async t => {
  const ctx = await fixture(t);
  await ctx.chat('建立现有聊天窗');
  ctx.elapsed();
  for (const [id, value] of [['fraction', 1.5], ['string', '1'], ['boolean', false]] as const) {
    ctx.replies.push({ tool: 'heartbeat_draw', id, args: { card_number: value } });
  }
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.mode, 'draw');
  assert.equal(run.result_code, 'HEARTBEAT_CORRECTIONS_EXHAUSTED');
  assert.equal(ctx.wire.length, 4);
  const spec = (ctx.wire[1]!.tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>)
    .find(tool => tool.function.name === 'heartbeat_draw')!;
  assert.deepEqual(spec.function.parameters.properties.card_number, { type: 'integer' });
  for (const [index, id] of [[2, 'fraction'], [3, 'string']] as const) {
    const response = ctx.wire[index]!.messages.find(message => message.tool_call_id === id);
    assert.deepEqual(JSON.parse(text(response)), {
      error_code: 'INVALID_NUMBER', remaining_numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], retry_allowed: true,
    });
  }
  assert.equal(ctx.cards.getDeliveredDraw(run.id), null);
  assert.equal(ctx.cards.getDeck('primary', ctx.date)?.exhausted, false);
  assert.deepEqual(ctx.cards.getDraw({ runId: run.id, operationId: 'boolean' }), {
    status: 'rejected', reason: 'corrections_exhausted', remainingNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], retryAllowed: false,
  });
});

test('R13: a second choice in the same live turn returns first-card metadata without another reveal', async t => {
  const ctx = await fixture(t);
  await ctx.chat('建立现有聊天窗');
  ctx.elapsed();
  ctx.replies.push(draw(1), draw(2), asMessage('我已经读过第一张了。'));
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.mode, 'draw');
  assert.deepEqual(ctx.cards.getDeck('primary', ctx.date)?.deliveredNumbers, [1]);
  assert.equal(ctx.wire.length, 4);
  const receipts = ctx.wire[3]!.messages.filter(message => message.role === 'tool');
  const second = receipts.find(message => message.tool_call_id === 'draw-2');
  assert.deepEqual(JSON.parse(text(second)), {
    error_code: 'HEARTBEAT_DRAW_ALREADY_STARTED',
    heartbeat_draw_receipt: { operation_id: 'draw-1', card_number: 1, delivery_state: 'delivered' },
  });
  assert.equal(receipts.filter(message => text(message).includes(REVEAL)).length, 1);
  assert.equal(receipts.filter(message => 'heartbeat_card' in JSON.parse(text(message))).length, 1);
  assert.equal(ctx.projections().n, 1);
});

test('T-A04/T-A05/T-A07 (v2.1): 21:00 正常夜休保次晨 08:00 兜底并续跑 50 分钟循环，09:00 补觉等用户下条普通消息', async t => {
  // Part 1: 21:00 正常夜休（morning_0800）
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T21:00:00+08:00') });
  const ctx = await fixture(t);
  const activity = new ConversationActivityService(ctx.host.db);
  const heartbeats = () => (ctx.host.db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind='keepwarm' AND task_id!='fixture-history'").get() as { n: number }).n;
  const wake = async (): Promise<void> => { ctx.elapsed(); ctx.replies.push(asMessage('合成回复')); await ctx.scheduler.tick(); };
  await ctx.chat('建立当前会话');
  // 反例：引用、讨论功能、否定、继续聊天——都不是休息，心跳照常唤醒。
  for (const line of ['昨天你说了晚安', '晚安这个功能怎么改', '我还不睡，先聊一会', '为什么说晚安还会叫醒', '“晚安”']) {
    await ctx.chat(line);
    const before = heartbeats();
    await wake();
    assert.equal(heartbeats(), before + 1, line);
    assert.equal(activity.resting('primary'), false, line);
  }
  // 21:00 明确晚安：进入正常夜休，保留次晨 08:00 有条件兜底。
  await ctx.chat('晚安，我睡了');
  const state = activity.restState('primary');
  assert.equal(state.resting, true);
  assert.equal(state.source, 'owner_message');
  assert.equal(state.recovery_mode, 'morning_0800');
  const requests = ctx.wire.length;
  const runs = heartbeats();
  for (let tick = 0; tick < 3; tick++) await wake();
  assert.equal(ctx.wire.length, requests, '夜休期间多个 tick 都不再唤醒，也不发模型请求');
  assert.equal(heartbeats(), runs);
  assert.equal(
    (ctx.host.db.prepare("SELECT next_due_at FROM background_tasks WHERE kind='keepwarm'").get() as { next_due_at: string | null }).next_due_at,
    new Date('2026-11-25T08:00:00+08:00').toISOString(),
  );
  // 睡前不久补一句（间隔 < 4h）保持夜间暂停；新消息再道晚安按 R1 覆盖原决定时间。
  t.mock.timers.setTime(Date.parse('2026-11-24T21:05:00+08:00'));
  await ctx.chat('爱你');
  await wake();
  assert.equal(activity.resting('primary'), true);
  t.mock.timers.setTime(Date.parse('2026-11-24T21:06:00+08:00'));
  await ctx.chat('晚安');
  await wake();
  assert.equal(ctx.wire.length, requests + 2, '只有普通聊天的请求，没有心跳请求');
  assert.equal(activity.resting('primary'), true);
  assert.notEqual(activity.restState('primary').decided_at, state.decided_at, 'R1：新消息的休息决定覆盖原决定时间');
  // 隔日 07:59:59 仍不发，08:00:00 正常触发晨间兜底（第 1 次），之后按 50 分钟继续（08:50 第 2 次）。
  t.mock.timers.setTime(Date.parse('2026-11-25T07:59:59+08:00'));
  await ctx.scheduler.tick();
  assert.equal(ctx.wire.length, requests + 2);
  t.mock.timers.setTime(Date.parse('2026-11-25T08:00:00+08:00'));
  ctx.replies.push(asMessage('晨间合成回复'));
  await ctx.scheduler.tick();
  assert.equal(ctx.wire.length, requests + 3);
  assert.equal(heartbeats(), runs + 1);
  const morningInput = text(ctx.wire.at(-1)!.messages.findLast(message => message.role === 'user'));
  assert.match(morningInput, /2026-11-25 08:00/);
  assert.match(morningInput, /晨间活动机会/);
  assert.equal(activity.resting('primary'), false, '08:00 有效晨间机会解除到期的正常夜休');
  // v2.1：08:50 合法进入第二轮 50 分钟心跳。
  t.mock.timers.setTime(Date.parse('2026-11-25T08:50:00+08:00'));
  ctx.replies.push(asMessage('第二轮合成回复'));
  await ctx.scheduler.tick();
  assert.equal(ctx.wire.length, requests + 4, 'v2.1：08:50 正常启动第二轮自动心跳');
  assert.equal(heartbeats(), runs + 2);
  const regularInput = text(ctx.wire.at(-1)!.messages.findLast(message => message.role === 'user'));
  assert.match(regularInput, /^\[心跳唤醒\] 2026-11-25 08:50 \w{3} UTC\+8\n/);
  assert.doesNotMatch(regularInput, /晨间活动机会/);
  // Part 2: 09:00 白天补觉（next_user_message）：不预告 08:00，跨日仍等待用户，普通新消息即可恢复。
  t.mock.timers.setTime(Date.parse('2026-11-25T09:00:00+08:00'));
  await ctx.chat('晚安，我睡了');
  assert.equal(activity.restState('primary').recovery_mode, 'next_user_message');
  assert.equal((ctx.host.db.prepare("SELECT next_due_at FROM background_tasks WHERE kind='keepwarm'").get() as { next_due_at: string | null }).next_due_at, null);
  t.mock.timers.setTime(Date.parse('2026-11-26T08:00:00+08:00'));
  await ctx.scheduler.tick();
  assert.equal(heartbeats(), runs + 2, '补觉跨到次日 08:00 也不启动');
  t.mock.timers.setTime(Date.parse('2026-11-26T09:00:00+08:00'));
  await ctx.chat('起来啦，吃点什么');
  assert.equal(activity.resting('primary'), false, 'v2.1：白天普通新消息直接恢复，无需特地说早安');
});

test('T-A06: 休息跨重启保留；晚安前已排队的心跳在执行时读到新决定；手动恢复只领取一次，不动总开关', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T21:30:00+08:00') });
  const root = tempRoot('heartbeat-rest-restart-');
  const first = await fixture(t, CARDS, 'available', 0, { root });
  const activityOf = () => new ConversationActivityService(first.host.db);
  await first.chat('建立当前会话');
  first.elapsed();
  // 心跳已到期并被领取，但在会话串行链里排在一个未结束的步骤后面；这时她说了晚安。
  let release!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const blocked = first.host.supervisor.enqueueBackground('primary', () => new Promise<void>(resolve => { markEntered(); release = resolve; }));
  await entered;
  const ticking = first.scheduler.tick();
  await new Promise(resolve => setTimeout(resolve, 30));
  const queued = first.host.db.prepare("SELECT id FROM background_runs WHERE kind='keepwarm' AND state IN ('claimed','running') ORDER BY rowid DESC LIMIT 1").get() as { id: string };
  const { scheduler } = first.host;
  scheduler.notePendingUserChat();
  first.host.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '晚安，我睡了', clientMessageId: 'goodnight-while-queued' });
  assert.equal(activityOf().resting('primary'), true, '消息一被正式接受，休息即成立');
  const requests = first.wire.length;
  release();
  await blocked;
  await ticking;
  const oldRun = first.host.db.prepare('SELECT state,result_code FROM background_runs WHERE id=?').get(queued.id) as { state: string; result_code: string };
  assert.deepEqual({ ...oldRun }, { state: 'noop', result_code: 'KEEPWARM_RESTING' }, '已读旧状态的任务不能在晚安后继续');
  assert.equal(first.wire.length, requests, '排队的那次心跳零模型请求');
  await first.chat('睡前再说一句');
  assert.equal(activityOf().resting('primary'), true);

  // 重启：状态、总开关与排程都原样保留，恢复不靠回放旧消息。
  const settingsBefore = first.host.db.prepare("SELECT enabled FROM background_tasks WHERE kind='keepwarm'").get();
  // The fixture's own cleanup stops this host again at the end of the test.
  const stopOnce = first.host.stop.bind(first.host);
  let stopped = false;
  t.mock.method(first.host, 'stop', async () => { if (!stopped) { stopped = true; await stopOnce(); } });
  await first.host.stop();
  const reopened = await fixture(t, CARDS, 'available', 0, { root, reopen: true });
  const server = (reopened.host as unknown as { server: { listen(port: number, bind: string, ready: () => void): void } }).server;
  t.mock.method(server, 'listen', (_port, _bind, ready) => ready());
  await reopened.host.start();
  assert.equal(new ConversationActivityService(reopened.host.db).resting('primary'), true);
  assert.deepEqual(reopened.host.db.prepare("SELECT enabled FROM background_tasks WHERE kind='keepwarm'").get(), settingsBefore);
  reopened.elapsed();
  reopened.replies.push(asMessage('合成回复'));
  await reopened.scheduler.tick();
  assert.equal(reopened.wire.length, 0, '重启后的第一个 tick 不唤醒');

  const resumed = new ConversationActivityService(reopened.host.db).resumeRest('primary', { actorId: 'qiaosheng', operationId: 'ui-resume' });
  assert.equal(resumed.changed, true);
  assert.equal(resumed.source, 'control');
  await reopened.chat('继续聊');
  reopened.elapsed();
  reopened.replies.push(asMessage('合成回复'));
  await reopened.scheduler.tick();
  assert.equal(reopened.wire.length, 2, '恢复后是一次普通聊天和一次正常心跳');
  assert.equal(new BackgroundSettingsService(reopened.host.db, reopened.host.config).effective().keepwarm.enabled, true, '总开关保持原样');
});

type LayeredFeed = { items: Array<{ blocks: Array<{ id: string; layer: string; source_label: string; text?: string; outcome?: string }> }> };
async function layers(ctx: Awaited<ReturnType<typeof fixture>>, projectionSource: { payload_ref: string } | undefined, messages = ctx.host.messages) {
  const projection = readHeartbeatProjection(JSON.parse(String(projectionSource?.payload_ref)));
  assert.ok(projection);
  const feed = await decorateMomentResponse(new URL('http://est.test/api/v1/content/posts?include_references=1'),
    { items: [{ id: 'heartbeat-test', kind: 'reference', revision: 1, reference: projection }] },
    { db: ctx.host.db, messages, heartbeat: ctx.host.heartbeat }) as LayeredFeed;
  const blocks = feed.items[0]!.blocks;
  return { main: blocks.filter(block => block.layer === 'main'), detail: blocks.filter(block => block.layer === 'detail') };
}
const projectionOf = (ctx: Awaited<ReturnType<typeof fixture>>) => ctx.host.db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection' ORDER BY rowid DESC LIMIT 1").get() as { payload_ref: string } | undefined;

test('T-C04: 朋友圈主体是卡面和同轮真实发出的话，按正式消息顺序；邀请、揭牌、选号和结束状态收进详情', async t => {
  const ctx = await fixture(t);
  makeFixtureToolsResident(ctx.host.db, ['heartbeat_draw', 'background_complete', 'chat_send_text']);
  await ctx.chat('建立当前会话');
  ctx.elapsed();
  const speech = ['先看这张。', '回应卡面的话', '最后再说一句。'];
  ctx.replies.push(
    draw(3),
    { tool: 'tool_define', id: 'define-chat', args: { name: 'chat_send_text' }, speech: speech[0] },
    { tool: 'chat_send_text', id: 'send-card-reply', args: { text: speech[1]!, idempotency_key: 'card-reply' } },
    asMessage(speech[2]!),
  );
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(ctx.cards.getDeliveredDraw(run.id)?.cardNumber, 3);
  const { main, detail } = await layers(ctx, projectionOf(ctx));
  const published = (ctx.host.db.prepare("SELECT id FROM messages WHERE turn_id=? AND speaker='assistant' ORDER BY sequence").all(run.turn_id) as Array<{ id: string }>).map(row => row.id);
  assert.equal(published.length, 3);
  assert.deepEqual(main.map(block => [block.id, block.source_label, block.text ?? null]), [
    ['card', '3 号 · 日常', `${REVEAL}/fixture-3`],
    ...speech.map((line, index) => [`message:${published[index]}`, '本轮聊天', line]),
  ]);
  // Nothing after the first reply is cut off: three separately published messages are all attached.
  // Details keep the real order: invitation, the choice, the reveal notice, then the end state.
  assert.deepEqual(detail.map(block => block.source_label), ['心跳状态', '选号', '心跳状态', '结束状态']);
  assert.equal(detail.find(block => block.id.startsWith('action:'))?.outcome, 'committed');
  assert.equal(ctx.host.db.prepare("SELECT count(*) n FROM messages WHERE turn_id=? AND speaker='assistant'").get(run.turn_id)?.n, 3);
});

test('T-C04: 抽卡后安静结束只显示卡面和真实动作，不编造回复；拒抽和被拦的轮次没有主体', async t => {
  const ctx = await fixture(t);
  await ctx.chat('建立当前会话');
  const quiet = async (replies: Reply[]) => {
    ctx.elapsed();
    ctx.replies.push(...replies);
    await ctx.scheduler.tick();
    return layers(ctx, projectionOf(ctx));
  };
  const drawn = await quiet([draw(2), noop()]);
  assert.deepEqual(drawn.main.map(block => block.id), ['card']);
  assert.deepEqual(drawn.detail.map(block => [block.source_label, block.text ?? null]), [
    ['心跳状态', ctx.runtimeMessages(ctx.latestRun().id)[0]!.content], ['选号', '选择 2 号牌 · 已选中。'],
    ['心跳状态', '[心跳唤醒] 揭开了 2 号牌。'], ['结束状态', '本轮结束，没有另发聊天留言。'],
  ]);
  assert.equal(ctx.host.db.prepare("SELECT count(*) n FROM messages WHERE turn_id=? AND speaker='assistant'").get(ctx.latestRun().turn_id)?.n, 0);

  const declined = await quiet([noop()]);
  assert.deepEqual(declined.main, []);
  assert.deepEqual(declined.detail.map(block => block.source_label), ['心跳状态', '心跳状态', '结束状态'], '未抽卡：只有邀请、未抽卡提示和结束状态');

  // 早先版本的朋友圈记录没有动作明细：仍按卡面与真实回复展示，不补造动作。
  const older = await decorateMomentResponse(new URL('http://est.test/api/v1/content/posts?include_references=1'), { items: [{ id: 'older', kind: 'reference', revision: 1, reference: {
    mode: 'draw', conversationId: 'primary', businessDate: ctx.date, version: 1, state: 'drawn',
    card: { number: 5, source: { kind: 'moments', namespace: 'content', id: 'fixture-5', revision: 2, identity: 'content:moments:fixture-5', permissionScope: 'primary' } },
    messages: drawn.detail.filter(block => block.id.startsWith('message:')).map((block, index) => ({ messageId: block.id.slice('message:'.length), revision: 1, sequence: index + 1 })),
  } }] }, { db: ctx.host.db, messages: ctx.host.messages, heartbeat: ctx.host.heartbeat }) as LayeredFeed;
  assert.deepEqual(older.items[0]!.blocks.map(block => [block.layer, block.source_label]), [['main', '5 号 · 日常'], ['detail', '心跳状态'], ['detail', '心跳状态']]);
});

test('T-B02/T-D01: 抽卡之后在同一逻辑轮里继续发话、写记忆、再发一句都合法；同一动作重传只发一次，另一句不同的话不被吞', async t => {
  const ctx = await fixture(t, CARDS, 'available', 0, { maxModelRequests: 7 });
  makeFixtureToolsResident(ctx.host.db, ['heartbeat_draw', 'background_complete', 'chat_send_text']);
  await ctx.chat('建立当前会话');
  const { db, messages, heartbeat } = ctx.host;
  const memoryId = 'fixture-memory-after-draw';
  const privateText = '抽卡之后写下的合成记忆，仅供隔离复验。';
  let holds = 0;
  const remote = (heartbeat!.sources as unknown as { external: { memory: { transport: MariposaTransport } } }).external.memory;
  remote.transport = async (name, args) => {
    assert.equal(name, 'memory.hold');
    holds++;
    return { ok: true, result: { operation_id: args.operation_id, memory_id: memoryId, version: 1,
      binding_ids: [], committed_at: new Date().toISOString(), commit_observed_at: new Date().toISOString() } };
  };
  db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('background_tool_prices',?,?)")
    .run(JSON.stringify({ memory_hold: { max_cost_micro_usd: 1 } }), new Date().toISOString());
  ctx.elapsed();
  const first = '回应卡面的第一句。';
  const second = '随后另起的一句。';
  ctx.replies.push(
    draw(4),
    { tool: 'chat_send_text', id: 'send-first', args: { text: first, idempotency_key: 'say-first' } },
    // The same action retried under the same key and text: one message, not two.
    { tool: 'chat_send_text', id: 'send-first-retry', args: { text: first, idempotency_key: 'say-first' } },
    { tool: 'memory_hold', id: 'keep-after-draw', args: { original_title: '合成写入', text: privateText, categories: ['daily'], creation_mode: 'contemporaneous' } },
    { tool: 'chat_send_text', id: 'send-second', args: { text: second, idempotency_key: 'say-second' } },
    { tool: 'background_complete', id: 'finish', args: { outcome: 'done' } },
  );
  const revisionBefore = ctx.activity().activity_revision;
  await ctx.scheduler.tick();
  const run = ctx.latestRun();
  assert.equal(run.result_code, 'complete:done');
  assert.equal(ctx.cards.getDeliveredDraw(run.id)?.cardNumber, 4);
  assert.equal(holds, 1);
  // Everything after the first sentence still ran inside the same run: speaking
  // does not end the turn, nor does this run's own speech make it yield to itself.
  const published = (db.prepare("SELECT id FROM messages WHERE turn_id=? AND speaker='assistant' ORDER BY sequence").all(run.turn_id) as Array<{ id: string }>)
    .map(row => messages.getMessage(row.id)!);
  assert.deepEqual(published.map(message => message.revision.content), [first, second]);
  // Each call keeps its own receipt in the retained protocol of this single run.
  const receipts = (ctx.trajectory.forWindow(ctx.windowId())!.messages as OrMessage[]).filter(message => message.role === 'tool')
    .map(message => [message.tool_call_id, JSON.parse(text(message)) as Record<string, unknown>] as const);
  const receipt = (id: string) => receipts.find(([callId]) => callId === id)?.[1];
  assert.deepEqual(receipts.map(([callId]) => callId), ['draw-4', 'send-first', 'send-first-retry', 'keep-after-draw', 'send-second', 'finish']);
  assert.deepEqual(receipt('send-first'), { message_id: published[0]!.id, published: true });
  assert.deepEqual(receipt('send-first-retry'), { message_id: published[0]!.id, published: true }, '重传返回同一条消息的身份');
  assert.deepEqual(receipt('send-second'), { message_id: published[1]!.id, published: true });
  assert.equal(receipt('keep-after-draw')?.memory_id, memoryId);
  assert.deepEqual(receipt('finish'), { completed: true, outcome: 'done' });
  assert.equal(db.prepare("SELECT count(*) n FROM turns WHERE trigger='cache_keepalive'").get()?.n, 1, '一次心跳，没有第二轮');
  assert.equal(ctx.activity().activity_revision, revisionBefore + 2, '两句话各自是真实活动；抽卡和写记忆不是');
  const projection = readHeartbeatProjection(JSON.parse(String(db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get()?.payload_ref)));
  assert.equal(projection?.state, 'drawn');
  assert.deepEqual(projection?.actions?.map(action => [action.kind, action.status]), [['selection', 'committed'], ['memory_hold', 'committed']]);
  assert.equal(String(db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get()?.payload_ref).includes(privateText), false);
  void heartbeat;
});
