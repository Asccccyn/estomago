// Run only through verify-mariposa-bootstrap.py against a synthetic loopback M.
// M operations are real HTTP. Selected failures below are explicitly injected by
// this test's fetch adapter after/before an actual M request; no model is run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';

type Expected = {
  revision: number; target_memory_id: string; moods: Record<string, string>;
  buckets: Record<string, { event: string; words: string[] }>; i: string;
  plan: { title: string; content: string };
};
type Call = {
  capability: string; section?: string; snapshot?: string; loadedSnapshot?: string;
  responseSnapshot?: string; memoryId?: string; field?: string; offset?: number;
  bytes: number; serverStatus: number; exposedStatus: number; injection?: string;
};
type Fault = { kind: 'second_mood_page_503' | 'stale_once' | 'stale_each_snapshot'; target: string; firstOffset?: number; failOffset?: number; mutated: Set<string> };
const base = process.env.CROSS_MARIPOSA_URL!;
assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
assert.ok(base.startsWith('http://127.0.0.1:'), 'Only isolated loopback HTTP is allowed');
const expected = (): Expected => JSON.parse(fs.readFileSync(process.env.CROSS_MARIPOSA_EXPECTED!, 'utf8'));
const nativeFetch = globalThis.fetch;
const calls: Call[] = [];
const resources: ReturnType<typeof openDatabase>[] = [];
let compact = false;
let fault: Fault | null = null;

