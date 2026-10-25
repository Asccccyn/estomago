// P08 演练A 重做（S17 裁定 §6 / A26·A03）：真实模型扩展场景。
// 序列（全部经正常入口，无手工 INSERT 窗口/目录）：
//  ① c1 正常消息 → 旧窗 w1 冻结目录证据（不含 probe——注册发生在其后）
//  ② 仅在测试装配注册 probe（新模块文件+装配一行，核心零修改）
//  ③ 旧窗 w1 目录保持原样；旧窗 define probe 沿现行拒绝（零回退）
//  ④ c2 正常消息 → 新窗 w2 装配目录含 probe（新窗采用）
//  ⑤ fake 模型实际执行 catalog→define→invoke(probe)
//  ⑥ 断言真实 probe 返回进入下一模型请求的 tool 内容
// probe 只拿窄结构端口 PublishedVoiceReader（装配处用 OidoSourceRepository 既有谓词实现）。
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
import { storedToolset, freezeWindowTools, definitionId } from '../../apps/host/src/runtime/tool-discovery.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { OidoSourceRepository } from '../../apps/host/src/modules/oido/source-repository.ts';
import { wireOidoCapabilitiesForTest } from '../helpers.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';
import { registerProbeModule, PROBE_TOOL_NAME } from '../helpers/probe-module.ts';

