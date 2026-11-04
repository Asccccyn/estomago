// Invoked by the existing isolated loopback runner; no model or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assembleTestTools, makeDb } from '../helpers.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
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
  const messages = new MessageService(db); messages.ensureConversation('c1');
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w1','c1','ACTIVE','now','now')").run();
  const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '合成上下文', clientMessageId: 'fixture' });
  const client = new MariposaClient({ baseUrl: base, credentialEnv: 'ESTOMAGO_TEST_MARIPOSA_TOKEN' });
  const { tools, registry } = assembleTestTools({ db, messages, media: {} as never, mariposa: client,
    reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  const catalog = registry.currentCatalog();
  const frozen = freezeWindowTools(db, 'w1', catalog, 'deferred');
  const history: any[] = [];
  const ctx = { roomId: 'c1', windowId: 'w1', turnId: sub.turnId, requestId: 'req1', purpose: 'chat' as const,
    activeReviewId: null, seenSequence: sub.message.sequence, seenMessages: [] };
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

  for (const depth of [undefined, 10]) {
    const r = await invoke('memory_correct', { action: 'trace', memory_id: expected.memories[11], ...(depth ? { max_depth: depth } : {}) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.output.max_depth, depth ?? 5);
    assert.equal((r.output.earlier as unknown[]).length, depth ?? 5);
    assert.deepEqual(r.output.later, []); assert.equal(r.output.truncated, true);
    assert.equal(r.output.visited, (depth ?? 5) + 1);
  }
  for (const max_depth of [0, 11, 1.5, '10']) {
    const before = wire.length;
    assert.equal((await invoke('memory_correct', { action: 'trace', memory_id: expected.memories[11], max_depth })).ok, false);
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
  fs.writeFileSync(process.env.CROSS_MARIPOSA_RESULT!, JSON.stringify({ evidence: 'A01-A04/A09/A10/A12 frozen schema → ModelToolBridge → actual HTTP legacy profile → domain → toModel', wire }, null, 2));
  console.log('P1/P2: actual HTTP, delivered detail and structured continuation contracts passed; synthetic data only');
} finally { globalThis.fetch = nativeFetch; db.close(); }
