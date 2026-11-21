import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { Host } from '../../apps/host/src/app-context.ts';
import { ContentServer } from '../../apps/content/src/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { ZashideleMoments } from '../../apps/host/src/integrations/zashidele/moments.ts';
import type { HeartbeatSourceAdapter } from '../../apps/host/src/modules/heartbeat/sources.ts';
import { HeartbeatCards } from '../../apps/host/src/modules/heartbeat/service.ts';
import { heartbeatBusinessDate, type HeartbeatRuntime } from '../../apps/host/src/modules/heartbeat/runtime.ts';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { readHeartbeatProjection, type HeartbeatSource } from '../../packages/contracts/src/heartbeat.ts';
import { readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';

test('real Host registration shares one deck/ledger with enabled seventh source, opted-in living room, and one fixed midnight Sol memory', { timeout: 30000 }, async t => {
  assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T15:59:50Z') });
  const root = tempRoot('heartbeat-source-adapters-');
  const content = new ContentServer({ stateRoot: path.join(root, 'content'), port: 0 });
  let host: Host | undefined;
  t.after(async () => { await host?.stop(); await content.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await content.start(); writeApprovedIdentity(root);

  let enabled = false, listReads = 0, detailReads = 0, livingReads = 0, memoryLists = 0, solCalls = 0;
  const items = new Map(Array.from({ length: 7 }, (_, i) => [`seventh-${i}`, 1]));
  const adapter: HeartbeatSourceAdapter = {
    kind: 'ext:fixture', namespace: 'fixture', enabled: () => enabled,
    async list(room) {
      listReads++;
      return [...items].map(([id, revision]) => ({ kind: 'ext:fixture', namespace: 'fixture', id, revision, identity: `fixture:item:${id}`, permissionScope: room }));
    },
    async resolve(source, room) {
      detailReads++;
      if (room !== 'primary') return { status: 'forbidden' };
      const revision = items.get(source.id);
      if (!revision) return { status: 'deleted' };
      if (source.revision !== revision) return { status: 'revision_unavailable' };
      return { status: 'available', text: `合成第七源 ${source.id}`, assetIds: [], imageIds: [] };
    },
  };
  const memory = (id: string) => ({ memory_id: id, version: 1, text: `合成记忆 ${id}`, visibility: 'active' });
  t.mock.method(MariposaClient.prototype, 'memoryListForHeartbeat', async () => {
    memoryLists++;
    return { ok: true, result: { items: ['memory-a', 'memory-b'].map(memory), next_cursor: null } };
  });
  t.mock.method(MariposaClient.prototype, 'memoryGet', async (id: string) => ({ ok: true, result: memory(id) }));
  const livingItem = { id: 'living-post', revision: 'a'.repeat(64), author_id: 'fixture-author', author_name: '合成作者', author_kind: 'human', scope: 'everyone', source_kind: 'manual_post', created_at: new Date().toISOString(), text: '合成客厅原帖' };
  t.mock.method(ZashideleMoments.prototype, 'read', async (id: string | null) => {
    livingReads++;
    return { status: 200, body: id ? livingItem : { items: [livingItem], next_cursor: null } };
  });
  const fakeSol = async (url: string, headers: Record<string,string>, payload: any) => {
    solCalls++;
    assert.ok(url.endsWith('/responses'));
    assert.equal(headers.authorization,'Bearer fixture-only');
    assert.equal(payload.text.format.name,'heartbeat_daily_memory_choice');
    assert.deepEqual(JSON.parse(payload.input[1].content).map((c:any)=>c.id).sort(),solCalls===1?['memory-a','memory-b']:['memory-a']);
    assert.ok(JSON.parse(payload.input[1].content).every((c:any)=>c.text===`合成记忆 ${c.id}`));
    assert.equal(payload.input.length,2);
    return {status:200,json:{id:'fixture-sol-response-'+solCalls,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({id:solCalls===1?'memory-b':'memory-a'})}]}]}};
  };
  const usage = { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.001 };
  let heart = false, operation = 'draw-1', target: number | null = null, wireNumber = 0, reveals = 0, memoryReveals = 0;
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, async payload => {
    const messages = payload.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>;
    let delta: Record<string, unknown> = { content: '合成正常聊天' }, finish = 'stop';
    if (heart) {
      const result = messages.find(message => message.role === 'tool' && message.tool_call_id === operation);
      if (!result) {
        const number = target ?? Number(host!.db.prepare("SELECT card_number AS n FROM heartbeat_cards WHERE source_kind='ext:fixture' ORDER BY card_number LIMIT 1").get()?.n);
        assert.ok(number >= 1 && number <= 10);
        delta = { tool_calls: [{ index: 0, id: operation, type: 'function', function: { name: 'heartbeat_draw', arguments: JSON.stringify({ card_number: number }) } }] };
      } else {
        if (JSON.stringify(result.content).includes('合成第七源')) reveals++;
        if (JSON.stringify(result.content).includes('合成记忆 memory-b')) memoryReveals++;
        delta = { tool_calls: [{ index: 0, id: operation + '-finish', type: 'function', function: { name: 'background_complete', arguments: '{"outcome":"noop"}' } }] };
      }
      finish = 'tool_calls';
    }
    return { status: 200, headers: new Headers(), body: Readable.from([
      `data: ${JSON.stringify({ id: `wire-${++wireNumber}`, choices: [{ delta }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage })}\n\n`, 'data: [DONE]\n\n',
    ]) };
  });
  const ready = readyRuntimePatch();
  const config = buildConfig({ ...ready, runtime: { ...ready.runtime as object, provider: 'mock', tool_schema_mode: 'direct' },
    openrouter: { model: 'anthropic/claude-fixture' }, content: { enabled: true, port: content.port }, background: { keepwarm: { sleep_window: { enabled: true, start:'23:59',end:'00:01',timezone:'Asia/Shanghai' } } } });
  host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0, runnerOverride: runner,
    heartbeatSources: [adapter], heartbeatDailyMemoryTransportForTest: fakeSol });
  await host.start();
  const base = `http://127.0.0.1:${host.port}`, token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  async function req(route: string, method = 'GET', body?: object, op?: string, revision?: number, expected = 200) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Origin: base };
    if (body) headers['Content-Type'] = 'application/json';
    if (op) headers['Idempotency-Key'] = op;
    if (revision !== undefined) headers['If-Match'] = `"${revision}"`;
    const response = await fetch(`${base}/api/v1${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, expected); return response.json();
  }
  const clock = (ms: number) => { t.mock.timers.setTime(ms); };
  let chats = 0;
  async function chatAndHeartbeat() {
    heart = false;
    clock(Date.now() + 2000);
    const m = host!.messages.submitUserMessageWithTurn({conversationId:'primary', content:'合成输入',clientMessageId:`input-${++chats}`});
    host!.supervisor.enqueue(m.turnId); await host!.supervisor.waitIdle();
    assert.equal(host!.db.prepare('SELECT state FROM turns WHERE id=?').get(m.turnId)?.state, 'completed');
    heart = true; clock(Date.now() + 3_001_000); await host!.scheduler!.tick(); await host!.supervisor.waitIdle();
  }
  const settings = await req('/background/settings');
  assert.equal(settings.keepwarm.include_living_room, false);
  await req('/background/settings', 'PUT', { keepwarm: { enabled: true, daily_cost_cap_usd: 5 } }, 'enable', 0);
  host.db.prepare('INSERT INTO runtime_settings(key,value,updated_at) VALUES(?,?,?)').run('or_model_price',JSON.stringify({input_micro_per_token:0.000003,output_micro_per_token:0.000015}),new Date().toISOString());
  host.db.prepare('INSERT INTO runtime_settings(key,value,updated_at) VALUES(?,?,?)').run('background_tool_prices',JSON.stringify({heartbeat_memory_select:{max_cost_micro_usd:7}}),new Date().toISOString());
  const count=(table:string)=>Number(host!.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n);
  const counts=['messages','turns','provider_requests','surfacing_jobs','heartbeat_runs'].map(count);
  clock(Date.parse('2026-11-20T16:00:05Z'));
  await host.scheduler!.tick();
  assert.equal(solCalls,1); assert.equal(memoryLists,1);
  assert.deepEqual(['messages','turns','provider_requests','surfacing_jobs','heartbeat_runs'].map(count),counts);
  const choice=host.db.prepare('SELECT * FROM heartbeat_daily_memory_choices').get()!;
  assert.equal(choice.memory_id,'memory-b'); assert.equal(choice.revision,1); assert.equal(choice.business_date,'2026-11-21');
  assert.equal(choice.frozen_at,'2026-11-20T16:00:00.000Z'); assert.equal(choice.selected_at,'2026-11-20T16:00:05.000Z');
  const memoryRun=(await req('/background/runs')).runs.find((r:any)=>r.kind==='heartbeat_memory');
  assert.equal(memoryRun.trigger_origin,'heartbeat_memory'); assert.equal(memoryRun.state,'completed');
  assert.equal(host.scheduler!.dailyOccupiedMicroUsd('keepwarm','2026-11-21'),7);
  assert.equal((await req('/background/heartbeat')).daily_memory.state,'selected');
  // Closed during midnight chat sleep still prepares memory only; ordinary
  // heartbeats below start outside sleep. Generic owner task edits are refused.
  await req('/background/tasks/bgt_heartbeat_daily_memory','PUT',{delay_seconds:60},'bad-system-edit',1,403);
  await req('/background/tasks/bgt_heartbeat_daily_memory','DELETE',undefined,'bad-system-delete',1,403);
  clock(Date.parse('2026-11-20T16:02:00Z'));
  const runtime = (host as unknown as { heartbeat: HeartbeatRuntime }).heartbeat;
  (runtime as unknown as {media:{mStore:unknown}}).media.mStore = { uploadBytes: async (bytes: Buffer) => ({content_hash:createHash('sha256').update(bytes).digest('hex')}) };
  const upload = async (bytes: Buffer, purpose: string, key: string) => {
    const response = await fetch(base + '/api/v1/assets?purpose=' + purpose, {method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:base,
      'Content-Type':'application/octet-stream','Idempotency-Key':key},body:bytes});
    assert.equal(response.status,201); return response.json();
  };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=','base64');
  const image = await upload(png,'chat_image','fixture-photo');
  const photo = await req('/content/albums/important_photos/entries','POST',{asset_id:image.asset_id},'photo',undefined,201);
  const aliasSticker = await req('/content/albums/stickers/entries','POST',{asset_id:image.asset_id},'alias-sticker',undefined,201);
  const stickerOnly = await upload(Buffer.concat([png,Buffer.from([7])]),'chat_sticker','fixture-sticker');
  const sticker = await req('/content/albums/stickers/entries','POST',{asset_id:stickerOnly.asset_id},'sticker',undefined,201);
  const code = await upload(Buffer.from('<!doctype html><html><body>synthetic work only</body></html>'),'creation_work','fixture-work');
  const work = await req('/content/creations','POST',{work_asset_id:code.asset_id,work_kind:'html',title:'合成作品'},'work',undefined,201);
  assert.ok(photo.id !== aliasSticker.id && sticker.id !== work.id);
  let excludedReads = 0;
  const transport = globalThis.fetch;
  t.mock.method(globalThis,'fetch', (input:URL|string|Request,init?:RequestInit) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (heart && (!init?.method || init.method === 'GET') && (pathname.startsWith('/api/v1/content/creations') || pathname.includes('/albums/stickers/')
      || pathname === '/api/v1/content/album-entries/' + sticker.id || pathname === '/api/v1/content/album-entries/' + aliasSticker.id)) excludedReads++;
    return transport(input,init);
  });
  await chatAndHeartbeat();
  assert.equal(listReads, 0); assert.equal(detailReads, 0); assert.equal(livingReads, 0);
  assert.equal((await req('/background/heartbeat')).mode, 'unprepared');

  await req('/background/settings', 'PUT', { keepwarm: { include_living_room: true } }, 'living-on', 1);
  enabled = true;
  await chatAndHeartbeat();
  const rows = host.db.prepare('SELECT card_number AS number, source_ref_json FROM heartbeat_cards ORDER BY card_number').all() as Array<{number:number;source_ref_json:string}>;
  const refs = rows.map(row => ({ number: row.number, source: JSON.parse(row.source_ref_json) as HeartbeatSource }));
  assert.equal(refs.length, 10); assert.equal(refs.filter(ref => ref.source.kind === 'ext:fixture').length, 7);
  assert.equal(refs.filter(ref => ref.source.kind === 'ext:living-room').length, 1);
  assert.deepEqual(refs.filter(ref => ref.source.kind === 'memory').map(ref => ref.source.id), ['memory-b']);
  assert.deepEqual(refs.filter(ref => ref.source.kind === 'album').map(ref=>ref.source.id),[photo.id]);
  assert.equal(excludedReads,0); assert.equal(memoryLists,1); assert.equal(solCalls,1);
  assert.equal(reveals, 1); assert.equal(listReads, 1); assert.ok(livingReads >= 2);
  const delivered = host.db.prepare("SELECT run_id,card_number FROM heartbeat_draw_operations WHERE state='delivered'").get() as {run_id:string;card_number:number};
  const cards = new HeartbeatCards(host.db), original = cards.getDeliveredDraw(delivered.run_id)!;
  assert.equal(original.source.kind,'ext:fixture');
  assert.equal(cards.isSourceEligible({ ...original.source, kind: 'wishstar', namespace: 'superposition', id: 'source-alias' }), false);
  await runtime.recoverProjections(10);
  const outbox = host.db.prepare("SELECT payload_ref FROM outbox WHERE target='content_heartbeat_projection' ORDER BY created_at DESC LIMIT 1").get() as {payload_ref:string};
  assert.equal(readHeartbeatProjection(JSON.parse(outbox.payload_ref))?.card?.source.kind,'ext:fixture');

  const memoryRef = refs.find(ref=>ref.source.kind === 'memory')!;
  target=memoryRef.number; operation='draw-daily-memory';
  await chatAndHeartbeat();
  assert.equal(memoryReveals,1);
  assert.equal(solCalls,1,'same daily deck never reruns the Sol choice');
  assert.equal(cards.isSourceEligible(memoryRef.source),false);
  assert.equal(new HeartbeatCards(host.db,()=>Date.now()+29*86400000).isSourceEligible(memoryRef.source),false);
  assert.equal(new HeartbeatCards(host.db,()=>Date.now()+31*86400000).isSourceEligible(memoryRef.source),true);

  const beforeOffReads = detailReads;
  enabled = false;
  assert.ok(!(await req('/background/heartbeat')).available_numbers.some((number: number) => refs.find(ref=>ref.number===number)?.source.kind === 'ext:fixture'));
  assert.equal((await runtime.cardForDisplay(delivered.run_id, 'primary'))?.status,'forbidden');
  assert.equal(detailReads,beforeOffReads);
  enabled = true;
  const changed = refs.find(ref => ref.source.kind === 'ext:fixture' && ref.number !== delivered.card_number)!;
  items.set(changed.source.id, 2); target = changed.number; operation = 'draw-changed';
  await chatAndHeartbeat();
  assert.equal(host.db.prepare('SELECT state FROM heartbeat_draw_operations WHERE operation_id=?').get(operation)?.state, 'rejected');
  assert.equal(reveals,1); assert.ok(!(await req('/background/heartbeat')).available_numbers.includes(target));
  assert.equal(host.db.prepare('SELECT source_ref_json FROM heartbeat_cards WHERE card_number=?').get(target)?.source_ref_json, rows.find(row=>row.number===target)?.source_ref_json);
  assert.equal(cards.getDeck('primary',heartbeatBusinessDate())?.deliveredNumbers.length,2);
  assert.equal(excludedReads,0);
  // An offline/missed midnight is not backfilled during the day; another
  // source failure still leaves all the existing nonmemory sources intact.
  heart=false;
  clock(Date.parse('2026-11-22T03:00:00Z'));
  await host.scheduler!.tick();
  assert.equal(solCalls,1);
  assert.equal(host.db.prepare("SELECT COUNT(*) n FROM heartbeat_daily_memory_choices WHERE business_date='2026-11-22'").get()?.n,0);
  assert.equal(host.db.prepare("SELECT result_code FROM background_runs WHERE kind='heartbeat_memory' ORDER BY rowid DESC LIMIT 1").get()?.result_code,'DAILY_MEMORY_MIDNIGHT_MISSED');
  // No trusted quote means no transmission, not a free or random fallback.
  host.db.prepare("DELETE FROM runtime_settings WHERE key='background_tool_prices'").run();
  clock(Date.parse('2026-11-22T16:00:05Z'));
  await host.scheduler!.tick();
  assert.equal(solCalls,1);
  assert.equal(host.db.prepare("SELECT result_code FROM background_runs WHERE kind='heartbeat_memory' ORDER BY rowid DESC LIMIT 1").get()?.result_code,'BUDGET_ESTIMATE_UNAVAILABLE');
  host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('background_tool_prices',?,?)")
    .run(JSON.stringify({heartbeat_memory_select:{max_cost_micro_usd:7}}),new Date().toISOString());
  // Miss the following day entirely, then return during a real midnight.
  // Only that day's choice may be made immediately, and the previously read
  // memory remains blocked by the same 30-day delivery ledger.
  clock(Date.parse('2026-11-24T16:00:05Z'));
  await host.scheduler!.tick();
  assert.equal(solCalls,2);
  assert.equal(host.db.prepare("SELECT memory_id FROM heartbeat_daily_memory_choices WHERE business_date='2026-11-25'").get()?.memory_id,'memory-a');
  assert.equal(host.db.prepare("SELECT COUNT(*) n FROM heartbeat_daily_memory_choices WHERE business_date='2026-11-24'").get()?.n,0);
});
