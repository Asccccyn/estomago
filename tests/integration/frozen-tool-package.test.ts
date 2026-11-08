import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { ClaudeSdkRunner } from '../../apps/host/src/runtime/runner-claude-sdk.ts';
import { SubscriptionAccessRunner } from '../../apps/host/src/runtime/subscription-access.ts';
import { RuntimeSettingsService } from '../../apps/host/src/runtime/runtime-settings.ts';
import { storedToolset } from '../../apps/host/src/runtime/tool-discovery.ts';
import { scriptedSdkInput } from '../helpers/sdk-query-input.ts';
import { tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';

const examples: Record<string, Record<string, unknown>> = {
  memory_hold:{original_title:'合成事件',text:'合成经历与感受',categories:['daily','sweet'],creation_mode:'contemporaneous'},
  memory_recall:{query:'合成旧事'}, memory_recall_next:{result_set_id:'synthetic-result'},
  memory_read_full:{memory_ref:'synthetic-unseen'},conversation_read:{around_seq:1,limit:1},memory_i_read:{what:'emotion'},plans_read:{},
  memory_i_write:{action:'create',content:'合成 I'},plans_write:{action:'create',title:'合成计划'},memory_open:{action:'keeps',memory_id:'synthetic'},
  episode_read:{},episode_apply:{action:'start',reason_code:'tracking_requested',label:'合成事件',source_selections:[{}]},
  content_post_create:{body:'合成动态',idempotency_key:'synthetic'},content_comment_create:{post_id:'synthetic',body:'合成评论',idempotency_key:'synthetic'},content_posts_list:{},
  conversation_archive:{kind:'sweet',latest_completed_turn:true},image_generate:{prompt:'合成画',client_operation_id:'synthetic'},
  wake_manage:{operation:'list'},chat_send_text:{text:'合成正式消息',idempotency_key:'synthetic'},media_import:{source_url:'https://127.0.0.1/image.png'},
  chat_send_attachment:{asset_id:'synthetic',presentation:'image'},call_control:{action:'status'},oido_analyze:{audio_ref:'est:synthetic'},
  chat_send_voice:{text:'合成语音'},media_search:{query:'合成图'},oido_get:{analysis_id:'synthetic'},transcript_read:{audio_ref:'est:synthetic'},
  identity_milestone_write:{operation:'read'},wishstar_write_star:{content:'合成星',visibility:'hidden',idempotency_key:'synthetic'},wishstar_read:{what:'dates'},
  wishstar_start_session:{special_date_id:'synthetic'},wishstar_confirm_session:{session_id:'synthetic'},wishstar_take_star:{session_id:'synthetic'},
  wishstar_finish_session:{session_id:'synthetic'},wishstar_request_star:{},wishstar_respond_request:{request_id:'synthetic',decision:'not_now'},
  wishstar_offer_star:{star_id:'synthetic'},wishstar_accept_offer:{offer_id:'synthetic'},
  memory_words_write:{action:'add',memory_id:'synthetic',refs:[{seq:1}]},memory_relations:{action:'list',memory_id:'synthetic'},content_albums_read:{},media_view:{asset_ref:'est:synthetic'},memory_source_bind:{memory_id:'synthetic',start_seq:1,end_seq:1},
};

test('生产装配：M 开窗故障仍发送 40C/7D；直接 invoke、冻结重启与全局配置隔离', async () => {
  const root=tempRoot('frozen-package-'); writeApprovedIdentity(root);
  const config=buildConfig({...readyRuntimePatch(),runtime:{...readyRuntimePatch().runtime,provider:'claude-agent-sdk',model:'claude-sonnet-4-6',tool_schema_mode:'deferred',subscription_proxy_url:'http://127.0.0.1:1'},integrations:{mariposa:{base_url:'http://127.0.0.1:9'}},deployment:{port:0}});
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async (input,init)=>{
    const url=String(input);
    if(url.startsWith('http://127.0.0.1:9')) return new Response(JSON.stringify({ok:false,error:{code:'SYNTHETIC_UNAVAILABLE'}}),{status:503});
    // Media import is an external boundary too; never resolve/download its URL.
    if(!url.startsWith('http://127.0.0.1:')) throw Error('SYNTHETIC_EXTERNAL_UNAVAILABLE');
    return originalFetch(input,init);
  };
  const captures:any[]=[]; const results:Record<string,any>={}; let queryCount=0; let queryError:unknown;
  const query=(input:any)=>{
    const n=++queryCount,session=randomUUID();
    const iterator=(async function*(){
      try {
      if(!(yield* scriptedSdkInput(input,session,(message,history)=>captures.push({options:input.options,message,history}))))return;
      yield {type:'stream_event',session_id:session,event:{type:'message_start',message:{id:`m${n}`,model:input.options.model,usage:{input_tokens:1,output_tokens:0}}}};
      if(n===1){
        const system=Array.isArray(input.options.systemPrompt)?input.options.systemPrompt.join('\n'):input.options.systemPrompt;
        const ids=Object.fromEntries([...system.matchAll(/- ([a-z_]+)（definition_id: (td_[a-f0-9]+)）/g)].map((m:any)=>[m[1],m[2]]));
        // RT01（复审 20261106）：41C 全量 + 7D 完整定义都随窗预送——直接执行需要参数事实，
        // 不再只给 D 组一行摘要（旧 41 断言= D 组无完整定义的旧合同）
        const D7=['memory_correct','deletion_review','creation_save_artifact','oido_capabilities','oido_view','oido_find','oido_compare'];
        assert.equal(Object.keys(ids).length,50,'C 组（含 conversation_archive/image_generate）+ 7D 全部带 definition（完整定义随窗）');
        assert.deepEqual([...Object.keys(examples),...D7].sort(),Object.keys(ids).sort());
        const [a,b]=InMemoryTransport.createLinkedPair(); const client=new Client({name:'fake-sdk',version:'1'});
        await input.options.mcpServers.est.instance.connect(b);await client.connect(a);
        let index=0;
        for(const [name,args] of Object.entries(examples)){
          const toolInput={name,definition_id:ids[name],arguments:args}; const id=`c${++index}`;
          yield {type:'assistant',session_id:session,message:{id:`tool-${id}`,content:[{type:'tool_use',id,name:'mcp__est__tool_invoke',input:toolInput}]}};
          await input.options.hooks.PreToolUse[0].hooks[0]({hook_event_name:'PreToolUse',tool_name:'mcp__est__tool_invoke',tool_input:toolInput,tool_use_id:id});
          const result=await client.callTool({name:'tool_invoke',arguments:toolInput});
          const body=JSON.parse((result.content as any[])[0].text);results[name]=body;
          assert.notEqual(body.error_code,'TOOL_DEFINITION_NOT_SEEN',name);
          assert.ok(!String(body.error_code??'').startsWith('TOOL_ARG_'),`${name}: ${JSON.stringify(body)}`);
        }
        const defineArgs={name:'memory_correct'};
        yield {type:'assistant',session_id:session,message:{id:'define-d',content:[{type:'tool_use',id:'define-d',name:'mcp__est__tool_define',input:defineArgs}]}};
        await input.options.hooks.PreToolUse[0].hooks[0]({hook_event_name:'PreToolUse',tool_name:'mcp__est__tool_define',tool_input:defineArgs,tool_use_id:'define-d'});
        const definition=JSON.parse(((await client.callTool({name:'tool_define',arguments:defineArgs})).content as any[])[0].text);
        const deferredArgs={name:'memory_correct',definition_id:definition.definition_id,arguments:{action:'corrections'}};
        yield {type:'assistant',session_id:session,message:{id:'early-d',content:[{type:'tool_use',id:'early-d',name:'mcp__est__tool_invoke',input:deferredArgs}]}};
        await input.options.hooks.PreToolUse[0].hooks[0]({hook_event_name:'PreToolUse',tool_name:'mcp__est__tool_invoke',tool_input:deferredArgs,tool_use_id:'early-d'});
        // P6/U01（20261106）：定义阅读不再是授权——合法 definition_id 直接执行
        assert.notEqual(JSON.parse(((await client.callTool({name:'tool_invoke',arguments:deferredArgs})).content as any[])[0].text).error_code,'TOOL_DEFINITION_NOT_SEEN');
        yield {type:'stream_event',event:{type:'message_stop'}};
        await input.options.hooks.PostToolBatch[0].hooks[0]({hook_event_name:'PostToolBatch'});
        yield {type:'stream_event',session_id:session,event:{type:'message_start',message:{id:'after-define',model:input.options.model,usage:{input_tokens:1,output_tokens:0}}}};
        yield {type:'assistant',session_id:session,message:{id:'ready-d',content:[{type:'tool_use',id:'ready-d',name:'mcp__est__tool_invoke',input:deferredArgs}]}};
        await input.options.hooks.PreToolUse[0].hooks[0]({hook_event_name:'PreToolUse',tool_name:'mcp__est__tool_invoke',tool_input:deferredArgs,tool_use_id:'ready-d'});
        assert.notEqual(JSON.parse(((await client.callTool({name:'tool_invoke',arguments:deferredArgs})).content as any[])[0].text).error_code,'TOOL_DEFINITION_NOT_SEEN');
        await client.close();
      }
      yield {type:'assistant',session_id:session,message:{id:`done-${n}`,content:[{type:'text',text:'合成完成'}]}};
      yield {type:'stream_event',event:{type:'message_stop'}};
      yield {type:'result',subtype:'success',session_id:session};
      } catch(error) { queryError=error; throw error; }
    })();
    return Object.assign(iterator,{close(){},accountInfo:async()=>({apiProvider:'firstParty'}),usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async()=>({rate_limits_available:true,rate_limits:{extra_usage:{is_enabled:false}}})});
  };
  let host:Host|undefined;
  const start=async()=>{
    host=await Host.create({stateRoot:root,config,logDir:null,bind:'127.0.0.1',port:0});
    if(host.runnerSelection.status==='ok')host.runnerSelection.runner=new SubscriptionAccessRunner(config,new RuntimeSettingsService(host.db),async()=>({status:'ok',runner:new ClaudeSdkRunner(query as any)}));
  };
  const send=async(room='primary')=>{
    host!.messages.ensureConversation(room);
    const submitted=host!.messages.submitUserMessageWithTurn({conversationId:room,content:'合成普通回合',clientMessageId:randomUUID()});
    host!.supervisor.enqueue(submitted.turnId);await host!.supervisor.waitIdle();
    assert.equal(host!.db.prepare('SELECT state FROM turns WHERE id=?').get(submitted.turnId)?.state,'completed',String(queryError instanceof Error ? queryError.stack : queryError) + JSON.stringify(host!.db.prepare('SELECT blocked_reason FROM attempts WHERE turn_id=?').all(submitted.turnId)));
    return host!.windows.activeWindow(room)!.id;
  };
  try{
    await start();const id=await send();
    const frozen=storedToolset(host!.db,id)!;
    assert.equal(frozen.catalog.length,52); // 51C+... 目录 52 项（memory_source_bind 入 C 组；P4 +conversation_archive、P3 +image_generate）
    assert.equal(Object.values(frozen.groups).filter(g=>g==='D').length,7);
    assert.equal(Object.values(frozen.groups).filter(g=>g==='T').length,2);
    assert.ok(frozen.initialText!.includes('content_albums_read'));
    assert.ok(!frozen.initialText!.includes('episode_list'));
    const row=host!.db.prepare('SELECT catalog_json,groups_json,initial_text FROM window_toolsets WHERE window_id=?').get(id);
    host!.db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('tools_initial_visible','[]','now')").run();
    await host!.stop();host=undefined;
    await start();assert.equal(await send(),id);
    assert.deepEqual(host!.db.prepare('SELECT catalog_json,groups_json,initial_text FROM window_toolsets WHERE window_id=?').get(id),row);
    const newId=await send('new-room');
    assert.equal(Object.values(storedToolset(host!.db,newId)!.groups).filter(g=>g==='C').length,0);
    assert.equal(Object.keys(results).length,43); // P4 +conversation_archive、P3 +image_generate
    const proofs=host!.db.prepare('SELECT tool_context_json FROM provider_requests WHERE window_id=? AND sent_at IS NOT NULL').all(id) as any[];
    assert.ok(proofs.some(p=>JSON.parse(p.tool_context_json).length===43));
  } finally {await host?.stop();globalThis.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});}
});
