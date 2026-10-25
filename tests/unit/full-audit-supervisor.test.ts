import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
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
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';

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
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), archiveSync: null, media: media, messages: messages, events: events });
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

test('FA-M01 dispatched unknown input cannot be edited through service or edit-and-retry; frozen wire stays unchanged',async t=>{
 const ctx=compose(tempRoot('fa-mutation-'),async()=>response(chatBody('seed')),{nowMs:Date.now()});cleanup(t,ctx);
 await seedChatTurn(ctx,'base');
 const sub=ctx.messages.submitUserMessageWithTurn({conversationId:'c1',content:'original',clientMessageId:'pending'});
 const win=ctx.windows.activeWindow('c1')!.id;
 ctx.db.prepare("UPDATE turns SET state='failed' WHERE id=?").run(sub.turnId);
 ctx.db.prepare("UPDATE attempts SET state='failed',window_id=? WHERE id=?").run(win,sub.attemptId);
 ctx.db.prepare("INSERT INTO provider_requests(id,window_id,turn_id,attempt_id,purpose,seen_manifest_json,created_at,dispatch_started_at,payload_wire_json) VALUES ('unknown',?,?,?,'chat','[]','now','now','frozen')").run(win,sub.turnId,sub.attemptId);
 assert.throws(()=>ctx.messages.editUserMessage(sub.message.id,'changed'),(e:any)=>e.code==='MESSAGE_ALREADY_DISPATCHED');
 assert.throws(()=>new MessageRetryService(ctx.db,ctx.messages,'openrouter').retry({conversationId:'c1',messageId:sub.message.id,content:'changed',expectedRevision:1,operationKey:'edit'}),(e:any)=>e.code==='MESSAGE_ALREADY_DISPATCHED');
 assert.equal(ctx.messages.getMessage(sub.message.id)!.revision.content,'original');
 assert.equal((ctx.db.prepare("SELECT payload_wire_json FROM provider_requests WHERE id='unknown'").get()as any).payload_wire_json,'frozen');
 assert.equal(new MessageRetryService(ctx.db,ctx.messages,'openrouter').decorate([sub.message])[0].mutation_status?.can_edit,false);
});

test('FA-M02 editing during asynchronous preparation invalidates the old first dispatch',async t=>{
 let calls=0;const ctx=compose(tempRoot('fa-edit-race-'),async()=>{calls++;return response(chatBody('should not send'));},{nowMs:Date.now()});cleanup(t,ctx);
 const sub=ctx.messages.submitUserMessageWithTurn({conversationId:'c1',content:'old accepted',clientMessageId:'race'});
 (ctx.supervisor as any).d.surfacing={augmentFor:async()=>{ctx.messages.editUserMessage(sub.message.id,'new accepted');return null;},reuseFrozen:()=>null,markRetained:()=>{}};
 ctx.supervisor.enqueue(sub.turnId);await ctx.supervisor.waitIdle();
 assert.equal(calls,0);assert.match((ctx.db.prepare('SELECT blocked_reason FROM attempts WHERE id=?').get(sub.attemptId)as any).blocked_reason,/INPUT_REVISION_SUPERSEDED/);
});

test('FA-C01 DS final reasoning state is preserved across real driver payloads without rewriting old messages',async t=>{
 const payloads:any[]=[];
 const transport:OrTransport=async p=>{payloads.push(structuredClone(p));return response(sse({id:'ds-'+payloads.length,choices:[{delta:{reasoning_content:'opaque-'+payloads.length,content:'answer'}}]})+sse({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:5,prompt_cache_hit_tokens:32,prompt_cache_miss_tokens:8}})+DONE);};
 const ctx=compose(tempRoot('fa-ds-state-'),transport,{nowMs:Date.now()});cleanup(t,ctx);
 ctx.config.runtime.provider='deepseek';ctx.config.deepseek.model='deepseek-flash';(ctx.supervisor as any).d.runnerSelection={status:'ok',runner:new DeepSeekRunner({retryMax:0},transport)};
 await seedChatTurn(ctx,'one');const before=ctx.trajectory.forWindow(ctx.windows.activeWindow('c1')!.id)!.messages;
 await seedChatTurn(ctx,'two');
 const assistant=payloads[1].messages.find((m:any)=>m.role==='assistant');assert.equal(assistant.reasoning_content,'opaque-1');
 assert.deepEqual(ctx.trajectory.forWindow(ctx.windows.activeWindow('c1')!.id)!.messages.slice(0,before.length),before);
});

