// P01.5：合成正常会话快照的可复用场景助手。
// 真实装配（MessageService/WindowManager/TurnSupervisor/HostToolExecutor/SurfacingService/
// MediaService 全为生产代码）；外部 fake 只在 runner transport 与 Mariposa transport 边界。
// 场景：新窗第一轮（catalog→define→invoke(memory_hold)→正文回复，含同轮浮现块）→
// 第二条普通消息 → 通过真实发布链发一条已发布语音 → 第三条消息（历史投影携带语音）。
// 记录：每条模型请求的 tools 名单 + messages（ID/时间戳归一化后逐字保留）+ 关键工具回执。
// 归一化只消除 genId/ISO 时间戳/日期等技术噪声（D34：不改正文/角色/顺序/修订/权限差异）。
import fs from 'node:fs';
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
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import {assembleTestTools } from '../helpers.ts';
import { bindMessageLifecycle } from '../../apps/host/src/application/message-lifecycle.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import {writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));
const callFrame = (n: number, name: string, args: unknown) =>
  sse({ id: 'g' + n, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call' + n, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;

const bootPack = (): Record<string, unknown> => ({ snapshot_id: 'snap_t1', state_hash: 'h1', profile: 'estomago', memory_days: { items: [], count: 0 }, plans: { items: [], count: 0 }, i: { content: '', note: '' } });

// 浮现候选（与 surfacing-seam 同形状；detail_ref 固定值——归一化不得吃掉业务引用）
export const SURFACE_ITEM = {
  event_id: 'ev_1', memory_id: '00001', memory_version: '1',
  memory_date: '2026-07-09', date_confidence: 'exact',
  event_text: '7月9日我们把记忆库建成了',
  body_hash: 'b'.repeat(64), detail_ref: 'sdr_seam1',
};

const HOLD_ARGS = { original_title: '合成记忆', categories: ['daily'], text: '完整原文', creation_mode: 'contemporaneous', date_confidence: 'exact' };

export type WireRecord = { label: string; tools: string[]; messages: unknown[] };

/** genId 全前缀 + ISO/日期 归一化（只消除测试技术噪声）。 */
export function normalize(v: unknown): unknown {
  const idRe = /\b(alert|aref|asset|att|bgd|bgr|bgt|csel|eff|msg|obx|rbl|rcpt|rev|rt|se|sfd|sfj|sre|ssr|stream|sub|turn|use|win)_[0-9a-z]+\b/g;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      return x
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g, '<ts>')
        .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} \w+ UTC[+-]\d{1,2}/g, '<host-clock>')
        .replace(idRe, '<id>');
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return x;
  };
  return walk(v);
}

