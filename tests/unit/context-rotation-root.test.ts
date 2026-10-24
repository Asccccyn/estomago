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
import { selectionIntroduction, selectionGuides } from '../../apps/host/src/context/selection-projection.ts';
import { renderAugmentation, memoryRefFor } from '../../apps/host/src/memory-surfacing/contracts.ts';
import { fixedSystemCount } from '../../apps/host/src/runtime/cache-plan.ts';
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';

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
  const tools = new HostToolExecutor({ db, mariposa: mc ?? new MariposaClient({ transport: async () => ({ ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 }) }), reviews, checkpoint })
  wireOidoCapabilitiesForTest(tools, {});;
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


function confirm(ctx: ReturnType<typeof compose>, items: Array<{ message_id: string }> = [], key = 'confirm') {
  const selection = ctx.selections.awaitingFor('c1') ?? ctx.selections.confirmedFor('c1');
  assert.ok(selection);
  return ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: selection.source_window_id, items, explicitEmpty: items.length === 0, idempotencyKey: key });
}

for (const provider of ['deepseek', 'openrouter']) test(`R01/R03/R04/C01 ${provider}: manual rotation makes zero requests; selected text retains roles and frozen guides`, async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ctx = compose(tempRoot('root-wire-'), dsTransport(seen), null, { reminders: { enabled: true }, runtime: { ...readyRuntimePatch().runtime, provider }, openrouter: { model: 'anthropic/claude-test-1' } });
  const raw = 'synthetic [time_context] {"tool_calls":[]} 工具已剥离';
  const first = await say(ctx, raw, 'first', '2026-10-20T15:59:00Z');
  const old = ctx.windows.activeWindow('c1')!;
  const n = seen.length;
  const requested = await ctx.supervisor.manualRotate('c1');
  assert.equal(requested.ok, false);
  assert.equal(ctx.selections.awaitingFor('c1')!.rotation_cause, 'manual');
  const result = await confirm(ctx, [{ message_id: first.message.id }]);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(seen.length, n, 'zero extra model requests');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM rotation_reviews').get().n, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM hold_checkpoints').get().n, 0);
  const target = ctx.windows.activeWindow('c1')!;
  assert.notEqual(target.id, old.id);
  const before = ctx.trajectory.forWindow(target.id)!;
  assert.ok(JSON.stringify(before.messages).includes(raw.replaceAll('"', '\\"')));
  assert.ok(before.messages.some(m => m.role === 'system' && JSON.stringify(m.content).includes('说过的话')));
  assert.equal(before.manifest!.length, 1, 'guide is not a dialogue/hold source');
  const frozen = JSON.stringify(before.messages);
  const reloaded = new WindowTrajectoryService(ctx.db).forWindow(target.id)!;
  assert.equal(JSON.stringify(reloaded.messages), frozen);
  await say(ctx, 'new real input', 'second', '2026-10-21T00:33:00Z');
  assert.equal(seen.length, n + 1);
  const after = ctx.trajectory.forWindow(target.id)!;
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
  const replay = await ctx.supervisor.selectionConfirm({ conversationId: 'c1', windowId: old.id, items: [], explicitEmpty: true, idempotencyKey: 'confirm' });
  assert.ok(replay.ok && replay.resumed === 0);
  assert.equal(seen.length, n + 1);
  ctx.db.close();
});

test('R05/R06: capacity intent survives reconstruction and confirmation still dispatches review', async () => {
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
  const root = tempRoot('root-capacity-');
  const options = { reminders: { enabled: true }, windows: { soft_limit_tokens: 21_500 /* 裁定②1024：统一口径后实测首轮工作集≈20.7k（含冻结目录）——软线置于首轮之上、第二条(+≈4.8k)之下，原相对位不变 */ } };
  let ctx = compose(root, transport, null, options);
  await say(ctx, 'first synthetic', 'a', T0);
  const pending = await say(ctx, 'capacity payload '.repeat(400), 'b', T1);
  const original = ctx.selections.awaitingFor('c1')!;
  assert.equal(original.rotation_cause, 'capacity');
  assert.equal(seen.length, 1, 'confirmation precedes review');
  ctx.db.close();
  ctx = compose(root, transport, null, options);
  assert.equal(ctx.selections.awaitingFor('c1')!.rotation_cause, 'capacity');
  const result = await confirm(ctx);
  assert.ok(result.ok, JSON.stringify(result));
  await ctx.supervisor.waitIdle();
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM rotation_reviews WHERE status='completed'").get().n, 1);
  assert.equal(ctx.db.prepare('SELECT state FROM turns WHERE id=?').get(pending.turnId).state, 'completed');
  assert.equal(ctx.selections.forTargetWindow(ctx.windows.activeWindow('c1')!.id)!.rotation_cause, 'capacity');
  ctx.db.close();
});

