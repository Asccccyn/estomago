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
import {EventService} from '../../apps/host/src/events/service.ts';
import {readToolActivity} from '../../apps/host/src/server/tool-activity.ts';

function fixture(t:any){
 const {db,root}=makeDb();t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});
 const messages=new MessageService(db);messages.ensureConversation('c1');
 db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w1','c1','ACTIVE','now','now')").run();
 const sub=messages.submitUserMessageWithTurn({conversationId:'c1',content:'合成输入',clientMessageId:'fixture'});
 const calls:any[]=[];
 const mariposa=new MariposaClient({transport:async(cap,payload)=>{
   calls.push({cap,payload});
   if (cap === 'memory.update') return { ok: true, result: { memory_id: 'm1', version: 2 } };
   return {ok:true,result:{operation_id:payload.operation_id,memory_id:'m1',version:1,binding_ids:[],committed_at:'2026-10-21T12:00:00Z'}};
 }});
 const { tools: executor } = assembleTestTools({ db: db, mariposa: mariposa, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), events: new EventService(db) });
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
 // P6/U01（20261106）：定义阅读不再是授权——define 后（未发送/未在其他房间"看过"）直接执行
 const early=await f.executor.execute('tool_invoke',invoke,f.ctx);
 assert.deepEqual(early.output,{saved:true,memory_id:'m1',version:1,source_status:'unbound'},'未发送定义即执行');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].cap,'memory.hold');
 // 伪造 definition_id=版本不符拒绝（冻结版本校验保留）
 const forged=await f.executor.execute('tool_invoke',{name:'memory_hold',definition_id:'td_deadbeef',arguments:args},f.ctx);
 assert.equal((forged.output as {error_code:string}).error_code,'TOOL_DEFINITION_STALE');
 f.persist(tools,[{role:'assistant',tool_calls:[{id:'def-call',function:{name:'tool_define',arguments:JSON.stringify({name:'memory_hold'})}}]}, {role:'tool',tool_call_id:'def-call',content:JSON.stringify(defined.output)}]);
 const repeated=await f.executor.execute('tool_define',{name:'memory_hold'},f.ctx);assert.equal(repeated.output.already_available,true);assert.equal(repeated.output.parameters,undefined);
 const held=await f.executor.execute('tool_invoke',invoke,f.ctx);assert.deepEqual(held.output,{saved:true,memory_id:'m1',version:1,source_status:'unbound'});
 assert.equal(f.calls.length,2);assert.equal(f.calls.at(-1)!.cap,'memory.hold');
 assert.ok(f.calls[0].payload.operation_id.startsWith('es-hold-'));
 assert.equal(JSON.stringify(storedToolset(f.db,'w1')!.tools),before);
 const effect=f.db.prepare('SELECT state,verified,memory_id,operation_id FROM tool_side_effects').get() as any;
 assert.equal(effect.state,'committed');assert.equal(effect.verified,1);assert.equal(effect.memory_id,'m1');assert.equal(effect.operation_id,f.calls[0].payload.operation_id);
});

test('memory_update uses the verified hold version and applies Mariposa field rules in a frozen window', async t => {
  const f = fixture(t);
  const catalog = structuredClone(fullToolCatalog());
  const definition = catalog.find(t => t.function.name === 'memory_update')!;
  const fields = definition.function.parameters.properties as Record<string, Record<string, unknown>>;
  assert.equal(fields.text!.minLength, 1);
  assert.equal(fields.original_title!.maxLength, 30);
  assert.deepEqual(fields.date_confidence!.enum, ['exact', 'inferred', 'unknown']);
  // Recreate the previously published field shapes before freezing the window.
  for (const field of ['text', 'original_title', 'date_confidence']) {
    fields[field] = { type: 'string', description: fields[field]!.description };
  }
  freezeWindowTools(f.db, 'w1', catalog, 'deferred');
  const snapshot = f.db.prepare('SELECT catalog_json FROM window_toolsets WHERE window_id=?').get('w1');
  const call = (name: string, args: Record<string, unknown>) => f.executor.execute('tool_invoke', { name, arguments: args }, f.ctx);
  const saved = await call('memory_hold', { original_title: '合成', categories: ['daily'], text: '合成正文', creation_mode: 'contemporaneous' });
  assert.equal(saved.ok, true);
  const update = { memory_id: saved.output.memory_id, expected_version: saved.output.version };
  for (const [field, input, code] of [
    ['text', '', 'TOOL_ARG_LENGTH'], ['original_title', '', 'TOOL_ARG_LENGTH'],
    ['original_title', '😀'.repeat(31), 'TOOL_ARG_LENGTH'], ['date_confidence', 'certain', 'TOOL_ARG_ENUM'],
    ['memory_date', null, 'TOOL_ARG_TYPE'],
  ] as const) {
    const result = await call('memory_update', { ...update, [field]: input });
    assert.equal(result.ok, false);
    assert.equal(result.output.error_code, code);
    assert.ok(String(result.output.error).startsWith('/' + field));
  }
  assert.equal(f.calls.length, 1, 'invalid updates never reach Mariposa');
  const fieldsToSave = { ...update, text: '修订后的正文', original_title: '😀'.repeat(30), date_confidence: 'inferred' };
  const updated = await call('memory_update', fieldsToSave);
  assert.equal(updated.output.version, 2);
  assert.deepEqual(f.calls[1], { cap: 'memory.update', payload: fieldsToSave });
  assert.deepEqual(f.db.prepare('SELECT catalog_json FROM window_toolsets WHERE window_id=?').get('w1'), snapshot);
});

