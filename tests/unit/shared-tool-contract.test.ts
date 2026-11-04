import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assembleTestTools,makeDb,tempRoot} from '../helpers.ts';
import {MessageService} from '../../apps/host/src/messages/service.ts';
import {freezeWindowTools,storedToolset,recordToolContext,definitionId} from '../../apps/host/src/runtime/tool-discovery.ts';
import {WISHSTAR_READ_ACTIONS} from '../../apps/host/src/modules/wishstar/service.ts';
import {validateArgsAgainstSchema} from '../../apps/host/src/capabilities/validation.ts';

test('共享制品过期可检出；生成副本不能靠改 golden 通过',t=>{
 const source=new URL('../../apps/host/src/integrations/mariposa/contracts/capabilities.v1.json',import.meta.url);
 const root=tempRoot('contract-stale-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const text=fs.readFileSync(source,'utf8');fs.writeFileSync(path.join(root,'capabilities.v1.json'),text);
 const check=()=>spawnSync(process.execPath,['scripts/sync-mariposa-contract.mjs',root,'--check'],{encoding:'utf8'});
 assert.equal(check().status,0);
 const stale=JSON.parse(text);stale.capabilities.find((c:any)=>c.canonical_name==='memory.hold').input_schema.properties.original_title.maxLength=31;
 fs.writeFileSync(path.join(root,'capabilities.v1.json'),JSON.stringify(stale));assert.notEqual(check().status,0);
});

test('许愿星实际领域 DTO：五种读取、请求定位、所有写分支和打开正文不丢失',async t=>{
 const {db,root}=makeDb();t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/wishstar-domain-responses.json',import.meta.url),'utf8')).responses;
 const messages=new MessageService(db);messages.ensureConversation('c1');
 db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES('w1','c1','ACTIVE','now','now')").run();
 const sub=messages.submitUserMessageWithTurn({conversationId:'c1',content:'合成许愿星上下文',clientMessageId:'synthetic'});
 let responseName='';const calls:any[]=[];
 const {tools,registry}=assembleTestTools({db,media:{} as any,messages,wishstar:{forward:async(method:string,url:string,body:unknown)=>{calls.push({method,url,body});return {status:200,body:structuredClone(fixture[responseName])};}} as any});
 freezeWindowTools(db,'w1',registry.currentCatalog(),'deferred',registry.currentGroups());
 const set=storedToolset(db,'w1')!;
 const context=[{role:'system',content:set.initialText}];
 db.prepare("INSERT INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,sent_at,created_at) VALUES('r','w1',?,?,'chat','[]',?,'now','now')").run(sub.attemptId,sub.turnId,JSON.stringify({messages:context}));
 recordToolContext(db,'r','w1',context);
 const ctx={roomId:'c1',windowId:'w1',turnId:sub.turnId,requestId:'r',purpose:'chat' as const,activeReviewId:null,seenSequence:1,seenMessages:[]};
 const run=async(name:string,args:Record<string,unknown>)=>{
  const spec=set.catalog.find(s=>s.function.name===name)!;assert.equal(validateArgsAgainstSchema(args,spec.function.parameters).ok,true,name);
  const before=calls.length;
  const result=await tools.execute('tool_invoke',{name,definition_id:definitionId(spec),arguments:args},ctx);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(calls.length,before+1,name);return result.output;
 };
 let requestId='';
 for(const [what,target] of Object.entries(WISHSTAR_READ_ACTIONS)){
  responseName=target;const result=await run('wishstar_read',{what});
  assert.ok(Object.keys(result).length,what);
  if(what==='requests')requestId=(result.incoming as any[])[0].id;
  if(what==='notifications')assert.equal(result.consumed,0);
  if(what==='hidden'){assert.equal((result.items as any[])[0].content,'SYNTHETIC_PRIVATE_REMAINING');assert.equal((result.items as any[])[0].being_offered,false);}
 }
 const args:Record<string,Record<string,unknown>>={
  wishstar_write_star:{content:'合成星',visibility:'hidden',idempotency_key:'fixture'},
  wishstar_offer_star:{star_id:fixture.wishstar_offer_star.star_id},
  wishstar_accept_offer:{offer_id:fixture.wishstar_list_offers.incoming[0].id},
  wishstar_request_star:{},wishstar_respond_request:{request_id:requestId,decision:'give'},
  wishstar_start_session:{special_date_id:fixture.wishstar_start_session.special_date_id},
  wishstar_confirm_session:{session_id:fixture.wishstar_confirm_session.id},
  wishstar_take_star:{session_id:fixture.wishstar_start_session.id},
  wishstar_finish_session:{session_id:fixture.wishstar_finish_session.id},
 };
 const writes=set.catalog.filter(s=>s.function.name.startsWith('wishstar_')&&s.function.name!=='wishstar_read');
 assert.deepEqual(Object.keys(args).sort(),writes.map(s=>s.function.name).sort(),'new actions require a real DTO case');
 for(const [name,input] of Object.entries(args)){
  responseName=name;const result=await run(name,input);
  if(name==='wishstar_take_star'||name==='wishstar_accept_offer'){
   assert.equal(result.content,fixture[name].content);assert.equal(result.state,'SHARED');
   assert.deepEqual(result.new_response_ids,[]);assert.ok(Array.isArray(result.responses));
  }
  if(name==='wishstar_respond_request')assert.equal((result.request as any).id,requestId);
 }
});
