import {test} from 'node:test';
import { assembleTestTools, fullToolCatalog, makeDb } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildConfig} from '../../apps/host/src/config/schema.ts';
import {MessageService} from '../../apps/host/src/messages/service.ts';
import {freezeWindowTools,storedToolset,definitionId,buildDeferredTools,effectiveToolName} from '../../apps/host/src/runtime/tool-discovery.ts';
import {MariposaClient} from '../../apps/host/src/integrations/mariposa/client.ts';
import {RotationReviewService} from '../../apps/host/src/context/rotation-review.ts';
import {HoldCheckpointService} from '../../apps/host/src/memory/hold-checkpoint.ts';

function fixture(t:any){
 const {db,root}=makeDb();t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});
 const messages=new MessageService(db);messages.ensureConversation('c1');
 db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w1','c1','ACTIVE','now','now')").run();
 const sub=messages.submitUserMessageWithTurn({conversationId:'c1',content:'合成输入',clientMessageId:'fixture'});
 const calls:any[]=[];
 const mariposa=new MariposaClient({transport:async(cap,payload)=>{calls.push({cap,payload});return {ok:true,result:{operation_id:payload.operation_id,memory_id:'m1',version:1,binding_ids:[],committed_at:'2026-10-21T12:00:00Z'}}}});
 const { tools: executor } = assembleTestTools({ db: db, mariposa: mariposa, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
 const ctx={roomId:'c1',windowId:'w1',turnId:sub.turnId,requestId:'req1',purpose:'chat' as const,activeReviewId:null,seenSequence:sub.message.sequence,seenMessages:[]};
 const persist=(tools:any[],messages:any[]=[])=>db.prepare("INSERT OR REPLACE INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,sent_at,created_at) VALUES ('req1','w1',?,?,'chat','[]',?,'now','now')").run(sub.attemptId,sub.turnId,JSON.stringify({tools,messages}));
 return {db,executor,ctx,calls,persist};
}

test('new windows advertise three fixed entry points; definitions never grow the tools prefix',t=>{
 const f=fixture(t);const all=fullToolCatalog();const small=freezeWindowTools(f.db,'w1',all,'deferred');
 assert.deepEqual(small.map(t=>t.function.name),['tool_catalog','tool_define','tool_invoke']);
 assert.ok(JSON.stringify(small).length<JSON.stringify(all).length/5);
 const changed=all.map(t=>({...t,function:{...t.function,description:'changed'}}));
 assert.deepEqual(freezeWindowTools(f.db,'w1',changed,'legacy'),small,'restart/config changes preserve persisted prefix');
});

test('old windows recover exactly sent tools including empty toolset, never replace cached prefix',t=>{
 const f=fixture(t);const old=[fullToolCatalog()[0]];f.persist(old);
 assert.deepEqual(freezeWindowTools(f.db,'w1',fullToolCatalog(),'deferred'),old);
 assert.equal(storedToolset(f.db,'w1')!.protocol,'legacy');
 f.db.prepare('DELETE FROM window_toolsets').run();f.persist([]);
 assert.deepEqual(freezeWindowTools(f.db,'w1',fullToolCatalog(),'deferred'),[]);
});

test('define then sent proof before invoke; no direct/forged/cross-room invocation; compact hold preserves receipt',async t=>{
 const f=fixture(t);const tools=freezeWindowTools(f.db,'w1',fullToolCatalog(),'deferred');f.persist(tools);
 const before=JSON.stringify(tools);
 const args={original_title:'合成',categories:['daily'],text:'合成完整正文',creation_mode:'contemporaneous',date_confidence:'exact'};
 assert.equal((await f.executor.execute('memory_hold',args,f.ctx)).ok,false);
 assert.equal((await f.executor.execute('tool_define',{name:'not-real'},f.ctx)).ok,false);
 const defined=await f.executor.execute('tool_define',{name:'memory_hold'},f.ctx);assert.equal(defined.ok,true);
 const invoke={name:'memory_hold',definition_id:defined.output.definition_id,arguments:args};
 assert.equal((await f.executor.execute('tool_invoke',invoke,f.ctx)).output.error_code,'TOOL_DEFINITION_NOT_SEEN');
 f.persist(tools,[{role:'user',content:JSON.stringify(defined.output)}]);
 assert.equal((await f.executor.execute('tool_invoke',invoke,f.ctx)).ok,false);
 f.persist(tools,[{role:'assistant',tool_calls:[{id:'def-call',function:{name:'tool_define',arguments:JSON.stringify({name:'memory_hold'})}}]}, {role:'tool',tool_call_id:'def-call',content:JSON.stringify(defined.output)}]);
 assert.equal((await f.executor.execute('tool_invoke',invoke,{...f.ctx,roomId:'other'})).ok,false);
 const repeated=await f.executor.execute('tool_define',{name:'memory_hold'},f.ctx);assert.equal(repeated.output.already_available,true);assert.equal(repeated.output.parameters,undefined);
 const held=await f.executor.execute('tool_invoke',invoke,f.ctx);assert.deepEqual(held.output,{saved:true,memory_id:'m1',source_status:'unbound'});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].cap,'memory.hold');
 assert.ok(f.calls[0].payload.operation_id.startsWith('es-hold-'));
 assert.equal(JSON.stringify(storedToolset(f.db,'w1')!.tools),before);
 const effect=f.db.prepare('SELECT state,verified,memory_id,operation_id FROM tool_side_effects').get() as any;
 assert.equal(effect.state,'committed');assert.equal(effect.verified,1);assert.equal(effect.memory_id,'m1');assert.equal(effect.operation_id,f.calls[0].payload.operation_id);
});

test('catalog does not expose schemas and invoke cannot inject reserved args',async t=>{
 const f=fixture(t);freezeWindowTools(f.db,'w1',fullToolCatalog(),'deferred');
 const result=await f.executor.execute('tool_catalog',{},f.ctx);
 assert.ok(Array.isArray(result.output.tools));assert.ok(!JSON.stringify(result.output).includes('parameters'));
 assert.equal(effectiveToolName('tool_invoke','{"name":"context_review_complete"}'),'context_review_complete');
});

test('new-window default is deferred; explicit legacy remains a compatibility option',()=>{assert.equal(buildConfig().runtime.tool_schema_mode,'deferred');assert.equal(buildConfig({runtime:{tool_schema_mode:'legacy'}}).runtime.tool_schema_mode,'legacy');assert.throws(()=>buildConfig({runtime:{tool_schema_mode:'unknown'}}));});