/** 跑一遍合成正常会话，返回归一化 wire 记录与关键事实。每次调用独立临时根。 */
export async function runSyntheticSession(): Promise<{ records: WireRecord[]; facts: Record<string, unknown> }> {
  const root = tempRoot('mc-snapshot-');
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter', tool_schema_mode: 'deferred' },
    openrouter: { model: 'anthropic/claude-test-1' },
  });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const log: Array<{ tools: string[]; full: unknown[] }> = [];
  let n = 0;
  let holds = 0;
  const mariposa: MariposaTransport = async (cap, payload) => {
    if (cap === 'bootstrap.get') return { ok: true, result: bootPack() };
    if (cap === 'memory.hold') { holds++; return { ok: true, result: { operation_id: payload.operation_id, memory_id: 'm1', version: 1, binding_ids: [], committed_at: '2026-10-21T12:00:00Z' } }; }
    if (cap === 'memory.surfacing.prepare') return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_snap', selected_count: 1, reason_code: null } };
    if (cap === 'memory.surfacing.validate') return { ok: true, result: { status: 'ready', validation_receipt: 'svr_snap', items: [SURFACE_ITEM], reason_code: null } };
    if (cap === 'memory.surfacing.check') return { ok: true, result: { valid: true, accepted_detail_refs: [SURFACE_ITEM.detail_ref] } };
    throw Error('unexpected ' + cap);
  };
  const svc = new SurfacingService(db, new MariposaClient({ transport: mariposa }), {
    enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v1',
    delivery_deadline_ms: 2000, max_added_tokens_per_turn: 4096,
    max_packet_bytes: 24576, worker_concurrency: 2,
  }, null);
  const messages = new MessageService(db, bindMessageLifecycle({ surfacing: svc, activity: null }));
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const { tools: tools } = assembleTestTools({ db: db, mariposa: new MariposaClient({ transport: mariposa }), surfaceDetailClient: new MariposaClient({ transport: mariposa }), reviews: reviews, checkpoint: checkpoint });
  // P04：装配镜像生产——已迁域接 registry（依赖由执行器实例反射读取）
  const { wireOidoCapabilitiesForTest } = await import('../helpers.ts');
  const trajectory = new WindowTrajectoryService(db);
  const media = new MediaService(db, path.join(root, 'media'), config);
  const transport: OrTransport = async (payload) => {
    n++;
    log.push({ tools: (payload.tools as Array<{ function: { name: string } }>).map((t) => t.function.name), full: payload.messages as unknown[] });
    let body: string;
    if (n === 1) body = callFrame(n, 'tool_catalog', {});
    else if (n === 2) body = callFrame(n, 'tool_define', { name: 'memory_hold' });
    else if (n === 3) {
      const definition = JSON.parse((payload.messages.at(-1) as { content: string }).content);
      body = callFrame(n, 'tool_invoke', { name: 'memory_hold', definition_id: definition.definition_id, arguments: HOLD_ARGS });
    } else body = textBody('g' + n, '合成回复');
    return { status: 200, headers: new Map(), body: frameStream(body) };
  };
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({bootstrap: new MariposaClient({ transport: mariposa }), // S18：显式 BootstrapPort（原经 tools.mariposaClient 隐式取得）
    
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events),
    usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')),
    tools, reviews, checkpoint, trajectory, surfacing: svc,
    // 已发布语音的结构化投影依赖听觉声明（oído 已配置的真实产品状态；深听链本卡只采集投影，不调远端）
    oidoHearing: true,
    media,
  });
  messages.ensureConversation('c1');
  const records: WireRecord[] = [];
  const facts: Record<string, unknown> = {};
  try {
    // 第一轮：catalog→define→invoke→正文（同轮浮现块随本轮进入 wire）
    const a = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '还记得去年那件事吗 合成一', clientMessageId: 'snap-one' });
    supervisor.enqueue(a.turnId);
    await supervisor.waitIdle();
    for (let i = 0; i < 4; i++) records.push({ label: `turn1-req${i + 1}`, tools: log[i]!.tools, messages: normalize(log[i]!.full) as unknown[] });
    const defineOutput = JSON.parse((log[1]!.full.at(-1) as { content: string }).content);
    const invokeResult = JSON.parse((log[3]!.full.at(-1) as { content: string }).content);
    facts.define_output = normalize(defineOutput);
    facts.invoke_result = normalize(invokeResult);
    facts.hold_calls = holds;
    // 第二条普通消息
    const b = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '合成测试输入二', clientMessageId: 'snap-two' });
    supervisor.enqueue(b.turnId);
    await supervisor.waitIdle();
    records.push({ label: 'turn2-req1', tools: log[4]!.tools, messages: normalize(log[4]!.full) as unknown[] });
    // 第三条：她真实发送一条语音消息（正常入口；无转写——深听链是 P03，不伪造；
    // 听觉可用时当前输入投影为结构化音频引用）
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x07]), purpose: 'chat_voice', operationId: 'snap-voice-upload', createdBy: 'qiaosheng', origin: 'upload' });
    const c = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '', clientMessageId: 'snap-voice', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    supervisor.enqueue(c.turnId);
    await supervisor.waitIdle();
    facts.voice_message = normalize({ id: c.message.id, kind: c.message.kind });
    records.push({ label: 'turn3-voice-req1', tools: log[5]!.tools, messages: normalize(log[5]!.full) as unknown[] });
    // 同轮浮现绑定与交付（surfacing_jobs=源消息/修订绑定；deliveries=attempt 级交付态）
    const jobs = db.prepare('SELECT conversation_id, source_message_id, source_revision, source_sequence, state FROM surfacing_jobs ORDER BY created_at').all();
    facts.surfacing_jobs = normalize(jobs);
    const deliveries = db.prepare('SELECT attempt_id, window_id, state, retained FROM surfacing_deliveries ORDER BY created_at').all();
    facts.surfacing_deliveries = normalize(deliveries);
    const hasMemoriesBlock = (full: unknown[]): boolean => full.some((m) => {
      const c = (m as { content?: unknown }).content;
      const texts = Array.isArray(c) ? c.map((b) => String((b as { text?: string }).text ?? '')) : [typeof c === 'string' ? c : ''];
      return texts.some((t) => t.includes('{"memories":'));
    });
    const firstMemoriesReq = log.findIndex((r) => hasMemoriesBlock(r.full));
    facts.surfacing_block_request = firstMemoriesReq + 1; // 1-based；0=未出现
  } finally {
    await svc.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { records, facts };
}
