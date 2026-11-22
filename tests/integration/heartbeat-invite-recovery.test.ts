import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { lastCacheEvidence } from '../../apps/host/src/runtime/cache-observation.ts';
import { tailBoundaryOf } from '../../apps/host/src/runtime/cache-plan.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import type { SdkQueryFactory } from '../../apps/host/src/runtime/sdk-host-query.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import { installHeartbeatFixtureSources } from '../helpers/heartbeat-sources.ts';
import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';
import type { MessagePageDto, SubmitMessageResponse } from '../../packages/contracts/src/api.ts';

type Lane = 'api' | 'sdk';
type Seam = 'before_confirm' | 'after_confirm' | 'after_publish' | 'after_talk_commit';
const TALK_REPLY = '合成心跳问候，有句话想告诉你。';
const isInvite = (message: { role: string; content: unknown }) =>
  message.role === 'user' && JSON.stringify(message.content).includes('[心跳唤醒]');
const isTalkReply = (message: { role: string; content: unknown }) =>
  message.role === 'assistant' && JSON.stringify(message.content).includes(TALK_REPLY);
const model = 'anthropic/claude-heartbeat-invite-fixture';

async function fixture(root: string, lane: Lane, options: { seam?: Seam; beforeTalkComplete?: () => Promise<void> } = {}) {
  const { seam, beforeTalkComplete } = options;
  let requests = 0;
  let sdkResume: string | undefined;
  let sdkReplayedInvites = 0;
  let sdkReplayedTalks = 0;
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime as object, provider: 'mock', tool_schema_mode: 'direct',
      ...(lane === 'sdk' ? { subscription_proxy_url: 'http://127.0.0.1:1' } : {}) },
    openrouter: { model }, background: { keepwarm: { sleep_window: { enabled: false } } },
  });
  const query: SdkQueryFactory = input => {
    const session = 'fixture-invite-session';
    const output = (async function* () {
      let invite = false;
      if (!(yield* scriptedSdkInput(input, session, (frame, history) => {
        requests++;
        sdkResume = input.options?.resume;
        invite = isInvite(frame.message);
        sdkReplayedInvites = history.filter(({ message }) => isInvite(message)).length;
        sdkReplayedTalks = history.filter(({ message }) => isTalkReply(message)).length;
      }))) return;
      if (invite && seam === 'before_confirm') process.kill(process.pid, 'SIGKILL');
      const id = `sdk-invite-${requests}`;
      yield { type: 'stream_event', session_id: session, event: { type: 'message_start', message: {
        id, model: input.options?.model, usage: { input_tokens: 600, output_tokens: 4, cache_read_input_tokens: 1500 },
      } } };
      yield { type: 'assistant', session_id: session, message: { id, content: [{ type: 'text', text: invite ? TALK_REPLY : '合成回复' }] } };
      if (invite && beforeTalkComplete) await beforeTalkComplete();
      yield { type: 'stream_event', session_id: session, event: { type: 'message_stop' } };
      yield { type: 'result', subtype: 'success', session_id: session };
    })();
    return Object.assign(output, {
      close() {}, accountInfo: async () => ({ apiProvider: 'firstParty' }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: false } },
      }),
    }) as ReturnType<SdkQueryFactory>;
  };
  const runner = lane === 'sdk' ? new ClaudeSdkRunner(query) : new OpenRouterRunner({
    providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0,
  }, async payload => {
    requests++;
    const last = (payload.messages as OrMessage[]).at(-1);
    const invite = Boolean(last && isInvite(last));
    if (invite && seam === 'before_confirm') process.kill(process.pid, 'SIGKILL');
    async function* output() {
      yield `data: ${JSON.stringify({ choices: [{ delta: { content: invite ? TALK_REPLY : '合成回复' } }] })}\n\n`;
      if (invite && beforeTalkComplete) await beforeTalkComplete();
      yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2100,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":1500,"cache_write_tokens":600},"cost":0.001}}\n\n';
      yield 'data: [DONE]\n\n';
    }
    return { status: 200, headers: new Headers(), body: Readable.from(output()) };
  });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0, runnerOverride: runner });
  async function chat(label: string) {
    host.messages.ensureConversation('primary');
    const { turnId } = host.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: label, clientMessageId: label });
    host.supervisor.enqueue(turnId);
    await host.supervisor.waitIdle();
    assert.equal(host.db.prepare('SELECT state FROM turns WHERE id=?').get(turnId)?.state, 'completed');
    return turnId;
  }
  return { host, config, chat, requests: () => requests, sdkReplayedInvites: () => sdkReplayedInvites,
    sdkReplayedTalks: () => sdkReplayedTalks, sdkResume: () => sdkResume };
}

