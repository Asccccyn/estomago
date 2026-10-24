import {memoryRefFor,SURFACE_HOST_NOTICE} from '../../apps/host/src/memory-surfacing/contracts.ts';
// 自动浮现 · supervisor 接缝与缓存边界（EST_MARIPOSA_AUTO_SURFACING_V1）。
// 核心见证 6（真实缓存）：U1 wire 在旧历史之后追加一次；U2 不删移旧包、
// 不再重复追加；失败不假标 coverage。OR/DS 信封面=独立 host-origin text
// block 置于真实 user_input block 之前（docs/04）。
import { test } from 'node:test';
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
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';

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

function compose(root: string, transport: OrTransport, mariposa: MariposaTransport, log: Array<Record<string, unknown>>) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
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
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), surfaceDetailClient: new MariposaClient({ transport: mariposa }), reviews, checkpoint })
  wireOidoCapabilitiesForTest(tools, {});;
  const trajectory = new WindowTrajectoryService(db);
  const wrapped: OrTransport = async (payload) => {
    log.push({ kind: 'chat', full: payload.messages, tools: payload.tools?.map((t: { function: { name: string } }) => t.function.name) ?? [] });
    return transport(payload);
  };
  const runner = new DeepSeekRunner({ retryMax: 0 }, wrapped);
  const supervisor = new TurnSupervisor({
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events),
    usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')),
    tools, reviews, checkpoint, trajectory, surfacing: svc,
  });
  messages.ensureConversation('c1');
  return { db, config, messages, windows, supervisor, svc, tools };
}

type Block = { type: string; text?: string };
const toBlocks = (c: unknown): Block[] => (Array.isArray(c) ? (c as Block[]) : typeof c === 'string' ? [{ type: 'text', text: c }] : []);
// DS serializes content blocks into one string at its wire boundary.
const memoryJson = (text: string): string => text.slice(text.indexOf('{"memories":'));

