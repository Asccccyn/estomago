// AUD-08/09/29 回归（自包含，避免跨目录 helpers 导入的 node 剥离器怪癖）：
// 大规模回放追平（1005/3005）、Last-Event-ID 优先、回放-实时无空洞、慢客户端背压断开。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
process.env.ESTOMAGO_TEST_MODE = '1';

const { openDatabase } = await import('../../apps/host/src/db/connection.ts');
const { migrate } = await import('../../apps/host/src/db/migrations.ts');
const { EventService } = await import('../../apps/host/src/events/service.ts');
const { buildConfig } = await import('../../apps/host/src/config/schema.ts');
const { IdentityService } = await import('../../apps/host/src/identity/service.ts');
const { REQUIRED_PROBES, defaultObservedSdkVersion } = await import('../../apps/host/src/identity/service.ts');
const { buildPaths } = await import('../../apps/host/src/config/paths.ts');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tempRoot = (p = 'aud08-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const OBSERVED = defaultObservedSdkVersion();

function seedIdentity(root: string): void {
  const paths = buildPaths(root);
  for (const d of [paths.configDir, paths.identityDir, paths.workspacesDir]) fs.mkdirSync(d, { recursive: true });
  const text = '（回归测试）经批准身份正文';
  fs.writeFileSync(path.join(paths.identityDir, 'approved-identity.md'), text);
  fs.writeFileSync(path.join(paths.configDir, 'identity-manifest.json'), JSON.stringify({
    display_name: 'estómago', spec_version: '0.2.1', status: 'APPROVED', identity_version: 'test-v1',
    approved_source_ref: 'approved-identity.md', approved_source_hash: sha256(text),
    i_version: 'test-i-1', runtime_rules_version: 'test-rules-1', system_prompt_mode: 'explicit_custom',
    system_prompt_hash: sha256(text), sdk_version: OBSERVED, runtime_version: 'node-test',
    cwd_realpath: fs.realpathSync(paths.workspacesDir), settings_sources: [], effective_model: null,
    effective_tools: [], effective_mcp_servers: null, managed_policy_summary: null,
    verification_evidence: [], requested_builtin_tools: [], requested_settings_sources: [], bootstrap_receipt_ref: null,
  }));
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256);
  for (const key of REQUIRED_PROBES) {
    db.prepare('INSERT OR REPLACE INTO capability_probes(id, probe_key, state, sdk_version, evidence_ref, observed_at) VALUES (?,?,?,?,?,?)')
      .run('prb_' + randomBytes(4).toString('hex'), key, 'supported', OBSERVED, 'test', new Date().toISOString());
  }
  db.close();
}

async function bootSeeded(count: number, port: number) {
  const root = tempRoot();
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256);
  const events = new EventService(db);
  for (let i = 0; i < count; i++) events.publish('message.persisted', { conversationId: null, payload: { i } });
  db.close();
  seedIdentity(root);
  const { Host } = await import('../../apps/host/src/app-context.ts');
  const config = buildConfig({
    deployment: { port },
    runtime: { model: 'fixture-model', sdk_version: OBSERVED, runtime_version: 'node-test', auth_and_billing_verified: true, capability_state: 'verified' },
  });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port });
  await host.start();
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  return { host, port: host.port, token, count, root };
}

async function readIds(port: number, token: string, opts: { cursor?: number; lastEventId?: number; collectMs?: number } = {}) {
  const { cursor = 0, lastEventId, collectMs = 3000 } = opts;
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/events?cursor=${cursor}&token=${encodeURIComponent(token)}`, {
    headers: lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {}, signal: ctrl.signal,
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const ids: number[] = [];
  const start = Date.now();
  try {
    while (Date.now() - start < collectMs) {
      const r = await Promise.race([reader.read(), new Promise<{ timeout: true }>((r2) => setTimeout(() => r2({ timeout: true }), 250))]);
      if ('done' in r && r.done) break;
      if ('value' in r && r.value) {
        buf += dec.decode(r.value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith('id: ')) ids.push(Number(line.slice(4)));
        }
      }
    }
  } catch { /* aborted */ }
  ctrl.abort();
  return ids;
}

test('AUD-08：1005 条全量回放（分页追平，不丢尾）', async () => {
  const { host, port, token, count } = await bootSeeded(1005, 0);
  const ids = await readIds(port, token, { cursor: 0 });
  assert.equal(ids.length, count, `应收到全部 ${count} 条，实际 ${ids.length}`);
  assert.ok(ids.every((v, i) => i === 0 || v > ids[i - 1]), '严格递增');
  await host.stop();
});

test('AUD-08：3005 条全量回放 + 回放期间 live 事件无空洞', async () => {
  const { host, port, token, count } = await bootSeeded(3005, 0);
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/events?cursor=0&token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const ids: number[] = [];
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith('id: ')) ids.push(Number(line.slice(4)));
        }
      }
    } catch { /* aborted */ }
  })();
  await sleep(600); // 客户端回放进行中
  const post = await fetch(`http://127.0.0.1:${port}/api/v1/conversations/primary/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'live 探针', client_message_id: 'live-aud08' }),
  });
  assert.equal(post.status, 201);
  await sleep(3000);
  ctrl.abort();
  await pump;
  const set = new Set(ids);
  const expectedMax = count + 2; // persisted + turn.started
  for (let i = 1; i <= expectedMax; i++) assert.ok(set.has(i), `sequence ${i} 不得缺失（空洞检查）`);
  assert.equal(ids.length, new Set(ids).size, '不得重复');
  await host.stop();
});

test('AUD-09：Last-Event-ID 优先于 query cursor', async () => {
  const { host, port, token } = await bootSeeded(50, 0);
  const ids = await readIds(port, token, { cursor: 0, lastEventId: 40, collectMs: 1500 });
  assert.equal(ids[0], 41, '应从 Last-Event-ID+1 开始');
  await host.stop();
});

test('AUD-29：完全不读的慢客户端被服务端断开（待发字节上限）', async () => {
  const root = tempRoot('aud29-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256);
  const events = new EventService(db);
  const blob = 'z'.repeat(48 * 1024);
  for (let i = 0; i < 400; i++) events.publish('message.persisted', { conversationId: null, payload: { blob } }); // ~19MB
  db.close();
  seedIdentity(root);
  const { Host } = await import('../../apps/host/src/app-context.ts');
  const config = buildConfig({
    deployment: { port: 0 },
    runtime: { model: 'fixture-model', sdk_version: OBSERVED, runtime_version: 'node-test', auth_and_billing_verified: true, capability_state: 'verified' },
  });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  const outcome = await new Promise((resolve) => {
    const sock = net.connect(host.port, '127.0.0.1');
    sock.on('connect', () => sock.write(`GET /api/v1/events?cursor=0&token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: x\r\n\r\n`));
    sock.on('data', () => {});
    sock.on('close', () => resolve('closed'));
    sock.on('end', () => resolve('ended'));
    setTimeout(() => resolve('timeout'), 20000);
  });
  assert.ok(outcome === 'closed' || outcome === 'ended', `慢客户端应被服务端断开（实际 ${outcome}）`);
  await host.stop();
});
