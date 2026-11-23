// 心跳保温修复 2026-11-23（C07）：预留留言的待用/已使用视图。真实 Host + 真实 Content + 真实心跳投递；
// 哪条留言属于哪个视图只看交付账本。隔离临时目录；假模型；不发真实消息。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { ContentServer } from '../../apps/content/src/service.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { HeartbeatCards } from '../../apps/host/src/modules/heartbeat/service.ts';
import { heartbeatBusinessDate } from '../../apps/host/src/modules/heartbeat/runtime.ts';
import { lastCacheEvidence } from '../../apps/host/src/runtime/cache-observation.ts';
import type { OrMessage } from '../../apps/host/src/runtime/or-payload.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { makeFixtureToolsResident, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';

const model = 'anthropic/claude-note-views-fixture';
const usage = { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.001 };
const drawId = 'fixture-note-views-draw';

type Note = { id: string; body: string | null; revision: number; delivery_state?: string; frozen_card?: { number: number } };

test('T-C02/T-C03: 已交付的留言离开待用列表并在已使用视图中可管理；投递未知的留在待确认；分页与计数一致；原文与账本保留', { timeout: 20000 }, async t => {
  assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
  const root = tempRoot('heartbeat-note-views-');
  const content = new ContentServer({ stateRoot: path.join(root, 'content'), port: 0 });
  let host: Host | undefined;
  t.after(async () => { await host?.stop(); await content.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await content.start();
  writeApprovedIdentity(root);
  const wire: OrMessage[][] = [];
  const transport = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 },
    async payload => {
      const messages = payload.messages as OrMessage[];
      wire.push(messages);
      const heartbeat = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('[心跳唤醒]'));
      const revealed = messages.some(message => message.role === 'tool' && message.tool_call_id === drawId);
      let delta: Record<string, unknown> = { content: '合成回复' };
      if (heartbeat && !revealed) {
        // 抽今天牌组里的任意一张预留留言：真实候选枚举把今天新建的留言编进了牌组。
        const card = host!.db.prepare("SELECT card_number FROM heartbeat_cards WHERE source_kind='reserved_note' ORDER BY card_number LIMIT 1").get() as { card_number: number };
        delta = { tool_calls: [{ index: 0, id: drawId, type: 'function', function: { name: 'heartbeat_draw', arguments: JSON.stringify({ card_number: card.card_number }) } }] };
      }
      if (revealed) delta = { content: '确实收到留下的话' };
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
  makeFixtureToolsResident(host.db, ['heartbeat_draw', 'background_complete']);
  await host.start();
  const base = `http://127.0.0.1:${host.port}`;
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  async function request(route: string, method = 'GET', body?: Record<string, unknown>, key?: string, rev?: number) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Origin: base };
    if (body) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    if (rev !== undefined) headers['If-Match'] = `"${rev}"`;
    const response = await fetch(base + '/api/v1' + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as any };
  }
  type Page = { items: Note[]; has_more: boolean; next_cursor: string | null; view: string; counts: { pending: number; used: number; uncertain: number } };
  const list = async (query = ''): Promise<Page> => (await request('/content/future-notes' + (query ? '?' + query : ''))).body as Page;
  const everything = async (query: string): Promise<Note[]> => {
    const seen: Note[] = [];
    let page = await list(query);
    seen.push(...page.items);
    while (page.next_cursor) {
      page = await list(query + (query ? '&' : '') + 'cursor=' + encodeURIComponent(page.next_cursor));
      seen.push(...page.items);
    }
    return seen;
  };

  const notes: Array<{ id: string; body: string }> = [];
  for (let index = 0; index < 25; index++) {
    const created = await request('/content/future-notes', 'POST', { body: `今天新写的合成留言 ${index}` }, `note-${index}`);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    notes.push({ id: created.body.id, body: created.body.body });
  }
  // 刚保存、还没被抽到的留言是“待用”，不是“没保存”。
  const waiting = await everything('');
  assert.equal(waiting.length, 25);
  assert.equal(new Set(waiting.map(note => note.id)).size, 25, '翻页不重不漏');
  assert.ok(waiting.every(note => note.delivery_state === 'pending' && !note.frozen_card));
  const first = await list('limit=20');
  assert.deepEqual([first.items.length, first.has_more, first.view, first.counts], [20, true, 'pending', { pending: 25, used: 0, uncertain: 0 }]);
  assert.equal((await request('/content/future-notes?view=bogus')).status, 400);
  assert.equal((await request('/content/future-notes?limit=101')).status, 400);
  assert.equal((await request('/content/future-notes?cursor=%2A%2A')).status, 400);

  // 真实心跳投递一张：今天建牌前保存的留言进入今天的牌组（没有“必须前一天”的条件）。
  assert.equal((await request('/background/settings', 'PUT', { keepwarm: { enabled: true, daily_cost_cap_usd: 5 } }, 'set-keepwarm', 0)).status, 200);
  host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('or_model_price',?,?)")
    .run(JSON.stringify({ input_micro_per_token: 0.000003, output_micro_per_token: 0.000015 }), new Date().toISOString());
  const sent = await request('/conversations/primary/messages', 'POST', { content: '先建立当前会话', client_message_id: 'chat-before' }, 'chat-before');
  assert.ok(sent.status >= 200 && sent.status < 500);
  await host.supervisor.waitIdle();
  const window = host.windows.activeWindow('primary')!.id;
  const evidence = lastCacheEvidence(host.db, window);
  const activity = host.db.prepare("SELECT last_real_activity_at FROM conversation_activity WHERE conversation_id='primary'").get() as { last_real_activity_at: string };
  assert.ok(evidence);
  const due = Math.max(Date.parse(evidence.startedAt), Date.parse(activity.last_real_activity_at)) + 3_000_001;
  // Keep the production scheduler and its gates. Only advance its clock.
  (host.scheduler as any).d.now = () => due;
  (host.supervisor as any).d.now = () => due;
  await host.scheduler!.tick();
  const cards = new HeartbeatCards(host.db);
  const deck = cards.getDeck('primary', heartbeatBusinessDate(new Date(due)))!;
  assert.equal(deck.deliveredNumbers.length, 1, '一次心跳只交付一张');
  const deliveredCard = host.db.prepare("SELECT card_number, json_extract(source_ref_json,'$.id') AS id FROM heartbeat_cards WHERE deck_id=? AND card_number=?")
    .get(deck.id, deck.deliveredNumbers[0]) as { card_number: number; id: string };
  assert.ok(notes.some(note => note.id === deliveredCard.id), '交付的是今天保存的留言');
  assert.equal((await request('/content/future-notes/' + deliveredCard.id)).body.delivery_state, 'delivered');

  const pendingPages = await everything('');
  assert.equal(pendingPages.length, 24);
  assert.ok(!pendingPages.some(note => note.id === deliveredCard.id), '已用留言不在默认待用列表的任何一页');
  const usedPages = await everything('view=used');
  assert.deepEqual(usedPages.map(note => [note.id, note.delivery_state]), [[deliveredCard.id, 'delivered']]);
  const summary = await list();
  assert.deepEqual(summary.counts, { pending: 24, used: 1, uncertain: 0 }, '计数与两个视图的实际条数一致');
  const second = await list('limit=20');
  assert.equal(second.items.length, 20);
  const rest = await list('limit=20&cursor=' + encodeURIComponent(second.next_cursor!));
  assert.deepEqual([rest.items.length, rest.has_more, rest.next_cursor], [4, false, null]);
  assert.equal(new Set([...second.items, ...rest.items].map(note => note.id)).size, 24);

  // 已使用视图里仍可按原授权编辑、删除；正文、固定修订和账本都在，不会回到待用。
  const used = usedPages[0]!;
  const edited = await request('/content/future-notes/' + used.id, 'PUT', { body: '交付后修改的合成留言' }, 'edit-used', used.revision);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.delivery_state, 'delivered');
  assert.equal((await request('/content/future-notes/' + used.id)).body.body, '交付后修改的合成留言');
  assert.equal((await everything('view=used')).length, 1);
  assert.ok(!(await everything('')).some(note => note.id === used.id));
  const ledger = host.db.prepare("SELECT state FROM heartbeat_draw_operations WHERE operation_id=?").get(drawId) as { state: string };
  assert.equal(ledger.state, 'delivered', '移出待用列表不动交付账本');

  // 牌组固定之后又保存的留言不会换进今天的十张牌，也没有被说成丢失。
  const later = await request('/content/future-notes', 'POST', { body: '建牌之后才保存的合成留言' }, 'note-later');
  assert.equal(later.status, 201);
  assert.deepEqual(cards.getDeck('primary', heartbeatBusinessDate(new Date(due)))!.availableNumbers.length, 9);
  const laterNote = (await everything('')).find(note => note.id === later.body.id)!;
  assert.equal(laterNote.delivery_state, 'pending');
  assert.equal(laterNote.frozen_card, undefined);

  // 投递结果未知的留言留在待用列表并单独标成待确认，既不算已使用，也不会重新可抽。
  // 今天牌组里还留着的那张预留留言。
  const uncertainNote = (await everything('')).find(note => note.frozen_card && note.delivery_state === 'pending')!;
  assert.ok(uncertainNote);
  const uncertainCard = host.db.prepare("SELECT card_number FROM heartbeat_cards WHERE deck_id=? AND json_extract(source_ref_json,'$.id')=?")
    .get(deck.id, uncertainNote.id) as { card_number: number };
  const stamp = new Date(due).toISOString();
  const runId = 'fixture-note-views-unknown';
  host.db.prepare(`INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at)
    VALUES(?,'fixture-history','primary','jiaming','keepwarm',1,?,'running',?,?)`).run(runId, runId, stamp, stamp);
  assert.equal(cards.begin({ runId, businessDate: heartbeatBusinessDate(new Date(due)) })?.mode, 'draw');
  const operation = { runId, operationId: 'fixture-unknown-draw' };
  assert.equal(cards.claim({ ...operation, cardNumber: uncertainCard.card_number }).status, 'claimed');
  assert.equal(cards.recordSource({ ...operation, result: 'ready' }).status, 'prepared');
  const requestId = 'fixture-unknown-request';
  host.db.prepare(`INSERT INTO provider_requests(id,window_id,purpose,seen_manifest_json,payload_json,background_run_id,dispatch_started_at,created_at)
    VALUES(?,?,'cache_keepalive','[]',?,?,?,?)`)
    .run(requestId, window, JSON.stringify({ messages: [{ role: 'tool', tool_call_id: operation.operationId, content: JSON.stringify({ heartbeat_card: { operation_id: operation.operationId } }) }] }), runId, stamp, stamp);
  assert.equal(cards.startDispatch({ ...operation, providerRequestId: requestId }), true);
  cards.closeRun(runId);
  host.db.prepare("UPDATE background_runs SET state='unknown' WHERE id=?").run(runId);
  assert.equal(cards.getDraw(operation)?.status, 'unknown');
  const afterUnknown = await list();
  assert.deepEqual(afterUnknown.counts, { pending: 25, used: 1, uncertain: 1 }, '25 条待用（含建牌后新增的那条）里有一条待确认');
  const uncertain = (await everything('')).find(note => note.id === uncertainNote.id)!;
  assert.equal(uncertain.delivery_state, 'unknown');
  assert.ok(!(await everything('view=used')).some(note => note.id === uncertainNote.id));
  assert.equal(cards.getDeck('primary', heartbeatBusinessDate(new Date(due)))!.availableNumbers.includes(uncertainCard.card_number), false, '结果未知不会重新可抽');

  // 宿主发出的投影能被同一版本的内容服务接受并保存为朋友圈记录，包括新增的 rest 结束原因和聊天来源。
  const deliveredSource = cards.getDeliveredDraw(drawId)!.source;
  const baseProjection = JSON.parse(String(host.db.prepare("SELECT payload_ref FROM outbox WHERE operation_key='heartbeat-moment:sleep-run'").get()?.payload_ref));
  const DAY = heartbeatBusinessDate(new Date(due));
  const extra = [
    ['heartbeat-moment:fixture-rest', { ...baseProjection, terminal: { status: 'cancelled', reason: 'rest' } }],
    ['heartbeat-moment:fixture-chat', { mode: 'draw', origin: 'chat', conversationId: 'primary', businessDate: DAY, version: 2, state: 'drawn_no_comment',
      card: { number: 3, source: deliveredSource }, messages: [{ messageId: 'fixture-chat-reveal', revision: 1, sequence: 1 }], actions: [], terminal: { status: 'completed' } }],
  ] as const;
  for (const [key, projection] of extra) host.db.prepare(`
    INSERT INTO outbox(id,operation_key,target,payload_ref,state,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)`)
    .run(`ob_${key.slice('heartbeat-moment:'.length)}`, key, 'content_heartbeat_projection', JSON.stringify(projection), stamp, stamp);
  await host.heartbeat!.recoverProjections(10);
  assert.deepEqual((host.db.prepare("SELECT operation_key,state FROM outbox WHERE target='content_heartbeat_projection' ORDER BY operation_key").all() as Array<Record<string, unknown>>)
    .map(row => [row.operation_key, row.state]),
  [['heartbeat-moment:fixture-chat', 'acked'], ['heartbeat-moment:fixture-rest', 'acked'], ['heartbeat-moment:sleep-run', 'acked']]);
  const feed = await request('/content/posts?include_references=1');
  assert.equal(feed.status, 200);
  const references = (feed.body.items as Array<Record<string, unknown>>).filter(item => item.kind === 'reference');
  assert.equal(references.length, 3, '三条朋友圈记录各建一次帖');
  assert.deepEqual(references.map(item => item.origin).sort(), ['chat', 'heartbeat', 'heartbeat']);

  // 移出待用不是删除：原授权的删除仍要她自己做，做了之后两个视图都不再列出，账本不变。
  assert.equal((await request('/content/future-notes/' + later.body.id, 'DELETE', undefined, 'delete-later', later.body.revision)).status, 200);
  assert.ok(!(await everything('')).some(note => note.id === later.body.id));
  assert.equal((await list()).counts.used, 1);
  assert.equal((host.db.prepare("SELECT count(*) n FROM heartbeat_draw_operations WHERE state='delivered'").get() as { n: number }).n, 1);
});
