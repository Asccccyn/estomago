import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EstomagoClient} from '../../apps/web/react/src/chat-client.ts'
const dto=(id='m1',turn='t1',sequence=1)=>({id,sequence,speaker:'owner',turn_id:turn,current_revision:1,revision:{revision:1,content:'synthetic',content_hash:'fixture',occurred_at:'2026-10-19T10:00:00Z',attachments:[]}})
async function setup(handler:(u:string,i?:RequestInit)=>Response|Promise<Response>|undefined=()=>undefined,rows:any[]=[]){
 const calls:any[]=[]
 const c=new EstomagoClient({fetch:async(u,i)=>{const url=String(u);calls.push({url,i});const v=handler(url,i);if(v!==undefined)return await v;if(url.includes('/messages?'))return Response.json({messages:rows});if(url.endsWith('/runtime-settings'))return Response.json({driver:'mock'});return Response.json({})},eventSource:()=>({close(){}}) as any,redirect(){}})
 await c.start();await new Promise(r=>setTimeout(r,0));return{c,calls}
}
test('terminal attempt cannot revive; older attempt cannot terminate newer attempt',async()=>{
 const {c}=await setup();try{
 c.handleEvent({sequence:1,kind:'turn.started',turn_id:'t1',attempt_id:'a1'})
 c.handleEvent({sequence:2,kind:'turn.completed',turn_id:'t1',attempt_id:'a1'})
 c.handleEvent({sequence:3,kind:'turn.status',turn_id:'t1',attempt_id:'a1',state:'running'})
 assert.equal(c.snapshot.messages.filter(m=>m.pending||m.streaming).length,0)
 c.handleEvent({sequence:4,kind:'turn.started',turn_id:'t1',attempt_id:'a2'})
 c.handleEvent({sequence:5,kind:'turn.interrupted',turn_id:'t1',attempt_id:'a1'})
 assert.equal(c.snapshot.messages.filter(m=>m.pending||m.streaming).length,1)
 }finally{c.stop()}
})
test('lifecycle cancellation aborts read and blocks late write across restart',async()=>{
 let resolve!:(r:Response)=>void,signal:AbortSignal|undefined
 const {c}=await setup((u,i)=>u.includes('/content/creations?')?new Promise(r=>{resolve=r;signal=i?.signal as AbortSignal}):undefined)
 const pending=c.loadPanel('bench');c.stop();assert.equal(signal?.aborted,true);await c.start();const baseline=c.snapshot
 resolve(Response.json({items:[{id:'late',created_at:'2026-10-19'}]}));await pending
 assert.equal(c.snapshot.workbench.length,0);assert.equal(c.snapshot.notice,baseline.notice);c.stop()
})
test('foreign events do not change messages or consume primary cursor',async()=>{
 const {c}=await setup();try{
 c.handleEvent({sequence:100,kind:'message.persisted',conversation_id:'other',message:dto('foreign')})
 c.handleEvent({sequence:1,kind:'message.persisted',conversation_id:'primary',message:dto()})
 assert.deepEqual(c.snapshot.messages.map(m=>m.id),['m1'])
 }finally{c.stop()}
})
test('invalid successful message acknowledgment preserves draft and original retry identity',async()=>{
 let n=0;const ids:string[]=[]
 const {c}=await setup((u,i)=>{if(u.endsWith('/messages')&&i?.method==='POST'){ids.push((i.headers as any)['Idempotency-Key']);return ++n===1?Response.json({message:{}}):Response.json({message:dto()})}})
 try{c.setDraft('synthetic');await c.send();assert.equal(c.snapshot.draft,'synthetic');await c.send();assert.equal(c.snapshot.draft,'');assert.equal(ids[0],ids[1])}finally{c.stop()}
})
test('500 message startup requests no historical reasoning or usage until explicit expansion',async()=>{
 const {c,calls}=await setup(undefined,Array.from({length:500},(_,i)=>dto('m'+i,'t'+i,i+1)))
 try{assert.equal(calls.filter(x=>/\/(reasoning|usage)/.test(x.url)).length,0);c.loadTurnDetails('t1');await new Promise(r=>setTimeout(r,0));assert.equal(calls.filter(x=>/\/(reasoning|usage)/.test(x.url)).length,2)}finally{c.stop()}
})
test('selection consumes nested rotated receipt once and never rotates the new active window',async()=>{
 let resolve!:(r:Response)=>void
 const {c,calls}=await setup((u)=>u.endsWith('/runtime')?Response.json({active_window:{id:'w1'}}):u.endsWith('/confirm')?new Promise(r=>resolve=r):undefined,[dto()])
 try{c.select('m1');const first=c.confirmSelection();const second=c.confirmSelection();await new Promise(r=>setTimeout(r,0));resolve(Response.json({selection:{id:'s1',rotated:true,window_id:'w2'}}));await Promise.all([first,second]);assert.equal(calls.filter(x=>x.url.endsWith('/confirm')).length,1);assert.equal(calls.filter(x=>x.url.endsWith('/rotate')).length,0);assert.equal(c.snapshot.selectionMode,false)}finally{c.stop()}
})
test('failed rotation preserves selected messages for recovery',async()=>{
 const {c}=await setup(u=>u.endsWith('/runtime')?Response.json({active_window:{id:'w1'}}):u.endsWith('/confirm')?Response.json({selection:{rotated:false}}):u.endsWith('/rotate')?Response.json({error:{code:'busy',message:'busy'}},{status:409}):undefined,[dto()])
 try{c.select('m1');await c.confirmSelection();assert.equal(c.snapshot.selectionMode,true);assert.deepEqual([...c.snapshot.selected],['m1'])}finally{c.stop()}
})

