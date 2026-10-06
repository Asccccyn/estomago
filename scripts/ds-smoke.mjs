#!/usr/bin/env node
// DS 官方 key 真实冒烟（DeepSeek 直连驱动，不经 OpenRouter——2026-10-05 她裁定）。
// 安全纪律：
//  - 不读/不打印 key 值（只经 DEEPSEEK_API_KEY 环境变量由 defaultTransport 使用；key 打 openrouter.ai 认证不了，端点已钉死 api.deepseek.com）
//  - 必须显式 ESTOMAGO_DS_SMOKE=1 且 DEEPSEEK_API_KEY 已设才发真实请求；--dry-run 用假 transport 自测脚本结构（零网络）
//  - 隔离：自建临时 ESTOMAGO_HOME，合成身份/对话，不碰生产根；慢速三步，输出上限 256 token（分级：几分钱）
//  - 字段自检（审计 P1-1 回归防线）：假/真 transport 层断言 payload 不含 session_id/provider/plugins/cache_control——
//    Anthropic 式或 OR 专属字段一旦泄漏进 DS 请求，dry-run 即失败，不等 live 400
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const DRY = process.argv.includes('--dry-run');
if (!DRY) {
  if (process.env.ESTOMAGO_DS_SMOKE !== '1') { console.error('拒绝：需 ESTOMAGO_DS_SMOKE=1（防误触真实请求）'); process.exit(2); }
  if (!process.env.DEEPSEEK_API_KEY) { console.error('拒绝：DEEPSEEK_API_KEY 未设置（DeepSeek 官方平台的 key 放进该环境变量，不要写在命令行；本脚本直连 api.deepseek.com，不经 OpenRouter）'); process.exit(2); }
}
process.env.ESTOMAGO_TEST_MODE = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'estomago-ds-smoke-'));
process.env.ESTOMAGO_HOME = root;

const { writeApprovedIdentity, readyRuntimePatch } = await import('../tests/helpers.ts');
const { buildConfig } = await import('../apps/host/src/config/schema.ts');
const { openDatabase } = await import('../apps/host/src/db/connection.ts');
const { migrate } = await import('../apps/host/src/db/migrations.ts');
const { sha256Hex } = await import('../apps/host/src/util/id.ts');
const { buildPaths } = await import('../apps/host/src/config/paths.ts');
const { Logger } = await import('../apps/host/src/observability/logging.ts');
const { EventService } = await import('../apps/host/src/events/service.ts');
const { MessageService } = await import('../apps/host/src/messages/service.ts');
const { IdentityService } = await import('../apps/host/src/identity/service.ts');
const { CapabilityMatrix } = await import('../apps/host/src/runtime/capabilities.ts');
const { ReasoningService } = await import('../apps/host/src/reasoning/service.ts');
const { UsageCollector } = await import('../apps/host/src/usage/collector.ts');
const { RoutingService } = await import('../apps/host/src/routing/service.ts');
const { WindowManager } = await import('../apps/host/src/windows/manager.ts');
const { TurnSupervisor } = await import('../apps/host/src/runtime/supervisor.ts');
const { DeepSeekRunner, deepSeekSelection } = await import('../apps/host/src/runtime/runner-deepseek.ts');
const { HostToolExecutor } = await import('../apps/host/src/runtime/host-tools.ts');
const { RotationReviewService } = await import('../apps/host/src/context/rotation-review.ts');
const { HoldCheckpointService } = await import('../apps/host/src/memory/hold-checkpoint.ts');
const { WindowTrajectoryService } = await import('../apps/host/src/runtime/window-trajectory.ts');
const { MariposaClient } = await import('../apps/host/src/integrations/mariposa/client.ts');

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
// 合成身份：rules 里注入工具指令，保证"请记录"消息高概率触发 memory_hold（可验证真实工具往返）
writeApprovedIdentity(root);
const paths0 = buildPaths(root);
const rulesPath = path.join(paths0.identityDir, 'runtime-rules.md');
fs.writeFileSync(rulesPath, fs.readFileSync(rulesPath, 'utf8') + '\n（冒烟指令）当用户消息以"请记录"开头时，你必须调用 memory_hold 工具记录其内容，然后简短确认。其余消息正常简短回复。');
// 改写 rules 后同步 manifest hash（gate 校验 hash，不是文件名）
const manifestPath = path.join(paths0.configDir, 'identity-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.rules_hash = sha256Hex(fs.readFileSync(rulesPath, 'utf8'));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const config = buildConfig({
  ...readyRuntimePatch(),
  runtime: { ...readyRuntimePatch().runtime, provider: 'deepseek' },
  deepseek: { model: MODEL, retry_max_attempts_after_initial: 0, max_output_tokens: 256 }, // 保险丝①②：冒烟不自动重试、输出上限压到一句话级
});
const paths = buildPaths(root);
const db = openDatabase(path.join(root, 'data'));
migrate(db, sha256Hex);
const logger = new Logger(path.join(root, 'logs'));
const events = new EventService(db);
const messages = new MessageService(db);
const identity = new IdentityService(config, paths);
const routing = new RoutingService(db, events, messages);
const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
const reviews = new RotationReviewService(db);
const checkpoint = new HoldCheckpointService(db);
const mariposaFake = async (cap, payload) => {
  if (cap === 'memory.hold') {
    const op = payload.operation_id;
    return { ok: true, result: { operation_id: op, memory_id: `smoke-${String(op).slice(-6)}`, version: 1, binding_ids: [], committed_at: new Date().toISOString() } };
  }
  return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
};
const tools = new HostToolExecutor({ db, mariposa: new MariposaClient({ transport: mariposaFake }), reviews, checkpoint });
const trajectory = new WindowTrajectoryService(db);

