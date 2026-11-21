import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Host } from '../../apps/host/src/app-context.ts';
import type { ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import type { SdkQueryFactory } from '../../apps/host/src/runtime/sdk-host-query.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { lastCacheEvidence } from '../../apps/host/src/runtime/cache-observation.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { makeFixtureToolsResident, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import { installHeartbeatFixtureSources } from '../helpers/heartbeat-sources.ts';
import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';

type Mode = 'api-deferred' | 'sdk-direct' | 'sdk-inflight' | 'heartbeat';
const usesSdk = (mode: Mode) => mode === 'sdk-direct' || mode === 'sdk-inflight';
let earlyStarted!: () => void;
const afterEarlyStart = new Promise<void>(resolve => { earlyStarted = resolve; });
const model = 'anthropic/claude-r33-fixture';
const usage = { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.001 };
const turns: OrMessage[][] = [];
const sdkPast: Array<{ message: { content: Array<{ type: string; tool_use_id?: string }> } }> = [];

const hasCompletion = (name: string, args: Record<string, unknown>) =>
  name === 'background_complete' || (name === 'tool_invoke' && args.name === 'background_complete');

function call(mode: Mode, id: string, name: string, args: Record<string, unknown>) {
  return { id, name: mode === 'api-deferred' ? 'tool_invoke' : name,
    input: mode === 'api-deferred' ? { name, arguments: args } : args };
}

function configuration(mode: Mode) {
  const ready = readyRuntimePatch();
  return buildConfig({
    ...ready, runtime: { ...ready.runtime as object, provider: 'mock', tool_schema_mode: mode === 'api-deferred' ? 'deferred' : 'direct',
      ...(usesSdk(mode) ? { subscription_proxy_url: 'http://127.0.0.1:1' } : {}) },
    openrouter: { model }, background: { keepwarm: { sleep_window: { enabled: false } } },
  });
}

function sdkFixture(mode: Mode, crash: boolean) {
  const query = ((input: any) => {
    const session = 'r33-synthetic-sdk';
    const output = (async function* () {
      if (!(yield* scriptedSdkInput(input, session, (_frame, history) => { sdkPast.push(...history); }))) return;
      yield { type: 'stream_event', session_id: session,
        event: { type: 'message_start', message: { id: 'sdk-observed', model: input.options.model } } };
      if (crash) {
        const action = call(mode, 'finish', 'background_complete', { outcome: 'noop' });
        const late = call(mode, 'late', 'chat_send_text', { text: '不可发出', idempotency_key: 'late-synthetic' });
        const early = mode === 'sdk-inflight' ? call(mode, 'early', 'chat_send_text', { text: '已经正式发出', idempotency_key: 'early-synthetic' }) : null;
        yield { type: 'assistant', session_id: session, message: { id: 'sdk-observed', content: [...(early ? [early] : []), action, late].map(tool =>
          ({ type: 'tool_use', ...tool, name: 'mcp__est__' + tool.name })) } };
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'synthetic', version: '1' });
        await input.options.mcpServers.est.instance.connect(serverTransport);
        await client.connect(clientTransport);
        if (early) {
          await input.options.hooks.PreToolUse[0].hooks[0]({
            hook_event_name: 'PreToolUse', tool_name: 'mcp__est__' + early.name, tool_input: early.input, tool_use_id: early.id,
          });
          void client.callTool({ name: early.name, arguments: early.input }).catch(() => {});
          await afterEarlyStart;
        }
        await input.options.hooks.PreToolUse[0].hooks[0]({
          hook_event_name: 'PreToolUse', tool_name: 'mcp__est__' + action.name, tool_input: action.input, tool_use_id: action.id,
        });
        await client.callTool({ name: action.name, arguments: action.input });
        throw new Error('fixture must die during accepted completion');
      }
      yield { type: 'assistant', session_id: session, message: { id: 'sdk-observed', content: [{ type: 'text', text: '下一轮实际回复' }] } };
      yield { type: 'result', subtype: 'success', session_id: session };
    })();
    return Object.assign(output, {
      close() {}, accountInfo: async () => ({ apiProvider: 'firstParty' }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: false } },
      }),
    });
  }) as SdkQueryFactory;
  return new ClaudeSdkRunner(query);
}

