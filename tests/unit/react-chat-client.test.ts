import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EstomagoClient } from '../../apps/web/react/src/chat-client.ts'
const dto=(id:string,text:string,revision=1)=>({id,sequence:1,speaker:'owner',turn_id:'turn-fixture',current_revision:revision,revision:{revision,content:text,content_hash:'fixture-hash-'+revision,occurred_at:'2026-10-13T12:00:00Z',attachments:[]}})
test('推理默认是未选择状态，取消选择清除覆盖值，不添加第五档',async()=>{
  let effort:string|null=null
  const h=await setup((url,init)=>{
    if(!url.endsWith('/runtime-settings'))return
    if(init?.method==='PUT'){
      const next=JSON.parse(String(init.body)).reasoning_effort
      effort=next==='default'?null:next
    }
    return Response.json({driver:'openrouter',or_model:{effective:'fixture'},effort_options:['default','low','medium','high','max'],reasoning_effort:{override:effort,effective:effort??'default'}})
  })
  try{
    assert.deepEqual(h.client.snapshot.efforts,['low','medium','high','max'])
    assert.equal(h.client.snapshot.effort,-1)
    await h.client.setEffort(1)
    assert.equal(effort,'medium')
    assert.equal(h.client.snapshot.effort,1)
    await h.client.setEffort(-1)
    assert.equal(effort,null)
    assert.equal(h.client.snapshot.effort,-1)
  }finally{h.client.stop()}
})
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

test('图片能力预检失败明确消息已保存、模型未发送，不自动重发',async()=>{
  const h=await setup()
  try{
    h.client.handleEvent({kind:'message.persisted',sequence:1,message:dto('m1','保留的消息')})
    h.client.handleEvent({kind:'turn.started',sequence:2,turn_id:'turn-fixture'})
    const requestsBefore=h.calls.length
    h.client.handleEvent({kind:'turn.status',sequence:3,turn_id:'turn-fixture',state:'failed',reason:'MODEL_VISION_UNAVAILABLE'})
    assert.equal(h.client.snapshot.notice,'暂时无法核实模型的图片能力，本轮未发送；消息已保存，请稍后重试。')
    assert.equal(h.client.snapshot.messages.length,1)
    assert.equal(h.client.snapshot.messages[0].text,'保留的消息')
    assert.ok(h.calls.slice(requestsBefore).every(c=>!c.init?.method||c.init.method==='GET'), '状态刷新只读，不自动重发')
  }finally{h.client.stop()}
})

test('重载恢复失败消息的重试入口；原文重试不追加用户气泡，不动底部草稿',async()=>{
  const failed={...dto('retry-message','原文'),reply_status:{state:'failed',can_retry:true,reason:null,turn_id:'turn-fixture',attempt_id:'old-attempt'}}
  let body:any
  const h=await setup((url,init)=>{
    if(url.includes('/messages?'))return Response.json({messages:[failed]})
    if(url.endsWith('/retry')){body=JSON.parse(String(init?.body));return Response.json({message:{...failed,reply_status:{...failed.reply_status,state:'pending',can_retry:false,attempt_id:'new-attempt'}},turn_id:'turn-fixture',attempt_id:'new-attempt'})}
  })
  try{
    assert.equal(h.client.snapshot.messages[0].canRetry,true)
    h.client.setDraft('另一条尚未发送的草稿')
    assert.equal(await h.client.retryMessage('retry-message'),true)
    assert.deepEqual(body,{content:'原文'})
    assert.equal(h.client.snapshot.messages.length,1)
    assert.equal(h.client.snapshot.messages[0].replyState,'pending')
    assert.equal(h.client.snapshot.messages[0].canRetry,false)
    assert.equal(h.client.snapshot.draft,'另一条尚未发送的草稿')
  }finally{h.client.stop()}
})

