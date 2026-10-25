// R09-E 前置件（她 2026-10-19 晚裁定：动 buildEnvelope/revisionBlocks 之前
// 必须建立字节级回归基线，目标零行为变化）。
//
// 本测试把生产等价装配链（DS 信封驱动、surfacing 关=生产现状、mock 身份、
// bootstrap 固定包）跑一组确定性回合，把每一笔**真实 transport 载荷**做
// 挥发字段归一化（随机 id/时间戳/time_context 值）后与 golden 逐字节比对。
// 任何重构若改变非挥发字节，本测试即红——重构者必须解释每一处差异。
// 更新 golden 须显式 ESTOMAGO_UPDATE_GOLDEN=1（防无意识漂移）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { DeepSeekRunner } from '../../apps/host/src/runtime/runner-deepseek.ts';
import type { OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot, wireOidoCapabilitiesForTest } from '../helpers.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const toolBody = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
  sse({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
  + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));
const T0 = '2026-10-19T09:00:00+08:00';
const GOLDEN = path.join(import.meta.dirname, '..', 'golden', 'envelope-baseline.json');

/** 挥发字段归一化：随机 id、时间戳、time_context 值——保留键与结构。 */
export function canonicalize(payload: unknown): string {
  payload = structuredClone(payload);
  // 她 1021 P2：time_context 纯文本段体（分钟级时钟=挥发）在 stringify 前
  // 归一化（单层正则；旧 JSON 形态由下方七键规则处理）
  const NEW_TC = /\[time_context\]（[^）]*）\n(?:user_gap: PT(?:\d+H)?(?:\d+M)?\n)?\d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) UTC(?:[+-]\d+(?::\d+)?)?/g;
  const msgs = (payload as { messages?: Array<{ content?: unknown }> }).messages;
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      const c = m.content;
      if (typeof c === 'string') m.content = c.replace(NEW_TC, '[time_context]（…）\n<TC>');
      else if (Array.isArray(c)) {
        for (const blk of c) {
          if (blk && typeof blk === 'object' && (blk as { type?: string }).type === 'text'
              && typeof (blk as { text?: string }).text === 'string') {
            (blk as { text: string }).text = (blk as { text: string }).text.replace(NEW_TC, '[time_context]（…）\n<TC>');
          }
        }
      }
    }
  }
  let s = JSON.stringify(payload);
  s = s.replace(/"(msg|turn|att|win|prq|gen|toolu|call|sfd|sfj|sub|evt|rev)_[A-Za-z0-9_-]+"/g, '"$1_<ID>"');
  s = s.replace(/toolu_[A-Za-z0-9_]+/g, 'toolu_<ID>');
  s = s.replace(/es-(hold|recall|surface|read|open)-[0-9a-f]{8,}/g, 'es-$1-<ID>');
  // 她 1021 P2：time_context 纯文本段体（分钟级时钟=挥发）整体归一化；
  // 旧 JSON 形态（{ 开头）由上方七键规则处理
  s = s.replace(/(（[^）]*）\\n)(?!\{)[0-9A-Za-z :|,-]{8,}(\\n\\n\[user_input\\])/g, '$1<TC>$2');
  s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, '<TS>');
  s = s.replace(/\\"now_at_utc\\":\\"[^\\]*\\"/g, '\\"now_at_utc\\":\\"<T>\\"');
  s = s.replace(/\\"local_date\\":\\"[^\\]*\\"/g, '\\"local_date\\":\\"<T>\\"');
  s = s.replace(/\\"weekday\\":\\"[^\\]*\\"/g, '\\"weekday\\":\\"<T>\\"');
  s = s.replace(/\\"daypart\\":\\"[^\\]*\\"/g, '\\"daypart\\":\\"<T>\\"');
  s = s.replace(/\\"elapsed_since_last_(user|assistant)_message\\":(null|\\"[^\\]*\\")/g, '\\"elapsed_since_last_$1_message\\":\\"<T>\\"');
  s = s.replace(/\\"crossed_business_date\\":(true|false)/g, '\\"crossed_business_date\\":<T>');
  return s;
}