test('catalog does not expose schemas and invoke cannot inject reserved args',async t=>{
 const f=fixture(t);freezeWindowTools(f.db,'w1',fullToolCatalog(),'deferred');
 const result=await f.executor.execute('tool_catalog',{},f.ctx);
 assert.ok(Array.isArray(result.output.tools));assert.ok(!JSON.stringify(result.output).includes('parameters'));
 assert.equal(effectiveToolName('tool_invoke','{"name":"context_review_complete"}'),'context_review_complete');
});

test('deferred lifecycle names the real tool and persists a useful argument rejection',async t=>{
 const f=fixture(t);const catalog=fullToolCatalog();const wire=freezeWindowTools(f.db,'w1',catalog,'deferred');
 const defined=await f.executor.execute('tool_define',{name:'memory_hold'},{...f.ctx,toolCallId:'define-visible'});
 assert.equal(defined.ok,true);
 const history=[{role:'assistant',tool_calls:[{id:'define-visible',function:{name:'tool_define',arguments:JSON.stringify({name:'memory_hold'})}}]}, {role:'tool',tool_call_id:'define-visible',content:JSON.stringify(defined.output)}];
 f.persist(wire,history);
 const failed=await f.executor.execute('tool_invoke',{name:'memory_hold',definition_id:defined.output.definition_id,arguments:'synthetic invalid argument'},{...f.ctx,toolCallId:'invoke-visible'});
 assert.equal(failed.ok,false);assert.equal(failed.output.error_code,'TOOL_ARG_TYPE');assert.match(String(failed.output.detail),/参数对象/);
 assert.equal(f.calls.length,0,'bad input never reaches the memory service');
 const projected=readToolActivity(f.db,f.executor.getCapabilityRegistry(),f.ctx.turnId,null);
 assert.equal(projected.length,2,'start/result are one activity per actual call');
 assert.equal(projected[0].effective_tool,'memory_hold');assert.match(projected[0].label,/读取工具定义/);
 assert.equal(projected[1].effective_tool,'memory_hold');assert.equal(projected[1].error_code,'TOOL_ARG_TYPE');

 // Persisted pre-upgrade events had the wrapper only; recover the target from
 // their existing protocol request, without invoking any historical operation.
 const events=new EventService(f.db);
 for(const phase of ['start','result'])events.publish('turn.tool',{conversationId:'c1',turnId:f.ctx.turnId,payload:{tool:'tool_invoke',label:'tool_invoke',tool_call_id:'legacy-call',attempt_id:null,request_id:'req1',phase,...(phase==='result'?{ok:false,error_code:'TOOL_ARG_TYPE'}:{})}});
 f.persist(wire,[...history,{role:'assistant',tool_calls:[{id:'legacy-call',function:{name:'tool_invoke',arguments:JSON.stringify({name:'memory_recall',arguments:'SYNTHETIC_PRIVATE_INPUT'})}}]}]);
 const restored=readToolActivity(f.db,f.executor.getCapabilityRegistry(),f.ctx.turnId,null);
 assert.equal(restored.length,3);assert.equal(restored[2].effective_tool,'memory_recall');assert.equal(restored[2].label,'查记忆');
 assert.ok(!JSON.stringify(restored).includes('SYNTHETIC_PRIVATE_INPUT'));assert.equal(f.calls.length,0);
});

test('new-window default is direct; explicit legacy remains a compatibility option',()=>{assert.equal(buildConfig().runtime.tool_schema_mode,'direct');assert.equal(buildConfig({runtime:{tool_schema_mode:'legacy'}}).runtime.tool_schema_mode,'legacy');assert.throws(()=>buildConfig({runtime:{tool_schema_mode:'unknown'}}));});