test('编辑重发双击只提交一次，回执丢失沿用操作键和旧版本，即使SSE已更新正文',async()=>{
  let complete!:(r:Response)=>void;let posts=0
  const h=await setup((url,init)=>{
    if(url.endsWith('/retry')){
      posts++
      if(posts===1)return Promise.reject(new Error('lost response'))
      return new Promise(resolve=>{complete=resolve})
    }
  })
  try{
    h.client.handleEvent({kind:'message.persisted',sequence:1,message:dto('m1','原文')})
    assert.equal(await h.client.editMessage('m1','修改后',true,1),false)
    h.client.handleEvent({kind:'message.edited',sequence:2,message:dto('m1','修改后',2)})
    const retry=h.client.editMessage('m1','修改后',true,1)
    assert.equal(await h.client.editMessage('m1','修改后',true,1),false)
    assert.equal(posts,2)
    const requests=h.calls.filter(c=>c.url.endsWith('/retry'))
    assert.deepEqual(requests[0].init,requests[1].init)
    assert.equal((requests[1].init!.headers as any)['If-Match'],'"1"')
    complete(Response.json({message:dto('m1','修改后',2),turn_id:'turn-fixture',attempt_id:'a2',duplicate:true}))
    assert.equal(await retry,true)
    assert.equal(h.client.snapshot.messages.length,1)
    assert.equal(h.client.snapshot.messages[0].editPending,false)
  }finally{h.client.stop()}
})

test('未知回执不能用新内容另起操作；直接重试先确认冻结的原操作',async()=>{
  let posts=0;const bodies:any[]=[]
  const h=await setup((url,init)=>{
    if(url.endsWith('/retry')){posts++;bodies.push(JSON.parse(String(init?.body)));return posts===1?Promise.reject(new Error('offline')):Response.json({message:dto('m1','第一次修改',2)})}
  })
  try{
    h.client.handleEvent({kind:'message.persisted',sequence:1,message:dto('m1','原文')})
    await h.client.editMessage('m1','第一次修改',true,1)
    assert.equal(await h.client.editMessage('m1','第二次修改',true,1),false)
    assert.equal(posts,1)
    assert.match(h.client.snapshot.notice,/尚未确认/)
    assert.equal(await h.client.retryMessage('m1'),true)
    assert.deepEqual(bodies,[{content:'第一次修改'},{content:'第一次修改'}])
  }finally{h.client.stop()}
})

test('编辑基于打开时版本，409不静默覆盖其他端的新修订且保留底部草稿',async()=>{
  const h=await setup((url,init)=>url.endsWith('/retry')?Response.json({error:{code:'revision_conflict',message:'版本已更新'}},{status:409}):undefined)
  try{
    h.client.handleEvent({kind:'message.persisted',sequence:1,message:dto('m1','原文')})
    const original=h.client.messageRevision('m1')
    h.client.handleEvent({kind:'message.edited',sequence:2,message:dto('m1','另一端的修改',2)})
    h.client.setDraft('底部草稿')
    assert.equal(await h.client.editMessage('m1','本地编辑',true,original),false)
    const request=h.calls.find(c=>c.url.endsWith('/retry'))!
    assert.equal((request.init!.headers as any)['If-Match'],'"1"')
    assert.equal(h.client.snapshot.messages[0].text,'另一端的修改')
    assert.equal(h.client.snapshot.draft,'底部草稿')
    assert.match(h.client.snapshot.notice,/编辑内容已保留/)
  }finally{h.client.stop()}
})

test('失败事件刷新真实重试资格，同版本状态更新生效，旧响应不覆盖后续状态',async()=>{
  let first!:(r:Response)=>void;let reads=0
  const h=await setup(url=>{
    if(url.endsWith('/messages/m1'))return ++reads===1?new Promise(resolve=>{first=resolve}):Response.json({message:{...dto('m1','原文'),reply_status:{state:'completed',can_retry:false,reason:'RETRY_NOT_FAILED'}}})
  })
  try{
    h.client.handleEvent({kind:'message.persisted',sequence:1,message:dto('m1','原文')})
    h.client.handleEvent({kind:'turn.status',sequence:2,turn_id:'turn-fixture',state:'failed',reason:'OR_NETWORK_ERROR'})
    h.client.handleEvent({kind:'turn.status',sequence:3,turn_id:'turn-fixture',state:'completed'})
    first(Response.json({message:{...dto('m1','原文'),reply_status:{state:'failed',can_retry:true,reason:null}}}))
    for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve))
    assert.equal(reads,2)
    assert.equal(h.client.snapshot.messages[0].replyState,'completed')
    assert.equal(h.client.snapshot.messages[0].canRetry,false)
  }finally{h.client.stop()}
})

