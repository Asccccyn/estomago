// 联合审计 A08 / B5（2026-10-27 执行口径）：自然未接的一次可选留言机会。
// Siren 真实 expired → est 既有对账周期消费（consumeMissedCallOpportunities）：
// - 每个 invite 最多一次机会（dedupe=invite:<id>:missed-opportunity，重复事件/重启不重复）；
// - 派发前复核：她已回电/正在通话=机会失效（skipped_superseded）；
// - declined/cancelled 不产生留言机会（拒接不补打、不走未接留言）；
// - 机会事实轮经 submitProgramFactTurn 串行入口提交；事实文本明确"可以不留言"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
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
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { handleRequest } from '../../apps/host/src/server/http.ts';
import { SirenAdapter } from '../../apps/host/src/integrations/siren/adapter.ts';
import { consumeMissedCallOpportunities } from '../../apps/host/src/integrations/siren/missed-calls.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, assembleTestTools } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sirenWith(recent: Array<Record<string, unknown>>): SirenAdapter {
  const transport = (async () => Response.json({ active: null, recent })) as unknown as typeof fetch;
  return new SirenAdapter('http://127.0.0.1:1', 't', transport);
}

function compose(root: string, transport: OrTransport) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const identity = new IdentityService(config, buildPaths(root));
  const { tools } = assembleTestTools({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages });
  const supervisor = new TurnSupervisor({
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner: new DeepSeekRunner({ retryMax: 0 }, transport) },
    reasoning: new ReasoningService(db, events), usage: new UsageCollector(db),
    routing: new RoutingService(db, events, messages), windows: new WindowManager(db, events, identity, config),
    logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db),
    checkpoint: new HoldCheckpointService(db), trajectory: new WindowTrajectoryService(db),
  });
  const sirenCall = new SirenAdapter('http://127.0.0.1:1', 'synthetic', (async (url: unknown) => {
    if (String(url).endsWith('/hangup-request')) return Response.json({ accepted: true });
    return Response.json({ call_id: 'return-call', ws_url: 'ws://127.0.0.1:9/call', token: 'synthetic' });
  }) as typeof fetch);
  const deps = { config, db, events, messages, supervisor, paths: buildPaths(root), sirenCall,
    logger: new Logger(path.join(root, 'logs')), auth: { isAuthorized: () => true, verifyToken: () => true, originAllowed: () => true } } as never;
  const call = async (route: string, method: string, body?: unknown) => {
    let status = 0;
    const res = new Writable({ write(_chunk, _encoding, done) { done(); } });
    Object.assign(res, { writeHead(code: number) { status = code; } });
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { headers: {}, method, url: route });
    await handleRequest(req as never, res as never, deps);
    assert.equal(status, 200);
  };
  return { db, messages, supervisor, call, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const okTransport: OrTransport = async () => ({ status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '（这通没接，先不留话。）' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) });

test('R04：自然过期 → 一次可选留言机会（事实轮可派发，明确可以不留言）', async () => {
  const prompts: string[] = [];
  const transport: OrTransport = async (p) => { prompts.push(JSON.stringify(p.messages)); return okTransport(p); };
  const c = compose(tempRoot('mc-op-'), transport);
  try {
    const siren = sirenWith([
      { invite_id: 'inv-exp-1', state: 'expired', expires_at: 1, created_at: 1 },
      { invite_id: 'inv-dec', state: 'declined', expires_at: 1, created_at: 1 },
    ]);
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    c.supervisor.enqueue(first.turnId);
    await c.supervisor.waitIdle();
    const r = await consumeMissedCallOpportunities(c.db, siren, (kind, factText, dedupeKey) => { c.supervisor.submitProgramFactTurn('primary', kind, factText, dedupeKey); });
    assert.equal(r.submitted, 1, '只有自然过期产生机会（declined 不产生）');
    await c.supervisor.waitIdle();
    // 机会事实轮：恰好一次、可派发；文本允许不留言并给留言语音路径
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM turns WHERE trigger='program_fact'").get() as { n: number }).n, 1);
    const factPrompt = prompts.find((p) => p.includes('[program_fact]') && p.includes('可选**留言机会'));
    assert.ok(factPrompt, '机会事实进入模型请求');
    assert.ok((factPrompt ?? '').includes('也完全可以什么都不留'), '明确允许不留言（不伪造用户输入、不强制作息）');
    assert.ok((factPrompt ?? '').includes('chat_send_voice'), '留言语音走 B1 正式语音链');
    // R05：重复事件/worker 重启（再次消费）不重复机会
    const r2 = await consumeMissedCallOpportunities(c.db, siren, (kind, factText, dedupeKey) => { c.supervisor.submitProgramFactTurn('primary', kind, factText, dedupeKey); });
    assert.equal(r2.submitted, 0, '同 invite 幂等：不生成第二个机会');
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM turns WHERE trigger='program_fact'").get() as { n: number }).n, 1);
    console.log(JSON.stringify({ case: 'r04_missed_once' }));
  } finally { await c.supervisor.stopAll(); await pause(30); c.close(); }
});

