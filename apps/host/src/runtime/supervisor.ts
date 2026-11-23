import { isVoiceCallActive } from '../modules/voice/call-service.ts';
import { selectionGuides } from '../context/selection-projection.ts';
import type { RotationCause } from '../context/manual-selection.ts';
import { supportsSurfacingTransport, surfaceTransportMessage } from '../context/contribution-transport.ts';
import { oidoHearingAvailable as voiceHearingPort } from '../application/voice-hearing-port.ts';
// P2 §6.6：聊天语音观察的准备预算（独立于自动浮现 300s；只等已在途的分析，超时冻结"尚未就绪"）
const VOICE_OBSERVATION_PREP_BUDGET_MS = 4000;
// Turn Supervisor v0.2.2（AUD-03/05/10/25 修复版）：
//  - 会话级路由 gate：任一 pending 票据冻结整个房间的模型执行（输入仍可持久化排队）。
//  - route signal 到达：一个控制序列内完成 持久票据→generation fence→标记 attempt→abort→
//    reasoning interrupted；fence 之后旧代增量一律丢弃，绝不发布。
//  - 会话连续性：window.sdk_session_id 持久化；同窗后续轮 resume；首轮/新窗创建新 session；
//    重启后从 DB 恢复（AUD-03）。
//  - 确定性终态：runner throw / error result / 无 result / abort 都落定 turn+attempt+reasoning
//    的确定状态；无 success result 不得 completed（AUD-25）。
//  - 启动 recovery pass：扫描孤儿 running/streaming，标记 RECOVERY_HOST_RESTART，不重跑模型。
//  - 日志只记稳定错误码/ID/计数（AUD-28）。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import type { Config } from '../config/schema.ts';
import type { MessageService } from '../messages/service.ts';
import type { EventService } from '../events/service.ts';
import type { IdentityService } from '../identity/service.ts';
import type { CapabilityMatrix } from './capabilities.ts';
import { subscriptionSdkOptions } from './build-options.ts';
import { SubscriptionAccessRunner } from './subscription-access.ts';
import { SDK_MODEL_OPTIONS } from './runtime-settings.ts';
import { lastRequestUsageForWindow, providerInputTotal } from '../usage/attribution.ts';
import type { RunnerSelection } from './runner.ts';
import type { ReasoningService } from '../reasoning/service.ts';
import type { UsageCollector } from '../usage/collector.ts';
import type { RoutingService } from '../routing/service.ts';
import type { WindowManager } from '../windows/manager.ts';
import type { Logger } from '../observability/logging.ts';
import { buildTimeContext, modelTimeContextText } from '../time/context.ts';
import { contextFingerprint } from '../identity/service.ts';
import { assembleContext } from '../context/assembler.ts';
import { HOST_BOUNDARY_RULES } from '../context/fixed-runtime.ts';
import { estimateRotationWorkingSet, systemFragmentChars } from './rotation-estimate.ts';
import { selectionEstimateContext, selectionCutoffSequence, selectionPendingInputChars } from '../context/selection-estimate.ts';
import { buildPreRotateReviewMessage } from '../context/review-prompts.ts';
import { rotationPlan, selectReviewRange, rawKey, type ManifestEntry } from '../context/review-policy.ts';
import type { RotationReviewService } from '../context/rotation-review.ts';
import type { HoldCheckpointService } from '../memory/hold-checkpoint.ts';
import { orSessionId } from './runner-openrouter.ts';
import { dsSessionId, buildDeepSeekPayload } from './runner-deepseek.ts';
import { buildOrPayload, withoutCacheMarkers, type OrMessage } from './or-payload.ts';
import { planBoundaries, tailBoundaryOf, fixedSystemCount } from './cache-plan.ts';
import { contextFingerprintJson, contextFingerprintOf } from './context-fingerprint.ts';
import type { WindowTrajectoryService } from './window-trajectory.ts';
import type { HostToolSpec } from '../capabilities/contracts.ts';
import { buildDeferredTools, buildDirectTools, freezeWindowTools, effectiveToolName, toolsetForTask } from './tool-discovery.ts';
import { compactUnsentToolResults } from './tool-result-retention.ts';
import { recordToolContext, taskDefinitionContext } from './tool-discovery.ts';
import { readTurnCompletion, TURN_COMPLETION_TOOL } from './turn-completion.ts';
import { appendCompletionToolReceipt, stageTurnCompletion, stageHeartbeatCheckpoint, markHeartbeatToolStarted } from './turn-completion-checkpoint.ts';
import { recoverAcceptedCompletions, recoverInterruptedHeartbeats } from './completion-recovery.ts';
import type { ModelToolBridge } from '../capabilities/model-bridge.ts';
import type { CatalogProvider } from '../capabilities/registry.ts';
// P01.1：叶类型正本在 capabilities/contracts.ts（宿主可信上下文随叶合同走）。
import type { ToolExecContext, ToolExecResult, BackgroundToolQuote, CoverageRange, SeenRef } from '../capabilities/contracts.ts';
import type { OrRequestEnvelope, RunnerPurpose } from './runner.ts';
import type { MatchedCompleteBlock } from '../../../../packages/contracts/src/sdk-events.ts';
import { TextSegmenter } from '../output/segments.ts';
import { sha256Hex, genId } from '../util/id.ts';
import { WindowBootstrapMachine, BOOTSTRAP_DEADLINE_MS } from './window-bootstrap.ts';
// P09：wishstar 依赖收窄为结构面（仅开窗临近纪念日提醒所需 upcoming）
import { buildPaths, resolveStateRoot } from '../config/paths.ts';
import { observeCacheUsage } from './cache-observation.ts';
import { renderToolContext, resolveToolGroups } from './tool-initial-visible.ts';
import { ConversationActivityService } from './wake-activity.ts';
import { keepwarmSleepState } from './keepwarm-sleep.ts';
import { keepwarmDispatchGate } from './background-keepwarm-gate.ts';
import { classifyBackgroundOutcome } from './background-outcome.ts';
import { settleBackgroundDispatch, settleBackgroundRun } from './background-ledger.ts';
import { estimateModelRequestCostMicroUsd } from './model-request-cost.ts';
import { ContractError, ToolNotDispatched } from './or-contract.ts';
import { projectRevisionBlocks, materializeEnvelope, toolResultContent, redactImageBlocksForStorage, visionSupportCached, refreshVisionSupport } from '../media/model-input.ts';
import { planCarryImages, buildCarryFragment, countCarryImageBlocks } from '../context/carry-images.ts';
import { CARRY_IMAGE_LIMIT, type CarrySetItem } from '../../../../packages/contracts/src/content.ts';
import { contentForward } from '../integrations/content/client.ts';
import { modelToolsAfterBindingRetirement, storedToolset } from './tool-discovery.ts';
import { catalogUsesLegacySequenceMarkers, stripLegacySequenceMarker } from './legacy-sequence-markers.ts';
import { missedCallOpportunityIsCurrent } from '../integrations/siren/missed-calls.ts';
import { HEARTBEAT_DRAW_TOOL, type HeartbeatRuntime } from '../modules/heartbeat/runtime.ts';
import type { HeartbeatMode } from '../modules/heartbeat/service.ts';

export type SupervisorDeps = {
  db: Db;
  config: Config;
  messages: MessageService;
  events: EventService;
  identity: IdentityService;
  capabilities: CapabilityMatrix;
  runnerSelection: RunnerSelection;
  reasoning: ReasoningService;
  usage: UsageCollector;
  routing: RoutingService;
  windows: WindowManager;
  logger: Logger;
  archiveSync?: { drainOnce(): Promise<unknown> }; // 助手消息正式发布后触发原文同步（未启用时不注入）
  wishstar?: { upcoming(days: number, signal?: AbortSignal): Promise<{ items: Array<{ name: string; date: string; days_until: number }> } | null> } | null; // 许愿星只读结构面（临近纪念日提醒；不 import 业务 client）
  tools?: ModelToolBridge; // OR 工具执行（memory_hold / context_review_complete；未注入则工具循环不可用）
  reviews?: RotationReviewService;
  checkpoint?: HoldCheckpointService;
  trajectory?: WindowTrajectoryService; // §2.2/§7：每窗 append-only 协议轨迹（缓存断点 G 与跨轮断言依据）
  supervisor?: TurnSupervisor; // 启动恢复重派用（recoverSchedule 静态方法无 this；实例注入后才可 enqueue）
  selections?: import('../context/manual-selection.ts').ManualSelectionService; // WP3（2026-10-08）：人工历史选集——新窗历史携带的唯一来源
  contentClient?: import('../integrations/content/client.ts').ContentClient | null; // 相册重构 P5：携带集合读取/消费（未装配=无携带注入，如实降级不阻塞聊天）
  archives?: import('../modules/archives/service.ts').ArchiveService; // 相册重构 P4：存档一次性通知（装配期投递）
  // P04.5：开窗资料窄端口（BootstrapPort=三个 bootstrap 读原语的结构子集）——
  // supervisor 不再从 tools 拉原始 Mariposa client；装配根绑定同一受控客户端。
  bootstrap?: import('../context/contributions.ts').BootstrapPort | null;
  /** 宿主用户 2026-11-07 裁定：开窗运行中事项片段取数端口（app-context 装配；缺省=null 不取） */
  episodes?: import('./window-bootstrap.ts').EpisodeListPort | null;
  // S17b 批次3：窄 catalog 接口——Supervisor 经同一 Registry 消费目录（唯一来源）
  toolCatalog?: CatalogProvider;
  // WP5（2026-10-08）：DS 昨天日结整链退役（digest 依赖已删；历史证据不篡改）
  settings?: import('./runtime-settings.ts').RuntimeSettingsService; // 2026-10-08 她裁定：聊天窗换模型/推理等级（override 持久正本）
  alerts?: import('../observability/system-alerts.ts').SystemAlertService; // EXEC_V1 WP2：缓存观测/压缩异常告警（未注入则观测静默跳过）
  mediaTools?: Pick<import('../modules/media/service.ts').MediaToolsService, 'readImage'>;
  media?: import('../media/assets.ts').MediaService; // EXEC_V1 WP3：媒体投影/物化（未注入=纯文本路径零变化）
  // JOINT-VOICE-20261022（04）：oído 听觉可用（=配置声明：integrations.oido 已配凭据）。
  // true 时当前输入无转写语音以结构化引用进入模型（可调 oido_analyze）；未注入/false 保持阻断语义。
  oidoHearing?: boolean;
  // WAKE_KEEPWARM_V1（2026-10-22）：真实活动锚点投影（L/维护回执 CAS）。
  activity?: ConversationActivityService;
  heartbeat?: HeartbeatRuntime;
  // WAKE_KEEPWARM_V1：后台派发让位检查（用户消息到来→心跳在安全边界让位，S-06）
  keepwarmYieldCheck?: (runId: string) => boolean;
  /** WAKE_KEEPWARM_V1：可注入时钟（后台执行位重检/迟到判定用；测试虚拟推进）。 */
  now?: () => number;
  // 自动浮现（EST_MARIPOSA_AUTO_SURFACING_V1 · WP5）：装配期有界复核+冻结注入块。
  // 未注入=零变化；P05.5/6：类型=context/contributions 叶接口（BeforeTurnContributor 完整
  // 生命周期：prepare/reuseFrozen/finalAdmit/markDispatched/markRetained/cancelForTurn）；
  // 策略全在 memory-surfacing/service.ts（装配实现该叶接口）。
  surfacing?: import('../context/contributions.ts').BeforeTurnContributor;
  // RR-04：观察「已用于本轮」的真实派发边界回填（observations.markDispatched）。
  // RV01（复审 20261106）：+decideQualification——轮次取消/停止时终结输入修订观察资格。
  voiceObservations?: Pick<import('../modules/oido/observations.ts').VoiceObservationService, 'snapshotsForRevision' | 'commitProjection' | 'awaitReadyForDispatch' | 'decideQualification'> | null;
};

/** JOINT-VOICE（自审修复）：听觉可用=配置声明 AND 本窗冻结工具目录含 oido_analyze。
 *  旧窗目录冻结（A05 合同：不动态膨胀破缓存）没有 oido 工具——此时引导调用会
 *  TOOL_NOT_IN_WINDOW，误导模型；退回阻断语义（转写未就绪明确报错）更诚实。
 *  无冻结记录的新窗=当前目录（buildHostTools 含 oido_analyze）。 */

const RUNNER_GRACE_MS = 5000; // §11：不合作 runner 的强制终态宽限
// §8.2 工具续请求上限已按宿主用户裁定撤销（2026-11-09"根治一下，调成无上限"：
// 一回合连写多条记忆+自纠会撞 8 轮上限，6 条已提交的副作用令整轮不可重放，
// 尾部记忆与正文回复双双丢失——保护误伤大于循环风险）。循环退出=模型自然
// 不再发起工具调用；模型死循环时由用户停止回合兜底（abort 信号全程贯通）。
// §3.3 有界恢复（2026-10-05 审计 P2-1）：同窗评审失败达上限后不再自动付费评审——
// 恢复路径=评审成功换新窗（新窗计数重置）或人工处理后手动换窗；防"模型永不调用 complete"时每条消息都付费评审。
const MAX_WINDOW_REVIEW_ATTEMPTS = 3;

/** 信封驱动：四类驱动共用消息轨迹与工具循环管线。R2（2026-11-07）起 mock 测试替身
 *  同走信封（消费 OrRunRequest、driver='mock'），旧 SDK 单请求 prompt 分支已退役。 */
export const isEnvelopeDriverKind = (kind: string): kind is 'openrouter' | 'deepseek' | 'claude-agent-sdk' | 'mock' =>
  kind === 'openrouter' || kind === 'deepseek' || kind === 'claude-agent-sdk' || kind === 'mock';

type ModelRequestContext = {
  requestId: string | null;
  entry: 'claude-agent-sdk' | 'openrouter' | 'deepseek';
  requestedModel: string;
  responseModel: string | null;
  provider: string | null;
};

// Request execution facts live with the existing request projection. Policy
// selection remains independent; upstream provider is unknown until observed.
function recordRequestExecution(db: Db, context: ModelRequestContext, backgroundRunId?: string): void {
  const { requestId, ...execution } = context;
  db.prepare("UPDATE provider_requests SET payload_json=json_set(payload_json,'$.execution',json(?)) WHERE id=?")
    .run(JSON.stringify(execution), requestId);
  if (backgroundRunId) db.prepare('UPDATE background_runs SET driver=?,model=? WHERE id=?')
    .run(context.entry, context.responseModel ?? context.requestedModel, backgroundRunId);
}

type ActiveRun = {
  token: { cancelled: boolean };
  controller: AbortController;
  generation: number;
};

export class TurnSupervisor {
  private d: SupervisorDeps;
  /** 相册重构 P5：rotation 准备期（pending 键，窗 id 未落地）暂存携带计划；窗口落地后
   *  迁入 window_carry_plans 表；换窗失败即弃（设置保留、不消费）。 */
  private pendingCarryPlans = new Map<string, { plan: ReturnType<typeof planCarryImages>; conversationId: string; createdAt: string }>();
  private chains = new Map<string, Promise<unknown>>(); // F-J-31：runSerialized 链尾 Promise<T|void> 存迹，只 await 不读值
  private active = new Map<string, ActiveRun>(); // key = turnId
  // F-J-09（联合审计 2026-10-06）：工具 schema/顺序按 epoch（窗口）冻结——
  // 同窗续请求 tools 恒定（§7.1）；词表刷新只影响新窗快照。进程内缓存；
  // 重启后同窗首发的快照重建（跨重启的前缀漂移只影响缓存命中，不影
  // 响正确性——新窗在换窗时取新快照）。
  // D2（她批准 2026-10-06）：本窗 Mariposa 开窗资料快照（缓存点 B）——
  // 首个信封前取一次并冻结（§5.2/§7.1：B 只冻结这一窗的输入快照，权限
  // 撤销/关键身份更正例外走既有安全换窗）。取不到=如实降级不带 B（事件
  // 记录），不阻塞聊天、不伪造"记忆已恢复"。
  private readonly bootstrapMachine: WindowBootstrapMachine;

  recoverAcceptedCompletions(finishBackground?: Parameters<typeof recoverAcceptedCompletions>[1]): void {
    recoverAcceptedCompletions(this.d, finishBackground);
    recoverInterruptedHeartbeats(this.d, finishBackground, (messages,sentCount,tools,maxTokens) =>
      this.compactBlockedResults(messages,sentCount,tools,maxTokens));
  }

  constructor(d: SupervisorDeps) {
    this.d = d;
    this.bootstrapMachine = new WindowBootstrapMachine(d);
  }

  enqueue(turnId: string): void {
    const conv = this.d.db.prepare('SELECT conversation_id FROM turns WHERE id = ?').get(turnId) as { conversation_id: string } | undefined;
    if (!conv) return;
    this.runSerialized(conv.conversation_id, async () => {
      try {
        await this.runTurn(turnId);
      } catch (err) {
        // AUD-10：链条内崩溃不留悬挂——该 turn 落 failed 终态
        // 整合（2026-10-24）：合同化守卫（wire 锚/append-only/政策窗）在主流程 throw 的
        // 结构化错误码透传到 attempt（此前一律 RUNNER_CRASHED，测试与排障分不清类型）
        const raw = String((err as Error).message ?? err);
        const contractCode = /^(WIRE_TRAJECTORY_DIVERGED|WIRE_HISTORY_SHORTENED|HISTORY_CHANGED|HISTORY_SHORTENED|PREFIX_PROFILE_CHANGED|DS_PROTOCOL_HISTORY_REQUIRES_NEW_WINDOW)/.exec(raw)?.[1]; // 旧码=历史 DB 行兼容（2026-10-24 起篡改统一 WIRE_TRAJECTORY_DIVERGED）
        this.d.logger.error('turn_crashed', { turn_id: turnId, code: stableCode(err), raw: String((err as Error).message ?? err).slice(0,180), ...(contractCode ? { contract_code: contractCode } : {}) });
        this.failTurnQuietly(turnId, contractCode ?? 'RUNNER_CRASHED');
      } finally {
        this.d.surfacing?.finishTurn?.(turnId);
        this.voiceTaps.delete(turnId); // RE-02：回合收口即撤抽头（完成/失败/中断同规则）
      }
    });
  }

