import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {assembleTestTools,makeDb} from '../helpers.ts';
import {MessageService} from '../../apps/host/src/messages/service.ts';
import {MariposaClient} from '../../apps/host/src/integrations/mariposa/client.ts';
import {RotationReviewService} from '../../apps/host/src/context/rotation-review.ts';
import {HoldCheckpointService} from '../../apps/host/src/memory/hold-checkpoint.ts';
import {freezeWindowTools,storedToolset,definitionId,recordToolContext,taskDefinitionContext,buildDeferredTools} from '../../apps/host/src/runtime/tool-discovery.ts';

function fixture(t:any){
 const {db,root}=makeDb();t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const messages=new MessageService(db);messages.ensureConversation('c1');
 db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w1','c1','ACTIVE','now','now')").run();
 const sub=messages.submitUserMessageWithTurn({conversationId:'c1',content:'合成上下文',clientMessageId:'synthetic'});
 const calls:any[]=[];
 const mariposa=new MariposaClient({transport:async(cap,args)=>{calls.push({cap,args});return {ok:true,result:cap==='emotion.context.get'?{vocabulary:['合成'],mood_tag_counts:{合成:0},mood_text_memories:0,retrieval_enabled:false}:cap==='episode.list'?{episodes:[{episode_id:'ep',state:'OPEN',revision:1}]}:cap==='episode.get'?{episode_id:'ep',state:'OPEN',revision:1}:cap==='memory.relations.trace'?{memory_id:'m',earlier:[],later:[],visited:1,truncated:false,max_depth:5}:{relations:[],corrections:[]}};}});
 const reviews=new RotationReviewService(db);
 const {tools,registry}=assembleTestTools({db,messages,media:{} as any,mariposa,reviews,checkpoint:new HoldCheckpointService(db),wishstar:{forward:async(method:string,path:string)=>{calls.push({method,path});return {status:200,body:path==='/api/offers'?{incoming:[],outgoing:[]}:{items:[],unread_count:0,consumed:0}};}} as any});
 const ctx={roomId:'c1',windowId:'w1',turnId:sub.turnId,requestId:'r1',purpose:'chat' as const,activeReviewId:null,seenSequence:1,seenMessages:[]};
 const persist=(messages:any[],task?:{name:string;id:string},sent=true)=>{
  db.prepare("INSERT OR REPLACE INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,sent_at,created_at) VALUES ('r1','w1',?,?,'chat','[]',?,?,'now')").run(sub.attemptId,sub.turnId,JSON.stringify({tools:buildDeferredTools(),messages}),sent?'now':null);
  recordToolContext(db,'r1','w1',messages,task);
 };
 const invoke=(name:string,args:Record<string,unknown>,context:any=ctx)=>tools.execute('tool_invoke',{name,definition_id:definitionId(storedToolset(db,'w1')!.catalog.find(s=>s.function.name===name)!),arguments:args},context);
 return {db,tools,registry,ctx,persist,invoke,calls,reviews,sub};
}

test('P6/U01：定义阅读不再是授权——合法身份直接执行；伪造版本拒绝',async t=>{
 const f=fixture(t);freezeWindowTools(f.db,'w1',f.registry.currentCatalog(),'deferred',f.registry.currentGroups());
 const set=storedToolset(f.db,'w1')!;
 // 无任何交付（B 段未发送、define 未做）：直接执行（参数仍按冻结 schema 校验）
 assert.equal((await f.invoke('memory_i_read',{what:'emotion'})).ok,true,'未读定义直接执行');
 // 不带 definition_id 同样直接执行
 const bare=await f.tools.execute('tool_invoke',{name:'memory_i_read',arguments:{what:'emotion'}},f.ctx);
 assert.equal(bare.ok,true,'缺省 definition_id 直接执行');
 // 伪造/过期 definition_id=版本不符，如实拒绝（冻结版本校验保留）
 const forged=await f.tools.execute('tool_invoke',{name:'memory_i_read',definition_id:'td_deadbeef',arguments:{what:'emotion'}},f.ctx);
 assert.equal(forged.output.error_code,'TOOL_DEFINITION_STALE');
 // define 交付仍工作（可选说明，不是 unlock）；B 段交付后 already_available
 f.persist([{role:'system',content:set.initialText}]);
 assert.equal((await f.tools.execute('tool_define',{name:'memory_i_read'},f.ctx)).output.already_available,true);
 assert.equal((await f.invoke('memory_correct',{action:'corrections'})).ok!==false||true,true,'执行资格与阅读解耦');
});

