// Real Host/app-context, loopback HTTP/SSE and production browser client.
// Only DeepSeek's network boundary and deliberately slow model/tool timing are fake.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { writeApprovedIdentity, readyRuntimePatch, pollUntil } from '../../tests/helpers.ts';
import { EstomagoClient } from '../../apps/web/react/src/chat-client.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';

const out=path.resolve(process.env.AUDIT_FRONTEND_OUT??'../evidence/frontend');fs.mkdirSync(out,{recursive:true});
const originalFetch=globalThis.fetch;
const syntheticKey='synthetic-ds-no-network';
process.env.AUDIT_SYNTHETIC_DS_TOKEN=syntheticKey;
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
type J=Record<string,any>;
const results:J[]=[];
let context:J|null=null;
let host:Host|null=null;
let clients:EstomagoClient[]=[];
let stateRoot='';
const bodies:J[]=[];
let serial=0;
let modelActive=0;
let maximumModelActive=0;
function content(p:J):string{return (p.messages??[]).map((m:J)=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');}
function definition(p:J,name:string):string{
  const values=(p.messages??[]).filter((m:J)=>m.role==='tool').map((m:J)=>{try{return JSON.parse(m.content)}catch{return {}}});
  return values.findLast((v:J)=>v.name===name&&v.definition_id)?.definition_id??'';
}
function toolResults(p:J):J[]{return (p.messages??[]).filter((m:J)=>m.role==='tool').map((m:J)=>{try{return JSON.parse(m.content)}catch{return {}}});}
function call(name:string,args:J){return {name,arguments:JSON.stringify(args)};}
function invoke(p:J,name:string,args:J){return call('tool_invoke',{name,definition_id:definition(p,name),arguments:args});}
function redact(p:J):J{return JSON.parse(JSON.stringify(p,(key,value)=>key==='reasoning_content'?{omitted:true,chars:String(value).length}:value));}

globalThis.fetch=async(input:any,init?:RequestInit)=>{
  const url=String(input instanceof Request?input.url:input);
  if(url==='https://api.deepseek.com/chat/completions'){
    assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${syntheticKey}`);
    const p=JSON.parse(String(init?.body));assert.equal(p.model,'deepseek-flash');
    const c=context!;const requestId=`fake-ds-${++serial}`;const started=Date.now();
    const hostTail=[...p.messages].reverse().find((m:J)=>m.role==='user');
    const isWake=String(hostTail?.content).includes('Host self-wake');
    const isKeepalive=String(hostTail?.content).includes('Cache keepalive (host event');
    let calls:J[]=[];let text='合成回复：青禾';let delay=0;
    if(isWake){
      c.first_model_at??=new Date(started).toISOString();
      if(!definition(p,'chat_send_text')||!definition(p,'background_complete'))calls=[call('tool_define',{name:'chat_send_text'}),call('tool_define',{name:'background_complete'})];
      else if(!toolResults(p).some((r:J)=>r.published===true||r.message_id))calls=[invoke(p,'chat_send_text',{text:`合成自醒正式消息：${c.name}`,idempotency_key:`wake-${c.name}`}),invoke(p,'background_complete',{outcome:'done'})];
      else text='内部结束，不重复发言';
    }else if(isKeepalive){
      text='1';
      const round=c.keepRound++;
      if(c.keepwarmMode==='catalog_define'){
        if(round===0)calls=[call('tool_catalog',{})];
        if(round===1)calls=[call('tool_define',{name:'wake_manage'})];
      }
      if(c.keepwarmMode==='published'){
        if(round===0)calls=[call('tool_define',{name:'chat_send_text'}),call('tool_define',{name:'background_complete'})];
        if(round===1)calls=[invoke(p,'chat_send_text',{text:'合成心跳正式消息：青禾',idempotency_key:'heartbeat-publication'}),invoke(p,'background_complete',{outcome:'done'})];
      }
    }
    else if(content(p).includes('AUDIT_TOOL_MANAGEMENT')&&!c.managementDone){
      const step=c.managementRound++;
      const receipt=toolResults(p).filter((r:J)=>r.task_id);
      if(step===0)calls=[call('tool_catalog',{})];
      if(step===1)calls=[call('tool_define',{name:'wake_manage'})];
      if(step===2)calls=[invoke(p,'wake_manage',{operation:'schedule',operation_id:'model-create',note:'合成自醒测试：idle',delay_seconds:2})];
      if(step===3)calls=[invoke(p,'wake_manage',{operation:'list'})];
      if(step===4)calls=[invoke(p,'wake_manage',{operation:'update',operation_id:'model-update',task_id:receipt[0]?.task_id,expected_revision:receipt[0]?.revision,note:'合成自醒测试：idle（修改后原文）',delay_seconds:3})];
      if(step===5)calls=[invoke(p,'wake_manage',{operation:'schedule',operation_id:'model-create-cancel',note:'合成取消预约',delay_seconds:3600})];
      if(step===6)calls=[invoke(p,'wake_manage',{operation:'cancel',operation_id:'model-cancel',task_id:receipt.at(-1)?.task_id,expected_revision:receipt.at(-1)?.revision})];
      if(step>=7){c.managementDone=true;text='预约、改期与取消均已完成';}
    }else if(content(p).includes('AUDIT_SLOW_TOOL')&&!c.slowToolDone){
      c.slowToolDone=true;calls=[call('tool_catalog',{})];
    }else if(String(hostTail?.content).includes('AUDIT_SLOW_REPLY'))delay=1800;
    else if(String(hostTail?.content).includes('AUDIT_CONTINUOUS'))delay=900;
    if(String(hostTail?.content).includes('AUDIT_FOLLOWUP'))text=`青禾；合成自醒正式消息：${c.name}`;
    const record:J={scenario:c.name,request_id:requestId,started_at:new Date(started).toISOString(),kind:isWake?'wake':isKeepalive?'keepalive':'chat',payload:redact(p),first_chunk_at:null,finished_at:null};bodies.push(record);
    modelActive++;maximumModelActive=Math.max(maximumModelActive,modelActive);
    const encoder=new TextEncoder();
    return new Response(new ReadableStream({async start(controller){
      try{
        record.first_chunk_at=new Date().toISOString();if(isWake)c.first_chunk_at??=record.first_chunk_at;
        const delta=calls.length?{tool_calls:calls.map((f,index)=>({index,id:`tool-${serial}-${index}`,type:'function',function:f}))}:{content:text};
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({id:requestId,model:'deepseek-flash',choices:[{delta}]})}\n\n`));
        if(delay)await sleep(delay);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:5000,completion_tokens:32,prompt_cache_hit_tokens:4096,prompt_cache_miss_tokens:904,total_tokens:5032}})}\n\ndata: [DONE]\n\n`));
        controller.close();
      }catch(error){controller.error(error)}finally{record.finished_at=new Date().toISOString();modelActive--;}
    }}),{status:200,headers:{'Content-Type':'text/event-stream'}});
  }
  const parsed=new URL(url);
  if(parsed.hostname!=='127.0.0.1'&&parsed.hostname!=='localhost')throw new Error(`AUDIT_NETWORK_FORBIDDEN:${parsed.hostname}`);
  return originalFetch(input,init);
};

function sourceFactory(base:string,token:string,c:J){return (url:string)=>{
  const controller=new AbortController();
  const source:any={onmessage:null,onopen:null,onerror:null,close:()=>controller.abort()};
  void (async()=>{
    try{
      const response=await originalFetch(base+url,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});assert.equal(response.status,200);source.onopen?.({});
      let pending='';const decoder=new TextDecoder();
      for await(const chunk of response.body! as any){
        pending+=decoder.decode(chunk,{stream:true});let at;
        while((at=pending.indexOf('\n\n'))>=0){const block=pending.slice(0,at);pending=pending.slice(at+2);const data=block.split('\n').filter((line:string)=>line.startsWith('data:')).map((line:string)=>line.slice(5).trim()).join('\n');if(!data)continue;
          const parsed=JSON.parse(data);c.sse_events.push({received_at:new Date().toISOString(),event:parsed});source.onmessage?.({data});}
      }
    }catch(error){if(!controller.signal.aborted){c.sse_errors.push(String(error));source.onerror?.({});}}
  })();return source as EventSource;
};}
async function startHost(root:string,c:J){
  const patch=readyRuntimePatch();
  const config=buildConfig({...patch,runtime:{...patch.runtime as object,provider:'deepseek',tool_schema_mode:'deferred'},deepseek:{model:'deepseek-flash',api_key_env:'AUDIT_SYNTHETIC_DS_TOKEN',max_output_tokens:2048,retry_max_attempts_after_initial:0},openrouter:{model:null},deployment:{port:0},background:{autonomous:{max_model_requests_per_run:5,max_tool_calls_per_run:12,daily_cost_cap_usd:10,max_run_ms:120000},keepwarm:{sleep_window:{enabled:false}}}});
  host=await Host.create({stateRoot:root,config,logDir:null,bind:'127.0.0.1',port:0});
  const enqueue=host.supervisor.enqueueBackground.bind(host.supervisor);
  host.supervisor.enqueueBackground=(conversation,fn)=>{c.enqueued_at??=new Date().toISOString();return enqueue(conversation,()=>{c.execution_slot_at??=new Date().toISOString();return fn();});};
  if(c.name==='tool_running'){
    const tools=(host.supervisor as any).d.tools;const execute=tools.execute.bind(tools);
    tools.execute=async(...args:any[])=>{if(args[0]==='tool_catalog'&&c.slowToolDone&&!c.toolDelayed){c.toolDelayed=true;c.tool_started_at=new Date().toISOString();await sleep(1800);c.tool_finished_at=new Date().toISOString();}return execute(...args);};
  }
  await host.start();c.host_started_at=new Date().toISOString();
  const base=`http://127.0.0.1:${host.port}`;const token=fs.readFileSync(path.join(root,'config/auth.token'),'utf8').trim();
  host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES ('or_model_price',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({input_micro_per_token:1,output_micro_per_token:2,cache_write_micro_per_token:1}),new Date().toISOString());
  const request=async(url:string,method='GET',body?:unknown,key='fixture',revision=0)=>{const response=await originalFetch(base+'/api/v1'+url,{method,headers:{Authorization:`Bearer ${token}`,Origin:base,'Content-Type':'application/json','Idempotency-Key':key,'If-Match':`"${revision}"`},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json() as J;if(!response.ok)throw Error(JSON.stringify({url,status:response.status,data}));return data;};
  const makeClient=()=>{const client=new EstomagoClient({fetch:(input,init)=>originalFetch(base+String(input),{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),Authorization:`Bearer ${token}`,Origin:base}}),eventSource:sourceFactory(base,token,c),redirect:()=>{throw Error('unexpected auth redirect')}});clients.push(client);client.subscribe(()=>{if(client.snapshot.messages.some(m=>m.text===`合成自醒正式消息：${c.name}`))c.frontend_consumed_at??=new Date().toISOString();});return client;};
  return {base,token,request,makeClient};
}
async function run(name:string){
  const c:J={name,kind:'fake-provider-real-product-http-sse',scheduler_poll_ms:15000,managementRound:0,sse_events:[],sse_errors:[],checks:[]};context=c;
  stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'audit-frontend-product-'));process.env.ESTOMAGO_HOME=stateRoot;writeApprovedIdentity(stateRoot);
  let env=await startHost(stateRoot,c);let client=env.makeClient();await client.start();
  const before=await env.request('/background/settings');await env.request('/background/settings','PUT',{autonomous:{enabled:true,daily_cost_cap_usd:10}},'enable',before.revision);
  const submit=async(text:string,id:string)=>{const r=await env.request('/conversations/primary/messages','POST',{content:text,client_message_id:id},id);return r;};
  if(name==='idle')await submit('AUDIT_TOOL_MANAGEMENT：合成测试，请按脚本发现、定义、预约、查询、改期和取消。','management');
  else await submit('合成聊天：请记住口令青禾。','seed');
  await host!.supervisor.waitIdle();
  let task:J;
  if(name==='idle')task=host!.db.prepare("SELECT * FROM background_tasks WHERE origin='self_schedule' AND enabled=1 ORDER BY created_at LIMIT 1").get() as J;
  else{
    const r=await env.request('/background/tasks','POST',{note:`合成自醒测试：${name}`,delay_seconds:1},`schedule-${name}`);
    task=host!.db.prepare('SELECT * FROM background_tasks WHERE id=?').get(r.task_id) as J;
  }
  assert.ok(task);c.task_id=task.id;c.original_due_at=task.scheduled_at;
  if(name==='long_reply'||name==='tool_running'||name==='continuous_input'){
    const nextTick=Date.parse(c.host_started_at)+15000;
    await sleep(Math.max(0,nextTick-Date.now()-300));
    await submit(name==='tool_running'?'AUDIT_SLOW_TOOL':'AUDIT_SLOW_REPLY',`busy-${name}`);
    if(name==='continuous_input'){await sleep(450);for(let i=0;i<3;i++){await submit(`AUDIT_CONTINUOUS ${i}`,`burst-${i}`);await sleep(100);}}
  }
  if(name==='page_closed'){client.stop();c.page_closed_at=new Date().toISOString();}
  if(name==='restart'){
    client.stop();await host!.stop();host=null;c.host_stopped_at=new Date().toISOString();await sleep(1300);
    env=await startHost(stateRoot,c);client=env.makeClient();await client.start();c.restarted_at=new Date().toISOString();
  }
  await pollUntil(()=>!!host!.db.prepare("SELECT 1 FROM background_runs WHERE task_id=? AND state IN ('completed','noop','failed','unknown')").get(task.id),22000,20);
  await host!.supervisor.waitIdle();
  if(name==='page_closed'){await client.start();c.page_reopened_at=new Date().toISOString();}
  c.run_before_frontend_wait=host!.db.prepare('SELECT * FROM background_runs WHERE task_id=?').get(task.id);
  c.messages_before_frontend_wait=host!.db.prepare('SELECT m.*,r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision ORDER BY m.sequence').all();
  await pollUntil(()=>client.snapshot.messages.some(m=>m.text===`合成自醒正式消息：${name}`),4000,10);
  const run=host!.db.prepare('SELECT * FROM background_runs WHERE task_id=?').get(task.id) as J;
  const published=host!.db.prepare("SELECT m.*,r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.turn_id=? AND m.speaker='assistant'").all(run.turn_id) as J[];
  c.run=run;c.published=published;c.frontend_snapshot=client.snapshot.messages;
  c.formal_publication_at=published[0]?.published_at;c.saved_at=published[0]?.created_at;
  assert.equal(run.state,'completed');assert.equal(published.length,1);assert.equal(published[0].content,`合成自醒正式消息：${name}`);
  const requestCount=bodies.length;
  const second=env.makeClient();await second.start();client.stop();await client.start();await sleep(50);
  assert.equal(bodies.length,requestCount,'mount/reconnect/two tabs do not request model');
  assert.equal(client.snapshot.messages.filter(m=>m.text===`合成自醒正式消息：${name}`).length,1);
  assert.equal(second.snapshot.messages.filter(m=>m.text===`合成自醒正式消息：${name}`).length,1);
  await submit('AUDIT_FOLLOWUP：请复述刚才的自醒消息和口令。',`followup-${name}`);await host!.supervisor.waitIdle();
  const followup=bodies.at(-1)!;assert.ok(JSON.stringify(followup.payload).includes(`合成自醒正式消息：${name}`));
  const mutation=await env.request(`/conversations/primary/messages/${host!.db.prepare("SELECT id FROM messages WHERE speaker='owner' ORDER BY sequence LIMIT 1").get()!.id}`);
  c.mutation_status=mutation.message.mutation_status;
  const staticResponse=await originalFetch(env.base+'/chat',{headers:{Authorization:`Bearer ${env.token}`}});
  const html=await staticResponse.text();c.static={status:staticResponse.status,cache_control:staticResponse.headers.get('cache-control'),html_sha256:sha256Hex(html),versioned_js:/chat-app\.js\?v=[a-f0-9]{12}/.test(html)};
  c.latency_ms={scheduler_claim:Date.parse(run.claimed_at)-Date.parse(c.original_due_at),queue:Date.parse(c.execution_slot_at)-Date.parse(c.enqueued_at),model_until_first_chunk:Date.parse(c.first_chunk_at)-Date.parse(c.first_model_at),model_until_publication:Date.parse(c.formal_publication_at)-Date.parse(c.first_model_at),saved_until_frontend_consumed:Date.parse(c.frontend_consumed_at)-Date.parse(c.saved_at),due_until_frontend_consumed:Date.parse(c.frontend_consumed_at)-Date.parse(c.original_due_at)};
  c.db={requests:host!.db.prepare('SELECT id,purpose,generation_id,outcome,dispatch_started_at,background_run_id FROM provider_requests').all(),operations:host!.db.prepare('SELECT * FROM background_operations').all(),dispatches:host!.db.prepare('SELECT * FROM background_dispatches').all(),tool_effects:host!.db.prepare('SELECT * FROM tool_side_effects').all()};
  c.passed=true;results.push(c);fs.writeFileSync(path.join(out,`${name}.json`),JSON.stringify(c,null,2));
  console.log(JSON.stringify({scenario:name,passed:true,latency_ms:c.latency_ms}));
}
async function runHeartbeat(){
  const c:J={name:'heartbeat',kind:'fake-provider-real-product-http-sse',sse_events:[],sse_errors:[],cases:[],virtual_clock:true};context=c;
  stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'audit-heartbeat-product-'));process.env.ESTOMAGO_HOME=stateRoot;writeApprovedIdentity(stateRoot);
  const env=await startHost(stateRoot,c);const client=env.makeClient();await client.start();
  const settings=await env.request('/background/settings');await env.request('/background/settings','PUT',{keepwarm:{enabled:true,daily_cost_cap_usd:10}},'heartbeat-enable',settings.revision);
  let virtualNow=Date.now();(host!.scheduler as any).d.now=()=>virtualNow;(host!.supervisor as any).d.now=()=>virtualNow;
  for(const mode of ['pure_ack','catalog_define','published']){
    c.keepwarmMode=mode;c.keepRound=0;
    await env.request('/conversations/primary/messages','POST',{content:`合成心跳验证 ${mode}，记住青禾。`,client_message_id:`heartbeat-seed-${mode}`},`heartbeat-seed-${mode}`);await host!.supervisor.waitIdle();
    const win=host!.windows.activeWindow('primary')!;
    const trajectoryBefore=(host!.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id=?').get(win.id) as J).messages_json;
    const countBefore=(host!.db.prepare('SELECT COUNT(*) n FROM messages').get() as J).n;
    const activityBefore=host!.db.prepare("SELECT * FROM conversation_activity WHERE conversation_id='primary'").get() as J;
    const latest=host!.db.prepare('SELECT dispatch_started_at FROM provider_requests WHERE outcome=\'completed\' ORDER BY dispatch_started_at DESC LIMIT 1').get() as J;
    virtualNow=Math.max(Date.parse(activityBefore.last_real_activity_at),Date.parse(latest.dispatch_started_at))+3000001;
    const requestBefore=bodies.length;
    await host!.scheduler!.tick();await host!.supervisor.waitIdle();await sleep(30);
    const run=host!.db.prepare("SELECT * FROM background_runs WHERE kind='keepwarm' ORDER BY created_at DESC LIMIT 1").get() as J;
    const trajectoryAfter=(host!.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id=?').get(win.id) as J).messages_json;
    const countAfter=(host!.db.prepare('SELECT COUNT(*) n FROM messages').get() as J).n;
    const activityAfter=host!.db.prepare("SELECT * FROM conversation_activity WHERE conversation_id='primary'").get() as J;
    assert.equal(run.state,'completed');
    if(mode==='pure_ack'){
      assert.equal(run.retention,'ephemeral_ack');assert.equal(run.result_code,'ack_only');assert.equal(bodies.length,requestBefore+1);
      assert.equal(trajectoryAfter,trajectoryBefore);assert.equal(countAfter,countBefore);assert.equal(activityAfter.activity_revision,activityBefore.activity_revision);assert.ok(activityAfter.maintenance_request_id);
    }else if(mode==='catalog_define'){
      assert.equal(run.retention,'retained');assert.equal(run.tool_calls_observed,2);assert.notEqual(trajectoryAfter,trajectoryBefore);assert.equal(countAfter,countBefore);assert.equal(activityAfter.activity_revision,activityBefore.activity_revision);
    }else{
      assert.equal(run.retention,'retained');assert.equal(countAfter,countBefore+1);assert.equal(activityAfter.activity_revision,activityBefore.activity_revision+1);
      await pollUntil(()=>client.snapshot.messages.some(m=>m.text==='合成心跳正式消息：青禾'),2000,10);
    }
    c.cases.push({mode,passed:true,request_count:bodies.length-requestBefore,run,messages_before:countBefore,messages_after:countAfter,activity_before:activityBefore,activity_after:activityAfter,canonical_trajectory_unchanged:trajectoryBefore===trajectoryAfter,model_requests:bodies.slice(requestBefore),frontend_messages:client.snapshot.messages});
  }
  const before=bodies.length;
  await env.request('/conversations/primary/messages','POST',{content:'心跳后继续聊天，请确认青禾。',client_message_id:'heartbeat-followup'},'heartbeat-followup');await host!.supervisor.waitIdle();
  assert.equal(bodies.length,before+1);assert.ok(JSON.stringify(bodies.at(-1)!.payload).includes('合成心跳正式消息：青禾'));
  const requests=bodies.at(-1)!.payload.messages;assert.equal(requests.filter((m:J)=>m.role==='user'&&String(m.content).includes('Cache keepalive (host event')).length,2,'only substantive heartbeat events persist');
  c.passed=true;c.timing='controlled scheduler/supervisor clock +50 minutes; no wall-time or real cache TTL claim';c.next_user_payload=bodies.at(-1)!.payload;
  results.push(c);fs.writeFileSync(path.join(out,'heartbeat.json'),JSON.stringify(c,null,2));console.log(JSON.stringify({scenario:'heartbeat',passed:true,cases:c.cases.map((r:J)=>({mode:r.mode,requests:r.request_count,retention:r.run.retention}))}));
}
try{
  if(process.argv.includes('--heartbeat')){
    await runHeartbeat();
  }else if(process.argv.includes('--serve')){
    context={name:'browser',managementDone:true,sse_events:[],sse_errors:[]};
    stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'audit-frontend-browser-'));process.env.ESTOMAGO_HOME=stateRoot;writeApprovedIdentity(stateRoot);
    fs.writeFileSync(path.join(stateRoot,'config/auth.token'),'frontend-audit-local-fixture-token');
    const env=await startHost(stateRoot,context);
    await env.request('/conversations/primary/messages','POST',{content:'隔离前端测试：这是合成聊天。',client_message_id:'browser-seed'},'browser-seed');await host!.supervisor.waitIdle();
    console.log(JSON.stringify({browser_base:env.base,login:'synthetic fixture token only',pid:process.pid}));
    await new Promise<void>(resolve=>{const timer=setTimeout(resolve,600000);process.once('SIGTERM',()=>{clearTimeout(timer);resolve()});process.once('SIGINT',()=>{clearTimeout(timer);resolve()});process.stdin.once('data',()=>{clearTimeout(timer);resolve()});});
  }else{
  const only=process.argv.find(v=>v.startsWith('--scenario='))?.slice(11);
  for(const name of only?[only]:['idle','long_reply','tool_running','continuous_input','restart','page_closed']){
    try{await run(name);}finally{for(const client of clients)client.stop();clients=[];if(host)await host.stop();host=null;if(stateRoot)fs.rmSync(stateRoot,{recursive:true,force:true});stateRoot='';}
  }
  }
}catch(error){results.push({scenario:context?.name,passed:false,error:String(error),stack:(error as Error).stack,partial:context});console.error(String(error));process.exitCode=1;}
finally{
  for(const client of clients)client.stop();if(host)await host.stop();if(stateRoot)fs.rmSync(stateRoot,{recursive:true,force:true});
  globalThis.fetch=originalFetch;delete process.env.AUDIT_SYNTHETIC_DS_TOKEN;
  fs.writeFileSync(path.join(out,'model-requests.json'),JSON.stringify(bodies,null,2));
  fs.writeFileSync(path.join(out,'product-summary.json'),JSON.stringify({results:results.map(({sse_events,frontend_snapshot,db,...r})=>r),max_concurrent_model_requests:maximumModelActive,provider:'fake DS transport only',real_network:'loopback HTTP and SSE only',frontend:'production EstomagoClient consuming real HTTP/SSE; DOM/device evidence separate',timing:process.argv.includes('--heartbeat')?'controlled scheduler/supervisor clock +50 minutes and manual tick; not wall performance or real provider TTL':'wall clock, actual 15000ms production scheduler polling; model and optional tool delays explicitly synthetic',iphone:'not tested on physical device; client disconnection is a simulation'},null,2));
}
