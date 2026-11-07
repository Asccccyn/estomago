import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { MemoryToolsService } from '../../apps/host/src/modules/memory/service.ts';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity, pollUntil } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const base = process.env.CROSS_MARIPOSA_URL!;
assert.ok(base.startsWith('http://127.0.0.1:'));
const nativeFetch = globalThis.fetch;

async function world(root: string, seed = true) {
  if (seed) writeApprovedIdentity(root);
  const patch = readyRuntimePatch();
  const config = buildConfig({ ...patch, runtime: { ...patch.runtime as object, provider: 'mock' }, archive: { enabled: false },
    integrations: { mariposa: { base_url: base, credential_ref: 'ESTOMAGO_TEST_MARIPOSA_TOKEN' } } });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  host.messages.ensureConversation('primary');
  const window = host.windows.activeWindow('primary') ?? host.windows.createWindow({ conversationId: 'primary', gate: host.identity.evaluateGate(host.db) }).window;
  const client = new MariposaClient({ baseUrl: base, credentialEnv: 'ESTOMAGO_TEST_MARIPOSA_TOKEN' });
  const reviews = new RotationReviewService(host.db), checkpoint = new HoldCheckpointService(host.db);
  const { tools } = assembleTestTools({ db: host.db, messages: host.messages, mariposa: client, reviews, checkpoint });
  const memory = new MemoryToolsService({ db: host.db, mariposa: client, reviews, checkpoint });
  return { host, client, reviews, tools, memory, windowId: window.id };
}
type World = Awaited<ReturnType<typeof world>>;
function context(w: World, id: string) {
  const sub = w.host.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: 'synthetic recovery request', clientMessageId: id });
  return { roomId: 'primary', windowId: w.windowId, turnId: sub.turnId, requestId: id, toolCallId: id,
    purpose: 'chat' as const, activeReviewId: null, seenSequence: sub.message.sequence, seenMessages: [{ id: sub.message.id, revision: sub.message.revision }] };
}
function loseResponse(capability: string, observe: (response: Response) => Promise<void>) {
  let lost = false;
  globalThis.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    if (!lost && String(input) === `${base}/api/capability/${capability}`) {
      lost = true;
      await observe(response.clone());
      await response.arrayBuffer();
      throw new Error('synthetic response loss after actual M result');
    }
    return response;
  };
}
async function matchingItems(w: World, content: string) {
  const r = await w.client.iItemsList(); assert.equal(r.ok, true);
  return (r.result.items as Array<{ item_id: string; content: string }>).filter(item => item.content === content);
}
function effect(w: World, id: string) {
  return w.host.db.prepare('SELECT state,operation_id FROM tool_side_effects WHERE id=?').get(id)!;
}