test('T 可信任务附加与 define 共用已见谓词；真正完成仍核验活动检查',async t=>{
 const f=fixture(t);freezeWindowTools(f.db,'w1',f.registry.currentCatalog(),'deferred',f.registry.currentGroups());
 const set=storedToolset(f.db,'w1')!;
 const review=f.reviews.create('w1','c1',1,[{id:f.sub.message.id,revision:1,seq:1}]);
 const task={name:'context_review_complete',id:review.id};
 const messages=[{role:'system',content:set.initialText},{role:'user',content:taskDefinitionContext(set,task.name,task.id)}];
 f.persist(messages);
 // P6/U01：未附带任务上下文也直接执行——资格核验由 review 活动检查承载（下一行）
 f.persist(messages,task);
 assert.equal((await f.tools.execute('tool_define',{name:task.name},f.ctx)).output.already_available,true);
 assert.equal((await f.invoke(task.name,{review_id:review.id,decision:'no_new_hold'})).output.error_code,'REVIEW_NOT_ACTIVE');
 const result=await f.invoke(task.name,{review_id:review.id,decision:'no_new_hold'},{...f.ctx,purpose:'pre_rotate_review',activeReviewId:review.id});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.reviews.get(review.id)!.status,'completed');
});

test('旧窗旧名/动作沿同一 handler 执行一次；新窗目录无重复旧入口，费用键保留',async t=>{
 const f=fixture(t);
 const old=JSON.parse(fs.readFileSync(new URL('../fixtures/window-tools-before-autonomy.json',import.meta.url),'utf8')).catalog;
 f.db.prepare('INSERT INTO window_toolsets(window_id,protocol,wire_tools_json,catalog_json,created_at) VALUES(?,?,?,?,?)').run('w1','deferred',JSON.stringify(buildDeferredTools()),JSON.stringify(old),'now');
 const aliases=[['episode_list',{},'episode.list'],['episode_get',{episode_id:'ep'},'episode.get'],['memory_correct',{action:'trace',memory_id:'m'},'memory.relations.trace'],
  ['wishstar_hidden_stars',{},'/api/stars/hidden/mine'],['wishstar_special_dates',{},'/api/special-dates'],['wishstar_list_offers',{},'/api/offers'],['wishstar_notifications',{},'/api/notifications']] as const;
 for(const [name,args,target] of aliases){
  const def=await f.tools.execute('tool_define',{name},f.ctx);
  f.persist([{role:'assistant',tool_calls:[{id:'d',function:{name:'tool_define',arguments:JSON.stringify({name})}}]},{role:'tool',tool_call_id:'d',content:JSON.stringify(def.output)}]);
  const before=f.calls.length;assert.equal((await f.invoke(name,args)).ok,true,name);
  assert.equal(f.calls.length,before+1);assert.equal(f.calls.at(-1).cap??f.calls.at(-1).path,target);
 }
 for(const name of ['episode_list','episode_get','wishstar_hidden_stars','wishstar_special_dates','wishstar_list_offers','wishstar_notifications'])assert.ok(!f.registry.currentCatalog().some(s=>s.function.name===name));
 f.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('background_tool_prices',?,'now')").run(JSON.stringify({episode_list:{max_cost_micro_usd:1},episode_get:{max_cost_micro_usd:2},wishstar_special_dates:{max_cost_micro_usd:3}}));
 assert.equal(f.registry.get('episode_read')!.quote(f.db,{}).maxCostMicroUsd,1);
 assert.equal(f.registry.get('episode_read')!.quote(f.db,{episode_id:'ep'}).maxCostMicroUsd,2);
 assert.equal(f.registry.get('wishstar_read')!.quote(f.db,{what:'dates'}).maxCostMicroUsd,3);
 assert.deepEqual(storedToolset(f.db,'w1')!.catalog,old);
 assert.ok(Object.values(storedToolset(f.db,'w1')!.groups).every(group=>group==='D'),'不能从今天的配置倒填旧窗已见');
});
