import { assembleTestTools } from '../helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate, SUPPORTED_SCHEMA_VERSION } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
function fixture() {
 assert.equal(process.env.ESTOMAGO_TEST_MODE,'1');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'joint-audit-est-'));
 const db=openDatabase(root);migrate(db,sha256Hex);
 const media=new MediaService(db,path.join(root,'media'),buildConfig({}));
 const messages=new MessageService(db); messages.ensureConversation('a'); messages.ensureConversation('b');
 let gets=0;
 const output:any={analysis_id:'analysis_synthetic',revision:1,state:'ready',range_ms:[0,1000],observations:[{kind:'pause',range_ms:[0,10],value:0,unit:'ms',quality:'measured'},{kind:'pitch',range_ms:[0,1000],value:null,unit:'semitone',quality:'unavailable',reason:'unvoiced'}],limits:[],trace_id:'internal_trace',job_id:'internal_job',provider:{request_id:'private_request'},transcript:'duplicated transcript'};
 const adapter:any={ingestVoice:async()=>({audioId:'audio_synthetic',deduplicated:false}),analyze:async()=>structuredClone(output),getOverview:async()=>{gets++;return structuredClone(output)},getProsodyPage:async()=>{gets++;return {analysis_id:'analysis_synthetic',revision:1,syllables:[],next_cursor:'next'}}};
 const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), media: media, messages: messages, oido: adapter });
 const ctx=(roomId='a'):ToolExecContext=>({roomId,windowId:'w',turnId:null,purpose:'chat',activeReviewId:null,seenSequence:1,seenMessages:[],requestId:'audit_synthetic'});
 const create=async()=>{const asset=await media.saveBuffer({bytes:Uint8Array.from([0x1a,0x45,0xdf,0xa3,0x02,0]),purpose:'chat_voice',operationId:'synthetic-upload',createdBy:'qiaosheng',origin:'upload'});messages.publishAssistantMessage({conversationId:'a',turnId:'t',content:'',kind:'voice',clientMessageId:'synthetic-message',attachments:[{asset_id:asset.id,presentation:'voice'}]});return asset;};
 return {root,db,media,messages,tools,adapter,ctx,create,output,gets:()=>gets,close(){db.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('JA-E01: 深听结果必须在当前会话已授权，不能凭 analysis_id 跨会话读',async()=>{const f=fixture();try{const a=await f.create();await f.tools.execute('oido_analyze',{audio_ref:`est:${a.id}`},f.ctx());const r=await f.tools.execute('oido_get',{analysis_id:'analysis_synthetic'},f.ctx('b'));assert.equal(r.ok,false,JSON.stringify(r));assert.equal(f.gets(),0);}finally{f.close();}});
test('JA-E02: 删除原声后 get 必须立即拒绝、不能再取远端副本',async()=>{const f=fixture();try{const a=await f.create();await f.tools.execute('oido_analyze',{audio_ref:`est:${a.id}`},f.ctx());f.db.prepare("DELETE FROM media_assets WHERE id=?").run(a.id);const r=await f.tools.execute('oido_get',{analysis_id:'analysis_synthetic'},f.ctx());assert.equal(r.ok,false);assert.equal(f.gets(),0);}finally{f.close();}});
test('JA-E03: 进入宿主回执的听觉投影剔除调度与重复正文，保留0/false/null',async()=>{const f=fixture();try{const a=await f.create();const r=await f.tools.execute('oido_analyze',{audio_ref:`est:${a.id}`},f.ctx());assert.equal(r.ok,true);for(const k of ['trace_id','job_id','provider','transcript'])assert.equal(k in r.output,false,k);assert.equal((r.output.observations as any[])[0].value,0);assert.equal((r.output.observations as any[])[1].value,null);assert.deepEqual(r.output.limits,[]);}finally{f.close();}});
test('JA-E04: 非有限测量不可悄悄 JSON 编码为 null',async()=>{const f=fixture();try{const a=await f.create();f.output.observations=[{kind:'pitch',range_ms:[0,1000],value:NaN,unit:'semitone',quality:'measured'}];const r=await f.tools.execute('oido_analyze',{audio_ref:`est:${a.id}`},f.ctx());assert.equal(r.ok,false);}finally{f.close();}});
test('JA-E05: schema 支持版本必须等于真实迁移最高版',()=>{const f=fixture();try{const row=f.db.prepare('SELECT max(version) AS version FROM schema_migrations').get() as {version:number};assert.equal(SUPPORTED_SCHEMA_VERSION,row.version);}finally{f.close();}});
test('JA-E06: 结果取回后撤权也不得将迟到证据交给模型',async()=>{const f=fixture();try{const a=await f.create();await f.tools.execute('oido_analyze',{audio_ref:`est:${a.id}`},f.ctx());const original=f.adapter.getOverview;f.adapter.getOverview=async(...args:any[])=>{const r=await original(...args);f.db.prepare("DELETE FROM media_assets WHERE id=?").run(a.id);return r;};const r=await f.tools.execute('oido_get',{analysis_id:'analysis_synthetic'},f.ctx());assert.equal(r.ok,false);}finally{f.close();}});
test('JA-E07: 中止后图片检索不得返回迟到成功（R8′：检索路径零编码）',async()=>{const f=fixture({mediaIndex:{available:true,workerFingerprint:async()=> 'synthetic-fp',unindexedImagesInRoom:()=>['one','two'],indexImage:async()=>{encoded++;return {indexed:true};},searchImagesByRoom:async()=>{queried++;controller.abort();return {candidates:[{asset_ref:'est:late',score:0.99}]};}}});try{const controller=new AbortController();
const r=await f.tools.execute('media_search',{query:'合成图'}, {...f.ctx(),signal:controller.signal});assert.equal(r.ok,false);assert.equal((r.output as any).error_code,'CANCELLED');assert.equal(queried,1);assert.equal(encoded,0,'R8′：检索不再前台补索引');}finally{f.close();}});
for(const [label,change] of [
 ['null measurement cannot be measured or lack a reason',(v:any)=>{v.observations=[{kind:'pitch',range_ms:[0,1],value:null,unit:'ms',quality:'measured'}];}],
 ['partial requires substantive limits',(v:any)=>{v.state='partial';delete v.limits;}],
 ['limits must be unique',(v:any)=>{v.limits=['unvoiced','unvoiced'];}],
] as const)test('JA-E08: '+label,async()=>{const f=fixture();try{const a=await f.create();change(f.output);const r=await f.tools.execute('oido_analyze',{audio_ref:`est:${a.id}`},f.ctx());assert.equal(r.ok,false);}finally{f.close();}});
for(const kind of ['conversation','source_hash'])test('JA-E09: transcript provenance must match '+kind,async()=>{const f=fixture();try{const a=await f.create();const row=f.db.prepare('SELECT content_sha256 FROM media_assets WHERE id=?').get(a.id) as any;f.db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,created_at,updated_at) VALUES (?,?,?,?,'ready',?,?,?)").run(a.id,kind==='conversation'?'b':'a','provenance-test',kind==='source_hash'?'wrong-sha':row.content_sha256,'错误来源的合成转写',new Date().toISOString(),new Date().toISOString());let passed:any='not called';f.adapter.ingestVoice=async(args:any)=>{passed=args.transcript;return {audioId:'synthetic',deduplicated:false};};const r=await f.tools.execute('oido_analyze',{audio_ref:`est:${a.id}`},f.ctx());assert.equal(r.ok,true);assert.equal(passed,null);}finally{f.close();}});
