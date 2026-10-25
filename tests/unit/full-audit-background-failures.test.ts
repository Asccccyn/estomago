import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import { MessageRetryService } from '../../apps/host/src/messages/retry.ts';
// ESTOMAGO_CHAT_EXEC_V1 · WP4 收尾 + WAKE_KEEPWARM_V1（2026-10-22 改写）：
// 后台模型回路执行器整链（04/05/06 §2/§4；K-01/K-12/K-13、C-01/C-02/C-07、B-01/B-10 面）。
// 2026-10-22 改写：保温零工具封锁（CW-13）与 128 输出封锁退役——心跳=完整回合；
// PURE_ACK/SUBSTANTIVE 分流；心跳维护回执经活动投影 CAS；执行走会话串行链。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex, genId } from '../../apps/host/src/util/id.ts';
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
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

function compose(root: string, transport: OrTransport, nowRef: { nowMs: number }, sleepEnabled = false, retryMax = 0) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: MODEL }, background: { keepwarm: { sleep_window: { enabled: sleepEnabled } } } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(null);
  const events = new EventService(db);
  const activity = new ConversationActivityService(db);
  const messages = new MessageService(db, null, activity);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const alerts = new SystemAlertService(db, events);
  const media = new MediaService(db, paths.mediaDir, config);
  const trajectory = new WindowTrajectoryService(db);
  const selections = new ManualSelectionService(db);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax }, transport);
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), archiveSync: null, media, messages, events });
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db, alerts), routing, windows, logger, alerts, media, trajectory, selections, tools, activity, now: () => nowRef.nowMs });
  messages.ensureConversation('c1');
  const bgSettings = new BackgroundSettingsService(db, config);
  return { root, db, config, messages, supervisor, alerts, media, tools, bgSettings, trajectory, windows, activity, events };
}

const chatBody = (text: string) => sse({ id: `gen-${text.length}`, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 500 }, cost: 0.002 } }) + DONE;

const toolCallBody = (calls: Array<{ id: string; name: string; args: string }>, usage = { prompt_tokens: 500, completion_tokens: 10, cost: 0.001 }) =>
  sse({ id: `gen-tc-${calls[0]!.id}`, choices: [{ delta: { tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } }] })
  + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + DONE;

/** 将真实本地测试轨迹的活动/缓存证据对齐到虚拟睡前时间；无网络。 */
function readySleepBoundaryRun(ctx: ReturnType<typeof compose>, nowRef: { nowMs: number }) {
  setPrice(ctx.db);
  ctx.bgSettings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1 } });
  const iso = new Date(nowRef.nowMs).toISOString();
  const before = new Date(nowRef.nowMs - 3_000_001).toISOString();
  ctx.db.prepare("UPDATE conversation_activity SET last_real_activity_at = ?, maintenance_request_id = NULL WHERE conversation_id = 'c1'").run(before);
  // 当前唯一请求是 seed chat。
  ctx.db.prepare('UPDATE provider_requests SET dispatch_started_at = ?').run(before);
  ctx.db.prepare("INSERT INTO background_tasks(id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,next_due_at,timezone,payload_json,created_by_actor_id,origin,created_at,updated_at) VALUES ('sleep-task','c1','jiaming','keepwarm',1,1,'cache_idle',?,'Asia/Shanghai','{}','system','system_keepwarm',?,?)").run(iso, iso, iso);
  ctx.db.prepare("INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at) VALUES ('sleep-run','sleep-task','c1','jiaming','keepwarm',1,'sleep-boundary','running',?,?)").run(iso, iso);
  const scheduler = wireExecutor(ctx, nowRef);
  const run = () => ctx.supervisor.runBackgroundTurn({ kind: 'keepwarm', runId: 'sleep-run', conversationId: 'c1', payload: {}, isCancelRequested: () => false, registerAbort: () => {}, maxModelRequests: 4, recordDispatch: (info) => scheduler.recordDispatchStart({ runId: 'sleep-run', ...info, capabilityName: null }) });
  return { scheduler, run };
}

