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

function compose(root: string, opts: { contentClient?: unknown } = {}) {
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
  const supervisor = new TurnSupervisor({ db, config, messages, events, identity, capabilities: new CapabilityMatrix(config), runnerSelection: { status: 'ok', runner }, reasoning: new ReasoningService(db, events), usage: new UsageCollector(db, alerts), routing, windows, logger, alerts, media, trajectory, selections, toolCatalog: registry, ...(opts.contentClient ? { contentClient: opts.contentClient as never } : {}) });
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
    // 10 张纯选集图：额度占用 10（≤上限通过），但片段=null——图块由选集历史消息投影
    // 携带（ALB-07：片段不再重复注入，旧缺陷 6 张被算 12 块）
    const r = await sup.resolveWindowCarry('c1', 'pending:c1', withAttachments.slice(0, 10));
    assert.equal(r.fragment, null, '纯选集图无相册携带——不产片段（历史投影即图块载体）');
    const planRow = ctx.db.prepare('SELECT plan_json FROM window_carry_plans WHERE window_id = ?').get('pending:c1') as { plan_json: string };
    const plan = JSON.parse(planRow.plan_json) as { ok: boolean; images: unknown[] };
    assert.equal(plan.ok, true);
    assert.equal(plan.images.length, 10, '合并额度占用 10 张');
    // 相册携带路径：给一张不在选集的携带图 → 片段含 1 图块（独立 system 数据块）
    const frag = { blocks: [{ type: 'text', text: '[开窗携带照片 1 张]（来自相册携带设置）\n1. 留言' }, { type: 'asset_image', asset_id: 'asset_album_x', projection_version: 'v1' }] };
    const built = sup.buildEnvelope({ conversationId: 'c1', materials: null, dialogue: [], tailUserText: ' ', selectedMessages: [], carryFragment: frag });
    const sysImgMsg = built.envelope.messages.filter((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === 'asset_image'));
    assert.equal(sysImgMsg.length, 1, '相册携带图集中在独立 system 数据块');
    assert.equal(sysImgMsg[0]!.role, 'system');
  }
});

test('ARC-STOP：stopActiveForConversation 停掉会话最新未终态回合（争吵存档停止链，持久终态）', async () => {
  const ctx = compose(tempRoot('arc-stop-'));
  {
    const t0 = new Date().toISOString();
    ctx.db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES ('turn_old','c1','user_input','completed',?)").run(t0);
    ctx.db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES ('turn_stop_me','c1','user_input','pending',?)").run(t0);
    const sup = ctx.supervisor as unknown as { stopActiveForConversation(c: string, e?: string | null): { stoppedTurnId: string } | null };
    const stopped = sup.stopActiveForConversation('c1');
    assert.ok(stopped, '应停掉 pending 回合');
    assert.equal(stopped!.stoppedTurnId, 'turn_stop_me');
    const after = ctx.db.prepare("SELECT state FROM turns WHERE id = 'turn_stop_me'").get() as { state: string };
    assert.match(after.state, /failed|blocked/, '持久终态（不随进程丢失，重启不复活）');
    assert.equal(sup.stopActiveForConversation('c1'), null, '无未终态回合后再停=null（幂等不误伤）');
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

test('CARRY-ASM-4 (P1-b 审计 2026-11-15): content 已配置但 carry-set 读不到→准备明确失败，不按空携带冻结空计划', async () => {
  // 死端口 content：配置了但不可达——resolveWindowCarry 必须抛 CARRY_SET_UNREADABLE
  // （旧实现 warn 后按空携带继续，滚窗冻结空计划、本窗永久丢携带图）。
  const ctx = compose(tempRoot('carry-asm-4-'), { contentClient: { baseUrl: 'http://127.0.0.1:1', token: 'x' } });
  const sup = ctx.supervisor as unknown as CarrySupervisor;
  let blocked: string | null = null;
  try { await sup.resolveWindowCarry('c1', 'pending:c1', []); } catch (e) { blocked = String((e as Error).message); }
  assert.ok(blocked?.startsWith('CARRY_SET_UNREADABLE'), `应明确失败（实际=${blocked ?? '未抛'}）`);
  ctx.db.close();
});
