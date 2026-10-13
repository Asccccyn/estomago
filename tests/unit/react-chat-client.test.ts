import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EstomagoClient } from '../../apps/web/react/src/chat-client.ts'
const dto=(id:string,text:string,revision=1)=>({id,sequence:1,speaker:'owner',turn_id:'turn-fixture',current_revision:revision,revision:{revision,content:text,content_hash:'fixture-hash-'+revision,occurred_at:'2026-10-13T12:00:00Z',attachments:[]}})
async function setup(handler:(url:string,init?:RequestInit)=>Promise<Response>|Response|undefined=()=>undefined){
  const calls:Array<{url:string;init?:RequestInit}>=[]
  const client=new EstomagoClient({fetch:async(u,init)=>{
    const url=String(u);calls.push({url,init});const response=handler(url,init);if(response)return await response
    if(url.includes('/messages?'))return Response.json({messages:[]})
    if(url.endsWith('/runtime-settings'))return Response.json({driver:'openrouter',or_model:{effective:'fixture'},model_options:['fixture'],effort_options:['high'],reasoning_effort:{effective:'high'}})
    if(url.endsWith('/context-records'))return Response.json({context:{hardCapacity:null}})
    return Response.json({})
  },eventSource:()=>({close(){},onmessage:null,onerror:null}) as any,redirect:()=>{}})
  await client.start();return {client,calls}
}
test('IME合成期不发送；多行、前后空白原样作为一条消息保存',async()=>{
  let sent:any
  const h=await setup((url,init)=>url.endsWith('/messages')&&init?.method==='POST'?(sent=JSON.parse(String(init.body)),Response.json({message:dto('m1',sent.content)})):undefined)
  try{h.client.setDraft('  第一行\r\n第二行\n ');h.client.setComposing(true);await h.client.send();assert.equal(sent,undefined)
    h.client.setComposing(false);await h.client.send();assert.equal(sent.content,'  第一行\n第二行\n ');assert.equal(h.client.snapshot.draft,'')
  }finally{h.client.stop()}
})
test('晚到回执不清空新草稿；发送过程中不重复提交',async()=>{
  let resolve!:(r:Response)=>void
  const h=await setup((url,init)=>url.endsWith('/messages')&&init?.method==='POST'?new Promise(r=>resolve=r):undefined)
  try{h.client.setDraft('原草稿');const pending=h.client.send();await h.client.send();h.client.setDraft('新草稿')
    assert.equal(h.calls.filter(c=>c.url.endsWith('/messages')&&c.init?.method==='POST').length,1)
    resolve(Response.json({message:dto('m1','原草稿')}));await pending;assert.equal(h.client.snapshot.draft,'新草稿')
  }finally{h.client.stop()}
})
test('仅附件可发送，失败重试冻结完整载荷，新附件不被清除',async()=>{
  let uploads=0,posts=0;const bodies:any[]=[]
  const h=await setup((url,init)=>{
    if(url.startsWith('/api/v1/assets?'))return Response.json({asset_id:'asset-'+(++uploads)})
    if(url.endsWith('/messages')&&init?.method==='POST'){bodies.push({body:JSON.parse(String(init.body)),key:(init.headers as any)['Idempotency-Key']});return ++posts===1?Promise.reject(new Error('lost response')):Response.json({message:dto('m1','')})}
  })
  try{await h.client.queue(new Blob(['a']),'a.png');assert.equal(h.client.canSend,true);await h.client.send()
    await h.client.queue(new Blob(['b']),'b.png');await h.client.send();assert.deepEqual(bodies[0],bodies[1]);assert.equal(bodies[1].body.kind,undefined)
    assert.equal(h.client.snapshot.attachments.length,1);assert.equal(h.client.snapshot.attachments[0].assetId,'asset-2')
  }finally{h.client.stop()}
})
test('语音必须完成可信转写才可发送，正文请求不携带客户端派生文字',async()=>{
  let resolve!:(r:Response)=>void;let body:any
  let reached!:()=>void;const transcribing=new Promise<void>(r=>reached=r)
  const h=await setup((url,init)=>{
    if(url.startsWith('/api/v1/assets?'))return Response.json({asset_id:'voice-fixture'})
    if(url.endsWith('/transcribe'))return new Promise(r=>{resolve=r;reached()})
    if(url.endsWith('/messages')&&init?.method==='POST'){body=JSON.parse(String(init.body));return Response.json({message:dto('mvoice','')})}
  })
  try{const upload=h.client.queue(new Blob(['voice']),'语音','voice');await transcribing
    assert.equal(h.client.canSend,false);resolve(Response.json({state:'ready',derived_text:'服务端转写'}));await upload;assert.equal(h.client.canSend,true)
    await h.client.send();assert.deepEqual(body.attachments,[{asset_id:'voice-fixture',presentation:'voice'}]);assert.equal(body.derived_text,undefined)
  }finally{h.client.stop()}
})
test('SSE按sequence去重，较旧修订不覆盖新内容',async()=>{
  const h=await setup()
  try{h.client.handleEvent({kind:'message.persisted',sequence:10,message:dto('m1','旧内容')})
    h.client.handleEvent({kind:'message.edited',sequence:12,message:dto('m1','新内容',2)})
    h.client.handleEvent({kind:'message.edited',sequence:11,message:dto('m1','旧事件',1)})
    h.client.handleEvent({kind:'message.edited',sequence:13,message:dto('m1','旧修订',1)})
    assert.equal(h.client.snapshot.messages.length,1);assert.equal(h.client.snapshot.messages[0].text,'新内容')
  }finally{h.client.stop()}
})
test('路由重新编辑更新原消息，携带If-Match的普通编辑也保留修订链',async()=>{
  const h=await setup((url,init)=>{
    if(url.includes('/route-decisions/'))return Response.json({message:dto('m1',JSON.parse(String(init?.body)).content,2)})
    if(url.endsWith('/messages/m1')&&init?.method==='PUT')return Response.json({message:dto('m1','再次编辑',3)})
  })
  try{h.client.handleEvent({kind:'message.persisted',sequence:1,message:dto('m1','原文')})
    h.client.handleEvent({kind:'route.pending',sequence:2,decision_id:'route-fixture',turn_id:'turn-fixture'})
    await h.client.resolveRoute('edit');h.client.setDraft('修订内容');await h.client.send()
    assert.equal(h.client.snapshot.messages[0].text,'修订内容');assert.equal(h.calls.filter(c=>c.url.endsWith('/messages')&&c.init?.method==='POST').length,0)
    await h.client.editMessage('m1','再次编辑');const request=h.calls.find(c=>c.url.endsWith('/messages/m1'))!
    assert.equal((request.init!.headers as any)['If-Match'],'"2"')
  }finally{h.client.stop()}
})
test('非OR模型不借用OR配置；容量未知不产生虚假百分比',async()=>{
  const h=await setup(url=>url.endsWith('/runtime-settings')?Response.json({driver:'deepseek',or_model:{effective:'not-the-real-model'}}):url.endsWith('/context-records')?Response.json({driver:'deepseek',exactModel:'deepseek-chat',context:{estimatedInput:20,hardCapacity:null}}):undefined)
  try{assert.deepEqual(h.client.snapshot.models,['deepseek-chat']);assert.equal(h.client.snapshot.canConfigure,false);await h.client.loadContext();assert.equal(h.client.snapshot.context.limit,null)}finally{h.client.stop()}
})
