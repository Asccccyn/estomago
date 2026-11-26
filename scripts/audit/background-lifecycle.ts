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
  const initial=content(p).match(new RegExp(`- ${name}（definition_id: (td_[a-f0-9]+)）`));
  if(initial)return initial[1];
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
    if(c.name==='autonomy-loop'&&isKeepalive)text='1';
    else if(c.name==='autonomy-loop'){
      const round=isWake?c.wakeRound++:c.chatRound++;
      if(isWake){
        assert.equal((p.messages.filter((m:J)=>m.role==='system').map((m:J)=>m.content).join('\n').match(/definition_id: td_/g)??[]).length,40);
        assert.ok(definition(p,'background_complete'),'T definition supplied by the trusted host task');
        if(round===0)calls=c.noop?[invoke(p,'background_complete',{outcome:'noop'})]:[
          invoke(p,'memory_recall',{query:'合成事件',lexical_terms:['合成事件']}),
          invoke(p,'memory_hold',{original_title:'合成醒来记录',text:'合成自主回合的经历与感受。',categories:['daily','sweet'],creation_mode:'contemporaneous'}),
          invoke(p,'wishstar_write_star',{content:'SYNTHETIC_MY_STAR AbC  原生空格。',visibility:'hidden',idempotency_key:'loop-star'}),
          invoke(p,'chat_send_text',{text:'合成自醒正式消息：autonomy-loop',idempotency_key:'loop-message'}),
          invoke(p,'call_control',{action:'invite'}),
          invoke(p,'wake_manage',{operation:'schedule',operation_id:'loop-next',note:'合成下一次预约',delay_seconds:3600}),
          invoke(p,'background_complete',{outcome:'done'}),
        ];
      }else if(round===0)calls=[invoke(p,'wake_manage',{operation:'schedule',operation_id:'loop-first',note:'合成首次预约',delay_seconds:2})];
      text='合成内部结束';
    }else if(isWake){
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
      if(c.keepwarmMode==='complete' && round===0)calls=[invoke(p,'background_complete',{outcome:'noop'})];
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
  if(context?.name==='autonomy-loop'&&parsed.origin==='http://127.0.0.1:19876'){
    assert.equal(parsed.pathname,'/api/stars');assert.equal(init?.method,'POST');
    const fixture=JSON.parse(fs.readFileSync('tests/fixtures/wishstar-domain-responses.json','utf8')).responses.wishstar_write_star;
    assert.equal(JSON.parse(String(init.body)).content,fixture.content);
    context.starWrites++;return Response.json(fixture);
  }
  if(context?.name==='autonomy-loop'&&parsed.origin==='http://127.0.0.1:19877'){
    assert.equal(parsed.pathname,'/v1/invites');assert.equal(init?.method,'POST');
    assert.equal(JSON.parse(String(init.body)).conversation_id,'primary');context.invites++;
    return Response.json({invite_id:'synthetic-invite',expires_at:Date.now()+45000});
  }
  const response=await originalFetch(input,init);
  if(context?.name==='autonomy-loop'&&parsed.origin===process.env.CROSS_MARIPOSA_URL)context.mariposa.push({path:parsed.pathname,status:response.status,body:await response.clone().json()});
  return response;
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
  const config=buildConfig({...patch,runtime:{...patch.runtime as object,provider:'deepseek',tool_schema_mode:'deferred'},deepseek:{model:'deepseek-flash',api_key_env:'AUDIT_SYNTHETIC_DS_TOKEN',max_output_tokens:2048,retry_max_attempts_after_initial:0},openrouter:{model:null},deployment:{port:0},background:{autonomous:{max_model_requests_per_run:c.name==='autonomy-loop'?4:5,max_tool_calls_per_run:c.name==='autonomy-loop'?8:12,daily_cost_cap_usd:10,max_run_ms:120000},keepwarm:{sleep_window:{enabled:false}}},
    ...(c.name==='autonomy-loop'?{integrations:{mariposa:{base_url:process.env.CROSS_MARIPOSA_URL,credential_ref:'ESTOMAGO_TEST_MARIPOSA_TOKEN'},siren:{base_url:'http://127.0.0.1:19877',credential_ref:'AUDIT_SYNTHETIC_DS_TOKEN'}},wishstar:{enabled:true,base_url:'http://127.0.0.1:19876',jiaming_token_env:'AUDIT_SYNTHETIC_DS_TOKEN'}}:{})});
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
  if(c.name==='autonomy-loop')host.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES ('background_tool_prices',?,'now') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(Object.fromEntries(['memory_recall','memory_hold','wishstar_write_star','call_control'].map(name=>[name,{max_cost_micro_usd:1}]))));
  const request=async(url:string,method='GET',body?:unknown,key='fixture',revision=0)=>{const response=await originalFetch(base+'/api/v1'+url,{method,headers:{Authorization:`Bearer ${token}`,Origin:base,'Content-Type':'application/json','Idempotency-Key':key,'If-Match':`"${revision}"`},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json() as J;if(!response.ok)throw Error(JSON.stringify({url,status:response.status,data}));return data;};
  const makeClient=()=>{const client=new EstomagoClient({fetch:(input,init)=>originalFetch(base+String(input),{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),Authorization:`Bearer ${token}`,Origin:base}}),eventSource:sourceFactory(base,token,c),redirect:()=>{throw Error('unexpected auth redirect')}});clients.push(client);client.subscribe(()=>{if(client.snapshot.messages.some(m=>m.text===`合成自醒正式消息：${c.name}`))c.frontend_consumed_at??=new Date().toISOString();});return client;};
  return {base,token,request,makeClient};
}