function scheduleHeartbeat(host: Host, config: ReturnType<typeof buildConfig>) {
  const window = host.windows.activeWindow('primary')!;
  const evidence = lastCacheEvidence(host.db, window.id);
  assert.ok(evidence);
  new BackgroundSettingsService(host.db, config).applyUpdate({
    expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 3 },
  });
  host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,'now')")
    .run(JSON.stringify({ input_micro_per_token: 1, output_micro_per_token: 2, cache_write_micro_per_token: 1 }));
  const anchor = new Date(Date.now() - 3_010_000).toISOString();
  host.db.prepare('UPDATE provider_requests SET dispatch_started_at=? WHERE id=?').run(anchor, evidence.requestId);
  host.db.prepare("UPDATE conversation_activity SET last_real_activity_at=? WHERE conversation_id='primary'").run(anchor);
  return window.id;
}

async function crash(root: string, lane: Lane, seam: Seam) {
  writeApprovedIdentity(root);
  installHeartbeatFixtureSources();
  const { host, config, chat } = await fixture(root, lane, { seam });
  await chat('建立当前会话');
  scheduleHeartbeat(host, config);
  const heartbeat = host.heartbeat!;
  const observe = heartbeat.observeDelivery.bind(heartbeat);
  heartbeat.observeDelivery = (...args) => {
    if (seam === 'after_confirm') process.kill(process.pid, 'SIGKILL');
    observe(...args);
    if (seam === 'after_publish') process.kill(process.pid, 'SIGKILL');
  };
  if (seam === 'after_talk_commit') {
    const exec = host.db.exec.bind(host.db);
    host.db.exec = sql => {
      exec(sql);
      if (sql === 'COMMIT' && host.db.prepare(`SELECT 1 FROM outbox
        WHERE target='content_heartbeat_projection' AND json_extract(payload_ref,'$.state')='talked'`).get()) {
        process.kill(process.pid, 'SIGKILL');
      }
    };
  }
  host.scheduler!.start();
  await host.scheduler!.tick();
  assert.fail('fixture did not reach the heartbeat invite crash seam');
}

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}

