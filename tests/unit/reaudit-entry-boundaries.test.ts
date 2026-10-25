import fs from 'node:fs';
import {createServer} from 'node:http';
import {AuthService} from '../../apps/host/src/auth/tokens.ts';
import {handleRequest} from '../../apps/host/src/server/http.ts';
// R4（2026-10-23）：voice ingress——Siren CoreBridge 同窗电话入口。
// 合同逐字段对齐 http-core-bridge.ts：POST /v1/chat/stream NDJSON 流（delta*/done|error）。
// 同窗=supervisor.enqueue 共用串行链/工具/轨迹；断开=stop 同管线；token 未配=503 fail-closed。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { handleVoiceChatStream } from '../../apps/host/src/server/http.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));

class FakeRes extends Writable {
  status = 0;
  headers: Record<string, string> = {};
  lines: string[] = [];
  buffer = '';
  _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.lines.push(line);
    }
    cb();
  }
  writeHead(code: number, headers: Record<string, string>): void { this.status = code; this.headers = headers; }
  override write = ((chunk: unknown) => { this._write(Buffer.from(String(chunk)), 'utf8', () => {}); return true; }) as Writable['write'];
}

function compose(root: string, transport: OrTransport) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) })
  wireOidoCapabilitiesForTest(tools, {  });;
  const trajectory = new WindowTrajectoryService(db);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner: new DeepSeekRunner({ retryMax: 0 }, transport) }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory });
  const auth=new AuthService(paths);const logger=new Logger(path.join(root,'logs'));
  return {root,db,config,messages,events,supervisor,auth,paths,tools,deps:{config,db,events,messages,supervisor,auth,paths,logger} as never,close(){db.close();fs.rmSync(root,{recursive:true,force:true});}};
}

const REQ = (obj: unknown, headers: Record<string, string> = {}): never => {
  const r = Readable.from([Buffer.from(JSON.stringify(obj), 'utf8')]) as Readable & { headers?: Record<string, string> };
  r.headers = headers;
  return r as never;
};
const withHeaders = (r: never, h: Record<string, string>): never => { ((r as unknown as { headers?: Record<string, string> }).headers) = h; return r; };


const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const normalTransport:OrTransport=async()=>({status:200,headers:new Map(),body:frameStream(sse({id:'synthetic',choices:[{delta:{content:'合成回答。'}}]})+sse({choices:[{delta:{},finish_reason:'stop'}]})+DONE)});
async function helperRound(ctx:ReturnType<typeof compose>, input:any){
 process.env.ESTOMAGO_VOICE_INGRESS_TOKEN='audit-voice';
 const req=REQ(input,{authorization:'Bearer audit-voice'}) as any;const res=new FakeRes();
 await handleVoiceChatStream(req,res as never,ctx.deps);
 return {req,res,close(){req.emit('close');}};
}

test('REV-E01 real router accepts the dedicated ingress token without owner credential',async()=>{
 const ctx=compose(tempRoot('reaudit-entry-auth-'),normalTransport);process.env.ESTOMAGO_VOICE_INGRESS_TOKEN='audit-voice';
 const server=createServer((req,res)=>void handleRequest(req,res,ctx.deps));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const port=(server.address() as any).port;const response=await fetch(`http://127.0.0.1:${port}/v1/chat/stream`,{method:'POST',headers:{Authorization:'Bearer audit-voice','Content-Type':'application/x-ndjson'},body:JSON.stringify({conversation_id:'c1',call_id:'synthetic-call',turn_id:'1',modality:'voice',text:'合成语音'}),signal:AbortSignal.timeout(1000)});const body=await response.text();console.log('AUTH_ROUTE',response.status,body);assert.equal(response.status,200,'dedicated token must reach its dedicated endpoint');}
 finally{delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await ctx.supervisor.stopAll();ctx.close();}
});