  /** 宿主事实走同一串行链与发布链，不伪造用户消息；dedupe_key 保证同一机会最多一次。 */
  submitProgramFactTurn(conversationId: string, kind: string, factText: string, dedupeKey: string): { turnId: string } | { deduplicated: true } {
    const d = this.d;
    const existing = d.db.prepare('SELECT turn_id FROM program_fact_turns WHERE dedupe_key = ?').get(dedupeKey) as { turn_id: string } | undefined;
    if (existing) return { deduplicated: true };
    const turnId = genId('turn');
    const nowIso = new Date().toISOString();
    tx(d.db, () => {
      d.db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, input_message_id, created_at) VALUES (?,?, 'program_fact', 'pending', NULL, ?)").run(turnId, conversationId, nowIso);
      d.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,1,NULL,'pending')").run(genId('att'), turnId);
      d.db.prepare('INSERT INTO program_fact_turns(turn_id, dedupe_key, kind, fact_text, created_at) VALUES (?,?,?,?,?)').run(turnId, dedupeKey, kind, factText, nowIso);
    });
    this.enqueue(turnId);
    return { turnId };
  }

  private admitProgramFact(turnId: string | null, conversationId: string): void {
    if (!turnId) return;
    const fact = this.d.db.prepare("SELECT created_at FROM program_fact_turns WHERE turn_id=? AND kind='invite_missed_opportunity'")
      .get(turnId) as { created_at: string } | undefined;
    // 邀请到入队的历史已检查；排队、重启恢复和请求重试期间仍可能发生回拨。
    if (fact && !missedCallOpportunityIsCurrent(this.d.db, conversationId, fact.created_at)) {
      throw new ContractError('MISSED_CALL_OPPORTUNITY_SUPERSEDED');
    }
  }

  /** 审计 F05：房间唯一串行链的通用入口——turn、自动评审、手动换窗共用同一互斥；
   *  前序任务失败不阻断后续（fn 总被执行），返回值/异常原样传给调用方。 */
  private runSerialized<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(conversationId) ?? Promise.resolve();
    const run = () => this.d.runnerSelection.status === 'ok' && this.d.runnerSelection.runner instanceof SubscriptionAccessRunner
      ? this.d.runnerSelection.runner.atSafeTurn(fn) : fn();
    const result = prev.then(run, run);
    const next = result.catch(() => {}).finally(() => {
      if (this.chains.get(conversationId) === next) this.chains.delete(conversationId);
    });
    this.chains.set(conversationId, next);
    return result;
  }

  async waitIdle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /** RE-02（2026-10-24 返修）：语音正文抽头——同一生成流（publishText 的真实新增 tail，
   *  与聊天落库同源）逐段供给 voice ingress；不经公共事件总线（不进 SSE/UI 面）。
   *  取消后代际内不再供给（与 publishSegments 同一 fence）。 */
  private voiceTaps = new Map<string, (text: string, legacySequenceMarkers: boolean) => void>();
  registerVoiceTap(turnId: string, onTap: (text: string, legacySequenceMarkers: boolean) => void): () => void {
    this.voiceTaps.set(turnId, onTap);
    return () => { this.voiceTaps.delete(turnId); };
  }

  /** 相册重构 P4（03 §3.1）：停止会话当前仍在跑/排队的回合（用户"不吵了"）。只停
   *  目标会话的最新未终态回合（不挂通话、不动其他会话）；返回被停回合或 null。 */
  stopActiveForConversation(conversationId: string, exceptTurnId: string | null = null): { stoppedTurnId: string } | null {
    // ALB-12（审计 2026-11-08）：目标是"正在继续的那次输出"——优先 running；仅当没有
    // running 时才处理最新排队输入（旧实现按 created_at 倒序，running+排队并存时停错
    // 排队者，正在输出的回合继续跑完）。
    const row = this.d.db.prepare(
      `SELECT id FROM turns WHERE conversation_id = ? AND state IN ('pending','running','route_owner_pending') AND id != ?
       ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'route_owner_pending' THEN 1 ELSE 2 END, created_at DESC, rowid DESC LIMIT 1`,
    ).get(conversationId, exceptTurnId ?? '') as { id: string } | undefined;
    if (!row) return null;
    const r = this.stop(row.id);
    return r.stopped ? { stoppedTurnId: row.id } : null;
  }

  stop(turnId: string): { stopped: boolean; generation: number | null; reason?: 'GENERATION_IN_FLIGHT' } {
    const run = this.active.get(turnId);
    if (!run) {
      // 排队中（无活动代）。F01（四仓审计 20261104，P1）：停止确认**直接持久落终态**
      // （RE-03 同语义：CANCELLED_BEFORE_DISPATCH）——旧实现只写内存 Set，进程在队列
      // 释放前退出则 Set 丢失，重启 recoverSchedule 按 pending 重新派发，已停止的输入
      // 复活并产生模型/工具费用（审计隔离复现：redispatched=1、模型调用=1）。
      // 持久终态使队列与恢复只消费数据库事实；在途链到达时 claim（只认 pending attempt）
      // 失败即早退，无需 Set 配合。若 turn 已终态/从未入队，failTurnQuietly 的条件
      // UPDATE 不生效，无害。
      const queued = this.d.db.prepare("SELECT 1 FROM turns WHERE id = ? AND state IN ('queued','running','pending')").get(turnId);
      if (queued) {
        const conv = this.d.db.prepare('SELECT conversation_id FROM turns WHERE id = ?').get(turnId) as { conversation_id: string } | undefined;
        if (conv) {
          this.d.events.publish('turn.status', { conversationId: conv.conversation_id, turnId, scope: 'private', payload: { state: 'failed', reason: 'CANCELLED_BEFORE_DISPATCH' } });
          this.failTurnQuietly(turnId, 'CANCELLED_BEFORE_DISPATCH');
          this.abandonObservationsForTurn(turnId);
          this.voiceTaps.delete(turnId);
        }
        return { stopped: true, generation: null };
      }
      return { stopped: false, generation: null };
    }
    // 她 2026-11-15 裁定：模型请求已派发（回复开始生成）后不再可打断——本轮跑完，
    // 保住 SDK 会话锚与缓存；打断只在派发前有效（无任何产出，锚由 runner 保留）。
    const inFlight = this.d.db.prepare(
      "SELECT 1 FROM attempts a JOIN provider_requests pr ON pr.attempt_id = a.id WHERE a.turn_id = ? AND a.state = 'running' AND pr.dispatch_started_at IS NOT NULL LIMIT 1",
    ).get(turnId);
    if (inFlight) return { stopped: false, generation: run.generation, reason: 'GENERATION_IN_FLIGHT' };
    this.d.surfacing?.cancelForTurn?.(turnId);
    this.abandonObservationsForTurn(turnId);
    run.token.cancelled = true; // generation fence：迟到 chunk 一律丢弃
    run.controller.abort(); // 同时触发 await 处的 grace 计时（§11：不合作 runner 的有界终止）
    return { stopped: true, generation: run.generation };
  }

  /** RV01（复审 20261106）：轮次停止/取消＝该轮输入修订的观察资格终结（abandoned）——
   *  取消在途 O 分析、迟到 ID 归属同一操作、消费面挡住；正文照常无分析继续。 */
  private abandonObservationsForTurn(turnId: string): void {
    const row = this.d.db.prepare('SELECT t.input_message_id, m.current_revision FROM turns t JOIN messages m ON m.id = t.input_message_id WHERE t.id = ?').get(turnId) as { input_message_id: string; current_revision: number } | undefined;
    if (row) this.d.voiceObservations?.decideQualification({ messageId: row.input_message_id, revision: row.current_revision }, 'abandoned', { turnId });
  }

  async stopAll(timeoutMs = 8000): Promise<void> {
    for (const run of this.active.values()) {
      run.token.cancelled = true;
      run.controller.abort();
    }
    const start = Date.now();
    while (this.active.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  createAttempt(turnId: string, inputRevision: number | null): string {
    const attemptId = `att_${turnId.slice(4)}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const row = this.d.db.prepare('SELECT MAX(attempt_no) AS m FROM attempts WHERE turn_id = ?').get(turnId) as { m: number | null };
    tx(this.d.db, () => {
      this.d.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,?,?,'pending')").run(attemptId, turnId, (row.m ?? 0) + 1, inputRevision);
    });
    return attemptId;
  }

  /**
   * WAKE_KEEPWARM_V1 §03：后台进入同一会话串行链的唯一入口。在链**外**调用
   * （调度器/HTTP）；内部执行体不得再向同链挂任务（自锁，S-03）。用户回合、到期
   * 自主唤醒、心跳与人工换窗共用 runSerialized——同 conversation 任意时刻最多一个
   * 真实 runner（S-01），后到的用户消息按既有链序处理（W-04：不无限插队）。
   */
  enqueueBackground<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    return this.runSerialized(conversationId, fn);
  }

  /**
   * WAKE_KEEPWARM_V1（2026-10-22 重写）：后台模型回合——自主预约唤醒与心跳保温。
   * 在会话串行链内被调用（app-context executor 经 enqueueBackground 包裹）；
   * 复用 runOrToolLoop（互斥/取消 fence/append-only/逐尝试派发账本/用量记账）。
   * 与旧实现的差别（02 基线缺口 B09-B13 修复）：
   *  - 请求基底=当前活动窗的**规范轨迹正本**（system 段沿用窗冻结前缀，不重建第二份
   *    system——C-06），host 事件只在尾部追加一次；
   *  - 自主预约 note 全文投递（不截断 200）；心跳用固定英文维护提示（05）；
   *  - 完整工具循环（无零工具/单请求封锁）；已见视野从轨迹 manifest 派生（非空）；
   *  - 结果按整轮确定性分类：PURE_ACK（成功且整轮恰为"1"）不进聊天原文与主轨迹；
   *    SUBSTANTIVE（任意工具/发布/非1文本）共享聊天轨迹提交与恢复（B11）；
   *  - 每次真实 transport 前估算保守费用上界并预占（不再固定 0，B-01）。
   */
  async runBackgroundTurn(opts: {
    kind: 'autonomous' | 'keepwarm';
    /** RB2-03（复审 20261106 第二轮）：用户返回让位资格——与预算同一控制类型分类
     *  （keepwarm/free_activity 让位；预约唤醒按普通回合规则继续）。缺省=仅 keepwarm。 */
    yieldEligible?: boolean;
    runId: string;
    conversationId: string;
    payload: Record<string, unknown>;
    isCancelRequested: () => boolean;
    registerAbort: (c: AbortController) => void;
    recordDispatch: (info: { logicalActionKey: string; attemptNo: number; dispatchKind: 'model' | 'tool'; reservedCostMicroUsd: number; capabilityName?: string }) => { allowed: boolean; dispatchId: string; code?: string };
    maxModelRequests: number; // 后台回合模型请求预算（§B 账本），与已撤销的 §8.2 工具轮上限无关
  }): Promise<{ outcome: 'completed' | 'noop' | 'failed' | 'unknown'; result_code?: string; detail?: string }> {
    const d = this.d;
    const dv = this.drv();
    if (dv === null) return { outcome: 'failed', result_code: 'SDK_BACKGROUND_POLICY_UNVERIFIED', detail: '当前驱动不支持后台回合（SDK 背景策略未验证）' };
    if (opts.kind === 'keepwarm') {
      const sleep = keepwarmSleepState(d.config.background.keepwarm.sleep_window, this.nowMs());
      if (sleep.blocked) return { outcome: 'noop', result_code: sleep.code!, detail: '睡眠时段暂停心跳——排队任务零派发' };
    }
    // —— 执行位内重检（03：领取≠执行；开关/任务 revision/取消只在 15 秒 tick 查一次不算数）——
    const runRow = d.db.prepare('SELECT state, task_id, task_revision, input_activity_revision FROM background_runs WHERE id = ?').get(opts.runId) as { state: string; task_id: string; task_revision: number; input_activity_revision: number | null } | undefined;
    if (!runRow) return { outcome: 'failed', result_code: 'RUN_NOT_FOUND' };
    if (runRow.state !== 'claimed' && runRow.state !== 'running') return { outcome: 'noop', result_code: `CANCELLED_${runRow.state.toUpperCase()}` };
    const taskRow = d.db.prepare('SELECT revision, enabled, control_reason, payload_json, origin FROM background_tasks WHERE id = ?').get(runRow.task_id) as { revision: number; enabled: number; control_reason: string | null; payload_json: string; origin: string } | undefined;
    if (!taskRow) return { outcome: 'failed', result_code: 'TASK_NOT_FOUND' };
    if (taskRow.revision !== runRow.task_revision) return { outcome: 'noop', result_code: 'TASK_SUPERSEDED', detail: '任务已修改/取消——旧 revision 零派发' };
    if (taskRow.enabled !== 1) return { outcome: 'noop', result_code: 'TASK_CANCELLED', detail: '任务已禁用——零派发' };
    const window = d.windows.activeWindow(opts.conversationId);
    if (!window) return { outcome: 'failed', result_code: 'NO_ACTIVE_WINDOW' };
    const pendingSel = d.selections ? d.selections.forTargetWindow(window.id) : null;
    if (pendingSel && pendingSel.status === 'awaiting') return { outcome: 'failed', result_code: 'CONTEXT_SELECTION_REQUIRED', detail: '等待用户手选原文——后台不自动空选' };
    const traj = d.trajectory?.forWindow(window.id) ?? null;
    if (!traj || traj.messages.length === 0) return { outcome: 'failed', result_code: 'NO_TRAJECTORY', detail: '窗口尚无规范轨迹' };
    const gate = d.identity.evaluateGate(d.db, { driver: dv.kind });
    if (gate.state !== 'READY' || !gate.manifest) return { outcome: 'failed', result_code: 'IDENTITY_BLOCKED' };
    if (opts.isCancelRequested()) return { outcome: 'completed', result_code: 'CANCELLED_BEFORE_START' };

    const nowIso0 = new Date().toISOString();
    const controller = new AbortController();
    opts.registerAbort(controller);
    let capturedActivityRevision: number | null = null;
    let heartbeatMode: HeartbeatMode | null = null;
    let heartbeatHostText: string | null = null;
    // —— 心跳专属派发门（R4a 迁 runtime/background-keepwarm-gate.ts；05 §派发门与异常）——
    if (opts.kind === 'keepwarm') {
      const gate = keepwarmDispatchGate({ db: d.db, activity: d.activity, conversationId: opts.conversationId, windowId: window.id, inputActivityRevision: runRow.input_activity_revision, nowMs: this.nowMs() });
      if (gate.decision === 'noop') return { outcome: 'noop', result_code: gate.resultCode, detail: gate.detail };
      capturedActivityRevision = gate.capturedActivityRevision;
    }
    const baseTools = this.windowTools(window.id);
    const toolset = storedToolset(d.db, window.id)!;

    // —— 尾部 host 事件（05/04：宿主事件口径，不伪造用户消息；一次冻结，续轮不重生成）——
    let tailNote: string;
    if (opts.kind === 'keepwarm') {
      if (!d.heartbeat) return { outcome: 'failed', result_code: 'HEARTBEAT_RUNTIME_UNAVAILABLE' };
      const offered = toolset.protocol === 'deferred' || toolset.onDemand ? toolset.catalog : toolset.tools;
      const supportsDraw = offered.some(tool => tool.function.name === HEARTBEAT_DRAW_TOOL)
        && offered.some(tool => tool.function.name === TURN_COMPLETION_TOOL);
      if (!supportsDraw && d.heartbeat.status(opts.conversationId).mode !== 'exhausted_keepwarm') {
        return { outcome: 'failed', result_code: 'HEARTBEAT_TOOL_WINDOW_UNAVAILABLE' };
      }
      const prepared = await d.heartbeat.begin({
        runId: opts.runId, conversationId: opts.conversationId, windowId: window.id, signal: controller.signal,
        retainedMessages: traj.messages,
      });
      if (controller.signal.aborted || opts.isCancelRequested() || d.keepwarmYieldCheck?.(opts.runId)) {
        return { outcome: 'noop', result_code: 'HEARTBEAT_CANCELLED_BEFORE_DISPATCH' };
      }
      heartbeatMode = prepared.mode;
      if (heartbeatMode === 'unprepared' || heartbeatMode === 'source_unavailable') {
        return { outcome: 'failed', result_code: heartbeatMode === 'unprepared'
          ? 'HEARTBEAT_DECK_UNPREPARED' : 'HEARTBEAT_SOURCE_UNAVAILABLE',
          ...(prepared.unavailable?.length ? { detail: '读取不可用的来源：' + prepared.unavailable.join(',') } : {}) };
      }
      heartbeatHostText = tailNote = prepared.hostText;
    } else {
      const mergedPayload = { ...JSON.parse(taskRow.payload_json) as Record<string, unknown>, ...opts.payload };
      const note = typeof mergedPayload.note === 'string' ? mergedPayload.note : '';
      // C07（四仓审计 20261106）：包装时间从**冻结 task/run** 一次取得并原样携带——
      // 设置时间（task 创建）、原 due（task.scheduled_at，相对时间首受理解析的冻结值）、
      // 实际递交；续轮/恢复复用同一冻结文本，迟到只标注不重算 due、不改 system。
      const taskFrozen = d.db.prepare('SELECT created_at, scheduled_at, created_by_actor_id FROM background_tasks WHERE id = ?').get(runRow.task_id) as { created_at: string; scheduled_at: string; created_by_actor_id: string } | undefined;
      const scheduledFor = taskFrozen?.scheduled_at ?? (typeof mergedPayload.scheduled_for === 'string' ? mergedPayload.scheduled_for : null);
      if (note.length > 8000) return { outcome: 'failed', result_code: 'WAKE_NOTE_INVALID', detail: '预约正文超长——报错不静默截断' };
      const historicalDelegate = taskRow.origin === 'self_schedule' && taskFrozen && taskFrozen.created_by_actor_id !== 'jiaming';
      const lines = [historicalDelegate ? '[Host historical delegated wake; not a new message or a self-created appointment]' : '[Host self-wake; not a message from Qiaosheng]'];
      if (historicalDelegate) lines.push(`Set by: ${taskFrozen.created_by_actor_id}`);
      if (taskFrozen) lines.push(`Set at: ${taskFrozen.created_at}`);
      if (scheduledFor) lines.push(`Scheduled for: ${scheduledFor}`);
      lines.push(`${historicalDelegate ? 'Original recorded note' : 'Your note'}: ${note.length > 0 ? note : '(none)'}`);
      lines.push(`Actual delivery: ${nowIso0}${scheduledFor && Date.parse(scheduledFor) + 60_000 < this.nowMs() ? ' (late)' : ''}`);
      tailNote = lines.join('\n');
    }
    // Keepwarm must send exactly the same tools as chat for this window.
    const scopedTaskTools = toolset.protocol === 'direct' && opts.kind === 'autonomous'
      && toolset.groups[TURN_COMPLETION_TOOL] === 'T';
    const tools = scopedTaskTools ? modelToolsAfterBindingRetirement(toolsetForTask(toolset, TURN_COMPLETION_TOOL)) : baseTools;
    if (opts.kind === 'autonomous' && taskRow.origin === 'self_schedule') {
      tailNote += '\n结束前，把要告诉乔乔的话发到聊天；有后续就自行安排。';
    }
    const taskDefinition = heartbeatMode === 'exhausted_keepwarm' || (toolset.protocol === 'direct' && !scopedTaskTools)
      ? null
      : taskDefinitionContext(toolset, 'background_complete', opts.runId);
    if (taskDefinition) tailNote += '\n' + taskDefinition;
    if (heartbeatMode === 'draw' && toolset.protocol === 'deferred') {
      const drawDefinition = taskDefinitionContext(toolset, HEARTBEAT_DRAW_TOOL, opts.runId);
      if (drawDefinition) tailNote += '\n' + drawDefinition;
    }
    // 请求基底=轨迹正本（system 段沿用窗冻结前缀）；host 事件尾部追加一次。
    const baseMessages: OrMessage[] = [
      ...traj.messages,
      { role: 'user', content: [{ type: 'text', text: tailNote }] } as unknown as OrMessage,
    ];
    const { boundaries } = planBoundaries({ messages: baseMessages, systemMessageCount: fixedSystemCount(traj.messages), prevBoundary: traj.lastBoundary });
    const envelope: OrRequestEnvelope = {
      model: dv.model,
      sessionId: dv.sessionId(opts.conversationId),
      messages: baseMessages,
      tools,
      boundaries,
      maxTokens: dv.maxTokens, // 主会话有效输出上限（09：不用旧 128 封锁）
      reasoning: dv.reasoning,
    };
    const { reasoning: _r, ...prevParams } = envelope;
    void _r;
    const previousEnvelope: OrRequestEnvelope = { ...(prevParams as OrRequestEnvelope), messages: traj.messages };

    // 后台 turn（无用户消息；trigger 区分用途——usage 按 purpose/预算日归属可查）
    const nowIso = nowIso0;
    const turnId = genId('turn');
    const attemptId = genId('att');
    d.db.prepare(`INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES (?,?,?, 'pending', ?)`)
      .run(turnId, opts.conversationId, opts.kind === 'keepwarm' ? 'cache_keepalive' : 'proactive_turn', nowIso);
    d.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,1,NULL,'pending')").run(attemptId, turnId);
    d.db.prepare("UPDATE attempts SET state='running',window_id=?,started_at=? WHERE id=?").run(window.id,nowIso,attemptId);
    d.db.prepare("UPDATE turns SET state='running',started_at=? WHERE id=?").run(nowIso,turnId);
    d.db.prepare('UPDATE background_runs SET state = \'running\', window_id = ?, driver = ?, model = ?, turn_id = ?, input_activity_revision = COALESCE(?, input_activity_revision), updated_at = ? WHERE id = ?').run(window.id, dv.kind, dv.model, turnId, capturedActivityRevision, nowIso, opts.runId);

    let toolCallsObserved = 0;
    const loop = await this.runOrToolLoop({
      envelope, purpose: opts.kind === 'keepwarm' ? 'cache_keepalive' : 'proactive_turn', activeReviewId: null,
      conversationId: opts.conversationId, windowId: window.id, turnId, attemptId, controller,
      onEvent: (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: ModelRequestContext) => {
        // 后台回合不发聊天气泡/思考流；用量照常入账（§05.6：后台无 handleEvent，此处最小挂钩）
        if (ev.kind === 'usage') {
          d.usage.record({ turnId, attemptId, scope: ev.scope, usage: ev.usage, requestId: reqCtx?.requestId ?? undefined, windowId: window.id, model: reqCtx?.responseModel ?? reqCtx?.requestedModel ?? dv.model, source: ev.source, completeness: ev.completeness });
        }
      },
      // B12 修复：已见视野从轨迹 manifest 派生（不再恒空）；续轮工具片段由循环内部并入
      seenSequence: traj.manifest && traj.manifest.length > 0 ? Math.max(...traj.manifest.map((m) => m.seq)) : 0,
      seenMessages: (traj.manifest ?? []).map((m) => (m.char_start !== undefined ? { id: m.id, revision: m.revision, char_start: m.char_start, char_end: m.char_end } : { id: m.id, revision: m.revision })),
      previousEnvelope,
      scopedTaskTools,
      heartbeatMode: heartbeatMode ?? undefined,
      heartbeatHostText: heartbeatHostText ?? undefined,
      background: {
        runId: opts.runId, kind: opts.kind, maxModelRequests: opts.maxModelRequests, recordDispatch: opts.recordDispatch, isCancelRequested: opts.isCancelRequested,
        observeToolCall: () => { toolCallsObserved++; },
        // RB2-03：让位资格由调用方按控制类型传入（keepwarm/free_activity）。
        yieldRequested: (opts.yieldEligible ?? opts.kind === 'keepwarm') && d.keepwarmYieldCheck ? () => d.keepwarmYieldCheck!(opts.runId) : null,
      },
    });
    // Same idempotent ledger as live/late usage. Missing charges retain reservations.
    settleBackgroundRun(d.db, opts.runId);
    // 结果分类与收尾（R4a 迁 runtime/background-outcome.ts）
    return classifyBackgroundOutcome({ db: d.db, trajectory: d.trajectory, activity: d.activity, kind: opts.kind, runId: opts.runId, conversationId: opts.conversationId, windowId: window.id, turnId, attemptId, baseManifest: traj.manifest ?? [], capturedActivityRevision, toolCallsObserved, isCancelRequested: opts.isCancelRequested, loop,
      ...(d.heartbeat && heartbeatMode && heartbeatHostText !== null
        ? { heartbeat: { runtime: d.heartbeat, mode: heartbeatMode, hostText: heartbeatHostText } } : {}),
    });
  }

  /** EXEC_V1 §03.6（WP3/M2）：消息修订 → 内部投影块（asset_image 引用，不含 Base64）。
   *  无媒体服务/纯文本消息=原样单文本块——旧路径零变化。 */
  /** 消息→OR 块投影。包4无seq整改（2026-11-18，裁定7）：模型面信封不再携带消息
   *  序号前缀 [N]——普通输入、开窗选集与滚窗追赶一律自然正文；真实 sequence 仍存
   *  于 messages/轨迹 manifest（后台定位正本），工具定位改锚点/游标（见包4报告）。 */
  /** 本轮的通话事实随实发轨迹保留。指明双向电话的输入和回复交付，内容与长度仍由回合决定。 */
  private static readonly LIVE_CALL_FACT = '这一轮是你和宿主用户在通电话。接下来是她刚在这通电话里对你说的话，经语音识别转写。你要对她说的话直接放在这轮回复里，她会在同一通电话里实时听到。聊天语音条是另一个动作，通话回复无需另外发送语音条。回复正文只放你要说的话，略去宿主的内部标记。';

  private isCallTurnMessage(messageId: string | null | undefined): boolean {
    if (!messageId) return false;
    const row = this.d.db.prepare('SELECT client_message_id FROM messages WHERE id=?').get(messageId) as { client_message_id: string | null } | undefined;
    return (row?.client_message_id ?? '').startsWith('voice:');
  }

  private revisionBlocks(messageId: string | null | undefined, revision: number | null | undefined, fallbackText: string, opts: { isCurrentInput?: boolean; hearingAvailable?: boolean; transcriptContinuationAvailable?: boolean } = {}): { blocks: Array<Record<string, unknown>>; hasImage: boolean; hasVoiceWithoutTranscript: boolean; observations: import('../modules/oido/observations.ts').VoiceObservationSnapshot[] } {
    if (this.d.media && messageId && revision) {
      try {
        const proj = this.d.media.projectForRevision(messageId, revision);
        const text = opts.isCurrentInput && fallbackText !== proj.content ? fallbackText : proj.content;
        // JOINT-VOICE-20261022（04）：当前输入语音引用带 audio_ref/时长；听觉可用性=配置声明
        //（不在发送关键路径探测——视觉门教训）；时长取 voice_transcripts 真实值，缺省如实"时长未知"
        let hearing: { available: boolean } | undefined;
        let voiceDurations: Map<string, number | null> | undefined;
        if (opts.isCurrentInput === true) {
          hearing = { available: opts.hearingAvailable ?? (this.d.oidoHearing === true) };
          const voiceIds = proj.attachments.filter((a) => a.presentation === 'voice').map((a) => a.asset_id);
          if (voiceIds.length > 0) {
            voiceDurations = new Map(voiceIds.map((id) => [id, null]));
            const marks = voiceIds.map(() => '?').join(',');
            for (const row of this.d.db.prepare(`SELECT asset_id, duration_ms FROM voice_transcripts WHERE asset_id IN (${marks})`).all(...voiceIds) as Array<{ asset_id: string; duration_ms: number | null }>) {
              voiceDurations.set(row.asset_id, row.duration_ms);
            }
          }
        }
        const extra = hearing || voiceDurations ? { ...opts, ...(hearing ? { hearing } : {}), ...(voiceDurations ? { voiceDurations } : {}) } : opts;
        const snapshots = this.d.voiceObservations?.snapshotsForRevision(messageId, revision, opts.isCurrentInput === true) ?? [];
        const r = projectRevisionBlocks(text, proj.attachments, { ...extra, voiceObservations: new Map(snapshots.map(snapshot => [snapshot.assetId, snapshot.text])) });
        const observations = snapshots.filter(snapshot => r.blocks.some(block => block.type === 'text' && block.text === snapshot.text));
        return { blocks: r.blocks as unknown as Array<Record<string, unknown>>, hasImage: r.hasImage, hasVoiceWithoutTranscript: r.hasVoiceWithoutTranscript, observations };
      } catch { /* 修订缺失→退纯文本（装载面已有披露机制），不中断回合 */ }
    }
    return { blocks: [{ type: 'text', text: fallbackText }], hasImage: false, hasVoiceWithoutTranscript: false, observations: [] };
  }

  private confirmModelRequest(o: Pick<Parameters<TurnSupervisor['runOrToolLoop']>[0],
    'windowId' | 'turnId' | 'attemptId' | 'background' | 'heartbeatMode' | 'heartbeatHostText'>, input: {
    requestId: string; round: number; attemptIndex: number; generationId: string | null;
    messages: OrMessage[]; confirmedSeen: ManifestEntry[];
  }): void {
    const { db, trajectory, heartbeat } = this.d;
    const { requestId, round, attemptIndex, generationId, messages, confirmedSeen } = input;
    const markSent = () => db.prepare('UPDATE provider_requests SET sent_at = COALESCE(sent_at, ?), attempt_no = COALESCE(attempt_no, ?), generation_id = COALESCE(?, generation_id) WHERE id = ?')
      .run(new Date().toISOString(), attemptIndex, generationId ?? null, requestId);
    const { turnId } = o;
    if (round === 0 && (o.heartbeatMode === 'draw' || o.heartbeatMode === 'exhausted_keepwarm') && turnId && trajectory) {
      // Confirm the first invitation and its recoverable prefix together, before publication.
      tx(db, () => {
        markSent();
        stageHeartbeatCheckpoint(db, {
          requestId, windowId: o.windowId, turnId, attemptId: o.attemptId,
          batch: { tail: [], sentMessages: messages }, confirmedSeen, heartbeatHostText: o.heartbeatHostText,
        });
      });
    } else {
      markSent();
    }
    if (o.background?.kind === 'keepwarm') {
      heartbeat?.observeDelivery(o.background.runId, requestId, messages, o.heartbeatHostText);
    }
  }

  private observeHeartbeatBatch(o: Pick<Parameters<TurnSupervisor['runOrToolLoop']>[0],
    'conversationId' | 'windowId' | 'turnId' | 'attemptId' | 'background' | 'heartbeatMode' | 'heartbeatHostText'>,
    requestId: string, tail: OrMessage[], sentMessages: OrMessage[], confirmedSeen: ManifestEntry[]): void {
    const { db, heartbeat, trajectory } = this.d;
    const { turnId, attemptId, conversationId, windowId, background } = o;
    if (background?.kind !== 'keepwarm' || !turnId || !trajectory || !heartbeat) return;
    const eventRows = tx(db, () => {
      stageHeartbeatCheckpoint(db, { requestId, windowId, turnId, attemptId,
        batch: { tail, sentMessages }, confirmedSeen, heartbeatHostText: o.heartbeatHostText });
      return o.heartbeatMode === 'draw'
        ? heartbeat.publishRepliesInTx({ runId: background.runId, turnId, attemptId, conversationId }, tail, sentMessages.length).eventRows
        : [];
    });
    heartbeat.dispatchEvents(eventRows);
  }

  // —— OR 工具循环（§8.2）：assistant tool_calls → 宿主完整验证后串行执行 → tool 结果续请求 →
  // 同样经 P2（previousPayload append-only 断言）。发布/记账语义由调用方 onEvent 决定。
  // 返回 finalMessages：成功回合的完整轨迹消息（含最终 assistant 文本），供轨迹持久化（§2.2）。
  private async runOrToolLoop(o: {
    forceOpenRouter?: boolean;
    envelope: OrRequestEnvelope;
    purpose: RunnerPurpose;
    activeReviewId: string | null;
    conversationId: string;
    windowId: string;
    turnId: string | null; // 确认后恢复的容量评审可无所属 turn——与运行时实况对齐（F-J-31）
    attemptId: string;
    controller: AbortController;
    onEvent: (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: ModelRequestContext) => void;
    seenSequence: number;
    seenMessages: ReadonlyArray<{ id: string; revision: number }>; // D13：实际装载视野（引用核对）
    liveSeenAdditions?: ReadonlyArray<{ id: string; revision: number }>; // 流式期间新发布的已见消息（活引用，exec 时取当下值）
    onDispatch?: (info: { attemptIndex: number; generationId: string | null; payloadJson: string; prqId: string }) => void; // F17：每次真实发送逐笔留证
    /** 整合（2026-10-24）：本轮懒初始化重建过轨迹=合法新基线——wire 锚 append-only 比对豁免
     *  （与既有 RE-10 wire 守卫豁免同裁定；保温批 wire 锚与轨迹重建场景单边绿、组合炸，此处弥合） */
    trajectoryRebuiltThisTurn?: boolean;
    inputBinding?: { messageId: string; revision: number };
    voiceObservations?: readonly import('../modules/oido/observations.ts').VoiceObservationSnapshot[];
    previousEnvelope?: OrRequestEnvelope | null; // 跨轮 previousPayload（轨迹正本；首轮后由循环内部接管）
    scopedTaskTools?: boolean; // 任务专属工具与主会话使用不同工具前缀。
    completionManifest?: readonly ManifestEntry[];
    heartbeatMode?: HeartbeatMode;
    heartbeatHostText?: string;
    /** EXEC_V1 §04.10（WP4 收尾）+ WAKE_KEEPWARM_V1：后台回合——每次 transport 前过
     *  背景准入（取消/请求数/预算预占），逐尝试记 dispatch 账；心跳与自主共用同一
     *  完整工具循环（2026-10-22：KEEPWARM_TOOL_REFUSED 已删除）。 */
    background?: {
      runId: string;
      kind: 'autonomous' | 'keepwarm';
      maxModelRequests: number;
      recordDispatch: (info: { logicalActionKey: string; attemptNo: number; dispatchKind: 'model' | 'tool'; reservedCostMicroUsd: number; capabilityName?: string }) => { allowed: boolean; dispatchId: string; code?: string };
      isCancelRequested: () => boolean;
      observeToolCall?: () => void;
      yieldRequested?: (() => boolean) | null; // S-06：心跳安全边界让位（用户消息到来）
    };
  }): Promise<{ result: import('./runner.ts').RunnerRunResult; finalMessages: OrMessage[] | null; lastSentMessages: OrMessage[] | null; toolSeen: ManifestEntry[]; pendingToolSeen: ManifestEntry[] }> {
    const d = this.d;
    const runner = (d.runnerSelection as Extract<RunnerSelection, { status: 'ok' }>).runner; // runOrToolLoop 仅在信封驱动分支被调用（rotateIfNeeded 的 !dv 早退与 runTurn 的 blocked 早退均已判别 ok）
    const driverKind = this.drv()?.kind;
    const sdkDriver = driverKind === 'claude-agent-sdk';
    if (sdkDriver) {
      const messages = this.restoreSdkSelectionHistory(o.windowId, o.envelope.messages);
      if (messages !== o.envelope.messages) o = { ...o, envelope: { ...o.envelope, messages } };
    }
    if (sdkDriver && !o.forceOpenRouter && !(runner instanceof SubscriptionAccessRunner && runner.useOpenRouter())) {
      const sdk = await this.runSdkToolLoop(o);
      if (runner instanceof SubscriptionAccessRunner && runner.canFallback(sdk.result)) {
        if (!o.scopedTaskTools) runner.invalidateSdkSession(o.windowId);
        return this.runOrToolLoop({ ...o, forceOpenRouter: true });
      }
      return sdk;
    }
    const transportKind = driverKind === 'deepseek' ? 'deepseek' : 'openrouter';
    const orFallback = sdkDriver;
    if (orFallback && runner instanceof SubscriptionAccessRunner && !o.scopedTaskTools) runner.invalidateSdkSession(o.windowId);
    const requestToolset = storedToolset(d.db, o.windowId);
    const usesScopedToolProfiles = requestToolset?.protocol === 'direct';
    const orModel = d.settings?.effectiveOrModel(d.config.openrouter.model) ?? d.config.openrouter.model;
    let envelope = orFallback ? { ...o.envelope, model: orModel!, sessionId: orSessionId(o.conversationId, orModel!, null),
      reasoning: d.settings?.effectiveReasoning(d.config.openrouter.reasoning) ?? d.config.openrouter.reasoning } : o.envelope;
    if (orFallback && d.media && hasAssetImage(envelope.messages) && !await this.modelSupportsImages(envelope.model, transportKind)) {
      const code = 'MODEL_VISION_UNAVAILABLE';
      d.logger.warn('media_gate_blocked', { turn_id: o.turnId, code, model: envelope.model, has_image: true });
      return { result: { outcome: 'error', errorClassified: null, errorCode: code, errorMessage: code, sessionId: null, requestId: null },
        finalMessages: null, lastSentMessages: null, toolSeen: [], pendingToolSeen: [] };
    }
    let prevEnvelope: OrRequestEnvelope | null = o.previousEnvelope ?? null;
    // Signed reasoning belongs to the model/provider that produced it. Keep the
    // canonical ledger intact, but omit those opaque fields from earlier model
    // intervals in the outgoing API projection. Current tool-loop reasoning stays.
    const priorInterval = transportKind === 'openrouter' ? d.db.prepare(`
      SELECT json_array_length(p.payload_json,'$.messages') AS message_count
      FROM provider_requests p JOIN turns t ON t.id=p.turn_id
      LEFT JOIN background_runs b ON b.id=p.background_run_id
      WHERE p.window_id=? AND p.outcome='completed'
        AND (json_extract(p.payload_json,'$.model') IS NOT ?
          OR (json_extract(p.payload_json,'$.execution.entry') IS NOT NULL AND json_extract(p.payload_json,'$.execution.entry') <> ?))
        AND ((p.purpose='chat' AND t.state='completed') OR (b.retention='retained' AND b.trajectory_committed_at IS NOT NULL))
      ORDER BY p.dispatch_started_at DESC,p.rowid DESC LIMIT 1
    `).get(o.windowId, envelope.model, transportKind) as { message_count: number } | undefined : undefined;
    const projectModelHistory = <T extends { messages: OrMessage[] }>(value: T): T => {
      if (!priorInterval) return value;
      const projected = structuredClone(value);
      for (const message of projected.messages.slice(0, priorInterval.message_count + 1)) delete message.reasoning_details;
      return projected;
    };

    // WP4（§7.2，2026-10-08）：conversation_read 的片段级已见——工具结果
    // **实际进入下一模型请求**（onDispatch 首发即真实发出）才从 pending 转
    // active；仅取到工具结果而未发送（停止/轮次耗尽/错误收口）不算已见（O05）
    const toolSeenActive: ManifestEntry[] = [];
    let roundPendingSeen: ManifestEntry[] = (d.trajectory?.forWindow(o.windowId)?.pendingManifest ?? []).map(({ pending_dispatch: _pending, ...entry }) => ({ ...entry, visible: true }));
    const pendingSeenByTool = new Map<string, ManifestEntry[]>();
    let dispatched = false;
    let toolsExecuted = false; // C03：本轮是否真实执行过工具（含已应答）——失败保留协议的判据
    let lastSentMessages: OrMessage[] | null = null;
    let pendingCalls: MatchedCompleteBlock[] = [];
    let pendingAssistantIndex = -1;
    // Only a response from an actually admitted request may extend canonical
    // history. Finish every incomplete tool batch with explicit nonexecution;
    // an attempted tool with unknown outcome is recorded separately below.
    const incompleteProtocol = (code: string): OrMessage[] => {
      const answered = new Set(envelope.messages.slice(pendingAssistantIndex + 1).filter(m => m.role === 'tool').map(m => m.tool_call_id));
      return [...envelope.messages, ...pendingCalls.filter(t => !answered.has(t.tool_id)).map(t => ({ role: 'tool', tool_call_id: t.tool_id, content: JSON.stringify({ error_code: code, executed: false }) }) as OrMessage)];
    };
    const failedLoop = (result: import('./runner.ts').RunnerRunResult, code = 'EXECUTION_NOT_STARTED') => {
      // C03（四仓审计 20261106）：**执行过工具**的失败轮保留已实际发出的协议前缀与工具
      // 结果（未应答 pending 补显式未执行记录）——下一普通输入从此前缀接续，不丢工具
      // 往来、不重放副作用。无工具的失败轮不保留（消息重试语义：失败输入不进正史）。
      const finalMessages = dispatched && (toolsExecuted || pendingCalls.length > 0) ? incompleteProtocol(code) : null;
      if (finalMessages) {
        const compacted = this.compactBlockedResults(finalMessages, lastSentMessages?.length ?? 0, envelope.tools, envelope.maxTokens);
        const unseen = new Set([...compacted].flatMap(id => pendingSeenByTool.get(id) ?? []));
        roundPendingSeen = roundPendingSeen.filter(entry => !unseen.has(entry));
      }
      return { result, finalMessages, lastSentMessages, toolSeen: toolSeenActive, pendingToolSeen: roundPendingSeen };
    };
    const seqOf = (id: string): number => {
      const row = d.db.prepare('SELECT sequence FROM messages WHERE id = ?').get(id) as { sequence: number } | undefined;
      return row?.sequence ?? 0;
    };
    try {
    for (let round = 0; ; round++) {
      const batchRanges: CoverageRange[] = [];
      pendingCalls = [];
      pendingAssistantIndex = -1;
      const captured: MatchedCompleteBlock[] = [];
      let lastText = null as string | null; // 闭包内赋值（wrapped）：外层流分析按声明类型读（F-J-31）
      const prqId0 = `prq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const prqId = prqId0;
      let lastPrqId = prqId0; // D07：终态/计量归属**最后一次实际派发**的请求行（重试不再覆盖首发）
      const requestContext: ModelRequestContext = { requestId: prqId, entry: transportKind,
        requestedModel: envelope.model, responseModel: null, provider: transportKind === 'deepseek' ? 'deepseek' : null };
      const onResponseMetadata = (info: { model: string | null; provider: string | null }): void => {
        requestContext.responseModel = info.model;
        requestContext.provider = info.provider ?? requestContext.provider;
        recordRequestExecution(d.db, requestContext, o.background?.runId);
      };
      const wrapped: typeof o.onEvent = (ev) => {
        if (ev.kind === 'complete_message') {
          for (const b of ev.matched) if (b.block_type === 'tool_use') captured.push(b);
          const text = ev.matched.find((b) => b.block_type === 'text' && typeof b.text === 'string');
          if (text) lastText = text.text;
        }
        // F10 同 SDK 车道口径：观测到实际模型/切换模型时刷新本请求上下文——requested 不冒充实际。
        // message_start 携带的是请求侧模型（OR runner 即 envelope.model），仅在尚无更精确
        // 观测（onResponseMetadata/切换通知）时采纳，不倒退覆盖。
        if (ev.kind === 'message_start' && typeof ev.model === 'string' && ev.model && requestContext.responseModel === null) requestContext.responseModel = ev.model;
        else if (ev.kind === 'system_notice' && ev.subtype === 'model_refusal_fallback' && typeof ev.fallback_model === 'string' && ev.fallback_model) requestContext.responseModel = ev.fallback_model;
        o.onEvent(ev, requestContext); // 审计 F12：usage 按实际请求身份去重（不互覆）
      };
      // F17：发送前保存不可变协议投影（重放/对账依据；受保护字段，不进普通日志）
      // cost-20261018：每轮落上下文指纹（只含 hash/位置/计数）；同轮重试行共用同一指纹
      const fingerprint = contextFingerprintOf({ round, tools: envelope.tools, messages: envelope.messages, boundaries: envelope.boundaries });
      const fingerprintJson = JSON.stringify(fingerprint);
      const manifestJson = this.requestManifest(o.windowId, envelope.messages, [
        ...o.seenMessages, ...(o.liveSeenAdditions ?? []), ...toolSeenActive, ...roundPendingSeen,
        ...(o.inputBinding ? [{ id: o.inputBinding.messageId, revision: o.inputBinding.revision }] : []),
      ]);
      d.db.prepare('INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, payload_json, context_fingerprint_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(prqId, o.windowId, o.attemptId, o.turnId, o.purpose, manifestJson, JSON.stringify(envelope), fingerprintJson, new Date().toISOString());
      recordToolContext(d.db,prqId,o.windowId,envelope.messages,o.background ? {name:'background_complete',id:o.background.runId} : o.activeReviewId ? {name:'context_review_complete',id:o.activeReviewId} : undefined);
      // F03 尾：工具续请求每轮重算容量硬门（§4.2：连续工具回合每次重算，预留不是无限消费额度）
      const capacityNow = this.requestCapacity(envelope.messages, envelope.tools, envelope.maxTokens);
      if (capacityNow?.plan.action === 'blocked_hard') {
        d.db.prepare('UPDATE provider_requests SET outcome = ? WHERE id = ?').run('CAPACITY_BLOCKED_HARD', prqId);
        return failedLoop({ outcome: 'error', errorClassified: null, errorCode: 'CAPACITY_BLOCKED_HARD_TOOL_ROUND', errorMessage: `工具续请求输入估计 ${capacityNow.estimate} 超过安全上界 ${capacityNow.plan.safeInput}`, sessionId: null, requestId: null });
      }
      const payloadJson = JSON.stringify(envelope);
      // EXEC_V1 §03.6.2（WP3/M2）：发送边界物化——内部 asset_image 引用在此从不可变文件确定性
      // 物化为 Provider 图像块；envelope/payload_json（内部证据）与轨迹保持引用形态（Base64 不入库）。
      // previousPayload 同规则物化——append-only 断言在物化形态上执行（新旧同语义规则，不忽略失败）。
      const matEnv = async (env: typeof envelope): Promise<typeof envelope> => projectModelHistory(d.media ? await materializeEnvelope(env, d.media, id =>
        d.heartbeat?.readImage(id, o.conversationId, o.background?.runId)
        ?? (d.mediaTools ? d.mediaTools.readImage(id, o.conversationId) : d.media!.readContentResolvingMaster(id, { modelImage: true }))) as typeof envelope : env);
      const runEnvelope = await matEnv(envelope);
      // EXEC_V1 02 §4.2（WP2）：transport 前准入落账——每次尝试（含 429/网络/首字节前重试）
      // 单独记 dispatch_started_at 与 wire_v1 最终发包体；sent_at 仍=真实发送确认（响应头已到）。
      // 旧 onDispatch 建行的路径废除：发出但无响应的尝试不再从派发账本消失。
      const onBeforeDispatch = async (info: { attemptIndex: number; payloadWireJson: string }): Promise<void> => {
        if (o.controller.signal.aborted) throw new ContractError('CANCELLED_BEFORE_DISPATCH');
        if (runner instanceof SubscriptionAccessRunner) runner.invalidateSdkSession(o.windowId);
        if (round === 0) this.admitProgramFact(o.turnId, o.conversationId);
        if (o.inputBinding) {
          const current = d.messages.getMessage(o.inputBinding.messageId);
          if (!current || current.current_revision !== o.inputBinding.revision) throw new ContractError('INPUT_REVISION_SUPERSEDED');
        }
        // §04.10.1：driver 内每次重试都过同一准入（取消后不再发；请求数/预算逐笔预占）
        if (o.background) {
          if (o.background.isCancelRequested()) throw new ContractError('CANCELLED_BEFORE_DISPATCH');
          if (o.background.kind === 'keepwarm') {
            const sleep = keepwarmSleepState(d.config.background.keepwarm.sleep_window, this.nowMs());
            if (sleep.blocked) throw new ContractError(sleep.code!);
          }
          // S-06：心跳让位——用户消息已到来且本维护轮尚未开始新的付费请求（安全边界）
          if (o.background.yieldRequested?.()) throw new ContractError('KEEPWARM_YIELDED');
          const started = (d.db.prepare('SELECT model_requests_started FROM background_runs WHERE id = ?').get(o.background.runId) as { model_requests_started: number } | undefined)?.model_requests_started ?? 0;
          if (started >= o.background.maxModelRequests) throw new ContractError('BACKGROUND_BUDGET_EXHAUSTED');
        }
        const nowIso = new Date().toISOString();
        if (o.attemptId) d.surfacing?.markDispatched?.(o.attemptId);
        let bgDispatchId: string | null = null;
        if (o.background) {
          // B-01（2026-10-22）：真实费用上界预占——可缓存输入按未命中最坏写入价（1h TTL
          // 公开溢价 2×input；显式 cache_write_micro_per_token 配置优先）+ 输入价 + 最大输出。
          const rec = o.background.recordDispatch({ logicalActionKey: `model:r${round}:a${info.attemptIndex}`, attemptNo: info.attemptIndex + 1, dispatchKind: 'model', reservedCostMicroUsd: estimateModelRequestCostMicroUsd(d.db, runEnvelope) });
          if (!rec.allowed) throw new ContractError(rec.code ?? 'BACKGROUND_BUDGET_EXHAUSTED');
          bgDispatchId = rec.dispatchId;
        }
        if (info.attemptIndex === 0) {
          d.db.prepare("UPDATE provider_requests SET dispatch_started_at = ?, attempt_no = 0, payload_wire_json = ?, payload_format = 'wire_v1', background_run_id = COALESCE(?, background_run_id), background_dispatch_id = COALESCE(?, background_dispatch_id) WHERE id = ?")
            .run(nowIso, redactImageBlocksForStorage(info.payloadWireJson).redactedJson, o.background?.runId ?? null, bgDispatchId, prqId);
          lastPrqId = prqId;
        } else {
          const retryId = `prq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          d.db.prepare("INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, payload_json, context_fingerprint_json, payload_wire_json, payload_format, created_at, dispatch_started_at, attempt_no, background_run_id, background_dispatch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(retryId, o.windowId, o.attemptId, o.turnId, o.purpose, manifestJson, payloadJson, fingerprintJson, redactImageBlocksForStorage(info.payloadWireJson).redactedJson, 'wire_v1', nowIso, nowIso, info.attemptIndex, o.background?.runId ?? null, bgDispatchId);
          lastPrqId = retryId; // D07：后续终态/usage 记在真正承载本次发送的行
        }
        recordToolContext(d.db,lastPrqId!,o.windowId,envelope.messages,o.background ? {name:'background_complete',id:o.background.runId} : o.activeReviewId ? {name:'context_review_complete',id:o.activeReviewId} : undefined);
        requestContext.requestId = lastPrqId;
        requestContext.responseModel = null;
        requestContext.provider = transportKind === 'deepseek' ? 'deepseek' : null;
        recordRequestExecution(d.db, requestContext, o.background?.runId);
        if (round === 0 && info.attemptIndex === 0 && o.inputBinding) {
          if (o.turnId) d.voiceObservations?.commitProjection(o.inputBinding, o.turnId, prqId, o.voiceObservations ?? []);
          const message = d.messages.getMessage(o.inputBinding.messageId);
          // JV-08：语音接纳行已发布过 persisted（SDK driver 无本补发）——按
          // kind+turn_id 防重，DS/OR 与接纳路径不会双发同一事件
          const already = message ? (d.db.prepare('SELECT COUNT(*) n FROM runtime_stream_events WHERE kind = ? AND turn_id = ?').get('message.persisted', o.turnId) as { n: number }).n : 0;
          if (message && already === 0) d.events.publish('message.persisted', {
            conversationId:o.conversationId,turnId:o.turnId,attemptId:o.attemptId,
            entityRef:message.id,entityRevision:message.current_revision,
            payload:{message:{...message,mutation_status:{can_edit:false,can_withdraw:false,reason:'MESSAGE_ALREADY_DISPATCHED'}}},
          });
        }
        if (o.background?.kind === 'keepwarm') {
          await this.admitHeartbeatDispatch(o.background.runId, lastPrqId, bgDispatchId, envelope.messages, o.controller.signal);
        }
        dispatched = true;
        lastSentMessages = envelope.messages;
      };
      let roundSeenPromoted = false; // 本轮首个真实响应=工具结果实际进入模型（429 重试后成功同算——修 O05 边角）
      let roundGenerationId: string | null = null; // R07：本轮工具事件的 provider 生成标识
      const onDispatch = (info: { attemptIndex: number; generationId: string | null }): void => {
        roundGenerationId = info.generationId ?? roundGenerationId;
        if (!roundSeenPromoted) {
          roundSeenPromoted = true;
          // WP4（O05）：请求真实发出=上一轮工具结果（含 conversation_read 片段）
          // 进入模型视野——pending 片段转正为已见
          if (roundPendingSeen.length > 0) {
            toolSeenActive.push(...roundPendingSeen);
            roundPendingSeen = [];
            pendingSeenByTool.clear();
          }
        }
        this.confirmModelRequest(o, { requestId: lastPrqId, round, ...info, messages: envelope.messages, confirmedSeen: toolSeenActive });
      };
      let previousPayload = prevEnvelope && (!orFallback || round > 0) ? this.buildPayloadFrom(await matEnv(prevEnvelope), transportKind) : null;
      // Compare against the last real wire request with the same native tool
      // profile. A scoped task has a different tool list, not a different history.
      // 整合（2026-10-24）：轨迹本轮重建（懒初始化）=合法新基线——旧 wire 锚不再可比，豁免
      if (round === 0 && prevEnvelope && !o.trajectoryRebuiltThisTurn && !orFallback) {
        const anchor = d.db.prepare(`SELECT p.payload_wire_json FROM provider_requests p
          JOIN turns t ON t.id=p.turn_id LEFT JOIN background_runs b ON b.id=p.background_run_id
          WHERE p.window_id=? AND p.outcome='completed' AND p.sent_at IS NOT NULL
            AND p.payload_format='wire_v1' AND p.payload_wire_json IS NOT NULL
            AND (? = 0 OR json_extract(p.context_fingerprint_json, '$.tools_hash') = ?)
            AND ((p.purpose='chat' AND t.state='completed') OR (b.retention='retained' AND b.trajectory_committed_at IS NOT NULL))
          ORDER BY p.dispatch_started_at DESC,p.rowid DESC LIMIT 1`).get(o.windowId, Number(usesScopedToolProfiles), fingerprint.tools_hash) as { payload_wire_json: string } | undefined;
        if (anchor) {
          const recorded = JSON.parse(anchor.payload_wire_json) as Record<string, unknown>;
          if (this.drv()?.kind === 'deepseek' && legacyDsReasoningGap(recorded, this.buildPayloadFrom(runEnvelope))) {
            return failedLoop({ outcome: 'error', errorClassified: null, errorCode: 'DS_PROTOCOL_HISTORY_REQUIRES_NEW_WINDOW', errorMessage: '旧窗口缺少已发送的模型协议内容，请通过正常手动换窗选择原文后继续；已有历史保持不变。', sessionId: null, requestId: null });
          }
          // Stored redacted image payloads cannot be compared as exact wire bytes.
          if (!hasStorageImageRedaction(recorded)) {
            previousPayload = projectModelHistory(recorded as Record<string, unknown> & { messages: OrMessage[] });
            // Only the retired binding surface may disappear from a legacy
            // provider tool list. The recorded wire and message prefix stay intact.
            if (Array.isArray(previousPayload.tools)) previousPayload = {
              ...previousPayload, tools: modelToolsAfterBindingRetirement(previousPayload.tools),
            };
          }
        }
      }
      const result = await Promise.race([
        runner.run({ driver: this.drv()?.kind === 'mock' ? 'mock' : transportKind, purpose: o.purpose, envelope: runEnvelope, previousPayload, allowToolAppend: requestToolset?.onDemand, abortController: o.controller, onEvent: wrapped, onDispatch, onBeforeDispatch, onResponseMetadata,
          // R2：mock 的会话连续性（AUD-03 断言）经信封请求的可选 SDK 形状字段传递；
          // route-edit 的 fresh_session 重跑不 resume 旧 session（同旧 prompt 车道语义）
          ...(this.drv()?.kind === 'mock' && o.attemptId ? { resumeSessionId: (d.db.prepare('SELECT CASE WHEN a.fresh_session = 1 THEN NULL ELSE w.sdk_session_id END AS s FROM attempts a JOIN windows w ON w.id = a.window_id WHERE a.id = ?').get(o.attemptId) as { s: string | null } | undefined)?.s ?? null } : {}) }),
        new Promise<never>((_, reject) => {
          const arm = (): void => { setTimeout(() => reject(new Error('RUNNER_GRACE_TIMEOUT')), RUNNER_GRACE_MS).unref?.(); };
          if (o.controller.signal.aborted) arm();
          else o.controller.signal.addEventListener('abort', arm, { once: true });
        }),
      ]).catch((err): import('./runner.ts').RunnerRunResult => {
        const isGrace = String((err as Error)?.message ?? err).includes('GRACE');
        if (isGrace) o.controller.abort();
        return { outcome: isGrace ? 'interrupted' : 'error', errorClassified: null, errorCode: isGrace ? 'RUNNER_GRACE_TIMEOUT' : 'RUNNER_THREW', errorMessage: String((err as Error)?.message ?? err), sessionId: null, requestId: null };
      });
      // D07：终态与 generation 写到**最后一次实际派发**的行；被重试取代的首发行如实标注，不被后次覆盖
      d.db.prepare('UPDATE provider_requests SET generation_id = ?, outcome = ? WHERE id = ?').run(result.requestId, result.outcome, lastPrqId);
      if (lastPrqId !== prqId) {
        d.db.prepare("UPDATE provider_requests SET outcome = 'SUPERSEDED_BY_RETRY' WHERE id = ? AND outcome IS NULL").run(prqId);
      }
      if (result.outcome !== 'completed') return failedLoop(result);
      if (o.heartbeatMode && o.background?.isCancelRequested()) {
        return failedLoop({ ...result, outcome: 'interrupted', errorCode: 'STOPPED_DURING_RESPONSE' });
      }
      if (captured.length === 0) {
        // 最终回复：assistant 文本入轨迹（协议历史的正式组成，供后续轮次与缓存前缀）。
        // F18：lastSentMessages=本轮实际发送的消息（不含未发送的最终 assistant）——G 候选边界
        const finalMessages = lastText !== null && lastText.length > 0
          ? [...envelope.messages, assistantProtocolMessage(lastText, result, this.drv()?.kind)]
          : envelope.messages;
        return { result, finalMessages, lastSentMessages: envelope.messages, toolSeen: toolSeenActive, pendingToolSeen: roundPendingSeen };
      }
      // WAKE_KEEPWARM_V1（2026-10-22）：心跳与自主共用完整工具执行循环——
      // 旧 KEEPWARM_TOOL_REFUSED 零工具封锁已删除（06 §4：修复所有心跳特有限制）。
      prevEnvelope = envelope;
      // F13：已发布正文随 assistant 消息续传（原样保留，§2.2）；opaque reasoning 片段作为
      // 协议继续态原样携带（§10：不解释不重构；真实端点兼容性=WP6 实测项，此处不冒称已验证）
      const assistantContinue: Record<string, unknown> = {
        role: 'assistant',
        content: lastText ?? null,
        tool_calls: captured.map((t) => ({ id: t.tool_id, type: 'function', function: { name: t.tool_name ?? '', arguments: t.text ?? '{}' } })),
      };
      if (result.reasoningFrames && result.reasoningFrames.length > 0) {
        // 审计 F13：各帧 delta 的 reasoning_details 是一维数组——续传必须展平回一维 object[]，
        // 不得嵌套成 object[][]（batch2 旧断言锁定的就是错误形状，已同步修正）
        const flat = (result.reasoningFrames as unknown[]).flatMap((f) => (Array.isArray(f) ? f : [f]));
        assistantContinue.reasoning_details = flat;
      }
      // D01（审计 3655d60）：DS thinking 型号在同一工具回合的续请求必须原样回传 reasoning_content
      // （当前带 tools 的 DS 合同要求跨轮原样保留；只进受保护协议轨迹，不入 UI 正文）。
      // 仅 DS 驱动携带；OR 的协议继续态走上面的 reasoning_details 通道，两不混淆。
      if (this.drv()?.kind === 'deepseek' && typeof (result as { reasoningContent?: unknown }).reasoningContent === 'string' && (result as { reasoningContent: string }).reasoningContent.length > 0) {
        assistantContinue.reasoning_content = (result as { reasoningContent: string }).reasoningContent;
      }
      pendingAssistantIndex = envelope.messages.length;
      pendingCalls = captured;
      envelope = { ...envelope, messages: [...envelope.messages, assistantContinue as unknown as OrMessage] };
      if (lastSentMessages) {
        this.observeHeartbeatBatch(o, lastPrqId, envelope.messages.slice(pendingAssistantIndex), lastSentMessages, toolSeenActive);
      }
      // §3.3：同一批里既有 hold 又有 complete → 先执行并核实全部写操作，最后才验证 complete（不并发抢先放行）。
      // 审计 F04：complete 按模型原始顺序排在 hold 前 was 错误签发路径；此处强制重排。
      const ordered = [
        ...captured.filter((t) => effectiveToolName(t.tool_name ?? '', t.text) !== 'context_review_complete'),
        ...captured.filter((t) => effectiveToolName(t.tool_name ?? '', t.text) === 'context_review_complete'),
      ];
      for (const t of ordered) {
        if (readTurnCompletion(d.db, o.attemptId, o.turnId) &&
            effectiveToolName(t.tool_name ?? '', t.text) !== TURN_COMPLETION_TOOL) {
          envelope = { ...envelope, messages: [...envelope.messages, {
            role: 'tool', tool_call_id: t.tool_id, content: JSON.stringify({ error_code: 'TURN_COMPLETED', executed: false }),
          } as OrMessage] };
          continue;
        }
        // 审计 F07：停止后不再分派同批后续工具（内容 fence 不足以拦新副作用——executor 真的会写 Mariposa）
        if (o.controller.signal.aborted) {
          return failedLoop({ outcome: 'interrupted', errorClassified: null, errorCode: 'STOPPED_DURING_TOOLS', errorMessage: '停止：同批后续工具不再分派（已发起写单独保留待核）', sessionId: null, requestId: result.requestId }, 'EXECUTION_CANCELLED');
        }
        if (o.background?.kind === 'keepwarm') {
          const sleep = keepwarmSleepState(d.config.background.keepwarm.sleep_window, this.nowMs());
          if (sleep.blocked) return failedLoop({ outcome: 'completed', errorClassified: null, errorCode: sleep.code, errorMessage: '睡眠时段暂停心跳——后续工具不再派发，已完成动作保留', sessionId: null, requestId: result.requestId }, sleep.code!);
        }
        // S-06：心跳安全边界让位——用户消息到来后不再分派后续工具；已执行工具的
        // 真实回执与已发布消息保留（不抹掉、不重复写），本轮按让位收口（completed：
        // 协议链在 provider_requests 留证，后续发布经 catchup 进入下一轮）。
        if (o.background?.yieldRequested?.()) {
          return failedLoop({ outcome: 'interrupted', errorClassified: null, errorCode: 'KEEPWARM_YIELDED', errorMessage: '用户消息到来：心跳让位——已执行工具回执保留，后续工具不再分派', sessionId: null, requestId: result.requestId }, 'KEEPWARM_YIELDED');
        }
        // PURE_ACK 判定：任意工具调用（含 catalog/define/只读）→实质行为（06 §2，按调用计数）
        if (o.background?.observeToolCall) o.background.observeToolCall();
        toolsExecuted = true;
        // The real executor validates the frozen definition and arguments before
        // quoting/admitting its effective handler. Never quote tool_invoke as free.
        const toolDispatch: { current: { id: string; quote: BackgroundToolQuote } | null } = { current: null };
        const argumentSource = t.text ?? undefined;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(argumentSource ?? '{}') as Record<string, unknown>;
        } catch {
          args = {}; // 参数非法：执行器会因缺必填字段拒绝（§8.2 输入完整校验后才执行）
        }
        let exec: ToolExecResult;
        try {
        exec = await d.tools!.execute(t.tool_name ?? '', args, {
          signal: o.controller.signal, // 语音分支：取消传播（电话/检索取消链）
          argumentSource,
          remainingResultBytes: () => this.remainingToolResultBytes(envelope.messages, envelope.tools, envelope.maxTokens),
          roomId: o.conversationId, windowId: o.windowId, turnId: o.turnId, purpose: o.purpose, backgroundRunId: o.background?.runId ?? null,
          activeReviewId: o.activeReviewId, seenSequence: o.seenSequence,
          seenMessages: [...o.seenMessages, ...(o.liveSeenAdditions ?? []), ...toolSeenActive.map(m => (m.char_start !== undefined ? { id: m.id, revision: m.revision, char_start: m.char_start, char_end: m.char_end } : { id: m.id, revision: m.revision }))], // D13：含流式期间新发布的已见原话；WP4：含已实际进入请求的回读片段
          requestId: lastPrqId, // internal request ledger identity; provider generation is separate
          ...(o.inputBinding ? { sourceMessageId: o.inputBinding.messageId } : {}),
          // R07（审计 FE-12）：工具生命周期统一身份
          toolCallId: t.tool_id, attemptId: o.attemptId, round, generationId: roundGenerationId,
          ...(o.turnId && t.tool_id && lastSentMessages && d.trajectory ? {
            recordCompletionCheckpoint: receipt => stageTurnCompletion(d.db, {
              requestId: lastPrqId, windowId: o.windowId, turnId: o.turnId!, attemptId: o.attemptId, callId: t.tool_id!,
              batch: { tail: envelope.messages.slice(pendingAssistantIndex), inFlight: [], sentMessages: lastSentMessages! },
              receipt, manifestAdditions: o.completionManifest ?? [], confirmedSeen: toolSeenActive, pendingSeen: roundPendingSeen,
              heartbeatHostText: o.heartbeatHostText,
            }),
          } : {}),
          ...(o.background?.kind === 'keepwarm' && t.tool_id ? {
            recordCommittedToolReceipt: receipt => appendCompletionToolReceipt(d.db, o.attemptId, t.tool_id!, receipt, []),
          } : {}),
          ...(o.background ? { beforeBackgroundTool: (quote: BackgroundToolQuote) => {
            const rec = o.background!.recordDispatch({ logicalActionKey: `tool:${t.tool_id}`, attemptNo: 1, dispatchKind: 'tool', reservedCostMicroUsd: quote.maxCostMicroUsd, capabilityName: quote.toolName });
            if (!rec.allowed) throw new ContractError(rec.code ?? 'BACKGROUND_TOOL_ADMISSION_REJECTED');
            toolDispatch.current = { id: rec.dispatchId, quote };
            if (o.background?.kind === 'keepwarm' && t.tool_id) markHeartbeatToolStarted(d.db, o.attemptId, lastPrqId, t.tool_id);
          } } : {}),
        });
        } catch (error) {
          if ((error as { code?: string }).code === 'IDEMPOTENCY_CONFLICT') {
            exec = { ok: false, output: { error_code: 'IDEMPOTENCY_CONFLICT' } };
          } else if (o.background && toolDispatch.current === null) {
            const code = error instanceof ContractError ? error.code : 'BACKGROUND_TOOL_ADMISSION_REJECTED';
            return failedLoop({ outcome: 'error', errorClassified: null, errorCode: code, errorMessage: '后台工具未通过报价或派发准入，尚未开始执行。', sessionId: null, requestId: result.requestId }, code);
          } else {
            envelope = { ...envelope, messages: [...envelope.messages, { role: 'tool', tool_call_id: t.tool_id, content: JSON.stringify({ error_code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN', outcome: 'unknown' }) } as OrMessage] };
            return failedLoop({ outcome: 'error', errorClassified: 'unknown', errorCode: 'TOOL_EXECUTION_OUTCOME_UNKNOWN', errorMessage: '工具已尝试执行，但未取得可信结果；不自动重放。', sessionId: null, requestId: result.requestId });
          }
        }
        if (exec.ok && toolDispatch.current?.quote.verifiedFree) {
          settleBackgroundDispatch(d.db, toolDispatch.current.id, { actualCostMicroUsd: 0, outcomeCode: 'verified_free_tool' });
        }
        // RE-05（2026-10-24）：工具结果携带内部图引用（如 oido_view 测量图）且当前型号
        // 已核实支持图像 → 工具消息正文=文本 JSON + asset_image 引用块（发送边界物化为
        // 原生图块，存储侧照常脱敏）；未核实/不支持 → 仅文本（工具 JSON 内已如实声明
        // 图未随正文携带，模型不得声称已看图）
        if (exec.ok && exec.imageRefs?.length && !await this.modelSupportsImages(envelope.model, driverKind === 'mock' ? 'mock' : transportKind)) {
          exec = { ok: false, output: { error_code: 'MODEL_VISION_UNAVAILABLE', detail: '工具已执行，但当前型号未核实支持图片，图片未交付。' } };
        }
        if (exec.ok && batchRanges.length && exec.coverageProjection) {
          exec = { ...exec, ...exec.coverageProjection(batchRanges) };
        }
        if (exec.ok && exec.coverageAdditions) batchRanges.push(...exec.coverageAdditions);
        // WP4：conversation_read 等只读工具返回的已见增量——先入 pending，
        // 随工具结果进入下一请求时转正（O05：取到结果≠已见）
        if (exec.seenAdditions && exec.seenAdditions.length > 0) {
          const additions: ManifestEntry[] = [];
          for (const a of exec.seenAdditions) {
            additions.push({
              id: a.id, revision: a.revision, seq: seqOf(a.id), origin: 'tool', visible: true,
              ...(a.char_start !== undefined ? { char_start: a.char_start, char_end: a.char_end } : {}),
            });
          }
          if (t.tool_id) pendingSeenByTool.set(t.tool_id, additions);
          roundPendingSeen.push(...additions);
        }
        envelope = { ...envelope, messages: [...envelope.messages, {role:'tool',tool_call_id:t.tool_id,content:toolResultContent(exec)} as OrMessage] };
        if (o.background?.kind === 'keepwarm' && t.tool_id) {
          appendCompletionToolReceipt(d.db, o.attemptId, t.tool_id, exec, pendingSeenByTool.get(t.tool_id) ?? []);
        }
        const addition = exec.activatedTool;
        if (exec.ok && addition && !envelope.tools.some(tool => (tool as HostToolSpec).function.name === addition.function.name)) {
          envelope = { ...envelope, tools: [...envelope.tools, addition] };
        }
        this.recordToolCoverage(lastPrqId, t.tool_id, exec);

      }
      if (readTurnCompletion(d.db, o.attemptId, o.turnId)) {
        // Final tool receipts are canonical locally; only the previous request
        // was sent. The next natural request carries the new protocol tail.
        return { result, finalMessages: envelope.messages, lastSentMessages, toolSeen: toolSeenActive, pendingToolSeen: roundPendingSeen };
      }
      if (o.activeReviewId && d.reviews?.get(o.activeReviewId)?.status === 'completed') {
        return { result, finalMessages: null, lastSentMessages: null, toolSeen: toolSeenActive, pendingToolSeen: roundPendingSeen }; // §3.3：complete 最后验证；完成后收口，评审请求不进对话轨迹
      }
    }
    } catch (error) {
      return failedLoop({ outcome: 'error', errorClassified: 'unknown', errorCode: stableCode(error), errorMessage: String((error as Error).message ?? error), sessionId: null, requestId: null });
    }
  }

  private requestManifest(windowId: string, messages: readonly OrMessage[], seen: readonly SeenRef[]): string {
    const opening = this.bootstrapMachine.coverageFor(windowId, messages);
    return JSON.stringify([
      ...seen.map(ref => ({ ...ref, visible: true })),
      ...(opening ? [opening] : []),
    ]);
  }

  private recordToolCoverage(requestId: string | null, toolCallId: string | null, result: ToolExecResult): void {
    if (!requestId || !toolCallId || !result.ok || !result.coverageAdditions?.length) return;
    // Ranges describe the projected result. The tool ID must later appear in a
    // confirmed request before this metadata can establish actual coverage.
    this.d.db.prepare("UPDATE provider_requests SET seen_manifest_json=json_insert(seen_manifest_json, '$[#]', json(?)) WHERE id=?")
      .run(JSON.stringify({ tool_coverage: [{ tool_call_id: toolCallId, ranges: result.coverageAdditions }] }), requestId);
  }

  /** Older SDK sessions persisted a copy of each guide in the next selected message.
   * Match those leading blocks against the frozen selection before rebuilding. */
  private restoreSdkSelectionHistory(windowId: string, messages: OrMessage[]): OrMessage[] {
    const firstGuide = messages.findIndex(m => m.role === 'system' && m.guide === true);
    if (firstGuide === -1) return messages;
    const items = this.d.selections?.forTargetWindow(windowId)?.items;
    if (!items?.length) return messages;

    let guide: string | undefined;
    let selectedIndex = 0;
    let restored: OrMessage[] | undefined;
    for (let i = firstGuide; i < messages.length && selectedIndex < items.length; i++) {
      const message = messages[i]!;
      if (message.role === 'system') {
        guide = message.guide === true && Array.isArray(message.content) ? message.content[0]?.text : undefined;
        continue;
      }
      const item = items[selectedIndex++]!;
      if (message.role !== (item.speaker === 'owner' ? 'user' : 'assistant')) return messages;
      if (guide && Array.isArray(message.content)) {
        const blocks = message.content;
        let copies = 0;
        while (blocks[copies]?.type === 'text' && blocks[copies]?.text === guide) copies++;
        if (copies > 0) {
          // A real selected message can itself be the same literal guide.
          // Legacy sequence-prefixed originals already sit after the added copies.
          const originalHasGuideText = sha256Hex(guide) === item.content_hash;
          const originalHasSequencePrefix = blocks[copies]?.text === `[${item.sequence}]\n${guide}`;
          if (originalHasGuideText && !originalHasSequencePrefix) copies--;
          if (copies > 0) (restored ??= messages.slice())[i] = { ...message, content: blocks.slice(copies) };
        }
      }
      guide = undefined;
    }
    return restored ?? messages;
  }

  private async runSdkToolLoop(o: Parameters<TurnSupervisor['runOrToolLoop']>[0]): Promise<Awaited<ReturnType<TurnSupervisor['runOrToolLoop']>>> {
    const d = this.d;
    const runner = (d.runnerSelection as Extract<RunnerSelection, { status: 'ok' }>).runner;
    const systemPrompt = o.envelope.messages.filter(m => m.role === 'system').flatMap(m => typeof m.content === 'string'
      ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text ?? ''));
    const cwd = buildPaths(resolveStateRoot(process.env.ESTOMAGO_HOME)).workspacesDir;
    const options = subscriptionSdkOptions({ ...d.config, runtime: { ...d.config.runtime, model: o.envelope.model } }, systemPrompt, cwd);
    const sdkEffort = o.envelope.reasoning?.effort;
    if (sdkEffort) options.options.effort = sdkEffort as import('../config/schema.ts').ThinkingEffort;
    const toolSeen: ManifestEntry[] = [];
    const batchRanges: CoverageRange[] = [];
    let pendingToolSeen: ManifestEntry[] = (d.trajectory?.forWindow(o.windowId)?.pendingManifest ?? []).map(({ pending_dispatch: _pending, ...entry }) => ({ ...entry, visible: true }));
    const pendingSeenByTool = new Map<string, ManifestEntry[]>();
    let requestId: string | null = null;
    let generationId: string | null = null;
    let dispatchId: string | null = null;
    let lastSentMessages: OrMessage[] | null = null;
    const requestContext: ModelRequestContext = { requestId: null, entry: 'claude-agent-sdk',
      requestedModel: o.envelope.model, responseModel: null, provider: 'firstParty' };
    const result = await runner.run({
      driver: 'claude-agent-sdk', prompt: '', options, resumeSessionId: null, abortController: o.controller,
      onEvent: ev => {
        if (ev.kind === 'message_stop' && requestId) d.db.prepare('UPDATE provider_requests SET outcome=? WHERE id=?').run('completed', requestId);
        o.onEvent(ev, requestContext);
      },
      host: {
        windowId: o.windowId, purpose: o.purpose, envelope: o.envelope,
        isolatedSession: o.scopedTaskTools,
        completionRequested: () => readTurnCompletion(d.db, o.attemptId, o.turnId) !== null,
        captureCompletionBatch: Boolean(o.turnId && d.trajectory),
        captureHeartbeatBatch: o.background?.kind === 'keepwarm' && Boolean(o.turnId && d.trajectory),
        ...(o.background?.kind === 'keepwarm' ? { observeHeartbeatBatch: (tail: OrMessage[], sent: OrMessage[]) => {
          if (requestId) this.observeHeartbeatBatch(o, requestId, tail, sent, toolSeen);
        } } : {}),
        // 2026-10-31 她批：SDK 原生媒体投影——发送边界物化（sdk-host-query/sdk-history），
        // 账本/持久化保持 asset_image 引用形态；无媒体服务（无 d.media）不注入→保留未核实门。
        ...(d.media ? { readImage: (assetId: string) => d.heartbeat?.readImage(assetId, o.conversationId, o.background?.runId)
          ?? (d.mediaTools ? d.mediaTools.readImage(assetId, o.conversationId) : d.media!.readContentResolvingMaster(assetId, { modelImage: true })) } : {}),
        beforeModel: async (messages, round) => {
          if (o.controller.signal.aborted) throw new ContractError('CANCELLED_BEFORE_DISPATCH');
          if (round > 0 && readTurnCompletion(d.db, o.attemptId, o.turnId)) throw new ContractError('TURN_COMPLETED_STOP');
          if (round === 0) this.admitProgramFact(o.turnId, o.conversationId);
          if (o.inputBinding && d.messages.getMessage(o.inputBinding.messageId)?.current_revision !== o.inputBinding.revision) throw new ContractError('INPUT_REVISION_SUPERSEDED');
          if (this.requestCapacity(messages, o.envelope.tools, o.envelope.maxTokens)?.plan.action === 'blocked_hard') {
            throw new ContractError('CAPACITY_BLOCKED_HARD_TOOL_ROUND');
          }
          if (o.background) {
            if (o.background.isCancelRequested()) throw new ContractError('CANCELLED_BEFORE_DISPATCH');
            if (o.background.yieldRequested?.()) throw new ContractError('KEEPWARM_YIELDED');
            if (o.background.kind === 'keepwarm' && keepwarmSleepState(d.config.background.keepwarm.sleep_window, this.nowMs()).blocked) throw new ContractError('KEEPWARM_SLEEP_WINDOW');
            const started = (d.db.prepare('SELECT model_requests_started FROM background_runs WHERE id=?').get(o.background.runId) as { model_requests_started: number }).model_requests_started;
            if (started >= o.background.maxModelRequests) throw new ContractError('BACKGROUND_BUDGET_EXHAUSTED');
            // The official preflight has just confirmed included subscription
            // usage and disabled overage. OR fallback retains its existing quote.
            const admission = o.background.recordDispatch({ logicalActionKey: `sdk:model:${round}`, attemptNo: 1, dispatchKind: 'model', reservedCostMicroUsd: 0 });
            if (!admission.allowed) throw new ContractError(admission.code ?? 'BACKGROUND_BUDGET_EXHAUSTED');
            dispatchId = admission.dispatchId;
          }
          requestId = genId('prq');
          const envelope = { ...o.envelope, messages };
          const at = new Date().toISOString();
          d.db.prepare(`INSERT INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,context_fingerprint_json,payload_format,created_at,dispatch_started_at,attempt_no,background_run_id,background_dispatch_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(requestId, o.windowId, o.attemptId, o.turnId, o.purpose,
            this.requestManifest(o.windowId, messages, [
              ...o.seenMessages, ...(o.liveSeenAdditions ?? []), ...toolSeen, ...pendingToolSeen,
              ...(o.inputBinding ? [{ id: o.inputBinding.messageId, revision: o.inputBinding.revision }] : []),
            ]), JSON.stringify(envelope),
            contextFingerprintJson({ round, tools: envelope.tools, messages, boundaries: envelope.boundaries }),
            'sdk_projection_v1', at, at, 0, o.background?.runId ?? null, dispatchId);
          recordToolContext(d.db,requestId,o.windowId,messages,o.background ? {name:'background_complete',id:o.background.runId} : o.activeReviewId ? {name:'context_review_complete',id:o.activeReviewId} : undefined);
          requestContext.requestId = requestId;
          requestContext.responseModel = null;
          recordRequestExecution(d.db, requestContext, o.background?.runId);
          if (o.background?.kind === 'keepwarm') {
            await this.admitHeartbeatDispatch(o.background.runId, requestId, dispatchId, messages, o.controller.signal);
          }
          lastSentMessages = structuredClone(messages);
          if (round === 0 && o.inputBinding && o.turnId) d.voiceObservations?.commitProjection(o.inputBinding, o.turnId, requestId, o.voiceObservations ?? []);
          d.surfacing?.markDispatched?.(o.attemptId);
        },
        modelStarted: (id, round, model) => {
          generationId = id;
          requestContext.responseModel = model ?? null;
          recordRequestExecution(d.db, requestContext, o.background?.runId);
          toolSeen.push(...pendingToolSeen); pendingToolSeen = [];
          pendingSeenByTool.clear();
          batchRanges.length = 0;
          if (requestId && lastSentMessages) {
            this.confirmModelRequest(o, { requestId, round, attemptIndex: 0, generationId: id, messages: lastSentMessages, confirmedSeen: toolSeen });
          }
        },
        recordToolDelivery: (toolCallId, result) => {
          this.recordToolCoverage(requestId, toolCallId, result);
          if (o.background?.kind === 'keepwarm' || readTurnCompletion(d.db, o.attemptId, o.turnId)) {
            appendCompletionToolReceipt(d.db, o.attemptId, toolCallId, result, pendingSeenByTool.get(toolCallId) ?? []);
          }
        },
        executeTool: async (name, args, toolCallId, round, messages = o.envelope.messages, argumentSource, completionBatch) => {
          if (!d.tools) throw new ContractError('HOST_TOOLS_UNAVAILABLE');
          if (o.controller.signal.aborted || o.background?.isCancelRequested()) throw new ToolNotDispatched('EXECUTION_CANCELLED');
          if (o.background?.kind === 'keepwarm' && keepwarmSleepState(d.config.background.keepwarm.sleep_window, this.nowMs()).blocked) throw new ToolNotDispatched('KEEPWARM_SLEEP_WINDOW');
          if (o.background?.yieldRequested?.()) throw new ToolNotDispatched('KEEPWARM_YIELDED');
          o.background?.observeToolCall?.();
          let toolDispatch: { id: string; quote: BackgroundToolQuote } | null = null;
          let executed: ToolExecResult;
          try {
          executed = await d.tools.execute(name, args, {
            signal: o.controller.signal, roomId: o.conversationId, windowId: o.windowId, turnId: o.turnId,
            argumentSource,
            remainingResultBytes: () => this.remainingToolResultBytes(messages, o.envelope.tools, o.envelope.maxTokens),
            purpose: o.purpose, backgroundRunId: o.background?.runId ?? null,
            activeReviewId: o.activeReviewId, seenSequence: o.seenSequence,
            seenMessages: [...o.seenMessages, ...(o.liveSeenAdditions ?? []), ...toolSeen],
            requestId: requestId!, toolCallId, attemptId: o.attemptId, round, generationId,
            ...(completionBatch && o.turnId && d.trajectory ? {
              recordCompletionCheckpoint: receipt => {
                const batch = completionBatch();
                const pending = batch.tail.filter(message => message.role === 'tool')
                  .flatMap(message => pendingSeenByTool.get(String(message.tool_call_id)) ?? []);
                stageTurnCompletion(d.db, {
                  requestId: requestId!, windowId: o.windowId, turnId: o.turnId!, attemptId: o.attemptId, callId: toolCallId,
                  batch, receipt, manifestAdditions: o.completionManifest ?? [], confirmedSeen: toolSeen, pendingSeen: pending,
                  heartbeatHostText: o.heartbeatHostText,
                });
              },
            } : {}),
            ...(o.background?.kind === 'keepwarm' ? {
              recordCommittedToolReceipt: receipt => appendCompletionToolReceipt(d.db, o.attemptId, toolCallId, receipt, []),
            } : {}),
            ...(o.inputBinding ? { sourceMessageId: o.inputBinding.messageId } : {}),
            ...(o.background ? { beforeBackgroundTool: (quote: BackgroundToolQuote) => {
              const admission = o.background!.recordDispatch({ logicalActionKey: `tool:${toolCallId}`, attemptNo: 1, dispatchKind: 'tool', reservedCostMicroUsd: quote.maxCostMicroUsd, capabilityName: quote.toolName });
              if (!admission.allowed) throw new ContractError(admission.code ?? 'BACKGROUND_TOOL_ADMISSION_REJECTED');
              toolDispatch = { id: admission.dispatchId, quote };
              if (o.background?.kind === 'keepwarm' && requestId) markHeartbeatToolStarted(d.db, o.attemptId, requestId, toolCallId);
            } } : {}),
          });
          } catch (error) {
            if ((error as { code?: string }).code === 'IDEMPOTENCY_CONFLICT') {
              executed = { ok: false, output: { error_code: 'IDEMPOTENCY_CONFLICT' } };
            } else if (o.background && toolDispatch === null) {
              throw new ToolNotDispatched(error instanceof ContractError ? error.code : 'BACKGROUND_TOOL_ADMISSION_REJECTED');
            } else {
              throw error;
            }
          }
          const settled = toolDispatch as { id: string; quote: BackgroundToolQuote } | null;
          if (executed.ok && settled?.quote.verifiedFree) settleBackgroundDispatch(d.db, settled.id, { actualCostMicroUsd: 0, outcomeCode: 'verified_free_tool' });
          if (executed.ok && batchRanges.length && executed.coverageProjection) {
            executed = { ...executed, ...executed.coverageProjection(batchRanges) };
          }
          if (executed.seenAdditions?.length) {
            const additions = executed.seenAdditions.map((seen): ManifestEntry => {
              const row = d.db.prepare('SELECT sequence FROM messages WHERE id=?').get(seen.id) as { sequence: number } | undefined;
              return { ...seen, seq: row?.sequence ?? 0, origin: 'tool', visible: true };
            });
            pendingSeenByTool.set(toolCallId, additions);
            pendingToolSeen.push(...additions);
          }
          if (executed.ok && !executed.imageRefs?.length && executed.coverageAdditions) batchRanges.push(...executed.coverageAdditions);
          return executed;
        },
      },
    });
    if (requestId) d.db.prepare('UPDATE provider_requests SET outcome=? WHERE id=?').run(result.outcome, requestId);
    // RB03（复审 20261106）：维护轮（cache_keepalive）成功同样 rebind——协议保留后
    // 维护记录属于当前 SDK 会话，宿主会话投影与原生锚同一事实。
    if (result.sessionId && !o.scopedTaskTools) {
      const old = d.windows.get(o.windowId)?.sdk_session_id ?? null;
      d.windows.rebindSession(o.windowId, old, result.sessionId);
    }
    const finalMessages = lastSentMessages ? result.finalMessages ?? null : null;
    const sent = result.lastSentMessages ?? lastSentMessages;
    if (result.outcome !== 'completed' && finalMessages) {
      const compacted = this.compactBlockedResults(finalMessages, sent?.length ?? 0, o.envelope.tools, o.envelope.maxTokens);
      const unseen = new Set([...compacted].flatMap(id => pendingSeenByTool.get(id) ?? []));
      pendingToolSeen = pendingToolSeen.filter(entry => !unseen.has(entry));
    }
    return { result, finalMessages, lastSentMessages: sent, toolSeen, pendingToolSeen };
  }

  private async admitHeartbeatDispatch(
    runId: string, requestId: string, dispatchId: string | null, messages: OrMessage[], signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.d.heartbeat?.beforeDispatch(runId, requestId, messages, signal);
    } catch (error) {
      // The local gate refused before any transport. Close the reservation
      // rather than carrying this known-zero continuation as an unknown cost.
      this.d.db.prepare('UPDATE provider_requests SET dispatch_started_at=NULL WHERE id=? AND sent_at IS NULL')
        .run(requestId);
      if (dispatchId) settleBackgroundDispatch(this.d.db, dispatchId, {
        actualCostMicroUsd: 0, outcomeCode: 'HEARTBEAT_BLOCKED_BEFORE_SEND', providerRequestId: requestId,
      });
      throw error;
    }
  }

  /** RE-08（2026-10-24）：本窗冻结目录是否含某工具——续读提示只在工具真实可用时给出
   *  （旧窗无 transcript_read=如实受限提示，不宣传不存在的读取能力）。无冻结目录=旧窗，保守 false。 */
  private windowHasTool(windowId: string | null | undefined, name: string): boolean {
    if (!windowId) return false;
    const set = storedToolset(this.d.db, windowId);
    if (!set) return false;
    const names = [...(Array.isArray(set.tools) ? set.tools : []), ...(Array.isArray((set as unknown as { catalog?: unknown }).catalog) ? (set as unknown as { catalog: unknown[] }).catalog : [])] as Array<{ function?: { name?: string } } | null | undefined>;
    return names.some((t) => t?.function?.name === name);
  }

  /** WAKE_KEEPWARM_V1：后台执行位重检的统一时钟（测试可虚拟推进）。 */
  private nowMs(): number { return this.d.now?.() ?? Date.now(); }

  /** 当前信封驱动配置（身份映射隔离：OR/DS 各自的型号、预算上限、粗估系数与 session 派生——互不混用；
   *  非信封驱动（SDK/mock）返回 null。 */
  private drv(): { kind: 'openrouter' | 'deepseek' | 'claude-agent-sdk' | 'mock'; model: string; maxTokens: number; reasoning: Record<string, unknown> | null; charsPerToken: number; sessionId: (roomId: string) => string } | null {
    const r = this.d.runnerSelection;
    if (r.status !== 'ok' || !isEnvelopeDriverKind(r.runner.kind)) return null;
    if (r.runner.kind === 'mock') {
      // R2：mock 并入信封管线——模型取 OR 声明值（与 wire 校验/视觉门同口径），session 仅测试断言用；
      // provider=mock 时 openrouter.model 可为空，回退到通过 buildOrPayload 型号校验的固定测试型号
      const or = this.d.config.openrouter;
      return { kind: 'mock', model: or.model ?? 'anthropic/claude-mock', maxTokens: or.max_output_tokens, reasoning: null, charsPerToken: or.estimate_chars_per_token, sessionId: roomId => `mock:${roomId}` };
    }
    if (r.runner.kind === 'claude-agent-sdk') {
      return { kind: 'claude-agent-sdk', model: (this.d.settings?.effectiveSdkModel(this.d.config.runtime.model) ?? this.d.config.runtime.model)!, maxTokens: this.d.config.openrouter.max_output_tokens,
        reasoning: { effort: this.d.settings?.reasoningEffort() ?? this.d.config.runtime.thinking.effort }, charsPerToken: this.d.config.openrouter.estimate_chars_per_token, sessionId: roomId => `sdk:${roomId}` };
    }
    if (r.runner.kind === 'deepseek') {
      const ds = this.d.config.deepseek;
      return { kind: 'deepseek', model: ds.model!, maxTokens: ds.max_output_tokens, reasoning: null, charsPerToken: ds.estimate_chars_per_token, sessionId: (roomId) => dsSessionId(roomId, ds.model!) };
    }
    const or = this.d.config.openrouter;
    // 2026-10-08：模型/推理等级经运行时 override（未设回落 config；模型变化
    // 经指纹触发受控换窗；effort 仅生成参数即时生效）
    const model = this.d.settings?.effectiveOrModel(or.model) ?? or.model;
    const reasoning = this.d.settings?.effectiveReasoning(or.reasoning) ?? or.reasoning;
    return { kind: 'openrouter', model: model!, maxTokens: or.max_output_tokens, reasoning, charsPerToken: or.estimate_chars_per_token, sessionId: (roomId) => orSessionId(roomId, model!, null) };
  }

  private async modelSupportsImages(model: string, kind: string | undefined): Promise<boolean> {
    const { base_url: baseUrl, vision_supported_models: declared } = this.d.config.openrouter;
    // The selectable Claude SDK catalog supports native image input via SDKUserMessage.
    if (kind === 'claude-agent-sdk' && SDK_MODEL_OPTIONS.some(option => option === model)) return true;
    if (declared.includes(model)) return true;
    const cached = visionSupportCached(model, baseUrl);
    if (cached !== null) return cached;
    return kind === 'openrouter' && await refreshVisionSupport(baseUrl, model) === true;
  }

  private buildPayloadFrom(envelope: OrRequestEnvelope, kind = this.drv()?.kind): Record<string, unknown> {
    if (kind === 'claude-agent-sdk') return { ...envelope };
    if (kind === 'deepseek') return buildDeepSeekPayload(envelope);
    const or = this.d.config.openrouter;
    return buildOrPayload({
      model: envelope.model, sessionId: envelope.sessionId, messages: envelope.messages, tools: envelope.tools,
      boundaries: envelope.boundaries, maxTokens: envelope.maxTokens, reasoning: envelope.reasoning,
      providerOnly: or.provider_only, allowFallbacks: or.allow_fallbacks, requireParameters: or.require_parameters,
    });
  }

  /** 审计 F27 + D11（审计 3655d60）：为 manifest=NULL 的旧轨迹行重建已见清单——按**宿主已知结构锚定**
   *  匹配，不用裸子串（旧实现 text.includes(row.content) 会把库内更早的子串正文 A 错配给轨迹里的 AA，
   *  给未发送原话签已见证明）：
   *  - user 轨迹消息=装配投影，正文以 `[user_input]\n` 头结束 → 锚定为 endsWith(`[user_input]\n{正文}`)；
   *  - assistant 轨迹消息=已发布分段原文 → 锚定为全文等值；
   *  按序消费候选防重复正文误配；任一条无匹配 → null（范围未知，如实阻断）。 */
  private rebuildTrajectoryManifest(conversationId: string, trajMessages: OrMessage[]): ManifestEntry[] | null {
    const dbRows = this.d.db.prepare(
      `SELECT m.id, m.sequence, m.current_revision, m.speaker, r.content FROM messages m
       JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       WHERE m.conversation_id = ? ORDER BY m.sequence`,
    ).all(conversationId) as Array<{ id: string; sequence: number; current_revision: number; speaker: string; content: string }>;
    const out: ManifestEntry[] = [];
    let cursor = 0;
    for (const tm of trajMessages) {
      if (tm.role !== 'user' && tm.role !== 'assistant') continue;
      const text = typeof tm.content === 'string' ? tm.content : Array.isArray(tm.content) ? tm.content.map((b) => (b as { text?: string }).text ?? '').join('') : '';
      const speaker = tm.role === 'user' ? 'owner' : 'assistant';
      let matched: { id: string; sequence: number; current_revision: number } | null = null;
      for (let i = cursor; i < dbRows.length; i++) {
        const row = dbRows[i]!;
        if (row.speaker !== speaker || row.content.length === 0) continue;
        // D11：锚定匹配（杜绝子串误配）——基底段=裸正文等值；回合追加段=装配投影，以 [user_input] 头收尾；
        // 序号前缀形态锚定：旧窗轨迹 [seq N]\n（2026-10-18 批）与新渲染
        // [N]\n（2026-10-19 瘦身裁定）并存——换窗前的存量轨迹按旧形态回放
        const anchored = text === row.content
          || text === `[${row.sequence}]\n${row.content}`
          || text === `[seq ${row.sequence}]\n${row.content}`
          || (speaker === 'owner' && text.endsWith(`[user_input]\n${row.content}`));
        if (anchored) {
          matched = row;
          cursor = i + 1;
          break;
        }
      }
      if (!matched) return null; // 无法无歧义重建：范围未知
      out.push({ id: matched.id, revision: matched.current_revision, seq: matched.sequence, origin: 'dialogue', visible: true });
    }
    return out;
  }

  // 当前输入之前的双方原话（§3.2.2：范围=本窗实际携带的真实对话；不扩大到全库）
  private dialogueUpTo(conversationId: string, maxSequence: number): Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; turnId: string | null }> {
    const rows = this.d.db.prepare(
      `SELECT id,sequence,speaker,current_revision,turn_id FROM messages
       WHERE conversation_id=? AND sequence<=?
         AND NOT (speaker='system' AND COALESCE(client_message_id,'') LIKE 'heartbeat:%')
       ORDER BY sequence DESC LIMIT 200`,
    ).all(conversationId, maxSequence) as Array<{ id: string; sequence: number; speaker: string; current_revision: number; turn_id: string | null }>;
    const out: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; turnId: string | null }> = [];
    for (const r of rows) {
      const msg = this.d.messages.getMessage(r.id);
      if (!msg) continue;
      out.push({ id: r.id, revision: r.current_revision, sequence: r.sequence, role: r.speaker === 'owner' ? 'user' : 'assistant', content: msg.revision.content, turnId: r.turn_id });
    }
    return out.reverse();
  }

  // 信封（§5.1/§5.5/§7.1，OR/DS 共用）：固定前缀=身份+当前 I+批准规则+宿主片段（审计 F02：I 完整装载）；
  // WP5（2026-10-08）：近期原话自动携带已退役——历史只经人工选集（selectedMessages）。
  // 身份映射隔离：型号/输出上限/粗估系数/session 派生按驱动取值（drv()）；DS 不发 session_id（runner 序列化丢弃）。
  /** Only complete preparations enter the cache. Published window trajectories
   *  remain immutable, including explicit gaps actually sent to the model.
   *  2026-10-17 重建版：原实现因一次误还原丢失，本版按现行测试合同重建
   *  （tests/unit/bootstrap-pages.test.ts / bootstrap-preparation.test.ts）。
   *  取数顺序：I → 事件 → 我们的话 → 心情（可选段让位剩余时间，预留 1700ms
   *  给终验）→ 同快照终验；SNAPSHOT_STALE/瞬时全局失败整包重建一次；
   *  Stop（父取消）返回 null 不告警；完整成功才进缓存。 */

  /** F-J-09：本窗冻结的工具快照（首发时定格，后续轮/评审/续请求复用） */
  /** 她 1024 裁定（接缝②）：容量按**实际发送载荷**计——消息轨迹 + 冻结工具目录（含 B 段
   *  tools/initial）同一份口径，rotateIfNeeded 预测与工具循环硬门共用本估测，不再各拼一套。 */
  private estimateRequestTokens(messages: unknown[], tools: OrRequestEnvelope['tools']): number {
    return Math.ceil(JSON.stringify({ messages, tools }).length / (this.drv()?.charsPerToken ?? 2.5));
  }

  private requestCapacity(messages: OrMessage[], tools: OrRequestEnvelope['tools'], maxOutput: number) {
    const windows = this.d.config.windows;
    if (windows.model_context_capacity === null) return null;
    const estimate = this.estimateRequestTokens(messages, tools);
    const plan = rotationPlan({
      currentInput: estimate, capacity: windows.model_context_capacity, maxOutput,
      toolReserve: windows.tool_input_reserve_tokens, reviewReserve: windows.review_reserve_tokens,
      safety: windows.safety_reserve_tokens, soft: windows.soft_limit_tokens,
    });
    return { estimate, plan };
  }

  private remainingToolResultBytes(messages: OrMessage[], tools: OrRequestEnvelope['tools'], maxOutput: number): number {
    const capacity = this.requestCapacity(messages, tools, maxOutput);
    if (!capacity) return Infinity;
    // The result consumes at most as many UTF-16 code units as UTF-8 bytes.
    // Leave room for the protocol envelope around the result.
    return Math.max(0, Math.floor((capacity.plan.safeInput - capacity.estimate) * (this.drv()?.charsPerToken ?? 2.5)) - 512);
  }

  private compactBlockedResults(messages: OrMessage[], sentCount: number, tools: OrRequestEnvelope['tools'], maxOutput: number): Set<string> {
    if (sentCount >= messages.length || this.requestCapacity(messages, tools, maxOutput)?.plan.action !== 'blocked_hard') return new Set();
    return compactUnsentToolResults(messages, sentCount);
  }

  /** Identify a retained response to the last dispatched request in this window.
   * A denied continuation can contain a full tool call and a short committed
   * receipt even after large unsent results have already been compacted. */
  private rejectedContinuationPrefix(windowId: string, messages: OrMessage[]): number | null {
    const last = this.d.db.prepare(`
      SELECT p.payload_json, p.purpose, p.sent_at, a.blocked_reason,
             wake.trajectory_committed_at AS wake_committed_at
      FROM provider_requests p LEFT JOIN attempts a ON a.id=p.attempt_id
      LEFT JOIN background_runs wake ON p.purpose='proactive_turn'
        AND wake.id=p.background_run_id AND wake.kind='autonomous'
        AND wake.window_id=p.window_id AND wake.turn_id=p.turn_id AND wake.retention='retained'
        AND wake.conversation_id=(SELECT conversation_id FROM windows WHERE id=p.window_id)
        AND a.window_id=p.window_id AND a.turn_id=p.turn_id AND a.state='failed'
      WHERE p.window_id=? AND (p.dispatch_started_at IS NOT NULL OR p.sent_at IS NOT NULL)
      ORDER BY p.rowid DESC LIMIT 1
    `).get(windowId) as {
      payload_json: string; purpose: string; sent_at: string | null; blocked_reason: string | null;
      wake_committed_at: string | null;
    } | undefined;
    if (!last?.sent_at) return null;
    const hardLimit = 'CAPACITY_BLOCKED_HARD_TOOL_ROUND';
    const chatBlocked = last.purpose === 'chat' && last.blocked_reason?.startsWith(`${hardLimit}:`);
    // Background finalization records the bare attempt error and commits the
    // trajectory before the scheduler publishes the run's final status.
    const wakeBlocked = last.wake_committed_at !== null && last.blocked_reason === hardLimit;
    if (!chatBlocked && !wakeBlocked) return null;
    const sent = (JSON.parse(last.payload_json) as { messages?: OrMessage[] }).messages;
    if (!sent?.length || sent.length >= messages.length
        || JSON.stringify(sent) !== JSON.stringify(messages.slice(0, sent.length))) return null;
    const tail = messages.slice(sent.length);
    const toolCalls = new Set(tail.flatMap(m => m.role === 'assistant' && Array.isArray(m.tool_calls)
      ? m.tool_calls.map((call: { id: string }) => call.id) : []));
    return tail.some(m => m.role === 'tool' && typeof m.tool_call_id === 'string' && toolCalls.has(m.tool_call_id)) ? sent.length : null;
  }

  private recoverOverbudgetTrajectory(trajectory: NonNullable<ReturnType<WindowTrajectoryService['forWindow']>>, sentCount: number): boolean {
    // Older hosts retained giant denied result bodies. Keep sent history and
    // original calls; only replace oversized results from the unsent tail.
    if (!trajectory.manifest || trajectory.pendingManifest.length) return false;
    const messages = trajectory.messages.slice();
    if (compactUnsentToolResults(messages, sentCount).size === 0) return false;
    this.d.trajectory!.replace(trajectory.windowId, messages, trajectory.lastBoundary, trajectory.manifest);
    trajectory.messages = messages;
    return true;
  }

  /** S17b 批次3：目录来源统一为同一 Registry——生产=显式 toolCatalog 依赖；
   *  直接构造的测试夹具经执行器上的同一注册表回退（BLOCKERS 登记过渡）。 */
  private toolCatalogSource(): import('../capabilities/registry.ts').CatalogProvider {
    return this.d.toolCatalog ?? this.d.tools?.getCapabilityRegistry() ?? (() => { throw new Error('TOOL_CATALOG_NOT_WIRED'); })();
  }

  private async prepareWindowTools(windowId: string, signal?: AbortSignal): Promise<void> {
    if (storedToolset(this.d.db,windowId)) return;
    await this.d.tools?.prepareWindowDefinitions(signal ?? AbortSignal.timeout(BOOTSTRAP_DEADLINE_MS));
    this.windowTools(windowId);
  }

  private windowTools(windowId: string): import('./or-payload.ts').OrTool[] {
    const existing = storedToolset(this.d.db, windowId);
    if (existing) return modelToolsAfterBindingRetirement(existing.tools);
    const source = this.toolCatalogSource();
    return modelToolsAfterBindingRetirement(freezeWindowTools(this.d.db, windowId, source.currentCatalog(),
      this.d.config.runtime.tool_schema_mode, source.currentGroups?.() ?? {}));
  }

  /** F-J-39：追赶投影——清单高水位之后、有真实发出证据（purpose=chat 且 sent_at 非空）的
   *  回合消息。失败回合的已发输入/已发布助手原话真实被模型看过，应计入评审范围与
   *  评审信封（不扫库假称已见；评审请求自身不算证据）。
   *  WAKE_KEEPWARM_V1（2026-10-22，B11 修复）：后台回合（自主唤醒/心跳）的真实发布
   *  同样构成追赶证据——此前只筛 purpose=chat 使自主发言可能出现在 UI 却缺在下一请求。 */
  private catchupEntries(conversationId: string, dialogue: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; turnId: string | null }>, trajMaxSeq: number, windowId: string): Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; turnId: string | null }> {
    // WP-07（CX-07）：追赶只取**当前 window/epoch** 内真实发出过的回合——
    // 此前按全库曾发送集合筛选，新窗（trajMaxSeq=-1）会把旧窗历史原文
    // 整体注回追赶投影，绕过人工选集（新窗历史唯一来源=选集）。
    // 跨窗历史一律走选集；追赶只服务"同窗内上一轨迹落盘后新发布的消息"。
    const sentChatTurnIds = new Set((this.d.db.prepare(
      "SELECT DISTINCT a.turn_id AS tid FROM attempts a JOIN provider_requests pr ON pr.attempt_id = a.id WHERE pr.purpose IN ('chat','proactive_turn','cache_keepalive') AND pr.dispatch_started_at IS NOT NULL AND pr.window_id = ?",
    ).all(windowId) as Array<{ tid: string | null }>).map((r) => r.tid).filter((t): t is string => t !== null));
    return dialogue.filter((m) => m.sequence > trajMaxSeq && m.turnId !== null && sentChatTurnIds.has(m.turnId));
  }

  private buildEnvelope(o: {
    conversationId: string;
    /** JOINT-VOICE：窗口感知听觉判定（旧窗冻结目录无 oido 工具时退回阻断） */
    windowId?: string;
    materials: { identityText: string; rulesText: string; iText: string | null; memoryAnchorsText?: string } | null;
    dialogue: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }>;
    tailUserText: string;
    bootText?: string | null;
    /** 宿主用户 2026-11-07 裁定：开窗定格的"运行中事项"独立片段（authority=none；
     *  随窗冻结，来自 WindowBootstrapMachine，不并入 B 段正文） */
    episodeFragment?: string | null;
    /** WP3（2026-10-08）：人工选集装配——严格按确认的引用集合装载（E04：
     *  不把"自动携带预算设 0"代替拆分——该预算键已随 WP5 退役）。给出即忽略
     *  dialogue 的自动预算挑选；可为空数组=明确空选（不带历史）。 */
    selectedMessages?: Array<{ message_id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; occurred_at?: string | null; reference_at?: string }>;
    /** EXEC_V1 §03.6：当前输入消息（投影其附件进尾部；缺省=纯文本尾） */
    tailMessage?: { id: string; revision: number } | null;
    /** 相册重构 P5：开窗携带块（选集图+相册携带合并规划的 system 数据块；随首请求冻结进轨迹） */
    carryFragment?: { blocks: Array<{ type: 'text'; text: string } | { type: 'asset_image'; asset_id: string; projection_version: 'v1' }> } | null;
  }): { envelope: OrRequestEnvelope; selected: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }>; hasImage: boolean; hasVoiceWithoutTranscript: boolean } {
    const dv = this.drv()!;
    // DBG-05/06（包2 2026-11-16）：A 段=身份正本+运行规则正本（文件版单一正本）+宿主边界。
    // I 不再复制进 A 段（唯一注入点=B 段 bootstrap，M I 版本体系）；代码内规则片段退役
    // （旧实现文件版与代码版双注入、且 I 占位与真实 I 冲突）。
    const splitOpening = o.materials?.memoryAnchorsText !== undefined;
    const runtimeRules = [o.materials?.rulesText, HOST_BOUNDARY_RULES].filter(Boolean).join('\n\n');
    const systemText = [o.materials?.identityText, splitOpening ? null : runtimeRules].filter(Boolean).join('\n\n');
    const messages: OrMessage[] = [
      { role: 'system', content: [{ type: 'text', text: systemText }] },
    ];
    // R11（复审 2026-10-07）：B（开窗资料）作为独立 system 数据块——显式
    // A/B 缓存分界（cache-plan 的 B 点分支要求 systemMessageCount>=2），
    // 不把外部资料并入 A 段升级成高优先级指令
    let localTools: string | null;
    let tools: OrRequestEnvelope['tools'];
    if (o.windowId) {
      tools = this.windowTools(o.windowId);
      localTools = storedToolset(this.d.db,o.windowId)?.initialText ?? null;
    } else {
      const source = this.toolCatalogSource(), catalog = source.currentCatalog();
      const groups = resolveToolGroups(this.d.db, catalog, source.currentGroups?.() ?? {});
      const mode = this.d.config.runtime.tool_schema_mode;
      tools = mode === 'direct' ? buildDirectTools(catalog, groups) : mode === 'deferred' ? buildDeferredTools() : catalog;
      localTools = mode === 'legacy' ? null : renderToolContext(catalog, groups, mode);
    }
    const bootstrapText = [o.bootText, splitOpening ? null : localTools].filter(Boolean).join('\n');
    if (bootstrapText) messages.push({role:'system',content:[{type:'text',text:bootstrapText}]});
    if (splitOpening) {
      const runtimeText = [runtimeRules, localTools].filter(Boolean).join('\n\n');
      messages.push({ role: 'system', content: [{ type: 'text', text: runtimeText }] });
    }
    if (o.episodeFragment) messages.push({role:'system',content:[{type:'text',text:o.episodeFragment}]});
    if (o.carryFragment) messages.push({ role: 'system', content: o.carryFragment.blocks } as unknown as { role: string; content: Array<{ type: 'text'; text: string }> });
    let selected: typeof o.dialogue = [];
    if (o.selectedMessages) {
      // WP3：人工选集——顺序=服务端 sequence（已由选集服务排好）；
      // 不要求相邻；按日期和序号间隙插入宿主引导语
      selected = o.selectedMessages.map((m) => ({ id: m.message_id, revision: m.revision, sequence: m.sequence, role: m.role, content: m.content }));
    } else {
      // WP5（2026-10-08 她裁定，D03）：自动 12k 携带整链退役——新窗历史唯一
      // 来源=人工选集；无选集的窗不带历史（空房首窗本来就无历史可带；
      // 已有历史的房间无活动窗/换窗均被 WP3 选集门拦截）。旧窗评审的
      // 范围/正文重建走 buildReviewReconstruction（单一正本不变）。
      selected = [];
    }
    // EXEC_V1 §03.6：历史与尾部统一走投影器（内部 asset_image 引用——轨迹/证据不含 Base64）
    // 相册重构 P5（宿主用户 2026-11-08 裁定：开窗包按最新裁定）：撤销 2026-10-18 textOnly——
    // 选集历史图片是真实图像输入（asset_image 块，发送边界物化+视觉门照常），并与开窗
    // 携带照片合并计入 CARRY_IMAGE_LIMIT（装配即校验，见下方 carryImageCount）。
    let envHasImage = false;
    const guides = selectionGuides(o.selectedMessages ?? []);
    let carryImageCount = o.carryFragment ? countCarryImageBlocks([{ content: o.carryFragment.blocks }]) : 0;
    // R2/RR2（复审 2026-11-09）：跨已选消息去块按 **M 对象身份**（content_sha256）——
    // 同字节经不同上传操作本来就是不同 E asset_id、同一张图（规划器 planCarryImages
    // 早已按 hash 合并；旧实现这里按 asset_id 去块，同字节别名仍双块）。
    // 收据缺席/无法定位的资产退回 asset 身份（不因缺哈希丢块）。
    const emittedImageKeys = new Set<string>();
    const imageKeyOf = (assetId: string): string => {
      const row = this.d.db.prepare('SELECT content_sha256 FROM media_assets WHERE id = ?').get(assetId) as { content_sha256: string } | undefined;
      return row?.content_sha256 ?? `est:${assetId}`;
    };
    // P1-a（审计 2026-11-15）：携带图先入去重键集——选集历史再出现同图（或同字节别名）
    // 时去块，不与携带双投（旧实现只对选集内部去重，携带图不在键集）。
    if (o.carryFragment) for (const b of o.carryFragment.blocks) {
      if ((b as { type: string }).type === 'asset_image') emittedImageKeys.add(imageKeyOf((b as { asset_id: string }).asset_id));
    }
    for (const m of selected) {
      const guide = guides.get(m.sequence);
      // 选集引导来自宿主。API 保留原位，SDK 按顺序装进系统提示。
      // guide 标记供旧 SDK 轨迹清理定位。
      if (guide) messages.push({ role: 'system', content: [{ type: 'text', text: guide }], guide: true } as unknown as { role: string; content: Array<{ type: 'text'; text: string }> });
      const proj = this.revisionBlocks(m.id, m.revision, m.content, { transcriptContinuationAvailable: this.windowHasTool(o.windowId, 'transcript_read') });
      envHasImage = envHasImage || proj.hasImage;
      const dedupedBlocks = proj.blocks.map((b) => {
        if (b.type !== 'asset_image') return b;
        const assetId = (b as { asset_id: string }).asset_id;
        const key = imageKeyOf(assetId);
        if (emittedImageKeys.has(key)) return null; // 后续重复原图（含同字节别名）：去块（正文/caption 文本保留）
        emittedImageKeys.add(key);
        return b;
      }).filter((b) => b !== null);
      carryImageCount += countCarryImageBlocks([{ content: dedupedBlocks }]);
      messages.push({ role: m.role, content: dedupedBlocks } as unknown as { role: string; content: Array<{ type: 'text'; text: string }> });
    }
    // 03 §8.5 装配级核验（规划器已拦一次，这里对实际装出的块再核一遍）：携带图+选集图
    // 合并后的实际图像块不得超过 CARRY_IMAGE_LIMIT；超限明确阻断，不截前 10、不静默丢图。
    if (carryImageCount > CARRY_IMAGE_LIMIT) {
      throw new Error(`CARRY_IMAGES_EXCEEDED:开窗携带图片 ${carryImageCount} 块超过上限 ${CARRY_IMAGE_LIMIT}——请减少选集中的图片或调低相册携带设置`);
    }
    // 相册重构 P4（03 §4/§5.1）：宿主一次性通知作为独立 system 数据块在尾部前追加——
    // 只追加新事件（不插历史中间、不改写旧前缀）；投递即标记（SDK 会话前缀保留已发
    // 内容，同会话重试不重复）。无通知=零块，前缀不受影响。
    // R4（复审 2026-11-08）：通知注入从窗口初始化信封移除——该信封可被 discardUnsent
    // 丢弃重建，而通知曾在取出时即标记 delivered（存档→滚窗→通知丢失的根因）。
    // 唯一注入点=普通轮尾部（orMessages 装配处），按实际投递证据收口。
    // 包4无seq整改：尾部当前输入不再查询/携带消息序号（旧 tailSeq 注入随裁定7 退役）
    const tailProj = this.revisionBlocks(o.tailMessage?.id ?? null, o.tailMessage?.revision ?? null, o.tailUserText, { isCurrentInput: true, hearingAvailable: voiceHearingPort(this.d.db, this.d.oidoHearing === true, o.windowId), transcriptContinuationAvailable: this.windowHasTool(o.windowId, 'transcript_read') });
    envHasImage = envHasImage || tailProj.hasImage;
    messages.push({ role: 'user', content: tailProj.blocks } as unknown as { role: string; content: Array<{ type: 'text'; text: string }> });
    return {
      hasImage: envHasImage,
      hasVoiceWithoutTranscript: tailProj.hasVoiceWithoutTranscript,
      envelope: {
        model: dv.model,
        sessionId: dv.sessionId(o.conversationId),
        messages,
        tools,
        boundaries: [], // 断点规划由调用方（cache-plan）负责；DS 直连自动缓存忽略断点
        maxTokens: dv.maxTokens,
        reasoning: dv.reasoning,
      },
      selected, // 审计 F06：manifest 必须从实际装载子集生成，不能按索引回映全量前缀
    };
  }

  // —— §4 换窗触发评估 + 换窗前一次提醒（同步执行于用户 turn 前；评审与凭证持久化）——
  private async rotateIfNeeded(o: {
    conversationId: string;
    window: import('../windows/manager.ts').WindowRow;
    gate: import('../identity/service.ts').GateResult;
    currentInputSequence: number;
    attemptId: string;
    turnId: string | null; // 自动换窗=当前 turn（评审请求可被 stop(turnId) 中断）；手动换窗=null（stopAll 兜底）
    materials: { identityText: string; rulesText: string; iText: string | null; memoryAnchorsText?: string } | null;
    cause?: RotationCause; // Persisted server intent; absent only during capacity evaluation.
    preserveWindow?: boolean; // Explicit retry may block on capacity but never rotates/rebuilds history.
  }): Promise<{ rotated: boolean; blocked: string | null }> {
    const d = this.d;
    const dv = this.drv();
    if (!dv && !o.cause) return { rotated: false, blocked: null };

    // F06：评审范围的实际已见清单优先取轨迹 manifest（真实发送证据）；无轨迹时退化为库投影。
    const dialogue = this.dialogueUpTo(o.conversationId, o.currentInputSequence - 1);
    // §11.1 估计：本地粗估 + 上次实际 usage 校准；精度如实标注。
    // 工作集估算（R4b 迁 runtime/rotation-estimate.ts：D06/F25/1024 裁定②/F-J-33/R21 口径单一正本）
    const trajForEstimate = d.trajectory?.forWindow(o.window.id) ?? null;
    const estimate = () => estimateRotationWorkingSet({ db: d.db, conversationId: o.conversationId, currentInputSequence: o.currentInputSequence, windowId: o.window.id, trajectoryRow: trajForEstimate, fallbackDialogue: dialogue, materials: o.materials, charsPerToken: dv?.charsPerToken ?? null, estimateTokensFor: (msgs) => this.estimateRequestTokens(msgs, this.windowTools(o.window.id)) });
    let { workingSet, nextWithIncoming } = estimate();

        // 2026-10-08 晚间她裁定：6h 静默触发已删除（睡觉≠换窗；换窗唯一自动基线=容量软线，2026-10-17 起 600k 兜底）
    const capacity = d.config.windows.model_context_capacity ?? Number.MAX_SAFE_INTEGER; // 未测量：容量触发按上限禁用（不画假百分比）。6h idle 触发已退役（2026-10-08）——唯一自动换窗基线=容量软线（600k 兜底）
    let plan: ReturnType<typeof rotationPlan> | null = null;
    let hardContinuationRecovery = false;
    if (dv && (!o.cause || o.cause === 'capacity')) {
      const planForEstimate = () => rotationPlan({
        currentInput: workingSet, // D06：旧窗自身（硬门判这个）
        nextInput: nextWithIncoming, // 新消息并入下一输入预测（触发先提醒再换窗，不直接堵死）
        capacity,
        maxOutput: dv.maxTokens,
        toolReserve: d.config.windows.tool_input_reserve_tokens,
        reviewReserve: d.config.windows.review_reserve_tokens,
        safety: d.config.windows.safety_reserve_tokens,
        soft: d.config.windows.soft_limit_tokens,
      });
      plan = planForEstimate();
      if (plan.action === 'blocked_hard' && trajForEstimate
          && this.requestCapacity(trajForEstimate.messages, this.windowTools(o.window.id), dv.maxTokens)?.plan.action === 'blocked_hard') {
        const sentCount = this.rejectedContinuationPrefix(o.window.id, trajForEstimate.messages);
        if (sentCount !== null) {
          if (this.recoverOverbudgetTrajectory(trajForEstimate, sentCount)) {
            ({ workingSet, nextWithIncoming } = estimate());
            plan = planForEstimate();
          }
          hardContinuationRecovery = Boolean(d.selections) && plan.action === 'blocked_hard';
        }
      }
    }
    if (!o.cause && plan) {
      // WP5（2026-10-08 §1.5 她裁定）：容量预警推送/展示退役——不再发布
      // 预警事件；软线计算（rotate 触发）与硬门（blocked_hard）照常保留。
      // bootstrap 不可用/缓存保护未覆盖等其他 context.warning 诊断不受影响。
      // 审计 F03：blocked_hard 是硬门——超安全输入上界不得继续发送；交调用方按待恢复收口，不静默放行
      if (plan.action === 'blocked_hard' && !hardContinuationRecovery) {
        const recovery = d.selections && !o.preserveWindow ? '；可在手动换窗确认选集后续接这条输入' : '';
        return { rotated: false, blocked: `CAPACITY_BLOCKED_HARD:当前输入估计 ${workingSet} 超过安全输入上界 ${plan.safeInput}（C-O-T-R-S），输入已保存待恢复${recovery}` };
      }
      if (plan.action !== 'rotate' && !hardContinuationRecovery) return { rotated: false, blocked: null };
      // A just-prepared target already includes the confirmed selection and
      // pending input budget. Its first input must not rotate the empty window
      // again on the same soft trigger; the per-request hard gate still applies.
      if (d.selections?.forTargetWindow(o.window.id) && !d.db.prepare('SELECT 1 FROM provider_requests WHERE window_id=? AND (dispatch_started_at IS NOT NULL OR sent_at IS NOT NULL) LIMIT 1').get(o.window.id)) {
        return { rotated: false, blocked: null };
      }
    }
    if (o.preserveWindow) return { rotated: false, blocked: 'RETRY_CONTEXT_CAPACITY:当前上下文需要换窗，本次重试未发送；请先处理上下文容量' };
    let reason: RotationCause = o.cause ?? 'capacity';
    if (o.gate.state !== 'READY') return { rotated: false, blocked: 'IDENTITY_BLOCKED' };
    if (!d.tools || !d.reviews || !d.checkpoint) return { rotated: false, blocked: 'ROTATION_SAFETY_UNAVAILABLE' };
    if (d.windows.activeWindow(o.conversationId)?.id !== o.window.id) return { rotated: false, blocked: 'ROTATION_SUPERSEDED' };
    if (d.routing.pendingForConversation(o.conversationId)) return { rotated: false, blocked: 'ROUTE_PENDING' };
    if ((d.db.prepare("SELECT COUNT(*) n FROM turns WHERE conversation_id=? AND state='running'").get(o.conversationId) as { n: number }).n) return { rotated: false, blocked: 'FENCE_ACTIVE' };

    // WP3（2026-10-08 她裁定，H07 全入口统一）：换窗历史携带只经人工选集。
    // 需要换窗而无"本窗源"的已确认方案 → 持久 awaiting + 阻断本 attempt
    //（blocked 即释放房间串行锁——H08：等她确认期间 confirm 可达，输入
    // 已保存；未提交≠空选，绝不自动携带/自动清空）。旧窗 hold 评审范围
    // 不受选集影响（selection/seen/hold_checkpoint 三清单分离，H10）。
    let selectionId: string | null = null;
    if (d.selections) {
      const confirmed = d.selections.confirmedFor(o.conversationId);
      if (confirmed && confirmed.source_window_id === o.window.id) {
        if (!confirmed.rotation_cause) return { rotated: false, blocked: 'ROTATION_CAUSE_UNKNOWN:请明确发起手动换窗以恢复旧选集' };
        reason = confirmed.rotation_cause;
        selectionId = confirmed.selection_id;
      } else {
        const awaiting = d.selections.ensureAwaiting({
          conversationId: o.conversationId,
          sourceWindowId: o.window.id,
          expectedWindowRevision: o.window.revision,
          cutoffSequence: o.currentInputSequence - 1,
          cause: reason,
        });
        return { rotated: false, blocked: `CONTEXT_SELECTION_REQUIRED:换窗前请确认新窗携带哪些历史原文（selection_id=${awaiting.selection_id}）；当前输入已保存，确认后自动继续` };
      }
    }

    // 审计 F05：评审互斥——同窗已有活跃评审（自动/手动）时不重复开评审，恢复走同 review_id 有界重试
    if (d.reviews.activeForWindow(o.window.id)) {
      return { rotated: false, blocked: 'REVIEW_IN_PROGRESS' };
    }
    // 审计 F08：评审前按原 operation_id 有界恢复 unknown 写；仍不可判定的如实阻断换窗
    await d.tools.recoverUnknownEffects(o.conversationId, o.window.id);
    const unresolvedBefore = d.reviews.unresolvedForWindow(o.window.id);
    if (unresolvedBefore.length > 0) {
      return { rotated: false, blocked: `WRITES_UNRESOLVED:${unresolvedBefore.length}（存在结果未知的写操作，换窗前须核实）` };
    }

    const fingerprintChanged = o.window.context_fingerprint && o.window.context_fingerprint !== contextFingerprint(d.config, o.gate.manifest);
    if (reason !== 'capacity' || fingerprintChanged || !dv) {
      d.events.publish('context.warning', { conversationId: o.conversationId, entityRef: o.window.id, scope: 'private', payload: { code: reason === 'manual' ? 'manual_review_bypassed' : 'identity_or_transport_review_unavailable', reason } });
      return this.doRotate(o, reason, null, selectionId);
    }

    const rotateWithoutOverbudgetReview = () => {
      d.events.publish('context.warning', { conversationId: o.conversationId, entityRef: o.window.id, scope: 'private',
        payload: { code: 'capacity_recovery_review_not_dispatched', reason, selection_id: selectionId } });
      return this.doRotate(o, reason, null, selectionId);
    };
    if (hardContinuationRecovery) return rotateWithoutOverbudgetReview();

    // 她裁定 2026-10-07 的总开关：关=换窗不发 hold 提醒（WP5 起该开关只
    // 管提醒——日结已整链退役）。记录 skipped 凭证如实定位（不伪造
    // reviewed/held 覆盖），直接换窗。
    if (d.config.reminders && !d.config.reminders.enabled) {
      d.reviews.markSkippedEmpty(o.window.id, o.conversationId, o.window.revision, [], {
        reason: 'reminders_disabled',
        note: '她裁定开关：关=不发评审提醒',
      });
      return await this.doRotate(o, reason, null, selectionId);
    }

    const trajRow = d.trajectory?.forWindow(o.window.id) ?? null;
    let trajManifest: ManifestEntry[] | null = trajRow?.manifest ?? null;
    // 审计 F27：v11 前旧轨迹行的 manifest 为 NULL（未知），不得当作空清单签 skipped_empty——
    // 按轨迹正文的 user/assistant 消息逐条匹配库内消息重建；任一匹配失败 → 范围未知，如实阻断。
    if (trajRow !== null && trajManifest === null) {
      trajManifest = this.rebuildTrajectoryManifest(o.conversationId, trajRow.messages);
      if (trajManifest !== null) {
        d.trajectory!.replaceManifest(o.window.id, trajManifest);
      } else {
        return { rotated: false, blocked: 'ROTATION_RANGE_UNKNOWN:旧窗口轨迹缺少已见清单且无法按正文重建——不签发空范围凭证，需明确恢复' };
      }
    }
    // F-J-10（联合审计 2026-10-06）：无轨迹时 manifest=实际装载子集（buildEnvelope
    // selected，12k 预算内完整回合组）——此前用最近 200 条库投影，范围可含模型看不见
    // 的消息，签出覆盖信封外内容的 review（违反 §3.2.2"不扩大到全库"）
    // 2026-10-08 她裁定：无轨迹窗不再按 12k 预算猜测范围（原 F-J-10 回退已删）——
    // 不知道它看过什么就明说不知道，与轨迹损坏同款处理，不签发范围凭证
    if (trajRow === null) {
      return { rotated: false, blocked: 'ROTATION_RANGE_UNKNOWN:窗口无已见记录（从未装配过信封）——不猜测评审范围；请先让本窗完成一轮，或明确放弃本次检查' };
    }
    // R12（复审 2026-10-07）：单一正本——范围、评审正文、seenMessages、
    // 书签高水位、凭证依据全部由同一份"实际评审输入清单"驱动。追赶投影
    // 此前只进范围与正文，已见集合仍取旧 manifest——catchup 原话进了评审
    // 正文却不在已见清单，引用核对必 QUOTE_MATCH_FAILED。
    const trajEarly = d.trajectory?.forWindow(o.window.id) ?? null;
    const trajMaxEarly = trajEarly?.manifest && trajEarly.manifest.length > 0 ? Math.max(...trajEarly.manifest.map((m) => m.seq)) : -1;
    const unifiedCatchup = trajEarly ? this.catchupEntries(o.conversationId, dialogue, trajMaxEarly, o.window.id) : [];
    const effectiveManifest: ManifestEntry[] = [
      ...(trajManifest ?? []),
      ...unifiedCatchup.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true })),
    ];

    // —— §3.2 评审范围：书签之后、扣除已完成同范围凭证的真实原话 ——
    // 人工携带的精确消息修订只作背景，不因携带而签发 reviewed/held 凭证。
    // 已完成/跳过的范围键按房间继承（新窗不重复检查旧窗已检查内容）。
    const checkpoint = d.checkpoint.forWindow(o.window.id);
    const carried = d.selections?.forTargetWindow(o.window.id)?.items ?? [];
    // The source selection is background, not a fake held/reviewed receipt.
    // Current selections are whole revisions; match both identity and revision.
    const carriedKeys = new Set(carried.map(m => rawKey({ id: m.message_id, revision: m.revision })));
    const carriedExempt = effectiveManifest.filter(m => carriedKeys.has(rawKey(m))).map(rawKey);
    let range;
    try {
      // F-J-39 + R12：范围=同一份 effectiveManifest（含追赶投影）——
      // 与评审信封、已见清单同源，范围 ⊆ 模型实际可见集合
      range = selectReviewRange({
        manifest: effectiveManifest,
        epochId: o.window.id,
        lastHold: checkpoint ? { epochId: checkpoint.epochId, seenSequence: checkpoint.seenSequence } : null,
        reviewedKeys: d.reviews.reviewedKeysForRoom(o.conversationId),
        carriedBackgroundKeys: carriedExempt,
      });
    } catch (err) {
      return { rotated: false, blocked: `ROTATION_RANGE_INVALID:${(err as { code?: string }).code ?? 'UNKNOWN'}` };
    }
    const rangeKeys = range.map(rawKey);
    if (d.reviews.completedForRange(o.conversationId, rangeKeys)) {
      return await this.doRotate(o, reason, null, selectionId); // 同范围有效凭证：直接换窗不再次收费检查（§4.3）
    }
    if (range.length === 0) {
      // F-J-40：空范围凭证携带定位依据（书签/清单高水位/触发原因/凭证计数）——
      // 空键集本身无法复核"为什么空"；不伪造 reviewed/held 全覆盖
      const manifestMax = effectiveManifest.reduce((mx, m) => Math.max(mx, m.seq), -1);
      d.reviews.markSkippedEmpty(o.window.id, o.conversationId, o.window.revision, rangeKeys, {
        reason,
        bookmark_seen_sequence: checkpoint ? checkpoint.seenSequence : null,
        manifest_high_water: manifestMax,
        manifest_entries: effectiveManifest.length,
        carried_exempt: carriedExempt.length,
      }); // §3.2.5：空范围不叫模型
      return await this.doRotate(o, reason, null, selectionId);
    }
    // —— §8.1 一次提醒（synthetic user 尾部；宿主隐藏普通输出；purpose=pre_rotate_review）——
    // 轨迹正本优先（模型看见的就是它看过的协议历史）；无轨迹时退化为 system+近期原话投影。
    const traj = trajEarly;
    // F-J-39 + R12：评审正文追赶投影=同一份 unifiedCatchup（与范围/已见清单
    // 同源——失败回合的已发输入/已发布原话有真实派发证据，属"截至本次已
    // 携带高水位"）
    const reviewCatchup = unifiedCatchup;
    const reviewCatchupMessages: OrMessage[] = reviewCatchup.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] }) as unknown as OrMessage);
    const reviewBaseMessages: OrMessage[] = traj ? [...traj.messages, ...reviewCatchupMessages] : []; // 无轨迹已在上方阻断——此分支不可达
    const baseTools = this.windowTools(o.window.id);
    const toolset = storedToolset(d.db, o.window.id)!;
    const scopedTaskTools = toolset.protocol === 'direct';
    const reviewId = genId('rev');
    const reviewDefinition = taskDefinitionContext(toolset, 'context_review_complete', reviewId);
    const reviewMessages: OrMessage[] = [...reviewBaseMessages, { role: 'user', content: [{ type: 'text', text: [buildPreRotateReviewMessage({ reviewId, reason, messageRefs: rangeKeys.join(', ') }),reviewDefinition].filter(Boolean).join('\n') }] }];
    const reviewTools = scopedTaskTools ? modelToolsAfterBindingRetirement(toolsetForTask(toolset, 'context_review_complete')) : baseTools;
    // A rolled-back wake can leave a fitting old prefix but an oversized review
    // once its already-published message is included. Honor the confirmed selection.
    if (selectionId && this.requestCapacity(reviewMessages, reviewTools, dv.maxTokens)?.plan.action === 'blocked_hard') {
      return rotateWithoutOverbudgetReview();
    }
    const failedReviews = (d.db.prepare("SELECT COUNT(*) n FROM rotation_reviews WHERE window_id = ? AND status = 'failed'").get(o.window.id) as { n: number }).n;
    if (failedReviews >= MAX_WINDOW_REVIEW_ATTEMPTS) {
      return { rotated: false, blocked: `ROTATION_REVIEW_RETRY_EXHAUSTED:本窗评审已失败 ${failedReviews} 次（上限 ${MAX_WINDOW_REVIEW_ATTEMPTS}），不再自动评审——请检查模型对提醒的响应或手动换窗；输入已保存待恢复` };
    }
    const review = d.reviews.create(o.window.id, o.conversationId, o.window.revision, range, reviewId);
    d.events.publish('review.sent', { conversationId: o.conversationId, entityRef: review.id, scope: 'private', payload: { window_id: o.window.id, reason, focus_count: range.length } });
    const { boundaries: reviewBoundaries, gDropped: reviewGDropped } = planBoundaries({ messages: reviewMessages, systemMessageCount: fixedSystemCount(reviewMessages), prevBoundary: traj?.lastBoundary ?? null });
    // F-J-32：G 保护点被丢弃时发脱敏观察事件（§7.2"保护未覆盖"可观测）
    if (reviewGDropped) {
      d.events.publish('context.warning', { conversationId: o.conversationId, entityRef: o.window.id, scope: 'private', payload: { source: 'cache', code: 'g_dropped' } });
    }
    const envelope: OrRequestEnvelope = {
      model: dv.model,
      sessionId: dv.sessionId(o.conversationId),
      messages: reviewMessages,
      tools: reviewTools,
      boundaries: reviewBoundaries,
      maxTokens: dv.maxTokens,
      reasoning: dv.reasoning,
    };
    const controller = new AbortController();
    // 审计 P2-2（§9.2 停止=abort 上游）：评审请求登记进活动代——自动换窗评审可被 stop(turnId) 中断；
    // 确认后恢复的容量评审登记在合成键下（无所属 turn），进程级 stopAll 兜底。
    const reviewRun: ActiveRun = { token: { cancelled: false }, controller, generation: 0 };
    const stopKey = o.turnId ?? `review:${o.window.id}`;
    this.active.set(stopKey, reviewRun);
    const reviewTurnId = (d.db.prepare('SELECT turn_id FROM attempts WHERE id = ?').get(o.attemptId) as { turn_id: string } | undefined)?.turn_id ?? o.attemptId;
    const quietEvent = (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: ModelRequestContext): void => {
      // 评审请求不发布正文/思考（§8.1）；只记账 usage 与终态（F12：真实 turn 归属 + 请求身份）
      if (ev.kind === 'usage') {
        d.usage.record({ turnId: reviewTurnId, attemptId: o.attemptId, requestId: reqCtx?.requestId ?? undefined, windowId: o.window.id, scope: ev.scope, usage: ev.usage, model: reqCtx?.responseModel ?? reqCtx?.requestedModel ?? dv.model, source: ev.source, completeness: ev.completeness }); // F31：评审费用按窗口归属（D10 修复：此前误传不存在的 o.windowId → 恒 NULL）
      }
    };
    const seenHighWater = effectiveManifest.length > 0 ? Math.max(...effectiveManifest.map((m) => m.seq)) : 0;
    let result: import('./runner.ts').RunnerRunResult;
    try {
      ({ result } = await this.runOrToolLoop({
        envelope, purpose: 'pre_rotate_review', activeReviewId: review.id,
        conversationId: o.conversationId, windowId: o.window.id,
        turnId: null, attemptId: o.attemptId, controller, onEvent: quietEvent, seenSequence: seenHighWater,
        scopedTaskTools,
        seenMessages: effectiveManifest.map((m) => (m.char_start !== undefined ? { id: m.id, revision: m.revision, char_start: m.char_start, char_end: m.char_end } : { id: m.id, revision: m.revision })), // D13+R12：评审视野=本窗实际已见清单（单一正本，含追赶投影；WP4 保片段范围）
      }));
    } finally {
      if (this.active.get(stopKey) === reviewRun) this.active.delete(stopKey);
    }
    const reviewRow = d.reviews.get(review.id);
    if (reviewRow?.status !== 'completed') {
      d.reviews.markFailed(review.id);
      d.events.publish('review.failed', { conversationId: o.conversationId, entityRef: review.id, scope: 'private', payload: { code: result.errorCode ?? 'MODEL_DID_NOT_COMPLETE' } });
      return { rotated: false, blocked: `ROTATION_REVIEW_FAILED:${result.errorCode ?? 'MODEL_DID_NOT_COMPLETE'}` };
    }
    return await this.doRotate(o, reason, review.id, selectionId);
  }

  private async doRotate(o: { conversationId: string; window: import('../windows/manager.ts').WindowRow; gate: import('../identity/service.ts').GateResult; currentInputSequence: number }, reason: RotationCause, reviewId: string | null, selectionId: string | null = null): Promise<{ rotated: boolean; blocked: string | null }> {
    // 审计 F05：评审期间可能已被并发换窗（手动/上一轮迟到返回）——只对评审针对的那个旧窗切换，
    // 活动指针已变则本轮评审作废（凭证留档），绝不叠加第二次轮转。
    const active = this.d.windows.activeWindow(o.conversationId);
    if (!active || active.id !== o.window.id) {
      return { rotated: false, blocked: 'ROTATION_SUPERSEDED:窗口已被并发切换，本次评审结果留档不重复换窗' };
    }
    // WP-07（CX-09）：初始轨迹材料在切换事务外先行准备——bootstrap
    // 获取是网络操作，不进 SQLite 写事务（正本要求不变）；准备失败=
    // 不换窗（旧窗保持 ACTIVE、选集不被消费、awaiting/confirmed 不动）
    let initialTrajectory: { messages: import('./or-payload.ts').OrMessage[]; manifest: import('../context/review-policy.ts').ManifestEntry[] } | null = null;
    try {
      initialTrajectory = await this.prepareInitialTrajectory(o.conversationId, o.gate, selectionId);
    } catch (err) {
      return { rotated: false, blocked: `ROTATE_PREPARE_FAILED:初始轨迹准备失败（${String((err as Error).message).slice(0, 80)}）——旧窗保持 ACTIVE` };
    }
    // WP3（E07）+WP-07（CX-09）：选集消费+窗口指针+初始轨迹同一事务
    //（selection consumed + target_window_id + ACTIVE 指针 + 初始轨迹
    // 要么全成要么全回滚）
    const latestGate = this.d.identity.evaluateGate(this.d.db, { driver: this.drv()?.kind ?? 'claude-agent-sdk' });
    if (latestGate.state !== 'READY' || contextFingerprint(this.d.config, latestGate.manifest) !== contextFingerprint(this.d.config, o.gate.manifest)) return { rotated: false, blocked: 'IDENTITY_CHANGED_DURING_PREPARE' };
    const rotated = this.d.windows.rotate({ conversationId: o.conversationId, expectedWindowId: o.window.id, gate: o.gate, maxSequence: o.currentInputSequence - 1, assembledOptions: null, selectionId: selectionId ?? undefined, initialTrajectory });
    if (!rotated.ok) return { rotated: false, blocked: `ROTATE_PREPARE_FAILED:${rotated.reason.slice(0, 80)}` };
    if (o.window.context_fingerprint !== rotated.window.context_fingerprint) this.d.db.prepare("UPDATE windows SET blocked_reason='ROTATED_CONTEXT_STALE' WHERE id=?").run(o.window.id);
    // pending 键上的 bootstrap 缓存迁移到真实窗 id（同窗不重复拉）
    this.bootstrapMachine.transferPending(`pending:${o.conversationId}`, rotated.window.id);
    this.d.events.publish('window.rotated', { conversationId: o.conversationId, entityRef: rotated.window.id, scope: 'private', payload: { reason, review_id: reviewId, selection_id: selectionId } });
    return { rotated: true, blocked: null };
  }

  /** 相册重构 P5：解析本窗开窗携带计划（选集图 ∪ 相册携带设置，去重 ≤ 上限）。
   *  P1-b（审计 2026-11-15）：content 已配置但 carry-set 读取失败（不可达/非 200/正文
   *  截断/形状不对）→ **准备明确失败**——旧实现 warn 后按空携带继续，滚窗会冻结空计划
   *  （本窗永久丢携带图）；失败保留旧窗/选集，可恢复重试。content 未配置=无携带能力，
   *  照常空携带。空清单（200+items=[]）合法滚窗。合并超限→抛错阻断本次换窗准备。 */
  private async resolveWindowCarry(conversationId: string, stashKey: string, selectedMessages: Array<{ message_id: string; attachments?: Array<{ asset_id: string; presentation: string }> }>): Promise<{ fragment: { blocks: Array<{ type: 'text'; text: string } | { type: 'asset_image'; asset_id: string; projection_version: 'v1' }> } | null; plan: ReturnType<typeof planCarryImages> }> {
    let carryItems: CarrySetItem[] = [];
    if (this.d.contentClient) {
      try {
        const res = await contentForward(this.d.contentClient, { method: 'GET', actor: 'jiaming', path: '/api/v1/content/carry-set' });
        if (res.status === 200 && !res.bodyFailed) {
          const body = res.body as { items?: CarrySetItem[] };
          if (Array.isArray(body.items)) carryItems = body.items;
          else throw new Error(`carry-set 响应形状不对（items 非数组）`);
        } else {
          throw new Error(`carry-set 读取失败（status=${res.status}${res.bodyFailed ? '，正文传输中断' : ''}）`);
        }
      } catch (err) {
        this.d.logger.warn('carry_set_unreadable', { conversationId, error: String((err as Error).message).slice(0, 120) });
        throw new Error(`CARRY_SET_UNREADABLE:${String((err as Error).message).slice(0, 120)}——携带清单读不到，本次准备不继续（旧窗/选集保留，可重试；不冻结空计划）`);
      }
    }
    // ALB-07：选集图带 M 对象身份（content_sha256）参与合并去重（同字节不同 asset 仍一张）
    const selectionImages = selectedMessages.flatMap((m) =>
      (m.attachments ?? []).filter((a) => a.presentation === 'image' || a.presentation === 'sticker').map((a) => {
        const row = this.d.db.prepare('SELECT content_sha256 FROM media_assets WHERE id = ?').get(a.asset_id) as { content_sha256: string } | undefined;
        return { asset_id: a.asset_id, message_id: m.message_id, content_sha256: row?.content_sha256 ?? `est:${a.asset_id}` };
      }));
    // R2（复审 2026-11-08）：相册携带项补 M 对象身份——生产装配此前只传 asset_id，
    // 规划器对选集图按 sha、相册图按 est:asset 计键，同图两张（反例：uniqueMedia=1
    // planned=2 blocks=2）。统一按 content_sha256 去重。
    const carryItemsWithHash = carryItems.map((c) => {
      const row = this.d.db.prepare('SELECT content_sha256 FROM media_assets WHERE id = ?').get(c.asset_id) as { content_sha256: string } | undefined;
      // 本地正本行优先；行缺席时保留 content 随携带集提供的身份（RR2，自查修正：
      // 旧写法无脑覆盖，本地查不到会把好数据抹成 null 退化回 est:asset 双键）
      return { ...c, content_sha256: row?.content_sha256 ?? c.content_sha256 ?? null };
    });
    // F1（复审 2026-11-09 二轮）：对账补身份——携带集仍缺 content_sha256 的存量行
    // （v7 前旧数据）按 E 资产正本经既有相册条目入口幂等回填；content 侧只补
    // content_sha256（不动 carry_mode/留言/updated_at）。失败仅告警不阻断滚窗，
    // 下次对账再补；201=对账间隙条目被删后重建（unexpected，可观测即可）。
    const backfillClient = this.d.contentClient;
    if (backfillClient) {
      for (let i = 0; i < carryItems.length; i++) {
        const c = carryItems[i]!;
        if (c.content_sha256) continue; // content 行已有身份
        const localHash = carryItemsWithHash[i]?.content_sha256 ?? null;
        if (!localHash) continue; // E 正本也不认识该资产：无从补，如实保持 asset 身份
        try {
          const res = await contentForward(backfillClient, {
            method: 'POST', actor: 'jiaming', path: `/api/v1/content/albums/${encodeURIComponent(c.kind)}/entries`,
            body: { asset_id: c.asset_id, content_sha256: localHash },
            headers: { 'idempotency-key': `carry-hash:${c.entry_id}` },
          });
          if (res.status === 201) this.d.logger.warn('carry_hash_backfill_recreated', { entryId: c.entry_id });
          else if (res.status !== 200) this.d.logger.warn('carry_hash_backfill_rejected', { entryId: c.entry_id, status: res.status });
        } catch {
          this.d.logger.warn('carry_hash_backfill_unreachable', { entryId: c.entry_id });
        }
      }
    }
    const plan = planCarryImages({ selectionImages, carryItems: carryItemsWithHash, speakerLabels: {
      qiaosheng: this.d.config.memory_surfacing.sol?.user_display_name ?? '宿主用户',
      jiaming: this.d.config.memory_surfacing.sol?.assistant_display_name ?? 'char',
    } });
    if (!plan.ok) throw new Error(`${plan.code}:${plan.detail}`);
    // ALB-08（审计 2026-11-08）：计划立即持久化（先落 pending 键行；窗口落地时迁到真实
    // window_id）——旧实现只存进程内 Map，滚窗成功后、首请求前重启即丢，next_once 复活。
    this.d.db.prepare('INSERT OR REPLACE INTO window_carry_plans(window_id, plan_json, has_next_once, created_at) VALUES (?,?,?,?)')
      .run(stashKey, JSON.stringify(plan), plan.ok && plan.hasNextOnce ? 1 : 0, new Date().toISOString());
    this.pendingCarryPlans.set(stashKey, { plan, conversationId, createdAt: new Date().toISOString() });
    return { fragment: buildCarryFragment(plan.ok ? plan.fragmentImages : [], plan.ok ? plan.images : []), plan };
  }

  /** 窗口落地后把暂存计划固化到真实 window_id（幂等；无暂存=无携带，不建行）。
   *  ALB-08：计划在准备期已落 pending 键行——这里把该行迁到真实 window_id（行迁移，
   *  不依赖进程内 Map 存活；Map 仅作同进程幂等缓存）。 */
  private persistCarryPlanForWindow(windowId: string): void {
    for (const [key, stash] of this.pendingCarryPlans) {
      if (!key.startsWith('pending:')) continue;
      if (stash.conversationId !== this.d.db.prepare('SELECT conversation_id FROM windows WHERE id = ?').get(windowId)?.conversation_id) continue;
      this.d.db.prepare('INSERT OR IGNORE INTO window_carry_plans(window_id, plan_json, has_next_once, created_at) VALUES (?,?,?,?)')
        .run(windowId, JSON.stringify(stash.plan), stash.plan.ok && stash.plan.hasNextOnce ? 1 : 0, stash.createdAt);
      // pending 键行使命结束：删除（非 UPDATE 迁移——新行已 INSERT，UPDATE 会撞 PK 唯一约束）
      this.d.db.prepare('DELETE FROM window_carry_plans WHERE window_id = ?').run(key);
      this.pendingCarryPlans.delete(key);
    }
  }

  /** P5 §7.4：窗内首次成功投递后消费 next_once（before=建窗时刻——不吞投递后新设项；
   *  content 失败保留未消费，下次成功补齐；同窗已消费即跳过）。 */
  private async consumeCarryNextOnceOnSuccess(windowId: string): Promise<void> {
    const row = this.d.db.prepare('SELECT has_next_once, consumed_at, created_at FROM window_carry_plans WHERE window_id = ?').get(windowId) as { has_next_once: number; consumed_at: string | null; created_at: string } | undefined;
    if (!row || !row.has_next_once || row.consumed_at || !this.d.contentClient) return;
    try {
      const res = await contentForward(this.d.contentClient, {
        method: 'POST', actor: 'jiaming', path: '/api/v1/content/carry-set/consume-next-once',
        body: { before: row.created_at }, headers: { 'idempotency-key': `carry-consume:${windowId}` },
      });
      // RR4-A：2xx 但正文截断=消费结果未知——不标记已消费（保留下次成功投递后补消费；
      // 同键 replay 幂等，content 侧已提交的话重放取回原回执）。
      if (res.status === 200 && res.bodyFailed) {
        this.d.logger.warn('carry_consume_body_unparseable', { windowId });
        return;
      }
      if (res.status === 200) {
        this.d.db.prepare('UPDATE window_carry_plans SET consumed_at = ? WHERE window_id = ? AND consumed_at IS NULL').run(new Date().toISOString(), windowId);
      } else {
        this.d.logger.warn('carry_consume_rejected', { windowId, status: res.status });
      }
    } catch {
      this.d.logger.warn('carry_consume_unreachable', { windowId }); // 保留未消费，后续成功回合补齐
    }
  }

  /** WP-07（CX-09）：新窗初始轨迹材料（事务外先行）——按已确认选集
   *  装配首信封（空选=无历史段）+开窗资料 B；bootstrap 以 pending 键
   *  缓存，切换成功后由调用方迁移到真实窗 id。 */
  private async prepareInitialTrajectory(conversationId: string, gate: import('../identity/service.ts').GateResult, selectionId: string | null): Promise<{ messages: import('./or-payload.ts').OrMessage[]; manifest: import('../context/review-policy.ts').ManifestEntry[] } | null> {
    const d = this.d;
    const dv = this.drv();
    if (!dv) {
      const sdkSelection = selectionId ? d.selections?.get(selectionId) : null;
      if (sdkSelection?.items?.length) throw new Error('SDK_SELECTION_TRANSPORT_UNAVAILABLE');
      return null;
    }
    if (!d.trajectory) throw new Error('ROTATION_TRAJECTORY_UNAVAILABLE');
    const materials = gate.state === 'READY' && gate.manifest ? d.identity.loadVerifiedMaterials(gate.manifest) : null;
    const boot = await this.bootstrapMachine.windowBootstrap(`pending:${conversationId}`, undefined, conversationId, materials?.memoryAnchorsText);
    const sel = selectionId && d.selections ? d.selections.get(selectionId) : null;
    const loadedSelection = d.selections && sel ? d.selections.loadForProjection(sel) : [];
    const carry = await this.resolveWindowCarry(conversationId, `pending:${conversationId}`, loadedSelection);
    const built = this.buildEnvelope({
      conversationId,
      materials,
      bootText: boot,
      episodeFragment: this.bootstrapMachine.episodeFragmentFor(`pending:${conversationId}`),
      dialogue: [],
      tailUserText: ' ',
      selectedMessages: loadedSelection,
      carryFragment: carry.fragment,
    });
    const inputChars = JSON.stringify(built.envelope.messages).length + this.selectionPendingInputChars(conversationId);
    const hardBound = (d.config.windows.model_context_capacity ?? Number.MAX_SAFE_INTEGER) - dv.maxTokens - d.config.windows.tool_input_reserve_tokens - d.config.windows.review_reserve_tokens - d.config.windows.safety_reserve_tokens;
    if (Math.ceil(inputChars / dv.charsPerToken) > hardBound) throw new Error('CAPACITY_BLOCKED_HARD:CONTEXT_SELECTION_TOO_LARGE');
    const manifest = built.selected.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
    return { messages: built.envelope.messages.slice(0, -1), manifest };
  }

  // —— WP3（MANUAL_HANDOFF_JUDGE_SWITCH_V1）：人工选集的宿主面 ——

  /** 选集容量估计上下文（§6.2：选集+A/B 系统段+待回答输入一起算；
   *  未知 tokenizer 标 rough；界=有效软线 min(soft, C-O-T-R-S)——装得下
   *  还要过请求级容量终检，这里只做选集级预检）。 */
  private selectionEstimateContext(tailInputChars: number): { charsPerToken: number; systemChars: number; tailInputChars: number; capacityBoundTokens: number } | null {
    const d = this.d;
    const dv = this.drv();
    if (!dv) return selectionEstimateContext({ driver: null, systemChars: 0, windows: d.config.windows, tailInputChars }); // SDK 驱动粗估回退（§6.2）
    const gate = d.identity.evaluateGate(d.db, { driver: dv.kind });
    const materials = gate.state === 'READY' && gate.manifest ? d.identity.loadVerifiedMaterials(gate.manifest) : null;
    return selectionEstimateContext({ driver: { charsPerToken: dv.charsPerToken, maxTokens: dv.maxTokens }, systemChars: systemFragmentChars(materials), windows: d.config.windows, tailInputChars });
  }

  /** 选择面截止水位：最后一条"已了结"消息（其 turn 非 pending/blocked）——
   *  待回答与排队输入不得作为历史带入（H04）。 */
  private selectionCutoffSequence(conversationId: string): number {
    return selectionCutoffSequence(this.d.db, conversationId); // R4b 迁 context/selection-estimate.ts（H04）
  }

  /** 待回答/排队输入的总字符（容量估计并入"当前待回答输入"，H04/H05）。 */
  private selectionPendingInputChars(conversationId: string): number {
    return selectionPendingInputChars(this.d.db, conversationId); // R4b 迁 context/selection-estimate.ts（H04/H05）
  }

  /** preview（§6.2）：只读核验——不跑模型、不 hold、不换窗、不写选集。 */
  selectionPreview(conversationId: string, windowId: string, items: Array<{ message_id: string; revision?: number; content_hash?: string }>): { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string } & Record<string, unknown> } {
    const d = this.d;
    if (!d.selections) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNAVAILABLE', detail: '选集服务未接线' } };
    const win = d.windows.get(windowId);
    // WP-03（2026-10-09，JFA-009/B02）：哨兵源（csel-src-*）同 confirm 语义
    // ——存量历史+无 ACTIVE 窗时 preview 也可核验（expectedWindowRevision=0）
    const isSentinel = windowId.startsWith('csel-src-');
    if ((!win && !isSentinel) || (win && win.conversation_id !== conversationId)) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNKNOWN_WINDOW', detail: '窗口不存在或不属于该房间' } };
    const est = this.selectionEstimateContext(this.selectionPendingInputChars(conversationId));
    if (!est) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNAVAILABLE', detail: '无可用信封驱动（聊天模型未配置）' } };
    const cutoff = this.selectionCutoffSequence(conversationId);
    return d.selections.preview({ conversationId, sourceWindowId: windowId, expectedWindowRevision: win ? win.revision : 0, items, cutoffSequence: cutoff, estimate: est, capacityBoundTokens: est.capacityBoundTokens });
  }

  /** confirm（§6.2/§6.3）：幂等确认；有被选集阻断的待回答输入时确认后
   *  自动换窗+原 input_message_id 恢复（只发一次，不重复 submit）。 */
  async selectionConfirm(o: {
    conversationId: string;
    windowId: string;
    items: Array<{ message_id: string; revision?: number; content_hash?: string }>;
    explicitEmpty: boolean;
    idempotencyKey: string | null;
    expectedWindowRevision?: number;
  }): Promise<{ ok: true; selection_id: string; rotated: boolean; windowId: string | null; resumed: number } | { ok: false; error: { code: string } & Record<string, unknown> }> {
    const d = this.d;
    if (!d.selections) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNAVAILABLE', detail: '选集服务未接线' } };
    const win = d.windows.get(o.windowId);
    const isSentinel = o.windowId.startsWith('csel-src-');
    if (!win && !isSentinel) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNKNOWN_WINDOW', detail: '窗口不存在或不属于该房间' } };
    if (win && win.conversation_id !== o.conversationId) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNKNOWN_WINDOW', detail: '窗口不属于该房间' } };
    const est = this.selectionEstimateContext(this.selectionPendingInputChars(o.conversationId));
    if (!est) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNAVAILABLE', detail: '无可用信封驱动（聊天模型未配置）' } };
    const cutoff = this.selectionCutoffSequence(o.conversationId);
    const confirmed = d.selections.confirm({
      conversationId: o.conversationId,
      sourceWindowId: o.windowId,
      // 显式携带的 expected_window_revision 优先（§6.2 preview→confirm
      // 期间窗口被并发轮转的 CAS；未携带按当前窗口修订）
      expectedWindowRevision: o.expectedWindowRevision ?? (win ? win.revision : 0),
      items: o.items,
      explicitEmpty: o.explicitEmpty,
      idempotencyKey: o.idempotencyKey,
      cutoffSequence: cutoff,
      estimate: est,
      capacityBoundTokens: est.capacityBoundTokens,
    });
    if (!confirmed.ok) return { ok: false, error: confirmed.error as { code: string } & Record<string, unknown> };
    if (confirmed.selection.status === 'consumed') {
      const recovered = d.windows.activeWindow(o.conversationId)?.id === confirmed.selection.target_window_id
        ? await this.resumeAfterSelectionConfirm(o.conversationId) : null;
      return { ok: true, selection_id: confirmed.selection.selection_id, rotated: true, windowId: confirmed.selection.target_window_id, resumed: recovered?.ok ? recovered.resumed : 0 };
    }
    // 有被选集阻断的待回答输入 → 确认即恢复（换窗/建窗 + 原输入重派一次）
    const blockedRows = d.db.prepare(
      "SELECT COUNT(*) n FROM turns t JOIN attempts a ON a.turn_id = t.id AND a.state='blocked' AND (a.blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' OR a.blocked_reason LIKE 'CONTEXT_ROTATION_REQUIRED%') WHERE t.conversation_id = ? AND t.state='blocked'",
    ).get(o.conversationId) as { n: number };
    if (blockedRows.n === 0 && !confirmed.selection.rotation_cause) {
      return { ok: true, selection_id: confirmed.selection.selection_id, rotated: false, windowId: null, resumed: 0 };
    }
    const resumed = await this.resumeAfterSelectionConfirm(o.conversationId);
    return resumed.ok
      ? { ok: true, selection_id: confirmed.selection.selection_id, rotated: true, windowId: resumed.windowId, resumed: resumed.resumed }
      : { ok: false, error: { code: 'CONTEXT_SELECTION_RESUME_FAILED', detail: resumed.reason.slice(0, 200), selection_id: confirmed.selection.selection_id, resumed: resumed.resumed } };
  }

  /** 确认后的恢复（§6.3）：同一串行队列 → 换窗（或无活动窗时建窗）→
   *  以原 input_message_id 重派被阻断输入（不 submitUserMessage，不重复
   *  归档）。旧窗 hold 提醒/unknown 恢复在换窗管线内照常执行。 */
  async resumeAfterSelectionConfirm(conversationId: string): Promise<{ ok: true; windowId: string; resumed: number } | { ok: false; reason: string; resumed: number }> {
    return this.runSerialized(conversationId, async () => {
      const d = this.d;
      let rot: { ok: true; windowId: string } | { ok: false; reason: string } | null = null;
      if (d.windows.activeWindow(conversationId)) {
        const confirmed = d.selections?.confirmedFor(conversationId);
        if (!confirmed) {
          const active = d.windows.activeWindow(conversationId)!;
          if (!d.selections?.forTargetWindow(active.id)) return { ok: false as const, reason: 'CONTEXT_SELECTION_UNCONFIRMED', resumed: 0 };
          // Commit may have survived a crash before requeue. Consumed selection
          // plus active target is the durable success evidence for resuming.
          rot = { ok: true, windowId: active.id };
        } else {
          if (!confirmed.rotation_cause) return { ok: false as const, reason: 'ROTATION_CAUSE_UNKNOWN', resumed: 0 };
          if (confirmed.source_window_id !== d.windows.activeWindow(conversationId)!.id) return { ok: false as const, reason: 'ROTATION_SOURCE_CHANGED', resumed: 0 };
          rot = await this.rotateConfirmed(conversationId, confirmed.rotation_cause);
        }
      } else {
        // 无活动窗（H13 分支的恢复）：按已确认选集直接建窗
        // WP-07（CX-09）：初始轨迹材料事务外先行准备，随 createWindow
        // 的激活事务原子写入（失败=旧状态不动，选集不被消费）
        const dv = this.drv();
        const gate = d.identity.evaluateGate(d.db, { driver: dv ? dv.kind : 'claude-agent-sdk' });
        const confirmed = d.selections?.confirmedFor(conversationId) ?? null;
        const selId = confirmed && confirmed.status === 'confirmed' ? confirmed.selection_id : undefined;
        if (!confirmed || !confirmed.rotation_cause) return { ok: false as const, reason: 'ROTATION_CAUSE_UNKNOWN', resumed: 0 };
        if (gate.state !== 'READY') return { ok: false as const, reason: 'IDENTITY_BLOCKED', resumed: 0 };
        if (!d.tools || !d.reviews) return { ok: false as const, reason: 'ROTATION_SAFETY_UNAVAILABLE', resumed: 0 };
        const sources = d.db.prepare('SELECT id FROM windows WHERE conversation_id=?').all(conversationId) as Array<{ id: string }>;
        for (const source of sources) {
          if (d.reviews.activeForWindow(source.id)) return { ok: false as const, reason: 'REVIEW_IN_PROGRESS', resumed: 0 };
          await d.tools.recoverUnknownEffects(conversationId, source.id);
          if (d.reviews.unresolvedForWindow(source.id).length) return { ok: false as const, reason: 'WRITES_UNRESOLVED', resumed: 0 };
        }

        // WP-07（CX-09）：初始轨迹材料事务外先行准备，随 createWindow 的
        // 激活事务原子写入；准备失败=不动旧状态、不消费选集（与 rotate
        // 同口径——失败如实返回，不吞异常降级）
        let prepared: { messages: import('./or-payload.ts').OrMessage[]; manifest: import('../context/review-policy.ts').ManifestEntry[] } | null;
        try {
          prepared = await this.prepareInitialTrajectory(conversationId, gate, selId ?? null);
        } catch (err) {
          rot = { ok: false, reason: `初始轨迹准备失败（${String((err as Error).message).slice(0, 120)}）——状态未动，可重试恢复` };
          prepared = null;
        }
        if (rot === null) {
          try {
            const latestGate = d.identity.evaluateGate(d.db, { driver: dv?.kind ?? 'claude-agent-sdk' });
            if (latestGate.state !== 'READY' || contextFingerprint(d.config, latestGate.manifest) !== contextFingerprint(d.config, gate.manifest)) throw new Error('IDENTITY_CHANGED_DURING_PREPARE');
            const created = d.windows.createWindow({ conversationId, gate, assembledOptions: null, selectionId: selId, initialTrajectory: prepared });
            rot = created.window.status === 'ACTIVE' ? { ok: true, windowId: created.window.id } : { ok: false, reason: created.blockedReason ?? '建窗失败' };
            // RRA-015（2026-10-09 复审）：无活动窗恢复分支同样迁移 pending
            // bootstrap 缓存到真实窗 id 并清 pending——此前只 doRotate 迁移，
            // 连续模型恢复的第二/三窗复用第一次的旧 B（违反新窗必拉最新）
            if (created.window.status === 'ACTIVE') {
              this.bootstrapMachine.transferPending(`pending:${conversationId}`, created.window.id);
            }
          } catch { rot = { ok: false, reason: 'ROTATE_COMMIT_FAILED' }; }
        }
      }
      if (!rot || !rot.ok) return { ok: false as const, reason: rot?.reason ?? 'ROTATION_NOT_COMMITTED', resumed: 0 };
      return { ok: true as const, windowId: rot.windowId, resumed: this.resumeSelectionInputs(conversationId) };
    });
  }

  private resumeSelectionInputs(conversationId: string): number {
    const db = this.d.db;
    const rows = db.prepare(
      "SELECT DISTINCT t.id FROM turns t JOIN attempts a ON a.turn_id = t.id AND a.state='blocked' AND (a.blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' OR a.blocked_reason LIKE 'CONTEXT_ROTATION_REQUIRED%') WHERE t.conversation_id = ? AND t.state='blocked'",
    ).all(conversationId) as Array<{ id: string }>;
    for (const r of rows) {
      tx(db, () => {
        db.prepare("UPDATE attempts SET state='pending', blocked_reason=NULL WHERE turn_id=? AND state='blocked' AND (blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' OR blocked_reason LIKE 'CONTEXT_ROTATION_REQUIRED%')").run(r.id);
        db.prepare("UPDATE turns SET state='pending', completed_at=NULL WHERE id=? AND state='blocked'").run(r.id);
      });
      this.enqueue(r.id); // 链尾排队（当前串行任务结束后执行）
    }
    return rows.length;
  }

  async manualRotate(conversationId: string, expectedWindowId?: string): Promise<{ ok: true; windowId: string } | { ok: false; reason: string }> {
    // 审计 F05：手动换窗占用房间串行链——与 turn/自动评审/另一个手动调用互斥，
    // 评审等待期间新 chat 排队而非并发发送
    return this.runSerialized(conversationId, async () => {
      if (expectedWindowId && this.d.windows.activeWindow(conversationId)?.id !== expectedWindowId) {
        return { ok: false as const, reason: 'WINDOW_STALE:目标窗口已不再活动' };
      }
      const result = await this.rotateConfirmed(conversationId, 'manual', true);
      if (result.ok && this.d.selections?.forTargetWindow(result.windowId)) this.resumeSelectionInputs(conversationId);
      return result;
    });
  }

  private async rotateConfirmed(conversationId: string, cause: RotationCause, explicitManual = false): Promise<{ ok: true; windowId: string } | { ok: false; reason: string }> {
    const d = this.d;
    const dv = this.drv();
    const gate = d.identity.evaluateGate(d.db, { driver: dv ? dv.kind : 'claude-agent-sdk' });
    const window = d.windows.activeWindow(conversationId);
    if (!window) return { ok: false, reason: 'NO_ACTIVE_WINDOW' };
    if (gate.state !== 'READY') return { ok: false, reason: 'IDENTITY_BLOCKED' };
    const cutoff = this.selectionCutoffSequence(conversationId);
    if (explicitManual && d.selections) {
      const prior = d.selections.activeForWindow(conversationId, window.id);
      const selection = prior ?? d.selections.ensureAwaiting({ conversationId, sourceWindowId: window.id, expectedWindowRevision: window.revision, cutoffSequence: cutoff, cause: 'manual' });
      d.selections.recordCause(selection.selection_id, 'manual');
      // Explicit manual rotation can recover the latest unchanged, never-sent
      // chat input from a legacy hard block without treating an old wake as committed.
      d.db.prepare(`
        UPDATE attempts SET blocked_reason=?
        WHERE id=(
          SELECT a.id FROM turns t JOIN messages m ON m.id=t.input_message_id
          JOIN attempts a ON a.id=(SELECT id FROM attempts WHERE turn_id=t.id ORDER BY attempt_no DESC LIMIT 1)
          WHERE t.conversation_id=? AND t.trigger='user_message' AND t.state='blocked'
            AND m.conversation_id=t.conversation_id AND m.speaker='owner'
            AND m.sequence=(SELECT MAX(sequence) FROM messages WHERE conversation_id=t.conversation_id AND speaker='owner')
            AND a.state='blocked' AND a.blocked_reason LIKE 'CAPACITY_BLOCKED_HARD:%'
            AND a.input_revision=m.current_revision AND a.retry_window_id IS NULL
            AND (a.window_id IS NULL OR a.window_id=?)
            AND NOT EXISTS(SELECT 1 FROM provider_requests p WHERE p.turn_id=t.id AND (p.dispatch_started_at IS NOT NULL OR p.sent_at IS NOT NULL))
            AND NOT EXISTS(SELECT 1 FROM voice_stream_turns v WHERE v.est_turn_id=t.id)
        )
      `).run(`CONTEXT_SELECTION_REQUIRED:容量阻断的原输入等待手动换窗确认（selection_id=${selection.selection_id}）`, conversationId, window.id);
      d.events.publish('context.warning', { conversationId, entityRef: selection.selection_id, scope: 'private', payload: { code: 'manual_rotation_requested', previous_cause: prior?.rotation_cause ?? null, source_window_id: window.id } });
    }
    const materials = gate.manifest ? d.identity.loadVerifiedMaterials(gate.manifest) : null;
    const r = await this.rotateIfNeeded({ conversationId, window, gate, currentInputSequence: cutoff + 1,
      attemptId: 'rotation-resume', turnId: null,
      materials,
      cause,
    });
    if (!r.rotated) return { ok: false, reason: r.blocked ?? 'ROTATION_NOT_COMMITTED' };
    const active = d.windows.activeWindow(conversationId);
    return active ? { ok: true, windowId: active.id } : { ok: false, reason: 'NO_ACTIVE_WINDOW' };
  }

  private async runTurn(turnId: string): Promise<void> {
    const d = this.d;
    const turn = d.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as
      | { id: string; conversation_id: string; state: string; input_message_id: string | null; generation: number }
      | undefined;
    if (!turn) return;
    const attempt = d.db.prepare("SELECT * FROM attempts WHERE turn_id = ? AND state = 'pending' ORDER BY attempt_no DESC LIMIT 1").get(turnId) as
      | { id: string; attempt_no: number; input_revision: number | null; fresh_session?: number; retry_window_id?: string | null }
      | undefined;
    if (!attempt) return;

    // —— 会话级路由 gate（AUD-05/36/37 拆分）：挡住的是 waiting_route_gate，不是票据 owner ——
    const roomPending = d.routing.pendingForConversation(turn.conversation_id);
    if (roomPending && roomPending.attempt_id !== attempt.id) {
      // 普通排队输入：可持久化，但绝不启动模型执行；决议事务会批量释放回 pending
      tx(d.db, () => {
        d.db.prepare("UPDATE attempts SET state = 'waiting_route_gate', blocked_reason = ? WHERE id = ? AND state = 'pending'")
          .run(`WAITING_ROUTE_GATE:${roomPending.id}`, attempt.id);
      });
      d.events.publish('turn.status', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id, payload: { state: 'waiting_route_gate', reason: 'ROUTE_ROOM_PENDING' } });
      return;
    }

    // —— 每轮实际执行前刷新 Time Context（按当前输入 sequence 取前驱，AUD-21） ——
    const inputMessage = turn.input_message_id ? d.messages.getMessage(turn.input_message_id) : null;
    const timeCtx = buildTimeContext(d.db, {
      conversationId: turn.conversation_id,
      config: d.config,
      eventOccurredAt: inputMessage?.revision.occurred_at ?? null,
      currentInputSequence: inputMessage?.sequence ?? null,
    });
    d.db.prepare('UPDATE turns SET time_context_json = ?, started_at = COALESCE(started_at, ?) WHERE id = ?').run(JSON.stringify(timeCtx), new Date().toISOString(), turnId);

    // —— 运行时 gate ——
    // §2.1/§6.3：驱动判别（先行——gate 的驱动专属前提据此区分，审计 F01）；OR/DS 均为信封驱动，
    // 身份映射按驱动隔离（dv()），SDK 专属前提只约束 SDK 驱动。
    const dv = this.drv();
    const gate = d.identity.evaluateGate(d.db, { driver: dv ? dv.kind : 'claude-agent-sdk' });
    // F04：校验与装配用同一份已验证材料（含批准规则正文；I 留在开窗包通道，未批准策略不装载）
    const materials = gate.state === 'READY' && gate.manifest ? d.identity.loadVerifiedMaterials(gate.manifest) : null;
    if (d.runnerSelection.status === 'blocked') {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, `RUNTIME_NOT_READY:${d.runnerSelection.reasons.map(codeOf).join(';')}`, 'blocked');
      return;
    }
    if (dv !== null && (!materials?.identityText || !materials?.rulesText)) {
      // §2.1：信封驱动（OR/DS）首条生成前必须有批准身份/规则材料——与 SDK 同一 gate，不提供默认人格
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'IDENTITY_NOT_READY:ENVELOPE_DRIVER_MISSING_APPROVED_MATERIALS', 'blocked');
      return;
    }

    // —— 窗口与 session（AUD-03）——
    let window = d.windows.activeWindow(turn.conversation_id);
    if (attempt.retry_window_id && (!window || window.id !== attempt.retry_window_id)) {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'RETRY_CONTEXT_CHANGED:原对话窗口已变化，本次重试未发送', 'blocked');
      return;
    }
    if (!window) {
      // WP3（H13，她裁定 2026-10-08）：已有历史但无活动窗**不擅自空选**——
      // 锚定 awaiting 等人工确认；只有真正全新的空房间才自动建首窗
      //（first_window_empty：无历史可带，自动空初始化合法）。恢复锚=最近
      // 一个窗口行（任意状态）；无窗口行的存量历史用哨兵源。
      // WP-04（JFA-B06）：判据去 dv——SDK 驱动有历史无活动窗同样锚定
      // awaiting（§5.5.7 全入口统一，不再只对信封驱动生效）
      if (d.selections) {
        // H13 判据=**已了结**历史（其 turn 非 pending/blocked）——本输入
        // 自身还在 pending，不能把自己算成"已有历史"（首条消息即建窗）
        const histCount = (d.db.prepare(
          `SELECT COUNT(*) n FROM messages m LEFT JOIN turns t ON t.input_message_id = m.id
           WHERE m.conversation_id = ? AND (t.id IS NULL OR t.state NOT IN ('pending','blocked'))`,
        ).get(turn.conversation_id) as { n: number }).n;
        if (histCount > 0) {
          const lastWin = d.db.prepare('SELECT id, revision FROM windows WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(turn.conversation_id) as { id: string; revision: number } | undefined;
          const awaiting = d.selections.ensureAwaiting({
            conversationId: turn.conversation_id,
            cause: 'initial',
            sourceWindowId: lastWin?.id ?? `csel-src-${turn.conversation_id}`,
            expectedWindowRevision: lastWin?.revision ?? 0,
            cutoffSequence: (d.db.prepare('SELECT COALESCE(MAX(sequence),0) AS m FROM messages WHERE conversation_id = ?').get(turn.conversation_id) as { m: number }).m,
          });
          this.blockAttempt(attempt.id, turnId, turn.conversation_id, `CONTEXT_SELECTION_REQUIRED:本房间已有历史但当前无活动窗口，请先确认新窗携带哪些历史（selection_id=${awaiting.selection_id}）；输入已保存`, 'blocked');
          return;
        }
      }
      d.windows.createWindow({ conversationId: turn.conversation_id, gate, assembledOptions: null });
      window = d.windows.activeWindow(turn.conversation_id);
      if (!window) {
        this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'NO_ACTIVE_WINDOW', 'blocked');
        return;
      }
    }
    // §7 AUD：人格/运行边界指纹变化 → 旧窗 CONTEXT_STALE，禁止 resume 旧 session
    // 2026-10-08：指纹按生效视图（含 or_model override；reasoning 已不参与指纹——
    // 换思考深度不换窗，上下文全复用）
    const expectedFingerprint = contextFingerprint(d.config, gate.manifest);
    if (window.context_fingerprint && window.context_fingerprint !== expectedFingerprint) {
      if (attempt.retry_window_id) {
        this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'RETRY_CONTEXT_CHANGED:运行配置已变化，本次重试未发送', 'blocked');
        return;
      }
      d.windows.markContextStale(window.id, 'CONTEXT_FINGERPRINT_MISMATCH');
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'CONTEXT_ROTATION_REQUIRED: 身份/运行边界已变化，需受控换窗（旧 session 不再续用）', 'blocked');
      // WP-07（CX-10）：切模型（运行边界变化）与手动换窗同一选集状态机——
      // 落 awaiting 选集行（哨兵源，无窗口行可 CAS、恒 revision 0），UI
      // 经确认入口（preview/confirm 以 awaiting.source_window_id 为目标）
      // 恢复原输入一次；不再是无出口的裸 blocked
      if (d.selections) {
        d.selections.ensureAwaiting({
          conversationId: turn.conversation_id,
          cause: 'identity_change',
          sourceWindowId: 'csel-src-model-change',
          expectedWindowRevision: 0,
          cutoffSequence: this.selectionCutoffSequence(turn.conversation_id),
        });
      }
      return;
    }
    // —— ESTOMAGO_OR_SELF_HOLD §2.2/§7：轨迹懒初始化（窗口创建/换窗后的首次信封驱动回合）——
    // 基底=system + 本输入之前的近期原话（首次规范化后固定，§7.1）；当前输入只作尾部追加一次。
    // R10（复审 2026-10-07）：准备阶段开始即可取消——活动代登记先于任何
    // await（此前 bootstrap 挂起发生在登记前，Stop 只认 active，房间卡在
    // 准备 await 上）。bootstrap 带受控截止时间+取消传递；取消后迟到
    // 结果不得再启动模型。
    const prepController = new AbortController();
    const prepRun: ActiveRun = { token: { cancelled: false }, controller: prepController, generation: turn.generation + 1 };
    this.active.set(turnId, prepRun);
    const prepSignal = AbortSignal.any([prepController.signal, AbortSignal.timeout(BOOTSTRAP_DEADLINE_MS)]);
    const stoppedDuringPreparation = () => {
      if (!prepRun.token.cancelled && !prepController.signal.aborted) return false;
      if (this.active.get(turnId) === prepRun) this.active.delete(turnId);
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'STOPPED_DURING_PREP:准备阶段已取消——迟到资料不派发模型，输入已保存', 'blocked');
      return true;
    };
    let trajInitializedThisTurn = false; // RE-10：懒初始化重建的轨迹=合法新基线，wire 守卫跳过
    if (dv && d.trajectory) {
      if (!attempt.retry_window_id && d.trajectory.discardUnsent(window.id)) this.bootstrapMachine.delete(window.id);
      const trajExists = d.trajectory.forWindow(window.id) !== null;
      if (attempt.retry_window_id && !trajExists) {
        this.active.delete(turnId);
        this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'RETRY_CONTEXT_UNAVAILABLE:原上下文缺失，本次重试未发送', 'blocked');
        return;
      }
      if (!trajExists) {
        trajInitializedThisTurn = true;
        // WP3：新窗历史装配只经人工选集（forTargetWindow 命中=消费过选集的
        // 新窗，严格按引用装配；空选=不带历史）。无选集命中的窗（真全新
        // 首窗/升级兼容期）维持旧自动回退——由 WP5 随 DS/12k 一并退役。
        const baseDialogue = this.dialogueUpTo(turn.conversation_id, inputMessage ? inputMessage.sequence - 1 : Number.MAX_SAFE_INTEGER);
        // D2（她批准 2026-10-06）：新窗轨迹初始化时装入开窗资料（缓存点 B）——
        // B 进入轨迹正本的 system 段并随窗冻结（§7.1 首次装配后固定）；取不到
        // =无 B 降级（context.warning 已记），不阻塞消息、不伪造"记忆已恢复"
        await this.prepareWindowTools(window.id, prepSignal);
        const boot0 = await this.bootstrapMachine.windowBootstrap(window.id, prepSignal, turn.conversation_id, materials?.memoryAnchorsText);
        if (stoppedDuringPreparation()) return;
        const sel0 = d.selections?.forTargetWindow(window.id) ?? null;
        // 相册重构 P5：懒初始化位点解析开窗携带（真实窗 id——直接固化行；选集/携带图
        //  随 buildEnvelope 装配并冻结进轨迹）。超限抛错→本 attempt 阻断（不静默丢图）。
        const loaded0 = sel0 ? d.selections!.loadForProjection(sel0) : [];
        const carry0 = await this.resolveWindowCarry(turn.conversation_id, window.id, loaded0);
        this.persistCarryPlanForWindow(window.id);
        const built0 = sel0
          ? this.buildEnvelope({ conversationId: turn.conversation_id, windowId: window.id, materials, bootText: boot0, episodeFragment: this.bootstrapMachine.episodeFragmentFor(window.id), dialogue: [], tailUserText: ' ', selectedMessages: loaded0, carryFragment: carry0.fragment })
          : this.buildEnvelope({ conversationId: turn.conversation_id, windowId: window.id, materials, bootText: boot0, episodeFragment: this.bootstrapMachine.episodeFragmentFor(window.id), dialogue: baseDialogue, tailUserText: ' ', carryFragment: carry0.fragment });
        // F06（复审修正）：manifest 从 buildEnvelope 实际选中的子集生成——裁剪掉旧消息时
        // 不再按索引回映全量前缀 ID（正文含 B、清单含 A 的错配源头）
        const baseManifest = built0.selected.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
        d.trajectory.init(window.id, built0.envelope.messages.slice(0, -1), baseManifest);
      }
    }
    // —— ESTOMAGO_OR_SELF_HOLD §4：换窗触发（容量软线 600k 兜底——唯一自动基线，6h 静默已退役）→ 一次提醒 → CAS 换窗；
    // 评审失败如实阻断本 attempt（不绕过、不伪造完成凭证）。
    if (dv && inputMessage) {
      const rotation = await this.rotateIfNeeded({
        conversationId: turn.conversation_id, window, gate,
        currentInputSequence: inputMessage.sequence, attemptId: attempt.id, turnId,
        materials,
        preserveWindow: Boolean(attempt.retry_window_id),
      });
      if (rotation.blocked) {
        this.active.delete(turnId);
        this.blockAttempt(attempt.id, turnId, turn.conversation_id, rotation.blocked, 'blocked');
        return;
      }
      if (rotation.rotated) {
        const next = d.windows.activeWindow(turn.conversation_id);
        if (next) window = next; // 新窗已 ACTIVE：本轮输入只进新窗一次（§4.2）
        if (next) this.persistCarryPlanForWindow(next.id); // P5：准备期暂存的携带计划随窗落地
        if (d.trajectory) {
          const nextTraj = d.trajectory.forWindow(window.id);
          if (!nextTraj) {
            const baseDialogue = this.dialogueUpTo(turn.conversation_id, inputMessage.sequence - 1);
            await this.prepareWindowTools(window.id, prepSignal);
            const bootR = await this.bootstrapMachine.windowBootstrap(window.id, prepSignal, turn.conversation_id, materials?.memoryAnchorsText);
            if (stoppedDuringPreparation()) return;
            // WP3：换窗后的新窗按消费的选集装配（选集在 doRotate 同事务
            // 绑定 target_window_id；无命中=兼容期自动回退）
            const selR = d.selections?.forTargetWindow(window.id) ?? null;
            const loadedR = selR ? d.selections!.loadForProjection(selR) : [];
            const carryR = await this.resolveWindowCarry(turn.conversation_id, window.id, loadedR);
            this.persistCarryPlanForWindow(window.id);
            const builtR = selR
              ? this.buildEnvelope({ conversationId: turn.conversation_id, windowId: window.id, materials, bootText: bootR, episodeFragment: this.bootstrapMachine.episodeFragmentFor(window.id), dialogue: [], tailUserText: ' ', selectedMessages: loadedR, carryFragment: carryR.fragment })
              : this.buildEnvelope({ conversationId: turn.conversation_id, windowId: window.id, materials, bootText: bootR, episodeFragment: this.bootstrapMachine.episodeFragmentFor(window.id), dialogue: baseDialogue, tailUserText: ' ', carryFragment: carryR.fragment });
            const baseManifest = builtR.selected.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
            d.trajectory.init(window.id, builtR.envelope.messages.slice(0, -1), baseManifest);
          }
        }
      }
    }
    // route-edit 的新 attempt（fresh_session=1）：不 resume 旧 session——修订输入全新开跑，
    // 旧 session 历史含被替代的旧触发，定点排除语义未实测前不得带旧触发重跑。
    // 信封驱动（OR/DS）无宿主可见 resume 语义（session_id 是内部关联标识，不存历史）→ 恒 null。

    // —— fence + running（claim 条件更新：双执行防护，AUD-37）——
    const generation = turn.generation + 1;
    const claimed = tx(d.db, () => {
      const c = d.db.prepare("UPDATE attempts SET state = 'running', window_id = ?, started_at = ? WHERE id = ? AND state = 'pending'")
        .run(window.id, new Date().toISOString(), attempt.id);
      if (Number(c.changes) === 1) {
        d.db.prepare('UPDATE turns SET generation = ?, state = ? WHERE id = ?').run(generation, 'running', turnId);
      }
      return Number(c.changes);
    });
    if (claimed !== 1) { // 已被其他执行路径占有：跳过（数据库是真源）
      if (this.active.get(turnId) === prepRun) this.active.delete(turnId);
      return;
    }
    d.events.publish('turn.status', {
      conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id,
      payload: { state: 'running', attempt_no: attempt.attempt_no, generation, resume_session: Boolean(window.sdk_session_id && !attempt.fresh_session) },
    });

    // R10：准备阶段被取消 → 迟到的 bootstrap 结果不得再启动模型
    if (prepRun.token.cancelled) {
      this.active.delete(turnId);
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'STOPPED_DURING_PREP:准备阶段已取消——迟到资料不派发模型，输入已保存', 'blocked');
      return;
    }
    const runToken: ActiveRun = { token: { cancelled: false }, controller: new AbortController(), generation };
    this.active.set(turnId, runToken);

    // 有效输入投影（路由编辑后 attempt.input_revision 指定修订）
    const effective = (() => {
      if (!inputMessage) return { content: '', revision: 1, hash: '', sequence: null as number | null };
      if (attempt.input_revision && attempt.input_revision !== inputMessage.current_revision) {
        const row = d.db
          .prepare('SELECT revision, content, content_hash FROM message_revisions WHERE message_id = ? AND revision = ?')
          .get(inputMessage.id, attempt.input_revision) as { revision: number; content: string; content_hash: string } | undefined;
        if (row) return { revision: row.revision, content: row.content, hash: row.content_hash, sequence: inputMessage.sequence };
      }
      return { content: inputMessage.revision.content, revision: inputMessage.current_revision, hash: inputMessage.revision.content_hash, sequence: inputMessage.sequence };
    })();

    // 自动浮现（EST_MARIPOSA_AUTO_SURFACING_V1 · docs/04）：目标内容修订
    // 确定之后、最终 payload 冻结之前——有界 validate/check（服务内控
    // 接受时起绝对总预算）+ 尝试级冻结注入块。source/target 均为本
    // 消息当前修订；工具续轮不重跑本路径（runTurn 每
    // attempt 一次；工具循环在 runOrToolLoop 内部，不重新装配尾部）。
    let surfacingAugment: import('../context/contributions.ts').AugmentResult | null = null;
    // P3（U05/T05，20261106）：通话话轮不注入浮现面——通话期间 Sol 调用与浮现注入均为 0
    const inputIsCallTurn = inputMessage ? Boolean(this.d.db.prepare("SELECT 1 FROM messages WHERE id=? AND client_message_id LIKE 'voice:%'").get(inputMessage.id)) : false;
    if (!inputIsCallTurn && d.surfacing && supportsSurfacingTransport(this.drv()?.kind ?? '') && inputMessage && inputMessage.speaker === 'owner') {
      try {
        const candidate = d.surfacing.reuseFrozen(attempt.id) ?? await d.surfacing.augmentFor({
          conversationId: turn.conversation_id, windowId: window.id, turnId,
          attemptId: attempt.id,
          approvedIdentityText: materials?.identityText ?? null,
          pendingCoverage: this.bootstrapMachine.coverageFor(window.id, d.trajectory?.forWindow(window.id)?.messages ?? [])?.window_coverage,
          message: { id: inputMessage.id, revision: effective.revision, sequence: inputMessage.sequence, content: effective.content, hash: effective.hash },
        });
        surfacingAugment = candidate;
      } catch {
        surfacingAugment = null; // 复核失败=本轮零注入，正常聊天不受影响（docs/08）
      }
      // ALB-10/R28 + R6 精确封存（复审 2026-11-08）：争吵封存的主闸在 prepare 下推——
      // quarrel sm 集随来源边界进 M，检索层逐项排除（words/raw 按 source_ref、event 按
      // 桶绑定），无关候选不再整包扣留。此处是终投递资格检查（03 §6：覆盖存档前已在
      // 途、存档后才冻结返回的候选）：命中来源仍整包扣留（text/items 一体冻结，item
      // 级剔除会投影不一致；下轮 prepare 已带排除集不再重推）。content 不可达=只暂缓
      // 本次自动注入（正常聊天继续），不空集放行冒充已核对。主动查看/手选/默认携带
      // 不在本路径；无法定位来源的候选（words/event 无 source_ref）不凭相似封禁。
      if (surfacingAugment && this.d.archives && this.d.contentClient) {
        // RR4-B：终投递复核同样受本回合取消约束（stop/route-signal abort 控制器）。
        const blocked = await this.d.archives.quarrelBlockedSourceRefs(turn.conversation_id, runToken.controller.signal);
        // RR4-W2d：服务可达（reachable）与范围读全（complete）分开——任一不成立都
        // 暂缓本次自动注入（正常聊天继续），已生成未投递的候选不绕过完整性判断。
        if (!blocked.reachable || !blocked.complete) {
          d.logger.warn('surfacing_deferred_quarrel_unreachable', { turn_id: turnId, delivery_id: surfacingAugment.deliveryId, complete: blocked.complete });
          surfacingAugment = null;
        } else if (blocked.refs.size > 0) {
          const hit = surfacingAugment.items.some((it) => typeof it.source_ref === 'string' && blocked.refs.has(it.source_ref.replace(/^source_msg:/, '')));
          if (hit) {
            d.logger.info('surfacing_suppressed_quarrel', { turn_id: turnId, delivery_id: surfacingAugment.deliveryId, blocked_refs: blocked.refs.size });
            surfacingAugment = null;
          }
        }
      }
    }
    // §3：经 ContextAssembler 构造（allowlist builder；reasoning 无通道）
    const assembledContext = assembleContext(
      {
        conversationId: turn.conversation_id, windowId: window?.id ?? null, turnId,
        inputMessageId: inputMessage?.id ?? null,
        timeContextText: modelTimeContextText(timeCtx),
        userInput: { revision: effective.revision, content: effective.content },
      },
      {},
    );
    // 程序事实轮（拒接/取消留言调度）：空尾 + program_fact_turns 有行 → 事实块追加为尾部
    // 宿主注入（[program_fact] 前缀，同 time_context 先例——不是用户发言，不写 messages）
    // B4（2026-11-04）：行内括号解释移入 HOST_BOUNDARY_RULES 固定边界（缓存前缀一次声明）；
    // 已实发旧轨迹的长格式逐字保留，新旧格式在新窗口轮出前共存（执行稿 B4 版本边界）。
    const programFact = inputMessage ? null : (d.db.prepare('SELECT fact_text, kind FROM program_fact_turns WHERE turn_id = ?').get(turnId) as { fact_text: string; kind: string } | undefined ?? null);
    // B4：一次性待消费程序事实（现网用例=通话结束）——仅随正常文字轮附带：
    // ①本轮输入存在（正常用户消息）②不是通话轮（通话中文字输入≠通话结束，B5 缩小打字依赖此区分）
    // ③该会话当前无 active 通话（事实仍真实时才说）。多个待消费事实按创建序全量附带。
    const pendingFacts = inputMessage && !this.isCallTurnMessage(inputMessage.id)
      ? (d.db.prepare("SELECT id, fact_text FROM pending_program_facts WHERE conversation_id=? AND consumed_at IS NULL ORDER BY created_at").all(turn.conversation_id) as Array<{ id: string; fact_text: string }>)
        .filter(() => !isVoiceCallActive(d.db, turn.conversation_id)) // E02：窄能力（与 model-bridge/executor 同源判定）
      : [];
    // 只有经 Siren 实时入口登记、实际接着本轮回复流的回合才声明电话模式。
    // 普通语音附件、通话时键入的消息、以及挂断后从聊天重试都没有本轮通话输出抽头。
    const liveCallFact = this.voiceTaps.has(turnId) ? `[program_fact]\n${TurnSupervisor.LIVE_CALL_FACT}` : null;
    const prompt = [
      ...assembledContext.segments.flatMap((seg) => {
        const block = `[${seg.source}]\n${seg.text}`;
        return seg.source === 'user_input' && liveCallFact ? [liveCallFact, block] : [block];
      }),
      ...(programFact ? [`[program_fact]\n${programFact.fact_text}`] : []),
      ...pendingFacts.map((f) => `[program_fact]\n${f.fact_text}`),
    ].join('\n\n');
    const inputHash = effective.hash || sha256Hex(effective.content);

    // 信封请求 v3（§5.5/§6.3/§7，OR/DS 共用管线）：消息=窗口轨迹正本 + 本轮输入尾部（append-only）；
    // 断点规划 A（system 末块）+ G（上次已发送边界，仍有效才标；B 待 bootstrap 接入）——DS 直连
    // 序列化时忽略断点（自动缓存，无参数）；previousPayload=轨迹正本构造的上一请求（跨轮 append-only 断言依据）。
    const dialogueForInput = dv && inputMessage ? this.dialogueUpTo(turn.conversation_id, inputMessage.sequence - 1) : [];
    const orTraj = dv ? d.trajectory?.forWindow(window.id) ?? null : null;
    // D05（审计 3655d60）：轨迹追赶投影——上一轨迹落盘后新发布的消息（含失败回合的已发输入与已发布
    // 助手原话）按库内当前修订补进本次信封，模型上下文与聊天界面不再分叉。成功回合的轨迹已含它们
    // （无重复）；失败回合不落轨迹，下一轮按同一规则重算（自愈且幂等，重试不去重问题不存在——
    // 失败轮的输入修订若被 route-edit 替代，追赶段按 current_revision 取到的是新修订，仍只出现一次）。
    const trajMaxSeq = orTraj?.manifest && orTraj.manifest.length > 0 ? Math.max(...orTraj.manifest.map((m) => m.seq)) : -1;
    // D05/D06 交互：追赶只收**有真实发出证据**的回合（该回合存在 purpose='chat' 且 sent_at 非空的请求）——
    // 被 P2 硬门拒发的大输入从未上线，不得被追赶投影反复注回上下文（否则 F25 短输入被永久堵死的
    // 回归以新形式复现）；评审请求（pre_rotate_review）不算证据（其信封不含聊天正文）。
    // F-J-39：追赶投影与评审路径同源（catchupEntries 单一实现）
    const catchup = orTraj ? this.catchupEntries(turn.conversation_id, dialogueForInput, trajMaxSeq, window.id) : [];
    // EXEC_V1 §03.6：追赶投影经同一投影器（媒体消息进上下文不再被拆成纯文本）
    const catchupContinuation = this.windowHasTool(window.id, 'transcript_read');
    const catchupMessages: OrMessage[] = catchup.map((m) => ({ role: m.role, content: this.revisionBlocks(m.id, m.revision, m.content, { transcriptContinuationAvailable: catchupContinuation }).blocks }) as unknown as OrMessage);
    const catchupManifest: ManifestEntry[] = catchup.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
    // WP-07（CX-07）：无轨迹 fallback 必须携带该窗已确认选集（选集为空
    // 数组=只发待答输入）——杜绝 dialogueUpTo 全量装配进入新窗（历史
    // 进新窗唯一途径=人工选集；同窗无轨迹的正常首轮已在上方懒初始化
    // 补建轨迹，到这里的 fallback 只剩轨迹意外缺失场景）
    const fallbackSel = dv && d.selections ? d.selections.forTargetWindow(window.id) : null;
    const fallbackBuild = (!orTraj && dv)
      ? this.buildEnvelope({
          conversationId: turn.conversation_id,
          materials,
          dialogue: [],
          tailUserText: prompt,
          tailMessage: inputMessage ? { id: inputMessage.id, revision: effective.revision } : null,
          selectedMessages: dv && d.selections && fallbackSel ? d.selections.loadForProjection(fallbackSel) : [],
        })
      : null;
    const orBaseMessages: OrMessage[] = orTraj
      ? [...orTraj.messages, ...catchupMessages]
      : (fallbackBuild ? fallbackBuild.envelope.messages.slice(0, -1) : []);
    // EXEC_V1 §03.6：本轮输入尾部投影（当前消息附件进模型；isCurrentInput：无转写语音在门处阻断）
    // P2 §6.6：同上——聊天语音观察的有界等待在装配前完成（独立预算，不挂浮现 300s）
    if (inputMessage && this.d.voiceObservations) await this.d.voiceObservations.awaitReadyForDispatch(inputMessage.id, effective.revision, VOICE_OBSERVATION_PREP_BUDGET_MS);
    const tailProjection = this.revisionBlocks(inputMessage?.id ?? null, effective.revision, prompt, { isCurrentInput: true, hearingAvailable: Boolean(dv) && voiceHearingPort(this.d.db, this.d.oidoHearing === true, window.id), transcriptContinuationAvailable: this.windowHasTool(window.id, 'transcript_read') });
    // Append the recollection before the real input, preserving both the user message and the existing history.
    const hostMemory: OrMessage[] = surfacingAugment
      ? [surfaceTransportMessage(this.drv()?.kind ?? '', surfacingAugment.text)] : [];
    // ALB-11（审计 2026-11-08，03 §4.2）：宿主一次性通知在下一次正常请求尾部追加为
    // 独立 system 数据块（与浮现注入同一追加位；不进冻结轨迹前缀、不改历史）。取出
    // 不立即标记——按本轮实际投递证据在终态收口（confirmNoticesDelivered）。
    const pendingNoticeBatch = this.d.archives ? this.d.archives.takePendingNotices(turn.conversation_id, true) : [];
    const hostNoticeMessages: OrMessage[] = pendingNoticeBatch.map((n) => ({ role: 'system', content: [{ type: 'text', text: n.text }] }) as OrMessage);
    const orMessages: OrMessage[] = [...orBaseMessages, ...hostMemory, ...hostNoticeMessages,
      { role: 'user', content: tailProjection.blocks } as OrMessage];
    // R2：四类驱动均为信封驱动；RUNTIME_NOT_READY/IDENTITY 门已在此前返回，dv 必非空
    const orEnvelope: OrRequestEnvelope = (() => {
          // R11：systemMessageCount 按实际（B 独立数据块时=2，cache-plan
          // 的独立 B 点分支由此生效；此前硬编码 1，B 点显式边界从未成立）
          const { boundaries, gDropped } = planBoundaries({ messages: orMessages, systemMessageCount: fixedSystemCount(orBaseMessages), prevBoundary: orTraj?.lastBoundary ?? null });
          if (gDropped) {
            d.events.publish('context.warning', { conversationId: turn.conversation_id, entityRef: window.id, scope: 'private', payload: { source: 'cache', code: 'g_dropped' } });
          }
          return {
            model: dv!.model,
            sessionId: dv!.sessionId(turn.conversation_id),
            messages: orMessages,
            // F-J-09：本窗冻结快照（首发定格；词表中途变化不改变本窗 tools）
            tools: this.windowTools(window.id),
            boundaries,
            maxTokens: dv!.maxTokens,
            reasoning: dv!.reasoning,
          };
        })();
    // F-J-09：跨轮 previousPayload 的 tools 取**已发送冻结快照**（本窗首发定格），
    // 不用本轮重建结果充当"上一请求"——若当前信封 tools 与冻结快照漂移（回归），
    // append-only 断言可在跨轮间抓到（此前两边恒同源=结构性失明）
    // WP-05（B16）：append-only 断言的 previousEnvelope 不携带 reasoning——
    // effort 是逐请求生成参数（她裁定 2026-10-08：换思考深度不换窗、
    // reasoning 已退出 contextFingerprint），跨轮比较该键会误杀合法的
    // 档位切换；轨迹正本（messages）仍是断言主体
    const { reasoning: _prevReasoning, ...orPrevParams } = orEnvelope !== null ? orEnvelope : ({} as OrRequestEnvelope);
    void _prevReasoning;
    const orPreviousPayloadEnvelope: OrRequestEnvelope | null = orTraj && orEnvelope !== null ? { ...(orPrevParams as OrRequestEnvelope), tools: this.windowTools(window.id), messages: [...orTraj.messages, ...catchupMessages] } : null;
    // R2（2026-10-23，E08）：DS 跨用户轮 wire 守卫——上一笔**实际派发**记录（provider_requests 的
    // wire_v1 存储投影）与本次将发出的轨迹前缀逐位核对 role/长度/继续态。此前守卫从（可能已剥除
    // 的）轨迹重建 previous，两份同源派生=结构性失明（审计真实复现：6→7 请求旧 assistant 的
    // reasoning_content 被剥而无人发现）。不通过忽略 reasoning_content 键让断言通过——legacy 的
    // 跨轮剥除是 D01 有意变换，按政策核验其被一致执行；新政策下 wire 有而轨迹无=直接拒发。
    if (dv?.kind === 'deepseek' && orTraj && !trajInitializedThisTurn) {
      // 只比已完成回合的最后一笔实发 wire：失败回合的工具 assistant 在 wire 里而轨迹/追赶投影
      // 不含它，拿它当前缀基准会假阳性（位置性错位）。已完成回合的 traj 基底==该回合末请求消息。
      const wireRow = d.db.prepare("SELECT pr.payload_wire_json FROM provider_requests pr JOIN turns t ON t.id = pr.turn_id WHERE pr.window_id = ? AND pr.purpose = 'chat' AND pr.sent_at IS NOT NULL AND pr.outcome IS NOT 'SUPERSEDED_BY_RETRY' AND t.state = 'completed' ORDER BY pr.sent_at DESC, pr.rowid DESC LIMIT 1").get(window.id) as { payload_wire_json: string | null } | undefined;
      if (wireRow?.payload_wire_json) {
        let wireMsgs: Array<Record<string, unknown>> | null = null;
        try { const parsed = JSON.parse(wireRow.payload_wire_json) as { messages?: unknown }; if (Array.isArray(parsed.messages)) wireMsgs = parsed.messages as Array<Record<string, unknown>>; } catch { wireMsgs = null; }
        if (wireMsgs) {
          const trajSide = [...orTraj.messages, ...catchupMessages] as Array<Record<string, unknown>>;
          if (wireMsgs.length > trajSide.length) throw new Error(`WIRE_TRAJECTORY_DIVERGED:shortened@wire${wireMsgs.length}>traj${trajSide.length}`);
          // RE-10（2026-10-24 返修）：完整前缀核对——role 之外，content（含旧 user 正文）、
          // tool_calls 参数、tool_call_id、name 等逐字段比对（上轮反例：已发送 user 内容被改写
          // 成 CORRUPTED…仍照发）。两侧按 DS 发送同态归一：块数组拍平为文本（镜像
          // buildDeepSeekPayload），图块（traj=asset_image 引用 / wire=image 物化+存储脱敏）
          // 统一占位——字节身份由资产不可变性与存储指纹另行保障；键序无关（canonical 序列化）。
          const wireNorm = withoutCacheMarkers({ messages: wireMsgs }).messages as Array<Record<string, unknown>>;
          const flatten = (content: unknown): unknown => {
            if (!Array.isArray(content)) return content ?? null;
            return content.map((b) => {
              const blk = b as Record<string, unknown> | null;
              if (blk && (blk.type === 'asset_image' || blk.type === 'image')) return '\u0000IMG\u0000';
              return typeof blk?.text === 'string' ? blk.text : '';
            }).join('');
          };
          const canon = (v: unknown): string => {
            if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
            if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
            const o = v as Record<string, unknown>;
            const keys = Object.keys(o).sort();
            return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
          };
          const comparable = (m: Record<string, unknown>): Record<string, unknown> => {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(m)) {
              if (k === 'cache_control' || k === 'reasoning_content') continue; // 缓存标记随轮次变化；reasoning 继续态在 assistant 分支无条件单独核对
              out[k] = k === 'content' ? flatten(v) : v;
            }
            return out;
          };
          for (let i = 0; i < wireMsgs.length; i++) {
            const w = wireNorm[i]!, t = trajSide[i]!;
            if (w.role !== t.role) throw new Error(`WIRE_TRAJECTORY_DIVERGED:role@${i}`);
            // system 段逐请求合法可变（time_context 等），不属于不可变历史——只比对
            // user/assistant/tool 消息（守卫职责=已发送历史正文/工具轨迹不被改写）
            if (w.role !== 'system') {
              const wC = canon(comparable(w)), tC = canon(comparable(t));
              if (wC !== tC) throw new Error(`WIRE_TRAJECTORY_DIVERGED:content@${i}`);
            }
            if (w.role === 'assistant') {
              // 她 1024 裁定（接缝①）：协议历史正本全保留、统一完整回传——"旧窗剥除"规则废止。
              // 继续态核对改为无条件：wire 有↔轨迹有必须一致（丢=被改写拒发；多=wire 没发过轨迹
              // 却有→同样 diverged）。不再有"轨迹存在继续态即拒发"的 legacy 分支。
              const wireHas = typeof w.reasoning_content === 'string' && w.reasoning_content.length > 0;
              const trajHas = typeof t.reasoning_content === 'string' && t.reasoning_content.length > 0;
              if (wireHas !== trajHas) throw new Error(`WIRE_TRAJECTORY_DIVERGED:reasoning@${i}`);
              if (wireHas && w.reasoning_content !== t.reasoning_content) throw new Error(`WIRE_TRAJECTORY_DIVERGED:reasoning_text@${i}`);
            }
          }
        }
      }
    }
    // F14：书签视野=发起请求实际看见的位置——本轮输入已进入 payload，序号=输入序号（不再减一）
    const orSeenHighWater = inputMessage ? inputMessage.sequence : 0;
    // D13（审计 3655d60）：本请求**实际装载**的 (消息,修订) 视野——引用核对只认这份清单
    const orSeenBase: ReadonlyArray<{ id: string; revision: number }> = orTraj
      ? [...(orTraj.manifest ?? []).map((m) => (m.char_start !== undefined ? { id: m.id, revision: m.revision, char_start: m.char_start, char_end: m.char_end } : { id: m.id, revision: m.revision })), ...catchupManifest.map((m) => ({ id: m.id, revision: m.revision })), ...(inputMessage ? [{ id: inputMessage.id, revision: effective.revision }] : [])]
      : catchupManifest.map((m) => ({ id: m.id, revision: m.revision }));
    // 记账模型：信封驱动用各自明确型号（§9.3 不混淆口径）；SDK 沿配置模型，F10 观测实际值后覆盖
    const configuredModelForUsage = dv ? dv.model : d.config.runtime.model;

    // 首发信封已确定本次执行窗口，发布和通话抽头共用该窗的冻结合同。
    const legacySequenceMarkers = catalogUsesLegacySequenceMarkers(storedToolset(d.db, window.id)?.catalog ?? []);
    const segmenter = new TextSegmenter();
    let sawReasoningBlock = false;
    // §16 + F11：正文按 (messageId, blockIndex) 跟踪——同一消息多个 text 块各自独立
    const publishedByKey = new Map<string, string>();
    // F11 第二道防线：归一化事件层的包幂等（runner 直发场景不经 normalizer；同 packet_uuid 只处理一次）
    const handledPacketUuids = new Set<string>();
    const publishText = (sdkMessageId: string, blockIndex: number, text: string): void => {
      const key = `${sdkMessageId}:${blockIndex}`;
      const prev = publishedByKey.get(key) ?? '';
      if (!text.startsWith(prev)) return; // 冲突：已发布气泡不可改写
      const tail = text.slice(prev.length);
      if (tail.length === 0) return;
      publishedByKey.set(key, text);
      // RE-02（2026-10-24）：语音抽头与聊天落库同源（同一真实新增 tail，provider 速度）；
      // 取消后代际内不供给（与下方 publishSegments 的 fence 一致）
      if (!runToken.token.cancelled) this.voiceTaps.get(turnId)?.(tail, legacySequenceMarkers);
      publishSegments(segmenter.push(tail));
    };
    let routeSignalHandled = false;
    let fallbackSwitched = false; // F10：模型切换已发生（SDK 观测）——回合按 interrupted 收口并标注原因
    let actualModelForUsage: string | null = null; // F10：用量记账用实际模型，不用配置模型冒充
    // F06/F14：本回合正式发布的助手消息 → 轨迹 manifest 增量（实际已见证据）
    const turnManifestAdditions: ManifestEntry[] = [];
    // 2026-10-17 她裁定（Claude 官端说话方式）：一轮回复合成一条消息——
    // 首段创建、后续段落以新修订追加（内容增长）；不再逐段独立成气泡
    let turnAssistantMessageId: string | null = null;
    const publishSegments = (segs: string[]): void => {
      for (const part of segs) {
        if (runToken.token.cancelled) return;
        const seg = legacySequenceMarkers ? stripLegacySequenceMarker(part) : part;
        let msg: ReturnType<import('../messages/service.ts').MessageService['getMessage']> | null;
        if (turnAssistantMessageId === null) {
          msg = d.messages.publishAssistantMessage({ conversationId: turn.conversation_id, turnId, content: seg });
          turnAssistantMessageId = msg.id;
          turnManifestAdditions.push({ id: msg.id, revision: msg.current_revision, seq: msg.sequence, origin: 'dialogue', visible: true });
        } else {
          msg = d.messages.appendAssistantPublication(turnAssistantMessageId, seg);
          if (msg === null) continue;
          // F02（四仓联合审计 20261104，链A）：追加段使消息修订增长——manifest 的"实际已见"
          // 证据必须同步推进，否则下一轮请求已含完整两段而 manifest 仍记首段修订，
          // resolveQuoteRefs 按旧修订读取导致引用截断（审计实测：storedRevision=2、
          // manifestRevision=1，引用只有第一段）。同消息单条 entry，原地推进修订。
          const entry = turnManifestAdditions.find((e) => e.id === msg!.id);
          if (entry && msg.current_revision > entry.revision) entry.revision = msg.current_revision;
        }
        d.events.publish('message.published', {
          conversationId: turn.conversation_id, turnId, entityRef: msg.id, entityRevision: msg.sequence,
          payload: { message: msg },
        });
      }
    };

    const handleRouteSignal = (notice?: { currentModel: string | null; evidenceCode: string }): void => {
      if (routeSignalHandled) return;
      routeSignalHandled = true;
      runToken.token.cancelled = true; // fence 立即生效（AUD-05：迟到输出不得发布）
      // 她 2026-10-24 裁定（approve 补完）：同一输入已接受过一次路由（票据 consumed+
      // choice=approve 的续跑）后再次路由信号 → 不再开新票据（无限"接受→又被路由"
      // 循环不可达用户收口），attempt/turn 按明确失败终局，原因如实标注。
      const approvedBefore = (d.db.prepare("SELECT COUNT(*) n FROM route_decisions WHERE turn_id = ? AND state = 'consumed' AND choice = 'approve'").get(turnId) as { n: number }).n;
      if (approvedBefore > 0) {
        try {
          tx(d.db, () => {
            d.db.prepare("UPDATE attempts SET state = 'failed', blocked_reason = 'ROUTE_SIGNAL_AFTER_APPROVE', completed_at = ? WHERE id = ?").run(new Date().toISOString(), attempt.id);
            d.db.prepare("UPDATE turns SET state = 'failed', completed_at = ? WHERE id = ?").run(new Date().toISOString(), turnId);
          });
        } catch (err) {
          d.logger.error('route_signal_loop_tx_failed', { turn_id: turnId, code: stableCode(err) });
          return;
        }
        d.events.publish('turn.status', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id, scope: 'private', payload: { state: 'failed', reason: 'ROUTE_SIGNAL_AFTER_APPROVE' } });
        runToken.controller.abort();
        d.reasoning.markAttemptFinal({ attemptId: attempt.id, final: 'interrupted', generation });
        return;
      }
      // 控制序列：持久票据 + generation fence + attempt/turn 状态，同一事务（事件在提交后发布）
      let ticketId: string | null = null;
      try {
        tx(d.db, () => {
          const ticket = d.routing.createPendingInTx({
            conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
            inputHash, targetModel: null, evidenceCode: notice?.evidenceCode ?? 'SDK_ROUTE_SIGNAL',
            messageId: inputMessage?.id ?? null, inputRevision: effective.revision,
          });
          ticketId = ticket.id;
          d.db.prepare('UPDATE turns SET generation = ? WHERE id = ?').run(generation + 1, turnId);
          d.db.prepare("UPDATE attempts SET state = 'route_owner_pending', completed_at = ? WHERE id = ?").run(new Date().toISOString(), attempt.id);
          d.db.prepare("UPDATE turns SET state = 'route_owner_pending' WHERE id = ?").run(turnId);
        });
      } catch (err) {
        d.logger.error('route_signal_tx_failed', { turn_id: turnId, code: stableCode(err) });
        return;
      }
      d.events.publish('route.pending', {
        conversationId: turn.conversation_id, turnId, attemptId: attempt.id, scope: 'private',
        payload: { decision_id: ticketId, current_model: notice?.currentModel ?? null, target_model: null, evidence_code: notice?.evidenceCode ?? 'SDK_ROUTE_SIGNAL', already_switched: false, affects_future_sessions: null },
      });
      d.events.publish('turn.status', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id, payload: { state: 'route_owner_pending', generation } });
      runToken.controller.abort(); // 通知 runner 停止
      d.reasoning.markAttemptFinal({ attemptId: attempt.id, final: 'interrupted', generation });
    };

    // §6.3：驱动判别请求——同一 handleEvent（发布/记账/route 语义对两驱动一致，不复制两套处理）
    const handleEvent = (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: ModelRequestContext): void => {
          // generation fence（AUD-05/03 迟到 chunk）：只挡内容类事件（正文/思考/工具投影）；
          // usage 与路由事实是记账观测，不是发布——fence 后仍须入账（F10：实际模型不能丢）
          if (runToken.token.cancelled && ev.kind !== 'usage' && ev.kind !== 'system_notice' && ev.kind !== 'packet_conflict') return;
          switch (ev.kind) {
            case 'content_block_start':
              if (ev.channel === 'subagent') break; // 子代理不投影进主私聊（AUD-12）
              if (ev.block_type === 'thinking') {
                sawReasoningBlock = true;
                d.reasoning.startBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index, generation });
              } else if (ev.block_type === 'redacted_thinking') {
                sawReasoningBlock = true;
                d.reasoning.markRedactedOrOmitted({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index, visibility: 'redacted', generation });
              }
              break;
            case 'thinking_delta':
              if (ev.channel === 'subagent') break;
              d.reasoning.appendDelta({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index, text: ev.text, generation });
              break;
            case 'text_delta':
              if (ev.channel === 'subagent') break;
              publishText(ev.sdk_message_id, ev.block_index, (publishedByKey.get(`${ev.sdk_message_id}:${ev.block_index}`) ?? '') + ev.text);
              break;
            case 'content_block_stop':
              if (ev.channel === 'subagent') break;
              d.reasoning.markStreamBlockComplete({ attemptId: attempt.id, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index, generation });
              break;
            case 'complete_message':
              if (ev.channel === 'subagent') break;
              if (ev.packet_uuid) {
                // F11：同包重投（归一化层）只处理首次；后续重放不再发布正文
                if (handledPacketUuids.has(ev.packet_uuid)) break;
                handledPacketUuids.add(ev.packet_uuid);
              }
              if (ev.matched.some((b) => b.block_type === 'thinking') || ev.matched.some((b) => b.block_type === 'redacted_thinking')) sawReasoningBlock = true;
              for (const b of ev.matched) {
                if (b.block_type === 'text' && typeof b.text === 'string') publishText(ev.sdk_message_id, b.block_index, b.text); // §16+F11
              }
              for (const u of ev.unmatched) {
                // §16+F11：只有无开放块对应的完整 text 才安全发布；ambiguous 不猜归属（reasoning 侧仍核对）。
                // 发布键绑定包 uuid（无则退化为 message id）——不同包同文字不误判，同包重投已被上层拦截
                if (u.reason !== 'no_open_block' || u.block_type !== 'text' || typeof u.text !== 'string' || u.text.length === 0) continue;
                publishText(`${ev.packet_uuid ?? ev.sdk_message_id}`, u.seq, u.text);
              }
              d.reasoning.reconcileCompleteMessage({
                conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
                sdkMessageId: ev.sdk_message_id, matched: ev.matched, unmatched: ev.unmatched, generation,
              });
              break;
            case 'tool_input_delta':
              d.events.publish('tool.status', {
                conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
                entityRef: `${ev.sdk_message_id}:${ev.block_index}`,
                payload: { phase: 'input_streaming', tool: null, channel: ev.channel },
              });
              break;
            case 'usage':
              d.usage.record({
                turnId, attemptId: attempt.id, scope: ev.scope, usage: ev.usage,
                requestId: reqCtx?.requestId ?? undefined, // F12：同 turn 多请求按请求身份分行保留
                windowId: window.id, // F31：直接归属窗口（不再只靠 attempt JOIN）
                model: reqCtx?.responseModel ?? reqCtx?.requestedModel ?? actualModelForUsage ?? configuredModelForUsage, // F10：观测到实际模型后按实际值；OR 用明确型号
                source: ev.source, completeness: ev.completeness,
              });
              // EXEC_V1 §04.5（WP2）：缓存证据观测——温态五条件门活接线（字段缺失/无派发起点=不评）
              if (d.alerts && reqCtx?.requestId && ev.scope === 'request') {
                try {
                  const prq = d.db.prepare('SELECT dispatch_started_at FROM provider_requests WHERE id = ?').get(reqCtx.requestId) as { dispatch_started_at: string | null } | undefined;
                  observeCacheUsage(d.alerts, {
                    db: d.db, windowId: window.id, requestId: reqCtx.requestId,
                    model: reqCtx?.responseModel ?? reqCtx?.requestedModel ?? actualModelForUsage ?? configuredModelForUsage,
                    readTokens: ev.usage.cache_read_input_tokens ?? null,
                    writeTokens: ev.usage.cache_creation_input_tokens ?? null,
                    inputTotal: providerInputTotal({ source: ev.source, input_tokens: ev.usage.input_tokens ?? null,
                      cache_read_input_tokens: ev.usage.cache_read_input_tokens ?? null, cache_creation_input_tokens: ev.usage.cache_creation_input_tokens ?? null }),
                    dispatchStartedAt: prq?.dispatch_started_at ?? null,
                    usageCompleteness: ev.completeness,
                  });
                } catch { /* 观测失败不影响回合记账 */ }
              }
              d.events.publish('usage.updated', {
                conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
                payload: { scope: ev.scope, usage: ev.usage, attempt_id: attempt.id },
              });
              break;
            case 'turn_end':
              if (ev.outcome === 'error' && ev.error_classified === 'route_signal') handleRouteSignal();
              break;
            case 'packet_conflict':
              // F11：同包标识不同载荷——不发布正文，留观测（不落 content 正文——隐私纪律）
              d.logger.warn('sdk_packet_conflict', { turn_id: turnId, code: 'PACKET_PAYLOAD_CONFLICT' });
              break;
            case 'system_notice':
              // F10：结构化 system 事件（只记 subtype/模型，不落 content 正文——隐私纪律）
              d.logger.info('sdk_system_notice', { turn_id: turnId, subtype: ev.subtype, original_model: ev.original_model, fallback_model: ev.fallback_model });
              // EXEC_V1 02 §3 / 05 §2.1（WP2）：SDK 观测到未许可压缩——critical 告警；
              // 只上报事实（policy_conflict 原因另行映射），原文/轨迹不受影响、不自动接管
              if (ev.subtype === 'compact_boundary') {
                try {
                  d.alerts?.observe({
                    code: 'CONTEXT_COMPACTION_UNEXPECTED', scopeKind: 'conversation', scopeId: turn.conversation_id,
                    dedupeKey: `compact:${turnId}`, observationId: `compact:${turnId}`,
                    safeSummary: { title: 'SDK 观测到未许可的上下文压缩', reason: 'sdk_compact_boundary', action_taken: 'alerted_only' },
                    related: { turnId },
                  });
                } catch { /* 告警失败不影响回合 */ }
              }
              if (ev.subtype === 'model_flagged' || ev.subtype === 'model_refusal_fallback' || ev.subtype === 'model_refusal_no_fallback') {
                const actualModel = ev.subtype === 'model_refusal_fallback' ? (ev.fallback_model ?? null) : null;
                try {
                  d.routing.recordSdkRouteEvent({
                    conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
                    subtype: ev.subtype, originalModel: ev.original_model, actualModel,
                    scope: ev.scope ?? 'session', noticeId: ev.notice_id, requestId: ev.request_id,
                  });
                } catch (err) {
                  d.logger.error('route_event_tx_failed', { turn_id: turnId, code: stableCode(err) });
                }
                if (ev.scope === 'local') break;
                if (ev.subtype === 'model_flagged' || ev.subtype === 'model_refusal_no_fallback') {
                  handleRouteSignal({ currentModel: ev.original_model ?? reqCtx?.responseModel ?? reqCtx?.requestedModel ?? null, evidenceCode: 'SDK_FLAGGED' });
                } else if (actualModel) {
                  // 切换已发生：后续生成/工具动作按规格暂停——fence + abort，回合按 interrupted 收口
                  actualModelForUsage = actualModel;
                  fallbackSwitched = true;
                  runToken.token.cancelled = true;
                  runToken.controller.abort();
                }
              }
              break;
            default:
              break;
          }
    };
    const runner = d.runnerSelection.runner;
    let result: import('./runner.ts').RunnerRunResult;
    let orFinalMessages: OrMessage[] | null = null;
    let orLastSentMessages: OrMessage[] | null = null; // F18：实际发送末态（G 边界依据）
    let orToolSeen: ManifestEntry[] = []; // confirmed in a provider request
    let orPendingToolSeen: ManifestEntry[] = [];
    // R2：orEnvelope 恒非空（四类驱动均信封驱动）；保留块作用域
    {
      // EXEC_V1 §03.6（WP3/M2）媒体门：当前输入无转写语音→不空输入唤起模型；
      // 含图但型号未核实视觉→MODEL_VISION_UNAVAILABLE（消息已保存、零模型请求、不静默丢图/换模型）
      const orHasImage = hasAssetImage(orMessages);
      const tailVoiceBlocked = fallbackBuild ? fallbackBuild.hasVoiceWithoutTranscript : tailProjection.hasVoiceWithoutTranscript;
      let mediaBlockedCode: string | null = null;
      if (d.media) {
        if (tailVoiceBlocked) mediaBlockedCode = 'MEDIA_TRANSCRIPTION_FAILED';
        else if (orHasImage && !await this.modelSupportsImages(orEnvelope.model, dv?.kind)) mediaBlockedCode = 'MODEL_VISION_UNAVAILABLE';
      }
      if (mediaBlockedCode !== null) {
        d.logger.warn('media_gate_blocked', { turn_id: turnId, code: mediaBlockedCode, model: orEnvelope.model, has_image: orHasImage });
        result = { outcome: 'error', errorClassified: null, errorCode: mediaBlockedCode, errorMessage: mediaBlockedCode, sessionId: null, requestId: null };
        orFinalMessages = null;
        orLastSentMessages = null;
        orToolSeen = [];
      } else {
      // 最终准入放在异步媒体能力检查之后；失败只删除尚未发送的本轮块。
      // 已发送历史、工具定义与缓存前缀保持原样。
      if (surfacingAugment && d.surfacing?.finalAdmit && inputMessage) {
        try {
          surfacingAugment = await d.surfacing.finalAdmit(surfacingAugment, {
            conversationId: turn.conversation_id, windowId: window.id,
            messageId: inputMessage.id, revision: effective.revision,
          });
        } catch { surfacingAugment = null; }
        if (!surfacingAugment) {
          orEnvelope.messages = orEnvelope.messages.filter(message => !hostMemory.includes(message));
          orEnvelope.boundaries = planBoundaries({ messages: orEnvelope.messages,
            systemMessageCount: fixedSystemCount(orBaseMessages), prevBoundary: orTraj?.lastBoundary ?? null }).boundaries;
        }
      }
      // OR：工具循环（§8.2）——含 grace fence、跨轮 append-only 断言；错误已由循环收口为终态
      const loop = await this.runOrToolLoop({
        envelope: orEnvelope, purpose: 'chat', activeReviewId: null,
        ...(inputMessage ? { inputBinding: { messageId: inputMessage.id, revision: effective.revision } } : {}),
        voiceObservations: tailProjection.observations,
        conversationId: turn.conversation_id, windowId: window.id,
        turnId, attemptId: attempt.id, controller: runToken.controller,
        trajectoryRebuiltThisTurn: trajInitializedThisTurn,
        onEvent: handleEvent, seenSequence: orSeenHighWater,
        seenMessages: orSeenBase, liveSeenAdditions: turnManifestAdditions,
        completionManifest: [
          ...catchupManifest,
          ...(inputMessage ? [{ id: inputMessage.id, revision: effective.revision, seq: inputMessage.sequence, origin: 'dialogue' as const, visible: true }] : []),
        ],
        previousEnvelope: orPreviousPayloadEnvelope,
      });
      result = loop.result;
      orFinalMessages = loop.finalMessages;
      orLastSentMessages = loop.lastSentMessages;
      orToolSeen = loop.toolSeen;
      orPendingToolSeen = loop.pendingToolSeen;
      }
    }
    this.active.delete(turnId);

    // B3（2026-11-04）：SDK 会话衔接诊断日志——resume 决策四值枚举 + 锚生命周期 + 错误安全字段。
    // 只含 ID/哈希口径的计数与状态（AUD-28 同口径：错误证据为白名单标量，无正文/token/key）。
    if (result.resumeDiagnosis) {
      d.logger.info('sdk_resume_decision', {
        turn_id: turnId, attempt_id: attempt.id, window_id: window.id,
        decision: result.resumeDiagnosis.decision,
        anchor_session: result.resumeDiagnosis.anchorSessionId ? (result.resumeDiagnosis.anchorSessionId === result.sessionId ? 'same' : 'changed') : null,
        anchor_msgs: result.resumeDiagnosis.anchorMessageCount ?? null,
        sent_msgs: result.resumeDiagnosis.sentMessageCount ?? null,
        anchor_outcome: result.resumeDiagnosis.anchorOutcome ?? null,
        outcome: result.outcome, error_code: result.errorCode,
      });
    }
    if (result.errorCode && result.errorEvidence) {
      // 日志字段为标量合同：安全证据逐键展开（evidence 本身已是白名单标量键）
      d.logger.warn('sdk_error_evidence', { turn_id: turnId, attempt_id: attempt.id, code: result.errorCode, ...result.errorEvidence });
    }
    // B4：一次性程序事实核销——本 attempt 有真实派发证据即核销（模型已见过该事实；
    // 失败/中断但不曾派发=保留待下一轮重试，不丢事实也不重复发送）。D05/D06 同口径。
    if (pendingFacts.length > 0 && d.db.prepare('SELECT 1 FROM provider_requests WHERE attempt_id=? AND dispatch_started_at IS NOT NULL LIMIT 1').get(attempt.id)) {
      const consumeNow = new Date().toISOString();
      tx(d.db, () => {
        d.db.prepare(`UPDATE pending_program_facts SET consumed_at=? WHERE id IN (${pendingFacts.map(() => '?').join(',')}) AND consumed_at IS NULL`)
          .run(consumeNow, ...pendingFacts.map((f) => f.id));
      });
    }

    // A native SDK turn can consume tools before a later subscription rejection.
    // Preserve that actual protocol work so the next OR turn cannot replay it.
    // C03（四仓审计 20261106）：OR 工具轮失败同样保留已发协议（failedLoop 现在对
    // 普通轮也给出 finalMessages）——续轮 503/失败后，下一普通输入接续已发前缀与
    // 真实工具结果，未执行工具以显式记录收尾，不重放副作用。
    if (result.outcome !== 'completed' && orFinalMessages && d.trajectory && (dv?.kind === 'claude-agent-sdk' ? result.activityStarted : true)) {
      if (!runToken.token.cancelled) publishSegments([segmenter.flushTail()].filter(Boolean) as string[]);
      const base = d.trajectory.forWindow(window.id)?.manifest ?? [];
      const input: ManifestEntry[] = inputMessage ? [{ id: inputMessage.id, revision: effective.revision, seq: inputMessage.sequence, origin: 'dialogue', visible: true }] : [];
      const pending = orPendingToolSeen.map(entry => ({ ...entry, visible: false, pending_dispatch: true as const }));
      d.trajectory.replace(window.id, orFinalMessages, tailBoundaryOf(orLastSentMessages ?? orFinalMessages),
        [...base, ...catchupManifest, ...input, ...turnManifestAdditions, ...orToolSeen, ...pending]);
    }

    // session 绑定（AUD-03）：首轮把观察到的 session 持久化到窗口（bindSession 的
    // WHERE sdk_session_id IS NULL 使 resume 轮天然幂等）；fresh_session 重跑完成后
    // 改绑新 session（旧 session 因含被替代输入而弃用）
    if (result.sessionId) {
      if (attempt.fresh_session) d.windows.rebindSession(window.id, window.sdk_session_id, result.sessionId);
      else d.windows.bindSession(window.id, result.sessionId);
    }

    const now = new Date().toISOString();
    // —— 确定性终态（AUD-10/25）——
    if (runToken.token.cancelled && routeSignalHandled) {
      segmenter.drop();
      if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
      return; // handleRouteSignal 已发布实际终态；再次 flag 的 failed 不被 pending 覆盖。
    }
    if (runToken.token.cancelled || result.outcome === 'interrupted') {
      segmenter.drop();
      d.reasoning.markAttemptFinal({ attemptId: attempt.id, final: 'interrupted', generation });
      if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
      tx(d.db, () => {
        // F10：SDK 观测到模型切换后的暂停——如实标注原因，与用户主动停止区分
        d.db.prepare("UPDATE attempts SET state = 'interrupted', blocked_reason = ?, completed_at = ? WHERE id = ?")
          .run(fallbackSwitched ? 'MODEL_FALLBACK_SWITCHED' : null, now, attempt.id);
        d.db.prepare("UPDATE turns SET state = 'interrupted', completed_at = ? WHERE id = ?").run(now, turnId);
      });
      d.events.publish('turn.interrupted', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, payload: { generation, ...(fallbackSwitched ? { reason: 'MODEL_FALLBACK_SWITCHED' } : {}) } });
      // ALB-08（审计 2026-11-08，R23"投递后停止不恢复一次设置"）：被停止/中断的回合若
      // 本窗的 chat 请求已实际发出（sent_at 非空），携带图与留言已被模型收到——
      // next_once 照常消费，不因停止复活为待带入。
      const delivered = d.db.prepare("SELECT 1 FROM provider_requests WHERE window_id = ? AND purpose = 'chat' AND sent_at IS NOT NULL AND outcome IS NOT 'SUPERSEDED_BY_RETRY' LIMIT 1").get(window.id);
      if (delivered) {
        void this.consumeCarryNextOnceOnSuccess(window.id).catch(() => undefined);
        this.d.archives?.confirmNoticesDelivered(pendingNoticeBatch.map((n) => n.id)); // ALB-11：已投递即收口
      }
      return;
    }
    if (result.outcome === 'error' || result.outcome === 'no_final_result') {
      segmenter.drop();
      d.reasoning.markAttemptFinal({ attemptId: attempt.id, final: 'failed', generation });
      if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
      const reasonCode = result.outcome === 'no_final_result' ? 'NO_FINAL_RESULT' : (result.errorCode ?? 'RUNNER_ERROR');
      // ALB-11：错误收尾但请求可能已实际发出（部分投递）——有证据即收口，无证据保持待发
      const errDelivered = d.db.prepare('SELECT 1 FROM provider_requests WHERE turn_id = ? AND sent_at IS NOT NULL LIMIT 1').get(turnId);
      if (errDelivered) this.d.archives?.confirmNoticesDelivered(pendingNoticeBatch.map((n) => n.id));
      const blockedReason = `${reasonCode}:${result.errorClassified ?? 'unknown'}`;
      tx(d.db, () => {
        d.db.prepare('UPDATE attempts SET state = ?, blocked_reason = ?, completed_at = ? WHERE id = ?').run('failed', blockedReason, now, attempt.id);
        d.db.prepare('UPDATE turns SET state = ?, completed_at = ? WHERE id = ?').run('failed', now, turnId);
      });
      // DBG-01（包2 2026-11-16）：失败事件带上脱敏的具体原因与证据字段（旧实现只发错误码，
      // errorMessage/errorEvidence 全程未发布——前端拿不到"为什么"）。detail 有界；证据沿
      // runner 白名单口径（不含消息正文/凭据）。
      const failDetail = (result.errorMessage ?? '').slice(0, 200) || null;
      d.events.publish('turn.status', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id, payload: { state: 'failed', reason: reasonCode, ...(failDetail ? { detail: failDetail } : {}), ...(result.errorEvidence ? { evidence: result.errorEvidence } : {}) } });
      d.logger.warn('attempt_failed', { turn_id: turnId, attempt_id: attempt.id, code: reasonCode });
      return;
    }

    // Already published segments survive a deliberate finish. Do not publish
    // an uncommitted trailing segment as an automatic final reply.
    if (readTurnCompletion(d.db, attempt.id, turnId)) segmenter.drop();
    else publishSegments([segmenter.flushTail()].filter(Boolean) as string[]);
    d.reasoning.markAttemptStreamEnded({ attemptId: attempt.id }); // 仍 streaming 的块 → complete/stream_only（无完整块核对，不伪装已核对）
    if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
    const markCompleted = (conn: Db): void => {
      conn.prepare("UPDATE attempts SET state = 'completed', completed_at = ?, completion_recovery_json=NULL WHERE id = ?").run(now, attempt.id);
      conn.prepare("UPDATE turns SET state = 'completed', completed_at = ? WHERE id = ?").run(now, turnId);
    };
    // §2.2/§7：成功回合才推进协议轨迹（append-only）+ 实际已见 manifest（F06：本轮输入与
    // 已发布助手消息入清单——下一轮范围/书签从这份证据出发）；新已发送边界=本轮末 text 块
    if (orFinalMessages !== null && d.trajectory) {
      const baseManifest = d.trajectory.forWindow(window.id)?.manifest ?? [];
      const inputEntry: ManifestEntry[] = inputMessage
        ? [{ id: inputMessage.id, revision: effective.revision, seq: inputMessage.sequence, origin: 'dialogue', visible: true }]
        : [];
      // Provider protocol state is retained verbatim in the protected trajectory.
      // Existing historical messages are never rewritten or backfilled.
      const trajMessages = orFinalMessages;
      // F18：G 候选=本轮实际发送的最后一个 text 块（生成的最终 assistant 尚未随任何请求发出，
      // 不得作为"已发送边界"；它将在下一轮真实发送后才成为候选）
      const boundaryBase = orLastSentMessages ?? orFinalMessages;
      const pending = orPendingToolSeen.map(entry => ({ ...entry, visible: false, pending_dispatch: true as const }));
      d.trajectory.replace(window.id, trajMessages, tailBoundaryOf(boundaryBase),
        [...baseManifest, ...catchupManifest, ...inputEntry, ...turnManifestAdditions, ...orToolSeen, ...pending], markCompleted);
      // 自动浮现：成功轨迹落正本后 retain（真实 manifest 确认，不是入库 ready
      // 就算送达——docs/04 retained 语义）；失败回合不假标 coverage。
      if (surfacingAugment) d.surfacing?.markRetained(surfacingAugment);
    } else {
      tx(d.db, () => markCompleted(d.db));
    }
    // 初始携带及到期通知按实际请求成功事实收口。
    void this.consumeCarryNextOnceOnSuccess(window.id).catch(() => undefined);
    this.d.archives?.confirmNoticesDelivered(pendingNoticeBatch.map((n) => n.id));
    d.events.publish('turn.completed', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, payload: { generation, session_id: result.sessionId } });
    // 原文线：助手气泡已正式发布 → 同步 drain（独立于模型结果；失败不影响 turn 终态）
    void d.archiveSync?.drainOnce().catch((err) => {
      d.logger.warn('archive_sync_after_turn_failed', { turn_id: turnId, code: stableCode(err) });
    });
  }

  // 决议后重新驱动房间（AUD-05/36/37）：waiting 已被决议事务释放为 pending；此处入队全部可跑 turn
  requeueConversationQueuedTurns(conversationId: string): void {
    const rows = this.d.db
      .prepare("SELECT t.id FROM turns t JOIN attempts a ON a.turn_id = t.id AND a.state IN ('pending','ready_after_route') WHERE t.conversation_id = ? AND t.state = 'pending'")
      .all(conversationId) as Array<{ id: string }>;
    for (const r of rows) this.enqueue(r.id);
  }

  // AUD-15/37（§9）：启动调度恢复——数据库是真源，committed-but-not-dispatched 一律重新入队
  private blockAttempt(attemptId: string, turnId: string, conversationId: string, reason: string, turnState: 'blocked' | 'route_owner_pending'): void {
    const now = new Date().toISOString();
    tx(this.d.db, () => {
      this.d.db.prepare("UPDATE attempts SET state = ?, blocked_reason = ?, completed_at = ? WHERE id = ?").run(turnState === 'route_owner_pending' ? 'route_owner_pending' : 'blocked', reason, now, attemptId);
      this.d.db.prepare('UPDATE turns SET state = ?, completed_at = ? WHERE id = ?').run(turnState, now, turnId);
    });
    this.d.events.publish('turn.status', { conversationId, turnId, attemptId, entityRef: attemptId, payload: { state: turnState, reason } });
    this.d.logger.warn('attempt_blocked', { turn_id: turnId, attempt_id: attemptId, code: reason.split(':')[0] });
  }

  private failTurnQuietly(turnId: string, code: string): void {
    const now = new Date().toISOString();
    try {
      tx(this.d.db, () => {
        const att = this.d.db.prepare("SELECT id FROM attempts WHERE turn_id = ? AND state IN ('running','pending')").get(turnId) as { id: string } | undefined;
        // RE-03：pending（排队期被取消，从未获得执行权）同样落确定终态
        this.d.db.prepare("UPDATE turns SET state = 'failed', completed_at = ? WHERE id = ? AND state IN ('running','pending')").run(now, turnId);
        if (att) {
          this.d.db.prepare("UPDATE attempts SET state = 'failed', blocked_reason = ?, completed_at = ? WHERE id = ?").run(code, now, att.id);
          this.d.db.prepare("UPDATE reasoning_blocks SET state = 'failed', updated_at = ? WHERE attempt_id = ? AND state = 'streaming'").run(now, att.id);
        }
      });
    } catch {
      // 尽力收尾
    }
  }
}

