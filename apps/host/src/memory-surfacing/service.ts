// SurfacingService：E 侧编排（docs/02/04）。
// - MessageService 接受事务内只登记作业（SQL 零网络），提交后唤醒 worker；
// - worker：prepare（Uₙ 后台准备，绝不进 Uₙ 当前请求）→ 目标绑定 →
//   validate（有界复核）→ supervisor 装配期 check（纯本地）→ 冻结注入块；
// - 每房间串行、全局并发上限；崩溃恢复有界；无后台补扫历史。
// - 后台零主模型 key / 零主模型 runner：专用 MariposaClient（surfacing
//   credential_ref，不回退聊天凭据）。
import type { Db } from '../db/connection.ts';
import type { MariposaClient } from '../integrations/mariposa/client.ts';
import { SurfacingRepository, type JobRow } from './repository.ts';
import { extractHypotheses, buildRecentDialogue } from './trigger.ts';
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
    const jobId = this.repo.registerAcceptedJob({
      conversationId: o.conversationId, messageId: o.messageId, revision: o.revision,
      sequence: o.sequence, content: o.content, contentHash: o.contentHash,
      occurredAt: o.occurredAt, hypotheses,
      policyRevision: this.cfg.policy_revision, promptRevision: this.cfg.prompt_prepare_revision,
    });
    // 目标绑定：这是"下一条真实用户输入"——同房最近一条 awaiting 的
    // prepared 作业绑到本消息；更早仍未绑定的按 missed_target 清账。
    if (jobId) {
      const awaiting = this.repo.preparedAwaitingTarget(o.conversationId, o.sequence);
      for (const job of awaiting) {
        if (job.id === jobId) continue;
        if (job.state === 'prepared') {
          this.repo.bindTarget({ conversationId: o.conversationId, jobId: job.id, targetMessageId: o.messageId, targetRevision: o.revision });
        }
      }
      this.repo.markMissedTargets(o.conversationId, o.sequence);
    }
  }

  onUserMessageEdited(o: { conversationId: string; messageId: string; supersededRevision: number }): void {
    if (!this.cfg.enabled) return;
    this.repo.cancelJobsForRevision(o.conversationId, o.messageId, o.supersededRevision);
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
      void this.runJob(job).finally(() => {
        this.running--;
        this.roomRunning.delete(job.conversation_id);
        this.scheduleWake();
      });
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    try {
      if (job.state === 'pending') await this.preparePhase(job);
      else if (job.state === 'target_bound') await this.validatePhase(job);
      else if (job.state === 'validating') await this.validatePhase(job);
    } catch (err) {
      // prepare/validate 失败：本轮正常聊天不受影响，源作业记原因；
      // unknown 结果不自动无限重试（docs/08）
      const code = err instanceof Error ? err.message.slice(0, 60) : 'unknown';
      this.repo.transition(job.id, ['preparing', 'validating'], 'blocked', { reason_code: code });
      this.log?.warn('surface_job_failed', { job: job.id, code });
    }
  }

  private async preparePhase(job: JobRow): Promise<void> {
    if (!this.repo.transition(job.id, ['pending'], 'preparing')) return;
    const src = this.sourceInputOf(job);
    const opId = `est-surface:${job.id}`;
    const r = await this.client.surfacePrepare({
      operation_id: opId,
      conversation_scope: job.conversation_id,
      source_input: {
        message_id: src.messageId, revision: src.revision, sequence: src.sequence,
        text: src.text, body_hash: src.bodyHash, occurred_at: src.occurredAt,
      },
      recent_dialogue: this.recentDialogue(job.conversation_id, src.sequence),
      event_hypotheses: JSON.parse(job.hypotheses_json ?? '[]'),
    });
    if (!r.ok) {
      this.repo.transition(job.id, ['preparing'], 'blocked', { reason_code: r.code, m_operation_id: opId });
      return;
    }
    const data = r.result as { status?: string; surface_run_id?: string; candidate_snapshot_ref?: string | null; reason_code?: string | null };
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

  private async validatePhase(job: JobRow): Promise<void> {
    if (job.state === 'target_bound' && !this.repo.transition(job.id, ['target_bound'], 'validating')) return;
    const src = this.sourceInputOf(job);
    const target = this.targetInputOf(job);
    if (!target) {
      this.repo.transition(job.id, ['validating', 'target_bound'], 'missed_target');
      return;
    }
    const deadlineAt = new Date(Date.now() + this.cfg.delivery_deadline_ms).toISOString();
    const p = (async () => {
      const r = await this.client.surfaceValidate({
        operation_id: `est-surface-v:${job.id}:${target.messageId}:${target.revision}`,
        conversation_scope: job.conversation_id,
        candidate_snapshot_ref: job.m_snapshot_ref ?? '',
        source_input_ref: { message_id: src.messageId, revision: src.revision },
        target_input: {
          message_id: target.messageId, revision: target.revision, sequence: target.sequence,
          text: target.text, body_hash: target.bodyHash, occurred_at: target.occurredAt,
        },
        recent_dialogue: this.recentDialogue(job.conversation_id, target.sequence),
        window_id: 'pending-check',
        deadline_at: deadlineAt,
      });
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
    try { await p; } finally { this.inflightValidate.delete(job.id); }
  }

  // —— supervisor 薄接点（装配期；本钩子不阻塞超过剩余 deadline）——

  async augmentFor(input: AugmentInput): Promise<AugmentResult | null> {
    if (!this.cfg.enabled) return null;
    const job = this.repo.nextPreparedForTarget(input.conversationId, input.message.id);
    if (!job) return null;
    if (job.target_revision !== input.message.revision) return null; // 目标并发改版：旧 receipt 作废
    const deadline = Date.now() + this.cfg.delivery_deadline_ms;
    if (job.state === 'validating') {
      // 有界等待最终复核完成（不包含新检索；超时本轮零注入）
      const inflight = this.inflightValidate.get(job.id);
      if (inflight) {
        await Promise.race([inflight, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
      }
    }
    const fresh = this.repo.jobById(job.id);
    if (!fresh || fresh.state !== 'ready' || !fresh.items_json) return null;
    const itemsAll = JSON.parse(fresh.items_json) as SurfaceItem[];
    // check：as-of 本地校验（纯本地无网络；回执绑目标消息/修订/窗口）
    const ck = await this.client.surfaceCheck({
      validation_receipt: fresh.receipt_id ?? '',
      conversation_scope: input.conversationId,
      target_message_id: input.message.id,
      target_revision: input.message.revision,
      window_id: input.windowId,
    });
    if (!ck.ok) return null;
    const ckd = ck.result as { valid?: boolean; accepted_detail_refs?: string[] };
    if (ckd.valid !== true) return null;
    const accepted = new Set(ckd.accepted_detail_refs ?? []);
    // 去重（本窗口实际上下文为准）+ 预算（按源事件顺序装入严格赢家；
    // 放不下的整条跳过，不截断/不摘要/不换次优——R33/R34）
    const covered = this.repo.coveredInWindow(input.conversationId, input.windowId, itemsAll);
    const items: SurfaceItem[] = [];
    let usedTokens = 0;
    const refs = new Map<string, string>();
    const refList: FrozenAugmentation['memoryRefs'] = [];
    for (const it of itemsAll) {
      if (!accepted.has(it.detail_ref)) continue;
      if (covered.has(it.event_id)) continue;
      const ref = memoryRefFor(it.detail_ref);
      const candidate = renderAugmentation([...items, it], new Map([[it.event_id, ref]]));
      const tokens = estimateTokens(candidate);
      const bytes = Buffer.byteLength(candidate, 'utf8');
      if (usedTokens + tokens > this.cfg.max_added_tokens_per_turn
        || bytes > this.cfg.max_packet_bytes) break;
      items.push(it);
      refs.set(it.event_id, ref);
      refList.push({ ref, detail_ref: it.detail_ref, event_id: it.event_id });
      usedTokens += tokens;
    }
    if (items.length === 0) return null;
    const text = renderAugmentation(items, refs);
    const deliveryId = this.repo.freezeDelivery({
      jobId: job.id, attemptId: input.attemptId, windowId: input.windowId,
      text, items, memoryRefs: refList,
    });
    this.repo.markDispatchStarted(job.id, deliveryId);
    return { deliveryId, text, items, memoryRefs: refList, payloadHash: this.repo.frozenForAttempt(input.attemptId)?.payload_hash ?? '', jobId: job.id };
  }

  /** 已冻结的 attempt 重试：transport retry 复用完全相同冻结包（docs/04）。 */
  reuseFrozen(attemptId: string): AugmentResult | null {
    const frozen = this.repo.frozenForAttempt(attemptId);
    if (!frozen) return null;
    const parsed = JSON.parse(frozen.selected_refs_json) as { items: SurfaceItem[]; refs: FrozenAugmentation['memoryRefs'] };
    return { deliveryId: frozen.id, text: frozen.payload_text, items: parsed.items, memoryRefs: parsed.refs, payloadHash: frozen.payload_hash, jobId: '' };
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
