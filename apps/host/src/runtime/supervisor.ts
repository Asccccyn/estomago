import { selectionGuides } from '../context/selection-projection.ts';
import type { RotationCause } from '../context/manual-selection.ts';
import { supportsSurfacingTransport, surfaceTransportMessage } from '../memory-surfacing/contracts.ts';
import { resolveReasoningReplayPolicy, storedReasoningReplayPolicy, type ReasoningReplayPolicy } from './ds-replay-policy.ts';
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
import { buildSdkOptions } from './build-options.ts';
import type { RunnerSelection } from './runner.ts';
import type { ReasoningService } from '../reasoning/service.ts';
import type { UsageCollector } from '../usage/collector.ts';
import type { RoutingService } from '../routing/service.ts';
import type { WindowManager } from '../windows/manager.ts';
import type { Logger } from '../observability/logging.ts';
import { buildTimeContext, modelTimeContextText } from '../time/context.ts';
import { contextFingerprint } from '../identity/service.ts';
import { assembleContext } from '../context/assembler.ts';
import { FIXED_RUNTIME_FRAGMENT, HOST_BOUNDARY_RULES } from '../context/fixed-runtime.ts';
import { buildPreRotateReviewMessage } from '../context/review-prompts.ts';
import { rotationPlan, selectReviewRange, rawKey, type ManifestEntry } from '../context/review-policy.ts';
import type { RotationReviewService } from '../context/rotation-review.ts';
import type { HoldCheckpointService } from '../memory/hold-checkpoint.ts';
import { orSessionId } from './runner-openrouter.ts';
import { dsSessionId, buildDeepSeekPayload } from './runner-deepseek.ts';
import { buildOrPayload, withoutCacheMarkers, type OrMessage } from './or-payload.ts';
import { planBoundaries, tailBoundaryOf, fixedSystemCount } from './cache-plan.ts';
import { contextFingerprintJson } from './context-fingerprint.ts';
import type { WindowTrajectoryService } from './window-trajectory.ts';
import { buildDeferredTools, freezeWindowTools, effectiveToolName } from './tool-discovery.ts';
import { buildHostTools, hostToolNames, type HostToolExecutor, type ToolExecContext, type ToolExecResult } from './host-tools.ts';
import type { OrRequestEnvelope, RunnerPurpose } from './runner.ts';
import type { MatchedCompleteBlock } from '../../../../packages/contracts/src/sdk-events.ts';
import { TextSegmenter } from '../output/segments.ts';
import { sha256Hex, genId } from '../util/id.ts';
import { bootstrapCall, completeBootstrapPages, BootstrapPagingError, globalBootstrapFailure, retryableBootstrapFailure, type BootstrapGap } from '../integrations/mariposa/bootstrap-pages.ts';
import type { WishstarClient } from '../integrations/wishstar/client.ts';
import { buildPaths, resolveStateRoot } from '../config/paths.ts';
import { observeCacheUsage } from './cache-observation.ts';
import { lastCacheEvidence } from './cache-observation.ts';
import { renderInitialVisibleText } from './tool-initial-visible.ts';
import { ConversationActivityService } from './wake-activity.ts';
import { keepwarmSleepState } from './keepwarm-sleep.ts';
import { settleBackgroundDispatch, settleBackgroundRun } from './background-ledger.ts';
import type { BackgroundToolQuote } from './background-tool-cost.ts';
import { estimateModelRequestCostMicroUsd } from './model-request-cost.ts';
import { ContractError } from './or-contract.ts';
import { projectRevisionBlocks, materializeEnvelope, redactImageBlocksForStorage, visionSupportCached, refreshVisionSupport } from '../media/model-input.ts';
import { storedToolset } from './tool-discovery.ts';

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
  wishstar?: Pick<WishstarClient, 'upcoming'> | null; // 许愿星（开窗临近纪念日提醒；未注入则无此行）
  tools?: HostToolExecutor; // OR 工具执行（memory_hold / context_review_complete；未注入则工具循环不可用）
  reviews?: RotationReviewService;
  checkpoint?: HoldCheckpointService;
  trajectory?: WindowTrajectoryService; // §2.2/§7：每窗 append-only 协议轨迹（缓存断点 G 与跨轮断言依据）
  supervisor?: TurnSupervisor; // 启动恢复重派用（recoverSchedule 静态方法无 this；实例注入后才可 enqueue）
  selections?: import('../context/manual-selection.ts').ManualSelectionService; // WP3（2026-10-08）：人工历史选集——新窗历史携带的唯一来源
  // WP5（2026-10-08）：DS 昨天日结整链退役（digest 依赖已删；历史证据不篡改）
  settings?: import('./runtime-settings.ts').RuntimeSettingsService; // 2026-10-08 她裁定：聊天窗换模型/推理等级（override 持久正本）
  alerts?: import('../observability/system-alerts.ts').SystemAlertService; // EXEC_V1 WP2：缓存观测/压缩异常告警（未注入则观测静默跳过）
  media?: import('../media/assets.ts').MediaService; // EXEC_V1 WP3：媒体投影/物化（未注入=纯文本路径零变化）
  // JOINT-VOICE-20261022（04）：oído 听觉可用（=配置声明：integrations.oido 已配凭据）。
  // true 时当前输入无转写语音以结构化引用进入模型（可调 oido_analyze）；未注入/false 保持阻断语义。
  oidoHearing?: boolean;
  // WAKE_KEEPWARM_V1（2026-10-22）：真实活动锚点投影（L/维护回执 CAS）。
  activity?: ConversationActivityService;
  // WAKE_KEEPWARM_V1：后台派发让位检查（用户消息到来→心跳在安全边界让位，S-06）
  keepwarmYieldCheck?: (runId: string) => boolean;
  /** WAKE_KEEPWARM_V1：可注入时钟（后台执行位重检/迟到判定用；测试虚拟推进）。 */
  now?: () => number;
  // 自动浮现（EST_MARIPOSA_AUTO_SURFACING_V1 · WP5）：装配期有界复核+冻结注入块。
  // 未注入=零变化；supervisor 只持薄接口，策略全在 memory-surfacing/service.ts。
  surfacing?: {
    augmentFor(input: import('../memory-surfacing/service.ts').AugmentInput): Promise<import('../memory-surfacing/service.ts').AugmentResult | null>;
    reuseFrozen(attemptId: string): import('../memory-surfacing/service.ts').AugmentResult | null;
    finalAdmit?(r: import('../memory-surfacing/service.ts').AugmentResult, input: {
      conversationId: string; windowId: string; messageId: string; revision: number;
    }): Promise<import('../memory-surfacing/service.ts').AugmentResult | null>;
    cancelForTurn?(turnId: string): void;
    markDispatched?(attemptId: string): void;
    markRetained(r: import('../memory-surfacing/service.ts').AugmentResult): void;
  };
};

/** JOINT-VOICE（自审修复）：听觉可用=配置声明 AND 本窗冻结工具目录含 oido_analyze。
 *  旧窗目录冻结（A05 合同：不动态膨胀破缓存）没有 oido 工具——此时引导调用会
 *  TOOL_NOT_IN_WINDOW，误导模型；退回阻断语义（转写未就绪明确报错）更诚实。
 *  无冻结记录的新窗=当前目录（buildHostTools 含 oido_analyze）。 */
export function oidoHearingAvailable(db: import('../db/connection.ts').Db, configured: boolean, windowId: string | null | undefined): boolean {
  if (!configured || !windowId) return false;
  const set = storedToolset(db, windowId);
  if (set && !set.catalog.some((tool) => tool.function.name === 'oido_analyze')) return false;
  return true;
}

const RUNNER_GRACE_MS = 5000; // §11：不合作 runner 的强制终态宽限
const MAX_TOOL_ROUNDS = 8; // §8.2：工具续请求有界（防循环收费；超限按错误收口，允许恢复）
// §3.3 有界恢复（2026-10-05 审计 P2-1）：同窗评审失败达上限后不再自动付费评审——
// 恢复路径=评审成功换新窗（新窗计数重置）或人工处理后手动换窗；防"模型永不调用 complete"时每条消息都付费评审。
const MAX_WINDOW_REVIEW_ATTEMPTS = 3;
// R10（复审 2026-10-07）：bootstrap 受控截止时间——准备阶段不无限挂起
const BOOTSTRAP_DEADLINE_MS = 8000;

/** 信封驱动（OR / DS 直连共用消息轨迹与工具循环管线；SDK/mock 走 prompt 路径） */
export const isEnvelopeDriverKind = (kind: string): kind is 'openrouter' | 'deepseek' =>
  kind === 'openrouter' || kind === 'deepseek';

type ActiveRun = {
  token: { cancelled: boolean };
  controller: AbortController;
  generation: number;
};

export class TurnSupervisor {
  private d: SupervisorDeps;
  private chains = new Map<string, Promise<unknown>>(); // F-J-31：runSerialized 链尾 Promise<T|void> 存迹，只 await 不读值
  private active = new Map<string, ActiveRun>(); // key = turnId
  // F-J-09（联合审计 2026-10-06）：工具 schema/顺序按 epoch（窗口）冻结——
  // 同窗续请求 tools 恒定（§7.1）；词表刷新只影响新窗快照。进程内缓存；
  // 重启后同窗首发的快照重建（跨重启的前缀漂移只影响缓存命中，不影
  // 响正确性——新窗在换窗时取新快照）。
  private frozenToolsByWindow = new Map<string, import('./or-payload.ts').OrTool[]>();
  // D2（她批准 2026-10-06）：本窗 Mariposa 开窗资料快照（缓存点 B）——
  // 首个信封前取一次并冻结（§5.2/§7.1：B 只冻结这一窗的输入快照，权限
  // 撤销/关键身份更正例外走既有安全换窗）。取不到=如实降级不带 B（事件
  // 记录），不阻塞聊天、不伪造"记忆已恢复"。
  private bootstrapByWindow = new Map<string, string>();

  constructor(d: SupervisorDeps) {
    this.d = d;
  }

  enqueue(turnId: string): void {
    const conv = this.d.db.prepare('SELECT conversation_id FROM turns WHERE id = ?').get(turnId) as { conversation_id: string } | undefined;
    if (!conv) return;
    this.runSerialized(conv.conversation_id, async () => {
      if (this.cancelledBeforeRun.delete(turnId)) {
        // RE-03：排队期已 stop——不派发，落确定终态（订阅者可见失败收口）
        this.d.events.publish('turn.status', { conversationId: conv.conversation_id, turnId, scope: 'private', payload: { state: 'failed', reason: 'CANCELLED_BEFORE_DISPATCH' } });
        this.failTurnQuietly(turnId, 'CANCELLED_BEFORE_DISPATCH');
        this.voiceTaps.delete(turnId);
        return;
      }
      try {
        await this.runTurn(turnId);
      } catch (err) {
        // AUD-10：链条内崩溃不留悬挂——该 turn 落 failed 终态
        // 整合（2026-10-24）：合同化守卫（wire 锚/append-only/政策窗）在主流程 throw 的
        // 结构化错误码透传到 attempt（此前一律 RUNNER_CRASHED，测试与排障分不清类型）
        const raw = String((err as Error).message ?? err);
        const contractCode = /^(WIRE_TRAJECTORY_DIVERGED|WIRE_HISTORY_SHORTENED|HISTORY_CHANGED|HISTORY_SHORTENED|PREFIX_PROFILE_CHANGED|DS_PROTOCOL_HISTORY_REQUIRES_NEW_WINDOW)/.exec(raw)?.[1];
        this.d.logger.error('turn_crashed', { turn_id: turnId, code: stableCode(err), ...(contractCode ? { contract_code: contractCode } : {}) });
        this.failTurnQuietly(turnId, contractCode ?? 'RUNNER_CRASHED');
      } finally {
        this.voiceTaps.delete(turnId); // RE-02：回合收口即撤抽头（完成/失败/中断同规则）
      }
    });
  }

  /** 拒接/取消留言调度（2026-10-24）：程序事实轮——宿主注入事实（她拒接了你的来电/你取消了自己的来电），
   *  不是用户发言（不写 messages）；走同一串行链与正常发布链，char的回应落本会话。
   *  dedupe_key（invite+action）幂等：前端重试/重复触发只跑一轮。 */
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