// 字段自检：DS 请求绝不携带 OR 专属字段或 Anthropic 式缓存标记（审计 P1-1；真/假 transport 共用）
function assertDsPayloadClean(payload) {
  const bad = ['session_id', 'provider', 'plugins', 'cache_control'].filter((k) => payload[k] !== undefined);
  if (bad.length > 0) throw new Error(`DS payload 字段自检失败（泄漏 OR/Anthropic 字段）：${bad.join(',')}`);
  const s = JSON.stringify(payload.messages ?? []);
  if (s.includes('cache_control') || s.includes('reasoning_details')) throw new Error('DS payload 字段自检失败：消息块携带 cache_control/reasoning_details');
  if (typeof payload.model !== 'string' || !/^[a-z0-9][a-z0-9._\-]*$/i.test(payload.model)) throw new Error('DS payload 字段自检失败：model 非单段 DS 官方型号');
}

let orTransport;
if (DRY) {
  const enc = new TextEncoder();
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const DONE = 'data: [DONE]\n\n';
  orTransport = async (payload) => {
    assertDsPayloadClean(payload); // dry-run 即拦截字段泄漏，不等 live 400
    const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.map((b) => b.text ?? '').join('\n') : '';
    const toolAlreadyRun = payload.messages.some((m) => m.role === 'tool'); // 工具已执行→收口（真模型行为）
    const body = text.includes('请记录') && !toolAlreadyRun
      ? sse({ id: 'gen-dry', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-dry', type: 'function', function: { name: 'memory_hold', arguments: JSON.stringify({ original_title: 'DS 冒烟记录', categories: ['daily'], text: '冒烟合成记录' }) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE
      : sse({ id: 'gen-dry', choices: [{ delta: { content: 'dry-run 合成回复' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 7, prompt_cache_hit_tokens: 24 } }) + DONE;
    return { status: 200, headers: new Map(), body: Readable.from(body.split('\n\n').filter(Boolean).map((s) => enc.encode(s + '\n\n'))) };
  };
}
const runner = DRY
  ? new DeepSeekRunner({ retryMax: 0 }, orTransport)
  : deepSeekSelection(config).runner; // 真实模式：defaultTransport 直连 api.deepseek.com，key 只在请求头构造处读取
if (!DRY) {
  // 真实模式也包一层字段自检（不触碰 key/流——只校验发出的 payload 形状）
  const realTransport = runner.transport;
  runner.transport = async (payload, signal) => { assertDsPayloadClean(payload); return realTransport(payload, signal); };
}
const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
messages.ensureConversation('c1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { mode: DRY ? 'dry-run' : 'live', model: MODEL, endpoint: config.deepseek.base_url, started_at: new Date().toISOString(), steps: [] };
async function step(name, content, clientId) {
  const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: clientId, occurredAt: new Date().toISOString() });
  supervisor.enqueue(sub.turnId);
  await supervisor.waitIdle();
  await sleep(DRY ? 50 : 1500); // 慢速：真实模式每步间隔 1.5s（低频保守，避免任何异常流量形态）
  const att = db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(sub.attemptId);
  const usage = db.prepare('SELECT request_id, input_tokens, output_tokens, cache_read_input_tokens, cost_usd, completeness FROM usage_observations WHERE attempt_id = ? ORDER BY rowid').all(sub.attemptId);
  const effects = db.prepare("SELECT kind, state FROM tool_side_effects WHERE turn_id = ?").all(sub.turnId);
  const published = messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 50 }).filter((m) => m.speaker === 'assistant').length;
  evidence.steps.push({ name, attempt: att, usage, effects, assistantPublished: published });
  console.log(`[${name}] attempt=${att.state} usageRows=${usage.length} effects=${JSON.stringify(effects)}`);
  return att.state;
}

// 保险丝③：任一步非 completed 立即停止——不给后续步骤继续发请求的机会
const SMOKE_MAX_REQUESTS = 10; // 保险丝④：全局真实发送上限（3 步 × 正常 1-2 轮 + 余量；超限说明行为异常，中止）
function requestCount() { return (db.prepare('SELECT COUNT(*) n FROM provider_requests WHERE sent_at IS NOT NULL').get()).n; }
const cleanup = () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); };
const saveEvidence = () => { fs.mkdirSync('reports', { recursive: true }); const out = path.join('reports', `ds-smoke-${Date.now()}.json`); fs.writeFileSync(out, JSON.stringify(evidence, null, 2)); console.log(`证据 → ${out}`); };
const s1 = await step('chat-baseline', '冒烟第一步：请只回复"收到"。', 'ds1');
if (s1 !== 'completed') { evidence.verdict = `ABORTED_AFTER_STEP1（${s1}，不再继续发送）`; saveEvidence(); console.log(evidence.verdict); cleanup(); process.exit(1); }
if (requestCount() > SMOKE_MAX_REQUESTS) { console.error('保险丝④熔断：真实发送数超上限，中止'); cleanup(); process.exit(1); }
const s2 = await step('tool-roundtrip', '请记录：今天跑了 DS 冒烟，一切都好。', 'ds2');
if (s2 !== 'completed' || requestCount() > SMOKE_MAX_REQUESTS) { console.error(`第二步后中止（state=${s2}, sent=${requestCount()}）`); evidence.verdict = 'ABORTED_AFTER_STEP2'; saveEvidence(); cleanup(); process.exit(1); }
const s3 = await step('followup-appendonly', '谢谢，请只回复"完成"。', 'ds3');
const win = windows.activeWindow('c1');
evidence.final = {
  window: win ? { id: win.id, status: win.status } : null,
  checkpoint: checkpoint.forWindow(win?.id ?? ''),
  trajectoryMessages: trajectory.forWindow(win?.id ?? '')?.messages.length ?? null,
  providerRequests: db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) sent FROM provider_requests').get(),
};
const pass = s1 === 'completed' && s2 === 'completed' && s3 === 'completed';
evidence.verdict = pass ? 'SMOKE_PASS（三步完成）' : 'SMOKE_FAIL（见 steps）';
saveEvidence();
console.log(`\n${evidence.verdict}`);
cleanup();
process.exit(pass ? 0 : 1);
