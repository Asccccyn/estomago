import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import {makeDb } from '../helpers.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { buildReadyReport } from '../../apps/host/src/observability/health.ts';
import { handleRequest } from '../../apps/host/src/server/http.ts';
import { ArchiveSyncService } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';

const key = 'EST_READY_TEST_KEY';
function setup(kind = 'openrouter', patch = {}) {
  const { db, root } = makeDb();
  const config = buildConfig({ openrouter: { api_key_env: key }, deepseek: { api_key_env: key }, ...patch });
  const capabilities = new CapabilityMatrix(config);
  const gate = { state: 'READY', reasons: [], manifest: null };
  let calls = 0;
  const runnerSelection = { status: 'ok', runner: { kind, interruptSupport: 'unknown', run: async () => { calls++; throw new Error('Health must not call a model'); } } };
  const report = (extra = {}) => buildReadyReport({ config, capabilities, db, gate, runnerSelection, ...extra } as any);
  return { db, root, config, capabilities, gate, runnerSelection, report, calls: () => calls };
}

for (const kind of ['openrouter','deepseek']) test(`${kind}: local readiness ignores unrelated SDK probes; disabled features remain disabled`, () => {
  process.env[key] = 'synthetic-key';
  const c = setup(kind);
  try {
    assert.equal(c.capabilities.overall(), 'unknown');
    const r = c.report();
    assert.equal(r.status, 'ready');
    assert.equal(r.components.runtime.status, 'ok');
    assert.equal(r.components.push.status, 'disabled');
    assert.equal(r.components.archive.status, 'disabled');
    delete process.env[key];
    assert.equal(c.report().components.runtime.status, 'blocked', 'removed credentials must invalidate readiness');
    assert.equal(c.calls(), 0);
  } finally { delete process.env[key]; c.db.close(); }
});

test('SDK unknown/blocked evidence remains a real readiness failure; blocked wins regardless of key ordering', () => {
  const c = setup('claude-agent-sdk');
  try {
    assert.equal(c.report().status, 'degraded');
    c.capabilities.set('complete_block_mapping_verified','blocked','synthetic-evidence');
    assert.equal(c.capabilities.overall(), 'blocked');
    assert.equal(c.report().components.runtime.status, 'blocked');
    assert.equal(c.calls(), 0);
  } finally { c.db.close(); }
});

test('identity, runner, enabled unknown push, missing archive worker and DB failure never report ready', () => {
  process.env[key] = 'synthetic-key';
  const c = setup();
  try {
    assert.equal(c.report({ gate: { state: 'BLOCKED', reasons: ['synthetic'] } }).status, 'degraded');
    assert.equal(c.report({ runnerSelection: { status: 'blocked', reasons: ['missing config'] } }).status, 'degraded');
    assert.equal(c.report({ config: buildConfig({ notifications: { remote_enabled: true } }) }).status, 'degraded');
    assert.equal(c.report({ config: buildConfig({ archive: { enabled: true } }) }).components.archive.status, 'blocked');
    const unavailable = { prepare: () => { throw new Error('private path must not escape'); } };
    assert.equal(c.report({ db: unavailable }).components.db.status, 'degraded');
  } finally { delete process.env[key]; c.db.close(); }
});

test('archive uses actual unresolved outbox; healthy configuration alone never hides unknown writes or failures', () => {
  const c = setup('openrouter', { archive: { enabled: true }, integrations: { mariposa: { base_url: 'http://127.0.0.1:1' } } });
  let calls = 0;
  const client = new MariposaClient({ transport: async () => { calls++; throw new Error('No network from health'); } });
  const logger = new Logger(path.join(c.root, 'health-logs'));
  const archive = new ArchiveSyncService({ db: c.db, client, events: new EventService(c.db), logger, config: c.config });
  try {
    assert.equal(archive.health().status, 'ok', 'local worker configured; not an upstream liveness claim');
    c.db.prepare("INSERT INTO outbox(id,operation_key,target,payload_ref,state,attempt,created_at,updated_at) VALUES ('o','o','mariposa.archive','{}','acked',1,'2026-10-21','2026-10-21')").run();
    assert.equal(archive.health().status, 'ok');
    for (const state of ['unknown_outcome','failed']) {
      c.db.prepare('UPDATE outbox SET state=? WHERE id=?').run(state,'o');
      assert.equal(archive.health().status, 'degraded');
    }
    c.db.prepare("UPDATE outbox SET state='pending',last_error=NULL WHERE id='o'").run();
    assert.equal(archive.health().status, 'ok', 'normal queue is not a failed write');
    c.db.prepare("UPDATE outbox SET last_error='HTTP_503' WHERE id='o'").run();
    assert.equal(archive.health().status, 'degraded');
    c.db.prepare("UPDATE outbox SET state='acked',last_error=NULL WHERE id='o'").run();
    assert.equal(archive.health().status, 'ok', 'verified recovery removes current degradation');
    assert.equal(calls, 0);
  } finally { logger.close(); c.db.close(); }
});

test('Mariposa readiness reports missing URL/credentials without reading them into output', () => {
  const client = new MariposaClient({ baseUrl: 'http://127.0.0.1:1', credentialEnv: key });
  delete process.env[key];
  assert.equal(client.isConfigured(), false);
  process.env[key] = 'synthetic-key';
  try {
    assert.equal(client.isConfigured(), true);
    assert.equal(new MariposaClient({ credentialEnv: key }).isConfigured(), false);
  } finally { delete process.env[key]; }
});

test('HTTP uses the report decision: healthy 200, real failures 503, disabled separately disclosed, live 200', async () => {
  process.env[key] = 'synthetic-key';
  const c = setup();
  let gate = c.gate;
  const deps = { ...c, identity: { evaluateGate: () => gate } } as any;
  const server = createServer((req,res) => { void handleRequest(req,res,deps); });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i=0;i<2;i++) {
      const r = await fetch(url+'/health/ready');
      assert.equal(r.status,200);
      assert.deepEqual(await r.json(), { ready:true,disabled:['archive','push'],degraded:[] });
    }
    gate = { state:'BLOCKED',reasons:['/private/secret/path'],manifest:null };
    const bad = await fetch(url+'/health/ready');
    assert.equal(bad.status,503);
    const body = await bad.text();
    assert.ok(!body.includes('/private/') && !body.includes('synthetic-key'));
    assert.deepEqual(JSON.parse(body).degraded,[{component:'identity',status:'blocked'}]);
    assert.equal((await fetch(url+'/health/live')).status,200);
    assert.equal(c.calls(),0);
  } finally { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); delete process.env[key];c.db.close(); }
});
