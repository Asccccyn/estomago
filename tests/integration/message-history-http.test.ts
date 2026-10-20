import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';

test('历史 HTTP：有界双向翻页、上海日期定位、带活动轮和路由的只读事件快照', async t => {
  const root = tempRoot('message-history-http-');
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), deployment: { port: 0 }, runtime: { ...readyRuntimePatch().runtime, provider: 'mock' } });
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  let enqueued = 0;
  host.supervisor.enqueue = () => { enqueued++; };
  await host.start();
  t.after(async () => { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${host.port}`;
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  const headers = { Authorization: `Bearer ${token}` };
  const endpoint = `${base}/api/v1/conversations/primary/messages`;
  for (let seq = 1; seq <= 60; seq++) {
    const created = seq < 36 ? '2026-10-09T15:59:59.999Z' : '2026-10-09T16:00:00.000Z';
    const content = `synthetic message ${seq}`;
    host.db.prepare("INSERT INTO messages(id,conversation_id,sequence,speaker,kind,current_revision,published_at,created_at) VALUES (?,'primary',?,'owner','text',1,?,?)").run(`history-${seq}`, seq, created, created);
    host.db.prepare("INSERT INTO message_revisions(id,message_id,revision,kind,content,content_hash,occurred_at,received_at,source) VALUES (?,?,1,'text',?,?,?,?,'fixture')")
      .run(`history-${seq}-r1`, `history-${seq}`, content, sha256Hex(content), created, created);
  }
  const pending = host.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: 'pending now', clientMessageId: 'pending-history' });
  host.events.publish('turn.started', { conversationId: 'primary', turnId: pending.turnId, attemptId: pending.attemptId, payload: {} });
  const routed = host.messages.submitUserMessageWithTurn({ conversationId: 'primary', content: 'route now', clientMessageId: 'route-history' });
  host.db.prepare("UPDATE turns SET state='route_owner_pending' WHERE id=?").run(routed.turnId);
  host.db.prepare("UPDATE attempts SET state='route_owner_pending' WHERE id=?").run(routed.attemptId);
  const route = host.routing.createPending({ conversationId: 'primary', turnId: routed.turnId, attemptId: routed.attemptId, inputHash: routed.message.revision.content_hash, targetModel: null, evidenceCode: 'FIXTURE', messageId: routed.message.id, inputRevision: 1 });
  const changes = (host.db.prepare('SELECT total_changes() n').get() as { n: number }).n;
  const watermark = host.events.maxSequence();
  assert.equal((await fetch(endpoint + '?order=latest&limit=50&snapshot=1')).status, 401);
  const initial = await (await fetch(endpoint + '?order=latest&limit=50&snapshot=1', { headers })).json() as any;
  assert.equal(initial.messages.length, 50);
  assert.equal(initial.before_sequence, 13); assert.equal(initial.after_sequence, 62);
  assert.equal(initial.has_earlier, true); assert.equal(initial.has_later, false);
  assert.equal(initial.event_cursor, watermark);
  assert.deepEqual(initial.active_turns.map((turn: any) => turn.turn_id).sort(), [pending.turnId, routed.turnId].sort());
  assert.equal(initial.pending_route.decision_id, route.id);
  assert.equal(initial.pending_route.evidence_code, 'FIXTURE');
  assert.equal(initial.pending_route.turn_id, routed.turnId);
  assert.equal(initial.pending_route.already_switched, false);
  const earlier = await (await fetch(endpoint + '?before=13&limit=50', { headers })).json() as any;
  assert.equal(earlier.messages.length, 12); assert.equal(earlier.has_earlier, false); assert.equal(earlier.has_later, true);
  assert.equal(earlier.event_cursor, undefined); assert.equal(earlier.active_turns, undefined);
  const forward = await (await fetch(endpoint + '?after=12&limit=50', { headers })).json() as any;
  assert.equal(forward.messages.length, 50); assert.equal(forward.has_later, false);
  const jump = await (await fetch(endpoint + '?date=2026-10-10&limit=50&snapshot=1', { headers })).json() as any;
  assert.equal(jump.messages[0].sequence, 36);
  assert.equal(jump.messages.at(-1).sequence, 62, 'date jump continues into the surrounding timeline');
  assert.equal(jump.timezone, 'Asia/Shanghai'); assert.equal(jump.date, '2026-10-10'); assert.equal(jump.empty_date, false);
  const absent = await (await fetch(endpoint + '?date=2026-10-08&limit=50', { headers })).json() as any;
  assert.deepEqual(absent.messages, []); assert.equal(absent.empty_date, true);
  for (const query of ['date=2026-02-30', 'date=bad', 'limit=-1', 'limit=1.5', 'limit=1001', 'before=-1', 'after=abc', 'before=3&after=1', 'date=2026-10-10&before=3', 'order=latest&after=0']) {
    assert.equal((await fetch(endpoint + '?' + query, { headers })).status, 400, query);
  }
  assert.equal((host.db.prepare('SELECT total_changes() n').get() as { n: number }).n, changes, 'every history request is read-only');
  assert.equal((host.db.prepare('SELECT COUNT(*) n FROM provider_requests').get() as { n: number }).n, 0);
  assert.equal(enqueued, 0);
});