test('FA-C02 catalog/define then final 1 remains substantive; heartbeat attempt reaches completed',async t=>{
 let n=0;const now={nowMs:Date.parse('2026-10-23T14:00:00+08:00')};
 const ctx=compose(tempRoot('fa-catalog-'),async p=>JSON.stringify(p).includes('Cache keepalive')&&++n===1?response(toolCallBody([{id:'catalog',name:'tool_catalog',args:'{}'}])):response(chatBody(n?'1':'seed')),now);cleanup(t,ctx);
 await seedChatTurn(ctx,'base');const{scheduler,run}=readySleepBoundaryRun(ctx,now);t.after(()=>scheduler.stop());
 await ctx.supervisor.enqueueBackground('c1',run);
 const bg=ctx.db.prepare("SELECT * FROM background_runs WHERE id='sleep-run'").get()as any;
 assert.equal(bg.retention,'retained');assert.ok(ctx.trajectory.forWindow(ctx.windows.activeWindow('c1')!.id)!.messages.some(m=>m.role==='tool'));
 assert.equal((ctx.db.prepare('SELECT state FROM attempts WHERE turn_id=?').get(bg.turn_id)as any).state,'completed');
});

test('FA-C03 background publication and protocol survive a later failed model request; next chat remembers it',async t=>{
 let n=0;let bg=true;const now={nowMs:Date.parse('2026-10-23T14:00:00+08:00')};const payloads:any[]=[];
 const ctx=compose(tempRoot('fa-bg-error-'),async p=>{payloads.push(structuredClone(p));if(bg&&JSON.stringify(p).includes('Cache keepalive')){if(++n===1)return response(toolCallBody([{id:'send',name:'chat_send_text',args:JSON.stringify({text:'published before failure',idempotency_key:'one'})}]));return{status:500,headers:new Headers(),body:Readable.from([])};}return response(chatBody('seed'));},now);cleanup(t,ctx);
 await seedChatTurn(ctx,'base');const{scheduler,run}=readySleepBoundaryRun(ctx,now);t.after(()=>scheduler.stop());
 const result=await ctx.supervisor.enqueueBackground('c1',run);assert.equal(result.outcome,'failed');
 const tr=ctx.trajectory.forWindow(ctx.windows.activeWindow('c1')!.id)!;assert.match(JSON.stringify(tr.messages),/published before failure/);assert.ok(tr.messages.some(m=>m.role==='tool'));
 const row=ctx.db.prepare("SELECT retention,trajectory_committed_at FROM background_runs WHERE id='sleep-run'").get()as any;assert.equal(row.retention,'retained');assert.ok(row.trajectory_committed_at);
 bg=false;await seedChatTurn(ctx,'after');assert.match(JSON.stringify(payloads.at(-1)),/published before failure/);
});

test('FA-P01 same business send key across model requests publishes exactly one durable SSE event',async t=>{
 const ctx=compose(tempRoot('fa-publish-'),async()=>response(chatBody('seed')),{nowMs:Date.now()});cleanup(t,ctx);await seedChatTurn(ctx,'base');
 const win=ctx.windows.activeWindow('c1')!.id;const turn=(ctx.db.prepare('SELECT id FROM turns LIMIT 1').get()as any).id;
 const context={roomId:'c1',windowId:win,turnId:turn,purpose:'proactive_turn' as const,activeReviewId:null,seenSequence:0,seenMessages:[],requestId:'first'};
 const a=await ctx.tools.execute('chat_send_text',{text:'one real publication',idempotency_key:'stable'},context);
 const b=await ctx.tools.execute('chat_send_text',{text:'one real publication',idempotency_key:'stable'},{...context,requestId:'second'});
 assert.equal(a.output.message_id,b.output.message_id);
 assert.equal((ctx.db.prepare("SELECT count(*) n FROM runtime_stream_events WHERE kind='message.published' AND entity_ref=?").get(a.output.message_id)as any).n,1);
});

test('FA-B01 price removed during a tool loop cannot turn the next paid request into a zero reservation',async t=>{
 let n=0;const now={nowMs:Date.parse('2026-10-23T14:00:00+08:00')};let ctx:ReturnType<typeof compose>;
 ctx=compose(tempRoot('fa-price-'),async p=>{if(JSON.stringify(p).includes('Cache keepalive')){n++;ctx.db.prepare("DELETE FROM runtime_settings WHERE key='or_model_price'").run();return response(toolCallBody([{id:'cat',name:'tool_catalog',args:'{}'}]));}return response(chatBody('seed'));},now);cleanup(t,ctx);
 await seedChatTurn(ctx,'base');const{scheduler,run}=readySleepBoundaryRun(ctx,now);t.after(()=>scheduler.stop());
 const r=await ctx.supervisor.enqueueBackground('c1',run);assert.equal(r.result_code,'BUDGET_ESTIMATE_UNAVAILABLE');assert.equal(n,1);
});