function setPrice(db: ReturnType<typeof openDatabase>, inputMicroPerToken = 0.000003, outputMicroPerToken = 0.000015): void {
  db.prepare("INSERT INTO runtime_settings(key, value, updated_at) VALUES ('or_model_price', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(JSON.stringify({ input_micro_per_token: inputMicroPerToken, output_micro_per_token: outputMicroPerToken }), new Date().toISOString());
}

/** 跑一次真实聊天回合建立窗口+轨迹+缓存证据（L=真实发布时刻）。 */
async function seedChatTurn(ctx: ReturnType<typeof compose>, cmid: string): Promise<string> {
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `消息-${cmid}`, clientMessageId: cmid });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal((ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string }).state, 'completed', '聊天回合完成');
  return t.turnId;
}

/** 复刻 app-context 的执行器接线（串行链+价格门+开关重查）。 */
function wireExecutor(ctx: ReturnType<typeof compose>, nowRef: { nowMs: number }): BackgroundScheduler {
  const sched: BackgroundScheduler = new BackgroundScheduler({ db: ctx.db, config: ctx.config, settings: ctx.bgSettings, alerts: ctx.alerts, now: () => nowRef.nowMs,
    executor: {
      async executeRun(input) {
        if (input.kind === 'reminder') return { outcome: 'completed' as const, result_code: 'delivered' };
        const priceRow = ctx.db.prepare("SELECT value FROM runtime_settings WHERE key = 'or_model_price'").get() as { value: string } | undefined;
        const price = priceRow ? JSON.parse(priceRow.value) as { input_micro_per_token?: number; output_micro_per_token?: number } : null;
        if (!price || typeof price.input_micro_per_token !== 'number' || typeof price.output_micro_per_token !== 'number') {
          return { outcome: 'failed' as const, result_code: 'BUDGET_ESTIMATE_UNAVAILABLE' };
        }
        const es = ctx.bgSettings.effective();
        if (es[input.kind].enabled !== true) return { outcome: 'noop' as const, result_code: input.kind === 'keepwarm' ? 'KEEPWARM_DISABLED' : 'AUTONOMOUS_DISABLED' };
        if (es[input.kind].daily_cost_cap_usd === null) return { outcome: 'failed' as const, result_code: 'BACKGROUND_BUDGET_NOT_CONFIGURED' };
        return ctx.supervisor.enqueueBackground(input.conversationId, () => ctx.supervisor.runBackgroundTurn({
          kind: input.kind as 'autonomous' | 'keepwarm',
          runId: input.runId, conversationId: input.conversationId, payload: input.payload,
          isCancelRequested: input.isCancelRequested, registerAbort: input.registerAbort,
          recordDispatch: (info) => sched.recordDispatchStart({ runId: input.runId, logicalActionKey: info.logicalActionKey, attemptNo: info.attemptNo, dispatchKind: info.dispatchKind, capabilityName: null, reservedCostMicroUsd: info.reservedCostMicroUsd }),
          maxModelRequests: es.autonomous.max_model_requests_per_run,
        }));
      },
    } });
  return sched;
}

const response = (body: string) => ({status:200,headers:new Headers(),body:Readable.from([enc.encode(body)])});
function cleanup(t:any,ctx:ReturnType<typeof compose>){t.after(async()=>{await ctx.supervisor.stopAll();ctx.db.close();fs.rmSync(ctx.root,{recursive:true,force:true});});}


function completeProtocol(messages:any[]){
 for(let i=0;i<messages.length;i++){
  const calls=messages[i]?.tool_calls;
  if(!Array.isArray(calls)||!calls.length)continue;
  const answers=[];for(let j=i+1;j<messages.length&&messages[j].role==='tool';j++)answers.push(messages[j].tool_call_id);
  assert.deepEqual([...answers].sort(),calls.map((c:any)=>c.id).sort(),'every observed tool call has exactly one explicit result');
 }
}