  /** 审计 F05：房间唯一串行链的通用入口——turn、自动评审、手动换窗共用同一互斥；
   *  前序任务失败不阻断后续（fn 总被执行），返回值/异常原样传给调用方。 */
  private runSerialized<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(conversationId) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const next = result.catch(() => {}).finally(() => {
      if (this.chains.get(conversationId) === next) this.chains.delete(conversationId);
    });
    this.chains.set(conversationId, next);
    return result;
  }

  async waitIdle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /** RE-03（2026-10-24 返修）：排队取消登记——尚未获得串行链的 turn 被 stop 时记录，
   *  链到达时不再派发（上轮反例：断开的排队电话轮在前序释放后仍派发模型） */
  private cancelledBeforeRun = new Set<string>();

  /** RE-02（2026-10-24 返修）：语音正文抽头——同一生成流（publishText 的真实新增 tail，
   *  与聊天落库同源）逐段供给 voice ingress；不经公共事件总线（不进 SSE/UI 面）。
   *  取消后代际内不再供给（与 publishSegments 同一 fence）。 */
  private voiceTaps = new Map<string, (text: string) => void>();
  registerVoiceTap(turnId: string, onTap: (text: string) => void): () => void {
    this.voiceTaps.set(turnId, onTap);
    return () => { this.voiceTaps.delete(turnId); };
  }

  stop(turnId: string): { stopped: boolean; generation: number | null } {
    const run = this.active.get(turnId);
    if (!run) {
      // 排队中（无活动代）：登记取消；链到达即拒发。若 turn 已完成/从未入队，无害空集。
      const queued = this.d.db.prepare("SELECT 1 FROM turns WHERE id = ? AND state IN ('queued','running','pending')").get(turnId);
      if (queued) {
        this.cancelledBeforeRun.add(turnId);
        return { stopped: true, generation: null };
      }
      return { stopped: false, generation: null };
    }
    this.d.surfacing?.cancelForTurn?.(turnId);
    run.token.cancelled = true; // generation fence：迟到 chunk 一律丢弃
    run.controller.abort(); // 同时触发 await 处的 grace 计时（§11：不合作 runner 的有界终止）
    return { stopped: true, generation: run.generation };
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

  // AUD-10/38（§10）+ D03（审计 3655d60）：启动恢复——孤儿 running/streaming/PREPARING/无票据 waiting 全部落确定状态，不重跑模型；
  //   active 评审无执行者（宿主重启即失主）→ failed（下次换窗按上限内有界重开评审，先做 unknown 写恢复）；
  //   running 写操作 → hold 记 unknown（可按 operation_id 恢复探测），本地类（review_complete 等）→ failed_resolved。
  static recoveryPass(db: Db, logger: { warn: (e: string, f: Record<string, unknown>) => void }): { turns: number; attempts: number; blocks: number; staleWindows: number; releasedWaiting: number; failedOwners: number; staleReviews: number; orphanEffects: number } {
    const now = new Date().toISOString();
    const turns = tx(db, () => Number(db.prepare("UPDATE turns SET state = 'failed', completed_at = ? WHERE state IN ('running') AND completed_at IS NULL").run(now).changes));
    const attempts = tx(db, () => Number(db.prepare("UPDATE attempts SET state = 'failed', blocked_reason = 'RECOVERY_HOST_RESTART', completed_at = ? WHERE state IN ('running')").run(now).changes));
    const blocks = tx(db, () => Number(db.prepare("UPDATE reasoning_blocks SET state = 'failed', updated_at = ? WHERE state = 'streaming'").run(now).changes));
    // 孤儿 candidate 窗口（AUD-38）：PREPARING 悬挂 → 终态 BLOCKED
    const staleWindows = tx(db, () => Number(db.prepare("UPDATE windows SET status = 'BLOCKED', blocked_reason = 'RECOVERY_ORPHAN_CANDIDATE', updated_at = ? WHERE status = 'PREPARING'").run(now).changes));
    // waiting_route_gate 但房间已无 pending 票据 → 释放回 pending（可被调度恢复接管）
    const releasedWaiting = tx(db, () => Number(db.prepare(
      `UPDATE attempts SET state = 'pending', blocked_reason = NULL
       WHERE state = 'waiting_route_gate'
         AND turn_id IN (SELECT t.id FROM turns t WHERE NOT EXISTS (
           SELECT 1 FROM route_decisions rd WHERE rd.conversation_id = t.conversation_id AND rd.state = 'pending'))`,
    ).run().changes));
    // route_owner_pending 但票据已消失（被并发消费后崩溃等）→ failed（防悬挂 owner）
    const failedOwners = tx(db, () => Number(db.prepare(
      `UPDATE attempts SET state = 'failed', blocked_reason = 'RECOVERY_ORPHAN_ROUTE_OWNER', completed_at = ?
       WHERE state = 'route_owner_pending'
         AND NOT EXISTS (SELECT 1 FROM route_decisions rd WHERE rd.attempt_id = attempts.id AND rd.state = 'pending')`,
    ).run(now).changes));
    // D03a：无执行者的 active 评审 → failed（重启后没有任何协程会收口它；不伪造完成凭证）
    const staleReviews = tx(db, () => Number(db.prepare("UPDATE rotation_reviews SET status = 'failed', updated_at = ? WHERE status = 'active'").run(now).changes));
    // D03b：崩溃遗留 running 写操作——hold 类结果不明（可按 operation_id 探测恢复），本地类可判未提交
    const orphanEffects = tx(db, () => Number(db.prepare(
      "UPDATE tool_side_effects SET state = CASE WHEN kind = 'hold' THEN 'unknown' ELSE 'failed_resolved' END, updated_at = ? WHERE state = 'running'",
    ).run(now).changes));
    const total = turns + attempts + blocks + staleWindows + releasedWaiting + failedOwners + staleReviews + orphanEffects;
    if (total > 0) logger.warn('recovery_pass', { turns, attempts, blocks, staleWindows, releasedWaiting, failedOwners, staleReviews, orphanEffects, code: 'RECOVERY_HOST_RESTART' });
    return { turns, attempts, blocks, staleWindows, releasedWaiting, failedOwners, staleReviews, orphanEffects };
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
    runId: string;
    conversationId: string;
    payload: Record<string, unknown>;
    isCancelRequested: () => boolean;
    registerAbort: (c: AbortController) => void;
    recordDispatch: (info: { logicalActionKey: string; attemptNo: number; dispatchKind: 'model' | 'tool'; reservedCostMicroUsd: number; capabilityName?: string }) => { allowed: boolean; dispatchId: string; code?: string };
    maxModelRequests: number;
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
    const taskRow = d.db.prepare('SELECT revision, enabled, control_reason, payload_json FROM background_tasks WHERE id = ?').get(runRow.task_id) as { revision: number; enabled: number; control_reason: string | null; payload_json: string } | undefined;
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
    let capturedActivityRevision: number | null = null;
    // —— 心跳专属派发门（05 §派发门与异常；执行位内重算，不用 tick 快照）——
    if (opts.kind === 'keepwarm') {
      const act = d.activity?.get(opts.conversationId) ?? null;
      if (!act || act.last_real_activity_at === null) return { outcome: 'noop', result_code: 'KEEPWARM_NO_REAL_ACTIVITY' };
      if (runRow.input_activity_revision !== null && runRow.input_activity_revision !== act.activity_revision) {
        return { outcome: 'noop', result_code: 'KEEPWARM_SUPERSEDED', detail: '新真实消息已使本维护候选失效' };
      }
      const target = d.activity!.nextKeepwarmTarget({ conversationId: opts.conversationId, windowId: window.id });
      if (target.scheduled && this.nowMs() < target.dueAtMs) return { outcome: 'noop', result_code: 'KEEPWARM_SUPERSEDED', detail: '目标已被新证据推后' };
      const evidence = lastCacheEvidence(d.db, window.id);
      if (evidence === null) return { outcome: 'noop', result_code: 'KEEPWARM_CACHE_EVIDENCE_UNKNOWN', detail: '无已确认缓存证据——保温不冷启动' };
      if (this.nowMs() - Date.parse(evidence.startedAt) >= 3_600_000) return { outcome: 'noop', result_code: 'KEEPWARM_CACHE_ALREADY_COLD', detail: '缓存估计已冷——不补冷写' };
      // 05 satisfied_by_request：同机会内一次真实请求已实际刷新有效缓存（自主唤醒/普通
      // 聊天）→ 本维护机会记技术回执进入后继，不重复付费。
      const prq = d.db.prepare('SELECT purpose FROM provider_requests WHERE id = ?').get(evidence.requestId) as { purpose: string } | undefined;
      const L = Date.parse(act.last_real_activity_at);
      const refreshedByOther = prq && prq.purpose !== 'cache_keepalive' && Date.parse(evidence.startedAt) >= L && (this.nowMs() - Date.parse(evidence.startedAt)) < 3_000_000;
      if (refreshedByOther) {
        d.activity!.noteMaintenanceReceipt({ conversationId: opts.conversationId, capturedActivityRevision: act.activity_revision, requestId: evidence.requestId, windowId: window.id, dispatchStartedAtIso: evidence.startedAt });
        return { outcome: 'noop', result_code: 'satisfied_by_request', detail: '同机会缓存已由真实请求刷新——本维护机会不重复付费' };
      }
      capturedActivityRevision = act.activity_revision;
    }

    // —— 尾部 host 事件（05/04：宿主事件口径，不伪造用户消息；一次冻结，续轮不重生成）——
    let tailNote: string;
    if (opts.kind === 'keepwarm') {
      tailNote = 'Cache keepalive (host event, not Qiaosheng). Reply 1 by default; you may choose otherwise and use available tools.';
    } else {
      const mergedPayload = { ...JSON.parse(taskRow.payload_json) as Record<string, unknown>, ...opts.payload };
      const note = typeof mergedPayload.note === 'string' ? mergedPayload.note : '';
      const scheduledFor = typeof mergedPayload.scheduled_for === 'string' ? mergedPayload.scheduled_for : null;
      if (note.length > 8000) return { outcome: 'failed', result_code: 'WAKE_NOTE_INVALID', detail: '预约正文超长——报错不静默截断' };
      const lines = ['[Host self-wake; not a message from Qiaosheng]'];
      if (scheduledFor) lines.push(`Scheduled for: ${scheduledFor}`);
      lines.push(`Your note: ${note.length > 0 ? note : '(none)'}`);
      if (scheduledFor && Date.parse(scheduledFor) + 60_000 < this.nowMs()) {
        lines.push(`Actual delivery: ${nowIso0} (late)`);
      }
      lines.push('You may use available tools and choose whether to speak.');
      tailNote = lines.join('\n');
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
      tools: this.windowTools(window.id), // 同一冻结快照（06 §4：心跳不换 tools）
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

    const controller = new AbortController();
    opts.registerAbort(controller);
    let toolCallsObserved = 0;
    const loop = await this.runOrToolLoop({
      envelope, purpose: opts.kind === 'keepwarm' ? 'cache_keepalive' : 'proactive_turn', activeReviewId: null,
      conversationId: opts.conversationId, windowId: window.id, turnId, attemptId, controller,
      onEvent: (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: { requestId: string | null }) => {
        // 后台回合不发聊天气泡/思考流；用量照常入账（§05.6：后台无 handleEvent，此处最小挂钩）
        if (ev.kind === 'usage') {
          d.usage.record({ turnId, attemptId, scope: ev.scope, usage: ev.usage, requestId: reqCtx?.requestId ?? undefined, windowId: window.id, model: dv.model, source: ev.source, completeness: ev.completeness });
        }
      },
      // B12 修复：已见视野从轨迹 manifest 派生（不再恒空）；续轮工具片段由循环内部并入
      seenSequence: traj.manifest && traj.manifest.length > 0 ? Math.max(...traj.manifest.map((m) => m.seq)) : 0,
      seenMessages: (traj.manifest ?? []).map((m) => (m.char_start !== undefined ? { id: m.id, revision: m.revision, char_start: m.char_start, char_end: m.char_end } : { id: m.id, revision: m.revision })),
      previousEnvelope,
      background: {
        runId: opts.runId, kind: opts.kind, maxModelRequests: opts.maxModelRequests, recordDispatch: opts.recordDispatch, isCancelRequested: opts.isCancelRequested,
        observeToolCall: () => { toolCallsObserved++; },
        yieldRequested: opts.kind === 'keepwarm' && d.keepwarmYieldCheck ? () => d.keepwarmYieldCheck!(opts.runId) : null,
      },
    });
    // Same idempotent ledger as live/late usage. Missing charges retain reservations.
    settleBackgroundRun(d.db, opts.runId);
    const sleepPaused = loop.result.errorCode?.startsWith('KEEPWARM_SLEEP_') === true;
    const finishedState = loop.result.outcome === 'completed' || sleepPaused ? 'completed' : 'failed';
    d.db.prepare('UPDATE turns SET state = ?, completed_at = ? WHERE id = ?').run(finishedState, new Date().toISOString(), turnId);
    d.db.prepare('UPDATE attempts SET state=?,blocked_reason=?,completed_at=? WHERE id=?').run(finishedState,loop.result.errorCode,new Date().toISOString(),attemptId);

    // —— 结果分类（06 §2：一条执行路径、两种提交结果；判定按整轮不是最后字符串）——
    const finalText = loop.finalMessages !== null && loop.finalMessages.length > 0
      ? (() => { const last = loop.finalMessages![loop.finalMessages!.length - 1]!; const c = last.content; return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => (b as { type?: string }).type === 'text').map((b) => (b as { text?: string }).text ?? '').join('') : ''; })()
      : '';
    const publishedCount = Number((d.db.prepare("SELECT COUNT(*) n FROM messages WHERE turn_id = ? AND speaker = 'assistant'").get(turnId) as { n: number }).n);
    const pureAck = loop.result.outcome === 'completed' && !loop.result.errorCode && toolCallsObserved === 0 && publishedCount === 0 && finalText.trim() === '1';
    d.db.prepare('UPDATE background_runs SET tool_calls_observed = ?, published_message_count = ?, retention = ?, updated_at = ? WHERE id = ?')
      .run(toolCallsObserved, publishedCount, pureAck ? 'ephemeral_ack' : 'retained', new Date().toISOString(), opts.runId);

    if (!pureAck) {
      // SUBSTANTIVE（06 §2）：提交最初事件与整个必要协议链——工具调用/结果/续轮/最终文本；
      // 正式发言已在工具执行时入消息库与归档 outbox；已见清单并入轨迹 manifest（B11/C-09）。
      if (d.trajectory && loop.finalMessages !== null) {
        const baseManifest = traj.manifest ?? [];
        const publishedEntries = (d.db.prepare("SELECT id, sequence FROM messages WHERE turn_id = ? AND speaker = 'assistant' ORDER BY sequence").all(turnId) as Array<{ id: string; sequence: number }>)
          .map((m) => ({ id: m.id, revision: 1, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
        d.trajectory.replace(window.id, loop.finalMessages, tailBoundaryOf(loop.lastSentMessages ?? loop.finalMessages), [...baseManifest, ...publishedEntries, ...loop.toolSeen, ...loop.pendingToolSeen.map(entry => ({ ...entry, visible: false, pending_dispatch: true as const }))]);
        d.db.prepare('UPDATE background_runs SET trajectory_committed_at = ?, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), opts.runId);
      }
      if (loop.result.outcome !== 'completed') {
        if (loop.result.errorCode === 'TOOL_EXECUTION_OUTCOME_UNKNOWN') return { outcome: 'unknown', result_code: loop.result.errorCode };
        if (opts.isCancelRequested()) return { outcome: 'completed', result_code: 'CANCELLED_MID_RUN' };
        if (sleepPaused) return { outcome: 'noop', result_code: loop.result.errorCode! };
        return { outcome: 'failed', result_code: loop.result.errorCode ?? (opts.kind === 'keepwarm' ? 'KEEPWARM_FAILED' : 'AUTONOMOUS_FAILED') };
      }

      const runCode = d.db.prepare('SELECT result_code FROM background_runs WHERE id = ?').get(opts.runId) as { result_code: string | null };
      const completion = runCode?.result_code?.startsWith('complete:') === true ? runCode.result_code.slice('complete:'.length) : null;
      // 非1最终文本默认内部可见（E03）：保存于轨迹与运行详情，不自动推送；发言走既有发送工具。
      return { outcome: completion === 'noop' ? 'noop' : 'completed', result_code: loop.result.errorCode?.startsWith('KEEPWARM_SLEEP_') ? loop.result.errorCode : completion === 'noop' ? 'complete:noop' : 'complete:done' };
    }

    // PURE_ACK（05）：完整成功且整轮恰为"1"——维护回执；不进聊天原文与主轨迹。
    // A retained tool result from an earlier interrupted run may have entered
    // the model in this pure maintenance request. Promote only that source
    // evidence; the canonical messages and cache boundary remain untouched.
    if (d.trajectory && loop.toolSeen.length > 0) {
      d.trajectory.replaceManifest(window.id, [...(traj.manifest ?? []), ...loop.toolSeen, ...loop.pendingToolSeen.map(entry => ({ ...entry, visible: false, pending_dispatch: true as const }))]);
    }
    if (opts.kind === 'keepwarm' && d.activity && capturedActivityRevision !== null) {
      // 缓存证据以本 run 的模型请求 usage 为准（K-13：无证据=回执可记、缓存 unknown，
      // 不写"保温成功"，同活动版本不重试）
      const evRow = d.db.prepare(
        `SELECT pr.id AS rid, pr.dispatch_started_at AS started FROM provider_requests pr
         JOIN background_dispatches bd ON bd.provider_request_id = pr.id
         JOIN usage_observations u ON u.request_id = pr.id AND u.completeness = 'complete'
         WHERE bd.run_id = ? AND pr.outcome = 'completed' AND (u.cache_read_input_tokens > 0 OR u.cache_creation_input_tokens > 0)
         ORDER BY pr.dispatch_started_at DESC LIMIT 1`,
      ).get(opts.runId) as { rid: string; started: string } | undefined;
      if (evRow) {
        d.activity.noteMaintenanceReceipt({ conversationId: opts.conversationId, capturedActivityRevision: capturedActivityRevision, requestId: evRow.rid, windowId: window.id, dispatchStartedAtIso: evRow.started });
      }
    }
    return { outcome: 'completed', result_code: opts.kind === 'keepwarm' ? 'ack_only' : 'complete:noop' };
  }

  /** EXEC_V1 §03.6（WP3/M2）：消息修订 → 内部投影块（asset_image 引用，不含 Base64）。
   *  无媒体服务/纯文本消息=原样单文本块——旧路径零变化。 */
  /** 消息→OR 块投影。opts.seq：给模型看的消息序号前缀 [N]（勾选式
   *  话语录入用，2026-10-18 她裁定）——前缀只存在于模型面信封，发布/
   *  存库/前端内容不带。 */
  private revisionBlocks(messageId: string | null | undefined, revision: number | null | undefined, fallbackText: string, opts: { isCurrentInput?: boolean; textOnly?: boolean; seq?: number; hearingAvailable?: boolean; transcriptContinuationAvailable?: boolean } = {}): { blocks: Array<Record<string, unknown>>; hasImage: boolean; hasVoiceWithoutTranscript: boolean } {
    const withSeq = (t: string): string => (opts.seq !== undefined ? `[${opts.seq}]\n${t}` : t);
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
        const r = projectRevisionBlocks(withSeq(text), proj.attachments, extra);
        return { blocks: r.blocks as unknown as Array<Record<string, unknown>>, hasImage: r.hasImage, hasVoiceWithoutTranscript: r.hasVoiceWithoutTranscript };
      } catch { /* 修订缺失→退纯文本（装载面已有披露机制），不中断回合 */ }
    }
    return { blocks: [{ type: 'text', text: withSeq(fallbackText) }], hasImage: false, hasVoiceWithoutTranscript: false };
  }

  // —— OR 工具循环（§8.2）：assistant tool_calls → 宿主完整验证后串行执行 → tool 结果续请求 →
  // 同样经 P2（previousPayload append-only 断言）。发布/记账语义由调用方 onEvent 决定。
  // 返回 finalMessages：成功回合的完整轨迹消息（含最终 assistant 文本），供轨迹持久化（§2.2）。
  private async runOrToolLoop(o: {
    envelope: OrRequestEnvelope;
    purpose: RunnerPurpose;
    activeReviewId: string | null;
    conversationId: string;
    windowId: string;
    turnId: string | null; // 确认后恢复的容量评审可无所属 turn——与运行时实况对齐（F-J-31）
    attemptId: string;
    controller: AbortController;
    onEvent: (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: { requestId: string | null }) => void;
    seenSequence: number;
    seenMessages: ReadonlyArray<{ id: string; revision: number }>; // D13：实际装载视野（引用核对）
    liveSeenAdditions?: ReadonlyArray<{ id: string; revision: number }>; // 流式期间新发布的已见消息（活引用，exec 时取当下值）
    onDispatch?: (info: { attemptIndex: number; generationId: string | null; payloadJson: string; prqId: string }) => void; // F17：每次真实发送逐笔留证
    /** 整合（2026-10-24）：本轮懒初始化重建过轨迹=合法新基线——wire 锚 append-only 比对豁免
     *  （与既有 RE-10 wire 守卫豁免同裁定；保温批 wire 锚与轨迹重建场景单边绿、组合炸，此处弥合） */
    trajectoryRebuiltThisTurn?: boolean;
    inputBinding?: { messageId: string; revision: number };
    previousEnvelope?: OrRequestEnvelope | null; // 跨轮 previousPayload（轨迹正本；首轮后由循环内部接管）
    /** EXEC_V1 §04.10（WP4 收尾）+ WAKE_KEEPWARM_V1：后台回合——每次 transport 前过
     *  背景准入（取消/请求数/预算预占），逐尝试记 dispatch 账；心跳与自主共用同一
     *  完整工具循环（2026-10-22：KEEPWARM_TOOL_REFUSED 已删除）。 */
    background?: {
      runId: string;
      kind: 'autonomous' | 'keepwarm';
      maxModelRequests: number;
      recordDispatch: (info: { logicalActionKey: string; attemptNo: number; dispatchKind: 'model' | 'tool'; reservedCostMicroUsd: number; capabilityName?: string }) => { allowed: boolean; dispatchId: string; code?: string };
      isCancelRequested: () => boolean;
      observeToolCall?: () => void; // PURE_ACK 判定：任意工具调用（含 catalog/define/只读）→实质行为
      yieldRequested?: (() => boolean) | null; // S-06：心跳安全边界让位（用户消息到来）
    };
  }): Promise<{ result: import('./runner.ts').RunnerRunResult; finalMessages: OrMessage[] | null; lastSentMessages: OrMessage[] | null; toolSeen: ManifestEntry[]; pendingToolSeen: ManifestEntry[] }> {
    const d = this.d;
    const runner = (d.runnerSelection as Extract<RunnerSelection, { status: 'ok' }>).runner; // runOrToolLoop 仅在信封驱动分支被调用（rotateIfNeeded 的 !dv 早退与 runTurn 的 blocked 早退均已判别 ok）
    let envelope = o.envelope;
    let prevEnvelope: OrRequestEnvelope | null = o.previousEnvelope ?? null;
    // WP4（§7.2，2026-10-08）：conversation_read 的片段级已见——工具结果
    // **实际进入下一模型请求**（onDispatch 首发即真实发出）才从 pending 转
    // active；仅取到工具结果而未发送（停止/轮次耗尽/错误收口）不算已见（O05）
    const toolSeenActive: ManifestEntry[] = [];
    let roundPendingSeen: ManifestEntry[] = (d.trajectory?.forWindow(o.windowId)?.pendingManifest ?? []).map(({ pending_dispatch: _pending, ...entry }) => ({ ...entry, visible: true }));
    let dispatched = false;
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
    const failedLoop = (result: import('./runner.ts').RunnerRunResult, code = 'EXECUTION_NOT_STARTED') => ({
      result, finalMessages: o.background && dispatched ? incompleteProtocol(code) : null,
      lastSentMessages, toolSeen: toolSeenActive, pendingToolSeen: roundPendingSeen,
    });
    const seqOf = (id: string): number => {
      const row = d.db.prepare('SELECT sequence FROM messages WHERE id = ?').get(id) as { sequence: number } | undefined;
      return row?.sequence ?? 0;
    };
    try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      pendingCalls = [];
      pendingAssistantIndex = -1;
      const captured: MatchedCompleteBlock[] = [];
      let lastText = null as string | null; // 闭包内赋值（wrapped）：外层流分析按声明类型读（F-J-31）
      const prqId0 = `prq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const prqId = prqId0;
      let lastPrqId = prqId0; // D07：终态/计量归属**最后一次实际派发**的请求行（重试不再覆盖首发）
      const wrapped: typeof o.onEvent = (ev, reqCtx) => {
        void reqCtx;
        if (ev.kind === 'complete_message') {
          for (const b of ev.matched) if (b.block_type === 'tool_use') captured.push(b);
          const text = ev.matched.find((b) => b.block_type === 'text' && typeof b.text === 'string');
          if (text) lastText = text.text;
        }
        o.onEvent(ev, { requestId: lastPrqId }); // 审计 F12：usage 按实际请求身份去重（不互覆）
      };
      // F17：发送前保存不可变协议投影（重放/对账依据；受保护字段，不进普通日志）
      // cost-20261018：每轮落上下文指纹（只含 hash/位置/计数）；同轮重试行共用同一指纹
      const fingerprintJson = contextFingerprintJson({ round, tools: envelope.tools, messages: envelope.messages, boundaries: envelope.boundaries });
      d.db.prepare('INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, payload_json, context_fingerprint_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(prqId, o.windowId, o.attemptId, o.turnId, o.purpose, JSON.stringify(envelope.messages.map((m) => ({ role: m.role }))), JSON.stringify(envelope), fingerprintJson, new Date().toISOString());
      // F03 尾：工具续请求每轮重算容量硬门（§4.2：连续工具回合每次重算，预留不是无限消费额度）
      const capacityNow = d.config.windows.model_context_capacity;
      if (capacityNow !== null) {
        const estNow = Math.ceil(JSON.stringify({ messages: envelope.messages, tools: envelope.tools }).length / (this.drv()?.charsPerToken ?? 2.5));
        const planNow = rotationPlan({
          currentInput: estNow, nextInput: estNow, capacity: capacityNow,
          maxOutput: this.drv()?.maxTokens ?? d.config.openrouter.max_output_tokens,
          toolReserve: d.config.windows.tool_input_reserve_tokens, reviewReserve: d.config.windows.review_reserve_tokens,
          safety: d.config.windows.safety_reserve_tokens, soft: d.config.windows.soft_limit_tokens,
        });
        if (planNow.action === 'blocked_hard') {
          d.db.prepare('UPDATE provider_requests SET outcome = ? WHERE id = ?').run('CAPACITY_BLOCKED_HARD', prqId);
          return failedLoop({ outcome: 'error', errorClassified: null, errorCode: 'CAPACITY_BLOCKED_HARD_TOOL_ROUND', errorMessage: `工具续请求输入估计 ${estNow} 超过安全上界 ${planNow.safeInput}`, sessionId: null, requestId: null });
        }
      }
      const payloadJson = JSON.stringify(envelope);
      // EXEC_V1 §03.6.2（WP3/M2）：发送边界物化——内部 asset_image 引用在此从不可变文件确定性
      // 物化为 Provider 图像块；envelope/payload_json（内部证据）与轨迹保持引用形态（Base64 不入库）。
      // previousPayload 同规则物化——append-only 断言在物化形态上执行（新旧同语义规则，不忽略失败）。
      const matEnv = (env: typeof envelope): typeof envelope => (d.media ? materializeEnvelope(env, d.media) as typeof envelope : env);
      const runEnvelope = matEnv(envelope);
      // EXEC_V1 02 §4.2（WP2）：transport 前准入落账——每次尝试（含 429/网络/首字节前重试）
      // 单独记 dispatch_started_at 与 wire_v1 最终发包体；sent_at 仍=真实发送确认（响应头已到）。
      // 旧 onDispatch 建行的路径废除：发出但无响应的尝试不再从派发账本消失。
      const onBeforeDispatch = async (info: { attemptIndex: number; payloadWireJson: string }): Promise<void> => {
        if (o.controller.signal.aborted) throw new ContractError('CANCELLED_BEFORE_DISPATCH');
        if (o.inputBinding) {
          const current = d.messages.getMessage(o.inputBinding.messageId);
          if (!current || current.current_revision !== o.inputBinding.revision) throw new ContractError('INPUT_REVISION_SUPERSEDED');
        }
        // §04.10.1：driver 内每次重试都过同一准入（取消后不再发；请求数/预算逐笔预占）
        if (o.background) {
          if (o.background.isCancelRequested()) throw new Error('DISPATCH_ADMISSION_REJECTED:CANCELLED');
          if (o.background.kind === 'keepwarm') {
            const sleep = keepwarmSleepState(d.config.background.keepwarm.sleep_window, this.nowMs());
            if (sleep.blocked) throw new ContractError(sleep.code!);
          }
          // S-06：心跳让位——用户消息已到来且本维护轮尚未开始新的付费请求（安全边界）
          if (o.background.yieldRequested?.()) throw new Error('DISPATCH_ADMISSION_REJECTED:KEEPWARM_YIELDED');
          const started = (d.db.prepare('SELECT model_requests_started FROM background_runs WHERE id = ?').get(o.background.runId) as { model_requests_started: number } | undefined)?.model_requests_started ?? 0;
          if (started >= o.background.maxModelRequests) throw new Error('DISPATCH_ADMISSION_REJECTED:BACKGROUND_BUDGET_EXHAUSTED');
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
            .run(retryId, o.windowId, o.attemptId, o.turnId, o.purpose, JSON.stringify(envelope.messages.map((m) => ({ role: m.role }))), payloadJson, fingerprintJson, redactImageBlocksForStorage(info.payloadWireJson).redactedJson, 'wire_v1', nowIso, nowIso, info.attemptIndex, o.background?.runId ?? null, bgDispatchId);
          lastPrqId = retryId; // D07：后续终态/usage 记在真正承载本次发送的行
        }
        if (round === 0 && info.attemptIndex === 0 && o.inputBinding) {
          const message = d.messages.getMessage(o.inputBinding.messageId);
          if (message) d.events.publish('message.persisted', {
            conversationId:o.conversationId,turnId:o.turnId,attemptId:o.attemptId,
            entityRef:message.id,entityRevision:message.current_revision,
            payload:{message:{...message,mutation_status:{can_edit:false,can_withdraw:false,reason:'MESSAGE_ALREADY_DISPATCHED'}}},
          });
        }
        dispatched = true;
        lastSentMessages = envelope.messages;
      };
      let roundSeenPromoted = false; // 本轮首个真实响应=工具结果实际进入模型（429 重试后成功同算——修 O05 边角）
      let roundGenerationId: string | null = null; // R07：本轮工具事件的 provider 生成标识
      const onDispatch = (info: { attemptIndex: number; generationId: string | null }): void => {
        roundGenerationId = info.generationId ?? roundGenerationId;
        // F17 语义保留：2xx=真实发送确认。行已在准入时建好——这里只确认 sent_at 与 generation。
        const nowIso = new Date().toISOString();
        d.db.prepare('UPDATE provider_requests SET sent_at = COALESCE(sent_at, ?), attempt_no = COALESCE(attempt_no, ?), generation_id = COALESCE(?, generation_id) WHERE id = ?')
          .run(nowIso, info.attemptIndex, info.generationId ?? null, lastPrqId);
        if (!roundSeenPromoted) {
          roundSeenPromoted = true;
          // WP4（O05）：请求真实发出=上一轮工具结果（含 conversation_read 片段）
          // 进入模型视野——pending 片段转正为已见
          if (roundPendingSeen.length > 0) {
            toolSeenActive.push(...roundPendingSeen);
            roundPendingSeen = [];
          }
        }
      };
      let previousPayload = prevEnvelope ? this.buildPayloadFrom(matEnv(prevEnvelope)) : null;
      // 整合（2026-10-24）：轨迹本轮重建（懒初始化）=合法新基线——旧 wire 锚不再可比，豁免
      if (round === 0 && prevEnvelope && !o.trajectoryRebuiltThisTurn) {
        const anchor = d.db.prepare(`SELECT p.payload_wire_json FROM provider_requests p
          JOIN turns t ON t.id=p.turn_id LEFT JOIN background_runs b ON b.id=p.background_run_id
          WHERE p.window_id=? AND p.outcome='completed' AND p.sent_at IS NOT NULL
            AND p.payload_format='wire_v1' AND p.payload_wire_json IS NOT NULL
            AND ((p.purpose='chat' AND t.state='completed') OR (b.retention='retained' AND b.trajectory_committed_at IS NOT NULL))
          ORDER BY p.dispatch_started_at DESC,p.rowid DESC LIMIT 1`).get(o.windowId) as { payload_wire_json: string } | undefined;
        if (anchor) {
          const recorded = JSON.parse(anchor.payload_wire_json) as Record<string, unknown>;
          if (this.drv()?.kind === 'deepseek' && legacyDsReasoningGap(recorded, this.buildPayloadFrom(runEnvelope))) {
            return failedLoop({ outcome: 'error', errorClassified: null, errorCode: 'DS_PROTOCOL_HISTORY_REQUIRES_NEW_WINDOW', errorMessage: '旧窗口缺少已发送的模型协议内容，请通过正常手动换窗选择原文后继续；已有历史保持不变。', sessionId: null, requestId: null });
          }
          // Stored redacted image payloads cannot be compared as exact wire bytes.
          if (!hasStorageImageRedaction(recorded)) previousPayload = recorded;
        }
      }
      const result = await Promise.race([
        runner.run({ driver: this.drv()?.kind ?? 'openrouter', purpose: o.purpose, envelope: runEnvelope, previousPayload, abortController: o.controller, onEvent: wrapped, onDispatch, onBeforeDispatch }),
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
      if (round === MAX_TOOL_ROUNDS) {
        return failedLoop({ outcome: 'error', errorClassified: null, errorCode: 'TOOL_ROUNDS_EXCEEDED', errorMessage: `工具续请求超过 ${MAX_TOOL_ROUNDS} 轮（有界防循环）`, sessionId: null, requestId: result.requestId }, 'TOOL_ROUNDS_EXCEEDED');
      }
      // §3.3：同一批里既有 hold 又有 complete → 先执行并核实全部写操作，最后才验证 complete（不并发抢先放行）。
      // 审计 F04：complete 按模型原始顺序排在 hold 前 was 错误签发路径；此处强制重排。
      const ordered = [
        ...captured.filter((t) => effectiveToolName(t.tool_name ?? '', t.text) !== 'context_review_complete'),
        ...captured.filter((t) => effectiveToolName(t.tool_name ?? '', t.text) === 'context_review_complete'),
      ];
      for (const t of ordered) {
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
          return failedLoop({ outcome: 'completed', errorClassified: null, errorCode: 'KEEPWARM_YIELDED_DURING_TOOLS', errorMessage: '用户消息到来：心跳让位——已执行工具回执保留，后续工具不再分派', sessionId: null, requestId: result.requestId }, 'KEEPWARM_YIELDED');
        }
        // PURE_ACK 判定：任意工具调用（含 catalog/define/只读）→实质行为（06 §2，按调用计数）
        if (o.background?.observeToolCall) o.background.observeToolCall();
        // The real executor validates the frozen definition and arguments before
        // quoting/admitting its effective handler. Never quote tool_invoke as free.
        const toolDispatch: { current: { id: string; quote: BackgroundToolQuote } | null } = { current: null };
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(t.text ?? '{}') as Record<string, unknown>;
        } catch {
          args = {}; // 参数非法：执行器会因缺必填字段拒绝（§8.2 输入完整校验后才执行）
        }
        args.__tool_call_id = t.tool_id;
        let exec: ToolExecResult;
        try {
        exec = await d.tools!.execute(t.tool_name ?? '', args, {
          signal: o.controller.signal, // 语音分支：取消传播（电话/检索取消链）
          roomId: o.conversationId, windowId: o.windowId, turnId: o.turnId, purpose: o.purpose, backgroundRunId: o.background?.runId ?? null,
          activeReviewId: o.activeReviewId, seenSequence: o.seenSequence,
          seenMessages: [...o.seenMessages, ...(o.liveSeenAdditions ?? []), ...toolSeenActive.map(m => (m.char_start !== undefined ? { id: m.id, revision: m.revision, char_start: m.char_start, char_end: m.char_end } : { id: m.id, revision: m.revision }))], // D13：含流式期间新发布的已见原话；WP4：含已实际进入请求的回读片段
          requestId: lastPrqId, // internal request ledger identity; provider generation is separate
          // R07（审计 FE-12）：工具生命周期统一身份
          toolCallId: t.tool_id, attemptId: o.attemptId, round, generationId: roundGenerationId,
          ...(o.background ? { beforeBackgroundTool: (quote: BackgroundToolQuote) => {
            const rec = o.background!.recordDispatch({ logicalActionKey: `tool:${t.tool_id}`, attemptNo: 1, dispatchKind: 'tool', reservedCostMicroUsd: quote.maxCostMicroUsd, capabilityName: quote.toolName });
            if (!rec.allowed) throw new ContractError(rec.code ?? 'BACKGROUND_TOOL_ADMISSION_REJECTED');
            toolDispatch.current = { id: rec.dispatchId, quote };
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
        // WP4：conversation_read 等只读工具返回的已见增量——先入 pending，
        // 随工具结果进入下一请求时转正（O05：取到结果≠已见）
        if (exec.seenAdditions && exec.seenAdditions.length > 0) {
          for (const a of exec.seenAdditions) {
            roundPendingSeen.push({
              id: a.id, revision: a.revision, seq: seqOf(a.id), origin: 'tool', visible: true,
              ...(a.char_start !== undefined ? { char_start: a.char_start, char_end: a.char_end } : {}),
            });
          }
        }
        // RE-05（2026-10-24）：工具结果携带内部图引用（如 oido_view 测量图）且当前型号
        // 已核实支持图像 → 工具消息正文=文本 JSON + asset_image 引用块（发送边界物化为
        // 原生图块，存储侧照常脱敏）；未核实/不支持 → 仅文本（工具 JSON 内已如实声明
        // 图未随正文携带，模型不得声称已看图）
        const modelSupportsImages = visionSupportCached(envelope.model) === true;
        const imageBlocks = modelSupportsImages && exec.imageRefs && exec.imageRefs.length > 0
          ? exec.imageRefs.map((id) => ({ type: 'asset_image', asset_id: id, projection_version: 'v1' as const }))
          : [];
        envelope = { ...envelope, messages: [...envelope.messages, { role: 'tool', tool_call_id: t.tool_id, ...(imageBlocks.length > 0 ? { content: [{ type: 'text', text: JSON.stringify(exec.output) }, ...imageBlocks] } : { content: JSON.stringify(exec.output) }) } as unknown as OrMessage] };
      }
      if (o.activeReviewId && d.reviews?.get(o.activeReviewId)?.status === 'completed') {
        return { result, finalMessages: null, lastSentMessages: null, toolSeen: toolSeenActive, pendingToolSeen: roundPendingSeen }; // §3.3：complete 最后验证；完成后收口，评审请求不进对话轨迹
      }
    }
    return failedLoop({ outcome: 'error', errorClassified: null, errorCode: 'TOOL_ROUNDS_EXCEEDED', errorMessage: 'unreachable', sessionId: null, requestId: null });
    } catch (error) {
      return failedLoop({ outcome: 'error', errorClassified: 'unknown', errorCode: stableCode(error), errorMessage: String((error as Error).message ?? error), sessionId: null, requestId: null });
    }
  }

  /** 指纹输入视图：并入运行时 override（or_model）。reasoning 不参与指纹
   *  ——effort 是逐请求生成参数，切换不构成运行边界变化（不换窗）。 */
  private fingerprintConfigView(config: import('../config/schema.ts').Config): import('../identity/service.ts').BoundaryConfigInput {
    if (!this.d.settings) return config;
    const model = this.d.settings.effectiveOrModel(config.openrouter.model);
    if (model === config.openrouter.model) return config;
    return { ...config, openrouter: { ...config.openrouter, model } };
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
  private drv(): { kind: 'openrouter' | 'deepseek'; model: string; maxTokens: number; reasoning: Record<string, unknown> | null; charsPerToken: number; sessionId: (roomId: string) => string } | null {
    const r = this.d.runnerSelection;
    if (r.status !== 'ok' || !isEnvelopeDriverKind(r.runner.kind)) return null;
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

  private buildPayloadFrom(envelope: OrRequestEnvelope): Record<string, unknown> {
    if (this.drv()?.kind === 'deepseek') return buildDeepSeekPayload(envelope);
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
      'SELECT id, sequence, speaker, current_revision, turn_id FROM messages WHERE conversation_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 200',
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
  private async windowBootstrap(windowId: string, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    let t = this.bootstrapByWindow.get(windowId);
    if (t !== undefined) return t;
    const d = this.d;
    const mc = d.tools?.mariposaClient() ?? null;
    if (!mc) return null; // 未接线：如实无 B
    const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(BOOTSTRAP_DEADLINE_MS)]) : AbortSignal.timeout(BOOTSTRAP_DEADLINE_MS);
    const startedAt = performance.now();
    const moodBudgetMs = (): number => Math.max(0, Math.floor(BOOTSTRAP_DEADLINE_MS - (performance.now() - startedAt) - 1700));
    const dedupeKey = `bootstrap:${windowId}`;
    const UNAVAILABLE_TEXT = 'Mariposa开窗资料未取得，I、计划及记忆资料状态未知；不表示记忆不存在';
    const report = (gaps: BootstrapGap[], code = 'BOOTSTRAP_UNAVAILABLE'): void => {
      const unavailable = gaps.length === 0;
      const critical = unavailable || gaps.some(gap => gap.section === 'i');
      const note = unavailable
        ? UNAVAILABLE_TEXT
        : gaps.some(gap => gap.section === 'i')
          ? 'I 当前的话未全载；其他已复核资料已保留，本次资料不完整'
          : '部分开窗资料未全载；失败的心情全文未注入，其他已复核资料已保留';
      d.events.publish('context.warning', { conversationId: 'unknown', entityRef: windowId, scope: 'private', payload: { source: 'bootstrap', code: unavailable ? code : (gaps[0]?.code ?? 'unknown'), section: unavailable ? 'bootstrap' : gaps[0]?.section, note } });
      d.alerts?.observe({ code: 'BOOTSTRAP_INCOMPLETE', severity: critical ? 'critical' : 'warning', scopeKind: 'integration', scopeId: 'mariposa', dedupeKey, observationId: null,
        safeSummary: { title: '开窗资料不完整', detail: note, reason: gaps.map(gap => gap.code).join(',') || code, count: gaps.length, window_id: windowId, retryable: gaps.some(gap => gap.retryable) } });
    };
    // SNAPSHOT_STALE invalidates every dependent field. Rebuild once from a new
    // first page, never splice a replacement snapshot into an existing attempt.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const first = await bootstrapCall(s => mc.bootstrapGet(s), { signal: lifetime });
        if (first.plans != null && (typeof first.plans !== 'object' || Array.isArray(first.plans)
          || (first.plans as { items?: unknown }).items !== undefined && (!Array.isArray((first.plans as { items?: unknown[] }).items) || ((first.plans as { items?: unknown[] }).items ?? []).some(item => !item || typeof item !== 'object' || Array.isArray(item))))) {
          throw new BootstrapPagingError('BOOTSTRAP_SHAPE_INVALID', 'bootstrap');
        }
        const snapId = typeof first.snapshot_id === 'string' && first.snapshot_id ? first.snapshot_id : null;
        const gaps: BootstrapGap[] = [];
        // —— I（current words）：畸形值=critical 局部缺口（不启续取）；续取失败整段丢弃 ——
        let iText: string | null = null;
        let iNote = '';
        const iRaw = (first as Record<string, unknown>).i as unknown;
        if (iRaw != null) {
          const bad = (v: unknown): boolean => v === null || typeof v !== 'object' || Array.isArray(v) || typeof (v as { content?: unknown }).content !== 'string';
          if (bad(iRaw)) {
            gaps.push({ section: 'i', code: 'BOOTSTRAP_SHAPE_INVALID', retryable: false });
            iText = null;
          } else {
            const iSec = iRaw as { content: string; truncated?: unknown; total_chars?: unknown; next_cursor?: Record<string, unknown> | null };
            iText = iSec.content;
            const iLoaded = Array.from(iText).length;
            const iTotal = typeof iSec.total_chars === 'number' ? iSec.total_chars : null;
            if (iSec.truncated === true && iSec.next_cursor == null) {
              gaps.push({ section: 'i', code: 'BOOTSTRAP_CURSOR_MISSING', retryable: false });
              iNote = '（超窗未全载：续取未完成）';
            } else if (iSec.next_cursor != null) {
              if (!snapId) throw new BootstrapPagingError('BOOTSTRAP_SNAPSHOT_MISSING', 'i');
              const seenOffsets = new Set<number>();
              let iCur: Record<string, unknown> | null = iSec.next_cursor ?? null;
              let loaded = iLoaded;
              let guard = 0;
              while (iCur != null && guard < 64) {
                guard++;
                const offset = (iCur as { i_offset?: unknown }).i_offset;
                if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset !== loaded || seenOffsets.has(offset)) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', 'i');
                seenOffsets.add(offset);
                try {
                  const page = await bootstrapCall(sg => mc.bootstrapNext(snapId!, iCur!, 'i', sg), { signal: lifetime, section: 'i' });
                  if (typeof page.offset !== 'number' || page.offset !== loaded) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', 'i');
                  if (page.snapshot_id !== snapId) throw new BootstrapPagingError('BOOTSTRAP_SNAPSHOT_MISMATCH', 'i');
                  if (page.instruction_authority !== 'none' || page.content_role !== 'bootstrap_memory_package') throw new BootstrapPagingError('BOOTSTRAP_AUTHORITY_INVALID', 'i');
                  if (page.section !== 'i') throw new BootstrapPagingError('BOOTSTRAP_RESOURCE_MISMATCH', 'i');
                  if (typeof page.content !== 'string' || page.content.length === 0) throw new BootstrapPagingError('BOOTSTRAP_NO_PROGRESS', 'i');
                  if (typeof page.total_chars !== 'number' || !Number.isSafeInteger(page.total_chars) || page.total_chars < 0 || (iTotal != null && page.total_chars !== iTotal)) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', 'i');
                  if (!Object.hasOwn(page, 'next_cursor')) throw new BootstrapPagingError('BOOTSTRAP_CURSOR_MISSING', 'i');
                  const cpLen = Array.from(page.content).length;
                  const endOffset = loaded + cpLen;
                  if (endOffset > page.total_chars) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', 'i');
                  const upcoming = page.next_cursor as Record<string, unknown> | null;
                  if (upcoming != null) {
                    const noff = (upcoming as { i_offset?: unknown }).i_offset;
                    if (typeof noff !== 'number' || noff !== endOffset) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', 'i');
                    if (seenOffsets.has(noff)) throw new BootstrapPagingError('BOOTSTRAP_CURSOR_REPEATED', 'i');
                  } else if (endOffset !== page.total_chars) {
                    throw new BootstrapPagingError('BOOTSTRAP_INCOMPLETE', 'i');
                  }
                  // 全部校验通过才拼接——坏页的尾巴不得进入已载前缀
                  iText += page.content;
                  loaded = endOffset;
                  iCur = upcoming;
                } catch (err) {
                  if (!(err instanceof BootstrapPagingError)) throw err;
                  if (globalBootstrapFailure(err)) throw err;
                  gaps.push({ section: 'i', code: err.code, retryable: retryableBootstrapFailure(err) });
                  iNote = `（超窗未全载：续取未完成，已载 ${Array.from(iText ?? '').length}字）`;
                  break;
                }
              }
            }
          }
        }
        // —— 事件/我们的话（每桶独立局部缺口；全局失败上抛整包重建）——
        const dayItems = ((((first as Record<string, unknown>).memory_days as Record<string, unknown> | undefined)?.items ?? []) as Array<Record<string, unknown>>).map(item => ({ ...item }));
        const readTextSection = async (item: Record<string, unknown>, field: 'event_text' | 'our_words'): Promise<void> => {
          const memId = item.memory_id;
          const curKey = `${field}_next`; const truncKey = `${field}_truncated`; const totalKey = field === 'event_text' ? 'event_text_total_chars' : 'our_words_total_items';
          let cur = item[curKey] as Record<string, unknown> | undefined | null;
          if (item[truncKey] === true && cur == null) {
            gaps.push({ section: field, ...(typeof memId === 'string' ? { memoryId: memId } : {}), code: 'BOOTSTRAP_CURSOR_MISSING', retryable: false });
            item.__bootNote = `[${field === 'event_text' ? '事件正文' : '我们的话'}分节未全载（续取游标缺失）]`;
            delete item[truncKey];
            return;
          }
          if (cur == null) return;
          if (!snapId) throw new BootstrapPagingError('BOOTSTRAP_SNAPSHOT_MISSING', field);
          try {
            if (field === 'event_text') {
              let text = typeof item.event_text === 'string' ? item.event_text : '';
              let loaded = Array.from(text).length;
              const total0 = item.event_text_total_chars;
              let total = typeof total0 === 'number' && Number.isSafeInteger(total0) ? total0 : null;
              const seen = new Set<number>();
              let guard = 0;
              while (cur != null && guard < 64) {
                guard++;
                if (cur.memory_id !== memId || cur.field !== field || typeof cur.offset !== 'number' || cur.offset !== loaded || seen.has(cur.offset)) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
                seen.add(cur.offset);
                const page = await bootstrapCall(sg => mc.bootstrapNext(snapId!, cur as Record<string, unknown>, 'memory_item', sg), { signal: lifetime, section: field });
                if (page.snapshot_id !== snapId || page.section !== 'memory_item' || page.memory_id !== memId || page.field !== field) throw new BootstrapPagingError('BOOTSTRAP_RESOURCE_MISMATCH', field);
                if (field === 'event_text' && (typeof page.offset !== 'number' || page.offset !== loaded)) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
                if (page.instruction_authority !== 'none' || page.content_role !== 'bootstrap_memory_package') throw new BootstrapPagingError('BOOTSTRAP_AUTHORITY_INVALID', field);
                if (typeof page.content !== 'string' || page.content.length === 0) throw new BootstrapPagingError('BOOTSTRAP_NO_PROGRESS', field);
                if (typeof page.total_chars !== 'number' || !Number.isSafeInteger(page.total_chars) || (total != null && page.total_chars !== total)) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', field);
                if (!Object.hasOwn(page, 'next_cursor')) throw new BootstrapPagingError('BOOTSTRAP_CURSOR_MISSING', field);
                const cpLenE = Array.from(page.content).length;
                const endE = loaded + cpLenE;
                if (endE > page.total_chars) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', field);
                const upcoming = page.next_cursor as Record<string, unknown> | null;
                if (upcoming != null) {
                  if (upcoming.memory_id !== memId || upcoming.field !== field || upcoming.offset !== endE) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
                  if (seen.has(upcoming.offset as number)) throw new BootstrapPagingError('BOOTSTRAP_CURSOR_REPEATED', field);
                } else if (endE !== page.total_chars) throw new BootstrapPagingError('BOOTSTRAP_INCOMPLETE', field);
                // 全部校验通过才拼接
                total = page.total_chars;
                text += page.content;
                loaded = endE;
                cur = upcoming;
              }
              if (total != null && loaded !== total) throw new BootstrapPagingError('BOOTSTRAP_INCOMPLETE', field);
              item.event_text = text;
              delete item[curKey]; delete item[truncKey];
            } else {
              const groups = Array.isArray(item.our_words) ? (item.our_words as Array<{ speaker?: string; texts?: unknown[] }>) : [];
              let flat: Array<{ speaker?: string; text: string }> = [];
              for (const g of groups) {
                if (!g || typeof g !== 'object') throw new BootstrapPagingError('BOOTSTRAP_SHAPE_INVALID', field);
                if (g.texts !== undefined && !Array.isArray(g.texts)) throw new BootstrapPagingError('BOOTSTRAP_SHAPE_INVALID', field);
                for (const wt of g.texts ?? []) {
                  if (typeof wt !== 'string') throw new BootstrapPagingError('BOOTSTRAP_SHAPE_INVALID', field);
                  flat.push({ speaker: g.speaker, text: wt });
                }
              }
              const total0 = item.our_words_total_items;
              let total = typeof total0 === 'number' && Number.isSafeInteger(total0) ? total0 : null;
              const seenIdx = new Set<number>();
              let itemOffset = flat.length;
              const cursor0 = cur as { item_offset?: unknown; char_offset?: unknown };
              if (cursor0.item_offset !== itemOffset || cursor0.char_offset !== 0) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
              let guard = 0;
              while (cur != null && guard < 64) {
                guard++;
                const co = cur as { item_offset?: unknown; char_offset?: unknown };
                if (typeof co.item_offset !== 'number' || co.item_offset !== itemOffset || typeof co.char_offset !== 'number' || seenIdx.has(co.item_offset)) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
                seenIdx.add(co.item_offset);
                const page = await bootstrapCall(sg => mc.bootstrapNext(snapId!, cur as Record<string, unknown>, 'memory_item', sg), { signal: lifetime, section: field });
                if (page.snapshot_id !== snapId || page.section !== 'memory_item' || page.memory_id !== memId || page.field !== field) throw new BootstrapPagingError('BOOTSTRAP_RESOURCE_MISMATCH', field);
                if (page.instruction_authority !== 'none' || page.content_role !== 'bootstrap_memory_package') throw new BootstrapPagingError('BOOTSTRAP_AUTHORITY_INVALID', field);
                if (!Array.isArray(page.items) || page.items.length === 0) throw new BootstrapPagingError('BOOTSTRAP_NO_PROGRESS', field);
                for (const g of page.items as Array<{ speaker?: string; texts?: unknown[] }>) {
                  for (const wt of g?.texts ?? []) {
                    if (typeof wt !== 'string') throw new BootstrapPagingError('BOOTSTRAP_SHAPE_INVALID', field);
                    flat.push({ speaker: g.speaker, text: wt });
                  }
                }
                itemOffset += page.items.length;
                if (typeof page.total_items === 'number' && Number.isSafeInteger(page.total_items)) {
                  if (total != null && page.total_items !== total) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', field);
                  total = page.total_items;
                }
                if (total != null && itemOffset > total) throw new BootstrapPagingError('BOOTSTRAP_TOTAL_MISMATCH', field);
                if (!Object.hasOwn(page, 'next_cursor')) throw new BootstrapPagingError('BOOTSTRAP_CURSOR_MISSING', field);
                const upcoming = page.next_cursor as Record<string, unknown> | null;
                if (upcoming != null) {
                  const u = upcoming as { item_offset?: unknown; char_offset?: unknown };
                  if (u.item_offset !== itemOffset || u.char_offset !== 0) throw new BootstrapPagingError('BOOTSTRAP_OFFSET_MISMATCH', field);
                } else if (total != null && itemOffset !== total) throw new BootstrapPagingError('BOOTSTRAP_INCOMPLETE', field);
                cur = upcoming;
              }
              // 重组为分组形状（渲染层沿用分组）
              const regrouped: Array<{ speaker?: string; texts: string[] }> = [];
              for (const w of flat) {
                const lastG = regrouped[regrouped.length - 1];
                if (lastG && lastG.speaker === w.speaker) lastG.texts.push(w.text);
                else regrouped.push({ speaker: w.speaker, texts: [w.text] });
              }
              item.our_words = regrouped;
              delete item[curKey]; delete item[truncKey];
            }
          } catch (err) {
            if (!(err instanceof BootstrapPagingError)) throw err;
            if (globalBootstrapFailure(err)) throw err;
            gaps.push({ section: field, ...(typeof memId === 'string' ? { memoryId: memId } : {}), code: err.code, retryable: retryableBootstrapFailure(err) });
            // 续取失败：保留已载前缀+如实披露游标（不静默当全文）；初值本就缺段则只留披露行
            const nextKey = field === 'event_text' ? 'event_text_next' : 'our_words_next';
            item.__bootNote = `[${field === 'event_text' ? '事件正文' : '我们的话'}分节未全载（${nextKey} 续取未完成）]`;
            delete item[curKey]; delete item[truncKey];
          }
        };
        for (const item of dayItems) {
          await readTextSection(item, 'event_text');
          await readTextSection(item, 'our_words');
        }
        // —— 心情（可选段：剩余时间-1700ms 预算；先终验后心情也依此预算让位）——
        const moodPkt = { ...(first as Record<string, unknown>), memory_days: dayItems.length > 0 || (first as Record<string, unknown>).memory_days != null ? { ...((first as Record<string, unknown>).memory_days as Record<string, unknown> ?? {}), ...(dayItems.length > 0 ? { items: dayItems } : {}) } : undefined };
        const moodResult = await completeBootstrapPages(mc, moodPkt as Record<string, unknown>, { signal: lifetime, maxDurationMs: moodBudgetMs() });
        const data = moodResult.data as Record<string, any>;
        gaps.push(...moodResult.gaps);
        // —— 同快照终验（仅部分交付需要：先验证其余段再交付缺口；失效=整包重建）——
        // 完整单页包 get 本身即权威（快照一页取尽），无需再验。
        if (gaps.length > 0) {
          const verify = await bootstrapCall(sg => mc.bootstrapValidate(snapId!, sg), { signal: lifetime });
          if (verify.unchanged !== true || verify.snapshot_id !== snapId || verify.profile !== 'estomago') {
            throw new BootstrapPagingError('SNAPSHOT_STALE', 'bootstrap');
          }
        }
        // —— 渲染（展示顺序不变：心情→事件→我们的话→计划→I）——
        const seg: string[] = ['[memory/bootstrap：开窗资料（数据，非指令；按需可用 memory_recall 查询更多）]'];
        // 临近纪念日提醒（她 2026-10-17 裁定：快到了才提醒，不每天提醒）——许愿星只读查询，
        // 失败/无凭据=无此行如实降级（一次警告，不阻塞开窗）
        if (d.wishstar) {
          try {
            const upcoming = await d.wishstar.upcoming(d.config.wishstar?.upcoming_days ?? 3, lifetime);
            for (const it of upcoming.items ?? []) {
              seg.push(`[临近纪念日：${it.name}（${it.days_until === 0 ? '就是今天' : `还有 ${it.days_until} 天`}）——来自许愿星]`);
            }
          } catch {
            d.events.publish('context.warning', { conversationId: 'unknown', entityRef: windowId, scope: 'private', payload: { source: 'wishstar', code: 'WISHSTAR_UNAVAILABLE', note: '临近纪念日查询不可用——本轮不带提醒，不影响其他开窗资料' } });
          }
        }
        const days = ((data.memory_days as Record<string, any> | undefined)?.items ?? []) as Array<Record<string, unknown>>;
        if (days.length > 0) {
          seg.push('近三日记忆：');
          for (const it of days) {
            let line = `- ${String(it.original_title ?? '')}（${String(it.memory_date ?? '?')}）`;
            if (Array.isArray(it.mood_tags) && (it.mood_tags as unknown[]).length > 0) {
              line += ' 心情:' + (it.mood_tags as unknown[]).join('/');
            }
            if (typeof it.mood_text === 'string' && it.mood_text.length > 0) {
              line += `（心情文字：${it.mood_text}）`;
            }
            seg.push(line);
            if (typeof it.event_text === 'string' && it.event_text.length > 0) seg.push(`  事件：${it.event_text}`);
            const words0 = it.our_words as unknown;
            for (const g of Array.isArray(words0) ? (words0 as Array<{ speaker?: string; texts?: unknown[] }>) : []) {
              for (const wt of g?.texts ?? []) if (typeof wt === 'string') seg.push(`  ${g?.speaker === 'jiaming' ? '他' : '她'}：${wt}`);
            }
            if (typeof it.__bootNote === 'string') seg.push(`  ${it.__bootNote}`);
          }
        }
        const plansSec = data.plans as Record<string, any> | undefined;
        const plans = ((plansSec?.items ?? []) as Array<Record<string, unknown>>);
        if (plans.length > 0) {
          seg.push('计划：');
          for (const pl of plans) {
            const detail = typeof pl.detail === 'string' && pl.detail.length > 0 ? `（${pl.detail}）` : '';
            seg.push(`- ${String(pl.title ?? '')}${detail}`);
          }
        }
        if (plansSec?.next_cursor != null) {
          const total = typeof plansSec.total === 'number' ? plansSec.total : null;
          seg.push(`[计划还有更多未载入（plans 续页未取；已载 ${plans.length}${total != null ? '/' + total : ''} 条）——按需可用 plans_read 查询]`);
        }
        if (typeof iText === 'string' && iText.length > 0) seg.push(`I（当前的话）：${iText}${iNote}`);
        else if (gaps.some(gap => gap.section === 'i')) seg.push('[I 当前的话未全载；其余已复核资料保留]');
        const moodGaps = gaps.filter(gap => gap.section === 'mood_text');
        if (moodGaps.length > 0) seg.push('[部分开窗资料未全载：心情文字未全载（该条心情全文未注入）；其他已复核资料已保留]');
        // 她 1022 裁定（首批 identity_milestone_write）：初始可读工具定义随 B 注入——
        // 随窗冻结（新窗生效）；wire 入口不变；invoke 旁路校验见 tool-initial-visible.ts
        const initialTools = renderInitialVisibleText(d.db);
        if (initialTools !== null) seg.push(initialTools);
        if (seg.length === 1) {
          // 空包（无任何资料段）：如实无 B——不注入占位文本、不告警、不缓存
          if (gaps.length > 0) report(gaps);
          return null;
        }
        const text = seg.join('\n');
        if (gaps.length > 0) {
          report(gaps);
          return text; // 部分交付：如实披露，不进缓存（下次重试）
        }
        this.bootstrapByWindow.set(windowId, text);
        d.alerts?.resolve(dedupeKey, { summary: {} });
        return text;
      } catch (err) {
        if (err instanceof BootstrapPagingError && err.code === 'BOOTSTRAP_CANCELLED') return null; // 父 Stop：静默，无告警无缓存
        if (err instanceof BootstrapPagingError && err.code === 'BOOTSTRAP_DEADLINE_EXCEEDED') {
          report([], 'BOOTSTRAP_DEADLINE_EXCEEDED');
          return UNAVAILABLE_TEXT;
        }
        if (!(err instanceof BootstrapPagingError)) throw err;
        if (attempt < 1 && (err.code === 'SNAPSHOT_STALE' || retryableBootstrapFailure(err))) continue; // 整包重建一次（仅快照失效/瞬时；授权拒绝重建无意义）
        report([], err.code);
        return UNAVAILABLE_TEXT;
      }
    }
    return null;
  }

  /** F-J-09：本窗冻结的工具快照（首发时定格，后续轮/评审/续请求复用） */
  // R2（2026-10-23，E08）：每窗冻结的 reasoning 继续态政策（schema 36；详见 ds-replay-policy.ts）
  private readonly reasoningPolicyCache = new Map<string, ReasoningReplayPolicy>();
  private reasoningPolicyOf(windowId: string): ReasoningReplayPolicy {
    let policy = this.reasoningPolicyCache.get(windowId);
    if (!policy) {
      policy = storedReasoningReplayPolicy(this.d.db.prepare('SELECT reasoning_replay_policy FROM windows WHERE id = ?').get(windowId) as { reasoning_replay_policy?: string | null } | undefined);
      this.reasoningPolicyCache.set(windowId, policy);
    }
    return policy;
  }
  private windowTools(windowId: string): import('./or-payload.ts').OrTool[] {
    let t = this.frozenToolsByWindow.get(windowId);
    if (!t) {
      t = freezeWindowTools(this.d.db, windowId, buildHostTools(), this.d.config.runtime.tool_schema_mode) as unknown as import('./or-payload.ts').OrTool[];
      this.frozenToolsByWindow.set(windowId, t);
    }
    return t;
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
    materials: { identityText: string; rulesText: string; iText: string | null } | null;
    dialogue: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }>;
    tailUserText: string;
    bootText?: string | null;
    /** WP3（2026-10-08）：人工选集装配——严格按确认的引用集合装载（E04：
     *  不把"自动携带预算设 0"代替拆分——该预算键已随 WP5 退役）。给出即忽略
     *  dialogue 的自动预算挑选；可为空数组=明确空选（不带历史）。 */
    selectedMessages?: Array<{ message_id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; occurred_at?: string | null; reference_at?: string }>;
    /** EXEC_V1 §03.6：当前输入消息（投影其附件进尾部；缺省=纯文本尾） */
    tailMessage?: { id: string; revision: number } | null;
  }): { envelope: OrRequestEnvelope; selected: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }>; hasImage: boolean; hasVoiceWithoutTranscript: boolean } {
    const dv = this.drv()!;
    const systemText = [o.materials?.identityText ?? '', o.materials?.iText ?? '', o.materials?.rulesText ?? '', FIXED_RUNTIME_FRAGMENT, HOST_BOUNDARY_RULES].filter((t) => t.length > 0).join('\n\n');
    const messages: OrMessage[] = [
      { role: 'system', content: [{ type: 'text', text: systemText }] },
    ];
    // R11（复审 2026-10-07）：B（开窗资料）作为独立 system 数据块——显式
    // A/B 缓存分界（cache-plan 的 B 点分支要求 systemMessageCount>=2），
    // 不把外部资料并入 A 段升级成高优先级指令
    if (o.bootText && o.bootText.length > 0) {
      messages.push({ role: 'system', content: [{ type: 'text', text: o.bootText }] });
    }
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
    // 2026-10-18 她的裁定：多选只带文本——选集历史投影 textOnly（图片以占位文本带入，
    // 不产视觉块、不触发视觉门）；尾部当前输入与追赶投影不受影响（当前轮的图照常进模型）
    let envHasImage = false;
    const guides = selectionGuides(o.selectedMessages ?? []);
    for (const m of selected) {
      const guide = guides.get(m.sequence);
      if (guide) messages.push({ role: 'system', content: [{ type: 'text', text: guide }] });
      const proj = this.revisionBlocks(m.id, m.revision, m.content, { textOnly: true, seq: m.sequence, transcriptContinuationAvailable: this.windowHasTool(o.windowId, 'transcript_read') });
      envHasImage = envHasImage || proj.hasImage;
      messages.push({ role: m.role, content: proj.blocks } as unknown as { role: string; content: Array<{ type: 'text'; text: string }> });
    }
    // 尾部当前输入也带 [seq]（她本轮的消息同样可被勾选）；无消息实体时（如
    // 保温空尾）不带序号
    const tailSeq = o.tailMessage?.id
      ? (this.d.db.prepare('SELECT sequence FROM messages WHERE id = ?').get(o.tailMessage.id) as { sequence: number } | undefined)?.sequence
      : undefined;
    const tailProj = this.revisionBlocks(o.tailMessage?.id ?? null, o.tailMessage?.revision ?? null, o.tailUserText, { isCurrentInput: true, hearingAvailable: oidoHearingAvailable(this.d.db, this.d.oidoHearing === true, o.windowId), transcriptContinuationAvailable: this.windowHasTool(o.windowId, 'transcript_read'), ...(tailSeq !== undefined ? { seq: tailSeq } : {}) });
    envHasImage = envHasImage || tailProj.hasImage;
    messages.push({ role: 'user', content: tailProj.blocks } as unknown as { role: string; content: Array<{ type: 'text'; text: string }> });
    return {
      hasImage: envHasImage,
      hasVoiceWithoutTranscript: tailProj.hasVoiceWithoutTranscript,
      envelope: {
        model: dv.model,
        sessionId: dv.sessionId(o.conversationId),
        messages,
        tools: (this.d.config.runtime.tool_schema_mode === 'legacy' ? buildHostTools() : buildDeferredTools()) as unknown as import('./or-payload.ts').OrTool[],
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
    materials: { identityText: string; rulesText: string; iText: string | null } | null;
    cause?: RotationCause; // Persisted server intent; absent only during capacity evaluation.
    preserveWindow?: boolean; // Explicit retry may block on capacity but never rotates/rebuilds history.
  }): Promise<{ rotated: boolean; blocked: string | null }> {
    const d = this.d;
    const dv = this.drv();
    if (!dv && !o.cause) return { rotated: false, blocked: null };

    // F06：评审范围的实际已见清单优先取轨迹 manifest（真实发送证据）；无轨迹时退化为库投影。
    const dialogue = this.dialogueUpTo(o.conversationId, o.currentInputSequence - 1);
    // §11.1 估计：本地粗估 + 上次实际 usage 校准；精度如实标注。
    // D06（审计 3655d60）：**旧窗工作集不含新入站消息**——硬门只判旧窗自身是否无可挽回（blocked_hard）；
    // 新消息长度只并入"下一输入"预测触发换窗（§4.2：大输入先保存、先提醒旧窗、新输入只进新窗一次）。
    // 新窗装下新输入的最终校验由工具循环每轮的 P2 容量门承担（F03 尾），真实硬门不放松。
    const currentInputLen = (d.db.prepare(
      `SELECT LENGTH(r.content) AS len FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       WHERE m.conversation_id = ? AND m.sequence = ?`,
    ).get(o.conversationId, o.currentInputSequence) as { len: number | null } | undefined)?.len ?? 0;
    // 审计 F25：估算只用实际发送集合——轨迹正本（无轨迹的新窗首轮回退库内近期，此时二者一致）。
    // 被拒/未发送的历史大消息不得污染当前工作集（否则短输入被持续 CAPACITY_BLOCKED_HARD）。
    const trajForEstimate = d.trajectory?.forWindow(o.window.id) ?? null;
    const sentChars = trajForEstimate
      ? trajForEstimate.messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0)
      : dialogue.reduce((s, m) => s + m.content.length, 0);
    // F-J-33：估算含 I——无轨迹回退路径此前漏计 iText（轨迹路径略保守高估，方向安全不动）
    const systemChars = (o.materials?.identityText.length ?? 0) + (o.materials?.rulesText.length ?? 0) + (o.materials?.iText?.length ?? 0) + FIXED_RUNTIME_FRAGMENT.length + HOST_BOUNDARY_RULES.length;
    const oldWindowEstimate = Math.ceil((sentChars + systemChars) / (dv?.charsPerToken ?? 1.5)); // 旧窗自身工作集
    const lastActual = (d.db.prepare(
      `SELECT u.input_tokens FROM usage_observations u JOIN attempts a ON a.id = u.attempt_id
       WHERE a.window_id = ? AND u.input_tokens IS NOT NULL AND u.completeness = 'complete' ORDER BY u.observed_at DESC LIMIT 1`,
    ).get(o.window.id) as { input_tokens: number } | undefined)?.input_tokens ?? null;
    const workingSet = Math.max(oldWindowEstimate, lastActual ?? 0);
    // R21（复审 2026-10-07）：下一输入=旧工作集+本轮新增输入（system 只计
    // 一次）——此前 Math.max(workingSet, incomingEstimate) 漏加本轮输入，
    // 临界消息在旧窗超软线却不触发提醒/换窗（既有问题，硬门不受影响）
    const nextWithIncoming = workingSet + Math.ceil(currentInputLen / (dv?.charsPerToken ?? 1.5));

        // 2026-10-08 晚间她裁定：6h 静默触发已删除（睡觉≠换窗；换窗唯一自动基线=容量软线，2026-10-17 起 600k 兜底）
    const capacity = d.config.windows.model_context_capacity ?? Number.MAX_SAFE_INTEGER; // 未测量：容量触发按上限禁用（不画假百分比）。6h idle 触发已退役（2026-10-08）——唯一自动换窗基线=容量软线（600k 兜底）
    let plan: ReturnType<typeof rotationPlan> | null = null;
    if (!o.cause) {
      plan = rotationPlan({
        currentInput: workingSet, // D06：旧窗自身（硬门判这个）
        nextInput: nextWithIncoming, // 新消息并入下一输入预测（触发先提醒再换窗，不直接堵死）
        capacity,
        maxOutput: dv!.maxTokens,
        toolReserve: d.config.windows.tool_input_reserve_tokens,
        reviewReserve: d.config.windows.review_reserve_tokens,
        safety: d.config.windows.safety_reserve_tokens,
        soft: d.config.windows.soft_limit_tokens,
      });
      // WP5（2026-10-08 §1.5 她裁定）：容量预警推送/展示退役——不再发布
      // 预警事件；软线计算（rotate 触发）与硬门（blocked_hard）照常保留。
      // bootstrap 不可用/缓存保护未覆盖等其他 context.warning 诊断不受影响。
      // 审计 F03：blocked_hard 是硬门——超安全输入上界不得继续发送；交调用方按待恢复收口，不静默放行
      if (plan.action === 'blocked_hard') {
        return { rotated: false, blocked: `CAPACITY_BLOCKED_HARD:当前输入估计 ${workingSet} 超过安全输入上界 ${plan.safeInput}（C-O-T-R-S），输入已保存待恢复` };
      }
      if (plan.action !== 'rotate') return { rotated: false, blocked: null };
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

    const fingerprintChanged = o.window.context_fingerprint && o.window.context_fingerprint !== contextFingerprint(this.fingerprintConfigView(d.config), o.gate.manifest);
    if (reason !== 'capacity' || fingerprintChanged || !dv) {
      d.events.publish('context.warning', { conversationId: o.conversationId, entityRef: o.window.id, scope: 'private', payload: { code: reason === 'manual' ? 'manual_review_bypassed' : 'identity_or_transport_review_unavailable', reason } });
      return this.doRotate(o, reason, null, selectionId);
    }

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
    // §3.3 有界恢复（审计 P2-1）：同窗评审失败达上限后不再自动发评审（每次评审都是真实付费请求）。
    // 恢复路径：评审成功换新窗（新窗计数自动重置）或人工处理（修提示/型号后手动换窗）。
    const failedReviews = (d.db.prepare("SELECT COUNT(*) n FROM rotation_reviews WHERE window_id = ? AND status = 'failed'").get(o.window.id) as { n: number }).n;
    if (failedReviews >= MAX_WINDOW_REVIEW_ATTEMPTS) {
      return { rotated: false, blocked: `ROTATION_REVIEW_RETRY_EXHAUSTED:本窗评审已失败 ${failedReviews} 次（上限 ${MAX_WINDOW_REVIEW_ATTEMPTS}），不再自动评审——请检查模型对提醒的响应或手动换窗；输入已保存待恢复` };
    }
    const review = d.reviews.create(o.window.id, o.conversationId, o.window.revision, range);
    d.events.publish('review.sent', { conversationId: o.conversationId, entityRef: review.id, scope: 'private', payload: { window_id: o.window.id, reason, focus_count: range.length } });

    // —— §8.1 一次提醒（synthetic user 尾部；宿主隐藏普通输出；purpose=pre_rotate_review）——
    // 轨迹正本优先（模型看见的就是它看过的协议历史）；无轨迹时退化为 system+近期原话投影。
    const traj = trajEarly;
    // F-J-39 + R12：评审正文追赶投影=同一份 unifiedCatchup（与范围/已见清单
    // 同源——失败回合的已发输入/已发布原话有真实派发证据，属"截至本次已
    // 携带高水位"）
    const reviewCatchup = unifiedCatchup;
    const reviewCatchupMessages: OrMessage[] = reviewCatchup.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] }) as unknown as OrMessage);
    const reviewBaseMessages: OrMessage[] = traj ? [...traj.messages, ...reviewCatchupMessages] : []; // 无轨迹已在上方阻断——此分支不可达
    const reviewMessages: OrMessage[] = [...reviewBaseMessages, { role: 'user', content: [{ type: 'text', text: buildPreRotateReviewMessage({ reviewId: review.id, reason, messageRefs: rangeKeys.join(', ') }) }] }];
    const { boundaries: reviewBoundaries, gDropped: reviewGDropped } = planBoundaries({ messages: reviewMessages, systemMessageCount: fixedSystemCount(reviewMessages), prevBoundary: traj?.lastBoundary ?? null });
    // F-J-32：G 保护点被丢弃时发脱敏观察事件（§7.2"保护未覆盖"可观测）
    if (reviewGDropped) {
      d.events.publish('context.warning', { conversationId: o.conversationId, entityRef: o.window.id, scope: 'private', payload: { source: 'cache', code: 'g_dropped' } });
    }
    const envelope: OrRequestEnvelope = {
      model: dv.model,
      sessionId: dv.sessionId(o.conversationId),
      messages: reviewMessages,
      // F-J-09：评审请求同窗复用冻结工具快照（epoch 内 tools 恒定）
      tools: this.windowTools(o.window.id),
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
    const quietEvent = (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: { requestId: string | null }): void => {
      // 评审请求不发布正文/思考（§8.1）；只记账 usage 与终态（F12：真实 turn 归属 + 请求身份）
      if (ev.kind === 'usage') {
        d.usage.record({ turnId: reviewTurnId, attemptId: o.attemptId, requestId: reqCtx?.requestId ?? undefined, windowId: o.window.id, scope: ev.scope, usage: ev.usage, model: dv.model, source: ev.source, completeness: ev.completeness }); // F31：评审费用按窗口归属（D10 修复：此前误传不存在的 o.windowId → 恒 NULL）
      }
    };
    const seenHighWater = effectiveManifest.length > 0 ? Math.max(...effectiveManifest.map((m) => m.seq)) : 0;
    let result: import('./runner.ts').RunnerRunResult;
    try {
      ({ result } = await this.runOrToolLoop({
        envelope, purpose: 'pre_rotate_review', activeReviewId: review.id,
        conversationId: o.conversationId, windowId: o.window.id,
        turnId: null, attemptId: o.attemptId, controller, onEvent: quietEvent, seenSequence: seenHighWater,
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
    if (latestGate.state !== 'READY' || contextFingerprint(this.fingerprintConfigView(this.d.config), latestGate.manifest) !== contextFingerprint(this.fingerprintConfigView(this.d.config), o.gate.manifest)) return { rotated: false, blocked: 'IDENTITY_CHANGED_DURING_PREPARE' };
    const rotated = this.d.windows.rotate({ conversationId: o.conversationId, expectedWindowId: o.window.id, gate: o.gate, maxSequence: o.currentInputSequence - 1, assembledOptions: null, selectionId: selectionId ?? undefined, initialTrajectory, ...(resolveReasoningReplayPolicy({ provider: this.d.config.runtime.provider, deepseek: this.d.config.deepseek }) === 'ds_tools_all_turns_v1' ? { reasoningPolicy: 'ds_tools_all_turns_v1' as const } : {}) });
    if (!rotated.ok) return { rotated: false, blocked: `ROTATE_PREPARE_FAILED:${rotated.reason.slice(0, 80)}` };
    if (o.window.context_fingerprint !== rotated.window.context_fingerprint) this.d.db.prepare("UPDATE windows SET blocked_reason='ROTATED_CONTEXT_STALE' WHERE id=?").run(o.window.id);
    // pending 键上的 bootstrap 缓存迁移到真实窗 id（同窗不重复拉）
    const pendingBoot = this.bootstrapByWindow.get(`pending:${o.conversationId}`);
    if (pendingBoot !== undefined) {
      this.bootstrapByWindow.set(rotated.window.id, pendingBoot);
      this.bootstrapByWindow.delete(`pending:${o.conversationId}`);
    }
    this.d.events.publish('window.rotated', { conversationId: o.conversationId, entityRef: rotated.window.id, scope: 'private', payload: { reason, review_id: reviewId, selection_id: selectionId } });
    return { rotated: true, blocked: null };
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
    const boot = await this.windowBootstrap(`pending:${conversationId}`);
    const sel = selectionId && d.selections ? d.selections.get(selectionId) : null;
    const built = this.buildEnvelope({
      conversationId,
      materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null,
      bootText: boot,
      dialogue: [],
      tailUserText: ' ',
      selectedMessages: d.selections && sel ? d.selections.loadForProjection(sel) : [],
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
    if (!dv) {
      // SDK 驱动（无信封映射）：粗估回退——不做选集级容量预检（请求级
      // 容量门仍在 SDK 侧），系统段记 0、界=不设限；tokenizer 未知=rough
      return { charsPerToken: 1.5, systemChars: 0, tailInputChars, capacityBoundTokens: Number.MAX_SAFE_INTEGER };
    }
    const gate = d.identity.evaluateGate(d.db, { driver: dv.kind });
    const materials = gate.state === 'READY' && gate.manifest ? d.identity.loadVerifiedMaterials(gate.manifest) : null;
    const systemChars = (materials?.identityText.length ?? 0) + (materials?.rulesText.length ?? 0) + (materials?.iText?.length ?? 0) + FIXED_RUNTIME_FRAGMENT.length + HOST_BOUNDARY_RULES.length;
    const w = d.config.windows;
    const capacity = w.model_context_capacity ?? Number.MAX_SAFE_INTEGER;
    const bound = Math.min(w.soft_limit_tokens, capacity - dv.maxTokens - w.tool_input_reserve_tokens - w.review_reserve_tokens - w.safety_reserve_tokens);
    return { charsPerToken: dv.charsPerToken, systemChars, tailInputChars, capacityBoundTokens: Math.max(0, bound) };
  }

  /** 选择面截止水位：最后一条"已了结"消息（其 turn 非 pending/blocked）——
   *  待回答与排队输入不得作为历史带入（H04）。 */
  private selectionCutoffSequence(conversationId: string): number {
    const row = this.d.db.prepare(
      `SELECT MAX(m.sequence) AS m FROM messages m
       LEFT JOIN turns t ON t.input_message_id = m.id
       WHERE m.conversation_id = ? AND (t.id IS NULL OR t.state NOT IN ('pending','blocked'))`,
    ).get(conversationId) as { m: number | null };
    return row?.m ?? 0;
  }

  /** 待回答/排队输入的总字符（容量估计并入"当前待回答输入"，H04/H05）。 */
  private selectionPendingInputChars(conversationId: string): number {
    const row = this.d.db.prepare(
      `SELECT COALESCE(SUM(LENGTH(r.content)), 0) AS chars FROM messages m
       JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       JOIN turns t ON t.input_message_id = m.id
       WHERE m.conversation_id = ? AND (t.state = 'pending' OR (t.state = 'blocked' AND EXISTS (SELECT 1 FROM attempts a WHERE a.turn_id=t.id AND a.state='blocked' AND (a.blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' OR a.blocked_reason LIKE 'CONTEXT_ROTATION_REQUIRED%'))))`,
    ).get(conversationId) as { chars: number };
    return row?.chars ?? 0;
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
            if (latestGate.state !== 'READY' || contextFingerprint(this.fingerprintConfigView(d.config), latestGate.manifest) !== contextFingerprint(this.fingerprintConfigView(d.config), gate.manifest)) throw new Error('IDENTITY_CHANGED_DURING_PREPARE');
            const created = d.windows.createWindow({ conversationId, gate, assembledOptions: null, selectionId: selId, initialTrajectory: prepared, ...(resolveReasoningReplayPolicy({ provider: d.config.runtime.provider, deepseek: d.config.deepseek }) === 'ds_tools_all_turns_v1' ? { reasoningPolicy: 'ds_tools_all_turns_v1' as const } : {}) });
            rot = created.window.status === 'ACTIVE' ? { ok: true, windowId: created.window.id } : { ok: false, reason: created.blockedReason ?? '建窗失败' };
            // RRA-015（2026-10-09 复审）：无活动窗恢复分支同样迁移 pending
            // bootstrap 缓存到真实窗 id 并清 pending——此前只 doRotate 迁移，
            // 连续模型恢复的第二/三窗复用第一次的旧 B（违反新窗必拉最新）
            if (created.window.status === 'ACTIVE') {
              const pendingBoot = this.bootstrapByWindow.get(`pending:${conversationId}`);
              if (pendingBoot !== undefined) {
                this.bootstrapByWindow.set(created.window.id, pendingBoot);
                this.bootstrapByWindow.delete(`pending:${conversationId}`);
              }
            }
          } catch { rot = { ok: false, reason: 'ROTATE_COMMIT_FAILED' }; }
        }
      }
      if (!rot || !rot.ok) return { ok: false as const, reason: rot?.reason ?? 'ROTATION_NOT_COMMITTED', resumed: 0 };
      const rows = d.db.prepare(
        "SELECT DISTINCT t.id FROM turns t JOIN attempts a ON a.turn_id = t.id AND a.state='blocked' AND (a.blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' OR a.blocked_reason LIKE 'CONTEXT_ROTATION_REQUIRED%') WHERE t.conversation_id = ? AND t.state='blocked'",
      ).all(conversationId) as Array<{ id: string }>;
      for (const r of rows) {
        tx(d.db, () => {
          d.db.prepare("UPDATE attempts SET state='pending', blocked_reason=NULL WHERE turn_id=? AND state='blocked' AND (blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' OR blocked_reason LIKE 'CONTEXT_ROTATION_REQUIRED%')").run(r.id);
          d.db.prepare("UPDATE turns SET state='pending', completed_at=NULL WHERE id=? AND state='blocked'").run(r.id);
        });
        this.enqueue(r.id); // 链尾排队（当前串行任务结束后执行）
      }
      return { ok: true as const, windowId: rot.windowId, resumed: rows.length };
    });
  }

  async manualRotate(conversationId: string, expectedWindowId?: string): Promise<{ ok: true; windowId: string } | { ok: false; reason: string }> {
    // 审计 F05：手动换窗占用房间串行链——与 turn/自动评审/另一个手动调用互斥，
    // 评审等待期间新 chat 排队而非并发发送
    return this.runSerialized(conversationId, async () => {
      if (expectedWindowId && this.d.windows.activeWindow(conversationId)?.id !== expectedWindowId) {
        return { ok: false as const, reason: 'WINDOW_STALE:目标窗口已不再活动' };
      }
      return this.rotateConfirmed(conversationId, 'manual', true);
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
      d.events.publish('context.warning', { conversationId, entityRef: selection.selection_id, scope: 'private', payload: { code: 'manual_rotation_requested', previous_cause: prior?.rotation_cause ?? null, source_window_id: window.id } });
    }
    const materials = gate.manifest ? d.identity.loadVerifiedMaterials(gate.manifest) : null;
    const r = await this.rotateIfNeeded({ conversationId, window, gate, currentInputSequence: cutoff + 1,
      attemptId: 'rotation-resume', turnId: null,
      materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null,
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
    const workspacesDir = buildPaths(resolveStateRoot(process.env.ESTOMAGO_HOME)).workspacesDir;
    const built = dv ? null : buildSdkOptions({ config: d.config, gate, identityText: materials?.identityText ?? null, approvedRulesText: materials?.rulesText ?? null, cwd: workspacesDir });
    if (d.runnerSelection.status === 'blocked') {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, `RUNTIME_NOT_READY:${d.runnerSelection.reasons.map(codeOf).join(';')}`, 'blocked');
      return;
    }
    if (built !== null && built.status === 'blocked') {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, `IDENTITY_NOT_READY:${built.reasons.map(codeOf).join(';').slice(0, 120)}`, 'blocked');
      return;
    }
    if (dv !== null && (!materials?.identityText || !materials?.rulesText)) {
      // §2.1：信封驱动（OR/DS）首条生成前必须有批准身份/规则材料——与 SDK 同一 gate，不提供默认人格
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'IDENTITY_NOT_READY:ENVELOPE_DRIVER_MISSING_APPROVED_MATERIALS', 'blocked');
      return;
    }
    if (dv !== null && !materials?.iText) {
      // 审计 F02：当前 I 必须完整进入固定前缀（§5.1/§7.1）——缺必需 I 时阻断，不静默降级
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'IDENTITY_NOT_READY:ENVELOPE_DRIVER_MISSING_I', 'blocked');
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
      d.windows.createWindow({ conversationId: turn.conversation_id, gate, assembledOptions: built ? built.assembled : null, ...(resolveReasoningReplayPolicy({ provider: d.config.runtime.provider, deepseek: d.config.deepseek }) === 'ds_tools_all_turns_v1' ? { reasoningPolicy: 'ds_tools_all_turns_v1' as const } : {}) });
      window = d.windows.activeWindow(turn.conversation_id);
      if (!window) {
        this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'NO_ACTIVE_WINDOW', 'blocked');
        return;
      }
    }
    // §7 AUD：人格/运行边界指纹变化 → 旧窗 CONTEXT_STALE，禁止 resume 旧 session
    // 2026-10-08：指纹按生效视图（含 or_model override；reasoning 已不参与指纹——
    // 换思考深度不换窗，上下文全复用）
    const expectedFingerprint = contextFingerprint(this.fingerprintConfigView(d.config), gate.manifest);
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
      if (!attempt.retry_window_id && d.trajectory.discardUnsent(window.id)) this.bootstrapByWindow.delete(window.id);
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
        const boot0 = await this.windowBootstrap(window.id, prepSignal);
        if (stoppedDuringPreparation()) return;
        const sel0 = d.selections?.forTargetWindow(window.id) ?? null;
        const built0 = sel0
          ? this.buildEnvelope({ conversationId: turn.conversation_id, windowId: window.id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, bootText: boot0, dialogue: [], tailUserText: ' ', selectedMessages: d.selections!.loadForProjection(sel0) })
          : this.buildEnvelope({ conversationId: turn.conversation_id, windowId: window.id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, bootText: boot0, dialogue: baseDialogue, tailUserText: ' ' });
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
        materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null,
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
        if (d.trajectory) {
          const nextTraj = d.trajectory.forWindow(window.id);
          if (!nextTraj) {
            const baseDialogue = this.dialogueUpTo(turn.conversation_id, inputMessage.sequence - 1);
            const bootR = await this.windowBootstrap(window.id, prepSignal);
            if (stoppedDuringPreparation()) return;
            // WP3：换窗后的新窗按消费的选集装配（选集在 doRotate 同事务
            // 绑定 target_window_id；无命中=兼容期自动回退）
            const selR = d.selections?.forTargetWindow(window.id) ?? null;
            const builtR = selR
              ? this.buildEnvelope({ conversationId: turn.conversation_id, windowId: window.id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, bootText: bootR, dialogue: [], tailUserText: ' ', selectedMessages: d.selections!.loadForProjection(selR) })
              : this.buildEnvelope({ conversationId: turn.conversation_id, windowId: window.id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, bootText: bootR, dialogue: baseDialogue, tailUserText: ' ' });
            const baseManifest = builtR.selected.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
            d.trajectory.init(window.id, builtR.envelope.messages.slice(0, -1), baseManifest);
          }
        }
      }
    }
    // route-edit 的新 attempt（fresh_session=1）：不 resume 旧 session——修订输入全新开跑，
    // 旧 session 历史含被替代的旧触发，定点排除语义未实测前不得带旧触发重跑。
    // 信封驱动（OR/DS）无宿主可见 resume 语义（session_id 是内部关联标识，不存历史）→ 恒 null。
    const resumeSessionId = dv ? null : attempt.fresh_session ? null : window.sdk_session_id;

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
      payload: { state: 'running', attempt_no: attempt.attempt_no, generation, resume_session: Boolean(resumeSessionId) },
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
    let surfacingAugment: import('../memory-surfacing/service.ts').AugmentResult | null = null;
    if (d.surfacing && supportsSurfacingTransport(this.drv()?.kind ?? '') && inputMessage && inputMessage.speaker === 'owner') {
      try {
        const candidate = d.surfacing.reuseFrozen(attempt.id) ?? await d.surfacing.augmentFor({
          conversationId: turn.conversation_id, windowId: window.id, turnId,
          attemptId: attempt.id,
          message: { id: inputMessage.id, revision: effective.revision, sequence: inputMessage.sequence, content: effective.content, hash: effective.hash },
        });
        surfacingAugment = candidate;
      } catch {
        surfacingAugment = null; // 复核失败=本轮零注入，正常聊天不受影响（docs/08）
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
    const programFact = inputMessage ? null : (d.db.prepare('SELECT fact_text, kind FROM program_fact_turns WHERE turn_id = ?').get(turnId) as { fact_text: string; kind: string } | undefined ?? null);
    const prompt = [
      ...assembledContext.segments.map((seg) => `[${seg.source}]${seg.source === 'time_context' ? '（宿主注入的程序事实，不是用户发言）' : ''}\n${seg.text}`),
      ...(programFact ? [`[program_fact]（宿主注入的程序事实，不是用户发言）\n${programFact.fact_text}`] : []),
    ].join('\n\n');
    // SDK has no host tool bridge; automatic surfacing remains unsupported.
    const sdkPrompt = prompt;
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
    const catchupMessages: OrMessage[] = catchup.map((m) => ({ role: m.role, content: this.revisionBlocks(m.id, m.revision, m.content, { seq: m.sequence, transcriptContinuationAvailable: catchupContinuation }).blocks }) as unknown as OrMessage);
    const catchupManifest: ManifestEntry[] = catchup.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
    // WP-07（CX-07）：无轨迹 fallback 必须携带该窗已确认选集（选集为空
    // 数组=只发待答输入）——杜绝 dialogueUpTo 全量装配进入新窗（历史
    // 进新窗唯一途径=人工选集；同窗无轨迹的正常首轮已在上方懒初始化
    // 补建轨迹，到这里的 fallback 只剩轨迹意外缺失场景）
    const fallbackSel = dv && d.selections ? d.selections.forTargetWindow(window.id) : null;
    const fallbackBuild = (!orTraj && dv)
      ? this.buildEnvelope({
          conversationId: turn.conversation_id,
          materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null,
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
    const tailProjection = this.revisionBlocks(inputMessage?.id ?? null, effective.revision, prompt, { isCurrentInput: true, hearingAvailable: oidoHearingAvailable(this.d.db, this.d.oidoHearing === true, window.id), transcriptContinuationAvailable: this.windowHasTool(window.id, 'transcript_read') });
    // Host memory is separate from the real input. OR uses explicitly labelled
    // user-channel data; DS retains its system data message. Only the tail grows.
    const hostMemory: OrMessage[] = surfacingAugment
      ? [surfaceTransportMessage(this.drv()?.kind ?? '', surfacingAugment.text)] : [];
    const orMessages: OrMessage[] = [...orBaseMessages, ...hostMemory,
      { role: 'user', content: tailProjection.blocks } as OrMessage];
    const orEnvelope: OrRequestEnvelope | null = dv
      ? (() => {
          // R11：systemMessageCount 按实际（B 独立数据块时=2，cache-plan
          // 的独立 B 点分支由此生效；此前硬编码 1，B 点显式边界从未成立）
          const { boundaries, gDropped } = planBoundaries({ messages: orMessages, systemMessageCount: fixedSystemCount(orBaseMessages), prevBoundary: orTraj?.lastBoundary ?? null });
          if (gDropped) {
            d.events.publish('context.warning', { conversationId: turn.conversation_id, entityRef: window.id, scope: 'private', payload: { source: 'cache', code: 'g_dropped' } });
          }
          return {
            model: dv.model,
            sessionId: dv.sessionId(turn.conversation_id),
            messages: orMessages,
            // F-J-09：本窗冻结快照（首发定格；词表中途变化不改变本窗 tools）
            tools: this.windowTools(window.id),
            boundaries,
            maxTokens: dv.maxTokens,
            reasoning: dv.reasoning,
          };
        })()
      : null;
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
          if (wireMsgs.length > trajSide.length) throw new Error(`WIRE_HISTORY_SHORTENED:${wireMsgs.length}>${trajSide.length}`);
          const dsPolicy = this.reasoningPolicyOf(window.id);
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
              if (k === 'cache_control' || k === 'reasoning_content') continue; // 缓存标记随轮次变化；继续态按政策单独核对
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
              const wireHas = typeof w.reasoning_content === 'string' && w.reasoning_content.length > 0;
              const trajHas = typeof t.reasoning_content === 'string' && t.reasoning_content.length > 0;
              if (dsPolicy === 'ds_tools_all_turns_v1') {
                if (wireHas !== trajHas) throw new Error(`WIRE_TRAJECTORY_DIVERGED:reasoning@${i}`);
                if (wireHas && w.reasoning_content !== t.reasoning_content) throw new Error(`WIRE_TRAJECTORY_DIVERGED:reasoning_text@${i}`);
              } else if (trajHas) {
                // legacy：跨轮轨迹不得携带继续态（D01 剥除必须一致执行；wire 同轮有、轨迹无=正常）
                throw new Error(`WIRE_TRAJECTORY_DIVERGED:legacy_reasoning_leak@${i}`);
              }
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
      if (!runToken.token.cancelled) this.voiceTaps.get(turnId)?.(tail);
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
      // 2026-10-19 她报障：模型把消息序号标记学舌进回复开头（前端可见）。
      // 发表层剥除段首标记（[N]/[seq N] 形态）——提示词已禁写，这里是保险层
      const stripped = segs.map((s) => s.replace(/^(\[seq ?\d+\]|\[\d+\])\s*/, ''));
      for (const seg of stripped) {
        if (runToken.token.cancelled) return;
        let msg: ReturnType<import('../messages/service.ts').MessageService['getMessage']> | null;
        if (turnAssistantMessageId === null) {
          msg = d.messages.publishAssistantMessage({ conversationId: turn.conversation_id, turnId, content: seg });
          turnAssistantMessageId = msg.id;
          turnManifestAdditions.push({ id: msg.id, revision: 1, seq: msg.sequence, origin: 'dialogue', visible: true });
        } else {
          msg = d.messages.appendAssistantPublication(turnAssistantMessageId, seg);
          if (msg === null) continue;
        }
        d.events.publish('message.published', {
          conversationId: turn.conversation_id, turnId, entityRef: msg.id, entityRevision: msg.sequence,
          payload: { message: msg },
        });
      }
    };

    const handleRouteSignal = (): void => {
      if (routeSignalHandled) return;
      routeSignalHandled = true;
      runToken.token.cancelled = true; // fence 立即生效（AUD-05：迟到输出不得发布）
      // 控制序列：持久票据 + generation fence + attempt/turn 状态，同一事务（事件在提交后发布）
      let ticketId: string | null = null;
      try {
        tx(d.db, () => {
          const ticket = d.routing.createPendingInTx({
            conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
            inputHash, targetModel: null, evidenceCode: 'SDK_ROUTE_SIGNAL',
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
        payload: { decision_id: ticketId, current_model: null, target_model: null, evidence_code: 'SDK_ROUTE_SIGNAL', already_switched: false, affects_future_sessions: null },
      });
      runToken.controller.abort(); // 通知 runner 停止
      d.reasoning.markAttemptFinal({ attemptId: attempt.id, final: 'interrupted', generation });
    };

    // §6.3：驱动判别请求——同一 handleEvent（发布/记账/route 语义对两驱动一致，不复制两套处理）
    const handleEvent = (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: { requestId: string | null }): void => {
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
                model: actualModelForUsage ?? configuredModelForUsage, // F10：观测到实际模型后按实际值；OR 用明确型号
                source: ev.source, completeness: ev.completeness,
              });
              // EXEC_V1 §04.5（WP2）：缓存证据观测——温态五条件门活接线（字段缺失/无派发起点=不评）
              if (d.alerts && reqCtx?.requestId && ev.scope === 'request') {
                try {
                  const prq = d.db.prepare('SELECT dispatch_started_at FROM provider_requests WHERE id = ?').get(reqCtx.requestId) as { dispatch_started_at: string | null } | undefined;
                  observeCacheUsage(d.alerts, {
                    db: d.db, windowId: window.id, requestId: reqCtx.requestId,
                    model: actualModelForUsage ?? configuredModelForUsage,
                    readTokens: ev.usage.cache_read_input_tokens ?? null,
                    writeTokens: ev.usage.cache_creation_input_tokens ?? null,
                    inputTotal: ev.usage.input_tokens ?? null,
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
              if (ev.subtype === 'model_refusal_fallback' || ev.subtype === 'model_refusal_no_fallback') {
                const actualModel = ev.subtype === 'model_refusal_fallback' ? (ev.fallback_model ?? null) : null;
                try {
                  d.routing.recordSdkRouteEvent({
                    conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
                    subtype: ev.subtype, originalModel: ev.original_model, actualModel,
                  });
                } catch (err) {
                  d.logger.error('route_event_tx_failed', { turn_id: turnId, code: stableCode(err) });
                }
                if (actualModel) {
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
    let orToolSeen: ManifestEntry[] = []; // WP4：conversation_read 片段已见（实际进入请求的部分）
    if (orEnvelope !== null) {
      // EXEC_V1 §03.6（WP3/M2）媒体门：当前输入无转写语音→不空输入唤起模型；
      // 含图但型号未核实视觉→MODEL_VISION_UNAVAILABLE（消息已保存、零模型请求、不静默丢图/换模型）
      const orHasImage = orMessages.some((m) => Array.isArray((m as { content: unknown }).content) && ((m as { content: Array<Record<string, unknown>> }).content.some((b) => b && b.type === 'asset_image')));
      const tailVoiceBlocked = fallbackBuild ? fallbackBuild.hasVoiceWithoutTranscript : tailProjection.hasVoiceWithoutTranscript;
      let mediaBlockedCode: string | null = null;
      if (d.media) {
        if (tailVoiceBlocked) mediaBlockedCode = 'MEDIA_TRANSCRIPTION_FAILED';
        else if (orHasImage) {
          // 2026-10-18：config 人工声明优先于目录发现——图片能力是公开静态事实，
          // 运行时目录查询在发消息关键路径上失败曾致连续阻断（证据只存进程内存、重启清零）
          const declaredVision = d.config.openrouter.vision_supported_models.includes(orEnvelope.model);
          let vision: boolean | null = declaredVision ? true : visionSupportCached(orEnvelope.model, d.config.openrouter.base_url);
          if (vision === null && !declaredVision && d.runnerSelection.status === 'ok' && d.runnerSelection.runner.kind === 'openrouter') {
            vision = await refreshVisionSupport(d.config.openrouter.base_url, orEnvelope.model);
          }
          if (vision !== true) mediaBlockedCode = 'MODEL_VISION_UNAVAILABLE';
        }
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
        conversationId: turn.conversation_id, windowId: window.id,
        turnId, attemptId: attempt.id, controller: runToken.controller,
        trajectoryRebuiltThisTurn: trajInitializedThisTurn,
        onEvent: handleEvent, seenSequence: orSeenHighWater,
        seenMessages: orSeenBase, liveSeenAdditions: turnManifestAdditions, // D13：流式发布即时入视野
        previousEnvelope: orPreviousPayloadEnvelope,
      });
      result = loop.result;
      orFinalMessages = loop.finalMessages;
      orLastSentMessages = loop.lastSentMessages;
      orToolSeen = loop.toolSeen;
      }
    } else if (d.media && inputMessage && d.media.listMessageAttachments(inputMessage.id, effective.revision).some((a) => a.presentation === 'image' || a.presentation === 'sticker')) {
      // AUD-04 P1：SDK 分支有图=视觉门阻断（消息已保存、零模型请求、不静默丢图/换模型）
      d.logger.warn('media_gate_blocked', { turn_id: turnId, code: 'MODEL_VISION_UNAVAILABLE', driver: 'claude-agent-sdk' });
      result = { outcome: 'error', errorClassified: null, errorCode: 'MODEL_VISION_UNAVAILABLE', errorMessage: 'SDK 驱动不支持图片输入——消息已保存', sessionId: null, requestId: null };
      orFinalMessages = null; orLastSentMessages = null; orToolSeen = [];
    } else {
      // SDK 分支：既有单请求路径（§11：不合作 runner 的有界终止——宽限只在 abort 之后才计时）
      try {
        result = await Promise.race([
          runner.run({ prompt: sdkPrompt, options: built!.assembled, resumeSessionId, abortController: runToken.controller, onEvent: handleEvent }),
          new Promise<never>((_, reject) => {
            const arm = (): void => {
              setTimeout(() => reject(new Error('RUNNER_GRACE_TIMEOUT')), RUNNER_GRACE_MS).unref?.();
            };
            if (runToken.controller.signal.aborted) arm();
            else runToken.controller.signal.addEventListener('abort', arm, { once: true });
          }),
        ]);
      } catch (err) {
        const isGrace = String((err as Error)?.message ?? '').includes('RUNNER_GRACE_TIMEOUT');
        if (isGrace) {
          // 不变式：grace 超时离开 await 时 runner 可能仍活着——旧代一律 fence + abort（迟到回调不得再发布）
          runToken.token.cancelled = true;
          runToken.controller.abort();
        }
        d.logger.error(isGrace ? 'runner_grace_exceeded' : 'runner_threw', { turn_id: turnId, attempt_id: attempt.id, code: stableCode(err) });
        result = { outcome: isGrace ? 'interrupted' : 'error', errorClassified: null, errorCode: isGrace ? 'RUNNER_GRACE_TIMEOUT' : 'RUNNER_THREW', errorMessage: String((err as Error)?.message ?? err), sessionId: null, requestId: null };
      }
    }
    this.active.delete(turnId);

    // session 绑定（AUD-03）：首轮把观察到的 session 持久化到窗口；
    // fresh_session 重跑完成后改绑新 session（旧 session 因含被替代输入而弃用）
    if (result.sessionId && !resumeSessionId) {
      if (attempt.fresh_session) d.windows.rebindSession(window.id, window.sdk_session_id, result.sessionId);
      else d.windows.bindSession(window.id, result.sessionId);
    }

    const now = new Date().toISOString();
    // —— 确定性终态（AUD-10/25）——
    if (runToken.token.cancelled && routeSignalHandled) {
      segmenter.drop();
      if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
      d.events.publish('turn.status', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id, payload: { state: 'route_owner_pending', generation } });
      return; // attempt/turn 已在 handleRouteSignal 的事务里置 route_owner_pending
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
      return;
    }
    if (result.outcome === 'error' || result.outcome === 'no_final_result') {
      segmenter.drop();
      d.reasoning.markAttemptFinal({ attemptId: attempt.id, final: 'failed', generation });
      if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
      const reasonCode = result.outcome === 'no_final_result' ? 'NO_FINAL_RESULT' : (result.errorCode ?? 'RUNNER_ERROR');
      const blockedReason = `${reasonCode}:${result.errorClassified ?? 'unknown'}`;
      tx(d.db, () => {
        d.db.prepare('UPDATE attempts SET state = ?, blocked_reason = ?, completed_at = ? WHERE id = ?').run('failed', blockedReason, now, attempt.id);
        d.db.prepare('UPDATE turns SET state = ?, completed_at = ? WHERE id = ?').run('failed', now, turnId);
      });
      d.events.publish('turn.status', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id, payload: { state: 'failed', reason: reasonCode } });
      d.logger.warn('attempt_failed', { turn_id: turnId, attempt_id: attempt.id, code: reasonCode });
      return;
    }

    // completed（仅当观察到 success result，runner 契约保证）
    publishSegments(([segmenter.flushTail()].filter(Boolean) as string[]));
    d.reasoning.markAttemptStreamEnded({ attemptId: attempt.id }); // 仍 streaming 的块 → complete/stream_only（无完整块核对，不伪装已核对）
    if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
    tx(d.db, () => {
      d.db.prepare("UPDATE attempts SET state = 'completed', completed_at = ? WHERE id = ?").run(now, attempt.id);
      d.db.prepare('UPDATE turns SET state = ?, completed_at = ? WHERE id = ?').run('completed', now, turnId);
    });
    d.events.publish('turn.completed', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, payload: { generation, session_id: result.sessionId } });
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
      d.trajectory.replace(window.id, trajMessages, tailBoundaryOf(boundaryBase), [...baseManifest, ...catchupManifest, ...inputEntry, ...turnManifestAdditions, ...orToolSeen]);
      // 自动浮现：成功轨迹落正本后 retain（真实 manifest 确认，不是入库 ready
      // 就算送达——docs/04 retained 语义）；失败回合不假标 coverage。
      if (surfacingAugment) d.surfacing?.markRetained(surfacingAugment);
    }
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
  static recoverSchedule(deps: SupervisorDeps): { redispatched: number } {
    const rows = deps.db
      .prepare("SELECT t.id FROM turns t JOIN attempts a ON a.turn_id = t.id WHERE t.state = 'pending' AND a.state IN ('pending','ready_after_route')")
      .all() as Array<{ id: string }>;
    for (const r of rows) deps.supervisor!.enqueue(r.id);
    const recoverable = deps.db.prepare(`SELECT DISTINCT s.conversation_id FROM context_selections s
      JOIN conversations c ON c.id=s.conversation_id
      WHERE s.rotation_cause IS NOT NULL AND
        (s.status='confirmed' OR (s.status='consumed' AND s.target_window_id=c.active_window_id))
        AND EXISTS (SELECT 1 FROM turns t JOIN attempts a ON a.turn_id=t.id
          WHERE t.conversation_id=s.conversation_id AND t.state='blocked' AND a.state='blocked'
          AND (a.blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' OR a.blocked_reason LIKE 'CONTEXT_ROTATION_REQUIRED%'))`).all() as Array<{ conversation_id: string }>;
    for (const row of recoverable) void deps.supervisor!.resumeAfterSelectionConfirm(row.conversation_id).catch(() => {
      deps.logger.warn('selection_recovery_failed', { code: 'ROTATION_RECOVERY_FAILED' });
    });
    return { redispatched: rows.length };
  }

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
        const att = this.d.db.prepare("SELECT id FROM attempts WHERE turn_id = ? AND state IN ('running')").get(turnId) as { id: string } | undefined;
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
