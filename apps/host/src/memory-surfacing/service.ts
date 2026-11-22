// SurfacingService：E 侧编排（docs/02/04 + SOL_RECALL_REFACTOR 2026-10-30）。
// - MessageService 接受事务内只登记作业（SQL 零网络；旧 regex 意图门已退役，
//   每条正式消息都登记），由该消息的目标回合领取；
// - 目标回合先跑 Sol 三态判断（none/observe 收口；recall 出计划），
//   计划随既有 prepare 请求进入 M 检索/JEV → 同轮源/目标绑定 →
//   validate（有界复核）→ supervisor 装配期 check → 冻结注入块；
// - 每房间串行、全局并发上限；崩溃恢复有界；无后台补扫历史。
// - 后台零主模型 key / 零主模型 runner：M 走专用 MariposaClient（surfacing
//   credential_ref，不回退聊天凭据）；Sol 走独立 OpenAI key（sol-provider）。
import { executeMemoryReadFull } from './detail-tool.ts';
import { syncedSourceIdsFor } from './source-boundary.ts';
import { unreadSurfaceItem, surfaceItemRanges, uncoveredRanges, windowCoverage, windowCoverageDigest } from './window-coverage.ts';
import type { CoverageRange } from '../capabilities/contracts.ts';
import type { Db } from '../db/connection.ts';
import { isCallActivityActive } from '../modules/voice/call-service.ts';
import { effectiveRevisionText } from '../messages/effective-text.ts';
import type { MariposaClient } from '../integrations/mariposa/client.ts';
import { SOL_INPUT_TOO_LARGE, SurfacingRepository, type JobRow } from './repository.ts';
import { buildRecentDialogue, type RecentMessage } from './trigger.ts';
import { speakerLabelFor } from '../identity/speaker-labels.ts';
import { projectIdentityFacts } from '../identity/surfacing-projection.ts';
import {
  estimateTokens, memoryRefFor, renderAugmentation, projectSurfacedMemory, readValidatedItems, surfaceItemKey,
  type FrozenAugmentation, type SurfaceItem, type MissingQuote,
} from './contracts.ts';
import {
  SolDecisionJudge, type SolDecisionInput, type SolDecisionPlan, type SolJudgeResult, type SolUsage,
} from './sol-provider.ts';

export type SurfacingConfig = {
  enabled: boolean;
  policy_revision: number;
  prompt_prepare_revision: string;
  delivery_deadline_ms: number;
  max_added_tokens_per_turn: number;
  max_packet_bytes: number;
  worker_concurrency: number;
  /** 检索核对使用的短近文用户消息条数。 */
  recent_user_messages: number;
  /** 本轮原话字节预算，含当前消息。 */
  recent_window_bytes: number;
};

export type AugmentInput = {
  conversationId: string;
  windowId: string;
  approvedIdentityText?: string | null;
  turnId: string;
  attemptId: string;
  pendingCoverage?: readonly CoverageRange[];
  message: { id: string; revision: number; sequence: number | null; content: string; hash: string };
};

/** supervisor 薄接点拿到的冻结结果。 */
export type AugmentResult = FrozenAugmentation & { jobId: string };

export class SurfacingService {
  readonly repo: SurfacingRepository;
  private running = 0;
  private roomRunning = new Set<string>();
  private stopped = false;
  private inflightPrepare = new Map<string, Promise<void>>();
  private inflightValidate = new Map<string, Promise<void>>();
  private controllers = new Map<string, Set<AbortController>>();

