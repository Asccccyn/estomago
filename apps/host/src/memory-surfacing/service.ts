// SurfacingService：E 侧编排（docs/02/04 + SOL_RECALL_REFACTOR 2026-10-30）。
// - MessageService 接受事务内只登记作业（SQL 零网络；旧 regex 意图门已退役，
//   每条正式消息都登记），提交后唤醒 worker；
// - worker（提交后）先跑 Sol 三态判断（none/observe 收口；recall 出计划），
//   计划随既有 prepare 请求进入 M 检索/JEV → 同轮源/目标绑定 →
//   validate（有界复核）→ supervisor 装配期 check → 冻结注入块；
// - 每房间串行、全局并发上限；崩溃恢复有界；无后台补扫历史。
// - 后台零主模型 key / 零主模型 runner：M 走专用 MariposaClient（surfacing
//   credential_ref，不回退聊天凭据）；Sol 走独立 OpenAI key（sol-provider）。
import { executeMemoryReadFull } from './detail-tool.ts';
import { syncedSourceIdsFor, windowContextMessageIds } from './source-boundary.ts';
import type { Db } from '../db/connection.ts';
import { effectiveRevisionText } from '../messages/effective-text.ts';
import type { MariposaClient } from '../integrations/mariposa/client.ts';
import { SurfacingRepository, type JobRow } from './repository.ts';
import { buildRecentDialogue, type RecentMessage } from './trigger.ts';
import {
  estimateTokens, memoryRefFor, renderAugmentation, projectSurfacedMemory, SURFACE_HOST_NOTICE, surfaceItemKey,
  type FrozenAugmentation, type SurfaceItem,
} from './contracts.ts';
import {
  SolDecisionJudge, type SolDecisionInput, type SolDecisionPlan, type SolJudgeResult,
} from './sol-provider.ts';

export type SurfacingConfig = {
  enabled: boolean;
  policy_revision: number;
  prompt_prepare_revision: string;
  delivery_deadline_ms: number;
  max_added_tokens_per_turn: number;
  max_packet_bytes: number;
  transport_overhead_text?: string;
  worker_concurrency: number;
  /** 近文窗口：当前消息之外的先前用户消息条数（docs/01 §2 默认 3）。 */
  recent_user_messages: number;
  /** 本轮原话窗口字节预算（含当前消息，整轮移除最旧，不截断单条）。 */
  recent_window_bytes: number;
};

export type AugmentInput = {
  conversationId: string;
  windowId: string;
  turnId: string;
  attemptId: string;
  message: { id: string; revision: number; sequence: number | null; content: string; hash: string };
};

/** supervisor 薄接点拿到的冻结结果。 */
export type AugmentResult = FrozenAugmentation & { jobId: string };

export class SurfacingService {
  readonly repo: SurfacingRepository;
  private wakeScheduled = false;
  private running = 0;
  private roomRunning = new Set<string>();
  private stopped = false;
  private inflightPrepare = new Map<string, Promise<void>>();
  private inflightValidate = new Map<string, Promise<void>>();
  private active = new Set<Promise<void>>();
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
  private eventQueue: Array<import('./contracts.ts').SurfaceJobEventPayload> = [];
  private eventFlushScheduled = false;

