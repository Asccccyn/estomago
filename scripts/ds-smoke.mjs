#!/usr/bin/env node
// DS 官方 key 真实冒烟（ESTOMAGO_OR_SELF_HOLD WP6 裁剪版：DS 无 1h cache_control，跳过缓存证据项）。
// 安全纪律：
//  - 不读/不打印 key 值（只经环境变量由 defaultTransport 使用）
//  - 必须显式 ESTOMAGO_DS_SMOKE=1 且 OPENROUTER_API_KEY 已设才发真实请求；--dry-run 用假 transport 自测脚本结构（零网络）
//  - 隔离：自建临时 ESTOMAGO_HOME，合成身份/对话，不碰生产根；慢速三步，总量 <1 万 token（分级：几分钱）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const DRY = process.argv.includes('--dry-run');
if (!DRY) {
  if (process.env.ESTOMAGO_DS_SMOKE !== '1') { console.error('拒绝：需 ESTOMAGO_DS_SMOKE=1（防误触真实请求）'); process.exit(2); }
  if (!process.env.OPENROUTER_API_KEY) { console.error('拒绝：OPENROUTER_API_KEY 未设置（把 DS 官方 key 放进环境变量，不要写在命令行）'); process.exit(2); }
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
const { OpenRouterRunner, openRouterSelection } = await import('../apps/host/src/runtime/runner-openrouter.ts');
const { HostToolExecutor } = await import('../apps/host/src/runtime/host-tools.ts');
const { RotationReviewService } = await import('../apps/host/src/context/rotation-review.ts');
const { HoldCheckpointService } = await import('../apps/host/src/memory/hold-checkpoint.ts');
const { WindowTrajectoryService } = await import('../apps/host/src/runtime/window-trajectory.ts');
const { MariposaClient } = await import('../apps/host/src/integrations/mariposa/client.ts');

const MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat';
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
  runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' },
  openrouter: { model: MODEL, provider_only: ['deepseek'] },
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
const tools = new HostToolExecutor({ mariposa: new MariposaClient({ transport: mariposaFake }), reviews, checkpoint });
const trajectory = new WindowTrajectoryService(db);

let orTransport;
if (DRY) {
  const enc = new TextEncoder();
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const DONE = 'data: [DONE]\n\n';
  orTransport = async (payload) => {
    const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user');
    const text = Array.isArray(lastUser?.content) ? lastUser.content.map((b) => b.text ?? '').join('\n') : '';
    const toolAlreadyRun = payload.messages.some((m) => m.role === 'tool'); // 工具已执行→收口（真模型行为）
    const body = text.includes('请记录') && !toolAlreadyRun
      ? sse({ id: 'gen-dry', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-dry', type: 'function', function: { name: 'memory_hold', arguments: JSON.stringify({ category: 'daily', text: '冒烟合成记录' }) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE
      : sse({ id: 'gen-dry', choices: [{ delta: { content: 'dry-run 合成回复' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 7, cost: 0.001 } }) + DONE;
    return { status: 200, headers: new Map(), body: Readable.from(body.split('\n\n').filter(Boolean).map((s) => enc.encode(s + '\n\n'))) };
  };
} else {
  orTransport = undefined; // openRouterSelection 内部 defaultTransport（真实 fetch，key 只在请求头构造处读取）
}
const runner = DRY
  ? new OpenRouterRunner({ providerOnly: ['deepseek'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, orTransport)
  : openRouterSelection(config).runner;
const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db), routing, windows, logger, tools, reviews, checkpoint, trajectory });
messages.ensureConversation('c1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { mode: DRY ? 'dry-run' : 'live', model: MODEL, started_at: new Date().toISOString(), steps: [] };
async function step(name, content, clientId) {
  const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content, clientMessageId: clientId, occurredAt: new Date().toISOString() });
  supervisor.enqueue(sub.turnId);
  await supervisor.waitIdle();
  await sleep(DRY ? 50 : 1500); // 慢速：真实模式每步间隔 1.5s（低频保守，避免任何异常流量形态）
  const att = db.prepare('SELECT state, blocked_reason FROM attempts WHERE id = ?').get(sub.attemptId);
  const usage = db.prepare('SELECT request_id, input_tokens, output_tokens, cost_usd, completeness FROM usage_observations WHERE attempt_id = ? ORDER BY rowid').all(sub.attemptId);
  const effects = db.prepare("SELECT kind, state FROM tool_side_effects WHERE turn_id = ?").all(sub.turnId);
  const published = messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 50 }).filter((m) => m.speaker === 'assistant').length;
  evidence.steps.push({ name, attempt: att, usage, effects, assistantPublished: published });
  console.log(`[${name}] attempt=${att.state} usageRows=${usage.length} effects=${JSON.stringify(effects)}`);
  return att.state;
}

const s1 = await step('chat-baseline', '冒烟第一步：请只回复"收到"。', 'ds1');
const s2 = await step('tool-roundtrip', '请记录：今天跑了 DS 冒烟，一切都好。', 'ds2');
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
fs.mkdirSync('reports', { recursive: true });
const out = path.join('reports', `ds-smoke-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.verdict}\n证据 → ${out}`);
db.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
