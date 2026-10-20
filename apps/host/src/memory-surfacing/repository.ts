// surfacing 运行表（迁移 v29）+ 作业状态机 CAS + 覆盖清单。
// 有界运行数据（docs/02）：候选选择/预留/实际交付分开存；coverage 是
// 投影清单可重建，不是永久 seen。表含对话/记忆投影——不进日志/Git。
import type { Db } from '../db/connection.ts';
import { genId, sha256Hex } from '../util/id.ts';
import type { EventHypothesis, SurfaceItem, SurfacingJobState } from './contracts.ts';

export type JobRow = {
  id: string;
  conversation_id: string;
  source_message_id: string;
  source_revision: number;
  source_sequence: number;
  target_message_id: string | null;
  target_revision: number | null;
  state: SurfacingJobState;
  generation: number;
  m_operation_id: string | null;
  m_snapshot_ref: string | null;
  policy_revision: number | null;
  prompt_revision: string | null;
  hypotheses_json: string | null;
  receipt_id: string | null;
  items_json: string | null;
  reason_code: string | null;
  deadline_ms: number | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
};

const JOB_COLS = 'id, conversation_id, source_message_id, source_revision, source_sequence, target_message_id, target_revision, state, generation, m_operation_id, m_snapshot_ref, policy_revision, prompt_revision, hypotheses_json, receipt_id, items_json, reason_code, deadline_ms, created_at, updated_at, expires_at';

