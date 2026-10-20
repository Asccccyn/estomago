import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EstomagoClient } from '../../apps/web/react/src/chat-client.ts'

type Json = Record<string, any>
const message = (sequence:number, revision=1, text=`synthetic-${sequence}`):Json => ({
  id:`m${sequence}`, conversation_id:'primary', sequence, speaker:sequence%2?'owner':'assistant',
  turn_id:`t${Math.ceil(sequence/2)}`, kind:'text', current_revision:revision,
  created_at:'2026-10-13T12:00:00Z', published_at:'2026-10-13T12:00:00Z',
  revision:{revision,content:text,content_hash:`synthetic-${sequence}-r${revision}`,occurred_at:'2026-10-13T12:00:00Z',attachments:[]},
})
const range = (from:number,to:number) => Array.from({length:Math.max(0,to-from+1)},(_,i)=>message(from+i))
const page = (messages:Json[],extra:Json={}) => ({messages,has_earlier:false,has_later:false,before_sequence:messages[0]?.sequence??null,after_sequence:messages.at(-1)?.sequence??null,timezone:'Asia/Shanghai',...extra})
const deferred = <T,>() => {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}}
const flush = async () => {for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve))}

async function setup(options:{initial?:Json;handler?:(url:URL,init?:RequestInit)=>Promise<Response>|Response|undefined}={}) {
  const calls:Array<{url:URL;init?:RequestInit}>=[]
  const sources:Array<{url:string;closed:boolean;onmessage:any;onopen:any;onerror:any;close:()=>void}>=[]
  const initial=options.initial??page(range(51,100),{has_earlier:true,event_cursor:900,active_turns:[],pending_route:null})
  const client=new EstomagoClient({fetch:async(input,init)=>{
    const url=new URL(String(input),'http://isolated.invalid');calls.push({url,init})
    const custom=options.handler?.(url,init);if(custom)return await custom
    if(url.pathname.endsWith('/messages'))return Response.json(initial)
    if(url.pathname.endsWith('/runtime-settings'))return Response.json({driver:'openrouter',or_model:{effective:'synthetic'},model_options:['synthetic'],effort_options:['default'],reasoning_effort:{effective:'default'}})
    if(url.pathname.endsWith('/context-records'))return Response.json({context:{},cache:{}})
    if(url.pathname.endsWith('/reasoning'))return Response.json({blocks:[]})
    if(url.pathname.endsWith('/usage'))return Response.json({totals:{}})
    return Response.json({})
  },eventSource:url=>{
    const source={url,closed:false,onmessage:null,onopen:null,onerror:null,close(){this.closed=true}}
    sources.push(source);return source as any
  },redirect:()=>{}})
  await client.start();await flush()
  return {client,calls,sources}
}
const visibleIds = (client:EstomagoClient) => client.snapshot.messages.filter(m=>!m.pending).map(m=>m.id)

test('首屏只取50条并从快照游标接续，旧事件不重放入历史或触发逐轮查询',async()=>{
  const h=await setup()
  try{
    const load=h.calls.find(c=>c.url.pathname.endsWith('/messages'))!
    assert.equal(load.url.searchParams.get('limit'),'50')
    assert.equal(load.url.searchParams.get('order'),'latest')
    assert.equal(load.url.searchParams.get('snapshot'),'1')
    assert.equal(visibleIds(h.client).length,50)
    assert.equal(new URL(h.sources[0]!.url,'http://isolated.invalid').searchParams.get('cursor'),'900')
    assert.equal(h.calls.filter(c=>/\/turns\/[^/]+\/(reasoning|usage)$/.test(c.url.pathname)).length,0)
    h.client.handleEvent({sequence:899,kind:'message.published',message:message(2)})
    h.client.handleEvent({sequence:901,kind:'message.published',message:message(101)})
    await flush()
    assert.equal(visibleIds(h.client).includes('m2'),false)
    assert.equal(visibleIds(h.client).includes('m101'),true,'快照之后的实时消息保留')
    assert.ok(h.calls.every(c=>!c.init?.method||c.init.method==='GET'))
  }finally{h.client.stop()}
})