test('FA-F01 zero-dispatch budget refusal never appends an unseen host event to canonical history',async t=>{
 let calls=0;const now={nowMs:Date.now()};const ctx=compose(tempRoot('fa-zero-dispatch-'),async p=>{if(JSON.stringify(p).includes('Cache keepalive'))calls++;return response(chatBody('seed'));},now);cleanup(t,ctx);
 await seedChatTurn(ctx,'base');const before=ctx.trajectory.forWindow(ctx.windows.activeWindow('c1')!.id)!.messages;const{run}=readySleepBoundaryRun(ctx,now);
 ctx.bgSettings.applyUpdate({expectedRevision:1,patch:{keepwarm_daily_cost_cap_usd:0.0000001}});
 const result=await ctx.supervisor.enqueueBackground('c1',run);
 assert.equal(result.result_code,'BACKGROUND_BUDGET_EXHAUSTED');assert.equal(calls,0);
 assert.deepEqual(ctx.trajectory.forWindow(ctx.windows.activeWindow('c1')!.id)!.messages,before);
 assert.equal((ctx.db.prepare("SELECT trajectory_committed_at FROM background_runs WHERE id='sleep-run'").get()as any).trajectory_committed_at,null);
});

test('FA-F02 next-round capacity refusal preserves a prior formal publication and complete tool protocol',async t=>{
 let background=true,n=0;const now={nowMs:Date.now()};const published='large-publication-'.repeat(300);const payloads:any[]=[];
 const ctx=compose(tempRoot('fa-capacity-protocol-'),async p=>{payloads.push(structuredClone(p));if(background&&JSON.stringify(p).includes('Cache keepalive')){n++;return response(toolCallBody([{id:'large-send',name:'chat_send_text',args:JSON.stringify({text:published,idempotency_key:'large'})}]));}return response(chatBody('seed'));},now);cleanup(t,ctx);
 await seedChatTurn(ctx,'base');const{run}=readySleepBoundaryRun(ctx,now);const win=ctx.windows.activeWindow('c1')!.id;const before=ctx.trajectory.forWindow(win)!;
 const tail={role:'user',content:[{type:'text',text:'Cache keepalive (host event, not Qiaosheng). Reply 1 by default; you may choose otherwise and use available tools.'}]};
 ctx.config.windows.tool_input_reserve_tokens=0;ctx.config.windows.review_reserve_tokens=0;ctx.config.windows.safety_reserve_tokens=0;
 ctx.config.windows.model_context_capacity=Math.ceil(JSON.stringify({messages:[...before.messages,tail],tools:(ctx.supervisor as any).windowTools(win)}).length/2.5)+ctx.config.openrouter.max_output_tokens+200;
 const result=await ctx.supervisor.enqueueBackground('c1',run);assert.equal(result.result_code,'CAPACITY_BLOCKED_HARD_TOOL_ROUND');assert.equal(n,1);
 const tr=ctx.trajectory.forWindow(win)!;completeProtocol(tr.messages);assert.ok(JSON.stringify(tr.messages).includes(published));
 assert.ok((ctx.db.prepare("SELECT trajectory_committed_at FROM background_runs WHERE id='sleep-run'").get()as any).trajectory_committed_at);
 ctx.config.windows.model_context_capacity=null;background=false;await seedChatTurn(ctx,'after');assert.ok(JSON.stringify(payloads.at(-1)).includes(published));
});