test('REV-E02 NDJSON deltas concatenate exactly to the one canonical published answer',async()=>{
 const transport:OrTransport=async()=>({status:200,headers:new Map(),body:(async function*(){yield enc.encode(sse({id:'synth-paragraphs',choices:[{delta:{content:'第一段。\n\n'}}]}));await pause(80);yield enc.encode(sse({id:'synth-paragraphs',choices:[{delta:{content:'第二段。'}}]}));yield enc.encode(sse({choices:[{delta:{},finish_reason:'stop'}]})+DONE);})()});
 const ctx=compose(tempRoot('reaudit-entry-delta-'),transport);let call:any;
 try{call=await helperRound(ctx,{conversation_id:'c1',call_id:'synthetic-call',turn_id:'2',modality:'voice',text:'合成输入'});await ctx.supervisor.waitIdle();await pause(80);const frames=call.res.lines.map((l:string)=>JSON.parse(l));const got=frames.filter((f:any)=>f.type==='delta').map((f:any)=>f.text).join('');const expected=(ctx.db.prepare("SELECT r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.speaker='assistant' ORDER BY m.sequence DESC LIMIT 1").get() as any).content;console.log('CANONICAL_VS_WIRE',JSON.stringify({expected,got,frames}));assert.equal(got,expected);}
 finally{call?.close();delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;await ctx.supervisor.stopAll();ctx.close();}
});

test('REV-E03 queued phone request cancelled before admission must never dispatch',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let calls=0;
 const ctx=compose(tempRoot('reaudit-entry-queue-'),async(p,s)=>{calls++;if(calls===1)await gate;return normalTransport(p,s);});let call:any;
 try{const first=ctx.messages.submitUserMessageWithTurn({conversationId:'c1',content:'先来的文字轮',clientMessageId:'first'});ctx.supervisor.enqueue(first.turnId);while(calls===0)await pause(5);call=await helperRound(ctx,{conversation_id:'c1',call_id:'synthetic-call',turn_id:'queued',modality:'voice',text:'排队后已挂断的合成输入'});call.close();release();await ctx.supervisor.waitIdle();console.log('QUEUED_CANCEL',JSON.stringify({provider_calls:calls,turns:ctx.db.prepare('SELECT state FROM turns ORDER BY created_at').all()}));assert.equal(calls,1,'disconnected queued voice turn dispatched after first turn');}
 finally{release();call?.close();delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;await ctx.supervisor.stopAll();ctx.close();}
});

test('REV-E04 a completed idempotent phone retry returns its terminal receipt',async()=>{
 const ctx=compose(tempRoot('reaudit-entry-repeat-'),normalTransport);let one:any,two:any;const input={conversation_id:'c1',call_id:'synthetic-call',turn_id:'replay',modality:'voice',text:'同一条合成输入'};
 try{one=await helperRound(ctx,input);await ctx.supervisor.waitIdle();await pause(80);two=await helperRound(ctx,input);await ctx.supervisor.waitIdle();await pause(100);console.log('REPLAY_FRAMES',JSON.stringify({first:one.res.lines,second:two.res.lines}));assert.ok(two.res.lines.some((l:string)=>l.includes('"done"')||l.includes('"error"')),'retry has no terminal frame and remains subscribed');}
 finally{one?.close();two?.close();delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;await ctx.supervisor.stopAll();ctx.close();}
});

test('REV-E05 a meaningful phrase reaches CoreBridge before the model finishes',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let emitted=false;
 const ctx=compose(tempRoot('reaudit-entry-first-'),async()=>({status:200,headers:new Map(),body:(async function*(){yield enc.encode(sse({id:'synthetic-stream',choices:[{delta:{content:'这是已经生成的完整短句。'}}]}));emitted=true;await gate;yield enc.encode(sse({choices:[{delta:{},finish_reason:'stop'}]})+DONE);})()}));let call:any;
 try{call=await helperRound(ctx,{conversation_id:'c1',call_id:'synthetic-call',turn_id:'stream',modality:'voice',text:'合成输入'});while(!emitted)await pause(5);await pause(80);const before=call.res.lines.filter((l:string)=>l.includes('"delta"'));release();await ctx.supervisor.waitIdle();await pause(80);console.log('PHRASE_WHILE_MODEL_ACTIVE',JSON.stringify({before_finish:before,after_finish:call.res.lines}));assert.ok(before.length>0,'single-paragraph reply withheld until full model completion');}
 finally{release();call?.close();delete process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;await ctx.supervisor.stopAll();ctx.close();}
});
