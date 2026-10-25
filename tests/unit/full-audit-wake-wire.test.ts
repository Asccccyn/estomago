// Fake transports; actual adapters, frozen tool discovery, supervisor and SQL.
import { test } from 'node:test';
import { assembleTestTools, makeDb, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundTaskService } from '../../apps/host/src/runtime/background-task-service.ts';
import { assertAppendOnly } from '../../apps/host/src/runtime/or-payload.ts';

const encode = new TextEncoder();
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const stream = (body: string) => Readable.from([encode.encode(body)]);

for (const provider of ['deepseek', 'openrouter'] as const) test(`${provider} F-W17 actual final wire: catalog → define → schedule/list/update/cancel; immutable previous payload`, async t => {
  const root = tempRoot('audit-wake-wire-'); writeApprovedIdentity(root);
  const { db } = makeDb(root); t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider, tool_schema_mode: 'deferred' }, deepseek: { model: 'deepseek-chat' }, openrouter: { model: 'anthropic/claude-test-1' } });
  const settings = new BackgroundSettingsService(db, config);
  settings.applyUpdate({ expectedRevision: 0, patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 1, keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  db.prepare("UPDATE background_tasks SET conversation_id='c1' WHERE id='bgt_keepwarm_system'").run();
  const tasks = new BackgroundTaskService(db, settings);
  const events = new EventService(db), messages = new MessageService(db), paths = buildPaths(root);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const reviews = new RotationReviewService(db), checkpoint = new HoldCheckpointService(db);
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: reviews, checkpoint: checkpoint, messages: messages, taskService: tasks });
  const payloads: Record<string, unknown>[] = [];
  const visible: Record<string, Record<string, unknown>> = {};
  let definitionId = '', taskId = '', revision = 1;
  const transport: OrTransport = async payload => {
    payloads.push(structuredClone(payload)); const n = payloads.length;
    assert.deepEqual((payload.tools as Array<{ function: { name: string } }>).map(v => v.function.name), ['tool_catalog', 'tool_define', 'tool_invoke']);
    const last = (payload.messages as Array<{ role: string; content: string }>).at(-1)!;
    const tool = n > 1 && n <= 8 ? JSON.parse(last.content) as Record<string, unknown> : null;
    const call = (name: string, args: unknown) => sse({ id: `gen-${n}`, choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
    const invoke = (args: unknown) => call('tool_invoke', { name: 'wake_manage', definition_id: definitionId, arguments: args });
    let body: string;
    if (n === 1) body = call('tool_catalog', {});
    else if (n === 2) { assert.ok(JSON.stringify(tool).includes('wake_manage')); body = call('tool_define', { name: 'wake_manage' }); }
    else if (n === 3) { definitionId = String(tool!.definition_id); visible.definition = tool!; body = invoke({ operation: 'schedule', operation_id: 'wire-schedule', note: '合成：十分钟后读书，完整备注保留。', delay_seconds: 600 }); }
    else if (n === 4) { visible.schedule = tool!; taskId = String(tool!.task_id); revision = Number(tool!.revision); body = invoke({ operation: 'list' }); }
    else if (n === 5) { visible.list = tool!; body = invoke({ operation: 'update', operation_id: 'wire-update', task_id: taskId, expected_revision: revision, delay_seconds: 900 }); }
    else if (n === 6) { visible.update = tool!; revision = Number(tool!.revision); body = invoke({ operation: 'cancel', operation_id: 'wire-cancel', task_id: taskId, expected_revision: revision }); }
    else if (n === 7) { visible.cancel = tool!; body = invoke({ operation: 'cancel', operation_id: 'wire-system-guard', task_id: 'bgt_keepwarm_system', expected_revision: 1 }); }
    else { if (n === 8) visible.system_guard = tool!; body = sse({ id: `gen-${n}`, choices: [{ delta: { content: '合成操作完成。' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 500, completion_tokens: 10 } }) + 'data: [DONE]\n\n'; }
    return { status: 200, headers: new Map(), body: stream(body) };
  };
  const runner = provider === 'deepseek' ? new DeepSeekRunner({ retryMax: 0 }, transport) : new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews, checkpoint, trajectory: new WindowTrajectoryService(db) });
  messages.ensureConversation('c1');
  const first = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '合成：请设闹钟，再查、改、取消。', clientMessageId: 'wire-1' });
  supervisor.enqueue(first.turnId); await supervisor.waitIdle();
  assert.equal((db.prepare('SELECT state FROM turns WHERE id=?').get(first.turnId) as { state: string }).state, 'completed');
  assert.equal(payloads.length, 8);
  const snapshot = JSON.stringify(payloads[7]);
  const second = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '合成：下一条普通聊天。', clientMessageId: 'wire-2' });
  supervisor.enqueue(second.turnId); await supervisor.waitIdle();
  assert.equal(payloads.length, 9);
  assert.equal(JSON.stringify(payloads[7]), snapshot);
  assert.equal(assertAppendOnly({ messages: payloads[7]!.messages }, { messages: payloads[8]!.messages }), true);
  const detail = tasks.detail({ actorId: 'jiaming', conversationId: 'c1', taskId });
  assert.equal(detail.ok && detail.task.note, '合成：十分钟后读书，完整备注保留。');
  assert.equal(detail.ok && detail.task.status, 'cancelled');
  const fields = Object.fromEntries(Object.entries(visible).map(([name, value]) => [name, Object.keys(value)]));
  const bytes = Object.fromEntries(Object.entries(visible).map(([name, value]) => [name, Buffer.byteLength(JSON.stringify(value), 'utf8')]));
  console.log('WAKE_WIRE_SAMPLE ' + JSON.stringify({ provider, evidence: 'fake_transport_actual_final_wire', visible, fields, bytes, tokens: null, token_note: 'No matching tokenizer; bytes are not tokens.' }));
  assert.equal(visible.system_guard.error_code, 'TASK_NOT_FOUND', 'model cannot cancel system maintenance by guessing its ID');
  assert.equal((visible.list.tasks as unknown[]).length, 1, 'model wake list excludes the system keepwarm task');
  assert.equal('next_cursor' in visible.list, false, 'no meaningless null cursor');
  for (const action of ['schedule', 'update', 'cancel']) assert.equal('duplicate' in visible[action]!, false, 'idempotence metadata stays in host ledger');
  assert.equal((db.prepare("SELECT enabled FROM background_tasks WHERE id='bgt_keepwarm_system'").get() as { enabled: number }).enabled, 1);
});
