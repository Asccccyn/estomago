import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

test('回忆详情HTTP：鉴权、房间/轮绑定、游标传递；点击不触发生成或检索',async t=>{
 const root=tempRoot('sf-detail-http-');writeApprovedIdentity(root);
 const host=await Host.create({stateRoot:root,logDir:null,bind:'127.0.0.1',port:0,config:buildConfig({...readyRuntimePatch(),deployment:{port:0},runtime:{...readyRuntimePatch().runtime,provider:'mock'}})});
 const enqueued:string[]=[];host.supervisor.enqueue=id=>{enqueued.push(id)};
 await host.start();t.after(async()=>{await host.stop();fs.rmSync(root,{recursive:true,force:true})});
 const a=host.messages.submitUserMessageWithTurn({conversationId:'primary',content:'合成原话',clientMessageId:'detail'});
 const reads:Array<unknown>=[];
 host.surfacing!.visibleMemoriesForTurn=()=>[{memory_ref:'sf_internal',date:'2026-07-09',text:'完整事件正文'}];
 host.surfacing!.readMemoryForTurn=async(room,turn,ref,cursor,section)=>{
  reads.push({room,turn,ref,cursor,section});
  return ref==='sf_internal'?{ok:true as const,data:{sections:{our_words:['完整话语'],relations:[{direction:'in'},{direction:'out'}]},complete:!!cursor,next_cursor:cursor?null:'p1'}}:{ok:false as const,code:'DETAIL_REF_NOT_SEEN',message:'not seen'};
 };
 const base=`http://127.0.0.1:${host.port}/api/v1/conversations/primary/turns/${a.turnId}/memories`;
 const headers={Authorization:'Bearer '+fs.readFileSync(path.join(root,'config/auth.token'),'utf8').trim()};
 assert.equal((await fetch(base)).status,401);
 assert.equal((await fetch(base.replace('/primary/','/other/'),{headers})).status,404);
 const list=await fetch(base,{headers});assert.equal(list.status,200);assert.equal(list.headers.get('cache-control'),'no-store');
 assert.equal(((await list.json()) as any).items[0].text,'完整事件正文');
 const page=await(await fetch(base+'/sf_internal',{headers})).json() as any;
 assert.equal(page.next_cursor,'p1');assert.equal(page.sections.relations.length,2);
 assert.equal((await fetch(base+'/sf_internal?cursor=p1',{headers})).status,200);
 assert.equal((reads[1] as any).cursor,'p1');
 assert.equal((reads[0] as any).section,'memory');
 assert.equal((await fetch(base+'/sf_internal?section=source',{headers})).status,200);
 assert.equal((reads.at(-1) as any).section,'source');
 const count=reads.length;
 assert.equal((await fetch(base+'/sf_internal?section=invalid',{headers})).status,400);
 assert.equal(reads.length,count);
 assert.equal((await fetch(base+'/sf_forged',{headers})).status,404);
 assert.equal(enqueued.length,0);
});
