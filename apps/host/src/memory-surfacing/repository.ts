// surfacing 运行表（迁移 v29）+ 作业状态机 CAS + 覆盖清单。
// 有界运行数据（docs/02）：候选选择/预留/实际交付分开存；coverage 是
// 投影清单可重建，不是永久 seen。表含对话/记忆投影——不进日志/Git。
import { projectSurfacedMemory, surfaceItemKey } from './contracts.ts';
import { tx, type Db } from '../db/connection.ts';
import { genId, sha256Hex } from '../util/id.ts';
import type { SurfaceItem, SurfacingJobState, SurfaceJobEventPayload } from './contracts.ts';

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
  sol_decision: string | null;
  sol_topic: string | null;
  sol_basis: string | null;
  sol_plan_json: string | null;
  sol_usage_json: string | null;
  receipt_id: string | null;
  items_json: string | null;
  reason_code: string | null;
  deadline_ms: number | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  /** R9（2026-11-03）：M 响应返回的真实执行版本（观测/对账，不参与作业键） */
  m_policy_revision: number | null;
  m_prompt_revision: string | null;
};

const JOB_COLS = 'id, conversation_id, source_message_id, source_revision, source_sequence, target_message_id, target_revision, state, generation, m_operation_id, m_snapshot_ref, policy_revision, prompt_revision, sol_decision, sol_topic, sol_basis, sol_plan_json, sol_usage_json, receipt_id, items_json, reason_code, deadline_ms, created_at, updated_at, expires_at, m_policy_revision, m_prompt_revision';

export class SurfacingRepository {
  private db: Db;
  private emit?: (p: SurfaceJobEventPayload) => void;
  constructor(db: Db, emit?: (p: SurfaceJobEventPayload) => void) {
    this.db = db;
    this.emit = emit;
  }

  /**
   * R05：状态提交处发生命周期事件（身份+状态+原因，零正文）。
   * 在状态写入之后同步调用；调用方（service）以微任务批量落 SSE，
   * 避免在调用方事务内嵌套开启 EventService 事务。读取路径不触发。
   */
  private emitState(jobId: string, from: SurfacingJobState, to: SurfacingJobState,
    extra: Partial<Pick<SurfaceJobEventPayload, 'reason_code' | 'window_id' | 'attempt_id' | 'delivery_id'>> = {}): void {
    if (!this.emit) return;
    const row = this.jobById(jobId);
    if (!row) return;
    this.emit({
      job_id: jobId,
      conversation_id: row.conversation_id,
      from, to,
      reason_code: extra.reason_code ?? row.reason_code ?? null,
      source_message_id: row.source_message_id,
      target_message_id: row.target_message_id,
      window_id: extra.window_id ?? null,
      attempt_id: extra.attempt_id ?? null,
      delivery_id: extra.delivery_id ?? null,
      m_operation_id: row.m_operation_id,
    });
  }

  // —— 事务内登记（MessageService 调用；只 SQL，不做网络）——