test('FA-F03 known same-key content conflict becomes a paired tool error and does not strand the turn',async t=>{
 let n=0;const now={nowMs:Date.now()};const ctx=compose(tempRoot('fa-known-conflict-'),async p=>{
  if(JSON.stringify(p).includes('Cache keepalive')&&++n===1)return response(toolCallBody([{id:'one',name:'chat_send_text',args:JSON.stringify({text:'original publication',idempotency_key:'same'})},{id:'conflict',name:'chat_send_text',args:JSON.stringify({text:'different publication',idempotency_key:'same'})}]));return response(chatBody(n?'1':'seed'));
 },now);cleanup(t,ctx);
 await seedChatTurn(ctx,'base');const{run}=readySleepBoundaryRun(ctx,now);const result=await ctx.supervisor.enqueueBackground('c1',run);assert.equal(result.outcome,'completed');
 const bg=ctx.db.prepare("SELECT * FROM background_runs WHERE id='sleep-run'").get()as any;assert.equal(bg.published_message_count,1);assert.ok(bg.trajectory_committed_at);
 assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE turn_id=?').get(bg.turn_id)as any).state,'completed');
 const tr=ctx.trajectory.forWindow(ctx.windows.activeWindow('c1')!.id)!;completeProtocol(tr.messages);
 const conflict=tr.messages.find((m:any)=>m.role==='tool'&&m.tool_call_id==='conflict')as any;assert.equal(JSON.parse(conflict.content).error_code,'IDEMPOTENCY_CONFLICT');
});

test('FA-F04 attempted tool exception is unknown; later tools are explicitly unexecuted and publication survives',async t=>{
 const now={nowMs:Date.now()};let invoked=0;const ctx=compose(tempRoot('fa-unknown-tool-'),async p=>JSON.stringify(p).includes('Cache keepalive')?response(toolCallBody([{id:'unknown-send',name:'chat_send_text',args:JSON.stringify({text:'saved before lost result',idempotency_key:'unknown'})},{id:'not-started',name:'tool_catalog',args:'{}'}])):response(chatBody('seed')),now);cleanup(t,ctx);
 await seedChatTurn(ctx,'base');const execute=ctx.tools.execute.bind(ctx.tools);ctx.tools.execute=async(name,args,context)=>{invoked++;const result=await execute(name,args,context);if(name==='chat_send_text')throw new Error('synthetic receipt loss after real local publication');return result;};
 const{run}=readySleepBoundaryRun(ctx,now);const result=await ctx.supervisor.enqueueBackground('c1',run);assert.equal(result.outcome,'unknown');assert.equal(result.result_code,'TOOL_EXECUTION_OUTCOME_UNKNOWN');assert.equal(invoked,1);
 const bg=ctx.db.prepare("SELECT * FROM background_runs WHERE id='sleep-run'").get()as any;assert.equal(bg.published_message_count,1);assert.ok(bg.trajectory_committed_at);
 const tr=ctx.trajectory.forWindow(ctx.windows.activeWindow('c1')!.id)!;completeProtocol(tr.messages);
 const unknown=JSON.parse((tr.messages.find((m:any)=>m.role==='tool'&&m.tool_call_id==='unknown-send')as any).content);assert.equal(unknown.outcome,'unknown');assert.equal('executed'in unknown,false);
 const skipped=JSON.parse((tr.messages.find((m:any)=>m.role==='tool'&&m.tool_call_id==='not-started')as any).content);assert.equal(skipped.executed,false);
 assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE turn_id=?').get(bg.turn_id)as any).state,'failed');
});

