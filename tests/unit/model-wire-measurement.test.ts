import {test} from 'node:test';
import { assembleTestTools, makeDb, validateToolArgs } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {MariposaClient} from '../../apps/host/src/integrations/mariposa/client.ts';
import {RotationReviewService} from '../../apps/host/src/context/rotation-review.ts';
import {HoldCheckpointService} from '../../apps/host/src/memory/hold-checkpoint.ts';
const ctx={roomId:'c1',windowId:'w1',turnId:'t1',requestId:'req1',purpose:'chat' as const,activeReviewId:null,seenSequence:1,seenMessages:[],toolCallId:'mw'};
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
 const { tools: executor } = assembleTestTools({ db: db, mariposa: new MariposaClient({transport:async()=>({ok:true,result:structuredClone(fixture)})}), reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
 const records=[];
 for(const c of cases){
  // S15：校验入口=helpers.validateToolArgs（条目 definition+通用校验，同注册表执行外壳）
  const checked = validateToolArgs(c.name, c.args);
  assert.equal(checked.ok, true, c.name+' 参数须过形状门');
  fixture=c.data;const result=await executor.execute(c.name,checked.value as Record<string,unknown>,ctx);assert.equal(result.ok,true);
  const content=JSON.stringify(result.output);records.push({tool:c.name,content,bytes:Buffer.byteLength(content,'utf8')});}
 console.log('MODEL_WIRE='+JSON.stringify(records));
 // S17b 批次2③：具体输出断言（不再只 ok+打印）——内部字段不泄漏、正文逐字、CAS/游标保真
 const byTool=Object.fromEntries(records.map(r=>[r.tool,JSON.parse(r.content)]));
 assert.deepEqual(byTool['episode_get'],{episode_id:'ep1',label:'合成事件',state:'OPEN',revision:3},'episode 投影保留观测 CAS 修订，剥离 created_by/created_at/updated_at 审计字段与空 source_selections');
 assert.deepEqual(byTool['plans_read'],{plan_id:'p1',version:2,title:'计划',content:body,state:'active',due_at:'2026-11-01',all_day:false},'plans 投影保留正文与版本，剥离 terminal_revision/terminal_date/forgetting_note');
 assert.deepEqual(byTool['deletion_review'],{request_id:'d1',memory_id:'m1',human_reason:'重复记录',status:'pending'},'deletion_review 剥离 rejection_reason(null)/submitted_by/日期');
 assert.deepEqual(byTool['memory_correct'],{relations:[{relation_id:'r1',from_memory:'m1',to_memory:'m2',relation_type:'contradicts',reversed:false}]},'relations 投影保留 reversed 标志，剥离 custom_label(null)/reverse_label(null)/created_by/时间戳');
 assert.ok(byTool['memory_i_read'].items[0].content===body,'I 正文逐字');
 assert.ok(!JSON.stringify(records).includes('forgetting_note'),'内部字段不泄漏');
});
