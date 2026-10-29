import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { SubscriptionAccessRunner } from '../../apps/host/src/runtime/subscription-access.ts';
import { RuntimeSettingsService, setModelMetaForTests, clearModelMetaCache } from '../../apps/host/src/runtime/runtime-settings.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';

// Full Host/HTTP/auth/persistence. Only the SDK query/control boundary is scripted;
// the callback uses the real MCP protocol and existing host business executor.
test('authenticated SDK chat survives host restart, preserves roles/corrections/tool receipt and honors manual selection', async () => {
  const root = tempRoot('sdk-host-continuity-');
  const previousHome = process.env.ESTOMAGO_HOME; process.env.ESTOMAGO_HOME = root;
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider:'claude-agent-sdk', model:'claude-sonnet-4-6', subscription_proxy_url:'http://127.0.0.1:1' }, deployment:{port:0} });
  const captures: any[] = []; let queryCount=0;
  let host: Host | undefined;
  let base='',cookie='';
  const query = (input: any) => {
    const n=++queryCount; const session=input.options.resume ?? randomUUID();
    const iterator=(async function*(){
      for await(const message of input.prompt){captures.push({options:input.options,message});break;}
      if(n===2){
        const args={operation:'schedule',operation_id:'continuity-once',delay_seconds:3600,note:'SYNTHETIC_COMPLETED_TASK'};
        yield {type:'stream_event',session_id:session,event:{type:'message_start',message:{id:'tool-message',model:input.options.model,usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}};
        yield {type:'assistant',session_id:session,message:{id:'tool-message',content:[{type:'tool_use',id:'continuity-tool',name:'mcp__est__wake_manage',input:args}]}};
        yield {type:'stream_event',event:{type:'message_stop'}};
        await input.options.hooks.PreToolUse[0].hooks[0]({hook_event_name:'PreToolUse',tool_name:'mcp__est__wake_manage',tool_input:args,tool_use_id:'continuity-tool'});
        const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'synthetic-sdk',version:'1.0.0'});
        await input.options.mcpServers.est.instance.connect(b);await client.connect(a);
        const result=await client.callTool({name:'wake_manage',arguments:args});await client.close();assert.equal(result.isError,false);
        await input.options.hooks.PostToolBatch[0].hooks[0]({hook_event_name:'PostToolBatch'});
      }
      const text=n===1?'ASSISTANT_ORIGINAL':n===2?'ASSISTANT_ACK_CORRECTION':'ASSISTANT_FOLLOWUP';
      const id=randomUUID();
      yield {type:'stream_event',session_id:session,event:{type:'message_start',message:{id,model:input.options.model,usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:100,cache_creation_input_tokens:0}}}};
      yield {type:'assistant',session_id:session,message:{id,content:[{type:'text',text}]}};
      yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:null},usage:{output_tokens:4}}};
      yield {type:'stream_event',event:{type:'message_stop'}};
      yield {type:'result',subtype:'success',session_id:session};
    })();
    return Object.assign(iterator,{close(){},accountInfo:async()=>({apiProvider:'firstParty'}),usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async()=>({rate_limits_available:true,rate_limits:{extra_usage:{is_enabled:false}}})});
  };
  const start=async()=>{
    host=await Host.create({stateRoot:root,config,logDir:null,bind:'127.0.0.1',port:0});
    assert.equal(host.runnerSelection.status,'ok');
    if(host.runnerSelection.status==='ok'){
      const sdk=new ClaudeSdkRunner(query as any);
      host.runnerSelection.runner=new SubscriptionAccessRunner(config,new RuntimeSettingsService(host.db),async cfg=>{
        assert.equal(cfg.runtime.provider,'claude-agent-sdk');return {status:'ok',runner:sdk};
      });
    }
    await host.start();base=`http://127.0.0.1:${host.port}`;
    assert.equal((await fetch(base+'/api/v1/auth/session')).status,401);
    const token=fs.readFileSync(path.join(root,'config/auth.token'),'utf8').trim();
    const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({token})});
    assert.equal(login.status,200);assert.ok(login.headers.get('set-cookie'));cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  };
  const send=async(content:string)=>{
    const r=await fetch(base+'/api/v1/conversations/primary/messages',{method:'POST',headers:{'content-type':'application/json',origin:base,cookie},body:JSON.stringify({content,client_message_id:randomUUID()})});
    assert.equal(r.status,201);const body:any=await r.json();await host!.supervisor.waitIdle();
    assert.equal(host!.db.prepare('SELECT state FROM turns WHERE id=?').get(body.turn_id)?.state,'completed');return body;
  };
  try{
    await start();
    const bg=new BackgroundSettingsService(host!.db,config);bg.applyUpdate({expectedRevision:bg.revision(),patch:{autonomous_enabled:true,autonomous_daily_cost_cap_usd:1}});
    await send('OWNER_ORIGINAL: meeting at OLD_LOCATION');
    const corrected=await send('OWNER_CORRECTION: meeting now at NEW_LOCATION; supersedes OLD_LOCATION');
    const window=host!.windows.activeWindow('primary')!.id;
    await host!.stop();host=undefined;
    await start();await send('AFTER_COLD_REBUILD');
    assert.equal(host!.windows.activeWindow('primary')!.id,window);assert.equal(captures[2].options.resume,undefined);
    const historyBlock=captures[2].message.message.content.find((b:any)=>b.text.startsWith('<est_history>')).text;
    const history=JSON.parse(historyBlock.slice(historyBlock.indexOf('[{'),historyBlock.lastIndexOf('\n</est_history>')));
    const text=(m:any)=>typeof m.content==='string'?m.content:JSON.stringify(m.content);
    assert.ok(history.some((m:any)=>m.role==='user'&&text(m).includes('OWNER_ORIGINAL')));
    assert.ok(history.some((m:any)=>m.role==='assistant'&&text(m).includes('ASSISTANT_ORIGINAL')));
    assert.ok(history.some((m:any)=>m.role==='user'&&text(m).includes('OWNER_CORRECTION')));
    assert.ok(history.some((m:any)=>m.role==='tool'&&m.tool_call_id==='continuity-tool'&&text(m).includes('task_id')));
    assert.equal(host!.db.prepare("SELECT COUNT(*) n FROM background_tasks WHERE origin='self_schedule'").get()?.n,1);
    new RuntimeSettingsService(host!.db).setMany([['sdk_model', 'claude-opus-5-5'], ['reasoning_effort', 'high']]);
    await host!.supervisor.manualRotate('primary');
    const selection=await host!.supervisor.selectionConfirm({conversationId:'primary',windowId:window,items:[{message_id:corrected.message.id}],explicitEmpty:false,idempotencyKey:'continuity-selection'});
    assert.equal(selection.ok,true,JSON.stringify(selection));
    await send('AFTER_SELECTION');
    assert.equal(captures[3].options.model, 'claude-opus-5-5');
    assert.equal(captures[3].options.effort, 'high');
    const selected=JSON.stringify(captures[3].message);
    assert.equal(captures[3].options.resume,undefined);assert.ok(selected.includes('OWNER_CORRECTION'));
    assert.ok(!selected.includes('OWNER_ORIGINAL'));assert.ok(!selected.includes('ASSISTANT_ORIGINAL'));
    assert.equal(host!.db.prepare("SELECT COUNT(*) n FROM background_tasks WHERE origin='self_schedule'").get()?.n,1);
  } finally { await host?.stop(); if(previousHome===undefined)delete process.env.ESTOMAGO_HOME;else process.env.ESTOMAGO_HOME=previousHome;fs.rmSync(root,{recursive:true,force:true}); }
});