test('跳过旧SSE仍恢复快照中的待答轮和路由确认',async()=>{
  const owner={...message(101),turn_id:'active-turn'}
  const pendingRoute={decision_id:'route-1',turn_id:'route-turn',current_model:null,target_model:'synthetic',evidence_code:'synthetic',already_switched:false}
  const h=await setup({initial:page([owner],{event_cursor:1000,active_turns:[{turn_id:'active-turn',attempt_id:'active-attempt',state:'running'}],pending_route:pendingRoute})})
  try{
    assert.ok(h.client.snapshot.messages.some(m=>m.pending&&m.turnId==='active-turn'))
    assert.equal(h.client.snapshot.route?.decision_id,'route-1')
    h.client.handleEvent({sequence:1001,kind:'turn.completed',turn_id:'active-turn',attempt_id:'active-attempt'})
    await flush()
    assert.equal(h.client.snapshot.messages.some(m=>m.pending&&m.turnId==='active-turn'),false)
  }finally{h.client.stop()}
})

test('更早页单飞，失败可重试，同一边界仅接受一次且使用服务器has_earlier',async()=>{
  let reads=0;const first=deferred<Response>()
  const h=await setup({handler:url=>{
    if(url.searchParams.has('before')){
      reads++
      assert.equal(url.searchParams.get('before'),'51')
      assert.equal(url.searchParams.get('limit'),'50')
      return reads===1?first.promise:Response.json(page(range(1,50),{has_earlier:false,has_later:true}))
    }
  }})
  try{
    const pending=h.client.loadEarlier();void h.client.loadEarlier();await flush()
    assert.equal(reads,1)
    first.resolve(Response.json({error:{message:'synthetic temporary error'}},{status:503}));await pending
    assert.equal(visibleIds(h.client).length,50)
    assert.equal(h.client.snapshot.hasEarlier,true)
    await h.client.loadEarlier();await flush()
    assert.equal(reads,2)
    assert.deepEqual(visibleIds(h.client),range(1,100).map(m=>m.id))
    assert.equal(h.client.snapshot.hasEarlier,false)
    await h.client.loadEarlier();assert.equal(reads,2)
  }finally{h.client.stop()}
})

test('日期无消息明确空日；有消息从锚点翻50条，可向前后继续且不重置SSE游标',async()=>{
  const h=await setup({handler:url=>{
    if(url.searchParams.get('date')==='2026-10-01')return Response.json(page([],{date:'2026-10-01',empty_date:true}))
    if(url.searchParams.get('date')==='2026-10-02')return Response.json(page(range(11,60),{date:'2026-10-02',has_earlier:true,has_later:true,event_cursor:900}))
    if(url.searchParams.get('after')==='60')return Response.json(page(range(61,80),{has_earlier:true,has_later:false}))
    if(url.searchParams.get('before')==='11')return Response.json(page(range(1,10),{has_earlier:false,has_later:true}))
  }})
  try{
    h.client.setDraft('synthetic unsent draft')
    await h.client.jumpToDate('2026-10-01');await flush()
    assert.deepEqual(visibleIds(h.client),[],'不偷偷跳到相邻日期')
    assert.equal(h.client.snapshot.historyDate,'2026-10-01')
    await h.client.jumpToDate('2026-10-02');await flush()
    assert.deepEqual(visibleIds(h.client),range(11,60).map(m=>m.id))
    assert.equal(h.client.snapshot.hasLater,true)
    assert.equal(h.sources.length,1,'日期分页不重连/重置实时事件游标')
    h.client.handleEvent({sequence:901,kind:'message.edited',message:message(20,2,'synthetic revised')})
    await flush()
    assert.equal(h.client.snapshot.messages.find(m=>m.id==='m20')?.text,'synthetic revised','日期页event_cursor不能吃掉真实事件')
    await h.client.loadLater();await h.client.loadEarlier();await flush()
    assert.deepEqual(visibleIds(h.client),range(1,80).map(m=>m.id))
    assert.equal(h.client.snapshot.draft,'synthetic unsent draft')
  }finally{h.client.stop()}
})

