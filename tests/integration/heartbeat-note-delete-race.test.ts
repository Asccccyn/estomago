import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { ContentServer } from '../../apps/content/src/service.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import type { HeartbeatRuntime } from '../../apps/host/src/modules/heartbeat/runtime.ts';
import type { ContentOperationCoordinator } from '../../apps/host/src/integrations/content/coordinator.ts';
import { lastCacheEvidence } from '../../apps/host/src/runtime/cache-observation.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { makeFixtureToolsResident, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';

const model = 'anthropic/claude-note-race-fixture';
const usage = { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.001 };
const drawId = 'fixture-note-draw';
const secret = '只可在实际派发门之后出现的合成预留话';
const beforeReveal = '合成：我现在去抽牌';
const afterReveal = '合成：这句是对已揭预留话的回应';
function toolBatch(items: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
  return { tool_calls: items.map((item, index) => ({ index, id: item.id, type: 'function',
    function: { name: item.name, arguments: JSON.stringify(item.args) } })) };
}

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}

for (const order of ['delete-before-gate', 'dispatch-before-delete-success', 'dispatch-before-delete-unknown',
  'edit-before-gate', 'edit-after-delivery', 'edit-after-unknown', 'content-action-replay', 'content-action-late-receipt',
  'reserved-pre-only', 'reserved-pre-and-post', 'wake-action-receipts'] as const) {
  test(`T44/F05: real reserved-note mutation and delivery follow the authoritative gate order (${order})`, { timeout: 15000 }, async t => {
    const editing = order.startsWith('edit-');
    assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
    const root = tempRoot('heartbeat-note-delete-race-');
    const content = new ContentServer({ stateRoot: path.join(root, 'content'), port: 0 });
    const entered = barrier();
    const proceed = barrier();
    let host: Host | undefined;
    t.after(async () => {
      proceed.release();
      await host?.stop();
      await content.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await content.start();
    writeApprovedIdentity(root);
    let sourceWrites = 0;
    let recoversAllowed = false;
    if (order === 'content-action-late-receipt') {
      const realFetch = globalThis.fetch;
      t.after(() => { globalThis.fetch = realFetch; });
      const source = `http://127.0.0.1:${content.port}/api/v1/content/`;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url === source + 'operations/resolve' && sourceWrites && !recoversAllowed) {
          const command = JSON.parse(String(init?.body ?? '{}')) as { path?: string };
          if (command.path === '/api/v1/content/posts') throw Error('synthetic receipt routing temporarily down');
        }
        const response = await realFetch(input, init);
        if (url === source + 'posts' && init?.method === 'POST' && ++sourceWrites === 1) {
          assert.equal(response.status, 201);
          await response.arrayBuffer();
          throw Error('synthetic response lost after actual Content commit');
        }
        return response;
      };
    }

    const wire: OrMessage[][] = [];
    let targetId = '';
    let number = 0;
    const transport = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 },
      async payload => {
        const messages = payload.messages as OrMessage[];
        wire.push(messages);
        const currentUser = messages.findLast(message => message.role === 'user');
        const heartbeat = JSON.stringify(currentUser).includes('[心跳唤醒]');
        const reveal = messages.some(message => message.role === 'tool' && message.tool_call_id === drawId);
        let delta: Record<string, unknown> = { content: '合成正常回复' };
        if (heartbeat && !reveal) {
          const card = host!.db.prepare("SELECT card_number FROM heartbeat_cards WHERE source_kind='reserved_note' AND source_identity=?")
            .get('content:reserved_note:' + targetId) as { card_number: number } | undefined;
          assert.ok(card, 'the note was selected through real Content candidate enumeration');
          number = card.card_number;
          delta = { tool_calls: [{ index: 0, id: drawId, type: 'function',
            function: { name: 'heartbeat_draw', arguments: JSON.stringify({ card_number: number }) } }] };
          if (order.startsWith('reserved-')) delta = toolBatch([
            { id: 'before-reveal', name: 'chat_send_text', args: { text: beforeReveal, idempotency_key: 'pre-card' } },
            { id: drawId, name: 'heartbeat_draw', args: { card_number: number } },
          ]);
        }
        if (heartbeat && reveal) {
          assert.notEqual(order, 'delete-before-gate', 'a prior source tombstone must stop transport');
          assert.match(JSON.stringify(messages), new RegExp(secret));
          const firstDelivery = host!.db.prepare('SELECT state FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId)?.state === 'dispatching';
          if (firstDelivery) {
            entered.release();
            await proceed.reached;
          } else assert.equal(order, 'wake-action-receipts', 'only the wake integration scenario needs additional continuations');
          if (order.endsWith('unknown')) throw Object.assign(new Error('synthetic connection lost after dispatch'), { code: 'ECONNRESET' });
          delta = { content: '确实收到留下的话' };
          if (order === 'content-action-replay') delta = { tool_calls: [
            ...['content-write-a','content-write-replay'].map((id, index) => ({ index, id, type: 'function', function: {
              name: 'content_post_create', arguments: JSON.stringify({ text: '同一业务操作正文', idempotency_key: 'one-heartbeat-post' }),
            } })),
            { index: 2, id: 'content-write-done', type: 'function', function: { name: 'background_complete', arguments: JSON.stringify({ outcome: 'done' }) } },
          ] };
          if (order === 'content-action-late-receipt') delta = { tool_calls: [
            ...['晚到回执真实正文','同键碰撞不同正文'].map((text, index) => ({ index,
              id: index === 0 ? 'content-late' : 'content-late-conflict', type: 'function', function: {
                name: 'content_post_create', arguments: JSON.stringify({ text, idempotency_key: 'one-late-post' }),
              } })),
            { index: 2, id: 'content-late-done', type: 'function', function: { name: 'background_complete', arguments: JSON.stringify({ outcome: 'done' }) } },
          ] };
          if (order === 'reserved-pre-only') delta = toolBatch([{ id: 'reserved-done', name: 'background_complete', args: { outcome: 'noop' } }]);
          if (order === 'reserved-pre-and-post') delta = toolBatch([
            { id: 'after-reveal', name: 'chat_send_text', args: { text: afterReveal, idempotency_key: 'post-card' } },
            { id: 'reserved-done', name: 'background_complete', args: { outcome: 'done' } },
          ]);
          if (order === 'wake-action-receipts') {
            const receipt = (id: string) => {
              const message = messages.find(item => item.role === 'tool' && item.tool_call_id === id);
              return message ? JSON.parse(String(message.content)) as { task_id: string; revision: number } : null;
            };
            const schedule = receipt('wake-schedule');
            const updated = receipt('wake-update');
            const scheduleArgs = { operation: 'schedule', operation_id: 'wake-original', note: '合成自约正文', delay_seconds: 3600 };
            if (!schedule) delta = toolBatch([
              { id: 'wake-schedule', name: 'wake_manage', args: scheduleArgs },
              { id: 'wake-schedule-retry', name: 'wake_manage', args: scheduleArgs },
              { id: 'wake-list', name: 'wake_manage', args: { operation: 'list' } },
              // Both values pass JSON schema; the true owner rejects supplying
              // both absolute and relative time, so this is a business failure.
              { id: 'wake-bad-schedule', name: 'wake_manage', args: { ...scheduleArgs, operation_id: 'wake-bad', at: '2020-01-01T00:00:00Z' } },
            ]);
            else if (!updated) {
              const args = { operation: 'update', operation_id: 'wake-change', task_id: schedule.task_id, expected_revision: schedule.revision, delay_seconds: 7200 };
              delta = toolBatch([
                { id: 'wake-update', name: 'wake_manage', args },
                { id: 'wake-update-retry', name: 'wake_manage', args },
                { id: 'wake-bad-update', name: 'wake_manage', args: { ...args, operation_id: 'wake-stale', expected_revision: 999 } },
              ]);
            } else {
              const args = { operation: 'cancel', operation_id: 'wake-cancelled', task_id: updated.task_id, expected_revision: updated.revision };
              delta = toolBatch([
                { id: 'wake-cancel', name: 'wake_manage', args },
                { id: 'wake-cancel-retry', name: 'wake_manage', args },
                { id: 'wake-list-after', name: 'wake_manage', args: { operation: 'list' } },
                { id: 'wake-done', name: 'background_complete', args: { outcome: 'noop' } },
              ]);
            }
          }
        }
        return { status: 200, headers: new Headers(), body: Readable.from([
          `data: ${JSON.stringify({ id: `request-${wire.length}`, choices: [{ delta }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: Array.isArray(delta.tool_calls) ? 'tool_calls' : 'stop' }], usage })}\n\n`,
          'data: [DONE]\n\n',
        ]) };
      });
    const ready = readyRuntimePatch();
    const config = buildConfig({
      ...ready, runtime: { ...ready.runtime as object, provider: 'mock', tool_schema_mode: 'direct' },
      openrouter: { model }, content: { enabled: true, port: content.port },
      background: { keepwarm: { sleep_window: { enabled: false } } },
    });
    host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0, runnerOverride: transport });
    makeFixtureToolsResident(host.db, ['heartbeat_draw', 'background_complete', 'chat_send_text']);
    await host.start();
    const base = `http://127.0.0.1:${host.port}`;
    const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
    async function request(route: string, method = 'GET', body?: Record<string, unknown>, key?: string, rev?: number) {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Origin: base };
      if (body) headers['Content-Type'] = 'application/json';
      if (key) headers['Idempotency-Key'] = key;
      if (rev !== undefined) headers['If-Match'] = `"${rev}"`;
      const response = await fetch(base + '/api/v1' + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    }
    for (let index = 0; index < 10; index++) {
      const { status, body } = await request('/content/future-notes', 'POST', { body: index === 0 ? secret : `其余合成预留话 ${index}` }, `note-${index}`);
      assert.equal(status, 201, JSON.stringify(body));
      if (!index) targetId = body.id;
    }
    const notePath = '/content/future-notes/' + targetId;
    const settings = await request('/background/settings', 'PUT', { keepwarm: { enabled: true, daily_cost_cap_usd: 5 },
      ...(order === 'wake-action-receipts' ? { autonomous: { enabled: true, daily_cost_cap_usd: 5 } } : {}) }, 'set-keepwarm', 0);
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,?)")
      .run(JSON.stringify({ input_micro_per_token: 0.000003, output_micro_per_token: 0.000015 }), new Date().toISOString());
    if (order === 'content-action-replay' || order === 'content-action-late-receipt') host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('background_tool_prices',?,?)")
      .run(JSON.stringify({ content_post_create: { max_cost_micro_usd: 1 } }), new Date().toISOString());

    async function chat(input: string, key: string) {
      const sent = await request('/conversations/primary/messages', 'POST', { content: input, client_message_id: key }, key);
      assert.ok(sent.status >= 200 && sent.status < 300, JSON.stringify(sent.body));
      await host!.supervisor.waitIdle();
    }
    await chat('先建立当前会话', 'chat-before');
    const window = host.windows.activeWindow('primary')!.id;
    const evidence = lastCacheEvidence(host.db, window);
    assert.ok(evidence);
    const activity = host.db.prepare("SELECT last_real_activity_at FROM conversation_activity WHERE conversation_id='primary'").get() as { last_real_activity_at: string };
    const due = Math.max(Date.parse(evidence.startedAt), Date.parse(activity.last_real_activity_at)) + 3_000_001;
    // Keep the production scheduler and its gates. Only advance its clock.
    (host.scheduler as any).d.now = () => due;
    (host.supervisor as any).d.now = () => due;

    if (order === 'delete-before-gate' || order === 'edit-before-gate') {
      const runtime = (host as unknown as { heartbeat: HeartbeatRuntime }).heartbeat;
      const beforeDispatch = runtime.beforeDispatch.bind(runtime);
      t.mock.method(runtime, 'beforeDispatch', async (runId: string, requestId: string, messages: OrMessage[], signal: AbortSignal) => {
        if (messages.some(message => message.tool_call_id === drawId)) {
          assert.equal(host!.db.prepare('SELECT state FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId)?.state, 'prepared');
          entered.release();
          await proceed.reached;
        }
        await beforeDispatch(runId, requestId, messages, signal);
      });
    }
    const run = host.scheduler!.tick();
    await Promise.race([entered.reached, run.then(() => { throw new Error('heartbeat ended before the intended synchronization point'); })]);
    if (order.startsWith('reserved-') || order === 'wake-action-receipts') {
      proceed.release(); await run; await host.supervisor.waitIdle();
      const runtime = (host as unknown as { heartbeat: HeartbeatRuntime }).heartbeat;
      await runtime.recoverProjections(20);
      const projection = JSON.parse(String(host.db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get()?.payload_ref));
      assert.equal(projection.card.source.kind, 'reserved_note');
      assert.equal(host.db.prepare('SELECT state FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId)?.state, 'delivered');
      if (order === 'wake-action-receipts') {
        const tasks = host.db.prepare("SELECT id,revision,enabled,created_by_actor_id FROM background_tasks WHERE origin='self_schedule'").all();
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0]?.revision, 3);
        assert.equal(tasks[0]?.enabled, 0);
        assert.equal(tasks[0]?.created_by_actor_id, 'jiaming');
        const wake = projection.actions.filter((a: any) => a.kind === 'wake');
        assert.deepEqual(wake.map((a: any) => [a.wakeOperation, a.status]), [
          ['schedule','committed'], ['schedule','failed'], ['update','committed'], ['update','failed'], ['cancel','committed'],
        ]);
        assert.deepEqual(wake.filter((a: any) => a.status === 'committed').map((a: any) => a.source), [1,2,3].map(revision => ({ namespace: 'host:task', id: tasks[0]!.id, revision })));
        const feed = await request('/content/posts?include_references=1');
        const blocks = feed.body.items.find((row: any) => row.kind === 'reference').blocks;
        for (const label of ['设置自主预约','修改自主预约','取消自主预约']) assert.ok(blocks.some((b: any) => b.source_label === label && b.text.includes('已完成')));
        await chat('下一条自然输入', 'chat-after');
        const receipts = wire.at(-1)!.filter(m => m.role === 'tool');
        for (const pair of [['wake-schedule','wake-schedule-retry'],['wake-update','wake-update-retry'],['wake-cancel','wake-cancel-retry']]) {
          const outputs = pair.map(id => JSON.parse(String(receipts.find(m => m.tool_call_id === id)?.content)));
          assert.deepEqual(outputs[0], outputs[1]);
          assert.equal(outputs[0].task_id, tasks[0]!.id);
        }
      } else {
        const said = (projection.messages as Array<{ messageId: string; revision: number; sequence: number }>).map(ref => host!.messages.getMessageAtRevision('primary', ref.messageId, ref.revision));
        assert.equal(said.find(m => m?.revision.content === beforeReveal)?.speaker, 'assistant');
        const expectsReply = order === 'reserved-pre-and-post';
        // The whole-turn reading still truthfully contains the pre-reveal
        // chat. Only the explicit response subset confers replay eligibility.
        assert.equal(projection.state, 'drawn');
        assert.deepEqual(projection.reservedReplyMessages, expectsReply ? projection.messages.filter((m: any) => m.messageId === said.find(row => row?.revision.content === afterReveal)?.id) : []);
        const pool = await runtime.sources.choose('primary', source => runtime.cards.isSourceEligible(source), AbortSignal.timeout(3000));
        const replay = pool.find(source => source.replay === 'first_reserved_response');
        assert.equal(!!replay, expectsReply);
        if (replay) {
          const updated = await request(notePath, 'PUT', { body: '源已修改，但仍用实际旧修订' }, 'edit-after-draw', 1);
          assert.equal(updated.status, 200);
          const payload = await runtime.sources.resolve(replay, 'primary', AbortSignal.timeout(3000));
          assert.equal(payload.status, 'available');
          if (payload.status === 'available') {
            assert.ok(payload.text.includes(afterReveal));
            assert.ok(payload.text.includes(secret));
            assert.ok(!payload.text.includes(beforeReveal));
            assert.ok(!payload.text.includes('源已修改'));
          }
        }
      }
      return;
    }
    if (order === 'content-action-late-receipt') {
      proceed.release(); await run; await host.supervisor.waitIdle();
      const runtime = (host as unknown as { heartbeat: HeartbeatRuntime }).heartbeat;
      const coordinator = (host as unknown as { contentOps: ContentOperationCoordinator }).contentOps;
      await runtime.recoverProjections(20);
      const original = content.db.prepare("SELECT id,revision FROM feed_posts WHERE body='晚到回执真实正文'").get() as { id: string; revision: number };
      assert.ok(original);
      const accepted = host.db.prepare("SELECT operation_key,state FROM outbox WHERE target='content.operation' AND json_extract(payload_ref,'$.actor')='jiaming'").get() as { operation_key: string; state: string };
      assert.equal(accepted.state, 'unknown_outcome');
      const projection = () => JSON.parse(String(host!.db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get()?.payload_ref));
      const initial = projection();
      const initialPosts = initial.actions.filter((a: any) => a.kind === 'post');
      assert.deepEqual(initialPosts.map((a: any) => a.status), ['unknown', 'failed']);
      assert.equal(initialPosts[0].operationId, accepted.operation_key, '首次意图已绑定真实业务键');
      const beforeFeed = await request('/content/posts?include_references=1');
      const beforeRef = beforeFeed.body.items.find((item: any) => item.kind === 'reference');
      assert.ok(beforeRef.blocks.some((b: any) => b.source_label === '发日常' && b.text.includes('结果待核')));
      const protocol = host.db.prepare('SELECT messages_json,manifest_json FROM window_trajectories WHERE window_id=?').get(window);
      const calls = wire.length;
      recoversAllowed = true;
      // The same production recovery method resolves the original receipt and
      // updates the already-created reading projection, without resending POST.
      await coordinator.recoverOnce(20, limit => runtime.recoverProjections(limit));
      const updated = projection();
      assert.equal(updated.version, initial.version + 1);
      const afterPosts = updated.actions.filter((a: any) => a.kind === 'post');
      assert.deepEqual(afterPosts.map((a: any) => a.status), ['committed', 'failed']);
      assert.deepEqual(afterPosts[0].source, { namespace: 'content:post', id: original.id, revision: original.revision });
      const afterFeed = await request('/content/posts?include_references=1');
      const afterRefs = afterFeed.body.items.filter((item: any) => item.kind === 'reference');
      assert.equal(afterRefs.length, 1);
      assert.equal(afterRefs[0].id, beforeRef.id);
      assert.ok(afterRefs[0].blocks.some((b: any) => b.source_label === '发日常' && b.text.includes('已完成')));
      assert.equal(sourceWrites, 1);
      assert.equal(wire.length, calls);
      assert.deepEqual(host.db.prepare('SELECT messages_json,manifest_json FROM window_trajectories WHERE window_id=?').get(window), protocol);
      return;
    }
    if (order === 'content-action-replay') {
      proceed.release(); await run; await host.supervisor.waitIdle();
      await (host as unknown as { heartbeat: HeartbeatRuntime }).heartbeat.recoverProjections(20);
      const info = content.db.prepare("SELECT id,revision FROM feed_posts WHERE body='同一业务操作正文'").all() as Array<{ id: string; revision: number }>;
      assert.equal(info.length, 1, '同键不同 provider call 仍只提交一个原帖');
      const operation = host.db.prepare("SELECT operation_key FROM outbox WHERE target='content.operation' AND json_extract(payload_ref,'$.actor')='jiaming'").get() as { operation_key: string };
      const attempts = host.db.prepare("SELECT action_json FROM heartbeat_actions WHERE json_extract(action_json,'$.kind')='post' ORDER BY rowid").all() as Array<{ action_json: string }>;
      assert.equal(attempts.length, 2, '保留两次真实工具调用');
      for (const row of attempts) {
        const receipt = JSON.parse(row.action_json);
        assert.equal(receipt.operationId, operation.operation_key);
        assert.deepEqual(receipt.source, { namespace: 'content:post', id: info[0]!.id, revision: info[0]!.revision });
      }
      const projection = host.db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection'").get() as { payload_ref: string };
      const actions = JSON.parse(projection.payload_ref).actions.filter((item: any) => item.kind === 'post');
      assert.equal(actions.length, 1, '朋友圈同业务操作只显示一次实际完成');
      assert.equal(actions[0].status, 'committed');
      await chat('下一条自然输入', 'chat-after');
      const next = wire.at(-1)!;
      for (const id of ['content-write-a', 'content-write-replay']) {
        const message = next.find(item => item.role === 'tool' && item.tool_call_id === id);
        assert.ok(message);
        assert.equal(JSON.parse(String(message.content)).id, info[0]!.id);
        assert.doesNotMatch(String(message.content), /tool-content-v2:|heartbeatReceipt/);
      }
      return;
    }
    if (editing) {
      const update = () => request(notePath, 'PUT', { body: '专页改后的真实留言' }, 'edit-note', 1);
      if (order === 'edit-before-gate') {
        const updated = await update();
        assert.equal(updated.status, 200);
        assert.equal(updated.body.delivery_state, 'pending');
        assert.equal(updated.body.frozen_card.revision, 1, '编辑不换今日固定号码的版本');
      }
      proceed.release();
      await run;
      await host.supervisor.waitIdle();
      const state = order.endsWith('unknown') ? 'unknown' : 'delivered';
      if (order !== 'edit-before-gate') {
        assert.equal((await request(notePath)).body.delivery_state, state);
        const updated = await update();
        assert.equal(updated.status, 200, JSON.stringify(updated.body));
        assert.equal(updated.body.delivery_state, state);
      }
      const latest = await request(notePath);
      assert.equal(latest.body.revision, 2);
      assert.equal(latest.body.body, '专页改后的真实留言');
      assert.equal(latest.body.delivery_state, state);
      assert.equal((await request(notePath + '?revision=1')).body.body, secret);
      assert.equal((await update()).body.revision, 2, '同键重放不再改源');
      assert.equal(host.db.prepare('SELECT state FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId)?.state, state);
      const deck = await request('/background/heartbeat');
      assert.equal(deck.body.available_numbers.includes(number), false);
      if (state === 'delivered') {
        await (host as unknown as { heartbeat: HeartbeatRuntime }).heartbeat.recoverProjections(20);
        const feed = await request('/content/posts?include_references=1');
        const reference = feed.body.items.find((item: any) => item.kind === 'reference');
        assert.ok(reference, '正式映射由原事件创建');
        const card = reference.blocks.find((block: any) => block.id === 'card');
        assert.equal(card.text, latest.body.body);
        assert.equal(card.observed_revision, 1);
        assert.equal(card.display_revision, 2);
        assert.equal(card.editable, false);
        assert.equal(card.management_href, '/home/heartbeat?note=' + targetId);
        const rejected = await request('/content/moment-references/' + reference.id + '/blocks/card', 'PUT',
          { body: '通用编辑器不得改预留话', expected_source_revision: 2 }, 'denied-moment-edit', reference.revision);
        assert.equal(rejected.status, 403);
        assert.equal(rejected.body.error.code, 'reserved_note_managed_in_heartbeat');
        assert.equal((await request(notePath)).body.revision, 2);
      }
      await chat('下一条自然输入', 'chat-after');
      assert.equal(host.db.prepare('SELECT COUNT(*) AS n FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId)?.n, 1);
      assert.equal(JSON.stringify(wire.at(-1)).includes(secret), state === 'delivered');
      assert.equal(JSON.stringify(wire.at(-1)).includes('专页改后的真实留言'), false, '既有协议不改写');
      return;
    }
    const sourceDeletion = await request(notePath, 'DELETE', undefined, 'delete-note', 1);
    assert.equal(sourceDeletion.status, 200, JSON.stringify(sourceDeletion.body));
    assert.equal(sourceDeletion.body.deleted, true);
    assert.equal(sourceDeletion.body.delivery_state, order === 'delete-before-gate' ? 'pending' : 'dispatching');
    assert.equal(sourceDeletion.body.frozen_card.number, number);
    assert.equal(sourceDeletion.body.frozen_card.available, false);
    proceed.release();
    await run;
    await host.supervisor.waitIdle();

    const deliveredState = order === 'delete-before-gate' ? 'pending' : order.endsWith('success') ? 'delivered' : 'unknown';
    const drawState = order === 'delete-before-gate' ? 'rejected' : deliveredState;
    const ledger = host.db.prepare('SELECT state,delivered_at FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId);
    assert.equal(ledger?.state, drawState);
    assert.equal(Boolean(ledger?.delivered_at), deliveredState === 'delivered');
    assert.equal(wire.length, order === 'delete-before-gate' ? 2 : 3);
    assert.equal(wire.slice(1).filter(messages => JSON.stringify(messages).includes(secret)).length, order === 'delete-before-gate' ? 0 : 1);
    const latest = await request(notePath);
    assert.equal(latest.body.deleted, true);
    assert.equal(latest.body.delivery_state, deliveredState);
    assert.equal((await request(notePath + '?revision=1')).status, 410);
    const replay = await request(notePath, 'DELETE', undefined, 'delete-note', 1);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.delivery_state, deliveredState);
    const deck = await request('/background/heartbeat');
    assert.equal(deck.body.available_numbers.includes(number), false);
    assert.equal(deck.body.delivered_numbers.includes(number), deliveredState === 'delivered');
    assert.notEqual(deck.body.mode, 'exhausted_keepwarm');

    if (order === 'delete-before-gate') {
      const blocked = host.db.prepare(`SELECT p.sent_at,p.dispatch_started_at,d.actual_cost_micro_usd
        FROM provider_requests p LEFT JOIN background_dispatches d ON d.id=p.background_dispatch_id
        WHERE p.purpose='cache_keepalive' ORDER BY p.rowid DESC LIMIT 1`).get();
      assert.deepEqual({ ...blocked }, { sent_at: null, dispatch_started_at: null, actual_cost_micro_usd: 0 });
    }
    await chat('下一条自然输入', 'chat-after');
    const after = wire.at(-1)!;
    assert.equal(after.filter(message => message.tool_call_id === drawId).length, 1);
    assert.equal(JSON.stringify(after).includes(secret), deliveredState === 'delivered');
    assert.equal(host.db.prepare('SELECT COUNT(*) AS n FROM heartbeat_draw_operations WHERE operation_id=?').get(drawId)?.n, 1);
  });
}
