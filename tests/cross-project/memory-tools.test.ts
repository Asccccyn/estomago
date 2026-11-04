// Invoked by the existing isolated loopback runner; no model or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assembleTestTools, makeDb } from '../helpers.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { ArchiveSyncService } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { freezeWindowTools, definitionId } from '../../apps/host/src/runtime/tool-discovery.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const base = process.env.CROSS_MARIPOSA_URL!;
assert.ok(base.startsWith('http://127.0.0.1:'));
const expected = JSON.parse(fs.readFileSync(process.env.CROSS_MARIPOSA_EXPECTED!, 'utf8'));
const nativeFetch = globalThis.fetch;
const wire: any[] = [];
globalThis.fetch = async (input, init) => {
  assert.equal(new URL(String(input)).origin, base);
  const response = await nativeFetch(input, init);
  wire.push({ capability: String(input).split('/').at(-1), request: JSON.parse(String(init?.body)),
    status: response.status, response: await response.clone().json() });
  return response;
};
const { db } = makeDb();
try {
  const messages = new MessageService(db); messages.ensureConversation('primary');
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w1','primary','ACTIVE','now','now')").run();
  const sub = messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '合成原话 AbC  原生空格。第二句“引号”。', clientMessageId: 'fixture' });
  const client = new MariposaClient({ baseUrl: base, credentialEnv: 'ESTOMAGO_TEST_MARIPOSA_TOKEN' });
  const archiveSync = new ArchiveSyncService({db,events:new EventService(db),logger:new Logger(null),client:new MariposaClient({baseUrl:base,credentialEnv:'ESTOMAGO_TEST_MARIPOSA_WORKER_TOKEN'}),config:buildConfig({integrations:{mariposa:{base_url:base}},archive:{enabled:true,source_scope:'estomago-primary-live'}})});
  const synced = await archiveSync.drainOnce(); assert.equal(synced.acked,1,JSON.stringify(synced));
  const { tools, registry } = assembleTestTools({ db, messages, media: {} as never, mariposa: client, archiveSync,
    reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const catalog = registry.currentCatalog();
  const frozen = freezeWindowTools(db, 'w1', catalog, 'deferred',registry.currentGroups());
  const history: any[] = [{role:'user',content:'[1] 合成原话 AbC  原生空格。第二句“引号”。'}];
  const ctx = { roomId: 'primary', windowId: 'w1', turnId: sub.turnId, requestId: 'req1', purpose: 'chat' as const,
    activeReviewId: null, seenSequence: sub.message.sequence, seenMessages: [{id:sub.message.id,revision:1}] };
  let count = 0;
  async function invoke(name: string, args: Record<string, unknown>) {
    const spec = catalog.find(s => s.function.name === name)!;
    assert.ok(spec, name);
    const defined = await tools.execute('tool_define', { name }, ctx);
    if (!defined.output.already_available) {
      history.push({ role: 'assistant', tool_calls: [{ id: `d${count}`, function: { name: 'tool_define', arguments: JSON.stringify({ name }) } }] },
        { role: 'tool', tool_call_id: `d${count}`, content: JSON.stringify(defined.output) });
    }
    db.prepare("INSERT OR REPLACE INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,sent_at,created_at) VALUES ('req1','w1',?,?,'chat','[]',?,'now','now')")
      .run(sub.attemptId, sub.turnId, JSON.stringify({ tools: frozen, messages: history }));
    return tools.execute('tool_invoke', { name, definition_id: definitionId(spec), arguments: args }, { ...ctx, toolCallId: `c${++count}` });
  }
  const emotion = await invoke('memory_i_read', { what: 'emotion' });
  assert.equal(emotion.ok, true, JSON.stringify(emotion));
  assert.ok((emotion.output.vocabulary as string[]).length > 0);
  assert.equal(emotion.output.mood_text_memories, 0);
  assert.equal(emotion.output.retrieval_enabled, false);
  assert.ok(Object.values(emotion.output.mood_tag_counts as object).every(v => v === 0));

  const iReadChecks:Record<string,(out:any)=>void>={
    current:out=>assert.ok(out.content || Array.isArray(out.items)),
    items:out=>assert.ok(Array.isArray(out.items)),
    item:out=>assert.equal(out.item_id,expected.item.item_id),
    item_history:out=>assert.ok(Array.isArray(out.revisions)),
    doc_history:out=>assert.ok(Array.isArray(out.versions)),
    emotion:out=>assert.equal(typeof out.retrieval_enabled,'boolean'),
  };
  const iEnum=(catalog.find(s=>s.function.name==='memory_i_read')!.function.parameters.properties as any).what.enum;
  assert.deepEqual([...iEnum].sort(),Object.keys(iReadChecks).sort(),'new read actions need a real HTTP projection case');
  for(const [what,check] of Object.entries(iReadChecks)){
    const out=await invoke('memory_i_read',{what,...(['item','item_history'].includes(what)?{item_id:expected.item.item_id}:{})});
    assert.equal(out.ok,true,JSON.stringify(out));check(out.output);
  }
  for (const depth of [undefined, 10]) {
    const r = await invoke('memory_relations', { action: 'trace', memory_id: expected.memories[11], ...(depth ? { max_depth: depth } : {}) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.output.max_depth, depth ?? 5);
    assert.equal((r.output.earlier as unknown[]).length, depth ?? 5);
    assert.deepEqual(r.output.later, []); assert.equal(r.output.truncated, true);
    assert.equal(r.output.visited, (depth ?? 5) + 1);
  }
  for (const max_depth of [0, 11, 1.5, '10']) {
    const before = wire.length;
    assert.equal((await invoke('memory_relations', { action: 'trace', memory_id: expected.memories[11], max_depth })).ok, false);
    assert.equal(wire.length, before, 'schema rejects before HTTP');
  }
  const planArgs = { plan_id: expected.plan.plan_id, include_links: true };
  const plan = await invoke('plans_read', planArgs);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const link = (plan.output.links as any[])[0]; assert.ok(link.link_id);
  const correction = await invoke('memory_correct', { action: 'plan_link', link_id: link.link_id, correction_action: 'remove_wrong_binding', note: '合成纠错' });
  assert.equal(correction.ok, true, JSON.stringify(correction));
  assert.equal(correction.output.removed_link_id, link.link_id);
  assert.equal(correction.output.replacement_link_id, null);
  assert.equal(correction.output.action, 'remove_wrong_binding');
  assert.deepEqual((await invoke('plans_read', planArgs)).output.links, []);
  const iArgs = { what: 'item_history', item_id: expected.item.item_id };
  const item = await invoke('memory_i_read', iArgs);
  const relation = (item.output.revisions as any[])[0].relations[0]; assert.ok(relation.relation_id);
  const corrected = await invoke('memory_correct', { action: 'i_relation', relation_id: relation.relation_id, correction_action: 'remove_wrong_binding' });
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  const readBack = await invoke('memory_i_read', iArgs);
  assert.equal(readBack.ok, true);
  assert.ok((readBack.output.revisions as any[]).every(r => !r.relations?.some((x: any) => x.relation_id === relation.relation_id))); 

  for (const [categories, success] of [[['daily', 'sweet'], true], [['diary'], true], [['diary', 'daily'], false], [['reloplay', 'anniversary'], false]] as const) {
    const r = await invoke('memory_hold', { original_title: '合成分类', text: '合成分类正文', creation_mode: 'contemporaneous', categories });
    assert.equal(r.ok, success, JSON.stringify(r));
    if (success) assert.equal(r.output.saved, true);
    else assert.equal(r.output.error_code, 'HOLD_EXCLUSIVE_CATEGORY');
  }

  const recalled = await invoke('memory_recall', { query:'合成事件', lexical_terms:['合成事件'] });
  assert.equal(recalled.ok, true, JSON.stringify(recalled));
  const ref = (recalled.output.candidates as any[])[0].memory_ref;
  assert.ok(ref);
  const notSent = await invoke('memory_read_full', { memory_ref:ref });
  assert.equal(notSent.output.error_code, 'DETAIL_REF_NOT_SEEN');
  history.push({role:'assistant',tool_calls:[{id:'recall-sent',function:{name:'tool_invoke',arguments:JSON.stringify({name:'memory_recall',arguments:{query:'合成事件'}})}}]},
    {role:'tool',tool_call_id:'recall-sent',content:JSON.stringify(recalled.output)});
  const beforeRead = wire.length;
  const full = await invoke('memory_read_full', {memory_ref:ref});
  assert.equal(full.ok,true,JSON.stringify(full));
  assert.match(String(full.output.text), /AbC  原生空格。\n第二行/);
  assert.deepEqual(wire.slice(beforeRead).map(x=>x.capability),['memory.detail.read'],'no recall/JEV/open for full read');
  const next = recalled.output.next as {tool:string;arguments:Record<string,unknown>};
  assert.equal(next.tool,'memory_recall_next');
  const page = await invoke(next.tool,next.arguments);
  assert.equal(page.ok,true,JSON.stringify(page));
  const all = [...recalled.output.candidates as any[],...page.output.candidates as any[]];
  assert.equal(new Set(all.map(c=>c.resource_ref)).size,12);
  const finalNext = page.output.next;
  assert.equal(finalNext,undefined);
  const prior = await invoke('memory_recall',{query:'合成分类',lexical_terms:['合成分类']});
  const refine = prior.output.next as {tool:string;arguments:Record<string,unknown>};
  assert.equal(refine.tool,'memory_recall');
  assert.equal(refine.arguments.query,'合成分类');
  assert.equal((await invoke(refine.tool,refine.arguments)).ok,true,'next.arguments invoked verbatim');


  history.push({role:'assistant',tool_calls:[{id:'page-sent',function:{name:'tool_invoke',arguments:JSON.stringify({name:'memory_recall_next',arguments:next.arguments})}}]},
    {role:'tool',tool_call_id:'page-sent',content:JSON.stringify(page.output)});
  const wordBucket = all.find(c=>c.memory_id===expected.memories[0]);
  const wordDetail = await invoke('memory_read_full',{memory_ref:wordBucket.memory_ref});
  assert.equal(wordDetail.ok,true,JSON.stringify(wordDetail));
  assert.ok((wordDetail.output.our_words as any[])[0].word_id,'word IDs must be readable');
  const held = await invoke('memory_hold',{original_title:'合成引用',categories:['daily','sweet'],text:'合成经历与感受正文',creation_mode:'contemporaneous',quotes:[{seq:1,from:1,to:1}],source_ranges:[{start_seq:1,end_seq:1}],mood_note:'合成心情文字'});
  assert.equal(held.ok,true,JSON.stringify(held));assert.ok(Array.isArray(held.output.source_selections));
  const holdWire = wire.findLast(call=>call.capability==='memory.hold').request.arguments;
  assert.equal(holdWire.our_words[0].speaker,'qiaosheng');
  assert.equal(holdWire.our_words[0].text,'合成原话 AbC  原生空格。');
  assert.equal(holdWire.mood.text,'合成心情文字');
  assert.ok(holdWire.event_source_ranges[0].members[0].content_hash);
  assert.equal(wire.findLast(call=>call.capability==='memory.hold').response.data.binding_ids.length,1);
  const episode = await invoke('episode_apply',{action:'start',label:'合成事件线',reason_code:'tracking_requested',source_selections:held.output.source_selections});
  assert.equal(episode.ok,true,JSON.stringify(episode));
  let beforeEpisode=wire.length;
  const episodeList=await invoke('episode_read',{});
  assert.equal(episodeList.ok,true,JSON.stringify(episodeList));
  assert.equal(wire.length,beforeEpisode+1);
  const episodeId=(episodeList.output.episodes as any[])[0].episode_id;
  beforeEpisode=wire.length;
  const episodeDetail=await invoke('episode_read',{episode_id:episodeId});
  assert.equal(episodeDetail.ok,true,JSON.stringify(episodeDetail));
  assert.equal(wire.length,beforeEpisode+1);
  assert.ok(episodeDetail.output.source_selections);

  const added = await invoke('memory_words_write',{action:'add',memory_id:held.output.memory_id,refs:[{seq:1,from:2,to:2}]});
  assert.equal(added.ok,true,JSON.stringify(added));assert.equal(added.output.action,'add');
  const revised = await invoke('memory_words_write',{action:'revise',memory_id:held.output.memory_id,word_id:(added.output.word_ids as string[])[0],refs:[{seq:1,from:1,to:1}]});
  assert.equal(revised.ok,true,JSON.stringify(revised));
  for (const args of [
    {creation_mode:'retrospective'},
    {creation_mode:'retrospective',memory_date:'2026-10-01',mood_note:'不应保存'},
    {creation_mode:'contemporaneous',quotes:[{seq:1,from:1}]},
  ]) {
    const before=wire.length;
    const bad = await invoke('memory_hold',{original_title:'合成非法边界',categories:['daily'],text:'合成',...args});
    assert.equal(bad.ok,false);assert.equal(wire.length,before,'invalid host parameters never reach M');
  }
  const revisedI=await invoke('memory_i_write',{action:'revise',item_id:expected.item.item_id,expected_revision:expected.item.revision,content:'合成 I 新修订'});
  assert.equal(revisedI.ok,true,JSON.stringify(revisedI));
  const restoredI=await invoke('memory_i_write',{action:'restore',item_id:expected.item.item_id,expected_revision:revisedI.output.revision,restore_revision:expected.item.revision,relations:[{memory_id:expected.memories[1],relation_type:'related_to'}]});
  assert.equal(restoredI.ok,true,JSON.stringify(restoredI));
  const restoredHistory=await invoke('memory_i_read',{what:'item_history',item_id:expected.item.item_id});
  assert.equal((restoredHistory.output.revisions as any[]).at(-1).relations[0].memory_id,expected.memories[1]);
  const retrospective=await invoke('memory_hold',{original_title:'合成补记',categories:['daily'],text:'合成过去事件',creation_mode:'retrospective',memory_date:'2026-10-01'});
  assert.equal(retrospective.ok,true,JSON.stringify(retrospective));
  // A real M first round is supplied as synthetic context; its stored plan has
  // completed lexical retrieval. E's normal semantic path is tested above.
  let raw = await invoke('memory_recall',{query:expected.raw_first.continuation.query,deep_search:true,
    refine_session_id:expected.raw_first.recall_session_id,deep_reason:expected.raw_first.continuation.reason});
  const rawRefs = new Set<string>();
  for (let step=0;step<5;step++) {
    assert.equal(raw.ok,true,JSON.stringify(raw));
    for (const card of raw.output.candidates as any[]) rawRefs.add(card.resource_ref);
    const next = raw.output.next as {tool:string;arguments:Record<string,unknown>} | undefined;
    if (!next) break;
    raw = await invoke(next.tool,next.arguments);
  }
  assert.equal(rawRefs.size,25,'frozen result pages and raw continuation remain distinct, no skipped source rows');
  const longText='长片锚点 AbC  原生空格。\n'+ '甲乙丙丁  XyZ\n'.repeat(3200);
  const longHold=await invoke('memory_hold',{original_title:'合成长片',text:longText,categories:['daily'],creation_mode:'contemporaneous'});
  assert.equal(longHold.ok,true,JSON.stringify(longHold));
  let longPage=await invoke('memory_recall',{query:'长片锚点',lexical_terms:['长片锚点']});
  let delivered='';let offset=0;
  for(let step=0;step<30;step++){
    assert.equal(longPage.ok,true,JSON.stringify(longPage));
    const wirePage=wire.at(-1)!.response.data;
    const longWire=(wirePage.candidates??[]).filter((c:any)=>c.memory_id===longHold.output.memory_id&&c.fragment?.kind==='evidence_snippet'&&c.fragment.evidence_index===0);
    const cards=(longPage.output.candidates as any[]).filter(c=>c.memory_id===longHold.output.memory_id&&c.fragment?.kind==='evidence_snippet'&&c.fragment.evidence_index===0);
    assert.deepEqual(cards.map(c=>c.fragment),longWire.map((c:any)=>c.fragment),'authored fragment and incomplete marker survive toModel');
    for(const card of cards){assert.equal(card.fragment.start_char,offset);delivered+=card.fragment.text;offset=card.fragment.end_char;assert.equal(card.fragment.content_complete,false);}
    const next=longPage.output.next as {tool:string;arguments:Record<string,unknown>}|undefined;
    if(!next||next.tool!=='memory_recall_next')break;
    longPage=await invoke(next.tool,next.arguments);
  }
  assert.equal(delivered,longText,'full authored text reconstructed from actual HTTP pages');
  fs.writeFileSync(process.env.CROSS_MARIPOSA_RESULT!, JSON.stringify({ evidence: 'A01-A04/A09/A10/A12 frozen schema → ModelToolBridge → actual HTTP legacy profile → domain → toModel', wire }, null, 2));
  console.log('P1/P2: actual HTTP, delivered detail and structured continuation contracts passed; synthetic data only');
} finally { globalThis.fetch = nativeFetch; db.close(); }