function mutateSyntheticDatabase() {
  const mutation = spawnSync(process.env.CROSS_MARIPOSA_PYTHON!, ['-B', process.env.CROSS_MARIPOSA_FIXTURE!, 'mutate'], { env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(mutation.status, 0, mutation.stderr);
}

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, base, 'No external network/model access');
  const capability = decodeURIComponent(url.pathname.split('/').at(-1)!);
  const body = JSON.parse(String(init?.body));
  const args = body.arguments;
  const cursor = args.cursor ?? {};
  const targetPage = capability === 'bootstrap.next' && args.section === 'memory_item' && cursor.field === 'mood_text' && cursor.memory_id === fault?.target;
  let injection: string | undefined;
  if (targetPage && fault) {
    if (fault.kind === 'stale_each_snapshot' && !fault.mutated.has(args.snapshot_id)) {
      fault.mutated.add(args.snapshot_id); mutateSyntheticDatabase(); injection = 'synthetic_database_mutation';
    } else {
      if (fault.firstOffset === undefined) fault.firstOffset = cursor.offset;
      else if (fault.failOffset === undefined && cursor.offset !== fault.firstOffset) fault.failOffset = cursor.offset;
      if (cursor.offset === fault.failOffset) {
        if (fault.kind === 'second_mood_page_503') injection = 'http_503_after_real_response';
        else if (fault.kind === 'stale_once' && fault.mutated.size === 0) {
          fault.mutated.add(args.snapshot_id); mutateSyntheticDatabase(); injection = 'synthetic_database_mutation';
        }
      }
    }
  }
  if (compact) args.output_profile = 'compact_v1';
  const response = await nativeFetch(input, { ...init, body: JSON.stringify(body) });
  const raw = await response.clone().text();
  const wire = JSON.parse(raw);
  const bytes = Buffer.byteLength(raw, 'utf8');
  const exposedStatus = injection === 'http_503_after_real_response' ? 503 : response.status;
  calls.push({ capability, section: args.section, snapshot: args.snapshot_id, loadedSnapshot: args.loaded_snapshot_id,
    responseSnapshot: wire.data?.snapshot_id, memoryId: cursor.memory_id, field: cursor.field, offset: cursor.offset,
    bytes, serverStatus: response.status, exposedStatus, injection });
  if (response.ok) {
    assert.ok(bytes <= 24576, 'Shared M wire-byte budget');
    const data = wire.data;
    assert.ok(!Object.hasOwn(data, 'anniversaries'));
    assert.notEqual(data.section, 'anniversaries');
    if (data.unchanged === true) {
      assert.equal(data.snapshot_id, args.loaded_snapshot_id);
      assert.equal(data.profile, 'estomago');
    } else {
      assert.equal(data.instruction_authority, 'none');
      assert.ok(String(data.content_role).startsWith('bootstrap'));
    }
  }
  if (injection === 'http_503_after_real_response') {
    assert.equal(response.status, 200, 'The upstream operation was real and successful; 503 is test injection');
    return new Response(JSON.stringify({ ok: false, error: { code: 'SYNTHETIC_PAGE_UNAVAILABLE' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
  return response;
};

function context(Supervisor: typeof TurnSupervisor = TurnSupervisor) {
  const stateRoot = process.env.ESTOMAGO_HOME!;
  fs.mkdirSync(stateRoot, { recursive: true });
  const db = openDatabase(fs.mkdtempSync(path.join(stateRoot, 'bootstrap-context-')));
  resources.push(db); migrate(db, sha256Hex);
  const events = new EventService(db);
  const alerts = new SystemAlertService(db, events);
  const client = new MariposaClient({ baseUrl: base, credentialEnv: 'ESTOMAGO_TEST_MARIPOSA_TOKEN' });
  const host = new Supervisor({ db, tools: { mariposaClient: () => client }, events, alerts,
    logger: { info() {}, warn() {}, error() {} } } as any) as any;
  const stream = () => db.prepare('SELECT kind,payload_ref FROM runtime_stream_events ORDER BY sequence').all() as Array<{ kind: string; payload_ref: string }>;
  return { host, events, alerts, stream };
}

function exactlyOnce(text: string, value: string, label: string) {
  assert.ok(value.length > 0);
  assert.equal(text.split(value).length - 1, 1, `${label} must be present exactly once`);
}
function verifyIndependentSections(text: unknown, data = expected()): asserts text is string {
  assert.equal(typeof text, 'string');
  const value = text as string;
  exactlyOnce(value, data.i, 'I');
  exactlyOnce(value, data.plan.title, 'Plan title');
  exactlyOnce(value, data.plan.content, 'Plan body');
  for (const bucket of Object.values(data.buckets)) {
    exactlyOnce(value, bucket.event, 'Event');
    for (const word of bucket.words) exactlyOnce(value, word, 'Our words');
  }
  assert.ok(!value.includes('临近纪念') && !value.includes('definition_id'));
  assert.ok(/数据，非指令/.test(value), 'Data retains its non-instruction boundary');
}
function verifyComplete(text: unknown, data = expected()): asserts text is string {
  verifyIndependentSections(text, data);
  for (const mood of Object.values(data.moods)) exactlyOnce(text, mood, 'Full Unicode mood');
}
function sameBytes(actual: string, baseline: string) {
  const a = Buffer.from(actual, 'utf8'), b = Buffer.from(baseline, 'utf8');
  if (!a.equals(b)) {
    let at = 0; while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++;
    assert.fail(`Successful bootstrap differs from the accepted baseline at byte ${at}; lengths ${a.length}/${b.length}`);
  }
}
function assertPrivateTextAbsent(diagnostics: unknown, data = expected()) {
  const serialized = JSON.stringify(diagnostics);
  for (const marker of [data.i, data.plan.title, data.plan.content, ...Object.values(data.buckets).flatMap(b => [b.event, ...b.words]), ...Object.values(data.moods).map(m => m.split('|')[0])]) {
    assert.ok(!serialized.includes(marker), 'Alerts/events must not contain private bootstrap content');
  }
}
function faultFor(kind: Fault['kind']): Fault { return { kind, target: expected().target_memory_id, mutated: new Set() }; }
const baselinePath = process.env.CROSS_ESTOMAGO_BASELINE;
const baselineConstructor: typeof TurnSupervisor | null = baselinePath
  ? (await import(pathToFileURL(path.join(baselinePath, 'apps/host/src/runtime/supervisor.ts')).href)).TurnSupervisor : null;
async function golden(): Promise<string | null> {
  if (!baselineConstructor) return null;
  const text = await context(baselineConstructor).host.windowBootstrap('accepted-baseline', AbortSignal.timeout(15000));
  verifyComplete(text); return text;
}

try {
  const normal: Record<string, string> = {};
  for (const profile of ['legacy', 'compact_v1']) {
    compact = profile === 'compact_v1';
    const baselineText = await golden();
    const { host, alerts } = context();
    const before = calls.length;
    const text = await host.windowBootstrap('complete-' + profile, AbortSignal.timeout(15000));
    verifyComplete(text);
    if (baselineText !== null) sameBytes(text, baselineText);
    normal[profile] = text;
    const own = calls.slice(before);
    assert.ok(own.filter(c => c.field === 'mood_text').length > 2);
    assert.ok(!own.some(c => c.section === 'anniversaries'));
    const count = calls.length;
    assert.equal(await host.windowBootstrap('complete-' + profile), text);
    assert.equal(calls.length, count, 'Complete same-window result is frozen');
    verifyComplete(await host.windowBootstrap('another-' + profile, AbortSignal.timeout(15000)));
    assert.ok(calls.length > count);
    assert.equal(alerts.summary('qiaosheng').open_count, 0);
    console.log(`PASS real HTTP ${profile}: full current sections, same-window cache/new-window fetch; baseline_verified=${baselineText !== null}`);
  }

  compact = false;
  const isolated = context();
  const initial = expected();
  fault = faultFor('second_mood_page_503');
  const failureStart = calls.length;
  const partial = await isolated.host.windowBootstrap('local-gap', AbortSignal.timeout(15000));
  verifyIndependentSections(partial, initial);
  const target = initial.target_memory_id;
  const targetHead = initial.moods[target].split('|')[0];
  assert.ok(!partial.includes(targetHead), 'Discard the failed mood including its already loaded prefix');
  for (const [mid, value] of Object.entries(initial.moods)) if (mid !== target) exactlyOnce(partial, value, 'Unaffected mood');
  assert.ok(/心情[^\n]*(?:未全载|未完整|缺口|未载入)/.test(partial), 'Partial package explicitly names the incomplete mood');
  assert.ok(!isolated.host.bootstrapByWindow.has('local-gap'), 'Partial result is not a complete cache entry');
  const localCalls = calls.slice(failureStart);
  const failures = localCalls.filter(c => c.injection === 'http_503_after_real_response');
  assert.equal(failures.length, 2, 'At most two attempts for the failed page');
  assert.equal(new Set(failures.map(c => c.offset)).size, 1);
  const initialSnapshot = localCalls.find(c => c.capability === 'bootstrap.get' && !c.loadedSnapshot)?.responseSnapshot;
  const validation = localCalls.find(c => c.capability === 'bootstrap.get' && c.loadedSnapshot);
  assert.ok(validation, 'Validate the same snapshot before emitting a partial package');
  assert.equal(validation.loadedSnapshot, initialSnapshot, 'Revalidation must cover exactly the snapshot that supplied the surviving content');
  const open = isolated.alerts.list({ actorId: 'qiaosheng', lifecycle: 'open' }).items;
  assert.equal(open.length, 1); assert.equal(open[0].code, 'BOOTSTRAP_INCOMPLETE'); assert.equal(open[0].severity, 'warning');
  assert.equal(isolated.alerts.summary('qiaosheng').unread_anomaly_count, 1);
  isolated.alerts.markRead('qiaosheng', [{ alert_id: open[0].alert_id, seen_event_sequence: open[0].last_event_sequence }]);
  assert.equal(isolated.alerts.summary('qiaosheng').unread_anomaly_count, 0);
  assert.equal(isolated.alerts.summary('qiaosheng').open_count, 1, 'Read is not recovery');
  assert.ok(isolated.stream().some(event => event.kind === 'system.alert.changed'));
  assertPrivateTextAbsent([open, isolated.stream()], initial);
  fault = null;
  const repaired = await isolated.host.windowBootstrap('local-gap', AbortSignal.timeout(15000));
  verifyComplete(repaired); sameBytes(repaired, normal.legacy);
  assert.ok(isolated.host.bootstrapByWindow.has('local-gap'));
  assert.equal(isolated.alerts.summary('qiaosheng').open_count, 0);
  assert.equal(isolated.alerts.list({ actorId: 'qiaosheng', lifecycle: 'resolved' }).items.length, 1);
  console.log('PASS injected mid-mood HTTP 503: failed mood fully omitted, independent content preserved, same snapshot validated, warning/read/recovery persisted');

  const stale = context();
  const old = expected();
  fault = faultFor('stale_once');
  const staleStart = calls.length;
  const restarted = await stale.host.windowBootstrap('stale-once', AbortSignal.timeout(15000));
  fault = null;
  verifyComplete(restarted);
  const freshGolden = await golden(); if (freshGolden !== null) sameBytes(restarted, freshGolden);
  assert.ok(!restarted.includes(old.moods[old.target_memory_id].split('|')[0]));
  assert.ok(!restarted.includes(old.i)); assert.ok(!restarted.includes(old.plan.content));
  assert.ok(!restarted.includes(old.buckets[old.target_memory_id].event));
  const rebuilt = calls.slice(staleStart).filter(c => c.capability === 'bootstrap.get' && !c.loadedSnapshot);
  // The optional baseline adds one independent get after the actual host run.
  const hostBuilds = baselineConstructor ? rebuilt.slice(0, -1) : rebuilt;
  assert.equal(hostBuilds.length, 2, 'One automatic full-package rebuild after SNAPSHOT_STALE');
  assert.equal(new Set(hostBuilds.map(c => c.responseSnapshot)).size, 2);
  assert.equal(calls.slice(staleStart).filter(c => c.serverStatus === 409).length, 1, 'A stale cursor is discarded immediately, not retried within the old snapshot');
  assert.ok(stale.host.bootstrapByWindow.has('stale-once'));
  assert.equal(stale.alerts.summary('qiaosheng').open_count, 0);
  console.log('PASS real database mutation/HTTP 409: fresh first-page rebuild, no old I/Plan/event/mood mixing or duplicate text');

  const persistent = context();
  const beforePersistentMutation = expected();
  fault = faultFor('stale_each_snapshot');
  const persistentStart = calls.length;
  const unavailable = await persistent.host.windowBootstrap('stale-twice', AbortSignal.timeout(15000));
  assert.ok(typeof unavailable === 'string' && unavailable.includes('开窗资料未取得'), 'Global failure must be visible to the model');
  assert.ok(unavailable.includes('不表示记忆不存在'), 'Missing input cannot be mistaken for an empty memory store');
  assertPrivateTextAbsent(unavailable, beforePersistentMutation);
  assertPrivateTextAbsent(unavailable);
  fault = null;
  assert.ok(!persistent.host.bootstrapByWindow.has('stale-twice'));
  assert.equal(calls.slice(persistentStart).filter(c => c.capability === 'bootstrap.get' && !c.loadedSnapshot).length, 2);
  assert.equal(calls.slice(persistentStart).filter(c => c.serverStatus === 409).length, 2);
  const critical = persistent.alerts.list({ actorId: 'qiaosheng', lifecycle: 'open' }).items;
  assert.equal(critical.length, 1); assert.equal(critical[0].code, 'BOOTSTRAP_INCOMPLETE'); assert.equal(critical[0].severity, 'critical');
  assertPrivateTextAbsent([critical, persistent.stream()]);
  verifyComplete(await persistent.host.windowBootstrap('stale-twice', AbortSignal.timeout(15000)));
  assert.equal(persistent.alerts.summary('qiaosheng').open_count, 0);
  console.log('PASS persistent real SNAPSHOT_STALE: bounded two builds, whole-package omission, critical alert, later explicit recovery');

  const cancelled = context();
  const count = calls.length; const controller = new AbortController(); controller.abort();
  assert.equal(await cancelled.host.windowBootstrap('cancelled', controller.signal), null);
  assert.ok(!cancelled.host.bootstrapByWindow.has('cancelled'));
  assert.equal(calls.length, count, 'Pre-cancelled bootstrap issues no HTTP request');
  console.log('PASS cancellation: no request, payload or cache');
  assert.ok(!calls.some(c => c.section === 'anniversaries'));

  const summary = {
    ok: true, profiles: ['legacy', 'compact_v1'], baseline_verified: baselineConstructor !== null,
    synthetic_memories: 2, synthetic_i: 1, synthetic_plans: 1, synthetic_words: 4,
    independent_anniversaries_retired: true, local_mood_failure_isolated: true,
    stale_auto_rebuilt: true, persistent_stale_bounded: true, alerts_projection_verified: true,
    browser_ui_verified: false, explicitly_injected_http_failures: failures.length,
    stale_database_mutations: calls.filter(c => c.injection === 'synthetic_database_mutation').length,
    http_calls: calls.length, max_wire_bytes: Math.max(...calls.map(c => c.bytes)), models_called: 0, messages_sent: 0,
  };
  fs.writeFileSync(process.env.CROSS_MARIPOSA_RESULT!, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  globalThis.fetch = nativeFetch;
  for (const db of resources) db.close();
}