const enc = new TextEncoder();
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const textBody = (id: string, text: string) => sse({ id, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
const callFrame = (n: number, name: string, args: unknown) =>
  sse({ id: 'g' + n, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call' + n, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + DONE;
const frameStream = (body: string) => Readable.from(body.split('\n\n').filter((x) => x.length > 0).map((x) => enc.encode(`${x}\n\n`)));

test('演练A：probe 经正常新窗入口 catalog→define→invoke 全链；旧窗零回退（A26/A03）', async () => {
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

  // ① 生产模块装配（无 probe）——旧窗先于探针注册创建；registry=生产模块注册表（helper 返回同一实例）
  const tools = new HostToolExecutor({ db, mariposa: client, reviews, checkpoint, media, messages });
  const registry = wireOidoCapabilitiesForTest(tools, {});

  const log: Array<{ tools: string[]; full: Array<{ role: string; content: unknown }> }> = [];
  let n = 0;
  let assetRefC2 = '';
  let phase = 0; // c2 轮次脚本：0=define,1=invoke,2=收尾
  const transport: OrTransport = async (payload) => {
    n++;
    log.push({ tools: (payload.tools as Array<{ function: { name: string } }>).map((t) => t.function.name), full: payload.messages as Array<{ role: string; content: unknown }> });
    let body: string;
    if (phase === 0 && n >= 2) { phase = 1; body = callFrame(n, 'tool_define', { name: PROBE_TOOL_NAME }); }
    else if (phase === 1) { phase = 2; console.log('INVOKE_DEBUG', JSON.stringify({ assetRefC2, last: String((payload.messages.at(-1) as any)?.content).slice(0, 80) })); body = callFrame(n, 'tool_invoke', { name: PROBE_TOOL_NAME, definition_id: JSON.parse((payload.messages.at(-1) as { content: string }).content).definition_id, arguments: { audio_ref: assetRefC2 } }); }
    else body = textBody('g' + n, phase === 2 ? '探针结果已收到' : '正常回复');
    return { status: 200, headers: new Map(), body: frameStream(body) };
  };
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({
    db, config, messages, events, identity, capabilities: new CapabilityMatrix(config),
    runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events),
    usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')),
    tools, reviews, checkpoint, trajectory: new WindowTrajectoryService(db),
    media, bootstrap: client, toolCatalog: registry,
  });
  messages.ensureConversation('c1');
  try {
    // ① 旧窗 w1（probe 未注册）
    const t1 = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '旧窗正常第一条', clientMessageId: 'drill-old' });
    supervisor.enqueue(t1.turnId);
    await supervisor.waitIdle();
    const w1 = windows.activeWindow('c1')!.id;
    const frozenOld = storedToolset(db, w1)!.catalog.map((t) => t.function.name);
    assert.ok(!frozenOld.includes(PROBE_TOOL_NAME), '旧窗冻结目录不含后注册探针（目录证据）');

    // ② 仅测试装配注册 probe（新模块+装配一行）
    const sources = new OidoSourceRepository(db);
    registerProbeModule(registry, {
      publishedVoiceReader: { isPublishedVoiceInRoom: (assetId, roomId) => sources.sourceAllowed(assetId, roomId) },
    });

    // ③ 旧窗保持原目录；define probe 沿现行拒绝（零回退）
    const frozenAfter = storedToolset(db, w1)!.catalog.map((t) => t.function.name);
    assert.deepEqual(frozenAfter, frozenOld, '注册 probe 后旧窗冻结目录逐项不变');
    const denied = await tools.execute('tool_define', { name: PROBE_TOOL_NAME }, { roomId: 'c1', windowId: w1, turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'drill-deny' });
    assert.equal((denied.output as { error_code: string }).error_code, 'TOOL_NOT_IN_ALLOWLIST', '旧窗 define 探针=沿现行拒绝');

    // ④ c2 正常入口 → 新窗 w2 装配目录含 probe；已发布语音（正式发布链，probe 的读面素材）
    messages.ensureConversation('c2');
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x21]), purpose: 'chat_voice', operationId: 'probe-voice-c2', createdBy: 'qiaosheng', origin: 'upload' });
    assetRefC2 = `est:${asset.id}`; // 赋值须在 t2 前（同一轮 tool 循环内引用）
    messages.publishAssistantMessage({ conversationId: 'c2', turnId: 'drill-voice-turn', content: '', kind: 'voice', clientMessageId: 'probe-voice', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    const t2 = messages.submitUserMessageWithTurn({ conversationId: 'c2', content: '检查那条语音', clientMessageId: 'probe-check' });
    supervisor.enqueue(t2.turnId);
    await supervisor.waitIdle();
    const w2 = windows.activeWindow('c2')!.id;
    const cat2 = storedToolset(db, w2)!.catalog;
    assert.ok(cat2.some((t) => t.function.name === PROBE_TOOL_NAME), '新窗装配目录含已注册探针（新窗采用）');

    // ⑤⑥ fake 模型 catalog→define→invoke(probe)；probe 结果进入下一模型请求 tool 内容
    const t3 = messages.submitUserMessageWithTurn({ conversationId: 'c2', content: '检查那条语音', clientMessageId: 'probe-check' });
    supervisor.enqueue(t3.turnId);
    await supervisor.waitIdle();
    // 请求序列：log0=c1 轮；log1=c2 定义调用；log2=定义结果+invoke 调用；log3=invoke 结果（进入下一模型请求）
    assert.ok(log.length >= 4, 'catalog→define→invoke→收尾 四请求');
    const defineOut = JSON.parse((log[2]!.full.at(-1) as { content: string }).content);
    assert.equal(defineOut.name, PROBE_TOOL_NAME, 'define 输出=探针定义（registry 工厂正本）');
    assert.equal(defineOut.definition_id, definitionId((await import('../helpers/probe-module.ts')).PROBE_DEFINITION), 'definitionId=探针定义序列化');
    const invokeRequest = log[3]!.full;
    const invokeOut = JSON.parse((invokeRequest.at(-1) as { content: string }).content);
    assert.deepEqual(invokeOut, { bound: true }, 'probe handler 真实执行：已发布语音被窄端口授权读面判定为 bound');
    // probe 结果已作为 tool 消息进入下一模型请求（⑥）
    assert.equal((invokeRequest.at(-1) as { role: string }).role, 'tool', 'probe 结果以 tool 消息进入下一模型请求');

    console.log(JSON.stringify({ case: 'drillA_redo', w1tools: frozenOld.length, w2HasProbe: true }));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