const CHILD = '--heartbeat-invite-crash';
if (process.argv[2] === CHILD) {
  await crash(process.argv[3]!, process.argv[4] as Lane, process.argv[5] as Seam);
} else for (const lane of ['api', 'sdk'] as const) for (const seam of ['before_confirm', 'after_confirm', 'after_publish', 'after_talk_commit'] as const) {
  test(`heartbeat: restore the confirmed invitation and a committed pure reply after restart (${lane}, ${seam})`, async t => {
    const root = tempRoot('heartbeat-invite-crash-');
    let running: Host | undefined;
    t.after(async () => { await running?.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    const child = spawnSync(process.execPath, [import.meta.filename, CHILD, root, lane, seam], {
      env: { ...process.env, ESTOMAGO_HOME: root }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(child.signal, 'SIGKILL', child.stdout + child.stderr);
    const before = openDatabase(path.join(root, 'data'));
    const request = before.prepare(`SELECT id,window_id,background_run_id,turn_id,payload_json,sent_at FROM provider_requests
      WHERE purpose='cache_keepalive'`).get() as { id: string; window_id: string; background_run_id: string; turn_id: string; payload_json: string; sent_at: string | null };
    const sent = (JSON.parse(request.payload_json) as { messages: OrMessage[] }).messages;
    const confirmed = seam !== 'before_confirm';
    const talked = seam === 'after_talk_commit';
    const inviteId = `heartbeat:${request.background_run_id}:invite`;
    assert.equal(Boolean(request.sent_at), confirmed);
    assert.equal(sent.filter(isInvite).length, 1);
    assert.equal(before.prepare('SELECT count(*) n FROM messages WHERE client_message_id=?').get(inviteId)?.n,
      seam === 'after_publish' || talked ? 1 : 0);
    const original = new WindowTrajectoryService(before).forWindow(request.window_id)!;
    assert.equal(original.messages.filter(isInvite).length, Number(talked));
    if (talked) {
      assert.deepEqual(original.messages.slice(0, -1), sent);
      assert.ok(isTalkReply(original.messages.at(-1)!));
      assert.equal(before.prepare('SELECT state FROM background_runs WHERE id=?').get(request.background_run_id)?.state, 'running');
    }
    before.close();

    for (let restart = 0; restart < 2; restart++) {
      const current = await fixture(root, lane);
      const host = running = current.host;
      const server = (host as unknown as { server: { listen(port: number, bind: string, ready: () => void): void } }).server;
      t.mock.method(server, 'listen', (_port, _bind, ready) => ready());
      await host.start();
      assert.equal(current.requests(), 0);
      const retained = new WindowTrajectoryService(host.db).forWindow(request.window_id)!;
      assert.deepEqual(retained.messages, confirmed && !talked ? sent : original.messages);
      assert.deepEqual(retained.lastBoundary, confirmed ? tailBoundaryOf(sent) : original.lastBoundary);
      assert.equal(host.db.prepare('SELECT count(*) n FROM provider_requests WHERE background_run_id=?').get(request.background_run_id)?.n, 1);
      const expectedPublished = Number(confirmed) + Number(talked);
      assert.equal(host.db.prepare('SELECT count(*) n FROM messages WHERE turn_id=?').get(request.turn_id)?.n, expectedPublished);
      const events = host.events.replayPage(0, 'primary').filter(event => event.kind === 'message.published' && event.turn_id === request.turn_id);
      assert.equal(events.length, expectedPublished);
      assert.equal(host.db.prepare('SELECT count(*) n FROM heartbeat_draw_operations WHERE run_id=?').get(request.background_run_id)?.n, 0);
      const result = host.db.prepare('SELECT state,result_code FROM background_runs WHERE id=?').get(request.background_run_id);
      assert.deepEqual({ ...result }, talked ? { state: 'completed', result_code: 'complete:done' }
        : { state: 'unknown', result_code: 'HOST_RESTART_MID_RUN' });
      assert.equal(host.db.prepare("SELECT maintenance_request_id FROM conversation_activity WHERE conversation_id='primary'").get()?.maintenance_request_id, null);
      if (talked) {
        const reply = host.db.prepare("SELECT id FROM messages WHERE turn_id=? AND speaker='assistant'").get(request.turn_id);
        assert.ok(reply);
        assert.equal(retained.manifest?.filter(entry => entry.id === reply.id && entry.visible).length, 1);
        assert.equal(host.db.prepare("SELECT last_real_message_id FROM conversation_activity WHERE conversation_id='primary'").get()?.last_real_message_id, reply.id);
        const projection = host.db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get();
        assert.ok(projection);
        const view = JSON.parse(String(projection.payload_ref));
        assert.equal(view.state, 'talked');
        assert.equal(view.card, null);
        assert.equal(view.messages.at(-1)?.messageId, reply.id);
      }
      if (restart === 1) {
        const turnId = await current.chat('重启后的自然输入');
        const next = host.db.prepare('SELECT window_id,payload_json FROM provider_requests WHERE turn_id=? AND sent_at IS NOT NULL')
          .get(turnId) as { window_id: string; payload_json: string };
        assert.equal(current.requests(), 1);
        assert.equal(next.window_id, request.window_id);
        const nextMessages = (JSON.parse(next.payload_json) as { messages: OrMessage[] }).messages;
        assert.equal(nextMessages.filter(isInvite).length, Number(confirmed));
        assert.equal(nextMessages.filter(isTalkReply).length, Number(talked));
        if (lane === 'sdk') {
          assert.equal(current.sdkReplayedInvites(), Number(confirmed));
          assert.equal(current.sdkReplayedTalks(), Number(talked));
        }
      }
      await host.stop();
      running = undefined;
    }
  });
}

if (process.argv[2] !== CHILD) for (const lane of ['api', 'sdk'] as const) {
  test(`heartbeat: publish the completed pure reply before handing off to new owner chat (${lane})`, { timeout: 10000 }, async t => {
    const root = tempRoot('heartbeat-reply-handoff-');
    const replyReceived = barrier();
    const finishReply = barrier();
    const restoreSources = installHeartbeatFixtureSources();
    writeApprovedIdentity(root);
    const setup = await fixture(root, lane, { beforeTalkComplete: async () => {
      replyReceived.release();
      await finishReply.reached;
    } });
    const { host, config, chat } = setup;
    t.after(async () => {
      finishReply.release();
      await host.stop();
      restoreSources();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await host.start();
    await chat('建立当前会话');
    const windowId = scheduleHeartbeat(host, config);
    const scheduler = host.scheduler!;
    const tick = scheduler.tick();
    await replyReceived.reached;

    const url = `http://127.0.0.1:${host.port}`;
    const messagesUrl = url + '/api/v1/conversations/primary/messages';
    const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
    const headers = { Authorization: `Bearer ${token}`, Origin: url, 'Content-Type': 'application/json' };
    const ownerText = '合成消息：我回到聊天了。';
    const submitted = await fetch(messagesUrl, { method: 'POST', headers,
      body: JSON.stringify({ content: ownerText, client_message_id: 'fixture-owner-handoff' }) });
    assert.equal(submitted.status, 201);
    const owner = await submitted.json() as SubmitMessageResponse;
    const run = host.db.prepare("SELECT id,turn_id FROM background_runs WHERE kind='keepwarm'").get();
    assert.ok(run);
    assert.ok(scheduler.isYieldRequested(String(run.id)));
    assert.equal(host.db.prepare('SELECT state FROM turns WHERE id=?').get(owner.turn_id)?.state, 'pending');
    assert.equal(setup.requests(), 2, 'foreground generation waits behind the in-flight heartbeat');

    finishReply.release();
    await tick;
    await host.supervisor.waitIdle();
    const historyResponse = await fetch(messagesUrl, { headers });
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json() as MessagePageDto;
    const speech = history.messages.filter(message => message.turn_id === run.turn_id && message.speaker === 'assistant');
    assert.equal(speech.length, 1);
    assert.equal(speech[0]?.revision.content, TALK_REPLY);
    assert.equal(history.messages.filter(message => message.turn_id === owner.turn_id && message.speaker === 'assistant').length, 1);
    assert.equal(host.events.replayPage(0, 'primary').filter(event => event.kind === 'message.published' && event.entity_ref === speech[0]?.id).length, 1);
    assert.deepEqual({ ...host.db.prepare('SELECT state,result_code FROM background_runs WHERE id=?').get(run.id) },
      { state: 'completed', result_code: 'complete:done' });
    assert.equal(host.db.prepare('SELECT count(*) n FROM heartbeat_draw_operations WHERE run_id=?').get(run.id)?.n, 0);

    const retained = new WindowTrajectoryService(host.db).forWindow(windowId)!;
    assert.equal(retained.messages.filter(isTalkReply).length, 1);
    assert.equal(retained.manifest?.filter(entry => entry.id === speech[0]?.id && entry.visible).length, 1);
    const packets = host.db.prepare('SELECT window_id,payload_json FROM provider_requests WHERE turn_id=? AND sent_at IS NOT NULL')
      .all(owner.turn_id);
    assert.equal(packets.length, 1);
    assert.equal(packets[0]?.window_id, windowId);
    const next = (JSON.parse(String(packets[0]?.payload_json)) as { messages: OrMessage[] }).messages;
    assert.equal(next.filter(isTalkReply).length, 1);
    assert.match(JSON.stringify(next.at(-1)?.content), new RegExp(ownerText));
    assert.equal(setup.requests(), 3);
    if (lane === 'sdk') {
      assert.equal(setup.sdkResume(), 'fixture-invite-session');
      assert.equal(setup.sdkReplayedTalks(), 0, 'continued native session already has the reply');
    }
  });
}
