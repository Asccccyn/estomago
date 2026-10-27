// JV-04（联合审计 2026-10-26）整改验证：voice_calls 启动对账——Siren 是通话生死
// 正本，终态通知/浏览器收口都可能丢失；宿主按正本纠正 active 投影，只处理确定事实。
// Siren HTTP 是外部边界（本地 stub 实现其公开 GET /v1/calls/:id 合同）；
// 被测对象是真实 reconcileVoiceCallsOnStartup + 真实迁移库 + 真实工具资格门。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
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
import type { ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { SirenAdapter } from '../../apps/host/src/integrations/siren/adapter.ts';
import { reconcileVoiceCallsOnStartup } from '../../apps/host/src/integrations/siren/reconcile.ts';
import { handleRequest } from '../../apps/host/src/server/http.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, assembleTestTools } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));

/** Siren 公开 GET /v1/calls/:id 合同 stub：按 call_id 返回受控正本事实。 */
function startSirenFactStub(facts: Map<string, { db_status: string; session_active: boolean }>): { url: string; stop(): void } {
  const server = http.createServer((req, res) => {
    const m = /^\/v1\/calls\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && m) {
      const fact = facts.get(decodeURIComponent(m[1]!));
      if (!fact) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'call_not_found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ call_id: m[1]!, db_status: fact.db_status, session_active: fact.session_active, ended_at: null }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(0, '127.0.0.1');
  return new Promise((resolve) => { server.on('listening', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, stop: () => server.close() })); }) as never;
}

const quietTransport: OrTransport = async () => ({ status: 200, headers: new Map(), body: frameStream(sse({ id: 'g', choices: [{ delta: { content: '好' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + DONE) });

test('JV-04 对账：通知丢失的 ended 收口；在途保留；未连+过期孤儿收口；不可达跳过；资格恢复', async () => {
  const facts = new Map<string, { db_status: string; session_active: boolean }>([
    ['sc_ended', { db_status: 'ended', session_active: false }],      // 终态通知丢失（linger/断线已收口）
    ['sc_live', { db_status: 'active', session_active: true }],       // 通话仍在进行
    ['sc_orphan', { db_status: 'active', session_active: false }],    // 签发后从未连接
    ['sc_fresh', { db_status: 'active', session_active: false }],     // 签发后等待连接（时效未过）
  ]);
  const stub = await startSirenFactStub(facts);
  const root = tempRoot('jv04-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,reserved_until) VALUES ('sc_ended','primary','active',?,NULL)").run(now);
  db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,reserved_until) VALUES ('sc_live','primary','active',?,NULL)").run(now);
  db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,reserved_until) VALUES ('sc_orphan','primary','active',?,'2000-01-01T00:00:00Z')").run(now);
  db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,reserved_until) VALUES ('sc_fresh','primary','active',?,?)").run(now, new Date(Date.now() + 60_000).toISOString());

  const sirenCall = new SirenAdapter(stub.url, 'stub-token');
  // 先测不可达跳过：指向一个立即拒绝的端口（127.0.0.1:1 不可达）
  const deadAdapter = new SirenAdapter('http://127.0.0.1:1', 'stub-token');
  const skipped = await reconcileVoiceCallsOnStartup(db, deadAdapter);
  assert.deepEqual(skipped, { ended: 0, kept: 0, skipped: 4 }, 'Siren 不可达：不动投影');
  assert.equal((db.prepare("SELECT COUNT(*) n FROM voice_calls WHERE state='active'").get() as { n: number }).n, 4);

  const r = await reconcileVoiceCallsOnStartup(db, sirenCall);
  assert.deepEqual(r, { ended: 2, kept: 2, skipped: 0 });
  const states = Object.fromEntries((db.prepare('SELECT call_id, state FROM voice_calls').all() as Array<{ call_id: string; state: string }>).map((x) => [x.call_id, x.state]));
  assert.equal(states['sc_ended'], 'ended', '终态通知丢失→按正本收口');
  assert.equal(states['sc_live'], 'active', '在途通话保留');
  assert.equal(states['sc_orphan'], 'ended', '从未连接+签发时效已过→孤儿收口');
  assert.equal(states['sc_fresh'], 'active', '等待连接（时效未过）保留');

  // 对账断言完成：让剩余两条合法 active 正常结束（其各自挂断链语义），
  // 再验证工具资格恢复——memory_only 只看 voice_calls active
  db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE state='active'").run(new Date().toISOString());
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const { tools } = assembleTestTools({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), messages, sirenCall });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new DeepSeekRunner({ retryMax: 0 }, quietTransport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory: new WindowTrajectoryService(db) });
  try {
    const first = messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '在', clientMessageId: 'm0' });
    supervisor.enqueue(first.turnId);
    await supervisor.waitIdle();
    const ctx = (): ToolExecContext => ({ roomId: 'primary', windowId: 'w', turnId: 't1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'jv04' });
    const out = await tools.execute('wake_manage', { action: 'list' }, ctx());
    assert.notEqual((out.output as Record<string, unknown>)['error_code'], 'TOOL_UNAVAILABLE_IN_CALL', '对账后普通聊天/唤醒工具不再被旧 active 拒绝');
    console.log(JSON.stringify({ case: 'jv04_reconcile', ...r, tool_gate_reopened: true }));
  } finally { await supervisor.stopAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); stub.stop(); }
});