test('R05：她已回电/正在通话——机会失效，不发过时留言', async () => {
  const submitted: string[] = [];
  const c = compose(tempRoot('mc-busy-'), okTransport);
  try {
    await c.call('/api/v1/calls', 'POST', { conversation_id: 'primary' });
    const siren = sirenWith([{ invite_id: 'inv-exp-2', state: 'expired', expires_at: 1, created_at: 1 }]);
    const r = await consumeMissedCallOpportunities(c.db, siren, (kind, _t, dedupeKey) => { submitted.push(dedupeKey); void kind; });
    assert.equal(r.skipped_superseded, 1);
    assert.equal(r.submitted, 0);
    assert.deepEqual(submitted, [], '机会失效不提交');
    await c.call('/api/v1/calls/return-call', 'DELETE');
    const ended = await consumeMissedCallOpportunities(c.db, siren, (_kind, _text, key) => { submitted.push(key); });
    assert.equal(ended.submitted, 0, '回拨结束后旧机会仍然失效');
    assert.deepEqual(submitted, []);
  } finally { await c.supervisor.stopAll(); await pause(30); c.close(); }
});

for (const callback of ['completed-call', 'dial-request'] as const) test(`未接机会排队后发生 ${callback}：实际派发前作废`, async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void;
  const busy = new Promise<void>(r => { entered = r; });
  const prompts: string[] = [];
  const c = compose(tempRoot('mc-queued-'), async (payload) => {
    prompts.push(JSON.stringify(payload.messages));
    if (prompts.length === 1) { entered(); await gate; }
    return okTransport(payload);
  });
  try {
    const first = c.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'queue-first' });
    c.supervisor.enqueue(first.turnId);
    await busy;
    const siren = sirenWith([{ invite_id: 'inv-queued', state: 'expired', created_at: Date.now() - 120000, expires_at: Date.now() - 60000 }]);
    const queued = await consumeMissedCallOpportunities(c.db, siren, (kind, text, key) => { c.supervisor.submitProgramFactTurn('primary', kind, text, key); });
    assert.equal(queued.submitted, 1, '确实已进入同一串行队列');
    if (callback === 'completed-call') {
      await c.call('/api/v1/calls', 'POST', { conversation_id: 'primary' });
      await c.call('/api/v1/calls/return-call', 'DELETE');
    } else {
      await c.call('/api/v1/calls/dial', 'POST', {});
    }
    release();
    await c.supervisor.waitIdle();
    const attempted = c.db.prepare(`SELECT t.state, a.blocked_reason FROM program_fact_turns p
      JOIN turns t ON t.id=p.turn_id JOIN attempts a ON a.turn_id=p.turn_id
      WHERE p.kind='invite_missed_opportunity'`).get() as { state: string; blocked_reason: string };
    assert.equal(attempted.state, 'failed');
    assert.match(attempted.blocked_reason, /^MISSED_CALL_OPPORTUNITY_SUPERSEDED:/);
    assert.ok(prompts.every(p => !p.includes('可选**留言机会')), '没有为旧未接机会请求模型');
    assert.equal(prompts.length, callback === 'dial-request' ? 2 : 1, '真实回拨请求仍正常交给模型');
  } finally { release(); await c.supervisor.waitIdle(); await c.supervisor.stopAll(); c.close(); }
});
