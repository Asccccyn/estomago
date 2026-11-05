import {test} from 'node:test';
import { assembleTestTools, makeDb } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MessageService} from '../../apps/host/src/messages/service.ts';
import {MariposaClient} from '../../apps/host/src/integrations/mariposa/client.ts';
import {RotationReviewService} from '../../apps/host/src/context/rotation-review.ts';
import {HoldCheckpointService} from '../../apps/host/src/memory/hold-checkpoint.ts';
import {sha256Hex} from '../../apps/host/src/util/id.ts';

function fixture(t:any){
 const {db,root}=makeDb();t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});
 const messages=new MessageService(db);messages.ensureConversation('c1');
 db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('new-window','c1','ACTIVE','now','now')").run();
 const rows=['事件开始','中间原文🙂\n不省略','事件结束'].map((content,i)=>({...messages.submitUserMessageWithTurn({conversationId:'c1',content,clientMessageId:`m${i}`,occurredAt:`2026-10-${18+i}T12:00:00Z`}).message,content}));
 for(const row of rows) db.prepare(`INSERT INTO source_sync_receipts(id,operation_id,origin_message_id,revision,source_conversation_id,source_message_id,content_hash,created_at) VALUES(?,'seed',?,1,'source-c',?,?,?)`).run(`receipt-${row.id}`,row.id,`source-${row.sequence}`,sha256Hex(row.content),'now');
 const calls:any[]=[];
 const client=new MariposaClient({transport:async(cap,payload)=>{calls.push({cap,payload});return {ok:true,result:{memory_id:payload.memory_id,binding_id:'bind1'}}}});
 const { tools: tools } = assembleTestTools({ db: db, mariposa: client, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
 const ctx={roomId:'c1',windowId:'new-window',turnId:null,requestId:'event-request',purpose:'chat' as const,activeReviewId:null,seenSequence:3,seenMessages:rows.map(r=>({id:r.id,revision:1}))};
 const args={memory_id:'m1',start_seq:1,end_seq:3};
 return {db,rows,calls,tools,ctx,args};
}

test('跨天且不受窗口边界截断：独立绑定传完整三条成员，不传原文正文',async t=>{
 const f=fixture(t);const r=await f.tools.execute('memory_source_bind',f.args,f.ctx);assert.equal(r.ok,true,JSON.stringify(r.output));
 assert.equal(f.calls.length,1);const p=f.calls[0].payload;
 assert.equal(p.our_words,undefined);assert.equal(p.source_selections,undefined);
 assert.deepEqual(p.members.map((x:any)=>x.source_message_id),['source-1','source-2','source-3']);
 assert.equal(JSON.stringify(p.members).includes('中间原文'),false);
});

test('来源当前修订缺失时只拒绝绑定，不发送远端绑定请求',async t=>{
 const f=fixture(t);f.db.prepare('UPDATE messages SET current_revision=2 WHERE id=?').run(f.rows[1]!.id);
 // Missing current revision cannot silently disappear from the selected interval.
 const r=await f.tools.execute('memory_source_bind',f.args,f.ctx);
 assert.equal(r.ok,false);assert.equal(f.calls.length,0);
});

test('绑定按真实来源验证，不要求先调用读取工具',async t=>{
 const f=fixture(t);f.ctx.seenMessages.length=0;
 const r=await f.tools.execute('memory_source_bind',f.args,f.ctx);
 assert.equal(r.ok,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].cap,'source.binding.bind');
});

test('跨来源会话、缺失边界和反向范围都拒绝',async t=>{
 for(const mode of ['conversation','missing','reverse']) {
  const f=fixture(t);
  if(mode==='conversation')f.db.prepare("UPDATE source_sync_receipts SET source_conversation_id='other' WHERE origin_message_id=?").run(f.rows[1]!.id);
  if(mode==='missing')f.args.end_seq=99;
  if(mode==='reverse')Object.assign(f.args,{start_seq:3,end_seq:1});
  assert.equal((await f.tools.execute('memory_source_bind',f.args,f.ctx)).ok,false);assert.equal(f.calls.length,0);
 }
});
