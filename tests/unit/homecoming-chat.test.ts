import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EstomagoClient } from '../../apps/web/react/src/chat-client.ts'

const ok=(data:unknown)=>Response.json(data)
const session='/api/v1/auth/session', history='/api/v1/conversations/primary/messages?limit=500&order=latest'
function harness(override:(url:string,init?:RequestInit)=>Promise<Response>|Response|undefined=()=>undefined){
  const requests:Array<{url:string;init?:RequestInit}>=[],sources:any[]=[]
  let redirects=0
  const client=new EstomagoClient({fetch:async(url,init)=>{
    const key=String(url);requests.push({url:key,init})
    const response=override(key,init);if(response)return await response
    if(key===session)return ok({authenticated:true})
    if(key===history)return ok({messages:[]})
    if(key.endsWith('/runtime-settings'))return ok({driver:'openrouter',or_model:{effective:'fixture-model'},model_options:['fixture-model'],effort_options:['low','high'],reasoning_effort:{effective:'high'}})
    if(key.endsWith('/context-records'))return ok({driver:'openrouter',exactModel:'fixture-model',context:{estimatedInput:0,hardCapacity:null},cache:{lastRead:null}})
    if(key.endsWith('/system-alerts/summary'))return ok({unread_anomaly_count:0})
    return ok({})
  },eventSource:(url)=>{const source={url,onmessage:null,onerror:null,closed:false,close(){this.closed=true}};sources.push(source);return source as any},redirect:()=>{redirects++}})
  return {client,requests,sources,get redirects(){return redirects}}
}
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve()}
test('实际入口是 React root 与组件源码，空服务端历史不生成演示消息',async()=>{
  const h=harness()
  try{
    const html=fs.readFileSync(path.resolve('apps/web/react/index.html'),'utf8')
    assert.match(html,/id="root"/);assert.match(html,/src\/main.tsx/);assert.doesNotMatch(html,/id="timeline"/)
    await h.client.start();assert.equal(h.client.snapshot.ready,true);assert.equal(h.client.snapshot.messages.length,0)
    assert.equal(h.client.snapshot.models[0],'fixture-model');assert.equal(h.sources.length,1)
    assert.equal(h.requests.some(r=>r.url.endsWith('/messages')&&r.init?.method==='POST'),false)
  }finally{h.client.stop()}
})
test('并发启动只恢复一次会话；失败可重试并保留草稿',async()=>{
  let release!:(r:Response)=>void;let first=true
  const h=harness(url=>url===session&&first?(first=false,new Promise(r=>release=r)):undefined)
  try{
    h.client.setDraft('保留的草稿')
    const boot=h.client.start();await h.client.start()
    assert.equal(h.requests.filter(r=>r.url===session).length,1)
    release(new Response('{}',{status:503}));await boot
    assert.equal(h.client.snapshot.ready,false);assert.equal(h.client.snapshot.draft,'保留的草稿')
    await h.client.start();assert.equal(h.client.snapshot.ready,true);assert.equal(h.sources.length,1)
    await h.client.start();assert.equal(h.sources.length,1)
  }finally{h.client.stop()}
})
test('会话、消息、模型或上下文401只跳转一次并关闭SSE',async()=>{
  for(const endpoint of [session,history,'/api/v1/runtime-settings','/api/v1/conversations/primary/context-records']){
    const h=harness(url=>url===endpoint?new Response('{}',{status:401}):undefined)
    try{await h.client.start();await flush();await h.client.start();assert.equal(h.redirects,1);assert.equal(h.client.snapshot.ready,false);assert.ok(h.sources.every(s=>s.closed))}finally{h.client.stop()}
  }
})
test('网络故障不冒充会话失效，原SSE负责重连；明确401才退出',async()=>{
  let phase='boot'
  const h=harness(url=>url===session&&phase!=='boot'?phase==='network'?Promise.reject(new Error('offline')):new Response('{}',{status:401}):undefined)
  try{
    await h.client.start();const source=h.sources[0];phase='network';source.onerror();await flush();assert.equal(h.redirects,0);assert.equal(source.closed,false)
    phase='expired';source.onerror();source.onerror();await flush();assert.equal(h.redirects,1);assert.equal(source.closed,true)
    source.onerror();await flush();assert.equal(h.redirects,1)
  }finally{h.client.stop()}
})
test('卸载关闭连接，迟到的旧连接事件不能改写新状态',async()=>{
  const h=harness()
  try{await h.client.start();const old=h.sources[0];h.client.stop();assert.equal(old.closed,true);await h.client.start()
    old.onmessage({data:JSON.stringify({kind:'message.persisted',sequence:9,message:{id:'late',sequence:1,speaker:'owner',revision:{revision:1,content:'旧连接',occurred_at:new Date().toISOString()}}})})
    assert.equal(h.client.snapshot.messages.length,0)
  }finally{h.client.stop()}
})