function compose(root: string, transport: OrTransport, log: Array<Record<string, unknown>>) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' }, deepseek: { model: 'deepseek-chat' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const mariposa: MariposaTransport = async (cap, payload) => {
    if (cap === 'bootstrap.get') return { ok: true, result: { snapshot_id: 'snap_t1', state_hash: 'h1', profile: 'estomago', memory_days: { items: [], count: 0 }, plans: { items: [], count: 0 }, i: { content: '', note: '' } } };
    if (cap === 'memory.hold') return { ok: true, result: { operation_id: (payload as { operation_id: string }).operation_id, memory_id: '00001', version: 1, binding_ids: [], committed_at: '2026-10-19T01:00:00Z' } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const messages = new MessageService(db, null); // surfacing 关=生产现状
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposa }), reviews, checkpoint, events })
  wireOidoCapabilitiesForTest(tools, {  });;
  const trajectory = new WindowTrajectoryService(db);
  const wrapped: OrTransport = async (payload) => {
    log.push(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>);
    return transport(payload);
  };
  const runner = new DeepSeekRunner({ retryMax: 0 }, wrapped);
  const supervisor = new TurnSupervisor({bootstrap: new MariposaClient({ transport: mariposa }), // S18：显式 BootstrapPort（原经 tools.mariposaClient 隐式取得）
    
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events),
    usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')),
    tools, reviews, checkpoint, trajectory,
  });
  messages.ensureConversation('c1');
  return { db, messages, supervisor };
}

test('R09-E 字节级基线：确定性三回合+一工具轮的 wire 载荷（挥发字段归一化后）与 golden 逐字节一致', async () => {
  const root = tempRoot('env-golden-');
  const log: Array<Record<string, unknown>> = [];
  let gen = 0;
  const transport: OrTransport = async (payload) => {
    gen++;
    const lastRole = (payload.messages as Array<{ role: string }>).at(-1)?.role;
    // 第三回合：先发一次工具调用，工具结果回来后再出正文
    if (gen === 3) return { status: 200, headers: new Map(), body: frameStream(toolBody(`g${gen}`, 'call_fixed_1', 'memory_hold', { original_title: '基线回归', creation_mode: 'contemporaneous', categories: ['daily'], text: '基线正文' })) };
    if (lastRole === 'tool') return { status: 200, headers: new Map(), body: frameStream(textBody(`g${gen}`, '写好了。')) };
    return { status: 200, headers: new Map(), body: frameStream(textBody(`g${gen}`, `回复${gen}`)) };
  };
  const ctx = compose(root, transport, log);
  try {
    for (const [i, text] of ['第一句，开窗。', '第二句，续聊。', '第三句，请记一下。'].entries()) {
      const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: text, clientMessageId: `golden-${i}`, occurredAt: T0 });
      ctx.supervisor.enqueue(sub.turnId);
      await ctx.supervisor.waitIdle();
    }
    if (log.length < 4) {
      const rows = ctx.db.prepare("SELECT t.id, t.state ts, a.state as_, a.blocked_reason FROM turns t LEFT JOIN attempts a ON a.turn_id=t.id ORDER BY t.created_at").all();
      console.error('TURNS:', JSON.stringify(rows));
    }
    assert.ok(log.length >= 4, `应至少 4 笔 wire（3 回合+1 工具续轮），实得 ${log.length}`);
    const wireBefore = JSON.stringify(log);
    assert.match(wireBefore, /\\n\d{4}-\d{2}-\d{2} \d{2}:\d{2} (Mon|Tue|Wed|Thu|Fri|Sat|Sun) UTC\+8/);
    const canon = log.map(canonicalize);
    assert.equal(JSON.stringify(log), wireBefore, 'canonicalize must not mutate the captured wire');
    const golden = fs.existsSync(GOLDEN) ? (JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as string[]) : null;
    if (!golden || process.env.ESTOMAGO_UPDATE_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(canon, null, 0));
      if (!golden) return; // 首次建立基线
      if (process.env.ESTOMAGO_UPDATE_GOLDEN === '1') return; // 显式重建后本次跳过比对
    }
    assert.equal(canon.length, golden!.length, 'wire 笔数变化=装配行为变化');
    for (let i = 0; i < canon.length; i++) {
      if (canon[i] !== golden![i]) {
        let j = 0; while (j < canon[i]!.length && canon[i]![j] === golden![i]![j]) j++;
        assert.fail(`第 ${i} 笔 wire 与基线不一致 @byte ${j}:\n  now   …${canon[i]!.slice(Math.max(0, j - 80), j + 120)}\n  golden…${golden![i]!.slice(Math.max(0, j - 80), j + 120)}`);
      }
    }
  } finally { ctx.db.close(); }
});
