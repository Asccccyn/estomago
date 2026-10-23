// WAKE_KEEPWARM_V1（03/04/07/08）：后台预约管理正本——HTTP 管理面与模型 wake_manage
// 共用同一套鉴权、幂等、CAS 与返回定义（不在 HTTP 直写表、MCP 另写一份业务）。
// 职责仅限持久 SQL：预约/修改/取消/列表 + 幂等账本；模型 transport 在 Supervisor。
// 时间校验（04）：RFC3339 必须带时区；at 与 delay_seconds 恰一个；过去时间返回
// WAKE_TIME_IN_PAST + server_now，不擅自改"现在"；相对时间只在首次受理解析一次，
// 同 operation_id 重放返回最初绝对时间（W-08）。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import type { BackgroundSettingsService } from './background-settings.ts';

const RFC3339_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const NOTE_MAX_CHARS = 8000; // 与 chat_send_text 同上限口径（04：不截断到 200）
const OPERATION_ID_MAX = 128;

function wakeTimestamp(at: unknown): number | null {
  if (typeof at !== 'string' || !RFC3339_TZ.test(at)) return null;
  const year = Number(at.slice(0, 4)), month = Number(at.slice(5, 7)), day = Number(at.slice(8, 10));
  const monthDays = new Date(Date.UTC(2000 + year % 400, month, 0)).getUTCDate();
  const parsed = Date.parse(at);
  return month >= 1 && month <= 12 && day >= 1 && day <= monthDays && Number(at.slice(11, 13)) <= 23 && Number(at.slice(14, 16)) <= 59 && Number(at.slice(17, 19)) <= 59 && Number.isFinite(parsed) ? parsed : null;
}

function relativeTimestamp(now: number, seconds: unknown): number | null {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const due = now + seconds * 1000;
  return Number.isSafeInteger(due) && Math.abs(due) <= 8.64e15 ? due : null;
}

export type TaskServiceError = { ok: false; code: string; httpStatus?: number; serverNowIso?: string; currentRevision?: number; detail?: string };

export type TaskSummary = {
  task_id: string; revision: number; kind: string; origin: string;
  scheduled_at: string | null; next_due_at: string | null; enabled: boolean;
  status: 'scheduled' | 'cancelled' | 'needs_review' | 'completed';
  note_preview: string | null; created_by: string; created_at: string;
};

type TaskRow = {
  id: string; conversation_id: string; actor_id: string; kind: string; enabled: number; revision: number;
  schedule_kind: string; scheduled_at: string | null; next_due_at: string | null; payload_json: string;
  created_by_actor_id: string; created_at: string; origin: string; control_reason: string | null;
};

function toSummary(r: TaskRow): TaskSummary {
  let note: unknown = null;
  try { note = (JSON.parse(r.payload_json) as { note?: unknown }).note ?? null; } catch { note = null; }
  const text = typeof note === 'string' ? note : null;
  const status: TaskSummary['status'] = r.control_reason?.endsWith('_needs_review') ? 'needs_review' : r.control_reason === 'delivered' ? 'completed' : r.enabled === 1 ? 'scheduled' : 'cancelled';
  return {
    task_id: r.id, revision: r.revision, kind: r.kind, origin: r.origin,
    scheduled_at: r.scheduled_at, next_due_at: r.next_due_at, enabled: r.enabled === 1,
    status, note_preview: text !== null ? (text.length > 80 ? `${text.slice(0, 80)}…` : text) : null,
    created_by: r.created_by_actor_id, created_at: r.created_at,
  };
}

export class BackgroundTaskService {
  private db: Db;
  private settings: BackgroundSettingsService;
  private now: () => number;
  constructor(db: Db, settings: BackgroundSettingsService, now: () => number = () => Date.now()) {
    this.db = db;
    this.settings = settings;
    this.now = now;
  }

  private nowIso(): string { return new Date(this.now()).toISOString(); }

