// 审计 A1+B1 回归（2026-10-25，Codex 独立复审复现迁入）：
//  A1——conversations 委托正则曾比 handler 宽（(.+) vs [^/]+），多段子路径请求被吞无响应（旧版 404）；
//      本测对 13 条未列出子路径断言 404 完整响应（含 memories/a/b 多段），另含 content 未配置 503 对照。
//  B1——通话内 tool_define(wishstar_list_offers) 曾返回完整定义进入下一模型请求（D39 违约）；
//      本测经真实 HTTP+Supervisor 断言定义结果=TOOL_UNAVAILABLE_IN_CALL。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';

async function fixture(defineDuringCall = false) {
  const root = tempRoot('audit-router-policy-');
  writeApprovedIdentity(root);
  process.env.AUDIT_DS_TOKEN = 'synthetic-only';
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'synthetic-voice-only';
  const previousFetch = globalThis.fetch;
  let modelRequests = 0;
  let defined: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.deepseek.com/chat/completions', 'only the fake model boundary is configured');
    modelRequests++;
    const payload = JSON.parse(String(init?.body));
    if (modelRequests > 1) {
      const tool = payload.messages.findLast((m: any) => m.role === 'tool');
      if (tool) defined = JSON.parse(tool.content);
    }
    const invoke = defineDuringCall && modelRequests === 1;
    const delta = invoke
      ? { tool_calls: [{ index: 0, id: 'audit-define', type: 'function', function: { name: 'tool_define', arguments: JSON.stringify({ name: 'wishstar_list_offers' }) } }] }
      : { content: '合成审计回复。' };
    const body = 'data: ' + JSON.stringify({ id: 'audit', choices: [{ delta }] }) + '\n\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: invoke ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n';
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const patch = readyRuntimePatch();
  const config = buildConfig({ ...patch,
    runtime: { ...patch.runtime as object, provider: 'deepseek', tool_schema_mode: 'deferred' },
    deepseek: { model: 'deepseek-flash', api_key_env: 'AUDIT_DS_TOKEN', retry_max_attempts_after_initial: 0 },
  });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  const base = `http://127.0.0.1:${host.port}`;
  const ownerToken = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  const call = (method: string, pathname: string, body?: unknown, voice = false): Promise<{ status: number | null; body: any; timedOut: boolean }> => new Promise((resolve, reject) => {
    let timedOut = false;
    const encoded = body === undefined ? null : JSON.stringify(body);
    const req = request(base + pathname, { method, headers: {
      Authorization: `Bearer ${voice ? 'synthetic-voice-only' : ownerToken}`, Origin: base,
      'Content-Type': 'application/json', 'Idempotency-Key': 'audit-operation',
      ...(encoded === null ? {} : { 'Content-Length': Buffer.byteLength(encoded) }),
    } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let result: unknown = text; try { result = JSON.parse(text); } catch {} resolve({ status: res.statusCode ?? null, body: result, timedOut: false }); });
    });
    req.setTimeout(1000, () => { timedOut = true; req.destroy(); });
    req.on('error', error => { if (timedOut) resolve({ status: null, body: null, timedOut: true }); else reject(error); });
    req.end(encoded ?? undefined);
  });
  return { host, call, get defined() { return defined; }, get modelRequests() { return modelRequests; }, async close() {
    await host.stop(); globalThis.fetch = previousFetch;
    delete process.env.AUDIT_DS_TOKEN; delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

test('unknown route groups retain a completed response, including a memory ref with an extra path segment', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('GET', '/api/v1/conversations')).status, 200);
    const routes = [
      ['GET', '/api/v1/conversations/primary/unknown'],
      ['PATCH', '/api/v1/background/xyz'],
      ['PATCH', '/api/v1/runtime-settings/xyz'],
      ['GET', '/api/v1/oido/analyses/example/unknown'],
      ['GET', '/api/v1/calendar/day/unknown'],
      ['GET', '/api/v1/assets/example/unknown'],
      ['GET', '/api/v1/calls/unknown'],
      ['POST', '/api/v1/windows/example/context-selection/unknown'],
      ['GET', '/api/v1/events/unknown'],
      ['GET', '/api/v1/alerts/example/unknown'],
      ['DELETE', '/v1/calls/example/unknown'],
      ['POST', '/v1/chat/stream/unknown'],
      ['GET', '/api/v1/conversations/primary/turns/example/memories/a/b'],
    ];
    const observed = [];
    for (const [method, route] of routes) observed.push({ method, route, ...await f.call(method, route) });
    const content = await f.call('GET', '/api/v1/content/unknown');
    console.log('AUDIT_ROUTE_RESPONSES', JSON.stringify({ observed, content, modelRequests: f.modelRequests }));
    assert.equal(content.status, 503, 'existing content proxy keeps its unconfigured-service contract');
    for (const r of observed) {
      assert.equal(r.timedOut, false, 'handler swallowed the unknown path: ' + r.route);
      assert.equal(r.status, 404, r.route);
    }
    assert.equal(f.modelRequests, 0);
  } finally { await f.close(); }
});

test('normal active phone call rejects defining a non-memory business tool', { timeout: 10000 }, async () => {
  const f = await fixture(true);
  try {
    const call = await f.call('POST', '/v1/calls', { call_id: 'audit-phone', conversation_id: 'primary' }, true);
    assert.equal(call.status, 200);
    const sent = await f.call('POST', '/api/v1/conversations/primary/messages', { content: '合成通话中的工具定义请求。', client_message_id: 'audit-call-define' });
    assert.equal(sent.status, 201, 'a new message uses the existing 201 Created contract');
    await f.host.supervisor.waitIdle();
    console.log('AUDIT_CALL_DEFINE', JSON.stringify({ modelRequests: f.modelRequests, result: f.defined }));
    assert.equal(f.modelRequests, 2, 'definition result really entered the next model request');
    assert.equal(f.defined?.error_code, 'TOOL_UNAVAILABLE_IN_CALL');
  } finally { await f.close(); }
});
