// B1 补充断言（2026-10-24，RE-05/V08）：oido_view 工具结果与图分路——
// 模型 JSON 无 base64（REV-E06 已覆盖工具层）；本文件验证驱动层：
// ① vision 已核实型号 → 工具消息正文=[文本JSON + asset_image 引用]，发送边界物化为
//    原生 image 块（wire 捕获、存储侧脱敏）；
// ② 未核实型号 → 工具消息仅文本（工具 JSON 内如实声明图未携带）。
import { test } from 'node:test';
import { assembleTestTools, readyRuntimePatch, tempRoot, writeApprovedIdentity } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { setVisionSupportForTests, clearVisionSupportCache } from '../../apps/host/src/media/model-input.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-view-1';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
// 1×1 真实 PNG（魔数完整可过 sniff）
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const okBody = (text: string) => sse({ id: `gen-${text.length}`, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;

function compose(root: string, transport: OrTransport) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter', tool_schema_mode: 'deferred' }, openrouter: { model: MODEL } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const media = new MediaService(db, paths.mediaDir, config);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, new EventService(db), messages);
  const windows = new WindowManager(db, new EventService(db), identity, config);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const oidoAdapter = {
    configured: true,
    capabilities: async () => ({ ok: true }),
    getView: async (id: string) => ({ mime: 'image/png', pngBase64: PNG.toString('base64'), metadata: { analysis_id: id } }),
  };
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), media: media, messages: messages, oido: oidoAdapter as never });
  const supervisor = new TurnSupervisor({ db, config, messages, events: new EventService(db), identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, new EventService(db)), usage: new UsageCollector(db), routing, windows, logger: new Logger(path.join(root, 'logs')), tools, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), trajectory: new WindowTrajectoryService(db), media, oidoHearing: true });
  return { db, config, messages, supervisor, media, tools, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

async function runVoiceViewRound(visionSupported: boolean | null): Promise<{ payloads: Array<Record<string, unknown>>; toolFrames: Array<Record<string, unknown>> }> {
  const payloads: Array<Record<string, unknown>> = [];
  let step = 0;
  let definitionId = '';
  const analysisId = 'an-native';
  const transport: OrTransport = async (p) => {
    payloads.push(structuredClone(p) as Record<string, unknown>);
    const last = (p.messages as Array<Record<string, unknown>>).at(-1);
    if (last?.role === 'tool') {
      const c = last.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.filter((b) => (b as { type?: string }).type === 'text').map((b) => (b as { text?: string }).text).join('')) : '';
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.definition_id === 'string') definitionId = parsed.definition_id;
    }
    const toolCall = (name: string, args: Record<string, unknown>) => sse({ id: `view-${payloads.length}`, choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${payloads.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;
    let body: string;
    if (step === 0) { step++; body = toolCall('tool_define', { name: 'oido_view' }); }
    else if (step === 1) { step++; body = toolCall('tool_invoke', { name: 'oido_view', definition_id: definitionId, arguments: { analysis_id: analysisId } }); }
    else body = okBody('合成回复');
    return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(body)]) };
  };
  const ctx = compose(tempRoot('b1-view-'), transport);
  try {
    setVisionSupportForTests(MODEL, visionSupported);
    // 合法源：发布语音消息附件 + analysis 绑定
    const asset = await ctx.media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x00]), purpose: 'chat_voice', operationId: 'op-view-native', createdBy: 'q', origin: 'upload' });
    ctx.messages.publishAssistantMessage({ conversationId: 'c1', turnId: 't-view', content: '', kind: 'voice', clientMessageId: 'm-view', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    ctx.db.prepare('INSERT INTO oido_source_bindings(analysis_id,conversation_id,asset_id,content_sha256) VALUES (?,?,?,?)').run('an-native', 'c1', asset.id, (ctx.db.prepare('SELECT content_sha256 FROM media_assets WHERE id=?').get(asset.id) as { content_sha256: string }).content_sha256);
    const sub = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '请看这条的测量图。', clientMessageId: 'view-ask' });
    ctx.supervisor.enqueue(sub.turnId);
    await ctx.supervisor.waitIdle();
    const state = ctx.db.prepare('SELECT state FROM turns WHERE id=?').get(sub.turnId) as { state: string };
    assert.equal(state.state, 'completed', JSON.stringify(ctx.db.prepare('SELECT state FROM attempts WHERE turn_id=?').all(sub.turnId)));
    const toolFrames = payloads.flatMap((p) => (p.messages as Array<Record<string, unknown>>).filter((m) => m.role === 'tool'));
    return { payloads, toolFrames };
  } finally {
    clearVisionSupportCache();
    await ctx.supervisor.stopAll();
    ctx.close();
  }
}

test('B1SUP vision-verified model receives native image block in tool result', async () => {
  const { toolFrames } = await runVoiceViewRound(true);
  console.log('FRAMES', JSON.stringify(toolFrames.map((m) => ({ shape: typeof m.content === 'string' ? 'string' : Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>).map((b) => b.type).join('+') : 'other' }))));
  const withImage = toolFrames.filter((m) => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'image'));
  assert.ok(withImage.length >= 1, 'expected a tool message carrying a materialized native image block');
  const frame = withImage.at(-1)!;
  const blocks = frame.content as Array<Record<string, unknown>>;
  const img = blocks.find((b) => b.type === 'image') as { source?: { type?: string; media_type?: string; data?: string } };
  assert.equal(img.source?.type, 'base64');
  assert.equal(img.source?.media_type, 'image/png');
  assert.ok(typeof img.source?.data === 'string' && (img.source!.data as string).length >= 40, 'expected real base64 payload (1×1 PNG ≈44 chars)');
  const textBlock = blocks.find((b) => b.type === 'text') as { text?: string };
  const parsed = JSON.parse(textBlock!.text!) as Record<string, unknown>;
  assert.ok(!('image_base64' in parsed), 'tool JSON must not carry base64');
  console.log(JSON.stringify({ case: 'b1sup_native_image', blocks: blocks.map((b) => b.type), imageBytes: Buffer.from(img.source!.data! as string, 'base64').length }));
});

test('B1SUP non-vision model gets text-only tool result with honest note', async () => {
  const { toolFrames } = await runVoiceViewRound(false);
  const viewFrames = toolFrames.filter((m) => {
    const c = m.content;
    if (typeof c !== 'string') return true; // any non-string content would be a violation here
    return c.includes('"analysis_id"');
  });
  assert.ok(viewFrames.length >= 1, 'expected the oido_view tool receipt');
  for (const m of viewFrames) {
    assert.equal(typeof m.content, 'string', 'non-vision model must not receive image blocks');
    const parsed = JSON.parse(m.content as string) as Record<string, unknown>;
    assert.ok(!('image_base64' in parsed));
  }
  console.log(JSON.stringify({ case: 'b1sup_text_only', frames: viewFrames.length }));
});
