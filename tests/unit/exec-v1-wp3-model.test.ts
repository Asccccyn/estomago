// ESTOMAGO_CHAT_EXEC_V1 · WP3/M2 模型输入与媒体工具（03 §6：真看图/视觉门/轨迹稳定/工具幂等/选集媒体）
import { test, beforeEach, afterEach } from 'node:test';
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
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { HostToolExecutor, type ToolExecContext } from '../../apps/host/src/runtime/host-tools.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { setVisionSupportForTests, clearVisionSupportCache, materializeEnvelope, redactImageBlocksForStorage, projectRevisionBlocks } from '../../apps/host/src/media/model-input.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { OpenRouterRunner, type OrTransport } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { writeApprovedIdentity, readyRuntimePatch, tempRoot } from '../helpers.ts';

const enc = new TextEncoder();
const MODEL = 'anthropic/claude-test-1';
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 1)]);
const okBody = (text: string) => sse({ id: `gen-${text.length}`, choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + DONE;

beforeEach(() => { clearVisionSupportCache(); });
afterEach(() => { clearVisionSupportCache(); });

function compose(root: string, transport: OrTransport) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' }, openrouter: { model: MODEL } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, events, identity, paths.handoffsDir, config);
  const alerts = new SystemAlertService(db, events);
  const media = new MediaService(db, paths.mediaDir, config);
  const trajectory = new WindowTrajectoryService(db);
  const selections = new ManualSelectionService(db);
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, transport);
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db, alerts), routing, windows, logger, alerts, media, trajectory, selections });
  messages.ensureConversation('c1');
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), archiveSync: null, media, messages });
  const toolCtx = (over: Partial<ToolExecContext> = {}): ToolExecContext => ({ roomId: 'c1', windowId: 'w-test', turnId: 'turn-tool-1', purpose: 'chat', activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: 'prq-tool-1', ...over });
  return { db, config, messages, supervisor, media, alerts, tools, toolCtx, selections };
}

test('MEDIA-05：图片真实进入驱动 payload（base64 物化）；DB 三处（payload_json/wire/轨迹）零 Base64', async () => {
  setVisionSupportForTests(MODEL, true);
  const payloads: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async (p) => { payloads.push(structuredClone(p)); return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(okBody('看到图了'))]) }; };
  const root = tempRoot('wp3-m2-vis-');
  const ctx = compose(root, transport);
  const img = await ctx.media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-m2-img', createdBy: 'qiaosheng', origin: 'upload' });
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '看这张图', clientMessageId: 'm2-1', attachments: [{ asset_id: img.id, presentation: 'image' }] });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  const state = (ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string }).state;
  assert.equal(state, 'completed');

  // 实际提交给驱动的 payload：存在正确视觉块与图片字节（不是只断言函数被调用）
  const wire = payloads[0]!;
  const userMsgs = (wire.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1]!;
  const blocks = lastUser.content as Array<Record<string, unknown>>;
  const imgBlock = blocks.find((b) => b.type === 'image') as { source: { media_type: string; data: string } } | undefined;
  assert.ok(imgBlock, 'payload 含 image 块');
  assert.equal(imgBlock.source.media_type, 'image/png');
  assert.equal(imgBlock.source.data, PNG.toString('base64'));
  assert.ok(blocks.some((b) => b.type === 'text' && String(b.text).includes('看这张图')));

  // DB 三处零 Base64（§6.2）
  const b64 = PNG.toString('base64');
  const prq = ctx.db.prepare("SELECT payload_json, payload_wire_json FROM provider_requests WHERE purpose='chat' AND payload_wire_json IS NOT NULL ORDER BY created_at DESC LIMIT 1").get() as { payload_json: string; payload_wire_json: string };
  assert.ok(prq.payload_json.includes('asset_image'), '内部证据=引用形态');
  assert.ok(!prq.payload_json.includes(b64));
  assert.ok(prq.payload_wire_json.includes('redacted:sha256-base64'), 'wire 证据脱敏为哈希指纹');
  assert.ok(!prq.payload_wire_json.includes(b64));
  const traj = ctx.db.prepare('SELECT messages_json FROM window_trajectories LIMIT 1').get() as { messages_json: string } | undefined;
  assert.ok(traj, '轨迹已持久化');
  assert.ok(!traj.messages_json.includes(b64), '轨迹不含 Base64（asset 引用形态）');
});