if (process.env.I_RECOVERY_CHILD === '1') {
  const w = await world(process.env.I_RECOVERY_ROOT!);
  loseResponse('i.item.create', async response => {
    assert.equal(response.status, 200);
    const row = w.host.db.prepare("SELECT id,state,operation_id FROM tool_side_effects WHERE kind='i_write'").get()!;
    assert.equal(row.state, 'running');
    fs.writeFileSync(process.env.I_RECOVERY_MARKER!, JSON.stringify(row));
    await new Promise(() => {});
  });
  await w.tools.execute('memory_i_write', { action: 'create', content: 'synthetic crash commit' }, context(w, 'crash'));
  throw new Error('parent must interrupt the actual committed response boundary');
} else {
  const results: Array<{ name: string; passed: boolean; error?: string }> = [];
  const cases: Array<[string, () => Promise<void>]> = [
    ['unknown survives Host rebuild and actual hold preflight recovers the original operation', async () => {
      const root = tempRoot('i-rebuild-'); let w: World | undefined;
      try {
        w = await world(root); const ctx = context(w, 'rebuild');
        loseResponse('i.item.create', async r => { assert.equal(r.status, 200); });
        const first = await w.tools.execute('memory_i_write', { action: 'create', content: 'synthetic rebuild commit' }, ctx);
        assert.equal(first.output.error_code, 'I_WRITE_OUTCOME_UNKNOWN'); globalThis.fetch = nativeFetch;
        const pending = w.reviews.unknownEffectsForWindow(w.windowId); assert.equal(pending.length, 1);
        await w.host.stop(); w = await world(root, false);
        assert.equal(w.reviews.unknownEffectsForWindow(w.windowId)[0]?.operationId, pending[0]!.operationId);
        const held = await w.tools.execute('memory_hold', { original_title: '合成恢复', categories: ['daily'], text: '合成恢复正文', creation_mode: 'contemporaneous' }, { ...ctx, toolCallId: 'hold' });
        assert.equal(held.ok, true); assert.equal(effect(w, pending[0]!.id).state, 'committed');
        assert.equal((await matchingItems(w, 'synthetic rebuild commit')).length, 1);
      } finally { globalThis.fetch = nativeFetch; if (w) await w.host.stop(); fs.rmSync(root, { recursive: true, force: true }); }
    }],
    ['SIGKILL after M commit recovers through actual Host.start', async () => {
      const root = tempRoot('i-crash-'), marker = path.join(root, 'committed.json'); let w: World | undefined;
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, I_RECOVERY_CHILD: '1', I_RECOVERY_ROOT: root, I_RECOVERY_MARKER: marker }, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', b => { stderr += String(b); });
      try {
        await pollUntil(() => { if (child.exitCode !== null) throw new Error(stderr); return fs.existsSync(marker); }, 10000, 25);
        const before = JSON.parse(fs.readFileSync(marker, 'utf8'));
        const exited = once(child, 'exit'); child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
        w = await world(root, false);
        assert.equal(effect(w, before.id).state, 'unknown');
        assert.equal(effect(w, before.id).operation_id, before.operation_id);
        assert.deepEqual(await w.memory.recoverUnknownEffects('primary', w.windowId), { resolved: 1, stillUnknown: 0 });
        assert.equal(effect(w, before.id).state, 'committed');
        assert.equal((await matchingItems(w, 'synthetic crash commit')).length, 1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
        if (w) await w.host.stop(); fs.rmSync(root, { recursive: true, force: true });
      }
    }],
    ['real 401 rejects a new write but cannot resolve an earlier unknown commit', async () => {
      const root = tempRoot('i-auth-'); const token = process.env.ESTOMAGO_TEST_MARIPOSA_TOKEN; let w: World | undefined;
      try {
        w = await world(root);
        loseResponse('i.item.create', async r => { assert.equal(r.status, 200); });
        const first = await w.tools.execute('memory_i_write', { action: 'create', content: 'synthetic auth commit' }, context(w, 'auth'));
        assert.equal(first.output.error_code, 'I_WRITE_OUTCOME_UNKNOWN'); globalThis.fetch = nativeFetch;
        const [pending] = w.reviews.unknownEffectsForWindow(w.windowId); assert.ok(pending);
        process.env.ESTOMAGO_TEST_MARIPOSA_TOKEN = 'synthetic-invalid';
        const denied = await w.client.iItemsList();
        assert.equal(denied.ok, false); assert.equal(denied.httpStatus, 401); assert.equal(denied.code, 'UNAUTHENTICATED');
        const newWrite = await w.tools.execute('memory_i_write', { action: 'create', content: 'synthetic rejected write' }, context(w, 'new-denied'));
        assert.equal(newWrite.output.error_code, 'I_UNAUTHENTICATED');
        assert.deepEqual(await w.memory.recoverUnknownEffects('primary', w.windowId), { resolved: 0, stillUnknown: 1 });
        assert.equal(effect(w, pending.id).state, 'unknown');
        process.env.ESTOMAGO_TEST_MARIPOSA_TOKEN = token;
        assert.deepEqual(await w.memory.recoverUnknownEffects('primary', w.windowId), { resolved: 1, stillUnknown: 0 });
        assert.equal(effect(w, pending.id).state, 'committed');
        assert.equal((await matchingItems(w, 'synthetic auth commit')).length, 1);
        assert.equal((await matchingItems(w, 'synthetic rejected write')).length, 0);
      } finally { globalThis.fetch = nativeFetch; process.env.ESTOMAGO_TEST_MARIPOSA_TOKEN = token; if (w) await w.host.stop(); fs.rmSync(root, { recursive: true, force: true }); }
    }],
    ['real receipt-first CAS rejection resolves as failure after its response is lost', async () => {
      const root = tempRoot('i-cas-'); let w: World | undefined;
      try {
        w = await world(root);
        const created = await w.client.iItemCreate({ content: 'synthetic CAS v1', operationId: 'cas-seed-create' }); assert.equal(created.ok, true);
        const itemId = String(created.result.item_id);
        const revised = await w.client.iItemRevise({ itemId, content: 'synthetic CAS v2', expectedRevision: 1, operationId: 'cas-seed-revise' }); assert.equal(revised.ok, true);
        loseResponse('i.item.revise', async r => { assert.equal(r.status, 409); assert.equal((await r.json()).error.code, 'VERSION_CONFLICT'); });
        const first = await w.tools.execute('memory_i_write', { action: 'revise', item_id: itemId, content: 'synthetic rejected revision', expected_revision: 1 }, context(w, 'stale-cas'));
        assert.equal(first.output.error_code, 'I_WRITE_OUTCOME_UNKNOWN'); globalThis.fetch = nativeFetch;
        const [pending] = w.reviews.unknownEffectsForWindow(w.windowId); assert.ok(pending);
        assert.deepEqual(await w.memory.recoverUnknownEffects('primary', w.windowId), { resolved: 1, stillUnknown: 0 });
        assert.equal(effect(w, pending.id).state, 'failed_resolved');
        assert.equal(w.reviews.unresolvedForWindow(w.windowId).length, 0);
        const current = await w.client.iItemGet(itemId); assert.equal(current.ok, true);
        assert.equal(current.result.revision, 2); assert.equal(current.result.content, 'synthetic CAS v2');
      } finally { globalThis.fetch = nativeFetch; if (w) await w.host.stop(); fs.rmSync(root, { recursive: true, force: true }); }
    }],
  ];
  for (const [name, run] of cases) {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: String(error) }); }
  }
  const output = { results };
  fs.writeFileSync(process.env.CROSS_MARIPOSA_RESULT!, JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2));
  assert.ok(results.every(r => r.passed), 'real I recovery contract failures recorded');
}
