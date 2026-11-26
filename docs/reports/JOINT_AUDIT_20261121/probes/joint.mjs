import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
const root = process.env.ESTOMAGO_HOME;
assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
assert.ok(root.startsWith(process.env.HOME+'/'));
const mod = rel => import(pathToFileURL(path.resolve(rel)).href);
const {Host} = await mod('apps/host/src/app-context.ts');
const {ContentServer} = await mod('apps/content/src/service.ts');
const {buildConfig} = await mod('apps/host/src/config/schema.ts');
const {readyRuntimePatch, writeApprovedIdentity} = await mod('tests/helpers.ts');
const {OpenRouterRunner} = await mod('apps/host/src/runtime/runner-openrouter.ts');
const {ClaudeSdkRunner} = await mod('apps/host/src/runtime/runner-claude-sdk.ts');
const {SubscriptionAccessRunner} = await mod('apps/host/src/runtime/subscription-access.ts');
const {RuntimeSettingsService} = await mod('apps/host/src/runtime/runtime-settings.ts');
const {BackgroundSettingsService} = await mod('apps/host/src/runtime/background-settings.ts');
const {scriptedSdkInput} = await mod('tests/helpers/sdk-query-input.ts');
const {Client} = await mod('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {InMemoryTransport} = await mod('node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
const {storedToolset} = await mod('apps/host/src/runtime/tool-discovery.ts');

const [lane, protocol, ending] = process.argv.slice(2);
const sdk = lane === 'sdk';
const {mock}=await import('node:test');
if(['clock','midnight','album'].includes(ending))mock.timers.enable({apis:['Date'],now:Date.parse(ending==='album'?'2026-11-21T01:00:00Z':'2026-11-21T15:09:59.000Z')});
const synthetic = '合成 2026 "引号"\n换行\\路径；字面\\n 和 \\u4f60。';
const metrics = {lane,protocol,ending,sourceReads:0,starWrites:[],starReplies:[],starViews:0,memoryWrites:[],sessions:[],results:[],factory:[],requests:[],flags:[],exceptions:[]};
const bytes = o => Buffer.byteLength(JSON.stringify(o));
const hash = s => createHash('sha256').update(s).digest('hex');
const usage = {prompt_tokens:2100,completion_tokens:4,prompt_tokens_details:{cached_tokens:1500,cache_write_tokens:600},cost:0.001};
const sdkUsage = {input_tokens:600,output_tokens:4,cache_read_input_tokens:1500,cache_creation_input_tokens:0};
let phase = 'chat', batch = 0, host, uid = 0;
const shared = Array.from({length:10},(_,i)=>({id:'audit-source-'+i,content:'合成卡面，供本次审计',state:'SHARED',author_name:'合成作者'}));
const responses = new Map();
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const dest = new URL(url);
  if (dest.hostname !== 'stars.invalid') return oldFetch(url,options);
  if (dest.pathname === '/api/stars/shared') {metrics.sourceReads++;return Response.json({items:ending==='short' && !metrics.readyAgain?shared.slice(0,9):ending==='album'?[]:shared});}
  if (dest.pathname.startsWith('/api/stars/shared/')) {metrics.starViews++;throw Error('READ_MUST_NOT_COUNT_VIEW');}
  const responsePath=/^\/api\/stars\/([^/]+)\/responses$/.exec(dest.pathname);
  if(responsePath && options.method==='POST'){
    const starId=decodeURIComponent(responsePath[1]), body=JSON.parse(options.body), key=new Headers(options.headers).get('Idempotency-Key');
    assert.ok(shared.some(s=>s.id===starId));assert.ok(key);
    if(!responses.has(key))responses.set(key,{id:'synthetic-response-'+responses.size,star_id:starId,responder_id:'jiaming',type:'text',text:body.text,created_at:'2026-11-21T00:00:00Z'});
    const receipt=responses.get(key);
    metrics.starReplies.push({match:body.text===synthetic,starId,receiptId:receipt.id,key});
    return Response.json(receipt,{status:201});
  }
  if (dest.pathname === '/api/stars' && options.method === 'POST') {
    const body=JSON.parse(options.body);
    const receipt={...body,id:'synthetic-new-star',state:'SHARED',written_at:'2026-11-21T00:00:00Z',extra_source_field:'source-only'};
    metrics.starWrites.push({match:body.content===synthetic,fullBytes:bytes(receipt)});
    return Response.json(receipt,{status:201});
  }
  return Response.json({items:[]});
};
const call = (name,args,discover=false) => {
  const wrap = protocol==='deferred' && !discover;
  return {id:'audit-'+(++uid), name:wrap?'tool_invoke':name,args:wrap?{name,arguments:args}:args};
};
function observeCard(content) {
  const text=typeof content==='string'?content:content?.find?.(b=>b.type==='text')?.text;
  if(typeof text!=='string')return;
  try {const card=JSON.parse(text).heartbeat_card;if(card?.reply_ref)metrics.replyRef=card.reply_ref;}catch{}
}
function next() {
  if (phase !== 'heart') return {text:'合成正常回复'};
  batch++;
  if(ending==='album' && metrics.removed && !metrics.tried){metrics.tried=true;return {calls:[call('heartbeat_draw',{card_number:1})]};}
  if(ending==='clock'||ending==='album')return {calls:[call('background_complete',{outcome:'noop'})]};
  if(ending==='midnight' && batch===2)mock.timers.setTime(Date.now()+2000);
  if (batch===1) return {calls:[call('tool_catalog',{},true),...['heartbeat_draw','wishstar_reply_star','wishstar_write_star','memory_hold','chat_send_text','background_complete'].map(name=>call('tool_define',{name},true))]};
  if(batch===2 && ending==='no-target')return {calls:[call('wishstar_reply_star',{reply_ref:'never-delivered',text:synthetic,idempotency_key:'bad-target'}),call('background_complete',{outcome:'noop'})]};
  if (batch===2) return {calls:[call('heartbeat_draw',{card_number:1})]};
  if (batch===3 && ending==='text') return {calls:[call('wishstar_write_star',{text:synthetic,visibility:'visible',idempotency_key:'joint-text'})]};
  if (batch===3) return {calls:[
    call('wishstar_reply_star',{reply_ref:metrics.replyRef,text:synthetic,idempotency_key:'joint-reply'}),
    ...(ending==='send'||ending==='silent'?[call('wishstar_reply_star',{reply_ref:metrics.replyRef,text:synthetic,idempotency_key:'joint-reply'})]:[]),
    call('wishstar_write_star',{text:synthetic,visibility:'visible',idempotency_key:'joint-star'}),
    call('memory_hold',{original_title:'合成题目',categories:['daily'],creation_mode:'contemporaneous',text:synthetic})
  ]};
  if (batch===4 && ending==='budget') return {calls:[call('tool_define',{name:'memory_hold'},true)]};
  if (batch===4) return {calls:[
    ...(ending==='send'?[call('chat_send_text',{text:synthetic,idempotency_key:'joint-chat'}),call('chat_send_text',{text:'另一条合成消息',idempotency_key:'joint-chat-2'})]:[]),
    call('background_complete',{outcome:ending==='send'?'done':'noop'}),
    call('chat_send_text',{text:'不应发布的合成文字',idempotency_key:'joint-late'})
  ]};
  throw Error('UNEXPECTED_POST_TERMINAL_MODEL');
}
const apiRunner = new OpenRouterRunner({providerOnly:['anthropic'],allowFallbacks:false,requireParameters:true,retryMax:0},async payload=>{
  metrics.requests.push({phase,tools:payload.tools.length});
  if(ending==='first-body-loss' && phase==='heart' && batch===0){
    batch++;
    return {status:200,headers:new Headers(),body:(async function*(){throw Object.assign(new Error('synthetic body stream lost after confirmation'),{code:'ECONNRESET'});})()};
  }
  if(ending==='unknown' && phase==='heart' && batch===2)throw Object.assign(new Error('synthetic connection lost after request reached transport'),{code:'ECONNRESET'});
  if(phase==='heart')for(const msg of payload.messages??[])if(msg.role==='tool')observeCard(msg.content);
  const r=next();
  const delta=r.calls?{tool_calls:r.calls.map((c,index)=>({index,id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))}:{content:r.text};
  const chunks=[{id:randomUUID(),choices:[{delta}]},{choices:[{delta:{},finish_reason:r.calls?'tool_calls':'stop'}],usage}];
  return {status:200,headers:new Headers(),body:Readable.from([...chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n'),'data: [DONE]\n\n'].map(s=>Buffer.from(s)))};
});
function sdkQuery(input) {
  const session=input.options.resume??randomUUID(); metrics.sessions.push({resume:Boolean(input.options.resume),id:hash(session).slice(0,10)});
  const gen=(async function*(){
    let client;
    try {
      if (!(yield* scriptedSdkInput(input,session,()=>{}))) return;
      while(true) {
        metrics.requests.push({phase});
        const id=randomUUID(),r=next(),calls=(r.calls??[]).map(c=>({type:'tool_use',name:'mcp__est__'+c.name,id:c.id,input:c.args}));
        yield {type:'stream_event',session_id:session,event:{type:'message_start',message:{id,model:input.options.model,usage:sdkUsage}}};
        yield {type:'assistant',session_id:session,message:{id,content:calls.length?calls:[{type:'text',text:r.text}]}};
        yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:null},usage:{output_tokens:4}}};
        yield {type:'stream_event',event:{type:'message_stop'}};
        if(!calls.length)break;
        if(!client){const [a,b]=InMemoryTransport.createLinkedPair();client=new Client({name:'audit-sdk',version:'1'});await input.options.mcpServers.est.instance.connect(b);await client.connect(a);}
        for(const c of calls){
          await input.options.hooks.PreToolUse[0].hooks[0]({hook_event_name:'PreToolUse',tool_name:c.name,tool_input:c.input,tool_use_id:c.id});
          const receipt=await client.callTool({name:c.name.substring(10),arguments:c.input});
          observeCard(receipt.content);
        }
        const outcome=await input.options.hooks.PostToolBatch[0].hooks[0]({hook_event_name:'PostToolBatch',tool_calls:calls.map(c=>({tool_use_id:c.id,tool_name:c.name,tool_input:c.input}))});
        if(outcome.continue===false)break;
      }
      yield {type:'result',subtype:'success',session_id:session};
    }catch(e){metrics.exceptions.push(e.message);throw e;}finally{await client?.close();}
  })();
  return Object.assign(gen,{close(){},applyFlagSettings:async o=>metrics.flags.push(o.env?.CLAUDE_CODE_TERMINAL_MCP_TOOLS),accountInfo:async()=>({apiProvider:'firstParty'}),usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async()=>({rate_limits_available:true,rate_limits:{extra_usage:{is_enabled:false}}})});
}
const content=new ContentServer({stateRoot:path.join(root,'content'),port:0});
try{
  await content.start();writeApprovedIdentity(root);
  process.env.JOINT_FIXTURE_STAR='fixture';
  const ready=readyRuntimePatch(), provider=sdk?'claude-agent-sdk':'openrouter';
  const config=buildConfig({...ready,runtime:{...ready.runtime,provider,access_policy:sdk?'subscription-first':'configured',model:'claude-sonnet-4-6',subscription_proxy_url:'http://127.0.0.1:1',tool_schema_mode:protocol},openrouter:{model:'anthropic/claude-fixture',vision_supported_models:['anthropic/claude-fixture']},content:{enabled:true,port:content.port},wishstar:{enabled:true,base_url:'https://stars.invalid',jiaming_token_env:'JOINT_FIXTURE_STAR'},background:{keepwarm:{sleep_window:{enabled:false}}},windows:{model_context_capacity:150000}});
  host=await Host.create({stateRoot:root,config,logDir:null,bind:'127.0.0.1',port:0});
  const runner=sdk?new ClaudeSdkRunner(sdkQuery):apiRunner;
  host.runnerSelection.runner=new SubscriptionAccessRunner(config,new RuntimeSettingsService(host.db), async c=>{metrics.factory.push(c.runtime.provider);assert.equal(c.runtime.provider,provider);return {status:'ok',runner};});
  await host.start();
  const db=host.db, settings=new BackgroundSettingsService(db,config);
  const remote=host.heartbeat.sources.external.memory;
  remote.transport=async (name,data)=>{
    if(name==='memory.hold'){
      metrics.memoryWrites.push({match:data.text===synthetic});
      if(ending==='partial'||ending==='recover')return {ok:false,code:'TRANSPORT_TIMEOUT'};
      if(ending==='cancel-after-actions'){
        const active=db.prepare("select id from background_runs where kind='keepwarm' and state='running'").get();
        const stop=await fetch(fixtureBase+'/api/v1/background/runs/'+active.id+'/stop',{method:'POST',headers:{...fixtureAuth,'Idempotency-Key':'joint-cancel'}});
        assert.equal(stop.status,200);
        metrics.cancelState=(await stop.json()).state;
      }
      return {ok:true,result:{operation_id:data.operation_id,memory_id:'synthetic-memory',version:1,binding_ids:[],committed_at:new Date().toISOString(),commit_observed_at:new Date().toISOString()}};
    }
    if(name==='memory.hold.status' && ending==='recover'){
      metrics.holdStatusOperation=data.operation_id;
      return {ok:true,result:{completed:true,receipt:{operation_id:data.operation_id,memory_id:'synthetic-memory',version:1,binding_ids:[],committed_at:new Date().toISOString(),commit_observed_at:new Date().toISOString()}}};
    }
    return {ok:true,result:{items:[],next_cursor:null}};
  };
  const rt=new RuntimeSettingsService(db);
  rt.setMany([
    ['or_model_price',JSON.stringify({input_micro_per_token:0.000003,output_micro_per_token:0.000015})],
    ['background_tool_prices',JSON.stringify(Object.fromEntries(['wishstar_reply_star','wishstar_write_star','memory_hold','chat_send_text'].map(n=>[n,{max_cost_micro_usd:1}])))]
  ]);
  if(ending==='unpriced')db.prepare("delete from runtime_settings where key='background_tool_prices'").run();
  async function chat(){
    const msg=host.messages.submitUserMessageWithTurn({conversationId:'primary',content:'合成审计输入',clientMessageId:randomUUID()});
    host.supervisor.enqueue(msg.turnId);await host.supervisor.waitIdle();
    return db.prepare('select state from turns where id=?').get(msg.turnId).state;
  }
  const fixtureBase='http://127.0.0.1:'+host.port;
  const fixtureAuth={Origin:fixtureBase,Authorization:'Bearer '+fs.readFileSync(path.join(root,'config/auth.token'),'utf8').trim()};
  if(ending==='album'){
    host.heartbeat.media.mStore={uploadBytes:async b=>({content_hash:hash(b)})};
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=','base64');
    for(let i=0;i<10;i++){
      const a=await fetch(fixtureBase+'/api/v1/assets?purpose=chat_image',{method:'POST',headers:{...fixtureAuth,'Idempotency-Key':'fixture-image-'+i,'Content-Type':'application/octet-stream'},body:Buffer.concat([png,Buffer.from([i])])});
      const asset=await a.json();assert.equal(a.status,201);
      const r=await fetch(fixtureBase+'/api/v1/content/albums/important_photos/entries',{method:'POST',headers:{...fixtureAuth,'Idempotency-Key':'fixture-entry-'+i,'Content-Type':'application/json'},body:JSON.stringify({asset_id:asset.asset_id})});assert.equal(r.status,201);
    }
  }
  metrics.firstChat=await chat();
  const window=host.windows.activeWindow('primary').id,set=storedToolset(db,window);
  const registry=host.supervisor.d.tools.capabilityRegistry;
  metrics.registry=registry.listByBaselineOrder().map(d=>{let price;try{price=d.quote(db,{}).verifiedFree?'free':'quoted';}catch{price='needs-quote/arguments';}return {name:d.id,owner:d.owner,call:d.memoryOnlyAllowed,legacy:Boolean(d.legacyOnly),replacedBy:d.replacedBy,price};});
  metrics.catalog=set.catalog.map(t=>({name:t.function.name,required:t.function.parameters.required??[],params:Object.keys(t.function.parameters.properties??{}),group:set.groups[t.function.name],wire:set.tools.some(x=>x.function.name===t.function.name)}));
  const L=Date.parse(db.prepare("select last_real_activity_at from conversation_activity where conversation_id='primary'").get().last_real_activity_at);
  let now=L+2999000; host.scheduler.d.now=host.supervisor.d.now=()=>now;
  settings.applyUpdate({expectedRevision:0,patch:{keepwarm_enabled:true,keepwarm_daily_cost_cap_usd:5}});
  host.scheduler.start();phase='heart';
  await host.scheduler.tick();metrics.beforeDue=db.prepare('select count(*) n from background_runs').get().n;
  now=L+3000000;
  if(['clock','midnight','album'].includes(ending))mock.timers.setTime(now);
  if(ending==='clock'){
    settings.applyUpdate({expectedRevision:settings.revision(),patch:{keepwarm_enabled:false}});
    await host.scheduler.tick();
    metrics.off=db.prepare('select count(*) n from background_runs').get().n;
    now+=1000;mock.timers.setTime(now);
    settings.applyUpdate({expectedRevision:settings.revision(),patch:{keepwarm_enabled:true}});
  }
  await host.scheduler.tick();await host.supervisor.waitIdle();
  metrics.run=db.prepare("select state,result_code,model_requests_started,tool_calls_started,turn_id from background_runs where kind='keepwarm' order by rowid desc").get();
  if(ending==='short'){
    metrics.readyAgain=true;
    for(const plus of [60000,240000,3000000]){now=L+3000000+plus;await host.scheduler.tick();}
    metrics.afterSourceRepair=db.prepare("select count(*) n from background_runs where kind='keepwarm'").get().n;
    metrics.maintenance=db.prepare("select maintenance_request_id from conversation_activity where conversation_id='primary'").get();
  }
  if(ending==='album'){
    const source=JSON.parse(db.prepare('select source_ref_json from heartbeat_cards where card_number=1').get().source_ref_json);
    const erased=await fetch(fixtureBase+'/api/v1/content/album-entries/'+source.id,{method:'DELETE',headers:{...fixtureAuth,'Idempotency-Key':'fixture-remove','If-Match':'"1"'}});
    assert.equal(erased.status,200);metrics.removed=true;
    const status=async()=>await (await fetch(fixtureBase+'/api/v1/background/heartbeat',{headers:fixtureAuth})).json();
    metrics.afterRemoval=await status();
    assert.equal(metrics.afterRemoval.available_numbers.includes(1),false);
    assert.equal(metrics.afterRemoval.delivered_numbers.length,0);
    now+=3000000;mock.timers.setTime(now);await host.scheduler.tick();
    metrics.afterChoice=await status();
  }
  if(ending==='clock'){
    const total=()=>db.prepare("select count(*) n from background_runs where kind='keepwarm'").get().n;
    const stamp=Date.parse(db.prepare("select maintenance_dispatch_started_at from conversation_activity where conversation_id='primary'").get().maintenance_dispatch_started_at);
    await host.scheduler.tick();metrics.reopenOnce=total();
    now=stamp+2999000;mock.timers.setTime(now);await host.scheduler.tick();metrics.successorEarly=total();
    now=stamp+3000000;mock.timers.setTime(now);await host.scheduler.tick();metrics.successorDue=total();
    const second=Date.parse(db.prepare("select maintenance_dispatch_started_at from conversation_activity where conversation_id='primary'").get().maintenance_dispatch_started_at);
    now=second+2999000;mock.timers.setTime(now);phase='after';await chat();now+=1000;mock.timers.setTime(now);
    await host.scheduler.tick();metrics.afterInterruption=total();
  }
  if(ending==='midnight'){
    metrics.frozenDay=db.prepare('select distinct business_date from heartbeat_runs').all();
    metrics.actualDay=(await mod('apps/host/src/modules/heartbeat/runtime.ts')).heartbeatBusinessDate();
  }
  metrics.draw=db.prepare("select card_number,state from heartbeat_draw_operations").all();
  if(ending==='unknown'){
    const {HeartbeatCards}=await mod('apps/host/src/modules/heartbeat/service.ts');
    const r=db.prepare('select source_ref_json from heartbeat_cards where card_number=1').get();
    if(r){const source=JSON.parse(r.source_ref_json);metrics.unknownEligible=[0,31].map(days=>new HeartbeatCards(db,()=>Date.now()+days*86400000).isSourceEligible(source));}
  }
  const tr=db.prepare("select messages_json from window_trajectories where window_id=?").get(window);
  const msgs=JSON.parse(tr.messages_json);
  for(const m of msgs.filter(m=>m.role==='tool')){
    const r=JSON.parse(m.content);const item={id:m.tool_call_id,keys:Object.keys(r),bytes:bytes(r)};
    if(r.tools)item.names=r.tools.map(t=>t.name);
    if(r.heartbeat_card)item.cardKeys=Object.keys(r.heartbeat_card);
    if(r.error_code)item.error=r.error_code;
    if(r.memory_id)item.memory_id=true;
    metrics.results.push(item);
  }
  const projections=db.prepare("select payload_ref from outbox where target='content_heartbeat_projection'").all().map(r=>JSON.parse(r.payload_ref));
  metrics.projections=projections.map(p=>({keys:Object.keys(p),state:p.state,messages:p.messages.length,source:p.card?.source?.kind,actions:p.actions?.map(a=>({kind:a.kind,status:a.status})),terminal:p.terminal}));
  metrics.invite=msgs.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:m.content[0].text).find(s=>s?.startsWith('[心跳唤醒]'))?.split('\n').slice(0,2).join(' ');
  await host.heartbeat.recoverProjections(10);
  const token=fs.readFileSync(path.join(root,'config/auth.token'),'utf8').trim();
  const page=await fetch('http://127.0.0.1:'+host.port+'/api/v1/content/posts?include_references=1',{headers:{Authorization:'Bearer '+token}});
  const posts=await page.json();metrics.feed=(posts.items??[]).map(x=>({kind:x.kind,keys:Object.keys(x),blocks:(x.blocks??[]).map(b=>({label:b.source_label,outcome:b.id==='outcome'?b.text:undefined}))}));
  metrics.runRequestStates=db.prepare("select outcome,sent_at is not null as sent from provider_requests where background_run_id is not null order by rowid").all();
  metrics.prefixBytes={wireTools:bytes(set.tools),catalog:bytes(set.catalog)};
  metrics.publishedOrder=db.prepare("select speaker,client_message_id from messages where turn_id=? order by sequence").all(metrics.run?.turn_id??'').map(r=>r.client_message_id?.startsWith('heartbeat:')?r.client_message_id.split(':').at(-1):r.speaker);
  metrics.requestsEvidence=db.prepare("select payload_json,sent_at from provider_requests where background_run_id is not null and sent_at is not null order by rowid").all().map(r=>{const m=JSON.parse(r.payload_json).messages;return {roles:m.slice(-3).map(x=>x.role),card:m.some(x=>x.role==='tool'&&JSON.stringify(x.content).includes('heartbeat_card')),system:hash(JSON.stringify(m.filter(x=>x.role==='system'))).slice(0,12)};});
  if(ending==='send'||ending==='silent'){
    assert.equal(metrics.firstChat,'completed');
    assert.deepEqual(metrics.draw.map(x=>x.state),['delivered']);
    assert.equal(metrics.starWrites[0]?.match,true);
    assert.equal(metrics.replyRef!=null,true);
    assert.equal(metrics.starReplies.length,2);
    assert.equal(responses.size,1);
    assert.ok(metrics.starReplies.every(r=>r.match && r.starId===projections[0]?.card.source.id));
    assert.equal(metrics.starViews,0);
    assert.equal(projections.length,1);
    assert.deepEqual(projections[0].actions.map(a=>[a.kind,a.status]),[['selection','committed'],['star_reply','committed'],['star_write','committed'],['memory_hold','committed']]);
    assert.equal(projections[0].actions[1].source.parentId,projections[0].card.source.id);
    assert.equal(projections[0].actions[1].source.id,metrics.starReplies[0].receiptId);
    assert.equal(projections[0].actions[1].operationId,metrics.starReplies[0].key);
    assert.equal(projections[0].actions[2].source.id,'synthetic-new-star');
    assert.deepEqual(projections[0].actions[3].source,{namespace:'mariposa:memory',id:'synthetic-memory',revision:1});
    assert.ok(!JSON.stringify(projections).includes(synthetic));
    const labels=metrics.feed[0].blocks.map(b=>b.label);
    assert.deepEqual(labels,['心跳状态','选号','心跳状态','1 号 · 许愿星','回应原星','写星','写记忆',...(ending==='send'?['本轮聊天','本轮聊天']:[]),'结束状态']);
    assert.deepEqual(metrics.publishedOrder,ending==='send'?['invite','card','assistant','assistant']:['invite','card']);
    assert.equal(metrics.results.filter(x=>x.keys.includes('star_id')&&x.keys.includes('id')&&x.keys.includes('type')).length,2);
    assert.equal(metrics.memoryWrites[0]?.match,true);
    assert.equal(metrics.requestsEvidence.length,4);
    assert.ok(metrics.requestsEvidence[2].card);
  }
  if(ending==='no-target'){
    assert.equal(metrics.starReplies.length,0);
    assert.equal(projections[0]?.state,'declined');
    assert.equal(projections[0]?.actions[0]?.status,'failed');
  }
  if(ending==='first-body-loss'){
    assert.equal(projections.length,1);
    assert.equal(projections[0].state,'interrupted');
    assert.equal(projections[0].card,null);
    assert.equal(projections[0].terminal.status,'failed');
    assert.deepEqual(metrics.publishedOrder,['invite']);
    assert.deepEqual(metrics.starReplies,[]);
  }
  if(ending==='cancel-after-actions'){
    assert.equal(metrics.cancelState,'cancelling');
    assert.equal(projections.length,1);
    assert.equal(projections[0].terminal.status,'cancelled');
    assert.ok(projections[0].actions.some(a=>a.kind==='memory_hold'&&a.status==='committed'));
    assert.ok(projections[0].actions.some(a=>a.kind==='star_reply'&&a.status==='committed'));
    assert.equal(metrics.run.model_requests_started,3);
    assert.deepEqual(metrics.publishedOrder,['invite','card']);
  }
  if(ending==='unknown'){
    assert.deepEqual(metrics.unknownEligible,[false,false]);
    assert.equal(projections[0]?.terminal?.status,'unknown');
    assert.equal(projections[0]?.card,null);
  }
  if(ending==='budget'){
    assert.equal(projections[0]?.terminal?.reason,'budget');
    assert.ok(projections[0]?.actions?.some(a=>a.kind==='memory_hold'&&a.status==='committed'));
  }
  if(ending==='unpriced'){
    assert.equal(metrics.run.result_code,'BUDGET_ESTIMATE_UNAVAILABLE');
    assert.equal(projections[0]?.terminal?.reason,'quote');
    assert.equal(metrics.starReplies.length,0);
    assert.equal(metrics.starWrites.length,0);
    assert.equal(metrics.memoryWrites.length,0);
  }
  if(ending==='short'){
    assert.equal(metrics.run.result_code,'HEARTBEAT_DECK_UNPREPARED');
    assert.equal(metrics.afterSourceRepair,1);
    assert.equal(projections.length,0);
  }
  if(ending==='midnight'){
    assert.equal(metrics.frozenDay.length,1);
    assert.notEqual(metrics.frozenDay[0].business_date,metrics.actualDay);
    assert.deepEqual(metrics.draw.map(x=>x.state),['delivered']);
  }
  if(ending==='partial'||ending==='recover'){
    assert.ok(projections[0]?.actions?.some(a=>a.kind==='star_reply'&&a.status==='committed'));
    assert.ok(projections[0]?.actions?.some(a=>a.kind==='memory_hold'&&a.status==='unknown'));
  }
  if(ending==='recover'){
    const before=projections[0], postId=posts.items[0].id;
    const recovered=await host.supervisor.d.tools.recoverUnknownEffects('primary',window);
    assert.equal(recovered.resolved,1);
    await host.heartbeat.recoverProjections(10);
    const after=JSON.parse(db.prepare("select payload_ref from outbox where target='content_heartbeat_projection'").get().payload_ref);
    assert.equal(after.version,before.version+1);
    const original=before.actions.find(a=>a.kind==='memory_hold'), settled=after.actions.find(a=>a.kind==='memory_hold');
    assert.equal(settled.operationId,original.operationId);
    assert.equal(metrics.holdStatusOperation,original.operationId);
    assert.equal(settled.status,'committed');
    assert.equal(settled.source.id,'synthetic-memory');
    assert.equal(metrics.memoryWrites.length,1);
    const afterFeed=await (await fetch(fixtureBase+'/api/v1/content/posts?include_references=1',{headers:fixtureAuth})).json();
    assert.equal(afterFeed.items.length,1);assert.equal(afterFeed.items[0].id,postId);
    assert.match(afterFeed.items[0].blocks.find(b=>b.source_label==='写记忆').text,/已完成/);
    metrics.recoveredProjection=true;
  }
  phase='after';metrics.nextChat=await chat();
  const history=JSON.parse(db.prepare('select payload_json from provider_requests where sent_at is not null order by rowid desc limit 1').get().payload_json).messages;
  const calls=history.flatMap(m=>m.tool_calls??[]).map(c=>c.id);
  const resultIds=history.filter(m=>m.role==='tool').map(m=>m.tool_call_id);
  metrics.paired=calls.every(id=>resultIds.filter(x=>x===id).length===1)&&resultIds.every(id=>calls.filter(x=>x===id).length===1);
  metrics.chatTextMatch=db.prepare("select r.content from messages m join message_revisions r on r.message_id=m.id and r.revision=m.current_revision where m.turn_id=? and m.speaker='assistant'").all(metrics.run?.turn_id??'').map(x=>x.content===synthetic);
  metrics.samePrefix=hash(JSON.stringify(history.slice(0,msgs.length)))===hash(JSON.stringify(msgs));
  metrics.terminal=db.prepare("select speaker,count(*) n from messages where turn_id=? and published_at is not null group by speaker").all(metrics.run?.turn_id??'');
  metrics.nextReceiptCount=JSON.parse(db.prepare('select payload_json from provider_requests where sent_at is not null order by rowid desc limit 1').get().payload_json).messages.filter(m=>m.role==='tool'&&m.tool_call_id?.startsWith('audit-')).map(m=>m.tool_call_id);
  if(ending==='send'||ending==='silent'){
    assert.equal(metrics.nextChat,'completed');
    assert.equal(metrics.paired,true);
    assert.equal(metrics.samePrefix,true);
    assert.deepEqual(metrics.chatTextMatch,ending==='send'?[true,false]:[]);
  }
}catch(e){metrics.exceptions.push(String(e.stack));process.exitCode=1;}finally{await host?.stop();await content.stop();console.log(JSON.stringify(metrics));}
