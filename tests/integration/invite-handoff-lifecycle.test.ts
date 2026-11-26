import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { isCallActivityActive } from '../../apps/host/src/modules/voice/call-service.ts';
import { readyRuntimePatch, tempRoot, writeApprovedIdentity, pollUntil } from '../helpers.ts';

const nativeFetch = globalThis.fetch;

async function fixture() {
  const root = tempRoot('invite-lifecycle-'); writeApprovedIdentity(root);
  const credential = 'EST_TEST_INVITE_CREDENTIAL'; process.env[credential] = 'synthetic';
  let host: Host | undefined;
  let inviteState = 'none', modelSerial = 0, solRequests = 0, creationRequests = 0;
  let createMode: 'hold' | 'fail' = 'hold', creating = false, releaseCreate: (() => void) | undefined;
  let holdSol = false, solWaiting = false, solAborted = false, releaseSol: (() => void) | undefined;
  const handled = new Set<string>();
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://api.deepseek.com/chat/completions') {
      const payload = JSON.parse(String(init?.body));
      const latest = payload.messages.findLast((m: { role: string }) => m.role === 'user');
      const text = typeof latest?.content === 'string' ? latest.content : JSON.stringify(latest?.content);
      const action = text.includes('TEST_INVITE') ? 'invite' : text.includes('TEST_CANCEL') ? 'cancel' : null;
      const call = action && !handled.has(action);
      if (action) handled.add(action);
      const delta = call ? { tool_calls: [{ index: 0, id: `call-${++modelSerial}`, type: 'function', function: {
        name: 'tool_invoke', arguments: JSON.stringify({ name: 'call_control', arguments: { action } }),
      } }] } : { content: '合成回复' };
      const chunks = [
        { id: `model-${++modelSerial}`, model: 'deepseek-flash', choices: [{ delta }] },
        { choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20, total_tokens: 24 } },
      ];
      return new Response(chunks.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url === 'https://synthetic-sol.invalid/v1/responses') {
      solRequests++;
      if (holdSol) {
        holdSol = false;
        solWaiting = true;
        await new Promise<void>(resolve => {
          releaseSol = resolve;
          init?.signal?.addEventListener('abort', () => { solAborted = true; resolve(); }, { once: true });
        });
      }
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision: 'none', topic: 'new', basis: '合成无检索需要', plan: null }) }] }], usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } });
    }
    const parsed = new URL(url);
    if (parsed.origin === 'http://127.0.0.1:19877') {
      const invite = () => ({ invite_id: 'synthetic-invite', state: inviteState, expires_at: Date.now() + 45_000 });
      if (parsed.pathname === '/v1/invites' && init?.method === 'POST') { inviteState = 'pending'; return Response.json(invite()); }
      if (parsed.pathname === '/v1/conversations/primary/invites') return Response.json({ active: inviteState === 'pending' ? invite() : null, recent: [] });
      if (parsed.pathname === '/v1/invites/synthetic-invite/cancel') { inviteState = 'cancelled'; return Response.json(invite()); }
      if (parsed.pathname === '/v1/invites/synthetic-invite/accept') { inviteState = 'accepted'; return Response.json(invite()); }
      if (parsed.pathname === '/v1/calls' && init?.method === 'POST') {
        creationRequests++;
        if (createMode === 'fail') return Response.json({ error: 'synthetic service unavailable' }, { status: 503 });
        creating = true; await new Promise<void>(resolve => { releaseCreate = resolve; });
        return Response.json({ call_id: 'synthetic-call', ws_url: 'ws://synthetic.invalid', token: 'synthetic-token', expires_at: new Date(Date.now() + 60_000).toISOString() });
      }
      if (parsed.pathname === '/v1/calls/synthetic-call/hangup-request') return Response.json({ accepted: true });
      if (parsed.pathname === '/v1/calls/synthetic-call') return Response.json({ call_id: 'synthetic-call', status: 'ended', started_at: null });
      throw new Error(`unexpected Siren request: ${parsed.pathname}`);
    }
    if (parsed.hostname !== '127.0.0.1') throw new Error(`unexpected external request: ${parsed.hostname}`);
    return nativeFetch(input, init);
  };
  try {
    const patch = readyRuntimePatch();
    const config = buildConfig({ ...patch, runtime: { ...patch.runtime as object, provider: 'deepseek', tool_schema_mode: 'deferred' },
      deepseek: { model: 'deepseek-flash', api_key_env: credential, retry_max_attempts_after_initial: 0 },
      integrations: { siren: { base_url: 'http://127.0.0.1:19877', credential_ref: credential } },
      memory_surfacing: { enabled: true, sol: { api_key_env: credential, base_url: 'https://synthetic-sol.invalid/v1' } } });
    host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 }); await host.start();
    const base = `http://127.0.0.1:${host.port}`, token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
    const request = async (route: string, method = 'POST', body: unknown = {}) => {
      const r = await nativeFetch(base + '/api/v1' + route, { method, headers: { Authorization: `Bearer ${token}`, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const submit = async (content: string) => {
      const r = await request('/conversations/primary/messages', 'POST', { content, client_message_id: content });
      assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r));
    };
    const chat = async (content: string) => { await submit(content); await host!.supervisor.waitIdle(); };
    return { host, request, submit, chat, accept: () => request('/calls/invites/synthetic-invite/accept'),
      get solRequests() { return solRequests; }, get creationRequests() { return creationRequests; },
      get creating() { return creating; }, get solWaiting() { return solWaiting; }, get solAborted() { return solAborted; },
      set createMode(mode: 'hold' | 'fail') { createMode = mode; },
      holdSol() { holdSol = true; }, releaseCreate() { releaseCreate?.(); },
      async close() { releaseCreate?.(); releaseSol?.(); await host!.stop(); globalThis.fetch = nativeFetch; delete process.env[credential]; fs.rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (host) await host.stop(); globalThis.fetch = nativeFetch; delete process.env[credential]; fs.rmSync(root, { recursive: true, force: true }); throw error;
  }
}

test('model invitation cancellation ends ringing and the next real chat resumes Sol', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.chat('TEST_INVITE'); assert.equal(isCallActivityActive(f.host.db, 'primary'), true);
    const ringing = f.solRequests; await f.chat('ringing chat'); assert.equal(f.solRequests, ringing);
    await f.chat('TEST_CANCEL'); assert.equal(isCallActivityActive(f.host.db, 'primary'), false);
    await f.chat('after cancellation'); assert.equal(f.solRequests, ringing + 1);
  } finally { await f.close(); }
});