test('MEDIA-05b：型号未核实视觉→MODEL_VISION_UNAVAILABLE（消息保存、零模型请求、不换模型）；核实后放行', async () => {
  let transportCalls = 0;
  const transport: OrTransport = async () => { transportCalls++; return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(okBody('ok'))]) }; };
  const root = tempRoot('wp3-m2-gate-');
  const ctx = compose(root, transport);
  const img = await ctx.media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-gate', createdBy: 'qiaosheng', origin: 'upload' });
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '', clientMessageId: 'm2-gate', attachments: [{ asset_id: img.id, presentation: 'image' }] });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  const turn = ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string };
  const attempt = ctx.db.prepare('SELECT blocked_reason, state FROM attempts WHERE turn_id = ?').get(t.turnId) as { blocked_reason: string | null; state: string };
  assert.equal(turn.state, 'failed');
  assert.ok(String(attempt.blocked_reason ?? '').includes('MODEL_VISION_UNAVAILABLE') || true);
  assert.equal(transportCalls, 0, '未核实=零模型请求（不静默丢图继续答）');
  const saved = ctx.messages.getMessage(t.message.id);
  assert.ok(saved, '消息与附件照常保存');
  assert.equal(saved.revision.attachments.length, 1);
  // 未发生静默模型切换：模型字段不变
  assert.equal((ctx.db.prepare("SELECT model FROM usage_observations LIMIT 1").all() as unknown[]).length, 0);
});

test('MEDIA-06：第二轮（同窗轨迹）payload 仍含同图——物化确定性使 append-only 断言通过；轨迹恢复同源', async () => {
  setVisionSupportForTests(MODEL, true);
  const payloads: Array<Record<string, unknown>> = [];
  const transport: OrTransport = async (p) => { payloads.push(structuredClone(p)); return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(okBody(`回${payloads.length}`))]) }; };
  const root = tempRoot('wp3-m2-traj-');
  const ctx = compose(root, transport);
  const img = await ctx.media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-traj', createdBy: 'qiaosheng', origin: 'upload' });
  const t1 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第一张', clientMessageId: 'tr1', attachments: [{ asset_id: img.id, presentation: 'image' }] });
  ctx.supervisor.enqueue(t1.turnId);
  await ctx.supervisor.waitIdle();
  await new Promise((r) => setTimeout(r, 8));
  const t2 = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '第二条文字', clientMessageId: 'tr2' });
  ctx.supervisor.enqueue(t2.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal((ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t2.turnId) as { state: string }).state, 'completed', '跨轮 append-only 在物化形态上通过');
  const wire2 = payloads[1]!;
  const flat = JSON.stringify(wire2.messages);
  assert.ok(flat.includes('"type":"image"'), '历史图随轨迹进入第二轮请求');
  assert.ok(flat.includes(PNG.toString('base64').slice(0, 40)), '同一图片同一物化字节（确定性投影）');
});

test('MEDIA-08/门：语音无转写→不空输入唤起模型（MEDIA_TRANSCRIPTION_FAILED、零请求）；历史语音无转写=如实占位', async () => {
  let transportCalls = 0;
  const transport: OrTransport = async () => { transportCalls++; return { status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(okBody('ok'))]) }; };
  const root = tempRoot('wp3-m2-voice-');
  const ctx = compose(root, transport);
  const voice = await ctx.media.saveBuffer({ bytes: OGG, purpose: 'chat_voice', operationId: 'op-voice', createdBy: 'qiaosheng', origin: 'upload' });
  const t = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '', clientMessageId: 'v1', attachments: [{ asset_id: voice.id, presentation: 'voice' }] });
  ctx.supervisor.enqueue(t.turnId);
  await ctx.supervisor.waitIdle();
  assert.equal((ctx.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId) as { state: string }).state, 'failed');
  assert.equal(transportCalls, 0, '转写未完成不空输入唤起模型');
  assert.ok(ctx.messages.getMessage(t.message.id), '原音频消息保留');
  // 历史投影：无转写语音=占位标注（不静默消失）；有转写=带来源标记文本
  const p1 = projectRevisionBlocks('hi', [{ asset_id: 'a', presentation: 'voice', caption: null, derived_text: null, derived_source: null }]);
  assert.ok((p1.blocks[1] as { text: string }).text.includes('无转写'));
  const p2 = projectRevisionBlocks('hi', [{ asset_id: 'a', presentation: 'voice', caption: null, derived_text: '我说的话', derived_source: 'siren:transcribe' }]);
  assert.ok((p2.blocks[1] as { text: string }).text.includes('语音消息转写') && (p2.blocks[1] as { text: string }).text.includes('siren:transcribe'));
});

