// 相册重构 P5：开窗携带装配合同（GLM_ALBUM_REFACTOR_EXECUTION 20261108，03 §8）。
// 真实 TurnSupervisor 实例上断言：resolveWindowCarry 合并超限→结构化阻断（旧窗不动、
// 不静默丢图）；≤10→携带片段（asset_image 块+留言文本）注入 envelope 的独立 system
// 数据块；装配计数校验兜底（绕过规划器直接塞 11 块→抛错）。无 contentClient 时携带
// 集合如实为空（不阻塞），选集图仍受同一上限。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { OpenRouterRunner } from '../../apps/host/src/runtime/runner-openrouter.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { RoutingService } from '../../apps/host/src/routing/service.ts';
import { WindowManager } from '../../apps/host/src/windows/manager.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { WindowTrajectoryService } from '../../apps/host/src/runtime/window-trajectory.ts';
import { ManualSelectionService } from '../../apps/host/src/context/manual-selection.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { CapabilityMatrix } from '../../apps/host/src/runtime/capabilities.ts';
import { ReasoningService } from '../../apps/host/src/reasoning/service.ts';
import { UsageCollector } from '../../apps/host/src/usage/collector.ts';
import { tempRoot, readyRuntimePatch, writeApprovedIdentity, assembleTestTools } from '../helpers.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);

function compose(root: string) {
  writeApprovedIdentity(root);
  const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, provider: 'openrouter' } });
  const paths = buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  const identity = new IdentityService(config, paths);
  const routing = new RoutingService(db, events, messages);
  const windows = new WindowManager(db, identity, config);
  const alerts = new SystemAlertService(db, events);
  const media = new MediaService(db, paths.mediaDir, config);
  const trajectory = new WindowTrajectoryService(db);
  const selections = new ManualSelectionService(db);
  const { registry } = assembleTestTools({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), archiveSync: null, media, messages });
  const runner = new OpenRouterRunner({ providerOnly: ['anthropic'], allowFallbacks: false, requireParameters: true, retryMax: 0 }, async () => ({ status: 200, headers: new Map<string, string>(), body: Readable.from(['data: {"type":"completion","message":{"content":[{"type":"text","text":"ok"}]}}\n\n']) }));
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db, alerts), routing, windows, logger, alerts, media, trajectory, selections, toolCatalog: registry });
  messages.ensureConversation('c1');
  return { db, messages, supervisor, media, selections, root };
}

async function seedImageMessages(ctx: ReturnType<typeof compose>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const a = await ctx.media.saveBuffer({ bytes: Buffer.concat([PNG, Buffer.from([i])]), purpose: 'chat_image', operationId: `op-carry-${i}`, createdBy: 'qiaosheng', origin: 'upload' });
    ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: `第${i}张`, clientMessageId: `cm-carry-${i}`, attachments: [{ asset_id: a.id, presentation: 'image' }] });
  }
}

type CarrySupervisor = { resolveWindowCarry(c: string, k: string, m: Array<{ message_id: string; attachments?: Array<{ asset_id: string; presentation: string }> }>): Promise<{ fragment: { blocks: Array<{ type: string; text?: string; asset_id?: string }> } | null }>; buildEnvelope(o: Record<string, unknown>): { envelope: { messages: Array<{ role: string; content: unknown }> } } };

test('CARRY-ASM-1: 选集 11 图→resolveWindowCarry 结构化阻断；10 图→片段注入 system 块', async () => {
  const ctx = compose(tempRoot('carry-asm-1-'));
  {
    await seedImageMessages(ctx, 11);
    const ids = (ctx.db.prepare("SELECT id FROM messages WHERE conversation_id='c1' ORDER BY sequence").all() as Array<{ id: string }>).map((r) => r.id);
    const sup = ctx.supervisor as unknown as CarrySupervisor;
    const withAttachments = ids.map((id) => ({
      message_id: id,
      attachments: ctx.db.prepare('SELECT asset_id, presentation FROM message_attachments WHERE message_id = ? ORDER BY position').all(id) as Array<{ asset_id: string; presentation: string }>,
    }));
    // 11 张：合并超限——阻断（无 contentClient 时携带集合为空，选集图自身超限同样拦）
    let blocked: string | null = null;
    try { await sup.resolveWindowCarry('c1', 'pending:c1', withAttachments.slice(0, 11)); } catch (e) { blocked = String((e as Error).message); }
    assert.ok(blocked?.includes('CARRY_IMAGES_EXCEEDED') === true, `11 图应阻断（实际 ${blocked}）`);
    // 10 张：通过；片段含 10 个 asset_image 块与说明文本
    const r = await sup.resolveWindowCarry('c1', 'pending:c1', withAttachments.slice(0, 10));
    assert.ok(r.fragment, '10 图应有携带片段');
    const blocks = r.fragment!.blocks;
    assert.equal(blocks.filter((b) => b.type === 'asset_image').length, 10);
    assert.match((blocks[0] as { text: string }).text, /开窗携带照片 10 张/);
    // 注入 envelope：独立 system 数据块（B 段之后），含 10 图
    const built = sup.buildEnvelope({ conversationId: 'c1', materials: null, dialogue: [], tailUserText: ' ', selectedMessages: [], carryFragment: r.fragment });
    const sysImgMsg = built.envelope.messages.filter((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === 'asset_image'));
    assert.equal(sysImgMsg.length, 1, '携带图集中在独立 system 数据块');
    assert.equal(sysImgMsg[0]!.role, 'system');
  }
});

test('CARRY-ASM-2: 装配兜底——绕过规划器塞 11 个图像块→buildEnvelope 抛错（不静默截断）', async () => {
  const ctx = compose(tempRoot('carry-asm-2-'));
  {
    await seedImageMessages(ctx, 11);
    const ids = (ctx.db.prepare("SELECT id FROM messages WHERE conversation_id='c1' ORDER BY sequence").all() as Array<{ id: string }>).map((r) => r.id);
    const sup = ctx.supervisor as unknown as CarrySupervisor;
    const loaded11 = ids.slice(0, 11).map((id) => ({
      message_id: id, revision: 1, sequence: 1, role: 'user' as const, content: 'x', occurred_at: null,
      attachments: ctx.db.prepare('SELECT asset_id, presentation FROM message_attachments WHERE message_id = ? ORDER BY position').all(id) as Array<{ asset_id: string; presentation: string }>,
    }));
    let asmBlocked: string | null = null;
    try { sup.buildEnvelope({ conversationId: 'c1', materials: null, dialogue: [], tailUserText: ' ', selectedMessages: loaded11 }); } catch (e) { asmBlocked = String((e as Error).message); }
    assert.ok(asmBlocked?.includes('CARRY_IMAGES_EXCEEDED') === true, `装配应兜底阻断（实际 ${asmBlocked}）`);
  }
});