test('JA-S08: owner can expand the same delivered bucket without exposing refs or retrieving again', async () => {
  const root = tempRoot('sf-full-wire-'); const log: Array<Record<string, unknown>> = [];
  const caps: string[] = [];
  const transport: OrTransport = async payload => {
    assert.ok(!JSON.stringify(payload.messages).includes(ITEM.detail_ref));
    return { status: 200, headers: new Map(), body: frameStream(textBody('g1','合成回复')) };
  };
  const mariposa: MariposaTransport = async (cap, payload) => {
    caps.push(cap);
    if (cap === 'bootstrap.get') return { ok: true, result: bootPack() };
    if (cap === 'memory.surfacing.prepare') return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_wire' } };
    if (cap === 'memory.surfacing.validate') return { ok: true, result: { status: 'ready', validation_receipt: 'svr_wire', items: [ITEM] } };
    if (cap === 'memory.surfacing.check') return { ok: true, result: { valid: true, accepted_detail_refs: [ITEM.detail_ref] } };
    if (cap === 'memory.detail.read') {
      assert.equal(payload.detail_ref, ITEM.detail_ref); assert.equal(payload.view,'model');
      assert.equal(payload.section,caps.filter(x=>x==='memory.detail.read').length===1?'source':'memory');
      return {ok:true,result:payload.section==='source'?{memory_id:'00001',source:[{text:'绑定的原文'}]}:{memory_id:'00001',text:'完整正文',next_cursor:payload.cursor?null:'memory:p1'}};
    }
    throw Error('unexpected '+cap);
  };
  const ctx=compose(root,transport,mariposa,log);
  try {
    const a=ctx.messages.submitUserMessageWithTurn({conversationId:'c1',content:'还记得那次记忆库建成吗？',clientMessageId:'a'});
    ctx.supervisor.enqueue(a.turnId);await ctx.supervisor.waitIdle();
    const list=ctx.svc.visibleMemoriesForTurn('c1',a.turnId);
    assert.equal(list.length,1);assert.equal(list[0].text,ITEM.event_text);
    const before=caps.length;
    const req=ctx.db.prepare('SELECT id,window_id FROM provider_requests WHERE turn_id=? AND sent_at IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(a.turnId) as {id:string;window_id:string};
    const visibleRef=JSON.parse(memoryJson((log[0].full as any[]).flatMap(m=>toBlocks(m.content)).find(b=>b.text?.includes('{"memories":'))!.text!)).memories[0].memory_ref;
    assert.equal(visibleRef,list[0].memory_ref);
    const modelRead=await ctx.tools.execute('memory_read_full',{memory_ref:visibleRef,section:'source'},
      {roomId:'c1',windowId:req.window_id,turnId:a.turnId,requestId:req.id,purpose:'chat',activeReviewId:null,seenSequence:1,seenMessages:[]});
    assert.equal(modelRead.ok,true);assert.equal((modelRead.output.source as any[])[0].text,'绑定的原文');
    assert.deepEqual(caps.slice(before),['memory.detail.read'],'model opens source directly, no ordinary detail or new search');
    const afterModel=caps.length;
    assert.equal((await ctx.svc.readMemoryForTurn('other',a.turnId,list[0].memory_ref)).ok,false);
    assert.equal((await ctx.svc.readMemoryForTurn('c1',a.turnId,'sf_forged')).ok,false);
    assert.equal(caps.length,afterModel);
    const first=await ctx.svc.readMemoryForTurn('c1',a.turnId,list[0].memory_ref);assert.equal(first.ok,true);
    assert.equal((await ctx.svc.readMemoryForTurn('c1',a.turnId,list[0].memory_ref,'memory:p1')).ok,true);
    assert.deepEqual(caps.slice(afterModel),['memory.detail.read','memory.detail.read']);
    assert.equal(log.length,1,'clicking detail never calls the main model');
  } finally {await ctx.svc.stop();ctx.db.close();}
});

test('核心见证6：U1 同轮独立回忆块；U2 不删移旧包不重加；retain 落账', async () => {
  const root = tempRoot('sfseam-');
  const log: Array<Record<string, unknown>> = [];
  let gen = 0;
  const transport: OrTransport = async () => { gen++; return { status: 200, headers: new Map(), body: frameStream(textBody(`g${gen}`, `回${gen}`)) }; };
  let checkCalls = 0;
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'bootstrap.get') return { ok: true, result: bootPack() };
    if (cap === 'memory.surfacing.prepare') return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_seam', selected_count: 1, reason_code: null } };
    if (cap === 'memory.surfacing.validate') return { ok: true, result: { status: 'ready', validation_receipt: 'svr_seam', items: [ITEM], reason_code: null } };
    if (cap === 'memory.surfacing.check') { checkCalls++; return { ok: true, result: { valid: true, accepted_detail_refs: [ITEM.detail_ref] } }; }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const ctx = compose(root, transport, mariposa, log);
  const say = async (id: string) => {
    const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `还记得去年那件事吗 ${id}`, clientMessageId: id, occurredAt: T0 });
    ctx.supervisor.enqueue(sub.turnId);
    await ctx.supervisor.waitIdle();
    return sub;
  };
  const u1 = await say('a');
  const job = ctx.svc.repo.jobByLogicalKey('c1', u1.message.id, 1, 1, 'surface_prepare_v1')!;
  assert.equal(job.source_message_id, job.target_message_id);
  assert.equal(job.source_revision, job.target_revision);
  const msgs2 = log[0]!.full as Array<{ role: string; content: unknown }>;
  const tail2 = msgs2[msgs2.length - 1]!;
  // docs/04：content 数组独立块；provider 只能接受字符串时确定性序列化
  // 两个有来源边界的段（分段 manifest 在 surfacing_deliveries）。
  const memoryMessage = msgs2[msgs2.length - 2]!;
  assert.equal(memoryMessage.role, 'system', 'host data is not a user message');
  const fullMemoryText = toBlocks(memoryMessage.content).map(b => b.text ?? '').join('\n');
  assert.equal(fullMemoryText.split(SURFACE_HOST_NOTICE).length - 1, 1);
  const memoryText = memoryJson(fullMemoryText);
  const tail2Text = toBlocks(tail2.content).map(b => b.text ?? '').join('\n');
  assert.deepEqual(JSON.parse(memoryText), { memories: [{ memory_ref: memoryRefFor(ITEM.detail_ref), date: '2026-07-09', text: ITEM.event_text }] });
  assert.ok(memoryText.includes(memoryRefFor(ITEM.detail_ref)));

  assert.ok(tail2Text.includes('还记得去年那件事吗 a'));
  assert.ok(!tail2Text.includes('{"memories":'), 'real user input is not rewritten with host memory');
  assert.ok(checkCalls >= 1, 'check 走过 M 本地校验');
  // retained 落账（真实 manifest 确认）
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM surfacing_deliveries WHERE retained=1').get() as { n: number }).n, 1);

  // U3：同窗下一轮——旧包在原位、不重复追加（append-only + 覆盖去重）
  await say('c');
  const msgs3 = log[1]!.full as Array<{ role: string; content: unknown }>;
  // 旧回忆块仍在轨迹原位（未删除/未移动到新尾部）
  const oldBlocks = msgs3.filter((m) => toBlocks(m.content).some((b) => b.text?.includes('{"memories":')));
  assert.equal(oldBlocks.length, 1, '旧回忆块仍在轨迹原位且仅一份');
  // 新尾部不再有回忆块（同事件已覆盖）
  const tail3 = msgs3[msgs3.length - 1]!;
  assert.equal(toBlocks(tail3.content).filter((b) => b.text?.includes('{"memories":')).length, 0, 'U3 不重复追加');
  // 覆盖表登记一次
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM surfacing_coverage').get() as { n: number }).n, 1);
  const activeWindow = ctx.windows.activeWindow('c1')!.id;
  assert.ok(ctx.svc.repo.coveredInWindow('c1', activeWindow, [ITEM]).has(ITEM.event_id), 'actual retained trajectory establishes visibility');
  assert.equal(ctx.svc.repo.coveredInWindow('c1', 'new-window', [ITEM]).size, 0, 'a new window has no inherited visibility claim');

  // 工具集：memory_read_full 进入冻结工具集（docs/06 E：不等首次出现才加）
  const tools1 = (log[0]!.tools as string[]);
  const tools3 = (log[1]!.tools as string[]);
  assert.ok(tools1.includes('memory_read_full'), 'U1 起工具集已含 memory_read_full');
  assert.deepEqual(tools1, tools3, '工具集跨轮冻结不变（缓存前缀）');
  await ctx.svc.stop();
  await new Promise((r) => setTimeout(r, 20));
  ctx.db.close();
});