test('owner access page switches SDK and API through authenticated HTTP and preserves the choice after restart without inference', async () => {
  const root = tempRoot('sdk-access-page-');
  const previousHome = process.env.ESTOMAGO_HOME; process.env.ESTOMAGO_HOME = root;
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter', access_policy: 'subscription-first', model: 'claude-sonnet-5' },
    openrouter: { model: 'anthropic/claude-opus-4.6' }, deployment: { port: 0 },
  });
  setModelMetaForTests(config.openrouter.model!, null);
  let host: Host | undefined;
  let base = '', cookie = '';
  const start = async () => {
    host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
    await host.start(); base = `http://127.0.0.1:${host.port}`;
  };
  const get = async () => (await fetch(base + '/api/v1/runtime-settings', { headers: { cookie } })).json();
  const change = async (policy: string) => {
    const response = await fetch(base + '/api/v1/runtime-settings', {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ access_policy: policy }),
    });
    assert.equal(response.status, 200);
  };
  try {
    await start();
    const denied = await fetch(base + '/settings/model-access', { redirect: 'manual' });
    assert.equal(denied.status, 302); assert.equal(denied.headers.get('location'), '/login');
    const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
    const login = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const page = await fetch(base + '/settings/model-access', { headers: { cookie } });
    assert.equal(page.status, 200); assert.match(await page.text(), /chat-app\.js/);
    assert.equal((await get()).access.next_entry, 'claude-agent-sdk');
    const selectSdk = await fetch(base + '/api/v1/runtime-settings', { method: 'PUT', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify({ sdk_model: 'claude-opus-4-6' }) });
    assert.equal(selectSdk.status, 200);
    const rejected = await fetch(base + '/api/v1/runtime-settings', { method: 'PUT', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify({ sdk_model: 'claude-fable-5-1' }) });
    assert.equal(rejected.status, 422);
    assert.equal((await get()).sdk_model, 'claude-opus-4-6');
    await change('configured');
    assert.equal((await get()).access.next_entry, 'openrouter');
    await host!.stop(); host = undefined;
    await start();
    const restored = await get();
    assert.equal(restored.access.policy, 'configured'); assert.equal(restored.driver, 'openrouter');
    await change('subscription-first');
    const sdk = await get();
    assert.equal(sdk.driver, 'claude-agent-sdk'); assert.equal(sdk.sdk_model, 'claude-opus-4-6');
    assert.deepEqual(sdk.sdk_model_options, ['claude-opus-4-6', 'claude-opus-5-5']);
    assert.deepEqual(sdk.effort_options, ['default', 'low', 'medium', 'high', 'max']);
    const effort = await fetch(base + '/api/v1/runtime-settings', {method:'PUT',headers:{'content-type':'application/json',origin:base,cookie},body:JSON.stringify({reasoning_effort:'xhigh'})});
    assert.equal(effort.status,422);
    const combined = await fetch(base + '/api/v1/runtime-settings', {method:'PUT',headers:{'content-type':'application/json',origin:base,cookie},body:JSON.stringify({sdk_model:'claude-opus-5-5',reasoning_effort:'xhigh'})});
    assert.equal(combined.status,200);
    const record = await (await fetch(base + '/api/v1/conversations/primary/context-records', {headers:{cookie}})).json();
    assert.equal(record.exactModel, 'claude-opus-5-5');
    assert.deepEqual((await get()).effort_options,['default','low','medium','high','xhigh','max']);
    assert.equal(host!.db.prepare('SELECT count(*) n FROM provider_requests').get()?.n, 0);
    assert.equal(host!.db.prepare('SELECT count(*) n FROM messages').get()?.n, 0);
  } finally {
    await host?.stop(); clearModelMetaCache();
    if (previousHome === undefined) delete process.env.ESTOMAGO_HOME; else process.env.ESTOMAGO_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