  /** 逻辑作业唯一键 (room, source_message_id, source_revision, policy, prompt)：
   *  前端重发相同 client_message_id 由 MessageService 幂等挡住，不重复建作业。
   *  SOL_RECALL_REFACTOR：每条正式消息都登记（旧 regex 意图门退役）；语义
   *  判断在提交后由 Sol 三态完成（service.preparePhase），事务内零网络。 */
  registerAcceptedJob(o: {
    conversationId: string; messageId: string; revision: number; sequence: number;
    content: string; contentHash: string; occurredAt: string | null;
    policyRevision: number; promptRevision: string;
    deadlineMs?: number;
  }): string | null {
    const id = genId('sfj');
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO surfacing_jobs(id, conversation_id, source_message_id, source_revision,
         source_sequence, state, generation, policy_revision, prompt_revision,
         source_body_hash, deadline_ms, created_at, updated_at, target_message_id, target_revision, expires_at)
       VALUES (?,?,?,?,?, 'pending', 0,?,?,?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, source_message_id, source_revision, policy_revision, prompt_revision)
       DO NOTHING`,
    ).run(id, o.conversationId, o.messageId, o.revision, o.sequence,
      o.policyRevision, o.promptRevision,
      o.contentHash, o.deadlineMs ?? null, now, now, o.messageId, o.revision,
      o.deadlineMs == null ? null : new Date(Date.parse(now) + o.deadlineMs).toISOString());
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

  /** 消息编辑撤销尚未保留的旧修订作业；已发送交付事实保持原样。 */
  /** P3（U05）+RB01（复审 20261106）：会话级取消全部未终态作业（通话活动开始时调用）。
   *  与 cancelJobsForRevision 同一收尾出口：逐行 emitState 状态事件（SSE 投影），
   *  不绕过 repo 状态事件直接裸 UPDATE。返回取消行数。 */
  cancelJobsForConversation(conversationId: string, reasonCode: string): number {
    const affected = this.db.prepare(
      `SELECT id, state FROM surfacing_jobs WHERE conversation_id=? AND state IN ('pending','preparing','prepared','target_bound','validating','ready','reserved','dispatch_started')`,
    ).all(conversationId) as Array<{ id: string; state: SurfacingJobState }>;
    const r = this.db.prepare(
      `UPDATE surfacing_jobs SET state='cancelled', updated_at=?, reason_code=?
       WHERE conversation_id=? AND state IN ('pending','preparing','prepared','target_bound','validating','ready','reserved','dispatch_started')`,
    ).run(new Date().toISOString(), reasonCode, conversationId);
    for (const row of affected) {
      this.emitState(row.id, row.state, 'cancelled', { reason_code: reasonCode });
    }
    return Number(r.changes);
  }

  cancelJobsForRevision(conversationId: string, messageId: string, supersededRevision: number): number {
    const affected = this.db.prepare(
      `SELECT id, state FROM surfacing_jobs WHERE conversation_id=? AND ((source_message_id=? AND source_revision=?) OR (target_message_id=? AND target_revision=?)) AND state NOT IN
         ('retained','attempted_not_retained','cancelled','superseded','missed_target','expired')`,
    ).all(conversationId, messageId, supersededRevision, messageId, supersededRevision) as Array<{ id: string; state: SurfacingJobState }>;
    // 修订失效原因落行（她 1021 执行稿：修订一致性可取证）；交付行不动
    const r = this.db.prepare(
      `UPDATE surfacing_jobs SET state='cancelled', reason_code='SOURCE_OR_TARGET_REVISED', updated_at=?
       WHERE conversation_id=? AND ((source_message_id=? AND source_revision=?) OR (target_message_id=? AND target_revision=?)) AND state NOT IN
         ('retained','attempted_not_retained','cancelled','superseded','missed_target','expired')`,
    ).run(new Date().toISOString(), conversationId, messageId, supersededRevision, messageId, supersededRevision);
    for (const row of affected) {
      this.emitState(row.id, row.state, 'cancelled', { reason_code: 'SOURCE_OR_TARGET_REVISED' });
    }
    return Number(r.changes);
  }

  /** 准备完成后只允许源消息自己的当前修订准入。 */
  bindTarget(o: { conversationId: string; jobId: string; targetMessageId: string; targetRevision: number }): boolean {
    const r = this.db.prepare(
      `UPDATE surfacing_jobs SET state='target_bound', target_message_id=?, target_revision=?, updated_at=?
       WHERE id=? AND conversation_id=? AND state='prepared' AND source_message_id=? AND source_revision=? AND target_message_id=? AND target_revision=?`,
    ).run(o.targetMessageId, o.targetRevision, new Date().toISOString(), o.jobId, o.conversationId, o.targetMessageId, o.targetRevision, o.targetMessageId, o.targetRevision);
    const ok = Number(r.changes) === 1;
    if (ok) this.emitState(o.jobId, 'prepared', 'target_bound');
    return ok;
  }

  /** 单调状态 CAS；源/目标修订失效由消息事务取消，发送前再次核状态。
   * R05：CAS 成功即发生命周期事件（extra 透传交付/窗口身份）。 */
  transition(jobId: string, from: SurfacingJobState[], to: SurfacingJobState, patch: Partial<Record<string, unknown>> = {},
    extra: Partial<Pick<SurfaceJobEventPayload, 'reason_code' | 'window_id' | 'attempt_id' | 'delivery_id'>> = {}): boolean {
    const marks = from.map(() => '?').join(',');
    const prev = this.jobById(jobId)?.state ?? null;
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
    const ok = Number(r.changes) === 1;
    if (ok && prev !== null) this.emitState(jobId, prev, to, extra);
    return ok;
  }

  nextPreparedForTarget(conversationId: string, targetMessageId: string): JobRow | null {
    const row = this.db.prepare(
      `SELECT ${JOB_COLS} FROM surfacing_jobs
       WHERE conversation_id=? AND target_message_id=? AND state IN ('pending','preparing','prepared','target_bound','validating','ready')
         AND source_message_id=target_message_id AND source_revision=target_revision
       ORDER BY source_sequence DESC LIMIT 1`,
    ).get(conversationId, targetMessageId) as JobRow | undefined;
    return row ?? null;
  }

  pendingJobs(limit = 20): JobRow[] {
    return this.db.prepare(
      `SELECT ${JOB_COLS} FROM surfacing_jobs WHERE state='pending' ORDER BY created_at ASC LIMIT ?`,
    ).all(limit) as JobRow[];
  }

  recoverableJobs(): JobRow[] {
    return this.db.prepare(
      `SELECT ${JOB_COLS} FROM surfacing_jobs WHERE state IN ('pending','preparing','prepared','target_bound','validating','ready','reserved','dispatch_started') ORDER BY created_at ASC`,
    ).all() as JobRow[];
  }

  /** 已完成需要来自现有作业与实际交付，不另存会话消费指针。 */
  completedNeed(conversationId: string, need: { sources: Array<{ message_id: string; revision: number }> }): {
    outcome: 'delivered' | 'no_match'; windowId: string | null; items: SurfaceItem[];
    jobId: string | null; sourceMessageId: string | null; sourceSequence: number | null;
  } | null {
    const row = this.db.prepare(`SELECT j.id AS job_id, j.source_message_id, j.source_sequence,
      json_extract(j.sol_plan_json, '$.need_outcome') AS outcome,
      d.window_id, d.selected_refs_json
      FROM surfacing_jobs j LEFT JOIN surfacing_deliveries d
        ON d.job_id=j.id AND d.retained=1 AND d.state='retained'
      WHERE j.conversation_id=? AND json_extract(j.sol_plan_json, '$.need')=?
        AND json_extract(j.sol_plan_json, '$.need_outcome') IN ('delivered','no_match')
        AND j.state IN ('retained','empty','rejected')
      ORDER BY j.source_sequence DESC, j.created_at DESC LIMIT 1`)
      .get(conversationId, JSON.stringify(need)) as { job_id: string; source_message_id: string | null; source_sequence: number | null; outcome: 'delivered' | 'no_match'; window_id: string | null; selected_refs_json: string | null } | undefined;
    return row ? { outcome: row.outcome, windowId: row.window_id,
      items: row.selected_refs_json ? (JSON.parse(row.selected_refs_json) as { items: SurfaceItem[] }).items : [],
      jobId: row.job_id, sourceMessageId: row.source_message_id, sourceSequence: row.source_sequence } : null;
  }

  recordSolRetrievalOutcome(jobId: string, outcome: 'delivered' | 'no_match'): void {
    this.db.prepare("UPDATE surfacing_jobs SET sol_plan_json=json_set(sol_plan_json, '$.need_outcome', ?) WHERE id=?")
      .run(outcome, jobId);
  }

  /** R9（2026-11-03）：记录 M prepare 响应返回的真实执行版本（观测/对账列） */
  recordMExecutionVersions(jobId: string, policyRevision: number | null, promptRevision: string | null): void {
    this.db.prepare('UPDATE surfacing_jobs SET m_policy_revision=?, m_prompt_revision=? WHERE id=?')
      .run(policyRevision, promptRevision, jobId);
  }

  // —— 设置覆盖（v35；与配置文件合并出同一生效值，预览/请求共用读者）——

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM surfacing_settings WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string | null): void {
    const now = new Date().toISOString();
    if (value === null) this.db.prepare('DELETE FROM surfacing_settings WHERE key=?').run(key);
    else this.db.prepare(
      'INSERT INTO surfacing_settings(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    ).run(key, value, now);
  }

  // —— 交付（attempt 级冻结；transport retry 复用同一冻结包）——

  freezeDelivery(o: {
    jobId: string; attemptId: string; windowId: string; text: string;
    items: SurfaceItem[]; memoryRefs: Array<{ ref: string; detail_ref: string; event_id: string | null }>;
  }): string | null {
    return tx(this.db, () => {
    const id = genId('sfd');
    if (!this.transition(o.jobId, ['ready'], 'reserved', {},
      { attempt_id: o.attemptId, window_id: o.windowId, delivery_id: id })) return null;
    const payloadHash = sha256Hex(o.text);
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO surfacing_deliveries(id, job_id, attempt_id, window_id, state, payload_text,
         payload_hash, selected_refs_json, retained, created_at)
       VALUES (?,?,?,?, 'frozen', ?, ?, ?, 0, ?)`,
    ).run(id, o.jobId, o.attemptId, o.windowId, o.text, payloadHash, JSON.stringify({ items: o.items, refs: o.memoryRefs }), now);
    return id;
    });
  }

  frozenForAttempt(attemptId: string): { id: string; job_id: string; payload_text: string; payload_hash: string; selected_refs_json: string } | null {
    // 尝试级冻结包跨 frozen/dispatched/retained 复用（transport retry 原
    // 样重用同一冻结包，不重渲染——docs/04 冻结与重试）
    const row = this.db.prepare(
      `SELECT id, job_id, payload_text, payload_hash, selected_refs_json FROM surfacing_deliveries WHERE attempt_id=? AND state IN ('frozen','dispatch_started','retained') ORDER BY created_at DESC LIMIT 1`,
    ).get(attemptId) as { id: string; job_id: string; payload_text: string; payload_hash: string; selected_refs_json: string } | undefined;
    return row ?? null;
  }

  markDispatchStarted(jobId: string, deliveryId: string): void {
    const job = this.jobById(jobId);
    if (!job || !['reserved', 'dispatch_started'].includes(job.state)) throw new Error('SURFACE_TARGET_CHANGED');
    const attemptId = (this.db.prepare('SELECT attempt_id FROM surfacing_deliveries WHERE id=?').get(deliveryId) as { attempt_id: string | null } | undefined)?.attempt_id ?? null;
    this.db.prepare(`UPDATE surfacing_deliveries SET state='dispatch_started', dispatched_at=? WHERE id=?`).run(new Date().toISOString(), deliveryId);
    this.transition(jobId, ['reserved', 'ready'], 'dispatch_started', {}, { delivery_id: deliveryId, attempt_id: attemptId });
  }

  /**
   * R02（审计 J01）最终准入丢弃：预留位收回（reason_code=FINAL_ADMISSION_DROPPED
   * 留痕）+ 冻结包标记 dropped（不再被 frozenForAttempt 复用/标记派发）。
   * 作业已不在 reserved（编辑撤销/停止等）时 transition 落空，但冻结包同样收回。
   */
  dropAtFinalAdmission(jobId: string): null {
    this.transition(jobId, ['reserved'], 'cancelled', { reason_code: 'FINAL_ADMISSION_DROPPED' });
    this.db.prepare(`UPDATE surfacing_deliveries SET state='dropped' WHERE job_id=? AND state='frozen'`).run(jobId);
    return null;
  }

  markRetained(jobId: string, deliveryId: string, items: SurfaceItem[]): void {
    const now = new Date().toISOString();
    const job = this.jobById(jobId);
    if (!job || !['dispatch_started', 'retained'].includes(job.state)) return;
    this.db.prepare(`UPDATE surfacing_deliveries SET state='retained', retained=1, retained_at=? WHERE id=?`).run(now, deliveryId);
    this.transition(jobId, ['dispatch_started'], 'retained', {}, { delivery_id: deliveryId });
    for (const it of items) {
      // source/words 证据的覆盖键：无桶证据用来源身份，不伪造 memory_id
      const coverageKey = it.memory_id ?? `src:${it.source_ref ?? it.detail_ref}`;
      this.db.prepare(
        `INSERT INTO surfacing_coverage(conversation_id, window_id, memory_id, memory_version, body_hash, occurrence_key, detail_ref, confirmed_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(conversation_id, window_id, memory_id, body_hash) DO UPDATE SET
           memory_version=excluded.memory_version, occurrence_key=excluded.occurrence_key,
           detail_ref=excluded.detail_ref, confirmed_at=excluded.confirmed_at`,
      ).run(
        this.jobById(jobId)?.conversation_id ?? '', this.db.prepare('SELECT window_id FROM surfacing_deliveries WHERE id=?').get(deliveryId)?.window_id ?? '',
        coverageKey, it.memory_version, it.body_hash, it.event_id, it.detail_ref, now);
    }
  }

  /** 覆盖去重（当前窗口上下文为准，非永久 seen）。返回 surfaceItemKey 集合；
   *  words/source 证据与事件正文分开记，不互相冒充。R33/R34 围栏保持：coverage
   *  行 + 保留交付必须在当前窗口的规范轨迹中真实可见才算覆盖；SDK/API
   *  共用同一轨迹和实际请求记录，不从 prepared 推断已送达。 */
  coveredInWindow(conversationId: string, windowId: string, items: SurfaceItem[]): Set<string> {
    const covered = new Set<string>();
    const trajectory = this.db.prepare('SELECT messages_json FROM window_trajectories WHERE window_id=?').get(windowId) as { messages_json: string } | undefined;
    if (!trajectory) return covered;
    const messages = JSON.parse(trajectory.messages_json) as Array<{ content: unknown }>;
    const texts = messages.flatMap(m => typeof m.content === 'string' ? [m.content]
      : Array.isArray(m.content) ? m.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string) : []);
    const deliveries = this.db.prepare(`SELECT d.payload_text, d.selected_refs_json FROM surfacing_deliveries d
      JOIN surfacing_jobs j ON j.id=d.job_id WHERE j.conversation_id=? AND d.window_id=? AND d.retained=1`)
      .all(conversationId, windowId) as Array<{ payload_text: string; selected_refs_json: string }>;
    const visible = deliveries.filter(d => texts.some(t => t.includes(d.payload_text)))
      .flatMap(d => (JSON.parse(d.selected_refs_json) as { items: SurfaceItem[] }).items);
    for (const it of items) {
      // F5b：与 markRetained 写入同一覆盖键（source 项写入键=src:来源身份，
      // 查询参数此前传裸 memory_id=null 永不匹配 → source-only 重复注入）
      const coverageKey = it.memory_id ?? `src:${it.source_ref ?? it.detail_ref}`;
      const row = this.db.prepare(
        `SELECT 1 FROM surfacing_coverage WHERE conversation_id=? AND window_id=? AND memory_id IS ? AND memory_version IS ? AND body_hash=?`,
      ).get(conversationId, windowId, coverageKey, it.memory_version, it.body_hash);
      if (row && visible.some(v => (v.memory_id ?? `src:${v.source_ref ?? v.detail_ref}`) === coverageKey && v.body_hash === it.body_hash)) covered.add(surfaceItemKey(it));
    }
    return covered;
  }

  /** Owner UI projection. Handles stay outside model text and resolve only
   * through this turn's confirmed, actually sent provider request. */
  visibleForTurn(conversationId: string, turnId: string): Array<{
    memory_ref: string; date: string | null; text: string; windowId: string; requestId: string;
  }> {
    const rows = this.db.prepare(`SELECT d.selected_refs_json, d.window_id, p.id AS request_id
      FROM surfacing_deliveries d JOIN attempts a ON a.id=d.attempt_id
      JOIN turns t ON t.id=a.turn_id JOIN provider_requests p ON p.attempt_id=a.id
      WHERE t.id=? AND t.conversation_id=? AND p.sent_at IS NOT NULL
        AND p.window_id=d.window_id AND d.state IN ('dispatch_started','retained')
      ORDER BY p.created_at DESC`).all(turnId, conversationId) as Array<{
        selected_refs_json: string; window_id: string; request_id: string;
      }>;
    const out: ReturnType<SurfacingRepository['visibleForTurn']> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      let data: { items: import('./contracts.ts').SurfaceItem[]; refs: Array<{ ref: string; event_id: string | null; detail_ref?: string }> };
      try { data = JSON.parse(row.selected_refs_json); } catch { continue; }
      for (const ref of data.refs ?? []) {
        if (seen.has(ref.ref) || !this.refToDetail(ref.ref, { roomId: conversationId, windowId: row.window_id, requestId: row.request_id })) continue;
        const item = data.items.find(i => (ref.detail_ref ? i.detail_ref === ref.detail_ref : i.event_id === ref.event_id));
        if (!item) continue;
        seen.add(ref.ref);
        out.push({ memory_ref: ref.ref, ...projectSurfacedMemory(item), windowId: row.window_id, requestId: row.request_id });
      }
    }
    return out;
  }

  refToDetail(memoryRef: string, scope: { roomId: string; windowId: string; requestId: string }): { detail_ref: string; origin?: 'recall' } | null {
    // Only the exact confirmed provider request establishes visibility, including
    // the first tool loop before the successful trajectory is retained.
    const request = this.db.prepare(`SELECT p.payload_wire_json, p.payload_json FROM provider_requests p
      JOIN turns t ON t.id=p.turn_id
      WHERE p.id=? AND p.window_id=? AND t.conversation_id=?
        AND p.sent_at IS NOT NULL ORDER BY p.created_at DESC LIMIT 1`)
      .get(scope.requestId, scope.windowId, scope.roomId) as { payload_wire_json: string | null; payload_json: string } | undefined;
    if (!request) return null;
    let messages: Array<{ role?: string; content?: unknown; tool_calls?: any[]; tool_call_id?: string }>;
    try { messages = JSON.parse(request.payload_wire_json ?? request.payload_json).messages; }
    catch { return null; }
    if (!Array.isArray(messages)) return null;
    const recallCalls = new Set<string>();
    for (const message of messages) {
      if (message.role === 'assistant') for (const call of message.tool_calls ?? []) {
        let name = call.function?.name;
        if (name === 'tool_invoke') {
          try { name = JSON.parse(call.function.arguments).name; } catch { continue; }
        }
        if (name === 'memory_recall' || name === 'memory_recall_next') recallCalls.add(call.id);
      }
      if (message.role !== 'tool' || !recallCalls.has(message.tool_call_id ?? '')) continue;
      const text = typeof message.content === 'string' ? message.content
        : Array.isArray(message.content) ? message.content.filter(b => b?.type === 'text').map(b => b.text).join('') : '';
      try {
        const result = JSON.parse(text);
        if (typeof result.recall_session_id === 'string' && Array.isArray(result.candidates)
          && result.candidates.some((candidate: any) => candidate.memory_ref === memoryRef)) {
          return { detail_ref: memoryRef, origin: 'recall' };
        }
      } catch { /* A malformed result cannot establish a delivered reference. */ }
    }
    const texts = messages.flatMap(m => typeof m.content === 'string' ? [m.content]
      : Array.isArray(m.content) ? m.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string) : []);
    const rows = this.db.prepare(`SELECT d.selected_refs_json, d.payload_text FROM surfacing_deliveries d
      JOIN surfacing_jobs j ON j.id=d.job_id
      WHERE j.conversation_id=? AND d.window_id=? AND d.state IN ('dispatch_started','retained')`)
      .all(scope.roomId, scope.windowId) as Array<{ selected_refs_json: string; payload_text: string }>;
    for (const row of rows) {
      if (!texts.some(t => t.includes(row.payload_text))) continue;
      const parsed = JSON.parse(row.selected_refs_json) as { refs: Array<{ ref: string; detail_ref: string }> };
      const hit = parsed.refs.find(r => r.ref === memoryRef);
      if (hit) return { detail_ref: hit.detail_ref };
    }
    return null;
  }
}