test('迟到的重试回执不能把已由SSE确认的终态退回pending',async()=>{
  let finishPost!:(response:Response)=>void;let reads=0
  const terminal={...dto('m1','原文'),reply_status:{state:'failed',can_retry:true,reason:null,attempt_id:'new-attempt'}}
  const h=await setup((url,init)=>{
    if(url.endsWith('/retry'))return new Promise(resolve=>{finishPost=resolve})
    if(url.endsWith('/messages/m1')){reads++;return Response.json({message:terminal})}
  })
  try{
    h.client.handleEvent({kind:'message.persisted',sequence:1,message:dto('m1','原文')})
    const submission=h.client.editMessage('m1','原文',true,1)
    h.client.handleEvent({kind:'turn.status',sequence:2,turn_id:'turn-fixture',attempt_id:'new-attempt',state:'failed'})
    for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve))
    assert.equal(h.client.snapshot.messages[0].replyState,'failed')
    finishPost(Response.json({message:{...terminal,reply_status:{...terminal.reply_status,state:'pending',can_retry:false}},attempt_id:'new-attempt'}))
    assert.equal(await submission,true)
    for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve))
    assert.ok(reads>=2,'成功回执后再次读取当前状态，即使之前刷新已空闲')
    assert.equal(h.client.snapshot.messages[0].replyState,'failed')
    assert.equal(h.client.snapshot.messages[0].canRetry,true)
  }finally{h.client.stop()}
})

test('后来发布的系统或助手消息立即隐藏旧失败消息的直接重试',async()=>{
  const failed={...dto('m1','原文'),reply_status:{state:'failed',can_retry:true,reason:null,attempt_id:'old'}}
  const h=await setup(url=>url.includes('/messages?')?Response.json({messages:[failed]}):undefined)
  try{
    assert.equal(h.client.snapshot.messages[0].canRetry,true)
    h.client.handleEvent({kind:'message.published',sequence:2,message:{...dto('later','稍后发布'),sequence:2,speaker:'system',turn_id:null}})
    assert.equal(h.client.snapshot.messages.find(m=>m.id==='m1')!.canRetry,false)
  }finally{h.client.stop()}
})
test('失败状态经SSE回放保留原因，打开活动日志不丢失也不重复',async()=>{
  const h=await setup(url=>url.includes('/context-records/events?')?Response.json({events:[]}):undefined)
  try{
    const failure={kind:'turn.status',sequence:10,turn_id:'turn-fixture',state:'failed',reason:'MODEL_VISION_UNAVAILABLE:unknown'}
    h.client.handleEvent(failure);h.client.handleEvent(failure)
    await h.client.loadPanel('log')
    assert.equal(h.client.snapshot.activity.length,1)
    assert.equal(h.client.snapshot.activity[0].d,'failed · MODEL_VISION_UNAVAILABLE:unknown')
    assert.equal(h.client.snapshot.panelNote,'')
    h.client.handleEvent({kind:'turn.status',sequence:11,turn_id:'other-turn',state:'blocked',reason:'IDENTITY_NOT_READY'})
    await h.client.loadPanel('log')
    assert.equal(h.client.snapshot.activity.length,2)
    assert.equal(h.client.snapshot.activity[0].d,'blocked · IDENTITY_NOT_READY')
  }finally{h.client.stop()}
})

test('回忆展开只发定点GET，保持同轮引用和分页游标，不发送聊天',async()=>{
 const h=await setup(url=>url.includes('/memories')?Response.json({sections:{memory:{text:'全文'}},next_cursor:null}):undefined)
 try {
  h.calls.length=0
  await h.client.loadSurfacedMemories('turn-a')
  await h.client.loadSurfacedMemoryDetail('turn-a','sf_one','p1')
  assert.equal(h.calls.length,2)
  assert.ok(h.calls[0].url.endsWith('/conversations/primary/turns/turn-a/memories'))
  assert.ok(h.calls[1].url.endsWith('/conversations/primary/turns/turn-a/memories/sf_one?section=memory&cursor=p1'))
  assert.ok(h.calls.every(c=>!c.init?.method||c.init.method==='GET'))
 } finally {h.client.stop()}
})