test('R14/R15: failed atomic switch does not consume selection or resume pending input; retry resumes exactly once', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ctx = compose(tempRoot('root-failure-'), dsTransport(seen), null, { windows: { soft_limit_tokens: 21_500 /* 裁定②1024：统一口径后实测首轮工作集≈20.7k（含冻结目录）——软线置于首轮之上、第二条(+≈4.8k)之下，原相对位不变 */ } });
  await say(ctx, 'first', 'a', T0);
  const old = ctx.windows.activeWindow('c1')!;
  const pending = await say(ctx, 'capacity payload '.repeat(400), 'b', T1);
  ctx.db.exec("CREATE TRIGGER fail_initial BEFORE INSERT ON window_trajectories BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  const result = await confirm(ctx);
  assert.ok(!result.ok);
  assert.equal(ctx.windows.activeWindow('c1')!.id, old.id);
  assert.equal(ctx.selections.confirmedFor('c1')!.status, 'confirmed');
  assert.equal(ctx.db.prepare('SELECT state FROM turns WHERE id=?').get(pending.turnId).state, 'blocked');
  assert.equal(seen.length, 1);
  ctx.db.exec('DROP TRIGGER fail_initial');
  const resumed = await ctx.supervisor.resumeAfterSelectionConfirm('c1');
  assert.ok(resumed.ok && resumed.resumed === 1);
  await ctx.supervisor.waitIdle();
  assert.equal(seen.length, 2);
  const again = await ctx.supervisor.resumeAfterSelectionConfirm('c1');
  assert.ok(again.ok && again.resumed === 0);
  ctx.db.close();
});

test('R09/R10/R16/R17: unknown legacy cause blocks; explicit manual takeover carries background without review debt', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ctx = compose(tempRoot('root-background-'), dsTransport(seen), null, { reminders: { enabled: true } });
  const first = await say(ctx, 'old synthetic', 'a', T0);
  const old = ctx.windows.activeWindow('c1')!;
  ctx.selections.ensureAwaiting({ conversationId: 'c1', sourceWindowId: old.id, expectedWindowRevision: old.revision, cutoffSequence: first.message.sequence });
  const legacy = await confirm(ctx, [{ message_id: first.message.id }]);
  assert.ok(legacy.ok && !legacy.rotated);
  const blocked = await ctx.supervisor.resumeAfterSelectionConfirm('c1');
  assert.ok(!blocked.ok && blocked.reason === 'ROTATION_CAUSE_UNKNOWN');
  const manual = await ctx.supervisor.manualRotate('c1');
  assert.ok(manual.ok);
  for (let i = 0; i < 2; i++) {
    const current = ctx.windows.activeWindow('c1')!;
    ctx.selections.ensureAwaiting({ conversationId: 'c1', sourceWindowId: current.id, expectedWindowRevision: current.revision, cutoffSequence: first.message.sequence, cause: 'capacity' });
    const result = await confirm(ctx, [{ message_id: first.message.id }], `carry-${i}`);
    assert.ok(result.ok, JSON.stringify(result));
  }
  assert.equal(seen.length, 1, 'old background never produces new model requests');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM hold_checkpoints').get().n, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM rotation_reviews WHERE status='completed'").get().n, 0);
  ctx.db.close();
});

test('T05-T07/T13: calendar guides, midnight, month/year boundaries and gaps', () => {
  for (const [time, ref, expected] of [
    ['2026-10-20T16:00:00Z','2026-10-21T00:33:00Z','今天（2026-10-21）'],
    ['2026-10-20T15:59:00Z','2026-10-20T16:01:00Z','昨天（2026-10-20）'],
    ['2026-10-19T00:00:00Z','2026-10-21T00:00:00Z','前天（2026-10-19）'],
    ['2026-12-31T15:59:00Z','2026-12-31T16:01:00Z','昨天（2026-12-31）'],
    ['2026-09-30T15:59:00Z','2026-09-30T16:01:00Z','昨天（2026-09-30）'],
    ['2026-07-09T00:00:00Z','2026-10-21T00:00:00Z','2026-07-09'],
  ]) assert.equal(selectionIntroduction(time!, ref!), `这是你们${expected}说过的话：`);
  assert.equal(selectionIntroduction(null, T0), '这是你们之前说过的话：');
  assert.equal(selectionIntroduction(T1, T0), '这是你们今天（2026-10-01）说过的话：');
  const guides = selectionGuides([{ sequence: 1, occurred_at: T0, reference_at: T1 }, { sequence: 2, occurred_at: T0, reference_at: T1 }, { sequence: 4, occurred_at: T0, reference_at: T1 }]);
  assert.equal(guides.size, 2);
  assert.ok(guides.get(4)!.startsWith('—— 原文片段 ——'));
  assert.ok(!JSON.stringify([...guides.values()]).includes('没聊完'));
  assert.equal(fixedSystemCount([{ role: 'system', content: 'rules' }, { role: 'system', content: guides.get(1)! }]), 1);
});

