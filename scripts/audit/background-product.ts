// Real Host/app-context, loopback HTTP/SSE and production browser client.
// Only DeepSeek's network boundary and deliberately slow model/tool timing are fake.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { writeApprovedIdentity, readyRuntimePatch, pollUntil } from '../../tests/helpers.ts';
import { installHeartbeatFixtureSources } from '../../tests/helpers/heartbeat-sources.ts';
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
function definition(p:J,name:string):string | undefined{
  return toolResults(p).findLast((v:J)=>v.name===name&&v.definition_id)?.definition_id;
}
function toolResults(p:J):J[]{return (p.messages??[]).filter((m:J)=>m.role==='tool').map((m:J)=>{try{return JSON.parse(m.content)}catch{return {}}});}
function call(name:string,args:J){return {name,arguments:JSON.stringify(args)};}
function invoke(p:J,name:string,args:J){
  const definitionId=definition(p,name);
  return call('tool_invoke',{name,...(definitionId ? {definition_id:definitionId} : {}),arguments:args});
}
function redact(p:J):J{return JSON.parse(JSON.stringify(p,(key,value)=>key==='reasoning_content'?{omitted:true,chars:String(value).length}:value));}

globalThis.fetch=async(input:any,init?:RequestInit)=>{
  const url=String(input instanceof Request?input.url:input);
  if(url==='https://api.deepseek.com/chat/completions'){
    assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${syntheticKey}`);
    const p=JSON.parse(String(init?.body));assert.equal(p.model,'deepseek-flash');
    const c=context!;const requestId=`fake-ds-${++serial}`;const started=Date.now();
    const hostTail=[...p.messages].reverse().find((m:J)=>m.role==='user');
    const isWake=String(hostTail?.content).includes('Host self-wake');
    const hostText=JSON.stringify(hostTail?.content);
    const isKeepalive=hostText.includes('[心跳唤醒]');
    const isExhausted=isKeepalive&&hostText.includes('请回复 1 保温');
    let calls:J[]=[];let text='合成回复：青禾';let delay=0;
    if(c.name==='autonomy-loop'&&isKeepalive){
      if(isExhausted)text='1';else calls=[invoke(p,'background_complete',{outcome:'noop'})];
    }
    else if(c.name==='autonomy-loop'){
      const round=isWake?c.wakeRound++:c.chatRound++;
      if(isWake){
        assert.deepEqual(p.tools.map((t:J)=>t.function.name).sort(),['tool_catalog','tool_define','tool_invoke']);
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
    }else if(isKeepalive&&c.name==='heartbeat'){
      if(c.keepwarmMode==='exhausted'){
        assert.equal(isExhausted,true,'only a genuinely exhausted request can produce the ack');
        text='1';
      }else{
        assert.equal(isExhausted,false);
        if(c.keepwarmMode==='declined')calls=[invoke(p,'background_complete',{outcome:'noop'})];
        else if(c.keepRound++===0)calls=[invoke(p,'heartbeat_draw',{card_number:c.cardNumber})];
        else calls=[
          ...(c.cardNumber===1?[invoke(p,'chat_send_text',{text:'合成心跳正式消息：青禾',idempotency_key:'heartbeat-publication'})]:[]),
          invoke(p,'background_complete',{outcome:'done'}),
        ];
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
    const toolCalls=calls.map((f,index)=>({index,id:`${requestId}-tool-${index}`,type:'function',function:f}));
    const record:J={scenario:c.name,request_id:requestId,started_at:new Date(started).toISOString(),kind:isWake?'wake':isKeepalive?'keepalive':'chat',payload:redact(p),tool_call_ids:toolCalls.map(call=>call.id),first_chunk_at:null,finished_at:null};bodies.push(record);
    modelActive++;maximumModelActive=Math.max(maximumModelActive,modelActive);
    const encoder=new TextEncoder();
    return new Response(new ReadableStream({async start(controller){
      try{
        record.first_chunk_at=new Date().toISOString();if(isWake)c.first_chunk_at??=record.first_chunk_at;
        const delta=toolCalls.length?{tool_calls:toolCalls}:{content:text};
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
  const restoreSources=installHeartbeatFixtureSources();
  try {
    const c:J={name:'heartbeat',kind:'fake-provider-real-product-http-sse',sse_events:[],sse_errors:[],cases:[],virtual_clock:true};context=c;
    stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'audit-heartbeat-product-'));process.env.ESTOMAGO_HOME=stateRoot;writeApprovedIdentity(stateRoot);
    const env=await startHost(stateRoot,c);const client=env.makeClient();await client.start();
    const settings=await env.request('/background/settings');
    await env.request('/background/settings','PUT',{keepwarm:{enabled:true,daily_cost_cap_usd:10}},'heartbeat-enable',settings.revision);
    let virtualNow=Date.now();
    (host!.scheduler as any).d.now=()=>virtualNow;
    (host!.supervisor as any).d.now=()=>virtualNow;
    const rounds=[{mode:'declined',number:0},...Array.from({length:10},(_,index)=>({mode:'drawn',number:index+1})),{mode:'exhausted',number:0}];
    for(const [index,{mode,number}] of rounds.entries()){
      c.keepwarmMode=mode;c.cardNumber=number;c.keepRound=0;
      await env.request('/conversations/primary/messages','POST',{
        content:`合成心跳验证 ${mode}，记住青禾。`,client_message_id:`heartbeat-seed-${index}`,
      },`heartbeat-seed-${index}`);
      await host!.supervisor.waitIdle();
      const countBefore=(host!.db.prepare('SELECT COUNT(*) n FROM messages').get() as J).n;
      const activityBefore=host!.db.prepare("SELECT * FROM conversation_activity WHERE conversation_id='primary'").get() as J;
      const latest=host!.db.prepare("SELECT dispatch_started_at FROM provider_requests WHERE outcome='completed' ORDER BY dispatch_started_at DESC,rowid DESC LIMIT 1").get() as J;
      virtualNow=Math.max(Date.parse(activityBefore.last_real_activity_at),Date.parse(latest.dispatch_started_at))+3000001;
      const requestBefore=bodies.length;
      await host!.scheduler!.tick();
      await host!.supervisor.waitIdle();
      const run=host!.db.prepare("SELECT * FROM background_runs WHERE kind='keepwarm' ORDER BY rowid DESC LIMIT 1").get() as J;
      assert.equal(run.state,mode==='declined'?'noop':'completed',JSON.stringify(run));
      assert.equal(run.retention,'retained');
      const condition=mode==='exhausted'?'ack_only':mode==='declined'?'complete:noop':'complete:done';
      assert.equal(run.result_code,condition);
      assert.equal(bodies.length-requestBefore,mode==='drawn'?2:1);

      const status=await env.request('/background/heartbeat');
      assert.equal(status.delivered_numbers.length,mode==='declined'?0:mode==='exhausted'?10:number);
      if(mode==='drawn')assert.ok(status.delivered_numbers.includes(number));
      const published=host!.db.prepare(`SELECT m.id,m.speaker,r.content FROM messages m
        JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision
        WHERE m.turn_id=? ORDER BY m.sequence`).all(run.turn_id) as J[];
      const formalReply=mode==='drawn'&&number===1?'合成心跳正式消息：青禾':mode==='exhausted'?'1':null;
      assert.deepEqual(published.filter(message=>message.speaker==='assistant').map(message=>message.content),formalReply?[formalReply]:[]);
      assert.equal(published.filter(message=>message.speaker==='system').length,mode==='exhausted'?1:2);
      const activityAfter=host!.db.prepare("SELECT * FROM conversation_activity WHERE conversation_id='primary'").get() as J;
      assert.equal(activityAfter.activity_revision,activityBefore.activity_revision+(mode==='drawn'&&number===1?1:0));
      if(formalReply)await pollUntil(()=>client.snapshot.messages.some(message=>message.text===formalReply),2000,10);
      const countAfter=(host!.db.prepare('SELECT COUNT(*) n FROM messages').get() as J).n;
      c.cases.push({mode,number,passed:true,request_count:bodies.length-requestBefore,run,messages_before:countBefore,messages_after:countAfter,published});
    }
    const before=bodies.length;
    await env.request('/conversations/primary/messages','POST',{content:'心跳后继续聊天，请确认青禾。',client_message_id:'heartbeat-followup'},'heartbeat-followup');
    await host!.supervisor.waitIdle();
    assert.equal(bodies.length,before+1);
    const next=bodies.at(-1)!.payload;
    assert.ok(JSON.stringify(next).includes('合成心跳正式消息：青禾'));
    const warmInput=next.messages.findIndex((message:J)=>message.role==='user'&&JSON.stringify(message.content).includes('请回复 1 保温'));
    assert.ok(warmInput>=0);
    assert.equal(next.messages[warmInput+1]?.role,'assistant');
    assert.equal(next.messages[warmInput+1]?.content,'1');
    assert.equal(next.messages.filter((message:J)=>message.role==='assistant'&&message.content==='1').length,1);
    assert.equal(next.messages.filter((message:J)=>message.role==='user'&&JSON.stringify(message.content).includes('[心跳唤醒]')).length,rounds.length);
    c.passed=true;c.timing='controlled scheduler/supervisor clock +50 minutes; no wall-time or real cache TTL claim';c.next_user_payload=next;
    results.push(c);fs.writeFileSync(path.join(out,'heartbeat.json'),JSON.stringify(c,null,2));
    console.log(JSON.stringify({scenario:'heartbeat',passed:true,cases:c.cases.map((r:J)=>({mode:r.mode,requests:r.request_count,retention:r.run.retention}))}));
  } finally { restoreSources(); }
}
async function runAutonomyLoop(){
  assert.ok(process.env.CROSS_MARIPOSA_URL,'use the isolated cross-project runner');
  const c:J={name:'autonomy-loop',chatRound:0,wakeRound:0,starWrites:0,invites:0,mariposa:[],sse_events:[],sse_errors:[]};context=c;
  stateRoot=process.env.ESTOMAGO_HOME!;writeApprovedIdentity(stateRoot);
  let env=await startHost(stateRoot,c);
  const before=await env.request('/background/settings');
  await env.request('/background/settings','PUT',{autonomous:{enabled:true,daily_cost_cap_usd:'unlimited'},keepwarm:{enabled:true,daily_cost_cap_usd:'unlimited'},free_activity:{enabled:false}},'loop-enable',before.revision);
  c.settings=await env.request('/background/settings');
  assert.deepEqual(c.settings.reminders,before.reminders);
  await env.request('/conversations/primary/messages','POST',{content:'合成普通回合：预约一次未来唤醒。',client_message_id:'loop-seed'},'loop-seed');await host!.supervisor.waitIdle();
  const task=host!.db.prepare("SELECT * FROM background_tasks WHERE origin='self_schedule'").get() as J;
  assert.ok(task,'normal chat scheduled through the frozen C definition');
  const due=(ms:number)=>{(host!.scheduler as any).d.now=()=>ms;(host!.supervisor as any).d.now=()=>ms;};
  due(Date.parse(task.scheduled_at)+1);await host!.scheduler!.tick();await host!.supervisor.waitIdle();
  const run=host!.db.prepare('SELECT * FROM background_runs WHERE task_id=?').get(task.id) as J;
  assert.equal(run?.state,'completed',JSON.stringify(run));
  const wakeRequests=bodies.filter(b=>b.kind==='wake');
  assert.equal(wakeRequests.length,1,'background_complete seals the run without another model request');
  const ids:string[]=wakeRequests[0].tool_call_ids;
  const trajectory=host!.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id=?').get(run.window_id) as J;
  const receipts=JSON.parse(trajectory.messages_json).filter((m:J)=>m.role==='tool' && ids.includes(m.tool_call_id));
  assert.deepEqual(receipts.map((m:J)=>m.tool_call_id),ids);
  const outputs=toolResults({messages:receipts});
  c.first_run=run;c.tool_receipts=outputs;
  assert.equal(outputs.length,7);assert.ok(outputs.every(r=>!r.error_code),JSON.stringify(outputs));
  assert.ok(outputs.some(r=>r.saved===true&&r.memory_id));
  assert.ok(outputs.some(r=>r.candidates?.some((m:J)=>m.memory_ref)));
  assert.equal(c.invites,1);
  assert.equal(c.starWrites,1,'real adapter consumed the domain-generated star DTO once');
  const next=host!.db.prepare("SELECT * FROM background_tasks WHERE origin='self_schedule' AND id<>?").get(task.id) as J;
  assert.ok(next);assert.equal(next.enabled,1,'ending current run does not delete the next task');
  assert.ok(c.mariposa.some((r:J)=>r.path.endsWith('/memory.hold')&&r.status===200));
  assert.ok(c.mariposa.some((r:J)=>r.path.endsWith('/memory.recall.start')&&r.status===200));
  assert.equal((host!.db.prepare("SELECT COUNT(*) n FROM messages WHERE turn_id=? AND speaker='assistant'").get(run.turn_id) as J).n,1);
  const window=host!.windows.activeWindow('primary')!;
  const frozen=host!.db.prepare('SELECT catalog_json,groups_json,initial_text FROM window_toolsets WHERE window_id=?').get(window.id);
  c.sent_proofs=host!.db.prepare('SELECT purpose,tool_context_json FROM provider_requests WHERE background_run_id=? AND sent_at IS NOT NULL').all(run.id);
  assert.ok(c.sent_proofs.some((p:J)=>JSON.parse(p.tool_context_json).some((d:J)=>d.name==='background_complete')));
  await host!.stop();host=null;
  env=await startHost(stateRoot,c);c.noop=true;c.wakeRound=0;
  assert.deepEqual(host!.db.prepare('SELECT catalog_json,groups_json,initial_text FROM window_toolsets WHERE window_id=?').get(window.id),frozen);
  due(Date.parse(next.scheduled_at)+1);await host!.scheduler!.tick();await host!.supervisor.waitIdle();
  const noop=host!.db.prepare('SELECT * FROM background_runs WHERE task_id=?').get(next.id) as J;c.noop_run=noop;
  assert.equal(noop.state,'noop',JSON.stringify(noop));
  assert.equal(bodies.filter(b=>b.kind==='wake').length,2,'Each occurrence uses one model request');
  assert.equal((host!.db.prepare("SELECT COUNT(*) n FROM messages WHERE turn_id=? AND speaker='assistant'").get(noop.turn_id) as J).n,0);
  assert.equal((host!.db.prepare("SELECT COUNT(*) n FROM background_tasks WHERE origin='self_schedule'").get() as J).n,2,'no automatic infinite scheduling');
  c.passed=true;results.push(c);fs.writeFileSync(path.join(out,'autonomy-loop.json'),JSON.stringify(c,null,2));
  console.log(JSON.stringify({scenario:c.name,passed:true,first_run:run.state,next_after_restart:noop.state,star_writes:c.starWrites}));
}
try{
  if(process.argv.includes('--autonomy-loop')){
    await runAutonomyLoop();
  }else if(process.argv.includes('--heartbeat')){
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