  /**
   * 04 幂等：actor+conversation+action+operation_id 唯一；同键同参数返回原回执
   * （duplicate=true），同键不同参数 IDEMPOTENCY_CONFLICT。业务写与回执落账同一事务
   * （07 状态变更原子性）——business 回调内部不得再开事务（connection.tx 不支持嵌套）。
   */
  private replay<T>(scope: { actorId: string; conversationId: string; action: string; operationId: string }, params: Record<string, unknown>): { result: T; duplicate: boolean } | { conflict: true } | null {
    const hash = JSON.stringify({ action: scope.action, params });
    const prior = this.db.prepare('SELECT request_hash, response_json FROM background_operations WHERE actor_id = ? AND conversation_id = ? AND action = ? AND operation_id = ?')
      .get(scope.actorId, scope.conversationId, scope.action, scope.operationId) as { request_hash: string; response_json: string } | undefined;
    if (prior) {
      if (prior.request_hash !== hash) return { conflict: true };
      return { result: JSON.parse(prior.response_json) as T, duplicate: true };
    }
    return null;
  }

  private once<T>(scope: { actorId: string; conversationId: string; action: string; operationId: string }, params: Record<string, unknown>, business: () => T): { result: T; duplicate: boolean } | { conflict: true } {
    return tx(this.db, () => {
      const prior = this.replay<T>(scope, params);
      if (prior) return prior;
      const result = business();
      this.db.prepare('INSERT INTO background_operations(actor_id, conversation_id, action, operation_id, request_hash, response_json, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(scope.actorId, scope.conversationId, scope.action, scope.operationId, JSON.stringify({ action: scope.action, params }), JSON.stringify(result), this.nowIso());
      return { result, duplicate: false };
    });
  }

  private receipt(saved: { result: unknown; duplicate: boolean } | { conflict: true }): { ok: true; task: TaskSummary; duplicate: boolean } | TaskServiceError {
    if ('conflict' in saved) return { ok: false, code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409, detail: '同幂等键对应不同参数' };
    const result = saved.result as { task_id?: string; task?: TaskSummary; code?: string };
    if (result.code) return { ...result, ok: false } as TaskServiceError;
    if (result.task) return { ok: true, task: result.task, duplicate: saved.duplicate };
    // 历史回执没有快照，保留读取兼容；不改写已经保存的旧回执。
    const row = this.db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(result.task_id ?? '') as TaskRow | undefined;
    return row ? { ok: true, task: toSummary(row), duplicate: saved.duplicate } : { ok: false, code: 'INTERNAL_TASK_MISSING', httpStatus: 500 };
  }

  /** 04 schedule：一次性预约（可多个并存；无 60 分钟冷却、无每日配额）。 */
  schedule(opts: {
    actorId: string; conversationId: string; operationId: string; note: string;
    at?: unknown; delaySeconds?: unknown; createdBy: 'jiaming' | 'qiaosheng';
  }): { ok: true; task: TaskSummary; duplicate: boolean } | TaskServiceError {
    if (!opts.operationId || opts.operationId.length > OPERATION_ID_MAX) return { ok: false, code: 'WAKE_REQUEST_INVALID', httpStatus: 400, detail: 'operation_id 必填（≤128 字符）' };
    if (typeof opts.note !== 'string' || opts.note.length === 0 || opts.note.length > NOTE_MAX_CHARS) return { ok: false, code: 'WAKE_NOTE_INVALID', httpStatus: 400, detail: `note 必填（1..${NOTE_MAX_CHARS} 字符，不截断）` };
    const hasAt = opts.at !== undefined && opts.at !== null;
    const hasDelay = opts.delaySeconds !== undefined && opts.delaySeconds !== null;
    if (hasAt === hasDelay) return { ok: false, code: 'WAKE_TIME_INVALID', httpStatus: 400, detail: 'at 与 delay_seconds 必须恰好一个' };
    const params: Record<string, unknown> = { note: opts.note, ...(hasAt ? { at: opts.at as string } : { delay_seconds: opts.delaySeconds as number }) };
    const scope = { actorId: opts.actorId, conversationId: opts.conversationId, action: 'wake_schedule', operationId: opts.operationId };
    const prior = this.replay(scope, params);
    if (prior) return this.receipt(prior);
    const nowMs = this.now();
    let dueMs: number;
    if (hasAt) {
      if (typeof opts.at !== 'string' || !RFC3339_TZ.test(opts.at)) return { ok: false, code: 'WAKE_TIME_INVALID', httpStatus: 400, detail: 'at 必须是带 Z/offset 的 RFC3339 时间，不接受裸本地时间' };
      const t = wakeTimestamp(opts.at);
      if (t === null) return { ok: false, code: 'WAKE_TIME_INVALID', httpStatus: 400, detail: 'at 不是有效日期时间' };
      dueMs = t;
    } else {
      const relative = relativeTimestamp(nowMs, opts.delaySeconds);
      if (relative === null) return { ok: false, code: 'WAKE_TIME_INVALID', httpStatus: 400, detail: 'delay_seconds 必须是有效时间范围内的正整数秒' };
      dueMs = relative;
    }
    if (dueMs <= nowMs) return { ok: false, code: 'WAKE_TIME_IN_PAST', httpStatus: 422, serverNowIso: this.nowIso(), detail: '预约时间必须在未来；已过期时间不擅自改为现在' };
    // 自主开关关闭：schedule/update 拒绝；list/cancel 可用（04）
    if (!this.settings.effective().autonomous.enabled) return { ok: false, code: 'SELF_WAKE_DISABLED', httpStatus: 422, detail: '自主预约唤醒未开启——保温开着不等于自主预约也开着' };
    const idem = this.once(scope, params, () => {
      if (!this.settings.effective().autonomous.enabled) return { code: 'SELF_WAKE_DISABLED', httpStatus: 422 };
      const id = genId('bgt');
      const dueIso = new Date(dueMs).toISOString();
      const nowIso = this.nowIso();
      this.db.prepare(
        `INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at)
         VALUES (?,?,?,'autonomous',1,1,'once',?,?,'Asia/Shanghai',NULL,NULL,?,?,'self_schedule',?,?)`,
      ).run(id, opts.conversationId, opts.actorId, dueIso, dueIso, JSON.stringify({ note: opts.note, source: 'self_schedule' }), opts.createdBy, nowIso, nowIso);
      return { task_id: id, scheduled_at: dueIso, task: toSummary(this.db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(id) as TaskRow) };
    });
    return this.receipt(idem);
  }

  /** 04 list：分页（cursor=`scheduled_at|id` 复合游标）；列表不回全文 note。 */
  list(opts: { actorId: string; conversationId: string; cursor?: unknown; limit?: unknown; selfScheduledOnly?: boolean }): { ok: true; tasks: TaskSummary[]; next_cursor: string | null } | TaskServiceError {
    const limit = typeof opts.limit === 'number' && Number.isSafeInteger(opts.limit) && opts.limit > 0 && opts.limit <= 100 ? opts.limit : 20;
    const params: Array<string | number> = [opts.conversationId, opts.actorId];
    let sql = 'SELECT * FROM background_tasks WHERE conversation_id = ? AND actor_id = ?';
    if (opts.selfScheduledOnly) sql += " AND kind = 'autonomous' AND origin = 'self_schedule'";
    if (typeof opts.cursor === 'string' && opts.cursor.includes('|')) {
      const [cat, cid] = opts.cursor.split('|');
      sql += ' AND (scheduled_at > ? OR (scheduled_at = ? AND id > ?))';
      params.push(cat!, cat!, cid!);
    }
    sql += ' ORDER BY scheduled_at ASC, id ASC LIMIT ?';
    params.push(limit + 1);
    const rows = this.db.prepare(sql).all(...params) as TaskRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { ok: true, tasks: page.map(toSummary), next_cursor: rows.length > limit && last ? `${last.scheduled_at}|${last.id}` : null };
  }

  /** 04 update：expected_revision CAS（changes=1 才算数）；旧 revision 零派发排队 run 失效。 */
  update(opts: {
    actorId: string; conversationId: string; operationId: string; taskId: string; expectedRevision: number;
    note?: unknown; at?: unknown; delaySeconds?: unknown; selfScheduledOnly?: boolean;
  }): { ok: true; task: TaskSummary; duplicate: boolean } | TaskServiceError {
    if (!opts.operationId || opts.operationId.length > OPERATION_ID_MAX) return { ok: false, code: 'WAKE_REQUEST_INVALID', httpStatus: 400 };
    if (!Number.isSafeInteger(opts.expectedRevision) || opts.expectedRevision < 1) return { ok: false, code: 'WAKE_REQUEST_INVALID', httpStatus: 400, detail: 'expected_revision 必须为正整数' };
    const row = this.db.prepare('SELECT * FROM background_tasks WHERE id = ? AND conversation_id = ? AND actor_id = ?').get(opts.taskId, opts.conversationId, opts.actorId) as TaskRow | undefined;
    if (!row) return { ok: false, code: 'TASK_NOT_FOUND', httpStatus: 404, detail: '任务不存在或不属于当前会话（跨 actor/会话隔离）' };
    if (opts.selfScheduledOnly && (row.kind !== 'autonomous' || row.origin !== 'self_schedule')) return { ok: false, code: 'TASK_NOT_FOUND', httpStatus: 404 };
    const hasNote = opts.note !== undefined && opts.note !== null;
    const hasAt = opts.at !== undefined && opts.at !== null;
    const hasDelay = opts.delaySeconds !== undefined && opts.delaySeconds !== null;
    if (hasAt && hasDelay) return { ok: false, code: 'WAKE_TIME_INVALID', httpStatus: 400, detail: 'at 与 delay_seconds 不能同时给' };
    if (!hasNote && !hasAt && !hasDelay) return { ok: false, code: 'WAKE_REQUEST_INVALID', httpStatus: 400, detail: '至少修改一项（note/at/delay_seconds）' };
    if (hasNote && (typeof opts.note !== 'string' || opts.note.length === 0 || opts.note.length > NOTE_MAX_CHARS)) return { ok: false, code: 'WAKE_NOTE_INVALID', httpStatus: 400 };
    const params: Record<string, unknown> = { task_id: opts.taskId, expected_revision: opts.expectedRevision, ...(hasNote ? { note: opts.note as string } : {}), ...(hasAt ? { at: opts.at as string } : {}), ...(hasDelay ? { delay_seconds: opts.delaySeconds as number } : {}) };
    const scope = { actorId: opts.actorId, conversationId: opts.conversationId, action: 'wake_update', operationId: opts.operationId };
    const prior = this.replay(scope, params);
    if (prior) return this.receipt(prior);
    if (row.kind === 'autonomous' && !this.settings.effective().autonomous.enabled) return { ok: false, code: 'SELF_WAKE_DISABLED', httpStatus: 422 };
    const nowMs = this.now();
    let dueIso: string | null = null;
    if (hasAt) {
      if (typeof opts.at !== 'string' || !RFC3339_TZ.test(opts.at)) return { ok: false, code: 'WAKE_TIME_INVALID', httpStatus: 400 };
      const t = wakeTimestamp(opts.at);
      if (t === null) return { ok: false, code: 'WAKE_TIME_INVALID', httpStatus: 400 };
      if (t <= nowMs) return { ok: false, code: 'WAKE_TIME_IN_PAST', httpStatus: 422, serverNowIso: this.nowIso() };
      dueIso = new Date(t).toISOString();
    } else if (hasDelay) {
      const relative = relativeTimestamp(nowMs, opts.delaySeconds);
      if (relative === null) return { ok: false, code: 'WAKE_TIME_INVALID', httpStatus: 400 };
      dueIso = new Date(relative).toISOString();
    }
    const idem = this.once(scope, params, () => {
      if (row.kind === 'autonomous' && !this.settings.effective().autonomous.enabled) return { code: 'SELF_WAKE_DISABLED', httpStatus: 422 };
      const nowIso = this.nowIso();
      let sets = 'revision = revision + 1, updated_at = ?';
      const args: Array<string | number | null> = [nowIso];
      if (hasNote) {
        const payload = { ...(JSON.parse(row.payload_json) as Record<string, unknown>), note: opts.note };
        sets += ', payload_json = ?';
        args.push(JSON.stringify(payload));
      }
      if (dueIso !== null) { sets += ', scheduled_at = ?, next_due_at = ?'; args.push(dueIso, dueIso); }
      if (dueIso !== null && row.control_reason?.endsWith('_needs_review')) sets += ', enabled = 1, control_reason = NULL';
      args.push(opts.taskId, opts.expectedRevision);
      const c = Number(this.db.prepare(`UPDATE background_tasks SET ${sets} WHERE id = ? AND revision = ?`).run(...args).changes);
      if (c !== 1) return { code: 'REVISION_CONFLICT', httpStatus: 409, currentRevision: this.currentRevisionOf(opts.taskId), detail: '任务版本不匹配——刷新后重试' };
      this.supersedeOpenRuns(opts.taskId, 'TASK_SUPERSEDED', nowIso);
      return { task_id: opts.taskId, revision: opts.expectedRevision + 1, task: toSummary(this.db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(opts.taskId) as TaskRow) };
    });
    return this.receipt(idem);
  }

  /** 04 cancel：CAS + revision 递增（不只是 enabled=0）；零派发排队 run 失效。 */
  cancel(opts: { actorId: string; conversationId: string; operationId: string; taskId: string; expectedRevision: number; selfScheduledOnly?: boolean }): { ok: true; task: TaskSummary; duplicate: boolean } | TaskServiceError {
    if (!opts.operationId || opts.operationId.length > OPERATION_ID_MAX) return { ok: false, code: 'WAKE_REQUEST_INVALID', httpStatus: 400 };
    if (!Number.isSafeInteger(opts.expectedRevision) || opts.expectedRevision < 1) return { ok: false, code: 'WAKE_REQUEST_INVALID', httpStatus: 400, detail: 'expected_revision 必须为正整数' };
    const row = this.db.prepare('SELECT * FROM background_tasks WHERE id = ? AND conversation_id = ? AND actor_id = ?').get(opts.taskId, opts.conversationId, opts.actorId) as TaskRow | undefined;
    if (!row) return { ok: false, code: 'TASK_NOT_FOUND', httpStatus: 404, detail: '任务不存在或不属于当前会话' };
    if (opts.selfScheduledOnly && (row.kind !== 'autonomous' || row.origin !== 'self_schedule')) return { ok: false, code: 'TASK_NOT_FOUND', httpStatus: 404 };
    const params: Record<string, unknown> = { task_id: opts.taskId, expected_revision: opts.expectedRevision };
    const idem = this.once({ actorId: opts.actorId, conversationId: opts.conversationId, action: 'wake_cancel', operationId: opts.operationId }, params, () => {
      const nowIso = this.nowIso();
      const c = Number(this.db.prepare("UPDATE background_tasks SET enabled = 0, next_due_at = NULL, revision = revision + 1, control_reason = 'cancelled', updated_at = ? WHERE id = ? AND revision = ?").run(nowIso, opts.taskId, opts.expectedRevision).changes);
      if (c !== 1) return { code: 'REVISION_CONFLICT', httpStatus: 409, currentRevision: this.currentRevisionOf(opts.taskId), detail: '任务版本不匹配——刷新后重试' };
      this.supersedeOpenRuns(opts.taskId, 'TASK_CANCELLED', nowIso);
      return { task_id: opts.taskId, revision: opts.expectedRevision + 1, cancelled: true, task: toSummary(this.db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(opts.taskId) as TaskRow) };
    });
    return this.receipt(idem);
  }

  /** 详情（授权查看面）：返回完整 note。 */
  detail(opts: { actorId: string; conversationId: string; taskId: string }): { ok: true; task: TaskSummary & { note: string | null } } | TaskServiceError {
    const row = this.db.prepare('SELECT * FROM background_tasks WHERE id = ? AND conversation_id = ? AND actor_id = ?').get(opts.taskId, opts.conversationId, opts.actorId) as TaskRow | undefined;
    if (!row) return { ok: false, code: 'TASK_NOT_FOUND', httpStatus: 404 };
    let note: string | null = null;
    try { const n = (JSON.parse(row.payload_json) as { note?: unknown }).note; note = typeof n === 'string' ? n : null; } catch { note = null; }
    return { ok: true, task: { ...toSummary(row), note } };
  }

  private currentRevisionOf(taskId: string): number {
    return (this.db.prepare('SELECT revision FROM background_tasks WHERE id = ?').get(taskId) as { revision: number } | undefined)?.revision ?? 0;
  }

  /** 使该任务零派发的开放 run 失效（取消/修改取代领取）；已有派发的不动（已进入模型不撤回已见事实）。 */
  private supersedeOpenRuns(taskId: string, code: string, nowIso: string): void {
    this.db.prepare(
      "UPDATE background_runs SET state = 'cancelled', result_code = ?, cancel_reason = ?, finished_at = ?, updated_at = ? WHERE task_id = ? AND state IN ('claimed','running') AND first_dispatch_started_at IS NULL AND NOT EXISTS (SELECT 1 FROM background_dispatches d WHERE d.run_id = background_runs.id)",
    ).run(code, code, nowIso, nowIso, taskId);
  }
}