for (const retry of [false, true]) {
  test(`${retry ? 'failed creation retry' : 'first acceptance'} owns preparation until handoff and releases it on hangup`, { timeout: 15000 }, async () => {
    const f = await fixture();
    try {
      await f.chat('TEST_INVITE');
      if (retry) {
        f.createMode = 'fail'; const failed = await f.accept();
        assert.equal(failed.status, 502); assert.equal(failed.body.error.code, 'siren_call_failed');
        assert.equal(isCallActivityActive(f.host.db, 'primary'), false);
        const before = f.solRequests; await f.chat('after creation failed'); assert.equal(f.solRequests, before + 1);
        f.holdSol(); await f.submit('Sol already in flight before retry');
        await pollUntil(() => f.solWaiting, 3000, 5);
        f.createMode = 'hold';
      }
      const accepting = f.accept(); await pollUntil(() => f.creating, 3000, 5);
      assert.equal(isCallActivityActive(f.host.db, 'primary'), true);
      if (retry) { assert.equal(f.solAborted, true); await f.host.supervisor.waitIdle(); }
      const before = f.solRequests; await f.chat('during call preparation'); assert.equal(f.solRequests, before);
      f.releaseCreate(); const accepted = await accepting; assert.equal(accepted.status, 200);
      const replay = await f.accept(); assert.equal(replay.status, 200);
      assert.equal(replay.body.call_id, accepted.body.call_id); assert.equal(f.creationRequests, retry ? 2 : 1);
      const ended = await f.request('/calls/' + accepted.body.call_id, 'DELETE'); assert.equal(ended.status, 200);
      assert.equal(isCallActivityActive(f.host.db, 'primary'), false);
      await f.chat('after hangup'); assert.equal(f.solRequests, before + 1);
    } finally { await f.close(); }
  });
}
