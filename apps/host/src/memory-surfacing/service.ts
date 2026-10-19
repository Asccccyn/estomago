// SurfacingService：E 侧编排（docs/02/04）。
// - MessageService 接受事务内只登记作业（SQL 零网络），提交后唤醒 worker；
// - worker：prepare（Uₙ 后台准备，绝不进 Uₙ 当前请求）→ 目标绑定 →
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
  private inflightValidate = new Map<string, Promise<void>>();
  private active = new Set<Promise<void>>();
  private controllers = new Map<string, AbortController>();

  private async bounded<T>(call: (signal: AbortSignal) => Promise<T>, ms: number, jobId: string): Promise<T> {
    if (ms <= 0 || this.stopped) throw new Error('SURFACE_TIMEOUT');
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([call(controller.signal), new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('SURFACE_CANCELLED')), { once: true });
        timer = setTimeout(() => { reject(new Error('SURFACE_TIMEOUT')); controller.abort(); }, Math.max(1, ms));
      })]);
    } finally { clearTimeout(timer!); this.controllers.delete(jobId); }
  }

  private db: Db;
  private client: MariposaClient;
  private cfg: SurfacingConfig;
  private log: import('../observability/logging.ts').Logger | null;

  constructor(
    db: Db,
    client: MariposaClient,
    cfg: SurfacingConfig,
    log: import('../observability/logging.ts').Logger | null,
  ) {
    this.db = db;
    this.client = client;
    this.cfg = cfg;
    this.log = log;
    this.repo = new SurfacingRepository(db);
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
      });
    }
    this.log?.info('surface_recall_gate', {
      conversation: o.conversationId, message: o.messageId, revision: o.revision,
      action: gate.action, reason: gate.reason, registered: jobId !== null,
    });
    // 目标绑定：这是"下一条真实用户输入"——同房最近一条 awaiting 的
    // prepared 作业绑到本消息；更早仍未绑定的按 missed_target 清账。
    // 与本条是否需要检索无关（旧实现对每条非空消息都执行，此处保持）。
    const awaiting = this.repo.preparedAwaitingTarget(o.conversationId, o.sequence);
    for (const job of awaiting) {
      if (job.id === jobId) continue;
      if (job.state === 'prepared') {
        this.repo.bindTarget({ conversationId: o.conversationId, jobId: job.id, targetMessageId: o.messageId, targetRevision: o.revision });
      }
    }
    this.repo.markMissedTargets(o.conversationId, o.sequence);
  }

  /** 两段式门：纯函数先行；仅 needs_context（"后来呢"）才读有界近期状态。 */
  private recallGate(o: { conversationId: string; sequence: number; content: string; occurredAt: string | null }): RecallGateResult {
    const now = o.occurredAt ? new Date(o.occurredAt) : new Date();
    const first = detectRecallNeed(o.content, null, Number.isNaN(now.getTime()) ? new Date() : now);
    if (first.action !== 'needs_context') return first;
    return detectRecallNeed(o.content, this.recentRecallState(o.conversationId, o.sequence), now);
  }

  /** 有界近期状态：最近 ≤2 个已接受 owner 轮里已确定回忆对象（prepared）的作业。
   *  只取用户自己消息的身份（id/revision/sequence），不读全历史、不存模型猜测；
   *  之前未命中（empty）、悬置（rejected/blocked）或已换题（作业已被后续消息
   *  绑走）都不延续。 */
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
    for (const [id, controller] of this.controllers) {
      if (this.repo.jobById(id)?.state === 'cancelled') controller.abort();
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
      this.roomRunning.add(job.conversation_id);
      this.running++;
      const work = this.runJob(job).finally(() => {
        this.active.delete(work);
        this.running--;
        this.roomRunning.delete(job.conversation_id);
        this.scheduleWake();
      });
      this.active.add(work);
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    try {
      if (job.state === 'pending') await this.preparePhase(job);

    } catch (err) {
      // prepare/validate 失败：本轮正常聊天不受影响，源作业记原因；
      // unknown 结果不自动无限重试（docs/08）
      const code = err instanceof Error && ['SURFACE_TIMEOUT', 'SURFACE_CANCELLED'].includes(err.message) ? err.message : 'SURFACE_UNKNOWN_OUTCOME';
      this.repo.transition(job.id, ['preparing', 'validating'], code === 'SURFACE_CANCELLED' ? 'cancelled' : 'blocked', { reason_code: code });
      this.log?.warn('surface_job_failed', { job: job.id, code });
    }
  }

  private async preparePhase(job: JobRow): Promise<void> {
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
    }, signal), 10000, job.id);
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
    const deadlineAt = new Date(Date.now() + this.cfg.delivery_deadline_ms).toISOString();
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
      }, signal), this.cfg.delivery_deadline_ms, job.id);
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
    const job = this.repo.nextPreparedForTarget(input.conversationId, input.message.id);
    if (!job) return null;
    if (job.target_revision !== input.message.revision) return null; // 目标并发改版：旧 receipt 作废
    const deadline = Date.now() + this.cfg.delivery_deadline_ms;
    // The window only exists at assembly time. A placeholder would make the
    // real Mariposa receipt invalid (a permissive fake hid this previously).
    if (job.state === 'target_bound') await this.validatePhase(job, input.windowId);
    else if (job.state === 'validating') {
      const inflight = this.inflightValidate.get(job.id);
      if (inflight) await inflight.catch(() => undefined);
    }
    const fresh = this.repo.jobById(job.id);
    if (!fresh || fresh.state !== 'ready' || !fresh.items_json) return null;
    const itemsAll = JSON.parse(fresh.items_json) as SurfaceItem[];
    // check：经 HTTP 调 Mariposa 的本地校验；回执绑目标消息/修订/窗口。
    const ck = await this.bounded(signal => this.client.surfaceCheck({
      validation_receipt: fresh.receipt_id ?? '',
      conversation_scope: input.conversationId,
      target_message_id: input.message.id,
      target_revision: input.message.revision,
      window_id: input.windowId,
    }, signal), deadline - Date.now(), job.id);
    if (!ck.ok) return null;
    const ckd = ck.result as { valid?: boolean; accepted_detail_refs?: string[] };
    if (ckd.valid !== true) return null;
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
    if (items.length === 0) return null;
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
    if (job.state !== 'reserved'
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
      }, signal), this.cfg.delivery_deadline_ms, job.id);
      if (ck.ok) {
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
    // 崩溃恢复：中断态收口（preparing/validating 的付费未知结果按原 op
    // 重放由 M 侧幂等承担；这里只把超窗作业收成 missed/expired，有界）
    for (const job of this.repo.recoverableJobs()) {
      this.repo.transition(job.id, ['preparing', 'validating', 'reserved', 'dispatch_started'],
        job.state === 'dispatch_started' ? 'attempted_not_retained' : 'expired');
    }
    this.scheduleWake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.active, ...this.inflightValidate.values()]);
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
       WHERE m.id=? AND m.current_revision=?`,
    ).get(job.target_message_id, job.target_revision) as { id: string; sequence: number; revision: number; content: string; content_hash: string; occurred_at: string | null } | undefined;
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