async function makeHost(root: string, mode: Mode, crash: boolean) {
  const runner = usesSdk(mode) ? sdkFixture(mode, crash) : new OpenRouterRunner({
    providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0,
  }, async payload => {
    const messages = payload.messages as OrMessage[];
    turns.push(messages);
    const isHeartbeat = JSON.stringify(messages.at(-1)).includes('[心跳唤醒]');
    const tooling = crash && (mode !== 'heartbeat' || isHeartbeat);
    const actions = tooling ? [
      ...(isHeartbeat ? [] : [call(mode, 'early', 'chat_send_text', { text: '已经正式发出', idempotency_key: 'early-synthetic' })]),
      call(mode, 'finish', 'background_complete', { outcome: 'noop' }),
      call(mode, 'late', 'chat_send_text', { text: '不可发出', idempotency_key: 'late-synthetic' }),
    ] : [];
    const delta = tooling ? { tool_calls: actions.map((tool, index) => ({
      index, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) },
    })) } : { content: '自然回复' };
    return { status: 200, headers: new Headers(), body: Readable.from([
      `data: ${JSON.stringify({ id: `generation-${turns.length}`, choices: [{ delta }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: tooling ? 'tool_calls' : 'stop' }], usage })}\n\n`,
      'data: [DONE]\n\n',
    ]) };
  });
  return Host.create({ stateRoot: root, config: configuration(mode), logDir: null, bind: '127.0.0.1', port: 0, runnerOverride: runner });
}

async function chat(host: Host, label: string) {
  host.messages.ensureConversation('primary');
  const input = host.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: label, clientMessageId: label });
  host.supervisor.enqueue(input.turnId);
  await host.supervisor.waitIdle();
  return input.turnId;
}

async function crashFixture(root: string, mode: Mode) {
  writeApprovedIdentity(root);
  installHeartbeatFixtureSources();
  const host = await makeHost(root, mode, true);
  if (mode !== 'api-deferred') makeFixtureToolsResident(host.db, ['heartbeat_draw', 'background_complete', 'chat_send_text']);
  const executor = (host.supervisor as any).d.tools;
  const original = executor.execute.bind(executor);
  // Crash immediately after the real accepted receipt reaches the bridge
  // caller, before either transport can append ordinary in-memory results.
  executor.execute = async (name: string, args: Record<string, unknown>, ctx: ToolExecContext) => {
    const result = await original(name, args, ctx);
    if (mode === 'sdk-inflight' && ctx.toolCallId === 'early') {
      assert.equal(result.ok, true);
      earlyStarted();
      await new Promise<void>(() => {});
    }
    if (hasCompletion(name, args)) {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(host.db.prepare('SELECT state FROM turns WHERE id=?').get(ctx.turnId!)?.state, 'running');
      process.kill(process.pid, 'SIGKILL');
    }
    return result;
  };
  if (mode === 'heartbeat') {
    await chat(host, '先建立当前会话');
    const win = host.windows.activeWindow('primary')!;
    const evidence = lastCacheEvidence(host.db, win.id)!;
    assert.ok(evidence);
    const settings = new BackgroundSettingsService(host.db, configuration(mode));
    settings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 3 } });
    host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,'now')")
      .run(JSON.stringify({ input_micro_per_token: 1, output_micro_per_token: 2, cache_write_micro_per_token: 1 }));
    const anchor = new Date(Date.now() - 3_010_000).toISOString();
    host.db.prepare('UPDATE provider_requests SET dispatch_started_at=? WHERE id=?').run(anchor, evidence.requestId);
    host.db.prepare("UPDATE conversation_activity SET last_real_activity_at=? WHERE conversation_id='primary'").run(anchor);
    host.scheduler!.start();
    await host.scheduler!.tick();
  } else {
    await chat(host, '主动结束这一轮');
  }
  throw new Error('fixture did not reach the completion crash point');
}