  private async bounded<T>(call: (signal: AbortSignal) => Promise<T>, ms: number, jobId: string): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0 || this.stopped) throw new Error('SURFACE_TIMEOUT');
    const controller = new AbortController();
    const controllers = this.controllers.get(jobId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(jobId, controllers);
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([call(controller.signal), new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('SURFACE_CANCELLED')), { once: true });
        timer = setTimeout(() => { reject(new Error('SURFACE_TIMEOUT')); controller.abort(); }, Math.max(1, ms));
      })]);
    } finally {
      clearTimeout(timer!); controllers.delete(controller);
      if (controllers.size === 0) this.controllers.delete(jobId);
    }
  }

  private db: Db;
  private client: MariposaClient;
  private sol: SolDecisionJudge;
  private cfg: SurfacingConfig;
  private log: import('../observability/logging.ts').Logger | null;
  private events: import('../events/service.ts').EventService | null;
  private quarrelSourceRefs: ((conversationId: string, signal?: AbortSignal) => Promise<{ refs: Set<string>; reachable: boolean; complete: boolean }>) | null;
  private eventQueue: Array<import('./contracts.ts').SurfaceJobEventPayload> = [];
  private eventFlushScheduled = false;

  constructor(
    db: Db,
    client: MariposaClient,
    sol: SolDecisionJudge,
    cfg: SurfacingConfig,
    log: import('../observability/logging.ts').Logger | null,
    events: import('../events/service.ts').EventService | null = null,
    quarrelSourceRefs: ((conversationId: string, signal?: AbortSignal) => Promise<{ refs: Set<string>; reachable: boolean; complete: boolean }>) | null = null,
  ) {
    this.db = db;
    this.client = client;
    this.sol = sol;
    this.cfg = cfg;
    this.log = log;
    this.events = events;
    this.quarrelSourceRefs = quarrelSourceRefs;
    // R05（审计 J02）：状态提交处收集生命周期事件，微任务批量落 SSE——
    // 事务内的状态写入不会嵌套开 EventService 事务；事件=投影非正本，
    // 发布失败只记日志绝不影响浮现状态机。
    this.repo = new SurfacingRepository(db, (p) => {
      this.logTerminalStage(p);
      this.eventQueue.push(p);
      if (!this.eventFlushScheduled) {
        this.eventFlushScheduled = true;
        queueMicrotask(() => {
          this.eventFlushScheduled = false;
          const batch = this.eventQueue.splice(0);
          for (const ev of batch) {
            try {
              this.events?.publish('surface.job', {
                conversationId: ev.conversation_id, scope: 'private', payload: ev,
              });
            } catch (err) {
              this.log?.warn?.('surface_event_publish_failed', { job_id: ev.job_id, to: ev.to, error: String((err as Error).message ?? err).slice(0, 120) });
            }
          }
        });
      }
    });
  }

  get enabled(): boolean { return this.cfg.enabled; }

  // —— MessageService 事务内挂点（SQL only）——

  onUserMessageAccepted(o: {
    conversationId: string; messageId: string; revision: number; sequence: number;
    content: string; contentHash: string; occurredAt: string | null;
  }): void {
    if (!this.cfg.enabled) return;
    if (!o.content || o.content.trim().length === 0) return;
    // P3（四仓审计 20261106，U05/T05）+RB01（复审 20261106）：通话话轮与通话活动期间
    // （响铃/准备/已建立）的普通文字都不登记自动浮现——通话期间 Sol 自动调用数为 0；
    // 结束不补扫，下一新非通话聊天恢复正常触发。活动事实用统一判定（call-service），
    // 不据 voice 字符串或单一路由猜测。
    const callTurn = this.db.prepare("SELECT 1 FROM messages WHERE id=? AND client_message_id LIKE 'voice:%'").get(o.messageId);
    if (callTurn || isCallActivityActive(this.db, o.conversationId)) return;
    // SOL_RECALL_REFACTOR：旧 P1 regex 意图门退役——每条正式用户消息都登记
    // 作业，语义判断（none/observe/recall）在提交后由 Sol 完成。这里不做
    // 任何网络调用；Sol 网络请求只出现在事务提交后的 preparePhase。
    const jobId = this.repo.registerAcceptedJob({
      conversationId: o.conversationId, messageId: o.messageId, revision: o.revision,
      sequence: o.sequence, content: o.content, contentHash: o.contentHash,
      occurredAt: o.occurredAt,
      policyRevision: this.cfg.policy_revision, promptRevision: this.cfg.prompt_prepare_revision,
      deadlineMs: this.cfg.delivery_deadline_ms,
    });
    this.log?.info('surface_job_registered', {
      conversation: o.conversationId, message: o.messageId, revision: o.revision,
      registered: jobId !== null,
    });
  }

  onUserMessageEdited(o: { conversationId: string; messageId: string; supersededRevision: number }): void {
    if (!this.cfg.enabled) return;
    this.repo.cancelJobsForRevision(o.conversationId, o.messageId, o.supersededRevision);
    for (const [id, controllers] of this.controllers) {
      if (this.repo.jobById(id)?.state === 'cancelled') for (const controller of controllers) controller.abort();
    }
  }

  /** P3（U05）：通话开始（建立/准备/接通）——取消该会话全部未完成浮现作业并中止
   *  在途 Sol 请求；不补扫，通话结束后由新的非通话聊天按规则重新触发。 */
  cancelForActiveCall(conversationId: string): void {
    if (!this.cfg.enabled) return;
    const n = this.repo.cancelJobsForConversation(conversationId, 'CALL_ACTIVE');
    for (const [id, controllers] of this.controllers) {
      if (this.repo.jobById(id)?.state === 'cancelled') for (const controller of controllers) controller.abort();
    }
    if (n > 0) this.log?.info('surface_jobs_cancelled_for_call', { conversation: conversationId, jobs: n });
  }

  cancelForTurn(turnId: string): void {
    const row = this.db.prepare(`SELECT m.id, m.conversation_id, m.current_revision FROM turns t
      JOIN messages m ON m.id=t.input_message_id WHERE t.id=?`).get(turnId) as
      { id: string; conversation_id: string; current_revision: number } | undefined;
    if (row) this.onUserMessageEdited({ conversationId: row.conversation_id, messageId: row.id, supersededRevision: row.current_revision });
  }

  finishTurn(turnId: string): void {
    const jobs = this.db.prepare(
      `SELECT j.id, j.state FROM surfacing_jobs j
       JOIN turns t ON t.input_message_id=j.target_message_id AND t.conversation_id=j.conversation_id
       JOIN messages m ON m.id=t.input_message_id AND m.current_revision=j.target_revision
       WHERE t.id=? AND t.state IN ('completed','failed','interrupted')
       AND j.state IN ('pending','preparing','prepared','target_bound','validating','ready','reserved','dispatch_started')`,
    ).all(turnId) as Array<{ id: string; state: JobRow['state'] }>;
    for (const job of jobs) {
      if (job.state === 'reserved') {
        this.repo.dropAtFinalAdmission(job.id);
      } else {
        this.repo.transition(job.id, [job.state], job.state === 'dispatch_started' ? 'attempted_not_retained' : 'expired',
          { reason_code: 'SURFACE_TURN_ENDED' });
      }
    }
  }

  /** P5 §9.4：生产分阶段耗时（进程内 performance.now 单调钟；跨进程由 job.created_at 桥接）。 */
  private readonly stageTimings = new Map<string, { firstRun?: number; solDone?: number; prepareDone?: number; validateDone?: number }>();
  private noteStage(jobId: string, stage: 'firstRun' | 'solDone' | 'prepareDone' | 'validateDone'): void {
    const t = this.stageTimings.get(jobId) ?? {};
    if (t[stage] === undefined) t[stage] = performance.now();
    this.stageTimings.set(jobId, t);
    this.log?.info('surface_stage', { job: jobId, stage, since_first_run_ms: Math.round(performance.now() - (t.firstRun ?? performance.now())) });
  }
  private logTerminalStage(p: { job_id: string; to: string }): void {
    if (!['delivered', 'retained', 'empty', 'blocked', 'timed_out', 'cancelled', 'expired', 'missed_target', 'rejected', 'unknown_cost'].includes(p.to)) return;
    const job = this.repo.jobById(p.job_id);
    const t = this.stageTimings.get(p.job_id);
    this.stageTimings.delete(p.job_id);
    if (!job || !t?.firstRun) return;
    const nowP = performance.now();
    const createdWall = Date.parse(job.created_at);
    const totalMs = Number.isFinite(createdWall) ? Math.round(Date.now() - createdWall) : Math.round(nowP - t.firstRun);
    const mk = (from?: number, to?: number): number | null => (from === undefined || to === undefined ? null : Math.round(to - from));
    const summary = {
      job: p.job_id, final_state: p.to, total_ms: totalMs,
      queue_ms: null as number | null,
      sol_ms: mk(t.firstRun, t.solDone),
      prepare_ms: mk(t.solDone, t.prepareDone),
      validate_ms: mk(t.prepareDone, t.validateDone),
      deliver_ms: mk(t.validateDone, nowP),
      crossed_10s: totalMs >= 10_000, crossed_25s: totalMs >= 25_000, crossed_60s: totalMs >= 60_000,
      deadline_ms: this.cfg.delivery_deadline_ms,
    };
    const firstRunWall = Date.now() - (nowP - t.firstRun);
    summary.queue_ms = Number.isFinite(createdWall) ? Math.round(firstRunWall - createdWall) : null;
    this.log?.info('surface_job_summary', summary);
  }

  private deadline(job: JobRow): number {
    const value = job.expires_at ? Date.parse(job.expires_at) : Date.parse(job.created_at) + this.cfg.delivery_deadline_ms;
    return Number.isFinite(value) ? value : 0;
  }

  /** R1/R3（裁定 2026-11-03）：本轮投递预算，最终投影 UTF-8 bytes 计量。
   * estimateTokens=bytes/3 的逆运算得 token 门对应字节，再与注入包字节
   * 门取小——与最终装入循环是同一对象同一尺；同 job 三次跨线调用
   * 同值（预算属操作载荷，M 端 payload_hash 幂等校验一致性）。 */
  private deliveryBudgetBytes(): number {
    return Math.min(this.cfg.max_added_tokens_per_turn * 3, this.cfg.max_packet_bytes);
  }

  /** C5：历史 delivered job 的全部 items 是否均为其**自身输入上下文**
   *  （触发消息+其近文窗）的原文回声——是则该送达没有提供任何历史
   *  证据，不构成"需要已满足"。逐字精确匹配（确切重复），只回溯评价
   *  那一次送达自身，不影响未来检索（T05 安全线内）。 */
  private echoDeliveryOf(conversationId: string, previous: { sourceMessageId: string; sourceSequence: number | null; items: SurfaceItem[] }): boolean {
    if (!previous.items || previous.items.length === 0) return false;
    const row = this.db.prepare(
      'SELECT m.sequence, r.revision, r.content FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision WHERE m.id=?',
    ).get(previous.sourceMessageId) as { sequence: number; revision: number; content: string } | undefined;
    if (!row) return false;
    const triggerText = effectiveRevisionText(this.db, previous.sourceMessageId, row.revision, row.content);
    const contextTexts = new Set<string>([triggerText]);
    for (const m of this.recentDialogue(conversationId, row.sequence, triggerText)) contextTexts.add(m.text);
    return previous.items.every(item => {
      const memory = projectSurfacedMemory(item);
      return contextTexts.has(memory.text) && (memory.our_words ?? []).every(word => contextTexts.has(word.text));
    });
  }

  private current(job: JobRow): boolean {
    return job.source_message_id === job.target_message_id
      && job.source_revision === job.target_revision && this.targetInputOf(job) !== null;
  }

  private ensurePrepared(job: JobRow, input: AugmentInput): Promise<void> {
    const existing = this.inflightPrepare.get(job.id);
    if (existing) return existing;
    if (this.running >= this.cfg.worker_concurrency || this.roomRunning.has(job.conversation_id)) {
      this.repo.transition(job.id, ['pending'], 'blocked', { reason_code: 'SURFACE_CAPACITY_EXHAUSTED' });
      return Promise.resolve();
    }
    this.running++;
    this.roomRunning.add(job.conversation_id);
    const work = this.preparePhase(job, input).finally(() => {
      this.inflightPrepare.delete(job.id);
      this.running--;
      this.roomRunning.delete(job.conversation_id);
    });
    this.inflightPrepare.set(job.id, work);
    return work;
  }

  private async preparePhase(job: JobRow, input: AugmentInput): Promise<void> {
    this.noteStage(job.id, 'firstRun');
    if (!this.current(job)) {
      this.repo.transition(job.id, ['pending'], 'expired', { reason_code: 'SURFACE_BINDING_INVALID' });
      return;
    }
    // RB01（复审 20261106）：Sol 真正请求门——augmentFor 装配路径不经 drain，必须在
    // 请求入口复核通话活动（响铃/准备/已建立统一事实）；活动即取消，不发起 Sol。
    if (isCallActivityActive(this.db, job.conversation_id)) {
      this.repo.transition(job.id, ['pending'], 'cancelled', { reason_code: 'CALL_ACTIVE' });
      this.log?.info('surface_job_call_gated', { job: job.id, conversation: job.conversation_id, entry: 'prepare' });
      return;
    }
    if (!this.repo.transition(job.id, ['pending'], 'preparing')) return;
    const src = this.sourceInputOf(job);
    const recent = this.solCandidateDialogue(job.conversation_id, src.sequence, src.text);
    if (recent === null) {
      this.repo.transition(job.id, ['preparing'], 'blocked', { reason_code: SOL_INPUT_TOO_LARGE });
      return;
    }
    const activeWindow = input.windowId;
    const dialogueText = [...recent.map(message => message.text), src.text].join('\n');
    const identityFacts = this.identityFactsInWindow(activeWindow, input.approvedIdentityText, dialogueText);
    const coveredContext = [
      ...identityFacts.map(fact => `本窗口有效身份资料：${fact}`),
      ...windowCoverageDigest(this.db, activeWindow, 8, 160, dialogueText),
    ].slice(0, 16).map(line => Array.from(line).slice(0, 320).join(''));
    // —— Sol 三态判断（事务提交后；先于任何 M 检索/JEV）——
    const sol = await this.runSolDecision(job, {
      currentMessage: { text: src.text, occurred_at: src.occurredAt },
      recentDialogue: recent.map(({ role, text, occurred_at }) => ({ role, text, occurred_at })),
      ...(coveredContext.length > 0 ? { coveredContext } : {}),
    });
    if (!sol.ok) {
      // 技术失败 ≠ none：独立原因码落作业，主对话照常继续
      this.repo.transition(job.id, ['preparing'], 'blocked', {
        reason_code: sol.code,
      });
      this.log?.warn('surface_sol_failed', { job: job.id, code: sol.code, elapsed_ms: sol.elapsed_ms, ...sol.diagnostic });
      return;
    }
    const d = sol.decision;
    this.repo.transition(job.id, ['preparing'], 'preparing', {
      sol_decision: d.decision, sol_topic: d.topic,
      sol_plan_json: d.plan ? JSON.stringify(d.plan) : null,
    });
    this.log?.info('surface_sol_decision', {
      job: job.id, decision: d.decision, topic: d.topic,
      route: d.plan?.route ?? null, breadth: d.plan?.breadth ?? null,
      queries: d.plan?.queries.length ?? 0, elapsed_ms: sol.elapsed_ms,
      usage_input: sol.usage?.input_tokens ?? null, usage_cached: sol.usage?.cached_tokens ?? null,
      usage_cache_write: sol.usage?.cache_write_tokens ?? null, usage_output: sol.usage?.output_tokens ?? null,
    });
    this.noteStage(job.id, 'solDone');
    if (d.decision !== 'recall' || !d.plan) {
      this.repo.transition(job.id, ['preparing'], 'empty', {
        reason_code: d.decision === 'observe' ? 'SURFACE_SOL_OBSERVE' : 'SURFACE_SOL_NONE',
      });
      return;
    }
    const plan = d.plan;
    const userInputs = [...recent.filter(m => m.role === 'owner'), {
      message_id: src.messageId, revision: src.revision, text: src.text,
    }];
    const needSources = new Map<string, { message_id: string; revision: number }>();
    for (const evidence of plan.evidence) {
      const original = userInputs[evidence.user_turn - 1];
      if (!original || !original.text.includes(evidence.quote)) {
        this.repo.transition(job.id, ['preparing'], 'blocked', { reason_code: 'SURFACE_SOL_INVALID_OUTPUT' });
        return;
      }
      needSources.set(original.message_id, { message_id: original.message_id, revision: original.revision });
    }
    const nameGrounds = [...userInputs.map(message => message.text), ...identityFacts];
    for (const query of plan.queries) {
      if (query.person_focus?.names.some(name => !nameGrounds.some(text => text.includes(name)))) {
        query.person_focus = null;
      }
    }
    // 同需身份来自实际用户原话及修订，查询/用途的自然语言改写不产生新身份。
    // 新对象、日期、原句或明确再查由新的原话依据区分，模型改写检索计划
    // 本身不能让同一组已处理原话再次消费。
    const need = { sources: [...needSources.values()].sort((a, b) => a.message_id.localeCompare(b.message_id)) };
    this.repo.transition(job.id, ['preparing'], 'preparing', { sol_plan_json: JSON.stringify({ ...plan, need }) });
    let previous = this.repo.completedNeed(job.conversation_id, need);
    if (previous && previous.outcome === 'delivered' && previous.sourceMessageId && this.echoDeliveryOf(job.conversation_id, {...previous,sourceMessageId:previous.sourceMessageId})) {
      // C5（RECALL_SOURCE_BOUNDARY 2026-11-01）：回声送达不满足历史需要——
      // 13:11 类错误交付（items 全为该 job 自身输入上下文的原文）不再占用
      // 同需去重；审计行原样保留（不改历史数据、不补发），本次需要照常检索。
      this.log?.info('surface_need_echo_delivery_bypassed', { job: job.id, previous_job: previous.jobId });
      previous = null;
    }
    const confirmed = windowCoverage(this.db, activeWindow ?? '');
    const deliveredHere = previous?.windowId === activeWindow && previous && previous.items.length > 0
      && previous.items.every(item => {
        const ranges = surfaceItemRanges(item);
        return ranges.length > 0 && ranges.every(range => !uncoveredRanges(range, confirmed).length);
      });
    if (previous && (previous.outcome === 'no_match' || deliveredHere)) {
      this.repo.transition(job.id, ['preparing'], 'empty', {
        reason_code: previous.outcome === 'delivered' ? 'SURFACE_NEED_ALREADY_DELIVERED' : 'SURFACE_NEED_ALREADY_SEARCHED',
      });
      return;
    }
    const opId = `est-surface:${job.id}`;
    // RECALL_SOURCE_BOUNDARY：来源边界随 prepare 下推（excluded=触发消息
    // 全修订+回声；in_context=当前窗携带原文）。收据缺席=如实不带（fail-open）。
    // R6 精确封存（复审 2026-11-08）：争吵存档的 sm 集并入同一来源边界下推——M 在
    // 检索层逐项排除（words/raw 按 source_ref、event 按桶绑定；旧绑定/无绑定保留），
    // 冻结前生效，无关候选不再被整包扣留（03 §6"复用已有来源边界和回声识别机制"）。
    // RR4-W2e（林石见 2026-11-10 修正稿）：排除集**不再截断**——触发来源全修订
    // （旧 cap 64）与 quarrel 全集（旧 cap 192）完整并入同一次 prepare（M 合同与
    // 规范化已同步放开；分块在 M 查询层完成）。完整集合超量不是暂停理由；清单
    // 不可核对时按 RR4-F1 在本阶段暂缓（见下），不再"不带排除集继续检索"。
    const excluded_source_ids = syncedSourceIdsFor(this.db, [src.messageId]);
    let quarrelPushed = 0;
    if (this.quarrelSourceRefs) {
      // RR4-B（复审 2026-11-12）：封存清单读取纳入 bounded——作业取消（cancelForTurn
      // abort 控制器）与剩余期限同时约束这段分页读取；signal 经端口传到共享分页器，
      // 取消后不再请求后页。读取完成后复核作业仍在 preparing，取消/编辑竞态下不再
      // 发 M prepare。
      const quarrel = await this.bounded(signal => this.quarrelSourceRefs!(job.conversation_id, signal), this.deadline(job) - Date.now(), job.id)
        .catch((err): { refs: Set<string>; reachable: boolean; complete: boolean } => {
          if (err instanceof Error && err.message === 'SURFACE_CANCELLED') throw err;
          return { refs: new Set(), reachable: false, complete: false }; // 读取向传输失败=不可核对（runJob 统一收口）
        });
      if (this.repo.jobById(job.id)?.state !== 'preparing') return;
      if (!(quarrel.reachable && quarrel.complete)) {
        // RR4-F1（复审 2026-11-11）：封存清单当次无法完整核对——**暂缓本次自动注入**
        // （沿用既有 blocked 状态路径，与 Sol 技术失败同款收口），不生成一包缺少完整
        // 排除依据的候选再指望终检补救。终检只比返回项的 source_ref：来自封存片段的
        // 派生桶（event，来源在 M 的 memory_source_bindings）不带该字段，prepare 不带
        // 排除集时会漏过终检进入请求（复审独立复现；清单在两次检查之间恢复的时序同样
        // 被本闸覆盖）。正常聊天继续；后续消息的新作业照常尝试（本作业按 blocked 终态）。
        this.repo.transition(job.id, ['preparing'], 'blocked', {
          reason_code: quarrel.reachable ? 'QUARREL_SCOPE_INCOMPLETE' : 'QUARREL_SCOPE_UNREACHABLE',
        });
        this.log?.warn?.('surface_deferred_quarrel_scope', { job: job.id, reachable: quarrel.reachable, complete: quarrel.complete });
        return;
      }
      for (const sm of quarrel.refs) if (!excluded_source_ids.includes(sm)) excluded_source_ids.push(sm);
      quarrelPushed = quarrel.refs.size;
      if (quarrelPushed > 0) this.log?.info?.('surface_quarrel_boundary_pushed', { job: job.id, quarrel_refs: quarrelPushed });
    }
    // RR4-B：发起 M prepare 前复核作业状态——取消/编辑发生在封存读取与本次调用之间时
    // 不再发起检索（bounded 只 abort 已注册的控制器，竞态窗口内的后续调用不自灭）。
    if (this.repo.jobById(job.id)?.state !== 'preparing') return;
    const r = await this.bounded(signal => this.client.surfacePrepare({
      operation_id: opId,
      conversation_scope: job.conversation_id,
      source_input: {
        message_id: src.messageId, revision: src.revision, sequence: src.sequence,
        text: src.text, body_hash: src.bodyHash, occurred_at: src.occurredAt,
      },
      recent_dialogue: this.trimJudgeDialogue(recent, src.text, plan),
      speaker_names: this.speakerNames,
      plan: this.planForMariposa(plan),
      ...(excluded_source_ids.length > 0 ? { excluded_source_ids } : {}),
      ...(confirmed.length > 0 ? { covered_ranges: confirmed } : {}),
      ...(coveredContext.length > 0 ? { covered_context: coveredContext } : {}),
      deadline_at: new Date(this.deadline(job)).toISOString(),
      // R1/R3（裁定 2026-11-03）：本轮投递预算随载荷过线（最终投影
      // UTF-8 bytes；属操作载荷，同 operation_id 重试须同值——M 端
      // payload_hash 幂等即校验）。E 终检仍权威。
      delivery_budget_bytes: this.deliveryBudgetBytes(),
    }, signal), this.deadline(job) - Date.now(), job.id);
    this.noteStage(job.id, 'prepareDone');
    if (Date.now() >= this.deadline(job)) throw new Error('SURFACE_TIMEOUT');
    if (!r.ok) {
      this.repo.transition(job.id, ['preparing'], 'blocked', { reason_code: r.code, m_operation_id: opId });
      return;
    }
    const data = r.result as { status?: string; candidate_snapshot_ref?: string | null; reason_code?: string | null; policy_revision?: number; prompt_revision?: string };
    // R9（裁定 2026-11-03）：读取并落盘 M 实际执行的政策/提示词版本——
    // 观测与失效对账依据（作业键仍用 E 自身调度身份，不受此影响）
    if (typeof data.policy_revision === 'number' || typeof data.prompt_revision === 'string') {
      this.repo.recordMExecutionVersions(
        job.id,
        typeof data.policy_revision === 'number' ? data.policy_revision : null,
        typeof data.prompt_revision === 'string' ? data.prompt_revision : null,
      );
      this.log?.info('surface_m_versions', {
        job: job.id, m_policy_revision: data.policy_revision ?? null, m_prompt_revision: data.prompt_revision ?? null,
      });
    }
    const state = data.status === 'prepared' ? 'prepared'
      : data.status === 'empty' ? 'empty'
        : data.status === 'rejected' ? 'rejected'
          : data.status === 'unknown_outcome' ? 'unknown_cost' : 'blocked';
    if (state === 'empty' && data.reason_code !== 'SURFACE_ALREADY_COVERED') {
      // 覆盖仅对当前有效窗口成立，不登记为全局的已查无匹配。
      this.repo.recordSolRetrievalOutcome(job.id, 'no_match');
    }
    this.repo.transition(job.id, ['preparing'], state, {
      m_operation_id: opId,
      m_snapshot_ref: data.candidate_snapshot_ref ?? null,
      reason_code: data.reason_code ?? null,
    });
  }

  /** Sol 判断（含一次同任务内的有界技术重试；共享剩余 deadline）。 */
  private async runSolDecision(job: JobRow, input: SolDecisionInput): Promise<SolJudgeResult> {
    const attempts: Array<SolUsage | null> = [];
    const attempt = (): Promise<SolJudgeResult> => this.bounded(
      async signal => {
        let index: number | undefined;
        const result = await this.sol.decide(input, signal, () => {
          index = attempts.push(null) - 1;
          this.repo.recordSolUsage(job.id, attempts);
        });
        if (index !== undefined && result.usage) {
          attempts[index] = result.usage;
          this.repo.recordSolUsage(job.id, attempts);
        }
        return result;
      }, this.deadline(job) - Date.now(), job.id,
    ).catch((err): SolJudgeResult => ({
      ok: false,
      code: err instanceof Error && err.message === 'SURFACE_CANCELLED' ? 'SURFACE_SOL_CANCELLED' : 'SURFACE_SOL_TIMEOUT',
      usage: null, elapsed_ms: 0,
    }));
    const first = await attempt();
    const transient = first.ok === false && ['SURFACE_SOL_HTTP_5XX', 'SURFACE_SOL_HTTP_429', 'SURFACE_SOL_TRANSPORT'].includes(first.code);
    if (!transient) return first;
    // 剩余 deadline ≥ 40% 才重试一次；重试仍失败保留真实原因码
    const remaining = this.deadline(job) - Date.now();
    if (remaining < 0.4 * this.cfg.delivery_deadline_ms) return first;
    const second = await attempt();
    return second;
  }

  /** est→M 计划：Sol 输出的查询级字段原样透传（need_kind/need/time_hint/
   *  语义与关键词）；说话人显示名映射为 M 内部枚举；evidence 逐字触发
   *  证据是 E 侧合同字段，不下发 M（M 合同无此字段）。 */
  private planForMariposa(plan: SolDecisionPlan): Record<string, unknown> {
    return {
      purpose: plan.purpose,
      route: plan.route,
      breadth: plan.breadth,
      queries: plan.queries.map(q => ({
        need_kind: q.need_kind,
        need: q.need,
        semantic: q.semantic,
        keywords: q.keywords,
        time_hint: q.time_hint,
        speaker: this.speakerEnumFor(q.speaker),
        source_mode: q.source_mode,
        person_focus: q.person_focus,
      })),
    };
  }

  private speakerEnumFor(display: string | null): 'jiaming' | 'qiaosheng' | null {
    if (!display) return null;
    const v = display.trim();
    if (v === 'jiaming' || v === 'qiaosheng') return v;
    if (v === '助手') return 'jiaming';
    if (v === '用户') return 'qiaosheng';
    if (this.sol.cfg.assistantDisplayName && v === this.sol.cfg.assistantDisplayName.trim()) return 'jiaming';
    if (this.sol.cfg.userDisplayName && v === this.sol.cfg.userDisplayName.trim()) return 'qiaosheng';
    return null;
  }

  private get speakerNames(): { owner: string; assistant: string } {
    return { owner: this.sol.cfg.userDisplayName, assistant: this.sol.cfg.assistantDisplayName };
  }

  private async validatePhase(job: JobRow, windowId: string): Promise<void> {
    const existing = this.inflightValidate.get(job.id);
    if (existing) return existing;
    if (!this.repo.transition(job.id, ['target_bound'], 'validating')) return;
    const src = this.sourceInputOf(job);
    const target = this.targetInputOf(job);
    if (!target) {
      this.repo.transition(job.id, ['validating', 'target_bound'], 'missed_target');
      return;
    }
    const recent = this.solCandidateDialogue(job.conversation_id, target.sequence, target.text);
    if (recent === null) {
      this.repo.transition(job.id, ['validating'], 'blocked', { reason_code: 'SURFACE_BODY_TOO_LARGE' });
      return;
    }
    const plan = job.sol_plan_json ? JSON.parse(job.sol_plan_json) as SolDecisionPlan : undefined;
    const deadlineAt = new Date(this.deadline(job)).toISOString();
    const p = (async () => {
      // RR4-B：发起 validate 前复核作业仍在 validating——取消/编辑落在上一跳与本次
      // 调用之间时不再发起 M 检索（bounded 只 abort 已注册控制器，竞态窗口不自灭）。
      if (this.repo.jobById(job.id)?.state !== 'validating') return;
      const r = await this.bounded(signal => this.client.surfaceValidate({
        operation_id: `est-surface-v:${job.id}:${target.messageId}:${target.revision}`,
        conversation_scope: job.conversation_id,
        words_view: 'memory_with_words',
        candidate_snapshot_ref: job.m_snapshot_ref ?? '',
        source_input_ref: { message_id: src.messageId, revision: src.revision },
        target_input: {
          message_id: target.messageId, revision: target.revision, sequence: target.sequence,
          text: target.text, body_hash: target.bodyHash, occurred_at: target.occurredAt,
        },
        recent_dialogue: this.trimJudgeDialogue(recent, target.text, plan),
        speaker_names: this.speakerNames,
        window_id: windowId,
        deadline_at: deadlineAt,
        // R1（2026-11-03）：预算贯穿 prepare→validate→check，同 job 同值
        delivery_budget_bytes: this.deliveryBudgetBytes(),
      }, signal), this.deadline(job) - Date.now(), job.id);
      this.noteStage(job.id, 'validateDone');
      if (Date.now() >= this.deadline(job)) throw new Error('SURFACE_TIMEOUT');
      if (!r.ok) {
        this.repo.transition(job.id, ['validating'], 'blocked', { reason_code: r.code });
        return;
      }
      const data = r.result as {
        status?: string; validation_receipt?: string | null; items?: SurfaceItem[]; missing?: MissingQuote[]; reason_code?: string | null;
      };
      const state = data.status === 'ready' ? 'ready'
        : data.status === 'empty' ? 'empty'
          : data.status === 'timed_out' ? 'timed_out'
            : data.status === 'rejected' ? 'rejected' : 'blocked';
      this.repo.transition(job.id, ['validating'], state, {
        receipt_id: data.validation_receipt ?? null,
        items_json: Array.isArray(data.items) && (data.items.length || data.missing?.length)
          ? JSON.stringify({ items: data.items, missing: data.missing }) : null,
        reason_code: data.reason_code ?? null,
      });
    })();
    this.inflightValidate.set(job.id, p);
    try { await p; }
    catch (err) {
      const code = err instanceof Error && err.message === 'SURFACE_TIMEOUT' ? 'SURFACE_TIMEOUT' : 'SURFACE_UNKNOWN_OUTCOME';
      this.repo.transition(job.id, ['validating'], code === 'SURFACE_TIMEOUT' ? 'timed_out' : 'blocked', { reason_code: code });
    } finally { this.inflightValidate.delete(job.id); }
  }

  // —— supervisor 薄接点（装配期；本钩子不阻塞超过剩余 deadline）——

  async augmentFor(input: AugmentInput): Promise<AugmentResult | null> {
    if (!this.cfg.enabled || this.stopped) return null;
    // RB01（复审 20261106）：最终装配准入同享通话门——通话活动期间不装配浮现块
    // （目标消息是通话期间文字时按同事实取消；下一新非通话消息恢复）。
    if (isCallActivityActive(this.db, input.conversationId)) {
      const gated = this.repo.nextPreparedForTarget(input.conversationId, input.message.id);
      if (gated) {
        this.repo.transition(gated.id, ['pending', 'preparing', 'prepared', 'target_bound', 'validating', 'ready'], 'cancelled', { reason_code: 'CALL_ACTIVE' });
        this.log?.info('surface_job_call_gated', { job: gated.id, conversation: input.conversationId, entry: 'augment' });
      }
      return null;
    }
    let job = this.repo.nextPreparedForTarget(input.conversationId, input.message.id);
    if (!job || job.target_revision !== input.message.revision || !this.current(job)) return null;
    const deadline = this.deadline(job);
    try {
      if (job.state === 'pending' || job.state === 'preparing') await this.ensurePrepared(job, input);
      job = this.repo.jobById(job.id)!;
      if (Date.now() >= deadline) throw new Error('SURFACE_TIMEOUT');
      if (!this.current(job)) return null;
      if (job.state === 'prepared') {
        this.repo.bindTarget({ conversationId: input.conversationId, jobId: job.id,
          targetMessageId: input.message.id, targetRevision: input.message.revision });
        job = this.repo.jobById(job.id)!;
      }
      if (job.state === 'target_bound' || job.state === 'validating') await this.validatePhase(job, input.windowId);
    } catch (err) {
      this.repo.transition(job.id, ['pending', 'preparing', 'prepared', 'target_bound', 'validating', 'ready'],
        err instanceof Error && err.message === 'SURFACE_TIMEOUT' ? 'timed_out' : 'blocked',
        { reason_code: err instanceof Error && err.message === 'SURFACE_TIMEOUT' ? 'SURFACE_TIMEOUT' : 'SURFACE_UNKNOWN_OUTCOME' });
      return null;
    }
    const fresh = this.repo.jobById(job.id);
    if (!fresh || fresh.state !== 'ready' || !fresh.items_json) return null;
    const { items: itemsAll, missing } = readValidatedItems(fresh.items_json);
    // check：经 HTTP 调 Mariposa 的本地校验；回执绑目标消息/修订/窗口。
    let ck;
    try {
      // RR4-B：同上——check 发起前复核作业仍 ready（取消后不再发第三跳 M 调用）。
      if (this.repo.jobById(job.id)?.state !== 'ready') return null;
      ck = await this.bounded(signal => this.client.surfaceCheck({
      validation_receipt: fresh.receipt_id ?? '',
      conversation_scope: input.conversationId,
      target_message_id: input.message.id,
      target_revision: input.message.revision,
      window_id: input.windowId,
      // R1（2026-11-03）：预算贯穿 prepare→validate→check，同 job 同值
      delivery_budget_bytes: this.deliveryBudgetBytes(),
    }, signal), deadline - Date.now(), job.id);
    } catch {
      this.repo.transition(job.id, ['ready'], 'timed_out', { reason_code: 'SURFACE_CHECK_FAILED' });
      return null;
    }
    if (Date.now() >= deadline) {
      this.repo.transition(job.id, ['ready'], 'timed_out', { reason_code: 'SURFACE_TIMEOUT' });
      return null;
    }
    if (!this.current(job) || this.repo.jobById(job.id)?.state !== 'ready') return null;
    if (!ck.ok) {
      this.repo.transition(job.id, ['ready'], 'blocked', { reason_code: ck.code });
      return null;
    }
    const ckd = ck.result as { valid?: boolean; accepted_detail_refs?: string[] };
    if (ckd.valid !== true) {
      this.repo.transition(job.id, ['ready'], 'rejected', { reason_code: 'SURFACE_CHECK_REJECTED' });
      return null;
    }
    const accepted = new Set(ckd.accepted_detail_refs ?? []);
    // 去重（本窗口实际上下文为准；事件正文与引语/来源分开记）+ 预算
    // （按源顺序装入严格赢家；放不下的整条跳过，不截断/不摘要/不换次优——R33/R34）
    const covered = [...windowCoverage(this.db, input.windowId), ...(input.pendingCoverage ?? [])];
    const items: SurfaceItem[] = [];
    const refs = new Map<string, string>();
    const refList: FrozenAugmentation['memoryRefs'] = [];
    const fitsPacket = (packet: string): boolean => {
      return estimateTokens(packet) <= this.cfg.max_added_tokens_per_turn
        && Buffer.byteLength(packet, 'utf8') <= this.cfg.max_packet_bytes;
    };
    let droppedCovered = 0;
    let droppedBudget = 0;
    for (const item of itemsAll) {
      if (!accepted.has(item.detail_ref)) continue;
      const it = unreadSurfaceItem(item, covered);
      if (!it) { droppedCovered++; continue; }
      const key = surfaceItemKey(it);
      const ref = memoryRefFor(it.detail_ref);
      const candidateRefs = new Map(refs).set(key, ref);
      const candidate = renderAugmentation([...items, it], candidateRefs, missing, this.speakerNames);
      if (!fitsPacket(candidate)) { droppedBudget++; continue; }
      items.push(it);
      covered.push(...surfaceItemRanges(it));
      refs.set(key, ref);
      refList.push({ ref, detail_ref: it.detail_ref, event_id: it.event_id });
    }
    // An accepted raw hit satisfies its needs when the original evidence is
    // all present in the window or in the items selected for this packet.
    const satisfiedRawNeeds = new Set(itemsAll.flatMap(item =>
      item.raw_context_needs && accepted.has(item.detail_ref) && !unreadSurfaceItem(item, covered)
        ? item.raw_context_needs : []));
    const rawIncomplete = itemsAll.some(item =>
      item.raw_context_needs?.some(need => !satisfiedRawNeeds.has(need)));
    if (rawIncomplete && !missing.some(gap => gap.kind === 'raw_context' && gap.status === 'incomplete')) {
      missing.push({ kind: 'raw_context', status: 'incomplete' });
    }
    let text = renderAugmentation(items, refs, missing, this.speakerNames);
    while (rawIncomplete && items.length && !fitsPacket(text)) {
      // Keep the earlier whole items, making room for the explicit gap.
      refs.delete(surfaceItemKey(items.pop()!));
      refList.pop();
      droppedBudget++;
      text = renderAugmentation(items, refs, missing, this.speakerNames);
    }
    const missingOnly = items.length === 0 && missing.length > 0 && (rawIncomplete || droppedCovered === itemsAll.length);
    const packetFits = fitsPacket(text);
    if (missingOnly && !packetFits) droppedBudget++;
    if (items.length === 0 && (!missingOnly || !packetFits)) {
      // F6：空结果原因分列——"全部已被覆盖"与"容量放不下"不是同一状态，
      // 也不能与"没找到"混同；原因码如实区分
      const reason = droppedBudget > 0
        ? (droppedCovered > 0 ? 'SURFACE_ALL_COVERED_OR_BUDGET' : 'SURFACE_BUDGET_NO_ROOM')
        : 'SURFACE_ALREADY_COVERED';
      this.repo.transition(job.id, ['ready'], 'empty', { reason_code: reason });
      return null;
    }
    if (Date.now() >= deadline) {
      this.repo.transition(job.id, ['ready'], 'timed_out', { reason_code: 'SURFACE_TIMEOUT' });
      return null;
    }
    const deliveryId = this.repo.freezeDelivery({
      jobId: job.id, attemptId: input.attemptId, windowId: input.windowId,
      text, items, memoryRefs: refList, missing,
    });
    if (!deliveryId) return null;
    return { deliveryId, text, items, memoryRefs: refList, payloadHash: this.repo.frozenForAttempt(input.attemptId)?.payload_hash ?? '', jobId: job.id };
  }

  /** 已冻结的 attempt 重试：transport retry 复用完全相同冻结包（docs/04）。 */
  reuseFrozen(attemptId: string): AugmentResult | null {
    const frozen = this.repo.frozenForAttempt(attemptId);
    if (!frozen) return null;
    const parsed = JSON.parse(frozen.selected_refs_json) as { items: SurfaceItem[]; refs: FrozenAugmentation['memoryRefs'] };
    return { deliveryId: frozen.id, text: frozen.payload_text, items: parsed.items, memoryRefs: parsed.refs, payloadHash: frozen.payload_hash, jobId: frozen.job_id };
  }

  /**
   * R02（审计 J01）最终准入：冻结（augmentFor 内 check→freeze）到最终装配之间
   * 没有上界——轨迹装配/派发排队/重试经 reuseFrozen 复用冻结包零校验，而 M 侧
   * 回执带时效。同一 surface.check 门（幂等本地 fence，不消费 receipt）在装配
   * 边界再核一次；失败只丢浮现块（作业收回留痕），主消息照常发出、绝不重发。
   * 已上线（dispatch_started）的冻结包按 docs/04 原样复用，不在此处改包。
   */
  async finalAdmit(aug: AugmentResult, input: {
    conversationId: string; windowId: string; messageId: string; revision: number;
  }): Promise<AugmentResult | null> {
    if (!this.cfg.enabled || this.stopped) return null;
    const job = this.repo.jobById(aug.jobId);
    if (!job) return null;
    if (job.state === 'dispatch_started') return aug;
    // RB01（复审 20261106）：冻结到最终装配之间通话开始——同一活动事实收口，
    // 不把已冻结块注入通话期间的装配。
    if (isCallActivityActive(this.db, input.conversationId)) {
      this.log?.info('surface_job_call_gated', { job: job.id, conversation: input.conversationId, entry: 'final_admit' });
      return this.repo.dropAtFinalAdmission(job.id);
    }
    if (!this.current(job) || Date.now() >= this.deadline(job)
      || job.conversation_id !== input.conversationId
      || job.state !== 'reserved'
      || job.target_message_id !== input.messageId
      || job.target_revision !== input.revision) {
      return this.repo.dropAtFinalAdmission(job.id);
    }
    try {
      const ck = await this.bounded(signal => this.client.surfaceCheck({
        validation_receipt: job.receipt_id ?? '',
        conversation_scope: input.conversationId,
        target_message_id: input.messageId,
        target_revision: input.revision,
        window_id: input.windowId,
      }, signal), this.deadline(job) - Date.now(), job.id);
      if (ck.ok && Date.now() < this.deadline(job) && this.current(job)
        && this.repo.jobById(job.id)?.state === 'reserved') {
        const ckd = ck.result as { valid?: boolean; accepted_detail_refs?: string[]; expires_at?: string };
        if (ckd.valid === true) {
          // F18（裁定 2026-11-03）：check 新鲜度合同——M 回执带短时效
          // expires_at（SURFACE_MAX_RECEIPT_AGE_MS=250ms 量级）：终验通过
          // 但回执已过期=不再注入。不放宽到任务 300s，也不在未过期时
          // 断言风险；字段缺席（旧 M/测试桩）不额外设障（以任务 deadline 为界）。
          const exp = typeof ckd.expires_at === 'string' ? Date.parse(ckd.expires_at) : NaN;
          const receiptFresh = !Number.isFinite(exp) || Date.now() < exp;
          if (!receiptFresh) {
            this.log?.warn('surface_check_expired', {
              job: job.id, expires_at: ckd.expires_at,
            });
            return this.repo.dropAtFinalAdmission(job.id);
          }
          // 接受面收缩（权限/版本撤销）：冻结块任一条掉出 accepted 即整块丢弃
          const accepted = new Set(ckd.accepted_detail_refs ?? []);
          if (aug.items.every(it => accepted.has(it.detail_ref))) {
            // 装配间隙同窗重复覆盖防护：任一证据已被实际覆盖即整块丢弃
            const covered = windowCoverage(this.db, input.windowId);
            if (aug.items.every(item => surfaceItemRanges(item).every(range => {
              const unread = uncoveredRanges(range, covered);
              return unread.length === 1 && unread[0]!.start_char === range.start_char && unread[0]!.end_char === range.end_char;
            }))) return aug;
          }
        }
      }
    } catch {
      // 超时/取消/坏回执：按丢处理，不阻塞主消息
    }
    return this.repo.dropAtFinalAdmission(job.id);
  }

  markDispatched(attemptId: string): void {
    const frozen = this.repo.frozenForAttempt(attemptId);
    if (frozen) this.repo.markDispatchStarted(frozen.job_id, frozen.id);
  }

  /** 成功轨迹 retain：写入真实 manifest 后调（不假标 coverage）。 */
  markRetained(result: AugmentResult): void {
    this.repo.markRetained(result.jobId, result.deliveryId);
  }

  // —— 设置面（同一功能的唯一设置区域；生效值与实际请求同源）——

  /** 启动时恢复已保存的设置覆盖（app-context 装配后调用一次）。
   *  F8（审计 2026-10-31）：双向恢复——此前只把保存的"关闭"生效，保存的
   *  "开启"在配置默认禁用时重启即丢（DB 仍为 1 而服务关闭）。 */
  restoreSavedSettings(): void {
    const model = this.repo.getSetting('sol_model');
    const template = this.repo.getSetting('sol_decision_template');
    const enabled = this.repo.getSetting('runtime_enabled');
    this.sol.applyOverrides({
      model: model ?? undefined,
      decision_template: template ?? null,
    });
    if (enabled === '1' || enabled === '0') {
      this.cfg = { ...this.cfg, enabled: enabled === '1' };
    }
  }

  settingsView(): Record<string, unknown> {
    const override = this.repo.getSetting('sol_decision_template');
    const modelOverride = this.repo.getSetting('sol_model');
    const enabledOverride = this.repo.getSetting('runtime_enabled');
    // R12（裁定 2026-11-03）：最终生效值+来源+作用范围——能回答"这次
    // 实际用了什么"。来源枚举：db_override（surfacing_settings 覆盖）/
    // config（yaml 或代码默认，以生效值为准）/ derived（按 R1 公式派生）/
    // observed（从 M 响应实测落库）。展示不改变配置优先级。
    const mLast = this.db.prepare(
      'SELECT m_policy_revision, m_prompt_revision, updated_at FROM surfacing_jobs WHERE m_policy_revision IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
    ).get() as { m_policy_revision: number; m_prompt_revision: string; updated_at: string } | undefined;
    return {
      enabled: this.cfg.enabled,
      sol: {
        configured: this.sol.isConfigured(),          // 只报状态，绝不回显凭据值
        model: this.sol.effectiveModel(),
        base_url: this.sol.cfg.baseUrl,
        cache_ttl: this.sol.cfg.cacheTtl,
        template_revision: this.sol.cfg.templateRevision,
        template_source: override ? 'override' : 'default',
        effective_template: this.sol.effectiveTemplate(), // 预览=请求正文同一出口
      },
      effective: {
        enabled: { value: this.cfg.enabled, scope: 'host', source: enabledOverride === null ? 'config' : 'db_override' },
        delivery_deadline_ms: { value: this.cfg.delivery_deadline_ms, scope: 'host/job', source: 'config' },
        max_added_tokens_per_turn: { value: this.cfg.max_added_tokens_per_turn, scope: 'host/turn', source: 'config' },
        max_packet_bytes: { value: this.cfg.max_packet_bytes, scope: 'host/turn', source: 'config' },
        delivery_budget_bytes: { value: this.deliveryBudgetBytes(), scope: 'host/turn', source: 'derived', note: 'min(max_added_tokens_per_turn×3, max_packet_bytes)；随 prepare/validate/check 载荷过线（R1/R3）' },
        worker_concurrency: { value: this.cfg.worker_concurrency, scope: 'host', source: 'config' },
        recent_user_messages: { value: this.cfg.recent_user_messages, scope: 'host', source: 'config' },
        recent_window_bytes: { value: this.cfg.recent_window_bytes, scope: 'host', source: 'config' },
        job_policy_revision: { value: this.cfg.policy_revision, scope: 'host/job', source: 'config', note: 'E 调度身份（R9），非 M 版本' },
        job_prompt_revision: { value: this.cfg.prompt_prepare_revision, scope: 'host/job', source: 'config', note: 'E 调度身份（R9），非 M 版本' },
        sol_model: { value: this.sol.effectiveModel(), scope: 'host/judge', source: modelOverride ? 'db_override' : 'config' },
        m_execution: mLast
          ? { policy_revision: mLast.m_policy_revision, prompt_revision: mLast.m_prompt_revision, observed_at: mLast.updated_at, source: 'observed' }
          : { source: 'observed', note: '尚无 M 版本观测（首个 prepare 响应后落库，R9）' },
        m_daily_quota: { source: 'observed', note: 'M 侧进程 env（当前 1000 次/$5），未跨线暴露——如实标注不可见，不冒充默认值' },
      },
    };
  }

  updateSettings(patch: { enabled?: unknown; model?: unknown; decision_template?: unknown }): { ok: boolean; error?: string } {
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') return { ok: false, error: 'enabled 必须是 boolean' };
      this.repo.setSetting('runtime_enabled', patch.enabled ? '1' : '0');
      this.cfg = { ...this.cfg, enabled: patch.enabled };
    }
    if (patch.model !== undefined) {
      if (patch.model !== null && typeof patch.model !== 'string') return { ok: false, error: 'model 必须是字符串或 null' };
      const model = typeof patch.model === 'string' && patch.model.trim().length > 0 ? patch.model.trim() : null;
      this.repo.setSetting('sol_model', model);
      this.sol.applyOverrides({ model: model ?? undefined });
    }
    if (patch.decision_template !== undefined) {
      if (patch.decision_template !== null && typeof patch.decision_template !== 'string') return { ok: false, error: 'decision_template 必须是字符串或 null（null=重置为默认）' };
      const template = typeof patch.decision_template === 'string' && patch.decision_template.trim().length > 0 ? patch.decision_template : null;
      if (template !== null && template.length > 65536) return { ok: false, error: 'decision_template 过长' };
      this.repo.setSetting('sol_decision_template', template);
      this.sol.applyOverrides({ decision_template: template });
    }
    return { ok: true };
  }

  visibleMemoriesForTurn(conversationId: string, turnId: string) {
    return this.repo.visibleForTurn(conversationId, turnId, this.speakerNames)
      .map(({ memory_ref, kind, date, text, speaker, title, mood_tags, our_words, context }) => ({
        memory_ref, kind, date, text, ...(speaker ? { speaker } : {}), ...(title ? { title } : {}),
        ...(mood_tags ? { mood_tags } : {}), ...(our_words ? { our_words } : {}), ...(context ? { context } : {}),
      }));
  }

  async readMemoryForTurn(conversationId: string, turnId: string, ref: string, cursor?: string, section: 'memory' | 'relations' | 'source' = 'memory') {
    const binding = this.repo.visibleForTurn(conversationId, turnId).find(it => it.memory_ref === ref);
    if (!binding) return { ok: false as const, code: 'DETAIL_REF_NOT_SEEN', message: '该回忆不属于本轮已交付内容' };
    const result = await executeMemoryReadFull(this.repo, this.client, { memory_ref: ref, cursor, section, view: 'model' },
      { roomId: conversationId, windowId: binding.windowId, requestId: binding.requestId });
    if (!result.ok) return result;
    const data = { ...result.data };
    const labels = this.speakerNames;
    for (const field of ['our_words', 'source']) {
      const entries = data[field];
      if (!Array.isArray(entries)) continue;
      data[field] = entries.map(entry => {
        const speaker = entry?.speaker ?? entry?.normalized_sender;
        return typeof speaker === 'string' ? { ...entry, display_speaker: speakerLabelFor(speaker, labels) } : entry;
      });
    }
    return { ok: true as const, data };
  }

  // —— 生命周期 ——

  async start(): Promise<void> {
    this.stopped = false;
    // 重启时所有未派发作业收口，包含旧跨轮待绑作业；不恢复到新用户轮。
    // 已派发但未保留的事实单独记录，不重放付费检索。
    for (const job of this.repo.recoverableJobs()) {
      if (job.state === 'reserved') {
        this.repo.dropAtFinalAdmission(job.id);
        continue;
      }
      this.repo.transition(job.id, ['pending', 'preparing', 'prepared', 'target_bound', 'validating', 'ready', 'reserved', 'dispatch_started'],
        job.state === 'dispatch_started' ? 'attempted_not_retained' : 'expired');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controllers of this.controllers.values()) for (const controller of controllers) controller.abort();
    await Promise.allSettled([...this.inflightPrepare.values(), ...this.inflightValidate.values()]);
  }

  // —— 源/目标投影 ——

  private sourceInputOf(job: JobRow): { messageId: string; revision: number; sequence: number; text: string; bodyHash: string; occurredAt: string | null } {
    const row = this.db.prepare(
      `SELECT m.id, m.sequence, r.revision, r.content, r.content_hash, r.occurred_at
       FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=?
       WHERE m.id=?`,
    ).get(job.source_revision, job.source_message_id) as { id: string; sequence: number; revision: number; content: string; content_hash: string; occurred_at: string | null } | undefined;
    if (row) return { messageId: row.id, revision: row.revision, sequence: row.sequence, text: effectiveRevisionText(this.db, row.id, row.revision, row.content), bodyHash: row.content_hash, occurredAt: row.occurred_at };
    return { messageId: job.source_message_id, revision: job.source_revision, sequence: job.source_sequence, text: '', bodyHash: '', occurredAt: null };
  }

  private targetInputOf(job: JobRow): { messageId: string; revision: number; sequence: number; text: string; bodyHash: string; occurredAt: string | null } | null {
    if (!job.target_message_id || !job.target_revision) return null;
    const row = this.db.prepare(
      `SELECT m.id, m.sequence, r.revision, r.content, r.content_hash, r.occurred_at
       FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision
       WHERE m.id=? AND m.current_revision=? AND m.conversation_id=? AND m.speaker='owner'`,
    ).get(job.target_message_id, job.target_revision, job.conversation_id) as { id: string; sequence: number; revision: number; content: string; content_hash: string; occurred_at: string | null } | undefined;
    if (!row) return null;
    return { messageId: row.id, revision: row.revision, sequence: row.sequence, text: effectiveRevisionText(this.db, row.id, row.revision, row.content), bodyHash: row.content_hash, occurredAt: row.occurred_at };
  }

  /** 从最近的 none、确认送达或 Sol 输入超限边界之后读取双方原话。 */
  private solCandidateDialogue(conversationId: string, beforeSequence: number, currentText: string): RecentMessage[] | null {
    let bytes = Buffer.byteLength(currentText, 'utf8');
    if (bytes > this.cfg.recent_window_bytes) return null;
    const boundary = this.repo.solInputBoundary(conversationId, beforeSequence);
    const rows = this.db.prepare(`SELECT m.id, m.sequence, m.speaker, m.current_revision AS rev, r.content, r.occurred_at
      FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision
      WHERE m.conversation_id=? AND m.sequence>? AND m.sequence<? AND m.published_at IS NOT NULL
        AND m.speaker IN ('owner','assistant') ORDER BY m.sequence`
    ).iterate(conversationId, boundary, beforeSequence) as Iterable<{
      id: string; sequence: number; speaker: RecentMessage['role']; rev: number; content: string; occurred_at: string | null;
    }>;
    const dialogue: RecentMessage[] = [];
    for (const row of rows) {
      const text = effectiveRevisionText(this.db, row.id, row.rev, row.content);
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > this.cfg.recent_window_bytes) return null;
      dialogue.push({ message_id: row.id, revision: row.rev, role: row.speaker, text, sequence: row.sequence, occurred_at: row.occurred_at });
    }
    return dialogue;
  }

  private identityFactsInWindow(windowId: string, approvedText: string | null | undefined, dialogue: string): string[] {
    if (!approvedText) return [];
    const row = this.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id=?').get(windowId) as { messages_json: string } | undefined;
    if (!row) return [];
    const [system] = JSON.parse(row.messages_json) as Array<{ role: string; content: unknown }>;
    const text = Array.isArray(system?.content) ? system.content.find(block => block?.type === 'text')?.text : system?.content;
    // A newly approved version does not appear in an already frozen window.
    if (system?.role !== 'system' || typeof text !== 'string' || !text.startsWith(`${approvedText}\n\n`)) return [];
    return projectIdentityFacts(approvedText, dialogue);
  }

  /** 来源回声核对使用的短近文。 */
  private recentDialogue(conversationId: string, beforeSequence: number, currentText: string): RecentMessage[] {
    const rows = this.db.prepare(
      `SELECT m.id, m.sequence, m.speaker, m.current_revision AS rev, r.content, r.occurred_at
       FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision
       WHERE m.conversation_id=? AND m.sequence < ? AND m.speaker IN ('owner','assistant')
       ORDER BY m.sequence DESC LIMIT 40`,
    ).all(conversationId, beforeSequence) as Array<{ id: string; sequence: number; speaker: string; rev: number; content: string; occurred_at: string | null }>;
    const messages: RecentMessage[] = rows.reverse().map((r) => ({
      message_id: r.id, revision: r.rev, role: r.speaker as 'owner' | 'assistant', text: effectiveRevisionText(this.db, r.id, r.rev, r.content), sequence: r.sequence, occurred_at: r.occurred_at,
    }));
    return this.trimJudgeDialogue(messages, currentText);
  }

  private trimJudgeDialogue(messages: RecentMessage[], currentText: string, plan?: SolDecisionPlan): RecentMessage[] {
    // JEV's bounded input still needs the original rows that attest to a date hint.
    // Keep two matches when ambiguous so dropping a row cannot invent a unique date.
    const dateAnchors = new Set<RecentMessage>();
    for (const query of plan?.queries ?? []) {
      if (!query.time_hint) continue;
      const hint = query.time_hint;
      for (const match of messages.filter(row => row.role === 'owner' && row.text.includes(hint)).slice(0, 2)) dateAnchors.add(match);
    }
    const trimmed = buildRecentDialogue(messages, {
      priorUserMessages: this.cfg.recent_user_messages,
      maxMessages: 16 - dateAnchors.size,
      budgetBytes: Math.max(0, this.cfg.recent_window_bytes - Buffer.byteLength(currentText, 'utf8')),
    });
    if (dateAnchors.size === 0) return trimmed;
    return [...new Set([...dateAnchors, ...trimmed])].sort((a, b) => a.sequence - b.sequence);
  }
}