export class SurfacingRepository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  // —— 事务内登记（MessageService 调用；只 SQL，不做网络）——

  /** 逻辑作业唯一键 (room, source_message_id, source_revision, policy, prompt)：
   *  前端重发相同 client_message_id 由 MessageService 幂等挡住，不重复建作业。 */
  registerAcceptedJob(o: {
    conversationId: string; messageId: string; revision: number; sequence: number;
    content: string; contentHash: string; occurredAt: string | null;
    hypotheses: EventHypothesis[]; policyRevision: number; promptRevision: string;
  }): string | null {
    if (o.hypotheses.length === 0) return null;
    const id = genId('sfj');
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO surfacing_jobs(id, conversation_id, source_message_id, source_revision,
         source_sequence, state, generation, hypotheses_json, policy_revision, prompt_revision,
         source_body_hash, deadline_ms, created_at, updated_at)
       VALUES (?,?,?,?,?, 'pending', 0, ?,?,?,?, NULL, ?, ?)
       ON CONFLICT(conversation_id, source_message_id, source_revision, policy_revision, prompt_revision)
       DO NOTHING`,
    ).run(id, o.conversationId, o.messageId, o.revision, o.sequence,
      JSON.stringify(o.hypotheses), o.policyRevision, o.promptRevision,
      o.contentHash, now, now);
    const row = this.jobByLogicalKey(o.conversationId, o.messageId, o.revision, o.policyRevision, o.promptRevision);
    return row?.id ?? id;
  }

  jobByLogicalKey(conversationId: string, messageId: string, revision: number, policyRev: number, promptRev: string): JobRow | null {
    const row = this.db.prepare(
      `SELECT ${JOB_COLS} FROM surfacing_jobs WHERE conversation_id=? AND source_message_id=? AND source_revision=? AND policy_revision=? AND prompt_revision=?`,
    ).get(conversationId, messageId, revision, policyRev, promptRev) as JobRow | undefined;
    return row ?? null;
  }

  jobById(id: string): JobRow | null {
    const row = this.db.prepare(`SELECT ${JOB_COLS} FROM surfacing_jobs WHERE id=?`).get(id) as JobRow | undefined;
    return row ?? null;
  }

  /** 消息编辑：撤销旧修订作业（仍未错过下一目标轮的可建新作业——上层判断）。 */
  cancelJobsForRevision(conversationId: string, messageId: string, supersededRevision: number): number {
    const r = this.db.prepare(
      `UPDATE surfacing_jobs SET state='cancelled', updated_at=?
       WHERE conversation_id=? AND source_message_id=? AND source_revision=? AND state NOT IN
         ('retained','attempted_not_retained','cancelled','superseded','missed_target','expired')`,
    ).run(new Date().toISOString(), conversationId, messageId, supersededRevision);
    return Number(r.changes);
  }

  /** 绑定下一真实用户输入（真实 accepted-user ordinal，不是 seq+1）。 */
  bindTarget(o: { conversationId: string; jobId: string; targetMessageId: string; targetRevision: number }): boolean {
    const r = this.db.prepare(
      `UPDATE surfacing_jobs SET state='target_bound', target_message_id=?, target_revision=?, updated_at=?
       WHERE id=? AND state IN ('prepared','empty','rejected','blocked','unknown_cost')`,
    ).run(o.targetMessageId, o.targetRevision, new Date().toISOString(), o.jobId);
    return Number(r.changes) === 1;
  }

  /** CAS 状态迁移（state+generation+source_revision+target_revision 边校验）。 */
  transition(jobId: string, from: SurfacingJobState[], to: SurfacingJobState, patch: Partial<Record<string, unknown>> = {}): boolean {
    const marks = from.map(() => '?').join(',');
    const sets = ['state=?', 'updated_at=?'];
    const vals: Array<string | number | null> = [to, new Date().toISOString()];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k}=?`);
      vals.push(typeof v === 'string' || typeof v === 'number' || v === null ? v : JSON.stringify(v));
    }
    vals.push(jobId);
    const r = this.db.prepare(
      `UPDATE surfacing_jobs SET ${sets.join(', ')} WHERE id=? AND state IN (${marks})`,
    ).run(...vals, ...from);
    return Number(r.changes) === 1;
  }

  nextPreparedForTarget(conversationId: string, targetMessageId: string): JobRow | null {
    const row = this.db.prepare(
      `SELECT ${JOB_COLS} FROM surfacing_jobs
       WHERE conversation_id=? AND target_message_id=? AND state IN ('target_bound','validating','ready')
       ORDER BY source_sequence DESC LIMIT 1`,
    ).get(conversationId, targetMessageId) as JobRow | undefined;
    return row ?? null;
  }

  /** 同房间：目标到达后可绑定的 prepared 作业（source 在目标之前的最近一条）。 */
  preparedAwaitingTarget(conversationId: string, targetSequence: number): JobRow[] {
    return this.db.prepare(
      `SELECT ${JOB_COLS} FROM surfacing_jobs
       WHERE conversation_id=? AND state IN ('prepared') AND source_sequence < ?
       ORDER BY source_sequence ASC`,
    ).all(conversationId, targetSequence) as JobRow[];
  }

  /** P1 省略表达延续依据：[minSourceSequence, beforeSequence) 内最近一条
   *  已确定回忆对象（prepared，有可用赢家）的作业；empty/rejected/blocked/
   *  cancelled 或已被后续消息绑走的不算。只读。 */
  preparedBetween(conversationId: string, minSourceSequence: number, beforeSequence: number): JobRow | null {
    const row = this.db.prepare(
      `SELECT ${JOB_COLS} FROM surfacing_jobs
       WHERE conversation_id=? AND state='prepared' AND source_sequence >= ? AND source_sequence < ?
       ORDER BY source_sequence DESC LIMIT 1`,
    ).get(conversationId, minSourceSequence, beforeSequence) as JobRow | undefined;
    return row ?? null;
  }

  pendingJobs(limit = 20): JobRow[] {
    return this.db.prepare(
      `SELECT ${JOB_COLS} FROM surfacing_jobs WHERE state IN ('pending','target_bound','validating') ORDER BY created_at ASC LIMIT ?`,
    ).all(limit) as JobRow[];
  }

  recoverableJobs(): JobRow[] {
    return this.db.prepare(
      `SELECT ${JOB_COLS} FROM surfacing_jobs WHERE state IN ('preparing','validating','reserved','dispatch_started') ORDER BY created_at ASC LIMIT 50`,
    ).all() as JobRow[];
  }

  markMissedTargets(conversationId: string, latestUserSequence: number): void {
    // 目标已过（更新的真实用户输入已出现且不是本作业目标）→ missed_target，
    // 不向后漂移（docs/01 §4）。
    this.db.prepare(
      `UPDATE surfacing_jobs SET state='missed_target', updated_at=?
       WHERE conversation_id=? AND state IN ('prepared','target_bound','validating')
         AND target_message_id IS NULL AND source_sequence < ?`,
    ).run(new Date().toISOString(), conversationId, latestUserSequence - 0);
  }

  // —— 交付（attempt 级冻结；transport retry 复用同一冻结包）——

  freezeDelivery(o: {
    jobId: string; attemptId: string; windowId: string; text: string;
    items: SurfaceItem[]; memoryRefs: Array<{ ref: string; detail_ref: string; event_id: string }>;
  }): string {
    const id = genId('sfd');
    const payloadHash = sha256Hex(o.text);
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO surfacing_deliveries(id, job_id, attempt_id, window_id, state, payload_text,
         payload_hash, selected_refs_json, retained, created_at)
       VALUES (?,?,?,?, 'frozen', ?, ?, ?, 0, ?)`,
    ).run(id, o.jobId, o.attemptId, o.windowId, o.text, payloadHash, JSON.stringify({ items: o.items, refs: o.memoryRefs }), now);
    this.transition(o.jobId, ['ready', 'reserved'], 'reserved');
    return id;
  }

  frozenForAttempt(attemptId: string): { id: string; payload_text: string; payload_hash: string; selected_refs_json: string } | null {
    // 尝试级冻结包跨 frozen/dispatched/retained 复用（transport retry 原
    // 样重用同一冻结包，不重渲染——docs/04 冻结与重试）
    const row = this.db.prepare(
      `SELECT id, payload_text, payload_hash, selected_refs_json FROM surfacing_deliveries WHERE attempt_id=? AND state IN ('frozen','dispatch_started','retained') ORDER BY created_at DESC LIMIT 1`,
    ).get(attemptId) as { id: string; payload_text: string; payload_hash: string; selected_refs_json: string } | undefined;
    return row ?? null;
  }

  markDispatchStarted(jobId: string, deliveryId: string): void {
    this.db.prepare(`UPDATE surfacing_deliveries SET state='dispatch_started', dispatched_at=? WHERE id=?`).run(new Date().toISOString(), deliveryId);
    this.transition(jobId, ['reserved', 'ready'], 'dispatch_started');
  }

  markRetained(jobId: string, deliveryId: string, items: SurfaceItem[]): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE surfacing_deliveries SET state='retained', retained=1, retained_at=? WHERE id=?`).run(now, deliveryId);
    this.transition(jobId, ['dispatch_started'], 'retained');
    for (const it of items) {
      this.db.prepare(
        `INSERT INTO surfacing_coverage(conversation_id, window_id, memory_id, memory_version, body_hash, occurrence_key, detail_ref, confirmed_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(conversation_id, window_id, memory_id, body_hash) DO NOTHING`,
      ).run(
        this.jobById(jobId)?.conversation_id ?? '', this.db.prepare('SELECT window_id FROM surfacing_deliveries WHERE id=?').get(deliveryId)?.window_id ?? '',
        it.memory_id, it.memory_version, it.body_hash, it.event_id, it.detail_ref, now);
    }
  }

  /** 覆盖去重（当前窗口上下文为准，非永久 seen）。 */
  coveredInWindow(conversationId: string, windowId: string, items: SurfaceItem[]): Set<string> {
    const covered = new Set<string>();
    for (const it of items) {
      const row = this.db.prepare(
        `SELECT 1 FROM surfacing_coverage WHERE conversation_id=? AND window_id=? AND memory_id=? AND body_hash=?`,
      ).get(conversationId, windowId, it.memory_id, it.body_hash);
      if (row) covered.add(it.event_id);
    }
    return covered;
  }

  dropCoverageForWindow(windowId: string): void {
    // 换窗：coverage 是投影清单——旧窗覆盖不拦新窗（docs/04 去重节）。
    this.db.prepare(`DELETE FROM surfacing_coverage WHERE window_id=?`).run(windowId);
  }

  refToDetail(memoryRef: string): { detail_ref: string } | null {
    const row = this.db.prepare(
      `SELECT selected_refs_json FROM surfacing_deliveries WHERE retained=1 AND selected_refs_json LIKE ?`,
    ).get(`%"ref":"${memoryRef}"%`) as { selected_refs_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.selected_refs_json) as { refs: Array<{ ref: string; detail_ref: string }> };
      const hit = parsed.refs?.find((r) => r.ref === memoryRef);
      return hit ? { detail_ref: hit.detail_ref } : null;
    } catch {
      return null;
    }
  }
}