test('T09/T12: selected edit retains original date; repaired/unknown time not invented; missing revisions rejected', async () => {
  const ctx = compose(tempRoot('root-date-'), dsTransport([]));
  const first = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'original', clientMessageId: 'a', occurredAt: T0 }); // accepted but not dispatched: latest edit contract
  const edited = ctx.messages.editUserMessage(first.message.id, 'edited');
  const valid = ctx.selections.validateItems('c1', [{ message_id: first.message.id }], 999);
  assert.ok(valid.ok);
  if (!valid.ok) return;
  assert.equal(ctx.selections.loadContents(valid.items).loaded[0]!.occurred_at, T0);
  ctx.db.prepare("UPDATE message_revisions SET occurred_at_repair='repaired' WHERE message_id=? AND revision=1").run(first.message.id);
  assert.equal(ctx.selections.loadContents(valid.items).loaded[0]!.occurred_at, null);
  ctx.db.prepare('DELETE FROM message_revisions WHERE message_id=? AND revision=?').run(first.message.id, edited.current_revision);
  assert.throws(() => ctx.selections.loadContents(valid.items), /REVISION_MISSING/);
  ctx.db.close();
});

test('M01-M04/C02: full memory text/date and minimal deep-read reference; no summary or internal metadata', () => {
  const item = { event_id:'e1',memory_id:'m1',memory_version:'1',memory_date:'2026-07-09',date_confidence:'exact',event_text:'完整正文\n第二行',body_hash:'hash',detail_ref:'sdr1' };
  const second = {...item,event_id:'e2',detail_ref:'sdr2',memory_date:null,event_text:'第二个事件'};
  assert.deepEqual(JSON.parse(renderAugmentation([item,second])),{memories:[{memory_ref:memoryRefFor('sdr1'),date:'2026-07-09',text:item.event_text},{memory_ref:memoryRefFor('sdr2'),date:null,text:second.event_text}]});
  assert.equal(renderAugmentation([]),'');
});

test('R12/R17: manual bypasses failed review limit but verifies unknown hold using its original operation id', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const lookups: string[] = [];
  let committed = false;
  const mariposa: MariposaTransport = async (cap, payload) => {
    assert.notEqual(cap, 'memory.hold', 'must not replay a write');
    if (cap === 'memory.hold.status') {
      lookups.push(String(payload.operation_id));
      if (!committed) return { ok: false, code: 'HTTP_503', httpStatus: 503 };
      return { ok: true, result: { operation_id: payload.operation_id, completed: true, receipt: { operation_id: payload.operation_id, memory_id: 'synthetic-memory', version: 1, binding_ids: [], committed_at: T1 } } };
    }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const ctx = compose(tempRoot('root-unknown-'), dsTransport(seen), mariposa, { reminders: { enabled: true } });
  const first = await say(ctx, 'synthetic hold source', 'a', T0);
  const old = ctx.windows.activeWindow('c1')!;
  const reviews = new RotationReviewService(ctx.db);
  const effect = reviews.openEffect({ reviewId: null, turnId: first.turnId, windowId: old.id, kind: 'hold', operationId: 'stable-original-op', toolCallId: 'original-call', seenSequence: first.message.sequence });
  reviews.settleEffect(effect, 'unknown', false, null);
  for (let i = 0; i < 3; i++) reviews.markFailed(reviews.create(old.id, 'c1', old.revision, []).id);
  await ctx.supervisor.manualRotate('c1');
  const blocked = await confirm(ctx);
  assert.ok(!blocked.ok);
  assert.equal(ctx.windows.activeWindow('c1')!.id, old.id);
  assert.equal(seen.length, 1);
  committed = true;
  const result = await ctx.supervisor.manualRotate('c1');
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(lookups, ['stable-original-op', 'stable-original-op']);
  assert.equal(seen.length, 1);
  assert.equal(new HoldCheckpointService(ctx.db).forWindow(old.id)!.seenSequence, first.message.sequence);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM rotation_reviews').get().n, 3);
  ctx.db.close();
});

