import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { ContentServer } from '../../apps/content/src/service.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import type { HeartbeatRuntime } from '../../apps/host/src/modules/heartbeat/runtime.ts';
import { lastCacheEvidence } from '../../apps/host/src/runtime/cache-observation.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';

const model = 'anthropic/claude-note-race-fixture';
const usage = { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.001 };
const drawId = 'fixture-note-draw';
const secret = '只可在实际派发门之后出现的合成预留话';

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}

for (const order of ['delete-before-gate', 'dispatch-before-delete-success', 'dispatch-before-delete-unknown'] as const) {
  test(`T44: real reserved-note deletion and delivery follow the authoritative gate order (${order})`, { timeout: 15000 }, async t => {
    assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
    const root = tempRoot('heartbeat-note-delete-race-');
    const content = new ContentServer({ stateRoot: path.join(root, 'content'), port: 0 });
    const entered = barrier();
    const proceed = barrier();
    let host: Host | undefined;
    t.after(async () => {
      proceed.release();
      await host?.stop();
      await content.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await content.start();
    writeApprovedIdentity(root);

    const wire: OrMessage[][] = [];
    let targetId = '';
    let number = 0;
    const transport = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 },
      async payload => {
        const messages = payload.messages as OrMessage[];
        wire.push(messages);
        const currentUser = messages.findLast(message => message.role === 'user');
        const heartbeat = JSON.stringify(currentUser).includes('[心跳唤醒]');
        const reveal = messages.some(message => message.role === 'tool' && message.tool_call_id === drawId);
        let delta: Record<string, unknown> = { content: '合成正常回复' };
        if (heartbeat && !reveal) {
          const card = host!.db.prepare("SELECT card_number FROM heartbeat_cards WHERE source_kind='reserved_note' AND source_identity=?")
            .get('content:reserved_note:' + targetId) as { card_number: number } | undefined;
          assert.ok(card, 'the note was selected through real Content candidate enumeration');
          number = card.card_number;
          delta = { tool_calls: [{ index: 0, id: drawId, type: 'function',
            function: { name: 'heartbeat_draw', arguments: JSON.stringify({ card_number: number }) } }] };
        }
        if (heartbeat && reveal) {
          assert.notEqual(order, 'delete-before-gate', 'a prior source tombstone must stop transport');
          assert.match(JSON.stringify(messages), new RegExp(secret));
          assert.equal(host!.db.prepare('SELECT state FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId)?.state, 'dispatching');
          entered.release();
          await proceed.reached;
          if (order === 'dispatch-before-delete-unknown') throw Object.assign(new Error('synthetic connection lost after dispatch'), { code: 'ECONNRESET' });
          delta = { content: '确实收到留下的话' };
        }
        return { status: 200, headers: new Headers(), body: Readable.from([
          `data: ${JSON.stringify({ id: `request-${wire.length}`, choices: [{ delta }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: heartbeat && !reveal ? 'tool_calls' : 'stop' }], usage })}\n\n`,
          'data: [DONE]\n\n',
        ]) };
      });
    const ready = readyRuntimePatch();
    const config = buildConfig({
      ...ready, runtime: { ...ready.runtime as object, provider: 'mock', tool_schema_mode: 'direct' },
      openrouter: { model }, content: { enabled: true, port: content.port },
      background: { keepwarm: { sleep_window: { enabled: false } } },
    });
    host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0, runnerOverride: transport });
    await host.start();
    const base = `http://127.0.0.1:${host.port}`;
    const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
    async function request(route: string, method = 'GET', body?: Record<string, unknown>, key?: string, rev?: number) {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Origin: base };
      if (body) headers['Content-Type'] = 'application/json';
      if (key) headers['Idempotency-Key'] = key;
      if (rev !== undefined) headers['If-Match'] = `"${rev}"`;
      const response = await fetch(base + '/api/v1' + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    }
    for (let index = 0; index < 10; index++) {
      const { status, body } = await request('/content/future-notes', 'POST', { body: index === 0 ? secret : `其余合成预留话 ${index}` }, `note-${index}`);
      assert.equal(status, 201, JSON.stringify(body));
      if (!index) targetId = body.id;
    }
    const notePath = '/content/future-notes/' + targetId;
    const settings = await request('/background/settings', 'PUT', { keepwarm: { enabled: true, daily_cost_cap_usd: 5 } }, 'set-keepwarm', 0);
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,?)")
      .run(JSON.stringify({ input_micro_per_token: 0.000003, output_micro_per_token: 0.000015 }), new Date().toISOString());

    async function chat(input: string, key: string) {
      const sent = await request('/conversations/primary/messages', 'POST', { content: input, client_message_id: key }, key);
      assert.ok(sent.status >= 200 && sent.status < 300, JSON.stringify(sent.body));
      await host!.supervisor.waitIdle();
    }
    await chat('先建立当前会话', 'chat-before');
    const window = host.windows.activeWindow('primary')!.id;
    const evidence = lastCacheEvidence(host.db, window);
    assert.ok(evidence);
    const activity = host.db.prepare("SELECT last_real_activity_at FROM conversation_activity WHERE conversation_id='primary'").get() as { last_real_activity_at: string };
    const due = Math.max(Date.parse(evidence.startedAt), Date.parse(activity.last_real_activity_at)) + 3_000_001;
    // Keep the production scheduler and its gates. Only advance its clock.
    (host.scheduler as any).d.now = () => due;
    (host.supervisor as any).d.now = () => due;

    if (order === 'delete-before-gate') {
      const runtime = (host as unknown as { heartbeat: HeartbeatRuntime }).heartbeat;
      const beforeDispatch = runtime.beforeDispatch.bind(runtime);
      t.mock.method(runtime, 'beforeDispatch', async (runId: string, requestId: string, messages: OrMessage[], signal: AbortSignal) => {
        if (messages.some(message => message.tool_call_id === drawId)) {
          assert.equal(host!.db.prepare('SELECT state FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId)?.state, 'prepared');
          entered.release();
          await proceed.reached;
        }
        await beforeDispatch(runId, requestId, messages, signal);
      });
    }
    const run = host.scheduler!.tick();
    await Promise.race([entered.reached, run.then(() => { throw new Error('heartbeat ended before the intended synchronization point'); })]);
    const sourceDeletion = await request(notePath, 'DELETE', undefined, 'delete-note', 1);
    assert.equal(sourceDeletion.status, 200, JSON.stringify(sourceDeletion.body));
    assert.equal(sourceDeletion.body.deleted, true);
    assert.equal(sourceDeletion.body.delivery_state, order === 'delete-before-gate' ? 'pending' : 'dispatching');
    assert.equal(sourceDeletion.body.frozen_card.number, number);
    assert.equal(sourceDeletion.body.frozen_card.available, false);
    proceed.release();
    await run;
    await host.supervisor.waitIdle();

    const deliveredState = order === 'delete-before-gate' ? 'pending' : order.endsWith('success') ? 'delivered' : 'unknown';
    const drawState = order === 'delete-before-gate' ? 'rejected' : deliveredState;
    const ledger = host.db.prepare('SELECT state,delivered_at FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId);
    assert.equal(ledger?.state, drawState);
    assert.equal(Boolean(ledger?.delivered_at), deliveredState === 'delivered');
    assert.equal(wire.length, order === 'delete-before-gate' ? 2 : 3);
    assert.equal(wire.slice(1).filter(messages => JSON.stringify(messages).includes(secret)).length, order === 'delete-before-gate' ? 0 : 1);
    const latest = await request(notePath);
    assert.equal(latest.body.deleted, true);
    assert.equal(latest.body.delivery_state, deliveredState);
    assert.equal((await request(notePath + '?revision=1')).status, 410);
    const replay = await request(notePath, 'DELETE', undefined, 'delete-note', 1);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.delivery_state, deliveredState);
    const deck = await request('/background/heartbeat');
    assert.equal(deck.body.available_numbers.includes(number), false);
    assert.equal(deck.body.delivered_numbers.includes(number), deliveredState === 'delivered');
    assert.notEqual(deck.body.mode, 'exhausted_keepwarm');

    if (order === 'delete-before-gate') {
      const blocked = host.db.prepare(`SELECT p.sent_at,p.dispatch_started_at,d.actual_cost_micro_usd
        FROM provider_requests p LEFT JOIN background_dispatches d ON d.id=p.background_dispatch_id
        WHERE p.purpose='cache_keepalive' ORDER BY p.rowid DESC LIMIT 1`).get();
      assert.deepEqual({ ...blocked }, { sent_at: null, dispatch_started_at: null, actual_cost_micro_usd: 0 });
    }
    await chat('下一条自然输入', 'chat-after');
    const after = wire.at(-1)!;
    assert.equal(after.filter(message => message.tool_call_id === drawId).length, 1);
    assert.equal(JSON.stringify(after).includes(secret), deliveredState === 'delivered');
    assert.equal(host.db.prepare('SELECT COUNT(*) AS n FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId)?.n, 1);
  });
}