function stableCode(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  if (/SQLITE|constraint|UNIQUE/i.test(msg)) return 'DB_ERROR';
  if (/ENOSPC|disk/i.test(msg)) return 'DISK_ERROR';
  return 'INTERNAL_ERROR';
}

/**
 * WAKE_KEEPWARM_V1 §09（B-01）：单次模型请求的保守费用上界（微美元整数）。
 * 上界组成：全部输入按未命中最坏写入价（1h TTL 公开溢价=2×input 价；价格配置若显式
 * 给出 cache_write_micro_per_token 则优先）+ 本次请求实际配置的最大输出。不把全部输入
 * 同时按普通 input 与 cache write 重复计费（按最坏单一分区）。价格缺失返回 null
 * （调用方 recordDispatch 前被 BUDGET_ESTIMATE_UNAVAILABLE 拦截——09：无报价=明确
 * blocked，不自填价格或放行）。
 */

function codeOf(reason: string): string {
  const m = /^([A-Z_]+)[:：]/.exec(reason);
  return m ? m[1]! : reason.split(/[：:;（(]/)[0]!.slice(0, 30);
}

/** Preserve opaque provider state for new assistant messages; never expose it as UI text. */
function assistantProtocolMessage(text: string, result: import('./runner.ts').RunnerRunResult, driver?: string): OrMessage {
  const message: OrMessage = { role: 'assistant', content: [{ type: 'text', text }] };
  if (driver === 'deepseek' && typeof result.reasoningContent === 'string') message.reasoning_content = result.reasoningContent;
  if (driver === 'openrouter' && result.reasoningFrames?.length) message.reasoning_details = result.reasoningFrames.flatMap(f => Array.isArray(f) ? f : [f]);
  return message;
}

function hasAssetImage(messages: OrMessage[]): boolean {
  return messages.some(message => Array.isArray(message.content) && message.content.some(block => block?.type === 'asset_image'));
}

function hasStorageImageRedaction(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasStorageImageRedaction);
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  return object.data_redacted === true || Object.values(object).some(hasStorageImageRedaction);
}

/** Old DS releases stripped opaque reasoning when committing a tool turn.
 * Recognize only that exact historical gap; all other drift still reaches the
 * strict driver's HISTORY_CHANGED guard. Never rewrite or backfill old bytes. */
function legacyDsReasoningGap(previous: Record<string, unknown>, current: Record<string, unknown>): boolean {
  for (const key of ['model', 'session_id', 'provider', 'tools']) {
    if (JSON.stringify(previous[key] ?? null) !== JSON.stringify(current[key] ?? null)) return false;
  }
  if (!Array.isArray(previous.messages) || !Array.isArray(current.messages) || current.messages.length < previous.messages.length) return false;
  let missing = false;
  for (let index = 0; index < previous.messages.length; index++) {
    const before = previous.messages[index] as Record<string, unknown>;
    const after = current.messages[index] as Record<string, unknown>;
    if (before?.role === 'assistant' && typeof before.reasoning_content === 'string' && after?.reasoning_content === undefined) {
      const { reasoning_content: _opaque, ...rest } = before;
      if (JSON.stringify(rest) !== JSON.stringify(after)) return false;
      missing = true;
    } else if (JSON.stringify(before) !== JSON.stringify(after)) return false;
  }
  return missing;
}