for(const extraDrift of [false,true])test(`FA-F05 legacy DS stripped reasoning is ${extraDrift?'still strict for unrelated drift':'a specific zero-dispatch manual-window requirement'}`,async t=>{
 let n=0;const transport:OrTransport=async()=>{n++;const delta=n===1?{reasoning_content:'opaque-old-tool',tool_calls:[{index:0,id:'old-read',type:'function',function:{name:'conversation_read',arguments:'{"from_sequence":1,"to_sequence":1}'}}]}:{reasoning_content:'opaque-old-final',content:'seed'};return response(sse({id:'ds-'+n,choices:[{delta}]})+sse({choices:[{delta:{},finish_reason:n===1?'tool_calls':'stop'}],usage:{prompt_tokens:80,completion_tokens:6,prompt_cache_hit_tokens:64,prompt_cache_miss_tokens:16}})+DONE);};
 const ctx=compose(tempRoot('fa-legacy-ds-'),transport,{nowMs:Date.now()});cleanup(t,ctx);ctx.config.runtime.provider='deepseek';ctx.config.deepseek.model='deepseek-flash';(ctx.supervisor as any).d.runnerSelection={status:'ok',runner:new DeepSeekRunner({retryMax:0},transport)};
 await seedChatTurn(ctx,'old-base');const win=ctx.windows.activeWindow('c1')!.id;const tr=ctx.trajectory.forWindow(win)!;
 const legacy=tr.messages.map(({reasoning_content,...rest}:any)=>rest);if(extraDrift)legacy[0]={...legacy[0],content:[{type:'text',text:'unrelated historical mutation'}]};
 ctx.db.prepare('UPDATE window_trajectories SET messages_json=? WHERE window_id=?').run(JSON.stringify(legacy),win);
 const sub=ctx.messages.submitUserMessageWithTurn({conversationId:'c1',content:'next after upgrade',clientMessageId:'new'});ctx.supervisor.enqueue(sub.turnId);await ctx.supervisor.waitIdle();
 const attempt=ctx.db.prepare('SELECT state,blocked_reason FROM attempts WHERE id=?').get(sub.attemptId)as any;
 // 整合（2026-10-24）：她 D3 批的政策窗（ds_tools_all_turns_v1，schema36）下，"轨迹被剥继续态"
 // 从特定 DS_PROTOCOL 升级为 wire 守卫 WIRE_TRAJECTORY_DIVERGED:reasoning——零派发+轨迹不动
 // 语义不变，接受两种码（原仓无政策表时恒为前者）
 assert.equal(n,2);assert.equal(attempt.state,'failed');assert.match(attempt.blocked_reason,extraDrift?/HISTORY_CHANGED|WIRE_TRAJECTORY_DIVERGED/:/DS_PROTOCOL_HISTORY_REQUIRES_NEW_WINDOW|WIRE_TRAJECTORY_DIVERGED(:reasoning)?/);
 assert.deepEqual(ctx.trajectory.forWindow(win)!.messages,legacy);
});

test('FA-F06 retained unread tool fragments stay pending until a later real dispatch; exact revision/range becomes usable',async t=>{
 let phase='seed',backgroundRound=0,nextRound=0;const payloads:any[]=[];const now={nowMs:Date.now()};
 const ctx=compose(tempRoot('fa-pending-source-'),async p=>{
  payloads.push(structuredClone(p));
  if(phase==='background'){
   if(++backgroundRound===1)return response(toolCallBody([{id:'source-read',name:'conversation_read',args:JSON.stringify({from_sequence:1,to_sequence:1})}]));
   return {status:500,headers:new Headers(),body:Readable.from([])};
  }
  if(phase==='chat_failure')return {status:500,headers:new Headers(),body:Readable.from([])};
  if(phase==='next_success'&&++nextRound===1)return response(toolCallBody([{id:'probe-seen',name:'conversation_read',args:JSON.stringify({from_sequence:2,to_sequence:2})}]));
  return response(chatBody('seed'));
 },now);cleanup(t,ctx);
 const source=ctx.messages.submitUserMessageWithTurn({conversationId:'c1',content:'合成原文片段'.repeat(4000),clientMessageId:'old-unseen-source'}).message;
 await seedChatTurn(ctx,'base');const win=ctx.windows.activeWindow('c1')!.id;
 assert.equal(ctx.trajectory.forWindow(win)!.manifest?.some(m=>m.id===source.id),false);
 const{run}=readySleepBoundaryRun(ctx,now);phase='background';const failed=await ctx.supervisor.enqueueBackground('c1',run);assert.equal(failed.outcome,'failed');
 const after=ctx.trajectory.forWindow(win)!;const pending=after.pendingManifest.find(m=>m.id===source.id)!;
 assert.ok(pending);assert.equal(pending.visible,false);assert.equal(pending.pending_dispatch,true);assert.equal(pending.revision,1);assert.equal(pending.char_start,0);assert.ok(pending.char_end!>0&&pending.char_end!<source.revision.content.length);
 assert.equal(after.manifest?.some(m=>m.id===source.id),false);
 assert.equal(new MessageRetryService(ctx.db,ctx.messages,'openrouter').decorate([source])[0].mutation_status?.can_edit,true,'retained-but-unsent source must not be frozen as already read');
 phase='chat_failure';const failedUser=ctx.messages.submitUserMessageWithTurn({conversationId:'c1',content:'failed chat retains pending',clientMessageId:'chat-failure'});ctx.supervisor.enqueue(failedUser.turnId);await ctx.supervisor.waitIdle();
 assert.ok(ctx.trajectory.forWindow(win)!.pendingManifest.some(m=>m.id===source.id));
 let nextToolContext:any=null;const execute=ctx.tools.execute.bind(ctx.tools);ctx.tools.execute=async(name,args,context)=>{if(phase==='next_success')nextToolContext=context;return execute(name,args,context);};
 phase='next_success';await seedChatTurn(ctx,'next');
 const visible=nextToolContext.seenMessages.find((m:any)=>m.id===source.id);assert.deepEqual(visible,{id:source.id,revision:1,char_start:pending.char_start,char_end:pending.char_end});
 const final=ctx.trajectory.forWindow(win)!;assert.equal(final.pendingManifest.length,0);
 const seen=final.manifest?.find(m=>m.id===source.id)!;assert.equal(seen.visible,true);assert.equal(seen.pending_dispatch,undefined);assert.equal(seen.char_start,pending.char_start);assert.equal(seen.char_end,pending.char_end);
 assert.equal(new MessageRetryService(ctx.db,ctx.messages,'openrouter').decorate([source])[0].mutation_status?.can_edit,false);
 assert.equal(JSON.stringify(payloads).includes('pending_dispatch'),false,'pending source metadata remains host-only');
});

