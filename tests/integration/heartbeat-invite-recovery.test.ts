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

type Lane = 'api' | 'sdk';
type Seam = 'before_confirm' | 'after_confirm' | 'after_publish';
const isInvite = (message: { role: string; content: unknown }) =>
  message.role === 'user' && JSON.stringify(message.content).includes('[心跳唤醒]');
const model = 'anthropic/claude-heartbeat-invite-fixture';

async function fixture(root: string, lane: Lane, seam?: Seam) {
  let requests = 0;
  let sdkReplayedInvites = 0;
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
        invite = isInvite(frame.message);
        sdkReplayedInvites = history.filter(({ message }) => isInvite(message)).length;
      }))) return;
      if (invite && seam === 'before_confirm') process.kill(process.pid, 'SIGKILL');
      const id = `sdk-invite-${requests}`;
      yield { type: 'stream_event', session_id: session, event: { type: 'message_start', message: {
        id, model: input.options?.model, usage: { input_tokens: 600, output_tokens: 4, cache_read_input_tokens: 1500 },
      } } };
      yield { type: 'assistant', session_id: session, message: { id, content: [{ type: 'text', text: '合成回复' }] } };
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
    if (last && isInvite(last) && seam === 'before_confirm') process.kill(process.pid, 'SIGKILL');
    return { status: 200, headers: new Headers(), body: Readable.from([
      'data: {"choices":[{"delta":{"content":"合成回复"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2100,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":1500,"cache_write_tokens":600},"cost":0.001}}\n\n',
      'data: [DONE]\n\n',
    ]) };
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
  return { host, config, chat, requests: () => requests, sdkReplayedInvites: () => sdkReplayedInvites };
}

async function crash(root: string, lane: Lane, seam: Seam) {
  writeApprovedIdentity(root);
  installHeartbeatFixtureSources();
  const { host, config, chat } = await fixture(root, lane, seam);
  await chat('建立当前会话');
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
  const heartbeat = host.heartbeat!;
  const observe = heartbeat.observeDelivery.bind(heartbeat);
  heartbeat.observeDelivery = (...args) => {
    if (seam === 'after_confirm') process.kill(process.pid, 'SIGKILL');
    observe(...args);
    if (seam === 'after_publish') process.kill(process.pid, 'SIGKILL');
  };
  host.scheduler!.start();
  await host.scheduler!.tick();
  assert.fail('fixture did not reach the heartbeat invite crash seam');
}

const CHILD = '--heartbeat-invite-crash';
if (process.argv[2] === CHILD) {
  await crash(process.argv[3]!, process.argv[4] as Lane, process.argv[5] as Seam);
} else for (const lane of ['api', 'sdk'] as const) for (const seam of ['before_confirm', 'after_confirm', 'after_publish'] as const) {
  test(`heartbeat: retain only the confirmed invitation after restart (${lane}, ${seam})`, async t => {
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
    const inviteId = `heartbeat:${request.background_run_id}:invite`;
    assert.equal(Boolean(request.sent_at), confirmed);
    assert.equal(sent.filter(isInvite).length, 1);
    assert.equal(before.prepare('SELECT count(*) n FROM messages WHERE client_message_id=?').get(inviteId)?.n, seam === 'after_publish' ? 1 : 0);
    const original = new WindowTrajectoryService(before).forWindow(request.window_id)!;
    assert.equal(original.messages.filter(isInvite).length, 0);
    before.close();

    for (let restart = 0; restart < 2; restart++) {
      const current = await fixture(root, lane);
      const host = running = current.host;
      const server = (host as unknown as { server: { listen(port: number, bind: string, ready: () => void): void } }).server;
      t.mock.method(server, 'listen', (_port, _bind, ready) => ready());
      await host.start();
      assert.equal(current.requests(), 0);
      const retained = new WindowTrajectoryService(host.db).forWindow(request.window_id)!;
      assert.deepEqual(retained.messages, confirmed ? sent : original.messages);
      assert.deepEqual(retained.lastBoundary, confirmed ? tailBoundaryOf(sent) : original.lastBoundary);
      assert.equal(host.db.prepare('SELECT count(*) n FROM provider_requests WHERE background_run_id=?').get(request.background_run_id)?.n, 1);
      assert.equal(host.db.prepare('SELECT count(*) n FROM messages WHERE turn_id=?').get(request.turn_id)?.n, Number(confirmed));
      const events = host.events.replayPage(0, 'primary').filter(event => event.kind === 'message.published' && event.turn_id === request.turn_id);
      assert.equal(events.length, Number(confirmed));
      assert.equal(host.db.prepare('SELECT count(*) n FROM heartbeat_draw_operations WHERE run_id=?').get(request.background_run_id)?.n, 0);
      const result = host.db.prepare('SELECT state,result_code FROM background_runs WHERE id=?').get(request.background_run_id);
      assert.deepEqual({ ...result }, { state: 'unknown', result_code: 'HOST_RESTART_MID_RUN' });
      assert.equal(host.db.prepare("SELECT maintenance_request_id FROM conversation_activity WHERE conversation_id='primary'").get()?.maintenance_request_id, null);
      if (restart === 1) {
        const turnId = await current.chat('重启后的自然输入');
        const next = host.db.prepare('SELECT window_id,payload_json FROM provider_requests WHERE turn_id=? AND sent_at IS NOT NULL')
          .get(turnId) as { window_id: string; payload_json: string };
        assert.equal(current.requests(), 1);
        assert.equal(next.window_id, request.window_id);
        assert.equal((JSON.parse(next.payload_json) as { messages: OrMessage[] }).messages.filter(isInvite).length, Number(confirmed));
        if (lane === 'sdk') assert.equal(current.sdkReplayedInvites(), Number(confirmed));
      }
      await host.stop();
      running = undefined;
    }
  });
}
