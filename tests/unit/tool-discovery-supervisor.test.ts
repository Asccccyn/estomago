// 自动浮现 · supervisor 接缝与缓存边界（EST_MARIPOSA_AUTO_SURFACING_V1）。
// 核心见证 6（真实缓存）：U1 wire 在旧历史之后追加一次；U2 不删移旧包、
// 不再重复追加；失败不假标 coverage。OR/DS 信封面=独立 host-origin text
// block 置于真实 user_input block 之前（docs/04）。
import { test } from 'node:test';
import { assertAppendOnly } from '../../apps/host/src/runtime/or-payload.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
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
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));
const T0 = '2026-10-19T09:00:00+08:00';
const NOTICE = '这是你的回忆，是你和宿主用户过去发生的事，不是现在正在发生的事。';

function bootPack(): Record<string, unknown> {
  return { snapshot_id: 'snap_t1', state_hash: 'h1', profile: 'estomago', memory_days: { items: [], count: 0 }, plans: { items: [], count: 0 }, i: { content: '', note: '' } };
}

const ITEM = {
  event_id: 'ev_1', memory_id: '00001', memory_version: '1',
 memory_date: '2026-07-09',
  date_confidence: 'exact', event_text: '7月9日我们把记忆库建成了',
  body_hash: 'b'.repeat(64), detail_ref: 'sdr_seam1',
};

function compose(root: string, transport: OrTransport, mariposa: MariposaTransport, log: Array<Record<string, unknown>>, provider: 'deepseek'|'openrouter') {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider, tool_schema_mode: 'deferred' }, deepseek: { model: 'deepseek-chat' }, openrouter: { model: 'anthropic/claude-test-1' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const svc = new SurfacingService(db, new MariposaClient({ transport: mariposa }), {
    enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v1',
    delivery_deadline_ms: 2000, max_added_tokens_per_turn: 4096,
    max_packet_bytes: 24576, worker_concurrency: 2,
  }, null);
  const messages = new MessageService(db, svc);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), surfaceDetailClient: new MariposaClient({ transport: mariposa }), reviews, checkpoint });
  const trajectory = new WindowTrajectoryService(db);
  const wrapped: OrTransport = async (payload) => {
    log.push({ kind: 'chat', full: payload.messages, tools: payload.tools?.map((t: { function: { name: string } }) => t.function.name) ?? [] });
    return transport(payload);
  };
  const runner = provider==='deepseek' ? new DeepSeekRunner({ retryMax: 0 }, wrapped) : new OpenRouterRunner({providerOnly:['anthropic'],allowFallbacks:false,requireParameters:true,retryMax:0},wrapped);
  const supervisor = new TurnSupervisor({
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events),
    usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')),
    tools, reviews, checkpoint, trajectory, surfacing: svc,
  });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, svc };
}

type Block = { type: string; text?: string };
const toBlocks = (c: unknown): Block[] => (Array.isArray(c) ? (c as Block[]) : typeof c === 'string' ? [{ type: 'text', text: c }] : []);

for(const provider of ['deepseek','openrouter'] as const) test(provider+': deferred discovery→definition→invocation preserves tools prefix',async()=>{
 const root=tempRoot('deferred-wire-');const log:Array<Record<string,unknown>>=[];let n=0;let holds=0;
 const args={original_title:'合成记忆',categories:['daily'],text:'完整原文',creation_mode:'contemporaneous',date_confidence:'exact'};
 const call=(name:string,args:unknown)=>sse({id:'g'+n,choices:[{delta:{tool_calls:[{index:0,id:'call'+n,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]})+sse({choices:[{delta:{},finish_reason:'tool_calls'}]})+DONE;
 const transport:OrTransport=async payload=>{
  n++;assert.deepEqual((payload.tools as any[]).map(t=>t.function.name),['tool_catalog','tool_define','tool_invoke']);
  let body:string;
  if(n===1)body=call('tool_catalog',{});
  else if(n===2){const catalog=JSON.parse((payload.messages.at(-1) as any).content);assert.ok(!JSON.stringify(catalog).includes('parameters'));body=call('tool_define',{name:'memory_hold'});}
  else if(n===3){const definition=JSON.parse((payload.messages.at(-1) as any).content);assert.equal(definition.name,'memory_hold');body=call('tool_invoke',{name:'memory_hold',definition_id:definition.definition_id,arguments:args});}
  else {if(n===4)assert.deepEqual(JSON.parse((payload.messages.at(-1) as any).content),{saved:true,memory_id:'m1',source_status:'unbound'});/*R1′(1023):60c6998 无 source_ranges 时如实 source_status:'unbound'*/body=textBody('g'+n,'回复');}
  return {status:200,headers:new Map(),body:frameStream(body)};
 };
 const mariposa:MariposaTransport=async(cap,payload)=>{
  if(cap==='bootstrap.get')return {ok:true,result:bootPack()};
  if(cap==='memory.hold'){holds++;return {ok:true,result:{operation_id:payload.operation_id,memory_id:'m1',version:1,binding_ids:[],committed_at:'2026-10-21T12:00:00Z'}};}
  throw Error('unexpected '+cap);
 };
 const ctx=compose(root,transport,mariposa,log,provider);
 try {
  const a=ctx.messages.submitUserMessageWithTurn({conversationId:'c1',content:'合成测试输入',clientMessageId:'one'});ctx.supervisor.enqueue(a.turnId);await ctx.supervisor.waitIdle();
  assert.equal(holds,1);assert.equal(n,4);
  const before=log[3].full as any[];
  const b=ctx.messages.submitUserMessageWithTurn({conversationId:'c1',content:'第二条合成输入',clientMessageId:'two'});ctx.supervisor.enqueue(b.turnId);await ctx.supervisor.waitIdle();
  assert.equal(assertAppendOnly({messages:before},{messages:log[4].full}),true);
  assert.equal(holds,1);assert.equal(n,5);
 }finally{await ctx.svc.stop();ctx.db.close();}
});