test('FA-F07 a pure heartbeat can confirm previously pending sources without appending its temporary branch',async t=>{
 let phase='seed',round=0;const now={nowMs:Date.now()};
 const ctx=compose(tempRoot('fa-pending-pure-'),async p=>{
  if(phase==='read'){if(++round===1)return response(toolCallBody([{id:'read',name:'conversation_read',args:'{"from_sequence":1,"to_sequence":1}'}]));return {status:500,headers:new Headers(),body:Readable.from([])};}
  return response(chatBody(phase==='pure'?'1':'seed'));
 },now);cleanup(t,ctx);
 const source=ctx.messages.submitUserMessageWithTurn({conversationId:'c1',content:'pending source for later pure heartbeat',clientMessageId:'source'}).message;
 await seedChatTurn(ctx,'base');const{scheduler,run}=readySleepBoundaryRun(ctx,now);phase='read';const first=await ctx.supervisor.enqueueBackground('c1',run);
 // This unit fixture invokes the executor directly; mirror scheduler terminal
 // bookkeeping before admitting a later occurrence for the same actor.
 ctx.db.prepare("UPDATE background_runs SET state=?,result_code=? WHERE id='sleep-run'").run(first.outcome,first.result_code??null);
 const win=ctx.windows.activeWindow('c1')!.id;const before=ctx.trajectory.forWindow(win)!;assert.equal(before.pendingManifest[0].id,source.id);
 ctx.db.prepare("INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at) VALUES ('second-pure','sleep-task','c1','jiaming','keepwarm',1,'second-pure','running','now','now')").run();
 phase='pure';const result=await ctx.supervisor.enqueueBackground('c1',()=>ctx.supervisor.runBackgroundTurn({kind:'keepwarm',runId:'second-pure',conversationId:'c1',payload:{},isCancelRequested:()=>false,registerAbort:()=>{},maxModelRequests:4,recordDispatch:info=>scheduler.recordDispatchStart({runId:'second-pure',...info,capabilityName:info.capabilityName??null})}));
 assert.equal(result.result_code,'ack_only');const after=ctx.trajectory.forWindow(win)!;
 assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.lastBoundary,before.lastBoundary);
 assert.equal(after.pendingManifest.length,0);assert.equal(after.manifest?.find(m=>m.id===source.id)?.visible,true);
});
