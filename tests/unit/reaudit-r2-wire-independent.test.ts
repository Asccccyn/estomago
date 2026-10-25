// R2 独立 wire 守卫回归（R01 减法后：每窗双政策层退役，本文件只保留实际 wire 行为）。
// 守卫：DS 跨轮以**上一笔已完成回合实发 wire** 为独立证据核对轨迹前缀——
// 已发送 user 正文被改写即拒发（WIRE_HISTORY_SHORTENED/WIRE_TRAJECTORY_DIVERGED）。
import { test } from 'node:test';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
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
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1', 'Use the isolated npm test runner');
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));
const HOLD_ARGS = { original_title: '政策回归', creation_mode: 'contemporaneous', categories: ['daily'], text: 'x' };
const toolRound = (gen: string) =>
  sse({ id: gen, choices: [{ delta: { reasoning_content: '思考片段甲' } }] })
  + sse({ choices: [{ delta: { reasoning_content: '乙' } }] })
  + sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'memory_hold', arguments: JSON.stringify(HOLD_ARGS) } }] } }] })
  + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const finalWithReasoning = (gen: string, text: string) =>
  sse({ id: gen, choices: [{ delta: { reasoning_content: '最终思考' } }] })
  + sse({ choices: [{ delta: { content: text } }] })
  + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;

function composeSup(root: string, transport: OrTransport, model: string, baseUrl?: string) {
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' },
    deepseek: { model, ...(baseUrl ? { base_url: baseUrl } : {}) },
  });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const mariposa: MariposaTransport = async (cap, payload) => ({ ok: true, result: { operation_id: payload.operation_id, memory_id: 'mem-x', version: 1, binding_ids: [], committed_at: new Date().toISOString() } });
  const mariposa_wire_1 = new MariposaClient({ transport: mariposa });
  const { tools: tools } = assembleTestTools({ db: db, mariposa: mariposa_wire_1, reviews: reviews, checkpoint: checkpoint });;
  const trajectory = new WindowTrajectoryService(db);
  const runner = new DeepSeekRunner({ retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({bootstrap: new MariposaClient({ transport: mariposa }), // S18：显式 BootstrapPort（原经 tools.mariposaClient 隐式取得）
     db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews, checkpoint, trajectory });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, trajectory };
}

const say = (ctx: ReturnType<typeof composeSup>, text: string, id: string) => {
  const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: text, clientMessageId: id, occurredAt: new Date().toISOString() });
  ctx.supervisor.enqueue(sub.turnId);
  return sub;
};


test('R2 actual wire guard rejects changed prior user content even when role/reasoning unchanged',async()=>{
 const root=tempRoot('reaudit-r2-content-');const payloads:Record<string,unknown>[]=[];
 const transport:OrTransport=async(payload)=>{payloads.push(structuredClone(payload));return {status:200,headers:new Map<string,string>(),body:frameStream(finalWithReasoning('audit-'+payloads.length,'synthetic answer'))};};
 const ctx=composeSup(root,transport,'deepseek-flash');try{
 const first=say(ctx,'synthetic original user','first');await ctx.supervisor.waitIdle();assert.equal((ctx.db.prepare('SELECT state FROM turns WHERE id=?').get(first.turnId) as any).state,'completed');
 const win=ctx.windows.activeWindow('c1')!;const row=ctx.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id=?').get(win.id) as any;const changed=JSON.parse(row.messages_json);const user=changed.find((m:any)=>m.role==='user');assert.ok(user);user.content=[{type:'text',text:'CORRUPTED SYNTHETIC HISTORY'}];ctx.db.prepare('UPDATE window_trajectories SET messages_json=? WHERE window_id=?').run(JSON.stringify(changed),win.id);
 const before=payloads.length;const second=say(ctx,'next synthetic question','second');await ctx.supervisor.waitIdle();console.log(JSON.stringify({case:'wire_content',before,after:payloads.length,state:(ctx.db.prepare('SELECT state FROM turns WHERE id=?').get(second.turnId) as any).state,tamperedReachedTransport:JSON.stringify(payloads.slice(before)).includes('CORRUPTED SYNTHETIC HISTORY')}));assert.equal(payloads.length,before,'independent actual wire must reject changed immutable content');
 }finally{ctx.db.close();}
});
