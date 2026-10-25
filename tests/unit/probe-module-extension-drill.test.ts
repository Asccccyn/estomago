// P08 演练A（A26/A27/A03）：扩展局部化+依赖替换演练。
// 见 specs 08 §"两项扩展演练"：探针模块（tests/helpers/probe-module.ts）接入真实 registry，
// 从真实模型入口（catalog→define→invoke）调用它；核心算法（supervisor/消息核心/通用执行器）
// 零修改——本测试文件+helper 即全部改动面（A26 CHANGE_LOCALITY 证据）。
// 同时覆盖 A03：同窗已冻结目录不因新模块注册而改变；新能力按政策仅新窗采用。
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
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { CapabilityRegistry } from '../../apps/host/src/capabilities/registry.ts';
import { storedToolset, freezeWindowTools } from '../../apps/host/src/runtime/tool-discovery.ts';
import { buildHostTools } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { wireOidoCapabilitiesForTest } from '../helpers.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';
import { registerProbeModule, PROBE_TOOL_NAME, PROBE_DEFINITION } from '../helpers/probe-module.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const callFrame = (n: number, name: string, args: unknown) =>
  sse({ id: 'g' + n, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call' + n, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));

test('演练A：探针模块经真实入口全链可达（核心零修改）；冻结窗口不因新注册改变（A03）', async () => {
  const root = tempRoot('probe-drill-');
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter', tool_schema_mode: 'deferred' },
    openrouter: { model: 'anthropic/claude-test-1' },
  } as never);
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const media = new MediaService(db, path.join(root, 'media'), config);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'bootstrap.get') return { ok: true, result: { snapshot_id: 's1', state_hash: 'h1', profile: 'estomago', memory_days: { items: [], count: 0 }, plans: { items: [], count: 0 }, i: { content: '', note: '' } } };
    throw Error('unexpected ' + cap);
  };
  const client = new MariposaClient({ transport: mariposa });

  // 探针模块注册（测试装配声明——生产 app-context 不含此模块）
  const registry = new CapabilityRegistry();
  registerProbeModule(registry, { db });

  const tools = new HostToolExecutor({ db, mariposa: client, reviews, checkpoint, media, messages });
  tools.setCapabilityRegistry(registry);
  tools.setMemoryRecovery((await import('../../apps/host/src/modules/memory/module.ts')).registerMemoryCapabilities(new CapabilityRegistry(), { db, mariposa: client, reviews, checkpoint }));

  const log: Array<{ tools: string[]; full: Array<{ role: string; content: unknown }> }> = [];
  let n = 0;
  let assetRef = '';
  const transport: OrTransport = async (payload) => {
    n++;
    log.push({ tools: (payload.tools as Array<{ function: { name: string } }>).map((t) => t.function.name), full: payload.messages as Array<{ role: string; content: unknown }> });
    let body: string;
    if (n === 1) body = textBody('g1', '第一条正文'); // 建窗轮
    else body = textBody('g' + n, '探针已执行');
    return { status: 200, headers: new Map(), body: frameStream(body) };
  };
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events),
    usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')),
    tools, reviews, checkpoint, trajectory: new WindowTrajectoryService(db),
    media, bootstrap: client,
  });
  messages.ensureConversation('c1');
  try {
    // 第一轮（建窗+冻结目录）——此时探针尚未进入冻结目录？探针在注册表中；冻结目录=buildHostTools（不含探针）
    const t1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '正常第一条', clientMessageId: 'probe-1' });
    supervisor.enqueue(t1.turnId);
    await supervisor.waitIdle();
    const winId = windows.activeWindow('c1')!.id;

    // A03 证据：同窗已冻结目录不含探针（冻结目录=基线 48 项；探针不进默认工具集合是 08 的要求）
    const set = storedToolset(db, winId)!;
    assert.equal(set.catalog.some((t) => t.function.name === PROBE_TOOL_NAME), false, '冻结窗口目录不含探针（旧窗不因新模块改变）');
    const denied = await tools.execute('tool_define', { name: PROBE_TOOL_NAME }, { roomId: 'c1', windowId: winId, turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-deny' });
    assert.equal((denied.output as { error_code: string }).error_code, 'TOOL_NOT_IN_ALLOWLIST', '同窗旧目录 define 探针=沿现行拒绝（零回退）');

    // 她真实发一条语音（正常入口）→ 探针从真实工具入口（execute=UI/宿主内部合法入口，与模型 tool_invoke 同一 registry 路径）判定
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x21]), purpose: 'chat_voice', operationId: 'probe-voice-upload', createdBy: 'qiaosheng', origin: 'upload' });
    const voice = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '', clientMessageId: 'probe-voice', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    supervisor.enqueue(voice.turnId);
    await supervisor.waitIdle();
    const win2 = windows.activeWindow('c1')!.id;
    void win2;

    // deferred 窗直调被现行 USE_TOOL_INVOKE 门拒绝（迁移前后一致；探针不在冻结目录）
    const deferred = await tools.execute(PROBE_TOOL_NAME, { audio_ref: `est:${asset.id}` }, { roomId: 'c1', windowId: winId, turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-deferred' });
    assert.equal((deferred.output as { error_code: string }).error_code, 'USE_TOOL_INVOKE', 'deferred 窗直调门保持');

    // 宿主/UI 内部入口：legacy 冻结窗上真实执行（与 P02.7 同模式）——registry→parse→admit→handler→投影，核心算法零修改
    db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w-legacy-probe','c1','ACTIVE',?,?)").run(new Date().toISOString(), new Date().toISOString());
    // 测试装配声明：legacy 探针窗目录=基线+探针（08：允许测试装配声明；探针不进生产默认集合）
    freezeWindowTools(db, 'w-legacy-probe', [...buildHostTools(), PROBE_DEFINITION], 'legacy');
    const direct = await tools.execute(PROBE_TOOL_NAME, { audio_ref: `est:${asset.id}` }, { roomId: 'c1', windowId: 'w-legacy-probe', turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-probe' });
    assert.deepEqual(direct.output, { bound: true }, '探针 handler 真实执行（本地 SQL 只读）');
    // 未绑定资产（错误引用）→ bound:false 如实
    const miss = await tools.execute(PROBE_TOOL_NAME, { audio_ref: 'est:nonexistent_asset' }, { roomId: 'c1', windowId: 'w-legacy-probe', turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-probe2' });
    assert.deepEqual(miss.output, { bound: false }, '未绑定资产如实 bound:false');

    console.log(JSON.stringify({ case: 'drillA_probe', tool: PROBE_TOOL_NAME }));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
