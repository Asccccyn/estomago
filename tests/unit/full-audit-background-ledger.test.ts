import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeDb } from '../helpers.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { settleBackgroundDispatch, settleBackgroundRun } from '../../apps/host/src/runtime/background-ledger.ts';

function fixture(t: TestContext) {
  const { db, root } = makeDb(); t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const started = '2026-10-23T15:59:00.000Z';
  new MessageService(db).ensureConversation('primary');
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('window','primary','ACTIVE',?,?)").run(started, started);
  db.prepare("INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,reserved_cost_micro_usd,created_at,updated_at) VALUES ('run','task','primary','jiaming','autonomous',1,'wake:task:1','running',100000,?,?)").run(started, started);
  db.prepare("INSERT INTO background_dispatches(id,run_id,logical_action_key,attempt_no,dispatch_kind,state,budget_day,reserved_cost_micro_usd,dispatch_started_at,created_at) VALUES ('dispatch','run','model:1',1,'model','reserved','2026-10-23',100000,?,?)").run(started, started);
  db.prepare("INSERT INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,background_run_id,background_dispatch_id,dispatch_started_at,sent_at,created_at) VALUES ('request','window','attempt','turn','proactive_turn','[]','{}','run','dispatch',?,'2026-10-23T16:01:00.000Z',?)").run(started, started);
  const collector = new UsageCollector(db);
  const record = (cost?: number, completeness: 'partial' | 'complete' = 'complete', scope: 'request' | 'turn' | 'cumulative' = 'request') => collector.record({ turnId: 'turn', attemptId: 'attempt', requestId: 'request', model: 'synthetic-model', windowId: 'window', source: 'ds_stream', completeness, scope, usage: { input_tokens: 100, output_tokens: 10, ...(cost !== undefined ? { cost_usd: cost } : {}) } });
  const dispatch = () => db.prepare("SELECT state,actual_cost_micro_usd,provider_request_id,budget_day FROM background_dispatches WHERE id='dispatch'").get() as { state: string; actual_cost_micro_usd: number | null; provider_request_id: string; budget_day: string };
  const run = () => db.prepare("SELECT known_cost_micro_usd,reserved_cost_micro_usd,unknown_cost_count FROM background_runs WHERE id='run'").get() as { known_cost_micro_usd: number; reserved_cost_micro_usd: number; unknown_cost_count: number };
  return { db, collector, record, dispatch, run, started };
}

test('F-B01 actual usage collector settles late known cost after unknown; repeats and final sweep do not double charge', t => {
  const f = fixture(t);
  f.record(); assert.equal(f.dispatch().state, 'unknown'); assert.equal(f.run().reserved_cost_micro_usd, 100000);
  f.record(0.08); assert.equal(f.dispatch().state, 'settled'); assert.equal(f.dispatch().actual_cost_micro_usd, 80000);
  assert.equal(f.dispatch().provider_request_id, 'request');
  assert.deepEqual({ ...f.run() }, { known_cost_micro_usd: 80000, reserved_cost_micro_usd: 0, unknown_cost_count: 0 });
  f.record(0.08); f.record(); settleBackgroundRun(f.db, 'run');
  assert.equal(f.run().known_cost_micro_usd, 80000);
  assert.equal((f.db.prepare("SELECT cost_usd FROM usage_observations WHERE request_id='request'").get() as { cost_usd: number }).cost_usd, 0.08, 'complete duplicate missing cost cannot erase known cost');
  f.record(0.09); assert.equal(f.run().known_cost_micro_usd, 80000, 'conflicting complete receipt cannot overwrite trusted cost');
});

test('F-B02 background usage binds actual run and dispatch-start Shanghai day across midnight', t => {
  const f = fixture(t); f.record(0.08);
  const usage = f.db.prepare("SELECT background_run_id,purpose,budget_day,dispatch_started_at,legacy_observed_at FROM usage_observations WHERE request_id='request'").get() as Record<string, unknown>;
  assert.deepEqual({ ...usage }, { background_run_id: 'run', purpose: 'proactive_turn', budget_day: '2026-10-23', dispatch_started_at: f.started, legacy_observed_at: 0 });
  assert.equal(f.dispatch().budget_day, '2026-10-23');
});

test('F-B03 turn/cumulative or partial amounts never settle one model request; unknown external tool cost remains unknown', t => {
  const f = fixture(t); f.record(9, 'complete', 'turn'); f.record(99, 'complete', 'cumulative'); f.record(undefined, 'partial');
  assert.equal(f.dispatch().state, 'unknown'); assert.equal(f.run().reserved_cost_micro_usd, 100000);
  f.db.prepare("INSERT INTO background_dispatches(id,run_id,logical_action_key,attempt_no,dispatch_kind,state,budget_day,reserved_cost_micro_usd,created_at) VALUES ('external','run','external:1',1,'tool','reserved','2026-10-23',20000,?)").run(f.started);
  settleBackgroundRun(f.db, 'run');
  const external = f.db.prepare("SELECT state,actual_cost_micro_usd FROM background_dispatches WHERE id='external'").get() as Record<string, unknown>;
  assert.deepEqual({ ...external }, { state: 'unknown', actual_cost_micro_usd: null }); assert.equal(f.run().reserved_cost_micro_usd, 120000);
});

test('F-B04 terminal settlement CAS cannot release twice or replace actual with unknown; invalid charges reject', t => {
  const f = fixture(t);
  assert.throws(() => settleBackgroundDispatch(f.db, 'dispatch', { actualCostMicroUsd: -1, outcomeCode: 'bad' }), /SETTLEMENT_INVALID/);
  assert.equal(settleBackgroundDispatch(f.db, 'dispatch', { actualCostMicroUsd: 80000, outcomeCode: 'settled' }), true);
  assert.equal(settleBackgroundDispatch(f.db, 'dispatch', { actualCostMicroUsd: 80000, outcomeCode: 'repeat' }), false);
  assert.equal(settleBackgroundDispatch(f.db, 'dispatch', { actualCostMicroUsd: null, outcomeCode: 'late-unknown' }), false);
  assert.equal(f.run().known_cost_micro_usd, 80000); assert.equal(f.run().reserved_cost_micro_usd, 0);
});