if (process.argv[2] === '--crash-after-completion') {
  await crashFixture(process.argv[3]!, process.argv[4] as Mode);
} else for (const mode of ['api-deferred', 'sdk-direct', 'sdk-inflight', 'heartbeat'] as const) {
  test(`R33: recover the observed completion protocol after actual SIGKILL (${mode})`, async t => {
    turns.length = 0; sdkPast.length = 0;
    const root = tempRoot('r33-recovery-');
    let restarted: Host | undefined;
    t.after(async () => { await restarted?.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    const child = spawnSync(process.execPath, [import.meta.filename, '--crash-after-completion', root, mode], {
      env: { ...process.env, ESTOMAGO_HOME: root }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(child.signal, 'SIGKILL', child.stdout + child.stderr);
    const before = openDatabase(path.join(root, 'data'));
    const checkpoint = before.prepare(`
      SELECT id,turn_id,completion_outcome,completion_recovery_json FROM attempts
      WHERE state='running' AND completion_outcome IS NOT NULL
    `).get() as { id: string; turn_id: string; completion_outcome: string; completion_recovery_json: string };
    assert.equal(checkpoint.completion_outcome, 'noop');
    const staged = JSON.parse(checkpoint.completion_recovery_json);
    const delivered = before.prepare('SELECT COUNT(*) AS n FROM provider_requests WHERE attempt_id=? AND sent_at IS NOT NULL').get(checkpoint.id)?.n;
    assert.equal(delivered, 1);
    assert.ok(staged.tail.some((m: OrMessage) => m.tool_call_id === 'finish'));
    assert.ok(!staged.tail.some((m: OrMessage) => m.tool_call_id === 'late'));
    before.close();

    const host = restarted = await makeHost(root, mode, false);
    await host.start();
    assert.equal(turns.length + sdkPast.length, 0, 'recovery made no model call');
    const recovered = host.db.prepare('SELECT state,completion_outcome,completion_recovery_json FROM attempts WHERE id=?').get(checkpoint.id);
    assert.deepEqual({ ...recovered }, { state: mode === 'sdk-inflight' ? 'failed' : 'completed', completion_outcome: 'noop', completion_recovery_json: null });
    assert.equal(host.db.prepare('SELECT COUNT(*) AS n FROM provider_requests WHERE attempt_id=?').get(checkpoint.id)?.n, delivered);
    const win = host.windows.activeWindow('primary')!;
    const trajectory = new WindowTrajectoryService(host.db).forWindow(win.id)!;
    assert.equal(trajectory.messages.filter(m => m.tool_call_id === 'finish').length, 1);
    const response = trajectory.messages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls)
      && (m.tool_calls as Array<{ id: string }>).some(call => call.id === 'finish'))!;
    assert.deepEqual(response, staged.tail.find((m: OrMessage) => m.role === 'assistant'));
    assert.equal(JSON.parse(trajectory.messages.find(m => m.tool_call_id === 'late')!.content as string).executed, false);
    const body = host.db.prepare(`
      SELECT r.content,m.speaker FROM messages m JOIN message_revisions r ON m.id=r.message_id AND r.revision=m.current_revision
      WHERE m.turn_id=? ORDER BY sequence
    `).all(checkpoint.turn_id);
    assert.ok(!body.some(row => row.content === '不可发出'));
    if (mode === 'api-deferred' || mode === 'sdk-inflight') assert.equal(body.filter(row => row.content === '已经正式发出').length, 1);
    if (mode === 'sdk-inflight') {
      assert.deepEqual(JSON.parse(trajectory.messages.find(m => m.tool_call_id === 'early')!.content as string),
        { error_code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN', outcome: 'unknown' });
    }
    if (mode === 'heartbeat') {
      const run = host.db.prepare('SELECT state,result_code FROM background_runs WHERE turn_id=?').get(checkpoint.turn_id);
      assert.deepEqual({ ...run }, { state: 'noop', result_code: 'complete:noop' });
      assert.equal(body.filter(row => row.content === '[心跳唤醒] 本轮未抽卡').length, 1);
      assert.equal(body.filter(row => row.speaker === 'assistant').length, 0);
    }
    await chat(host, '下一自然输入');
    if (usesSdk(mode)) {
      assert.equal(sdkPast.flatMap(frame => frame.message.content).filter(block => block.type === 'tool_result' && block.tool_use_id === 'finish').length, 1);
    } else {
      assert.equal(turns.at(-1)?.filter(m => m.tool_call_id === 'finish').length, 1);
    }
  });
}