test('查看历史时新消息不挤入旧页，回到最新后用新快照完整恢复',async()=>{
  let latestReads=0
  const h=await setup({handler:url=>{
    if(url.searchParams.has('date'))return Response.json(page(range(1,50),{date:'2026-10-02',has_later:true}))
    if(url.searchParams.get('order')==='latest'&&++latestReads>1)return Response.json(page(range(53,102),{has_earlier:true,event_cursor:903,active_turns:[],pending_route:null}))
  }})
  try{
    await h.client.jumpToDate('2026-10-02')
    h.client.handleEvent({sequence:901,kind:'message.published',message:message(101)})
    h.client.handleEvent({sequence:902,kind:'message.published',message:message(102)})
    h.client.handleEvent({sequence:903,kind:'message.edited',message:message(20,2,'synthetic visible edit')})
    await flush()
    assert.equal(visibleIds(h.client).length,50)
    assert.equal(visibleIds(h.client).includes('m101'),false)
    assert.equal(h.client.snapshot.newMessages,true)
    assert.equal(h.client.snapshot.messages.find(m=>m.id==='m20')?.text,'synthetic visible edit')
    await h.client.returnToLatest();await flush()
    assert.deepEqual(visibleIds(h.client),range(53,102).map(m=>m.id))
    assert.equal(h.client.snapshot.newMessages,false)
    assert.equal(new URL(h.sources.at(-1)!.url,'http://isolated.invalid').searchParams.get('cursor'),'903')
    assert.equal(h.sources[0]!.closed,true)
  }finally{h.client.stop()}
})

test('慢日期页不能覆盖后来的日期跳转；翻页期间的实时修订不被旧页面回包覆盖',async()=>{
  const slowDate=deferred<Response>(),slowOlder=deferred<Response>()
  const h=await setup({handler:url=>{
    if(url.searchParams.get('date')==='2026-10-01')return slowDate.promise
    if(url.searchParams.get('date')==='2026-10-02')return Response.json(page(range(51,100),{date:'2026-10-02',has_earlier:true,has_later:true}))
    if(url.searchParams.get('before')==='51')return slowOlder.promise
  }})
  try{
    const old=h.client.jumpToDate('2026-10-01');await flush()
    await h.client.jumpToDate('2026-10-02');await flush()
    slowDate.resolve(Response.json(page(range(1,50),{date:'2026-10-01',has_later:true})));await old;await flush()
    assert.deepEqual(visibleIds(h.client),range(51,100).map(m=>m.id))
    assert.equal(h.client.snapshot.historyDate,'2026-10-02')
    const earlier=h.client.loadEarlier();await flush()
    h.client.handleEvent({sequence:901,kind:'message.edited',message:message(45,2,'synthetic newer revision')})
    slowOlder.resolve(Response.json(page(range(1,50),{has_earlier:false,has_later:true})));await earlier;await flush()
    assert.equal(h.client.snapshot.messages.find(m=>m.id==='m45')?.text,'synthetic newer revision')
  }finally{h.client.stop()}
})

test('旧模式的慢分页回包不能混入后来的日期页；思考详情按展开再查询',async()=>{
  const older=deferred<Response>()
  const h=await setup({handler:url=>{
    if(url.searchParams.has('before'))return older.promise
    if(url.searchParams.has('date'))return Response.json(page(range(151,200),{date:'2026-10-03',has_earlier:true,has_later:true,event_cursor:900}))
  }})
  try{
    const pending=h.client.loadEarlier();await flush()
    await h.client.jumpToDate('2026-10-03');await flush()
    older.resolve(Response.json(page(range(1,50),{has_earlier:false,has_later:true})));await pending;await flush()
    assert.deepEqual(visibleIds(h.client),range(151,200).map(m=>m.id))
    assert.equal(h.client.snapshot.historyDate,'2026-10-03')
    assert.equal(h.calls.filter(c=>/\/turns\/[^/]+\/(reasoning|usage)$/.test(c.url.pathname)).length,0)
    await h.client.loadTurnDetails('t76');await flush()
    assert.ok(h.calls.some(c=>c.url.pathname==='/api/v1/turns/t76/reasoning'))
    assert.ok(h.calls.some(c=>c.url.pathname==='/api/v1/turns/t76/usage'))
  }finally{h.client.stop()}
})