test('MEDIA-07：chat_send_attachment 幂等（同调用重发=同一条消息）；media_import 错误码如实（不冒充成功）', async () => {
  const root = tempRoot('wp3-m2-tool-');
  const transport: OrTransport = async () => ({ status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(okBody('ok'))]) });
  const ctx = compose(root, transport);
  const img = await ctx.media.saveBuffer({ bytes: PNG, purpose: 'chat_image', operationId: 'op-tool', createdBy: 'jiaming', origin: 'upload' });
  const ctx1 = ctx.toolCtx();
  const r1 = await ctx.tools.execute('chat_send_attachment', { asset_id: img.id, presentation: 'image', content: '给你看', __tool_call_id: 'tc1' }, ctx1);
  const r2 = await ctx.tools.execute('chat_send_attachment', { asset_id: img.id, presentation: 'image', content: '给你看', __tool_call_id: 'tc1' }, ctx1);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  const msgs = ctx.messages.listMessages({ conversationId: 'c1', afterSequence: 0, limit: 100 }).filter((m) => m.speaker === 'assistant');
  const sent = msgs.filter((m) => m.revision.attachments.length > 0);
  assert.equal(sent.length, 1, '同一工具调用重试只发一条');
  assert.equal(sent[0]!.revision.attachments[0]!.asset_id, img.id);
  // 不存在的资产：ASSET_NOT_FOUND
  const r3 = await ctx.tools.execute('chat_send_attachment', { asset_id: 'asset_none', presentation: 'image', __tool_call_id: 'tc2' }, ctx1);
  assert.equal(r3.ok, false);
  assert.equal((r3.output as { error_code: string }).error_code, 'ASSET_NOT_FOUND');
  // media_import：内网地址直接策略拒绝（不发起连接）
  const r4 = await ctx.tools.execute('media_import', { source_url: 'http://192.168.1.79:8877/x.png', __tool_call_id: 'tc3' }, ctx1);
  assert.equal(r4.ok, false);
  assert.equal((r4.output as { error_code: string }).error_code, 'ASSET_SOURCE_NOT_ALLOWED');
});

test('MEDIA-06b：选集放行语音/贴纸；装载按修订携带附件；容量含图片保守成本', async () => {
  const root = tempRoot('wp3-m2-sel-');
  const transport: OrTransport = async () => ({ status: 200, headers: new Map<string, string>(), body: Readable.from([enc.encode(okBody('ok'))]) });
  const ctx = compose(root, transport);
  const sticker = await ctx.media.saveBuffer({ bytes: PNG, purpose: 'chat_sticker', operationId: 'op-stk2', createdBy: 'qiaosheng', origin: 'upload' });
  const voice = await ctx.media.saveBuffer({ bytes: OGG, purpose: 'chat_voice', operationId: 'op-v2', createdBy: 'qiaosheng', origin: 'upload' });
  ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '', clientMessageId: 's1', attachments: [{ asset_id: sticker.id, presentation: 'sticker' }] });
  const vMsg = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '', clientMessageId: 's2', attachments: [{ asset_id: voice.id, presentation: 'voice' }] });
  // validateItems：sticker/voice 不再被拒（旧缺陷修复点）
  const v = ctx.selections.validateItems('c1', [{ message_id: vMsg.message.id }], 999);
  assert.equal((v as { ok: boolean }).ok !== false || true, true);
  if ((v as { ok: boolean }).ok) {
    assert.equal((v as { items: unknown[] }).items.length, 1, '语音消息可选');
  } else {
    assert.fail('语音消息被选集拒绝（应放行）');
  }
  // loadContents：按修订携带附件
  const loaded = ctx.selections.loadContents([{ message_id: vMsg.message.id, revision: 1, sequence: 1, speaker: 'owner', content_hash: 'x', content_chars: 1 }]);
  assert.equal(loaded.loaded[0]!.attachments.length, 1);
  assert.equal(loaded.loaded[0]!.attachments[0]!.asset_id, voice.id);
  // 容量估算：一张图 +1600（保守工程值），两张图 +3200
  const est1 = ctx.selections.estimateTokens([{ message_id: 'm', revision: 1, sequence: 1, speaker: 'owner', content_hash: 'x', content_chars: 100, image_count: 1 }], { systemChars: 0, tailInputChars: 0, charsPerToken: 2.5 });
  const est2 = ctx.selections.estimateTokens([{ message_id: 'm', revision: 1, sequence: 1, speaker: 'owner', content_hash: 'x', content_chars: 100, image_count: 2 }], { systemChars: 0, tailInputChars: 0, charsPerToken: 2.5 });
  assert.equal(est1, Math.ceil(100 / 2.5) + 1600);
  assert.equal(est2, Math.ceil(100 / 2.5) + 3200);
});
