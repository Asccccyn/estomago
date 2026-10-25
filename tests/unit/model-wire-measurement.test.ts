import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeDb, wireOidoCapabilitiesForTest } from '../helpers.ts';
import {HostToolExecutor} from '../../apps/host/src/runtime/host-tools.ts';
import {MariposaClient} from '../../apps/host/src/integrations/mariposa/client.ts';
import {RotationReviewService} from '../../apps/host/src/context/rotation-review.ts';
import {HoldCheckpointService} from '../../apps/host/src/memory/hold-checkpoint.ts';
const ctx={roomId:'c1',windowId:'w1',turnId:'t1',requestId:'req1',purpose:'chat' as const,activeReviewId:null,seenSequence:1,seenMessages:[]};
const body='合成验收正文，逐字保留。\n！！';
const cases=[
 {name:'episode_get',args:{episode_id:'ep1'},data:{episode_id:'ep1',label:'合成事件',state:'OPEN',revision:3,scope_id:'c1',created_by:'jiaming',created_at:'2026-10-21T00:00:00Z',updated_at:'2026-10-21T00:00:00Z',closed_recorded_at:null,source_selections:[],decision_source_refs:[],terminal_source_ref:null}},
 {name:'plans_read',args:{plan_id:'p1'},data:{plan_id:'p1',version:2,title:'计划',content:body,state:'active',starts_at:null,due_at:'2026-11-01',all_day:false,weight:null,terminal_revision:4,terminal_date:null,forgetting_note:'technical note'}},
 {name:'deletion_review',args:{action:'get',request_id:'d1'},data:{request_id:'d1',memory_id:'m1',human_reason:'重复记录',status:'pending',rejection_reason:null,submitted_by:'qiaosheng',submitted_local_date:'2026-10-21',created_at:'2026-10-21T00:00:00Z',decided_at:null}},
 {name:'memory_correct',args:{action:'relations',memory_id:'m1'},data:{relations:[{relation_id:'r1',from_memory:'m1',to_memory:'m2',relation_type:'contradicts',custom_label:null,reverse_label:null,created_by:'jiaming',created_at:'2026-10-21T00:00:00Z',reversed:false}]}},
 {name:'memory_i_read',args:{what:'current'},data:{doc_id:'i_main',version:2,content:body,items:[{item_id:'i1',revision:2,content:body,updated_at:'2026-10-21T00:00:00Z',authored_by:'jiaming',has_history:true}],item_count:1}},
];
test('capture actual executor output serialized exactly as supervisor tool content',async t=>{
 const {db,root}=makeDb();t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});
 let fixture:any={};
 const executor=new HostToolExecutor({db,mariposa:new MariposaClient({transport:async()=>({ok:true,result:structuredClone(fixture)})}),reviews:new RotationReviewService(db),checkpoint:new HoldCheckpointService(db)})
  wireOidoCapabilitiesForTest(executor, {  });;
 const records=[];
 for(const c of cases){fixture=c.data;const result=await executor.execute(c.name,{...c.args,__tool_call_id:c.name},ctx);assert.equal(result.ok,true);
  const content=JSON.stringify(result.output);records.push({tool:c.name,content,bytes:Buffer.byteLength(content,'utf8')});}
 console.log('MODEL_WIRE='+JSON.stringify(records));
});