test('较晚返回的回复资格查询不能把旧最新消息插进日期页',async()=>{
  const reply=deferred<Response>()
  const h=await setup({handler:url=>{
    if(url.pathname.endsWith('/messages/m99'))return reply.promise
    if(url.searchParams.has('date'))return Response.json(page(range(1,50),{date:'2026-10-02',has_later:true,event_cursor:901,active_turns:[],pending_route:null}))
  }})
  try{
    h.client.handleEvent({sequence:901,kind:'turn.status',turn_id:'t50',attempt_id:'a50',state:'failed',reason:'synthetic'})
    await flush()
    assert.ok(h.calls.some(c=>c.url.pathname.endsWith('/messages/m99')))
    await h.client.jumpToDate('2026-10-02');await flush()
    reply.resolve(Response.json({message:message(99,2,'synthetic stale view response')}));await flush()
    assert.deepEqual(visibleIds(h.client),range(1,50).map(m=>m.id))
  }finally{h.client.stop()}
})

test('日期消息快照不应丢弃其中未包含的告警状态变更',async()=>{
  const date=deferred<Response>();let openAlerts=0
  const h=await setup({handler:url=>{
    if(url.searchParams.has('date'))return date.promise
    if(url.pathname.endsWith('/system-alerts/summary'))return Response.json({open_count:openAlerts,unread_anomaly_count:openAlerts})
  }})
  try{
    const jump=h.client.jumpToDate('2026-10-02');await flush()
    openAlerts=3
    h.client.handleEvent({sequence:901,kind:'system.alert.changed'})
    date.resolve(Response.json(page(range(1,50),{date:'2026-10-02',has_later:true,event_cursor:905,active_turns:[],pending_route:null})))
    await jump;await flush()
    assert.equal(h.client.snapshot.openAlerts,3,'消息快照未包含告警，必须应用通知或重读告警快照')
  }finally{h.client.stop()}
})

test('更早页期间收到的实时消息，在回最新快照失败后仍保留且不被游标跳过',async()=>{
  const older=deferred<Response>();let latestReads=0
  const h=await setup({handler:url=>{
    if(url.searchParams.has('before'))return older.promise
    if(url.searchParams.get('order')==='latest'&&++latestReads>1)return Response.json({error:{message:'synthetic latest snapshot failed'}},{status:503})
  }})
  try{
    const paging=h.client.loadEarlier();await flush()
    h.client.handleEvent({sequence:901,kind:'message.published',message:message(101)})
    await flush()
    assert.equal(visibleIds(h.client).includes('m101'),false,'翻页时事件尚在缓冲区')
    assert.equal(await h.client.returnToLatest(),false);await flush()
    assert.equal(visibleIds(h.client).includes('m101'),true,'失败的快照不能丢掉已经推进游标的缓冲事件')
    assert.equal(h.sources.length,2)
    assert.equal(h.sources[0]!.closed,true)
    assert.equal(new URL(h.sources[1]!.url,'http://isolated.invalid').searchParams.get('cursor'),'901')
    older.resolve(Response.json(page(range(1,50),{has_earlier:false,has_later:true})));await paging;await flush()
    assert.deepEqual(visibleIds(h.client),range(51,101).map(m=>m.id),'旧翻页回包不能覆盖已恢复的当前视图')
    h.client.handleEvent({sequence:901,kind:'message.published',message:message(101)})
    h.client.handleEvent({sequence:902,kind:'message.published',message:message(102)})
    await flush()
    assert.deepEqual(visibleIds(h.client),range(51,102).map(m=>m.id),'重连后的去重与新消息仍连续')
  }finally{h.client.stop()}
})