test('SSE historical replay cannot reset pagination boundary or pull old rows into latest page',async()=>{
 const {c,calls}=await setup(u=>u.includes('before=501')?Response.json({messages:[dto('m500','t500',500)]}):undefined,Array.from({length:500},(_,i)=>dto('m'+(501+i),'t'+(501+i),501+i)))
 try{c.handleEvent({sequence:1,kind:'message.persisted',message:dto('old','old',1)});assert.equal(c.snapshot.messages.length,500);await c.loadEarlier();assert.ok(calls.some(x=>x.url.includes('before=501')));assert.ok(c.snapshot.messages.some(x=>x.id==='m500'))}finally{c.stop()}
})

 test('malformed JSON on successful POST preserves draft and idempotency key',async()=>{
 let n=0;const ids:string[]=[]
 const {c}=await setup((u,i)=>{if(u.endsWith('/messages')&&i?.method==='POST'){ids.push((i.headers as any)['Idempotency-Key']);return ++n===1?new Response('{broken',{status:200}):Response.json({message:dto()})}})
 try{c.setDraft('synthetic');await c.send();assert.equal(c.snapshot.draft,'synthetic');assert.match(c.snapshot.notice,/格式错误/);await c.send();assert.equal(c.snapshot.draft,'');assert.equal(ids[0],ids[1])}finally{c.stop()}
})
test('late POST from stopped lifecycle cannot clear draft or unlock a new in-flight send',async()=>{
 const replies:Array<(r:Response)=>void>=[]
 const {c}=await setup((u,i)=>u.endsWith('/messages')&&i?.method==='POST'?new Promise(r=>replies.push(r)):undefined)
 try{
 c.setDraft('synthetic');const first=c.send();c.stop();assert.equal(c.canSend,false)
 await c.start();const retry=c.send();assert.equal(c.snapshot.sending,true)
 replies[0](Response.json({message:dto()}));await first
 assert.equal(c.snapshot.draft,'synthetic');assert.equal(c.snapshot.sending,true);assert.equal(c.snapshot.messages.length,0)
 replies[1](Response.json({message:dto()}));await retry;assert.equal(c.snapshot.draft,'');assert.equal(c.snapshot.sending,false)
 }finally{c.stop()}
})