// Audit clock boundary: no task/run/activity rows are hand-edited.
const RealDate=Date;let auditNow=RealDate.now();
globalThis.Date=class extends RealDate {constructor(...args:any[]){if(args.length===0)super(auditNow);else super(...args as [any]);}static now(){return auditNow;}} as DateConstructor;
const lifecycle:J[]=[];
async function probe(mode:string){
  const c:J={name:'lifecycle-'+mode,managementDone:true,sse_events:[],sse_errors:[],keepwarmMode:mode,keepRound:0};context=c;
  stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'lifecycle-background-'));process.env.ESTOMAGO_HOME=stateRoot;writeApprovedIdentity(stateRoot);
  const env=await startHost(stateRoot,c);
  const settings=await env.request('/background/settings');
  await env.request('/background/settings','PUT',{keepwarm:{enabled:true,daily_cost_cap_usd:10},autonomous:{enabled:true,daily_cost_cap_usd:10}},'enable-'+mode,settings.revision);
  await env.request('/conversations/primary/messages','POST',{content:'合成首次正式聊天',client_message_id:'seed-'+mode},'seed-'+mode);await host!.supervisor.waitIdle();
  const before=host!.db.prepare("SELECT * FROM conversation_activity WHERE conversation_id='primary'").get() as J;
  assert.ok(before.last_real_activity_at,'real HTTP message establishes L');
  if(mode==='wake'||mode==='wake-late'){
    const scheduled=await env.request('/background/tasks','POST',{note:'合成：半小时后问候',delay_seconds:1800},'wake-first');
    const original=host!.db.prepare('SELECT * FROM background_tasks WHERE id=?').get(scheduled.task_id) as J;
    const countBefore=bodies.length;auditNow+=1800001+(mode==='wake-late'?120000:0);
    const replay=await env.request('/background/tasks','POST',{note:'合成：半小时后问候',delay_seconds:1800},'wake-first');
    assert.equal(replay.task_id,scheduled.task_id);assert.equal(replay.scheduled_at,scheduled.scheduled_at);
    await host!.scheduler!.tick();await host!.supervisor.waitIdle();
    const requests=bodies.slice(countBefore);assert.ok(requests.some(r=>r.kind==='wake'));
    const first=requests.find(r=>r.kind==='wake')!;
    const tail=[...first.payload.messages].reverse().find((m:J)=>m.role==='user');
    const task=host!.db.prepare('SELECT * FROM background_tasks WHERE id=?').get(scheduled.task_id) as J;
    const run=host!.db.prepare('SELECT * FROM background_runs WHERE task_id=?').get(scheduled.task_id) as J;
    assert.equal(task.scheduled_at,original.scheduled_at);assert.equal(run.scheduled_for,original.scheduled_at);
    lifecycle.push({mode,actual_delivery:new Date(auditNow).toISOString(),run_due:run.scheduled_for,original_due:original.scheduled_at,scheduled_call_returned_before_due:Date.parse(original.scheduled_at)>Date.parse(original.created_at),stable_relative_replay:replay.scheduled_at===scheduled.scheduled_at,tail:tail.content,task_status:task.control_reason,run_state:run.state,wake_requests:requests.length,model_requests:requests});
  }else if(mode==='reminder'){
    const due=new Date(auditNow+1000).toISOString();
    const created=await env.request('/background/tasks','POST',{kind:'reminder',scheduled_at:due,text:'合成一次提醒'},'reminder-once');
    auditNow+=1001;await host!.scheduler!.tick();await host!.supervisor.waitIdle();
    const task=host!.db.prepare('SELECT * FROM background_tasks WHERE id=?').get(created.task_id) as J;
    const run=host!.db.prepare('SELECT * FROM background_runs WHERE task_id=?').get(created.task_id) as J;
    const detail=await env.request('/background/tasks/'+created.task_id);
    const dispatched=host!.db.prepare('SELECT COUNT(*) n FROM background_dispatches WHERE run_id=?').get(run.id) as J;
    lifecycle.push({mode,task_enabled:task.enabled,task_next_due_at:task.next_due_at,task_control_reason:task.control_reason,task_view_status:detail.task.status,run_state:run.state,dispatches:dispatched.n});
    assert.equal(run.state,'completed','reminder actually delivered');
  }else{
    auditNow+=3000001;const requestBefore=bodies.length;
    await host!.scheduler!.tick();await host!.supervisor.waitIdle();
    const after=host!.db.prepare("SELECT * FROM conversation_activity WHERE conversation_id='primary'").get() as J;
    const run=host!.db.prepare("SELECT * FROM background_runs WHERE kind='keepwarm' ORDER BY created_at DESC LIMIT 1").get() as J;
    assert.equal(run.state,mode==='complete'?'noop':'completed','real scheduler reached its declared terminal outcome');
    const sent=bodies.slice(requestBefore);assert.ok(sent.length>0,'model transport entered');
    const countRun=(host!.db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind='keepwarm'").get() as J).n;
    const countModel=bodies.length;auditNow+=3000001;
    await host!.scheduler!.tick();await host!.supervisor.waitIdle();
    const nextCount=(host!.db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind='keepwarm'").get() as J).n;
    const rec:J={mode,run,real_revision_before:before.activity_revision,real_revision_after:after.activity_revision,maintenance_after:after.maintenance_request_id,first_requests:sent.length,next_run_delta:nextCount-countRun,next_model_delta:bodies.length-countModel,model_requests:sent};
    if(mode==='pure_ack'){
      const prev=bodies.at(-1)!.payload;
      const requestIndex=bodies.length;
      await env.request('/conversations/primary/messages','POST',{content:'合成维护后新聊天',client_message_id:'post-ack'},'post-ack');await host!.supervisor.waitIdle();
      const next=bodies[requestIndex]?.payload;
      rec.next_chat_dispatched=Boolean(next);
      if(next){
        rec.first_message_difference=prev.messages.findIndex((v:J,i:number)=>JSON.stringify(v)!==JSON.stringify(next.messages[i]));
        rec.previous_message_count=prev.messages.length;
        rec.previous_at_difference=prev.messages[rec.first_message_difference];
        rec.next_at_difference=next.messages[rec.first_message_difference];
        rec.tools_equal=JSON.stringify(prev.tools)===JSON.stringify(next.tools);
        rec.next_chat_payload=next;
      }
    }
    lifecycle.push(rec);
  }
  await host!.stop();host=null;fs.rmSync(stateRoot,{recursive:true,force:true});stateRoot='';auditNow+=1000;
}
try {for(const mode of (process.argv.includes('--late-only')?['wake-late']:['pure_ack','catalog_define','complete','wake','reminder'])) await probe(mode);}
catch(error){lifecycle.push({error:String(error),stack:(error as Error).stack});process.exitCode=1;console.error(error);}
finally {
  for(const client of clients)client.stop();if(host)await host.stop();if(stateRoot)fs.rmSync(stateRoot,{recursive:true,force:true});
  globalThis.fetch=originalFetch;globalThis.Date=RealDate;delete process.env.AUDIT_SYNTHETIC_DS_TOKEN;
  fs.writeFileSync(path.join(out,'lifecycle-background.json'),JSON.stringify({evidence:'actual Host/HTTP/Scheduler/tools/DS serializer; synthetic transport and clock only; no external requests',maximum_model_concurrency:maximumModelActive,cases:lifecycle},null,2));
  console.log(JSON.stringify(lifecycle.map(({model_requests,next_chat_payload,...r})=>r)));
}
