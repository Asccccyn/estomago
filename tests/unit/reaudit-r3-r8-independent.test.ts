// R3′（2026-10-23，她批 R3P 方案）：长转写分页——首页 ≤8192B、续读读尽拼回全文、
// 源变更/跨会话/已删资产如实拒读（不静默截断、不静默重读新版本）。
import { test } from 'node:test';
import {fullToolCatalog, assembleTestTools } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import type { ToolExecContext } from '../../apps/host/src/capabilities/contracts.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { projectRevisionBlocks } from '../../apps/host/src/media/model-input.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3p-est-'));
  const db = openDatabase(root); migrate(db, sha256Hex);
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const messages = new MessageService(db); messages.ensureConversation('a'); messages.ensureConversation('b');
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), media: media, messages: messages });
  const ctx = (roomId = 'a'): ToolExecContext => ({ roomId, windowId: 'w', turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r3p' });
  const createWithTranscript = async (text: string) => {
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x00]), purpose: 'chat_voice', operationId: `op-${Math.random().toString(36).slice(2, 8)}`, createdBy: 'qiaosheng', origin: 'upload' });
    const row = db.prepare('SELECT content_sha256 FROM media_assets WHERE id=?').get(asset.id) as { content_sha256: string };
    db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,created_at,updated_at) VALUES (?,?,?,?,'ready',?,?,?)")
      .run(asset.id, 'a', 'r3p-op', row.content_sha256, text, new Date().toISOString(), new Date().toISOString());
    return asset;
  };
  return { root, db, media, messages, tools, ctx, createWithTranscript, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}


import { runMediaBackfillTick } from '../../apps/host/src/media/index/backfill.ts';
import { freezeWindowTools } from '../../apps/host/src/runtime/tool-discovery.ts';

for (const symbol of ['𠮷', '\u0000']) test('R3 model projection budget for '+JSON.stringify(symbol), async()=>{
 const f=fixture();try{const text=symbol.repeat(3000);const a=await f.createWithTranscript(text);
 const p=projectRevisionBlocks('',[{asset_id:a.id,presentation:'voice',caption:null,derived_text:text,derived_source:'siren:transcribe'}],{isCurrentInput:true,hearing:{available:true}});
 const projectionBytes=Buffer.byteLength(JSON.stringify(p.blocks));console.log(JSON.stringify({case:'projection_budget',symbol,bytes:projectionBytes}));
 assert.ok(projectionBytes<=8192, `serialized projection ${projectionBytes} > 8192`);
 }finally{f.close();}
});
// 她 1024 裁定：3/4 原夹具未发布消息（与 6/7 草稿拒绝互斥）——测试问题在夹具不在产品；
// 改为合法源（发布当前修订语音附件）后断言原样：预算分页在合法源上成立。
for (const symbol of ['𠮷', '\u0000']) test('R3 tool page serialized JSON budget for '+JSON.stringify(symbol),async()=>{
 const f=fixture();try{const a=await f.createWithTranscript(symbol.repeat(3000));
 f.messages.publishAssistantMessage({conversationId:'a',turnId:'synthetic-budget',content:'',kind:'voice',clientMessageId:`budget-${symbol.length}`,attachments:[{asset_id:a.id,presentation:'voice'}]});
 const r=await f.tools.execute('transcript_read',{audio_ref:'est:'+a.id},f.ctx());assert.equal(r.ok,true);const bytes=Buffer.byteLength(JSON.stringify(r.output));console.log(JSON.stringify({case:'tool_budget',symbol,bytes}));assert.ok(bytes<=8192,`serialized page ${bytes} > 8192`);}finally{f.close();}
});
test('R3 unsubmitted draft transcript is not reachable as conversation evidence',async()=>{
 const f=fixture();try{const a=await f.createWithTranscript('用户未发送的语音草稿');const r=await f.tools.execute('transcript_read',{audio_ref:'est:'+a.id},f.ctx());assert.equal(r.ok,false,'no current message attachment grants read');}finally{f.close();}
});
test('R3 revoked current message revision blocks transcript read',async()=>{
 const f=fixture();try{const a=await f.createWithTranscript('已撤回的消息附件');const m=f.messages.publishAssistantMessage({conversationId:'a',turnId:'synthetic',content:'',kind:'voice',clientMessageId:'published',attachments:[{asset_id:a.id,presentation:'voice'}]});
 f.db.prepare('UPDATE messages SET current_revision=2 WHERE id=?').run(m.id);const r=await f.tools.execute('transcript_read',{audio_ref:'est:'+a.id},f.ctx());assert.equal(r.ok,false,'old attachment revision cannot grant current read');}finally{f.close();}
});
test('R3 old frozen window must not truncate into an unavailable continuation tool',async()=>{
 const f=fixture();try{f.db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES('w','a','ACTIVE','2026-10-23','2026-10-23')").run();freezeWindowTools(f.db,'w',fullToolCatalog().filter(x=>x.function.name!=='transcript_read'),'legacy');
 const text='甲'.repeat(5000);const a=await f.createWithTranscript(text);const projected=projectRevisionBlocks('',[{asset_id:a.id,presentation:'voice',caption:null,derived_text:text,derived_source:'siren:transcribe'}],{isCurrentInput:true,hearing:{available:true}});
 const r=await f.tools.execute('transcript_read',{audio_ref:'est:'+a.id},f.ctx());console.log(JSON.stringify({case:'legacy_window',advertisesContinuation:JSON.stringify(projected).includes('transcript_read'),toolOk:r.ok,code:r.output.error_code}));assert.ok(!JSON.stringify(projected).includes('transcript_read')||r.ok,'advertised continuation must be usable under frozen window policy');
 }finally{f.close();}
});
test('R8 permanent first-room failure must not starve later rooms indefinitely',async()=>{
 const seen:string[]=[];const svc={available:true,workerFingerprint:async()=> 'synthetic-fp',roomsWithUnindexedImages:()=>['first','second'],unindexedImagesInRoom:(room:string)=>room==='first'?['bad']:['good'],indexImage:async(id:string)=>{seen.push(id);if(id==='bad')throw Error('bad media');return {indexed:true};}};
 for(let i=0;i<6;i++)await runMediaBackfillTick(svc as never,new AbortController().signal);
 console.log(JSON.stringify({case:'backfill_fairness',attempts:seen}));assert.ok(seen.includes('good'),'later room must receive service despite permanent failure');
});
test('R8 five permanently bad images must not starve sixth image',async()=>{
 const seen:string[]=[];const svc={available:true,workerFingerprint:async()=> 'synthetic-fp',roomsWithUnindexedImages:()=>['r'],unindexedImagesInRoom:()=>['bad1','bad2','bad3','bad4','bad5','good'],indexImage:async(id:string)=>{seen.push(id);if(id!=='good')throw Error('bad media');return {indexed:true};}};
 for(let i=0;i<6;i++)await runMediaBackfillTick(svc as never,new AbortController().signal);assert.ok(seen.includes('good'),'a bounded batch also needs retry/fairness progress');
});
test('R8 in-flight abort prevents subsequent asset attempts',async()=>{
 const c=new AbortController();const seen:string[]=[];const svc={available:true,workerFingerprint:async()=> 'synthetic-fp',roomsWithUnindexedImages:()=>['r'],unindexedImagesInRoom:()=>['a','b'],indexImage:async(id:string,signal:AbortSignal)=>{seen.push(id);c.abort();signal.throwIfAborted();return {indexed:true};}};await runMediaBackfillTick(svc as never,c.signal);assert.deepEqual(seen,['a']);
});