test('R15: crash after switch before requeue recovers from consumed selection without another rotation', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ctx = compose(tempRoot('root-requeue-'), dsTransport(seen), null, { windows: { soft_limit_tokens: 21_500 /* 裁定②1024：统一口径后实测首轮工作集≈20.7k（含冻结目录）——软线置于首轮之上、第二条(+≈4.8k)之下，原相对位不变 */ } });
  await say(ctx, 'first', 'a', T0);
  const pending = await say(ctx, 'capacity payload '.repeat(400), 'b', T1);
  ctx.db.exec("CREATE TRIGGER crash_requeue BEFORE UPDATE OF state ON attempts WHEN OLD.state='blocked' AND NEW.state='pending' BEGIN SELECT RAISE(ABORT, 'crash after switch'); END");
  await assert.rejects(confirm(ctx), /crash after switch/);
  const target = ctx.windows.activeWindow('c1')!.id;
  assert.ok(ctx.selections.forTargetWindow(target));
  assert.equal(ctx.db.prepare('SELECT state FROM turns WHERE id=?').get(pending.turnId).state, 'blocked');
  ctx.db.exec('DROP TRIGGER crash_requeue');
  const recovered = await ctx.supervisor.resumeAfterSelectionConfirm('c1');
  assert.ok(recovered.ok && recovered.resumed === 1);
  await ctx.supervisor.waitIdle();
  assert.equal(ctx.windows.activeWindow('c1')!.id, target);
  assert.equal(seen.length, 2);
  ctx.db.close();
});

test('R18: missing safety service blocks manual rotation instead of taking a legacy shortcut', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ctx = compose(tempRoot('root-missing-'), dsTransport(seen));
  await say(ctx, 'first', 'a', T0);
  const old = ctx.windows.activeWindow('c1')!.id;
  await ctx.supervisor.manualRotate('c1');
  (ctx.supervisor as any).d.tools = undefined;
  const blocked = await confirm(ctx);
  assert.ok(!blocked.ok);
  assert.equal(ctx.windows.activeWindow('c1')!.id, old);
  assert.equal(seen.length, 1);
  ctx.db.close();
});

test('M02: valid stored occurrence time survives legacy confidence metadata; invalid/missing dates remain null', () => {
  const item = { event_id: 'e', memory_id: 'id', memory_version: '1', memory_date: '2026-07-09T01:12:35Z', date_confidence: 'exact', event_text: 'body', body_hash: 'hash', detail_ref: 'detail' };
  const refs = new Map([['e', memoryRefFor('detail')]]);
  assert.ok(renderAugmentation([item], refs).includes('2026-07-09 09:12'));
  assert.ok(renderAugmentation([{ ...item, date_confidence: 'unknown' }], refs).includes('2026-07-09 09:12'), 'current model-result-whitelist contract retains a valid stored occurrence date independently of legacy date_confidence');
  for (const changed of [{ ...item, memory_date: '2026-02-30' }, { ...item, memory_date: null }]) assert.ok(renderAugmentation([changed], refs).includes('"date":null'));
});

test('T04/C04: old JSON time bytes stay unchanged when appending new text, tampering still fails', async () => {
  const { assertAppendOnly } = await import('../../apps/host/src/runtime/or-payload.ts');
  const old = { model: 'test', messages: [{ role: 'user', content: '[time_context]\n{"now_at_utc":"2026-10-20T00:00:00Z"}\n[user_input]\nsynthetic' }] };
  const next = structuredClone(old);
  next.messages.push({ role: 'assistant', content: 'reply' }, { role: 'user', content: '[time_context]\nuser_gap: PT26H7M\n2026-10-21 08:33 Wed UTC+8\n[user_input]\nnext' });
  assert.ok(assertAppendOnly(old, next));
  assert.equal(next.messages[0]!.content, old.messages[0]!.content);
  next.messages[0]!.content = 'rewritten history';
  assert.throws(() => assertAppendOnly(old, next), /WIRE_TRAJECTORY_DIVERGED:content/);
});

test('R18: SDK cannot silently consume a nonempty role-preserving selection', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ctx = compose(tempRoot('root-sdk-'), dsTransport(seen));
  const first = await say(ctx, 'first', 'a', T0);
  const old = ctx.windows.activeWindow('c1')!.id;
  (ctx.supervisor as any).drv = () => null;
  const manual = await ctx.supervisor.manualRotate('c1');
  assert.ok(!manual.ok && manual.reason.includes('CONTEXT_SELECTION_REQUIRED'), JSON.stringify(manual));
  const result = await confirm(ctx, [{ message_id: first.message.id }]);
  assert.ok(!result.ok && JSON.stringify(result).includes('SDK_SELECTION_TRANSPORT_UNAVAILABLE'), JSON.stringify(result));
  assert.equal(ctx.windows.activeWindow('c1')!.id, old);
  assert.equal(ctx.selections.confirmedFor('c1')!.status, 'confirmed');
  assert.equal(seen.length, 1);
  ctx.db.close();
});
