// SurfacingService：E 侧编排（docs/02/04）。
// - MessageService 接受事务内只登记作业（SQL 零网络），提交后唤醒 worker；
// - worker 与当轮装配共享 prepare → 同轮源/目标绑定 →
//   validate（有界复核）→ supervisor 装配期通过 HTTP 调 M 本地 check → 冻结注入块；
// - 每房间串行、全局并发上限；崩溃恢复有界；无后台补扫历史。
// - 后台零主模型 key / 零主模型 runner：专用 MariposaClient（surfacing
//   credential_ref，不回退聊天凭据）。
import type { Db } from '../db/connection.ts';
import type { MariposaClient } from '../integrations/mariposa/client.ts';
import { SurfacingRepository, type JobRow } from './repository.ts';
import {
  extractHypotheses, buildRecentDialogue, detectRecallNeed,
  type RecallGateResult, type RecentRecallState,
} from './trigger.ts';
import {
  estimateTokens, memoryRefFor, renderAugmentation,
  type FrozenAugmentation, type SurfaceItem,
} from './contracts.ts';

export type SurfacingConfig = {
  enabled: boolean;
  policy_revision: number;
  prompt_prepare_revision: string;
  delivery_deadline_ms: number;
  max_added_tokens_per_turn: number;
  max_packet_bytes: number;
  worker_concurrency: number;
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
  private cfg: SurfacingConfig;
  private log: import('../observability/logging.ts').Logger | null;
  private events: import('../events/service.ts').EventService | null;
  private eventQueue: Array<import('./contracts.ts').SurfaceJobEventPayload> = [];
  private eventFlushScheduled = false;

  constructor(
    db: Db,
    client: MariposaClient,
    cfg: SurfacingConfig,
    log: import('../observability/logging.ts').Logger | null,
    events: import('../events/service.ts').EventService | null = null,
  ) {
    this.db = db;
    this.client = client;
    this.cfg = cfg;
    this.log = log;
    this.events = events;
    // R05（审计 J02）：状态提交处收集生命周期事件，微任务批量落 SSE——
    // 事务内的状态写入不会嵌套开 EventService 事务；事件=投影非正本，
    // 发布失败只记日志绝不影响浮现状态机。
    this.repo = new SurfacingRepository(db, (p) => {
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
    const hypotheses = extractHypotheses(o.content);
    if (hypotheses.length === 0) return;
    // P1 回忆意图门（她 2026-10-20）：只控制"要不要登记检索作业"。普通
    // 聊天 skip → 零 Mariposa 检索/Dense/JEV；归档 outbox 在 MessageService
    // 另一条路径，不受影响。第一段纯函数零 I/O，只有省略表达才读近期状态。
    const gate = this.recallGate(o);
    let jobId: string | null = null;
    if (gate.action === 'lookup') {
      jobId = this.repo.registerAcceptedJob({
        conversationId: o.conversationId, messageId: o.messageId, revision: o.revision,
        sequence: o.sequence, content: o.content, contentHash: o.contentHash,
        occurredAt: o.occurredAt, hypotheses,
        policyRevision: this.cfg.policy_revision, promptRevision: this.cfg.prompt_prepare_revision,
        deadlineMs: this.cfg.delivery_deadline_ms,
      });
    }
    this.log?.info('surface_recall_gate', {
      conversation: o.conversationId, message: o.messageId, revision: o.revision,
      action: gate.action, reason: gate.reason, registered: jobId !== null,
    });
  }

  /** 两段式门：纯函数先行；仅 needs_context（"后来呢"）才读有界近期状态。 */
  private recallGate(o: { conversationId: string; sequence: number; content: string; occurredAt: string | null }): RecallGateResult {
    const now = o.occurredAt ? new Date(o.occurredAt) : new Date();
    const first = detectRecallNeed(o.content, null, Number.isNaN(now.getTime()) ? new Date() : now);
    if (first.action !== 'needs_context') return first;
    return detectRecallNeed(o.content, this.recentRecallState(o.conversationId, o.sequence), now);
  }

  /** 有界近期状态：最近 ≤2 个已接受 owner 轮里已确定回忆对象或已验证交付的同轮作业。
   *  只取用户自己消息的身份（id/revision/sequence），不读全历史、不存模型猜测；
   *  之前未命中（empty）、悬置（rejected/blocked）或修订失效都不延续。 */
  private recentRecallState(conversationId: string, beforeSequence: number): RecentRecallState {
    const rows = this.db.prepare(
      `SELECT sequence FROM messages WHERE conversation_id=? AND sequence < ? AND speaker='owner'
       ORDER BY sequence DESC LIMIT 2`,
    ).all(conversationId, beforeSequence) as Array<{ sequence: number }>;
    if (rows.length === 0) return { boundLookup: null };
    const job = this.repo.preparedBetween(conversationId, rows[rows.length - 1].sequence, beforeSequence);
    return {
      boundLookup: job
        ? { sourceMessageId: job.source_message_id, sourceRevision: job.source_revision, sourceSequence: job.source_sequence }
        : null,
    };
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

  private deadline(job: JobRow): number {
    const value = job.expires_at ? Date.parse(job.expires_at) : Date.parse(job.created_at) + this.cfg.delivery_deadline_ms;
    return Number.isFinite(value) ? value : 0;
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
    if (!this.current(job)) {
      this.repo.transition(job.id, ['pending'], 'expired', { reason_code: 'SURFACE_BINDING_INVALID' });
      return;
    }
    if (!this.repo.transition(job.id, ['pending'], 'preparing')) return;
    const src = this.sourceInputOf(job);
    const opId = `est-surface:${job.id}`;
    const r = await this.bounded(signal => this.client.surfacePrepare({
      operation_id: opId,
      conversation_scope: job.conversation_id,
      source_input: {
        message_id: src.messageId, revision: src.revision, sequence: src.sequence,
        text: src.text, body_hash: src.bodyHash, occurred_at: src.occurredAt,
      },
      recent_dialogue: this.recentDialogue(job.conversation_id, src.sequence),
      event_hypotheses: JSON.parse(job.hypotheses_json ?? '[]'),
    }, signal), this.deadline(job) - Date.now(), job.id);
    if (Date.now() >= this.deadline(job)) throw new Error('SURFACE_TIMEOUT');
    if (!r.ok) {
      this.repo.transition(job.id, ['preparing'], 'blocked', { reason_code: r.code, m_operation_id: opId });
      return;
    }
    const data = r.result as { status?: string; candidate_snapshot_ref?: string | null; reason_code?: string | null };
    const state = data.status === 'prepared' ? 'prepared'
      : data.status === 'empty' ? 'empty'
        : data.status === 'rejected' ? 'rejected'
          : data.status === 'unknown_outcome' ? 'unknown_cost' : 'blocked';
    this.repo.transition(job.id, ['preparing'], state, {
      m_operation_id: opId,
      m_snapshot_ref: data.candidate_snapshot_ref ?? null,
      reason_code: data.reason_code ?? null,
    });
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
        recent_dialogue: this.recentDialogue(job.conversation_id, target.sequence),
        window_id: windowId,
        deadline_at: deadlineAt,
      }, signal), this.deadline(job) - Date.now(), job.id);
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
    // 去重（本窗口实际上下文为准）+ 预算（按源事件顺序装入严格赢家；
    // 放不下的整条跳过，不截断/不摘要/不换次优——R33/R34）
    const covered = this.repo.coveredInWindow(input.conversationId, input.windowId, itemsAll);
    const items: SurfaceItem[] = [];
    const refs = new Map<string, string>();
    const refList: FrozenAugmentation['memoryRefs'] = [];
    for (const it of itemsAll) {
      if (!accepted.has(it.detail_ref)) continue;
      if (covered.has(it.event_id)) continue;
      const ref = memoryRefFor(it.detail_ref);
      const candidateRefs = new Map(refs).set(it.event_id, ref);
      const candidate = renderAugmentation([...items, it], candidateRefs);
      const tokens = estimateTokens(candidate);
      const bytes = Buffer.byteLength(candidate, 'utf8');
      if (tokens > this.cfg.max_added_tokens_per_turn
        || bytes > this.cfg.max_packet_bytes) continue;
      items.push(it);
      refs.set(it.event_id, ref);
      refList.push({ ref, detail_ref: it.detail_ref, event_id: it.event_id });
    }
    if (items.length === 0) {
      this.repo.transition(job.id, ['ready'], 'empty');
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
        const ckd = ck.result as { valid?: boolean; accepted_detail_refs?: string[] };
        if (ckd.valid === true) {
          // 接受面收缩（权限/版本撤销）：冻结块任一条掉出 accepted 即整块丢弃
          const accepted = new Set(ckd.accepted_detail_refs ?? []);
          if (aug.items.every(it => accepted.has(it.detail_ref))) {
            // 装配间隙同窗重复覆盖防护：任一事件已被实际覆盖即整块丢弃
            const covered = this.repo.coveredInWindow(input.conversationId, input.windowId, aug.items);
            if (aug.items.every(it => !covered.has(it.event_id))) return aug;
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
    if (row) return { messageId: row.id, revision: row.revision, sequence: row.sequence, text: row.content, bodyHash: row.content_hash, occurredAt: row.occurred_at };
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
    return { messageId: row.id, revision: row.revision, sequence: row.sequence, text: row.content, bodyHash: row.content_hash, occurredAt: row.occurred_at };
  }

  private recentDialogue(conversationId: string, beforeSequence: number): Array<{ message_id: string; revision: number; role: 'owner' | 'assistant'; text: string; sequence: number }> {
    const rows = this.db.prepare(
      `SELECT m.id, m.sequence, m.speaker, m.current_revision AS rev, r.content
       FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision
       WHERE m.conversation_id=? AND m.sequence < ? AND m.speaker IN ('owner','assistant')
       ORDER BY m.sequence DESC LIMIT 6`,
    ).all(conversationId, beforeSequence) as Array<{ id: string; sequence: number; speaker: string; rev: number; content: string }>;
    return buildRecentDialogue(rows.reverse().map((r) => ({
      message_id: r.id, revision: r.rev, role: r.speaker as 'owner' | 'assistant', text: r.content, sequence: r.sequence,
    })));
  }
}