  constructor(
    db: Db,
    client: MariposaClient,
    sol: SolDecisionJudge,
    cfg: SurfacingConfig,
    log: import('../observability/logging.ts').Logger | null,
    events: import('../events/service.ts').EventService | null = null,
  ) {
    this.db = db;
    this.client = client;
    this.sol = sol;
    this.cfg = cfg;
    this.log = log;
    this.events = events;
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

  cancelForTurn(turnId: string): void {
    const row = this.db.prepare(`SELECT m.id, m.conversation_id, m.current_revision FROM turns t
      JOIN messages m ON m.id=t.input_message_id WHERE t.id=?`).get(turnId) as
      { id: string; conversation_id: string; current_revision: number } | undefined;
    if (row) this.onUserMessageEdited({ conversationId: row.conversation_id, messageId: row.id, supersededRevision: row.current_revision });
  }

  afterCommit(): void {
    if (!this.cfg.enabled) return;
    this.scheduleWake();
  }

  // —— worker（每房间串行；全局并发上限）——

  private scheduleWake(): void {
    if (this.wakeScheduled || this.stopped) return;
    this.wakeScheduled = true;
    setImmediate(() => {
      this.wakeScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.stopped) return;
    const jobs = this.repo.pendingJobs(20);
    for (const job of jobs) {
      if (this.running >= this.cfg.worker_concurrency) break;
      if (this.roomRunning.has(job.conversation_id)) continue;
      const work = this.runJob(job).finally(() => this.active.delete(work));
      this.active.add(work);
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    try {
      if (job.state === 'pending') await this.ensurePrepared(job);

    } catch (err) {
      // prepare/validate 失败：本轮正常聊天不受影响，源作业记原因；
      // unknown 结果不自动无限重试（docs/08）
      const code = err instanceof Error && ['SURFACE_TIMEOUT', 'SURFACE_CANCELLED'].includes(err.message) ? err.message : 'SURFACE_UNKNOWN_OUTCOME';
      this.repo.transition(job.id, ['preparing', 'validating'], code === 'SURFACE_CANCELLED' ? 'cancelled' : code === 'SURFACE_TIMEOUT' ? 'timed_out' : 'blocked', { reason_code: code });
      this.log?.warn('surface_job_failed', { job: job.id, code });
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
    return previous.items.every(it => { const text = projectSurfacedMemory(it).text; return typeof text === 'string' && contextTexts.has(text); });
  }

  private current(job: JobRow): boolean {
    return job.source_message_id === job.target_message_id
      && job.source_revision === job.target_revision && this.targetInputOf(job) !== null;
  }

  private ensurePrepared(job: JobRow): Promise<void> {
    const existing = this.inflightPrepare.get(job.id);
    if (existing) return existing;
    if (this.running >= this.cfg.worker_concurrency || this.roomRunning.has(job.conversation_id)) {
      this.repo.transition(job.id, ['pending'], 'blocked', { reason_code: 'SURFACE_CAPACITY_EXHAUSTED' });
      return Promise.resolve();
    }
    this.running++;
    this.roomRunning.add(job.conversation_id);
    const work = this.preparePhase(job).finally(() => {
      this.inflightPrepare.delete(job.id);
      this.running--;
      this.roomRunning.delete(job.conversation_id);
      this.scheduleWake();
    });
    this.inflightPrepare.set(job.id, work);
    return work;
  }

  private async preparePhase(job: JobRow): Promise<void> {
    this.noteStage(job.id, 'firstRun');
    if (!this.current(job)) {
      this.repo.transition(job.id, ['pending'], 'expired', { reason_code: 'SURFACE_BINDING_INVALID' });
      return;
    }
    if (!this.repo.transition(job.id, ['pending'], 'preparing')) return;
    const src = this.sourceInputOf(job);
    if (Buffer.byteLength(src.text, 'utf8') > this.cfg.recent_window_bytes) {
      this.repo.transition(job.id, ['preparing'], 'blocked', { reason_code: 'SURFACE_BODY_TOO_LARGE' });
      return;
    }
    const recent = this.recentDialogue(job.conversation_id, src.sequence, src.text);
    // —— Sol 三态判断（事务提交后；先于任何 M 检索/JEV）——
    const sol = await this.runSolDecision(job, {
      currentMessage: { text: src.text },
      recentDialogue: recent.map(({ role, text }) => ({ role, text })),
    });
    if (!sol.ok) {
      // 技术失败 ≠ none：独立原因码落作业，主对话照常继续
      this.repo.transition(job.id, ['preparing'], 'blocked', {
        reason_code: sol.code,
        sol_usage_json: sol.usage ? JSON.stringify(sol.usage) : null,
      });
      this.log?.warn('surface_sol_failed', { job: job.id, code: sol.code, elapsed_ms: sol.elapsed_ms });
      return;
    }
    const d = sol.decision;
    this.repo.transition(job.id, ['preparing'], 'preparing', {
      sol_decision: d.decision, sol_topic: d.topic, sol_basis: d.basis,
      sol_plan_json: d.plan ? JSON.stringify(d.plan) : null,
      sol_usage_json: sol.usage ? JSON.stringify(sol.usage) : null,
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
      // 原始近文仍在聊天记录中；无需复制一份 observe 内容池。
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
    const activeWindow = (this.db.prepare('SELECT active_window_id FROM conversations WHERE id=?')
      .get(job.conversation_id) as { active_window_id: string | null } | undefined)?.active_window_id;
    const deliveredHere = previous?.windowId && previous.windowId === activeWindow && previous.items.length > 0
      && this.repo.coveredInWindow(job.conversation_id, previous.windowId, previous.items).size === previous.items.length;
    if (previous && (previous.outcome === 'no_match' || deliveredHere)) {
      this.repo.transition(job.id, ['preparing'], 'empty', {
        reason_code: previous.outcome === 'delivered' ? 'SURFACE_NEED_ALREADY_DELIVERED' : 'SURFACE_NEED_ALREADY_SEARCHED',
      });
      return;
    }
    const opId = `est-surface:${job.id}`;
    // RECALL_SOURCE_BOUNDARY：来源边界随 prepare 下推（excluded=触发消息
    // 全修订+回声；in_context=当前窗携带原文）。收据缺席=如实不带（fail-open）。
    const excluded_source_ids = syncedSourceIdsFor(this.db, [src.messageId], 64);
    const in_context_source_ids = syncedSourceIdsFor(this.db, windowContextMessageIds(this.db, job.conversation_id), 128);
    const r = await this.bounded(signal => this.client.surfacePrepare({
      operation_id: opId,
      conversation_scope: job.conversation_id,
      source_input: {
        message_id: src.messageId, revision: src.revision, sequence: src.sequence,
        text: src.text, body_hash: src.bodyHash, occurred_at: src.occurredAt,
      },
      recent_dialogue: recent,
      plan: this.planForMariposa(plan),
      ...(excluded_source_ids.length > 0 ? { excluded_source_ids } : {}),
      ...(in_context_source_ids.length > 0 ? { in_context_source_ids } : {}),
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
    if (state === 'empty') {
      // 只有M正常完成的空结果消费需要；接纳/预算/版本拒绝不等于查过。
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
    const attempt = (): Promise<SolJudgeResult> => this.bounded(
      signal => this.sol.decide(input, signal),
      this.deadline(job) - Date.now(), job.id,
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

  /** est→M 计划：Sol 输出的说话人显示名映射为 M 内部枚举；其余字段原样。 */
  private planForMariposa(plan: SolDecisionPlan): Record<string, unknown> {
    return {
      purpose: plan.purpose,
      route: plan.route,
      breadth: plan.breadth,
      queries: plan.queries.map(q => ({ semantic: q.semantic, keywords: q.keywords })),
      time_hint: plan.time_hint,
      speaker: this.speakerEnumFor(plan.speaker),
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
    const deadlineAt = new Date(this.deadline(job)).toISOString();
    const p = (async () => {
      const r = await this.bounded(signal => this.client.surfaceValidate({
        operation_id: `est-surface-v:${job.id}:${target.messageId}:${target.revision}`,
        conversation_scope: job.conversation_id,
        candidate_snapshot_ref: job.m_snapshot_ref ?? '',
        source_input_ref: { message_id: src.messageId, revision: src.revision },
        target_input: {
          message_id: target.messageId, revision: target.revision, sequence: target.sequence,
          text: target.text, body_hash: target.bodyHash, occurred_at: target.occurredAt,
        },
        recent_dialogue: this.recentDialogue(job.conversation_id, target.sequence, target.text),
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
        status?: string; validation_receipt?: string | null; items?: SurfaceItem[]; reason_code?: string | null;
      };
      const state = data.status === 'ready' ? 'ready'
        : data.status === 'empty' ? 'empty'
          : data.status === 'timed_out' ? 'timed_out'
            : data.status === 'rejected' ? 'rejected' : 'blocked';
      this.repo.transition(job.id, ['validating'], state, {
        receipt_id: data.validation_receipt ?? null,
        items_json: data.items && data.items.length > 0 ? JSON.stringify(data.items) : null,
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
    let job = this.repo.nextPreparedForTarget(input.conversationId, input.message.id);
    if (!job || job.target_revision !== input.message.revision || !this.current(job)) return null;
    const deadline = this.deadline(job);
    try {
      if (job.state === 'pending' || job.state === 'preparing') await this.ensurePrepared(job);
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
    const itemsAll = JSON.parse(fresh.items_json) as SurfaceItem[];
    // check：经 HTTP 调 Mariposa 的本地校验；回执绑目标消息/修订/窗口。
    let ck;
    try { ck = await this.bounded(signal => this.client.surfaceCheck({
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
    const covered = this.repo.coveredInWindow(input.conversationId, input.windowId, itemsAll);
    const items: SurfaceItem[] = [];
    const refs = new Map<string, string>();
    const refList: FrozenAugmentation['memoryRefs'] = [];
    let droppedCovered = 0;
    let droppedBudget = 0;
    for (const it of itemsAll) {
      if (!accepted.has(it.detail_ref)) continue;
      const key = surfaceItemKey(it);
      if (covered.has(key)) { droppedCovered++; continue; }
      const ref = memoryRefFor(it.detail_ref);
      const candidateRefs = new Map(refs).set(key, ref);
      const candidate = renderAugmentation([...items, it], candidateRefs);
      const wireText = (this.cfg.transport_overhead_text || SURFACE_HOST_NOTICE) + candidate;
      const tokens = estimateTokens(wireText);
      const bytes = Buffer.byteLength(wireText, 'utf8');
      if (tokens > this.cfg.max_added_tokens_per_turn
        || bytes > this.cfg.max_packet_bytes) { droppedBudget++; continue; }
      items.push(it);
      refs.set(key, ref);
      refList.push({ ref, detail_ref: it.detail_ref, event_id: it.event_id });
    }
    if (items.length === 0) {
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
    const text = renderAugmentation(items, refs);
    const deliveryId = this.repo.freezeDelivery({
      jobId: job.id, attemptId: input.attemptId, windowId: input.windowId,
      text, items, memoryRefs: refList,
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
            const covered = this.repo.coveredInWindow(input.conversationId, input.windowId, aug.items);
            if (aug.items.every(it => !covered.has(surfaceItemKey(it)))) return aug;
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
    this.repo.markRetained(result.jobId || '', result.deliveryId, result.items);
    // 检索目的完成状态：delivered（供下一轮 Sol 判断"同一需要已处理"）
    const job = result.jobId ? this.repo.jobById(result.jobId) : null;
    if (job) this.repo.recordSolRetrievalOutcome(job.id, 'delivered');
  }

  // —— 设置面（同一功能的唯一设置区域；生效值与实际请求同源）——

  get solJudge(): SolDecisionJudge { return this.sol; }

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
    return this.repo.visibleForTurn(conversationId, turnId)
      .map(({ memory_ref, date, text }) => ({ memory_ref, date, text }));
  }

  async readMemoryForTurn(conversationId: string, turnId: string, ref: string, cursor?: string, section: 'memory' | 'relations' | 'source' = 'memory') {
    const binding = this.repo.visibleForTurn(conversationId, turnId).find(it => it.memory_ref === ref);
    if (!binding) return { ok: false as const, code: 'DETAIL_REF_NOT_SEEN', message: '该回忆不属于本轮已交付内容' };
    return executeMemoryReadFull(this.repo, this.client, { memory_ref: ref, cursor, section, view: 'model' },
      { roomId: conversationId, windowId: binding.windowId, requestId: binding.requestId });
  }

  // —— 生命周期 ——

  async start(): Promise<void> {
    this.stopped = false;
    // 重启时所有未派发作业收口，包含旧跨轮待绑作业；不恢复到新用户轮。
    // 已派发但未保留的事实单独记录，不重放付费检索。
    for (const job of this.repo.recoverableJobs()) {
      this.repo.transition(job.id, ['pending', 'preparing', 'prepared', 'target_bound', 'validating', 'ready', 'reserved', 'dispatch_started'],
        job.state === 'dispatch_started' ? 'attempted_not_retained' : 'expired');
    }
    this.scheduleWake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controllers of this.controllers.values()) for (const controller of controllers) controller.abort();
    await Promise.allSettled([...this.active, ...this.inflightPrepare.values(), ...this.inflightValidate.values()]);
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

  /** 近文窗口：先取有界原始行（混合 ≤40），再按用户消息计数裁窗；
   *  当前消息不在其中（调用方单独追加，保证只出现一次）。 */
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
    return buildRecentDialogue(messages, {
      priorUserMessages: this.cfg.recent_user_messages,
      maxMessages: 16,
      budgetBytes: Math.max(0, this.cfg.recent_window_bytes - Buffer.byteLength(currentText, 'utf8')),
    });
  }
}
