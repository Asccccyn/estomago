// 包4（2026-11-18）：本文件原测 memory_source_bind 的 seq 区间绑定——该工具已退出
// char模型面（裁定6）。等价语义（跨天完整成员、不传原文正文、按真实来源收据验证）
// 由 episode_apply 的锚点范围承担；这里钉住替代路径 + 退出事实。
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
 const rows=['事件开始','中间原文\n不省略','事件结束'].map((content,i)=>({...messages.submitUserMessageWithTurn({conversationId:'c1',content,clientMessageId:`m${i}`,occurredAt:`2026-10-${18+i}T12:00:00Z`}).message,content}));
 for(const row of rows) db.prepare(`INSERT INTO source_sync_receipts(id,operation_id,origin_message_id,revision,source_conversation_id,source_message_id,content_hash,committed_at,created_at) VALUES(?,'seed',?,1,'source-c',?,?,?,?)`).run(`receipt-${row.id}`,row.id,`source-${row.sequence}`,sha256Hex(row.content),'now','now');
 const calls:any[]=[];
 const client=new MariposaClient({transport:async(cap,payload)=>{calls.push({cap,payload});return {ok:true,result:{episode_id:'ep-1',revision:1}}}});
 const { tools: tools } = assembleTestTools({ db: db, mariposa: client, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
 const ctx={roomId:'c1',windowId:'new-window',turnId:'t-ev',requestId:'event-request',purpose:'chat' as const,activeReviewId:null,seenSequence:3,seenMessages:rows.map(r=>({id:r.id,revision:1}))};
 const anchors={anchor_start:{speaker:'宿主用户' as const,quote:'事件开始'},anchor_end:{speaker:'宿主用户' as const,quote:'事件结束'}};
 return {db,rows,calls,tools,ctx,anchors};
}

test('跨天且不受窗口边界截断：episode 锚点范围传完整三条成员，不传原文正文（替代原独立绑定）',async t=>{
 const f=fixture(t);const r=await f.tools.execute('episode_apply',{action:'start',reason_code:'tracking_requested',label:'跨天事件',...f.anchors},f.ctx);assert.equal(r.ok,true,JSON.stringify(r.output).slice(0,300));
 assert.equal(f.calls.length,1);const p=f.calls[0].payload;
 const sel=(p.source_selections as Array<{members:Array<{source_message_id:string}>}>)[0]!;
 assert.deepEqual(sel.members.map((x)=>x.source_message_id),['source-1','source-2','source-3']);
 assert.equal(JSON.stringify(p).includes('中间原文'),false,'来源身份不携带原文正文');
});

test('来源收据缺失（该修订未同步）只拒绝，不发送远端请求',async t=>{
 const f=fixture(t);f.db.prepare('DELETE FROM source_sync_receipts WHERE origin_message_id=?').run(f.rows[1]!.id);
 const r=await f.tools.execute('episode_apply',{action:'start',reason_code:'tracking_requested',label:'x',...f.anchors},f.ctx);
 assert.equal(r.ok,false);
 assert.equal((r.output as {error_code:string}).error_code,'EVENT_SOURCE_NOT_SYNCED');
 assert.equal(f.calls.length,0,'未发送远端请求');
});

test('跨来源会话拒绝：锚点范围成员必须同源',async t=>{
 const f=fixture(t);
 f.db.prepare("UPDATE source_sync_receipts SET source_conversation_id='other' WHERE origin_message_id=?").run(f.rows[1]!.id);
 const r=await f.tools.execute('episode_apply',{action:'start',reason_code:'tracking_requested',label:'x',...f.anchors},f.ctx);
 assert.equal(r.ok,false);
 assert.equal((r.output as {error_code:string}).error_code,'EVENT_SOURCE_CONVERSATION_MISMATCH');
 assert.equal(f.calls.length,0);
});

test('包4裁定6：memory_source_bind 已退出模型面——旧名称不可调用',async t=>{
 const f=fixture(t);
 const r=await f.tools.execute('memory_source_bind',{memory_id:'m1',start_seq:1,end_seq:3},f.ctx);
 assert.equal(r.ok,false);
 assert.equal((r.output as {error_code:string}).error_code,'TOOL_NOT_IN_ALLOWLIST');
 assert.equal(f.calls.length,0);
});