// R02（审计 J01）：最终准入——冻结后回执在装配边界过期/被撤销时，同一 check 门
// 拦下浮现块；主消息照常派发（普通 B 不丢），wire 上无回忆块、覆盖零落账。
test('JA-S16: stale receipt at final admission drops only the surfacing block — the turn still dispatches', async () => {
  const root = tempRoot('sf-final-admit-');
  const log: Array<Record<string, unknown>> = [];
  let gen = 0;
  const transport: OrTransport = async () => { gen++; return { status: 200, headers: new Map(), body: frameStream(textBody(`g${gen}`, `回${gen}`)) }; };
  let checkCalls = 0;
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'bootstrap.get') return { ok: true, result: bootPack() };
    if (cap === 'memory.surfacing.prepare') return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_fa' } };
    if (cap === 'memory.surfacing.validate') return { ok: true, result: { status: 'ready', validation_receipt: 'svr_fa', items: [ITEM] } };
    if (cap === 'memory.surfacing.check') { checkCalls++; return { ok: true, result: { valid: checkCalls === 1, accepted_detail_refs: [ITEM.detail_ref] } }; }
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const ctx = compose(root, transport, mariposa, log);
  try {
    const u1 = await (async () => {
      const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '你还记得那次7.9我们把记忆库做成了吗？', clientMessageId: 'fa-a', occurredAt: T0 });
      ctx.supervisor.enqueue(sub.turnId); await ctx.supervisor.waitIdle();
      return sub;
    })();
    assert.equal(log.length, 1, 'current turn dispatches despite failed final admission');
    assert.equal(gen, 1);
    const msgs2 = log[0]!.full as Array<{ role: string; content: unknown }>;
    assert.equal(msgs2.filter(m => toBlocks(m.content).some(b => b.text?.includes('{"memories":'))).length, 0, 'wire has no surfacing block');
    const tail2 = msgs2[msgs2.length - 1]!;
    assert.ok(toBlocks(tail2.content).some(b => b.text?.includes('你还记得那次7.9我们把记忆库做成了吗？')), 'real user input is intact');
    // 同一门两次：augmentFor 一次（valid）+ finalAdmit 一次（invalid）
    assert.equal(checkCalls, 2, 'the same gate checked at freeze and at final assembly');
    const job = ctx.svc.repo.jobByLogicalKey('c1', u1.message.id, 1, 1, 'surface_prepare_v1')!;
    assert.equal(job.state, 'cancelled');
    assert.equal(job.reason_code, 'FINAL_ADMISSION_DROPPED');
    assert.equal((ctx.db.prepare("SELECT count(*) n FROM surfacing_deliveries WHERE state='dropped'").get() as { n: number }).n, 1);
    assert.equal((ctx.db.prepare('SELECT count(*) n FROM surfacing_coverage').get() as { n: number }).n, 0, 'no coverage is claimed for a dropped block');
  } finally { await ctx.svc.stop(); ctx.db.close(); }
});
