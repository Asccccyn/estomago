// P02.7 / A01：oido_get 真实 Host 接线离线合同。
// 前置经正常入口建立：她真实发送语音（MessageService 正常路径）→ oido_analyze 经旧路径
//（尚未迁，合法）+ 边界 fake HTTP 建立分析绑定 → 真实模型回合 catalog→define→invoke(oido_get)。
// 断言：新 handler=1；旧 handler=0（私有方法已删）；同定义同结果；通话内允许（D39）；
// 前台普通调用不被背景报价门挡（D40）；取消沿 CANCELLED；定义唯一来源。
import { test, before, after } from 'node:test';
import { assembleTestTools, fullToolCatalog, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
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
import { storedToolset, freezeWindowTools, definitionId } from '../../apps/host/src/runtime/tool-discovery.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { OidoAdapter } from '../../apps/host/src/integrations/oido/adapter.ts';
import { oidoModelView } from '../../apps/host/src/integrations/oido/model-view.ts';
import { CapabilityRegistry } from '../../apps/host/src/capabilities/registry.ts';
import { oidoGetCapability, oidoAnalyzeCapability, OIDO_GET_DEFINITION } from '../../apps/host/src/modules/oido/module.ts';

const CREDENTIAL = 'ESTOMAGO_TEST_OIDO_CREDENTIAL';
const OVERVIEW = { analysis_id: 'run_t1', revision: 1, state: 'ready', range_ms: [0, 1200], observations: [] };
const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const callFrame = (n: number, name: string, args: unknown) =>
  sse({ id: 'g' + n, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call' + n, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));

before(() => { process.env[CREDENTIAL] = 'unit-only-oido-token'; });
after(() => { delete process.env[CREDENTIAL]; });

test('A01/P02.7: 真实 Host 经 tool_define/invoke 调用已迁 oido_get——新handler=1、旧handler=0、同定义同结果、通话/前台/取消政策保持', async () => {
  const root = tempRoot('oido-wire-');
  writeApprovedIdentity(root);
  const config = buildConfig({
    ...readyRuntimePatch(),
    runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter', tool_schema_mode: 'deferred' },
    openrouter: { model: 'anthropic/claude-test-1' },
    integrations: { oido: { base_url: 'http://127.0.0.1:8791', credential_ref: CREDENTIAL } },
  } as never);
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const media = new MediaService(db, path.join(root, 'media'), config);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, config) // 合并对齐：handoffsDir 已随 handoff 退役移除（集成侧 2026-10-24 裁定）;
  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const oido = new OidoAdapter(config.integrations.oido);

  // 边界 fake：仅 oído HTTP（ingest/analyze/overview）；Mariposa bootstrap 走最小包
  const oidoCalls: string[] = [];
  const origFetch = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = (async (url: any, opts: any) => {
    const u = String(url);
    oidoCalls.push(`${opts?.method ?? 'GET'} ${u.replace('http://127.0.0.1:8791', '')}`);
    if (u.endsWith('/v1/audio:ingest')) return Response.json({ audio_id: 'aud_t1', deduplicated: false });
    if (u.endsWith('/v1/analyses') && opts?.method === 'POST') return Response.json(OVERVIEW);
    if (u.endsWith('/v1/analyses/run_t1')) return Response.json(OVERVIEW);
    return Response.json({}, { status: 404 });
  }) as typeof fetch;

  // 注册表：显式登记 oido_get，并包一层计数（新 handler 计数）
  let newHandlerCalls = 0;
  const registry = new CapabilityRegistry();
  const descriptor = oidoGetCapability({ db, oido, sources: new ((await import('../../apps/host/src/modules/oido/source-repository.ts')).OidoSourceRepository)(db) });
  const origRun = descriptor.run;
  descriptor.run = async (input, ctx) => { newHandlerCalls++; return origRun(input, ctx); };
  registry.register(descriptor);
  // 生产装配自 P03 起同时登记 oido_analyze（尚未迁入的其余 oído 工具走旧路径）
  registry.register(oidoAnalyzeCapability({ db, oido, sources: new ((await import('../../apps/host/src/modules/oido/source-repository.ts')).OidoSourceRepository)(db), audio: media }));

  const mariposa: MariposaTransport = async (cap) => {
    if (cap === 'bootstrap.get') return { ok: true, result: { snapshot_id: 'snap_t1', state_hash: 'h1', profile: 'estomago', memory_days: { items: [], count: 0 }, plans: { items: [], count: 0 }, i: { content: '', note: '' } } };
    throw Error('unexpected ' + cap);
  };
  const { tools: tools } = assembleTestTools({ db: db, mariposa: new MariposaClient({ transport: mariposa }), reviews: reviews, checkpoint: checkpoint, media: media, messages: messages });
  tools.setCapabilityRegistry(registry);

  // 真实模型回合：turn1=普通文本；随后宿主内部分析建绑定；turn2=catalog→define→invoke(oido_get)
  const log: Array<{ tools: string[]; full: Array<{ role: string; content: unknown }> }> = [];
  let n = 0;
  let assetRef = '';
  const transport: OrTransport = async (payload) => {
    n++;
    log.push({ tools: (payload.tools as Array<{ function: { name: string } }>).map((t) => t.function.name), full: payload.messages as Array<{ role: string; content: unknown }> });
    let body: string;
    // turn1：define→invoke(oido_analyze)（未迁工具=旧路径；前置经真实模型入口建立）
    if (n === 1) body = callFrame(1, 'tool_define', { name: 'oido_analyze' });
    else if (n === 2) body = callFrame(2, 'tool_invoke', { name: 'oido_analyze', definition_id: JSON.parse((payload.messages.at(-1) as { content: string }).content).definition_id, arguments: { audio_ref: assetRef } });
    else if (n === 3) body = textBody('g3', '合成回复一');
    // turn2：define→invoke(oido_get)（已迁工具=registry 新路径）
    else if (n === 4) body = callFrame(4, 'tool_define', { name: 'oido_get' });
    else if (n === 5) body = callFrame(5, 'tool_invoke', { name: 'oido_get', definition_id: JSON.parse((payload.messages.at(-1) as { content: string }).content).definition_id, arguments: { analysis_id: 'run_t1' } });
    else body = textBody('g' + n, '合成回复二');
    return { status: 200, headers: new Map(), body: frameStream(body) };
  };
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({bootstrap: new MariposaClient({ transport: mariposa }), // S18：显式 BootstrapPort（原经 tools.mariposaClient 隐式取得）
    
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events),
    usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')),
    tools, reviews, checkpoint, trajectory: new WindowTrajectoryService(db),
    media, oidoHearing: true,
  });
  messages.ensureConversation('c1');
  try {
    // 前置①（正常入口）：她真实发送一条语音；模型在同回合经真实 define→invoke(oido_analyze)
    // （未迁工具=旧路径）建立 analysis↔源绑定
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x09]), purpose: 'chat_voice', operationId: 'wire-voice-upload', createdBy: 'qiaosheng', origin: 'upload' });
    assetRef = `est:${asset.id}`;
    const submitted = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '', clientMessageId: 'wire-voice', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    supervisor.enqueue(submitted.turnId);
    await supervisor.waitIdle();
    const winId = windows.activeWindow('c1')!.id;
    const analyzeOut = JSON.parse((log[2]!.full.at(-1) as { content: string }).content);
    assert.equal(analyzeOut.analysis_id, 'run_t1', `oido_analyze 经真实入口建绑定成功（旧路径）：${JSON.stringify(analyzeOut).slice(0, 200)}`);
    assert.equal(newHandlerCalls, 0, 'analyze 未迁，新 handler 不应被调用');

    // turn2：真实模型入口 catalog→define→invoke(oido_get)
    const turn2 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '读一下深听结果', clientMessageId: 'wire-get' });
    supervisor.enqueue(turn2.turnId);
    await supervisor.waitIdle();

    // A01 断言
    assert.equal(newHandlerCalls, 1, '新 handler 恰好执行一次');
    assert.equal((tools as unknown as { oidoGet?: unknown }).oidoGet, undefined, '旧 handler 已删除（旧业务分支归零）');
    assert.equal(oidoCalls.some((c) => c === 'POST /v1/analyses'), true, 'adapter 真实收到 analyze 请求');
    assert.equal(oidoCalls.some((c) => c.endsWith('/v1/analyses/run_t1')), true, 'adapter 真实收到 overview 请求');
    const defineOut = JSON.parse((log[4]!.full.at(-1) as { content: string }).content);
    assert.equal(defineOut.definition_id, definitionId(OIDO_GET_DEFINITION), 'define 输出=模块正本定义的 definitionId');
    const set = storedToolset(db, winId)!;
    assert.equal(definitionId(set.catalog.find((t) => t.function.name === 'oido_get')!), definitionId(OIDO_GET_DEFINITION), '冻结目录与模块正本同源（单一定义来源）');
    const invokeOut = JSON.parse((log[5]!.full.at(-1) as { content: string }).content);
    assert.deepEqual(invokeOut, oidoModelView(OVERVIEW, false), 'wire 结果=唯一模型投影（同定义同结果）');
    // deferred 窗宿主直调被现行 USE_TOOL_INVOKE 门拒绝（迁移前后一致的政策，不因迁移改变）
    const direct = await tools.execute('oido_get', { analysis_id: 'run_t1' }, { roomId: 'c1', windowId: winId, turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-direct' });
    assert.equal((direct.output as { error_code: string }).error_code, 'USE_TOOL_INVOKE', 'deferred 窗直调门保持');

    // 政策断言在 legacy 冻结窗上执行（直调合法面；与既有 executorFixture 测试同模式）
    db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w-legacy','c1','ACTIVE',?,?)").run(new Date().toISOString(), new Date().toISOString());
    freezeWindowTools(db, 'w-legacy', fullToolCatalog(), 'legacy');
    const legacyCtx = { roomId: 'c1', windowId: 'w-legacy', turnId: null as string | null, purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [] as never, requestId: 'req-legacy' };
    // D40：前台普通调用（无背景 run/无报价配置）不被强加背景报价门
    const fg = await tools.execute('oido_get', { analysis_id: 'run_t1' }, { ...legacyCtx, requestId: 'req-fg' });
    assert.equal(fg.ok, true, `前台调用不查背景报价：${JSON.stringify(fg.output).slice(0, 160)}`);
    assert.deepEqual(fg.output, invokeOut, 'legacy 直调与模型 wire 同结果（同定义同结果）');
    // D39：通话内 oido_get 允许（memoryOnlyAllowed=true；通用判定不新增报价/门）
    db.prepare("INSERT OR REPLACE INTO voice_calls(call_id,conversation_id,state,started_at) VALUES ('call_t','c1','active',?)").run(new Date().toISOString());
    const inCall = await tools.execute('oido_get', { analysis_id: 'run_t1' }, { ...legacyCtx, turnId: 't-call', requestId: 'req-call' });
    assert.equal(inCall.ok, true, '通话内轻量 oído 能力放行');

    // 取消语义与基线相同：abort→CANCELLED
    const ac = new AbortController();
    ac.abort();
    const cancelled = await tools.execute('oido_get', { analysis_id: 'run_t1' }, { ...legacyCtx, requestId: 'req-cancel', signal: ac.signal });
    assert.equal(cancelled.ok, false);
    assert.equal((cancelled.output as { error_code: string }).error_code, 'CANCELLED');
  } finally {
    (globalThis as { fetch?: typeof fetch }).fetch = origFetch;
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
