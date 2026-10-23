// ESTOMAGO_CHAT_EXEC_V1 §04.3.1/§9（WP4）+ WAKE_KEEPWARM_V1（2026-10-22）：
// 宿主内唯一后台调度器——持久任务查询、到期领取、恢复、开关生效、提交到会话串行链。
// 2026-10-22 改造：
//  - 领取≠消耗：claim 不再永久禁用 once 任务（完成/显式取消才终结，04/W-14）；
//  - 自主 occurrence=wake:{task}:{revision}；保温 occurrence 由会话活动版本+维护回执组成
//    （同机会只领一次，K-13 不换 ID 重试）；
//  - chatBusy 用户在场门删除（U04）——排队与让位由会话串行链在执行位内处理；
//  - 60 分钟冷却删除（U02）；
//  - tick 单飞（S-02）：上一 tick 的异步执行未收尾时本 tick 只做本地检查不再重领；
//  - notePendingUserChat 按来源让位（S-05）：心跳在安全边界让位、自主唤醒不被无差别取消；
//  - 保温目标由 wake-activity 投影（真实发布锚点 L / 维护回执）驱动，不再用
//    最近任意缓存请求 +50 分冒充产品计时（B07）。
// 调度器无模型判断、不读身份正文、不发 API；模型执行仍归 Supervisor（同一串行链）。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import type { Config } from '../config/schema.ts';
import type { SystemAlertService } from '../observability/system-alerts.ts';
import { BackgroundSettingsService } from './background-settings.ts';
import { restartDisposition, clockRegressionAction, budgetGate, type RunState, type BackgroundKind } from './background-policy.ts';
import { ConversationActivityService } from './wake-activity.ts';
import { keepwarmSleepState } from './keepwarm-sleep.ts';
import { settleBackgroundRun } from './background-ledger.ts';

export type BackgroundExecutor = {
  /** 执行一次已领取的 run（在会话串行链内被调用——executor 负责取得执行位）。scheduler 负责状态/记账框架。 */
  executeRun(input: { runId: string; taskId: string; kind: 'autonomous' | 'keepwarm' | 'reminder'; conversationId: string; payload: Record<string, unknown>; isCancelRequested: () => boolean; registerAbort: (c: AbortController) => void }): Promise<{ outcome: 'completed' | 'noop' | 'failed' | 'unknown'; result_code?: string }>;
};

export type SchedulerDeps = {
  db: Db;
  config: Config;
  settings: BackgroundSettingsService;
  alerts: SystemAlertService;
  executor: BackgroundExecutor;
  now?: () => number; // 测试注入虚拟时钟
  tickMs?: number; // 轮询间隔（生产默认 15s；测试可 1ms）
};

type TaskRow = {
  id: string; conversation_id: string; actor_id: string; kind: 'autonomous' | 'keepwarm' | 'reminder';
  enabled: number; revision: number; schedule_kind: 'once' | 'daily' | 'interval' | 'cache_idle';
  scheduled_at: string | null; next_due_at: string | null; timezone: string; local_time: string | null;
  interval_ms: number | null; payload_json: string; created_by_actor_id: string;
  origin: string; control_reason: string | null;
};
type RunRow = { id: string; task_id: string; kind: 'autonomous' | 'keepwarm' | 'reminder'; state: RunState; occurrence_key: string; first_dispatch_started_at: string | null; conversation_id: string; actor_id: string };

export class BackgroundScheduler {
  private d: SchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private aborts = new Map<string, AbortController>();
  private cancelRequested = new Set<string>();
  private cancelReasons = new Map<string, string>();
  /** S-06/03：心跳的"安全边界让位"请求——用户消息到来后，正在执行的心跳在下一个
   * 请求/工具边界前停止续轮；已发生的写回执与已发布消息保留，不抹掉。 */
  private yieldRequested = new Set<string>();
  private lastTickMs = 0;
  private ticking = false; // S-02：tick 单飞
  private stopped = true;
  private activity: ConversationActivityService;
  readonly primaryConversation = 'primary';

  constructor(deps: SchedulerDeps) {
    this.d = deps;
    this.activity = new ConversationActivityService(deps.db);
  }

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.recoverOnStart();
    this.timer = setInterval(() => void this.tick(), this.d.tickMs ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // §9.2：停止领取并取消可取消任务（外部已开始动作留 unknown，由恢复期核实）
    for (const [runId, c] of this.aborts) { this.cancelRequested.add(runId); this.cancelReasons.set(runId, 'HOST_STOPPED'); c.abort(); }
  }

  /** AUD-02 P1 修复：按 kind 终止运行中的后台执行（关闭开关时调用）。 */
  disableKind(kind: 'autonomous' | 'keepwarm'): void {
    for (const [runId, c] of this.aborts) {
      const row = this.d.db.prepare('SELECT kind FROM background_runs WHERE id = ?').get(runId) as { kind: string } | undefined;
      if (row?.kind === kind) {
        this.cancelRequested.add(runId);
        this.cancelReasons.set(runId, kind === 'keepwarm' ? 'KEEPWARM_DISABLED' : 'AUTONOMOUS_DISABLED');
        c.abort();
      }
    }
  }

  /**
   * §7.1 聊天优先（2026-10-22 改造，S-05）：用户消息到来不再无差别取消全部后台——
   * 自主唤醒按普通回合规则继续（正在执行的预约不被销毁）；心跳在安全边界让位。
   * 显式 stop / 关闭功能 / 路由 gate 仍有立即 fence/abort 权（stopRun/disableKind）。
   */
  notePendingUserChat(): void {
    for (const [runId, c] of this.aborts) {
      const row = this.d.db.prepare('SELECT kind FROM background_runs WHERE id = ?').get(runId) as { kind: string } | undefined;
      if (row?.kind === 'keepwarm') this.yieldRequested.add(runId);
      void c;
    }
  }

  /** 心跳安全边界让位检查（Supervisor 工具循环在请求/工具边界调用）。 */
  isYieldRequested(runId: string): boolean { return this.yieldRequested.has(runId); }

  /**
   * §9.2 重启恢复（W-14/W-15）：零派发 claimed=可恢复——释放 occurrence key（旧行改写
   * key 留审计），保持原预约时间由下一 tick 重新领取；有派发→unknown（预占保留，不自动重放）。
   */
  recoverOnStart(): void {
    const nowIso = new Date(this.now()).toISOString();
    const rows = this.d.db.prepare("SELECT id, state, kind, occurrence_key FROM background_runs WHERE state IN ('claimed','running','cancelling','unknown')").all() as Array<{ id: string; state: RunState; kind: string; occurrence_key: string }>;
    for (const r of rows) {
      // Usage may have reached disk immediately before a crash. Recover its cost
      // without replaying the model or declaring an unknown external action done.
      settleBackgroundRun(this.d.db, r.id);
      const dispatchCount = (this.d.db.prepare('SELECT COUNT(*) n FROM background_dispatches WHERE run_id = ?').get(r.id) as { n: number }).n;
      const dispo = restartDisposition({ state: r.state, dispatchCount, kind: r.kind as BackgroundKind });
      if (dispo.resultCode === 'UNCHANGED') continue;
      if (dispo.to === 'skipped' && dispatchCount === 0) {
        // W-14：零派发=恢复同 occurrence——释放原 key（行留档），任务保持可领取
        this.d.db.prepare("UPDATE background_runs SET state = 'skipped', result_code = ?, occurrence_key = ?, finished_at = ?, updated_at = ? WHERE id = ?")
          .run(dispo.resultCode, `${r.occurrence_key}:recovered:${r.id}`, nowIso, nowIso, r.id);
      } else {
        this.d.db.prepare('UPDATE background_runs SET state = ?, result_code = ?, finished_at = ?, updated_at = ? WHERE id = ?').run(dispo.to, dispo.resultCode, nowIso, nowIso, r.id);
        // unknown 的 once 任务标待核对（不自动重放，09 表）
        this.d.db.prepare("UPDATE background_tasks SET control_reason = 'unknown_needs_review', updated_at = ? WHERE schedule_kind = 'once' AND id = (SELECT task_id FROM background_runs WHERE id = ?)").run(nowIso, r.id);
      }
    }
  }

  /** 一次调度心跳：时钟回拨检测 → 到期任务领取与执行。测试可直接调用并虚拟推进时钟。 */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) return; // S-02：单飞——上一 tick 的执行器还没收尾时不重领
    this.ticking = true;
    try {
      await this.tickInner();
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<void> {
    const nowMs = this.now();
    // §9.2 时钟向后跳：暂停新后台活动并报告（不缩短目标；恢复由下一 tick 时间正常后自然继续）
    const regression = clockRegressionAction(this.lastTickMs, nowMs);
    if (regression !== null) {
      this.d.alerts.observe({ code: regression, scopeKind: 'system', dedupeKey: 'bg:clock-regression', observationId: `bg:clock-regression:${Math.floor(nowMs / 60_000)}`, safeSummary: { title: '系统时钟回拨——后台模型任务已暂停', count: 1 } });
      return;
    }
    this.lastTickMs = Math.max(this.lastTickMs, nowMs);
    const settings = this.d.settings.effective();
    this.recalculateKeepwarmTargets(settings, nowMs);
    // 按最早到期排序领取（09：非任意表序；同到期稳定排序）
    const tasks = this.d.db.prepare("SELECT * FROM background_tasks WHERE enabled = 1 AND next_due_at IS NOT NULL ORDER BY next_due_at ASC, CASE WHEN kind = 'autonomous' THEN 0 WHEN kind = 'keepwarm' THEN 2 ELSE 1 END, id ASC").all() as TaskRow[];
    for (const task of tasks) {
      if (this.stopped) return;
      const due = task.next_due_at ? Date.parse(task.next_due_at) : null;
      if (due === null || Number.isNaN(due) || due > nowMs) continue;
      // 待核对任务不自动调度（E06/W-16：关闭期间错过/结果未知——等待显式恢复）
      if (task.control_reason !== null) continue;
      if (task.kind === 'autonomous' && !settings.autonomous.enabled) {
        // W-16：明确关闭期间到期的一次性预约→needs_review（不突发补发；未来任务按原时间继续）
        if (task.schedule_kind === 'once') {
          this.d.db.prepare("UPDATE background_tasks SET control_reason = 'disabled_missed_needs_review', updated_at = ? WHERE id = ?").run(new Date(nowMs).toISOString(), task.id);
        }
        continue;
      }
      if (task.kind === 'keepwarm' && !settings.keepwarm.enabled) continue;
      // 前面的执行可能跨入睡眠时段；每次领取用当前时钟再查，不能复用 tick 快照。
      if (task.kind === 'keepwarm' && keepwarmSleepState(this.d.settings.effective().keepwarm.sleep_window, this.now()).blocked) continue;
      if (task.kind === 'reminder' && !settings.reminders.enabled) continue;
      // 同主体同 kind 已有打开的执行（唯一索引兜底；此处先查少一次约束冲突）
      const open = this.d.db.prepare("SELECT id,task_id,state,result_code FROM background_runs WHERE actor_id = ? AND kind = ? AND state IN ('claimed','running','cancelling') LIMIT 1").get(task.actor_id, task.kind) as { id: string; task_id: string; state: string; result_code: string | null } | undefined;
      if (open) {
        if (open.task_id === task.id && open.state === 'claimed' && (open.result_code === 'NO_ACTIVE_WINDOW' || open.result_code === 'CONTEXT_SELECTION_REQUIRED')) await this.executeClaimed(open.id, task);
        continue;
      }
      const runId = this.claim(task, nowMs);
      if (runId === null) continue; // occurrence 唯一约束拦下并发领取（§9.1 CW-21）
      await this.executeClaimed(runId, task);
    }
  }

  /** 领取：插入唯一 occurrence；**不消耗任务**（once 不在此禁用——完成/显式取消才终结）。 */
  private claim(task: TaskRow, nowMs: number): string | null {
    const nowIso = new Date(nowMs).toISOString();
    const runId = genId('bgr');
    let occurrenceKey: string;
    let inputActivityRevision: number | null = null;
    if (task.kind === 'autonomous') {
      occurrenceKey = `wake:${task.id}:${task.revision}`;
    } else if (task.kind === 'keepwarm') {
      const act = this.activity.get(task.conversation_id);
      const win = this.d.db.prepare("SELECT id FROM windows WHERE conversation_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1").get(task.conversation_id) as { id: string } | undefined;
      if (!act || act.last_real_activity_at === null || !win) return null; // 无真实活动/无活动窗：本轮无可领机会
      inputActivityRevision = act.activity_revision;
      occurrenceKey = `keepwarm:${task.conversation_id}:${win.id}:${act.activity_revision}:${act.maintenance_request_id ?? 'none'}`;
    } else {
      occurrenceKey = `${task.id}:${task.revision}:${task.next_due_at ?? nowIso}`;
    }
    try {
      tx(this.d.db, () => {
        this.d.db.prepare(
          `INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, scheduled_for, state, settings_revision, input_activity_revision, claimed_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,'claimed',?,?,?,?,?)`,
        ).run(runId, task.id, task.conversation_id, task.actor_id, task.kind, task.revision, occurrenceKey, task.next_due_at ?? nowIso, this.d.settings.revision(), inputActivityRevision, nowIso, nowIso, nowIso);
        // interval/daily 推进 next_due_at；once 与 cache_idle 不在领取时消耗
        if (task.schedule_kind === 'interval' && task.interval_ms && task.interval_ms > 0) {
          this.d.db.prepare('UPDATE background_tasks SET next_due_at = ?, updated_at = ? WHERE id = ?').run(new Date(nowMs + task.interval_ms).toISOString(), nowIso, task.id);
        } else if (task.schedule_kind === 'daily') {
          const nextLocal = new Date(nowMs + 86_400_000 + 8 * 3_600_000);
          const [hh, mm] = (task.local_time ?? '09:00').split(':').map(Number);
          nextLocal.setUTCHours(hh ?? 9, mm ?? 0, 0, 0);
          this.d.db.prepare('UPDATE background_tasks SET next_due_at = ?, updated_at = ? WHERE id = ?').run(new Date(nextLocal.getTime() - 8 * 3_600_000).toISOString(), nowIso, task.id);
        }
      });
      return runId;
    } catch (error) {
      // Node SQLite identifies UNIQUE constraints by extended error 2067.
      if ((error as { errcode?: number }).errcode === 2067) return null;
      throw new Error('BACKGROUND_CLAIM_FAILED');
    }
  }

  /** §5.2/§5.4（2026-10-22 重写）：保温目标由真实活动投影驱动——L+50 分（真实消息）或
   *  维护回执 dispatch+50 分（技术续温）；任意新真实发布使旧回执失效（wake-activity CAS 语义）。 */
  private recalculateKeepwarmTargets(settings: ReturnType<BackgroundSettingsService['effective']>, nowMs: number): void {
    if (!settings.keepwarm.enabled) return;
    const rows = this.d.db.prepare("SELECT * FROM background_tasks WHERE kind = 'keepwarm' AND schedule_kind = 'cache_idle' AND enabled = 1").all() as TaskRow[];
    const nowIso = new Date(nowMs).toISOString();
    for (const t of rows) {
      if (keepwarmSleepState(settings.keepwarm.sleep_window, nowMs).blocked) {
        this.d.db.prepare('UPDATE background_tasks SET next_due_at = NULL, updated_at = ? WHERE id = ?').run(nowIso, t.id);
        continue;
      }
      const win = this.d.db.prepare("SELECT id FROM windows WHERE conversation_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1").get(t.conversation_id) as { id: string } | undefined;
      if (!win) {
        this.d.db.prepare('UPDATE background_tasks SET next_due_at = NULL, updated_at = ? WHERE id = ?').run(nowIso, t.id);
        continue;
      }
      const target = this.activity.nextKeepwarmTarget({ conversationId: t.conversation_id, windowId: win.id });
      if (!target.scheduled) {
        this.d.db.prepare('UPDATE background_tasks SET next_due_at = NULL, updated_at = ? WHERE id = ?').run(nowIso, t.id);
        continue;
      }
      this.d.db.prepare('UPDATE background_tasks SET next_due_at = ?, updated_at = ? WHERE id = ?').run(new Date(target.dueAtMs).toISOString(), nowIso, t.id);
    }
  }

  private async executeClaimed(runId: string, task: TaskRow): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(runId, controller);
    const isCancelRequested = (): boolean => this.cancelRequested.has(runId);
    const registerAbort = (c: AbortController): void => { this.aborts.set(runId, c); if (this.cancelRequested.has(runId)) c.abort(); };
    const finish = (state: RunState, resultCode: string | null, cancelReason: string | null = null): void => {
      const nowIso = new Date(this.now()).toISOString();
      const dispatched = (this.d.db.prepare('SELECT COUNT(*) n FROM background_dispatches WHERE run_id=?').get(runId) as { n: number }).n;
      const waiting = task.kind === 'autonomous' && dispatched === 0 && ((cancelReason === 'HOST_STOPPED') || (cancelReason === null && (resultCode === 'NO_ACTIVE_WINDOW' || resultCode === 'CONTEXT_SELECTION_REQUIRED')));
      if (waiting) state = 'claimed';
      this.d.db.prepare('UPDATE background_runs SET state = ?, result_code = ?, cancel_reason = ?, finished_at = ?, updated_at = ? WHERE id = ?').run(state, resultCode, cancelReason, waiting ? null : nowIso, nowIso, runId);
      this.aborts.delete(runId);
      this.cancelRequested.delete(runId);
      this.cancelReasons.delete(runId);
      this.yieldRequested.delete(runId);
      if (waiting) return;
      if (state === 'cancelled' && task.kind === 'autonomous') this.d.db.prepare("UPDATE background_tasks SET control_reason=COALESCE(control_reason,'stopped_needs_review'), updated_at=? WHERE id=? AND revision=?").run(nowIso, task.id, task.revision);
      this.finalizeTaskAfterRun(task, state, nowIso);
    };
    try {
      const r = await this.d.executor.executeRun({ runId, taskId: task.id, kind: task.kind, conversationId: task.conversation_id, payload: JSON.parse(task.payload_json) as Record<string, unknown>, isCancelRequested, registerAbort });
      if (this.cancelRequested.has(runId)) finish('cancelled', r.result_code ?? 'CANCELLED', this.cancelReasons.get(runId) ?? 'RUN_STOPPED');
      else finish(r.outcome, r.result_code ?? null);
    } catch (err) {
      if (this.cancelRequested.has(runId)) finish('cancelled', 'CANCELLED', this.cancelReasons.get(runId) ?? 'RUN_STOPPED');
      else finish('failed', 'BACKGROUND_EXECUTOR_FAILED');
    }
  }

  /** 领取≠消耗的收尾：once 任务只在成功（completed/noop）后终结；失败/未知→待核对（不自动重放）。 */
  private finalizeTaskAfterRun(task: TaskRow, state: RunState, nowIso: string): void {
    if (task.kind !== 'autonomous' || task.schedule_kind !== 'once') return;
    if (state === 'completed' || state === 'noop') {
      this.d.db.prepare("UPDATE background_tasks SET enabled = 0, next_due_at = NULL, control_reason = 'delivered', updated_at = ? WHERE id = ? AND revision = ?").run(nowIso, task.id, task.revision);
    } else if (state === 'failed' || state === 'unknown') {
      this.d.db.prepare("UPDATE background_tasks SET control_reason = CASE WHEN ? = 'unknown' THEN 'unknown_needs_review' ELSE 'failed_needs_review' END, next_due_at = NULL, updated_at = ? WHERE id = ? AND revision = ?").run(state, nowIso, task.id, task.revision);
    }
    // cancelled：显式取消已由 service 标记；宿主停止类取消保持任务待下一轮（开关/恢复决定）
  }

  /** 手动停止一次执行（§7.3：不关总开关）。返回实际状态。 */
  stopRun(runId: string): { state: RunState } | null {
    const row = this.d.db.prepare('SELECT id, state FROM background_runs WHERE id = ?').get(runId) as { id: string; state: RunState } | undefined;
    if (!row) return null;
    if (row.state === 'claimed' || row.state === 'running') {
      this.cancelRequested.add(runId);
      this.cancelReasons.set(runId, 'RUN_STOPPED');
      this.aborts.get(runId)?.abort();
      this.d.db.prepare("UPDATE background_runs SET state = 'cancelling', updated_at = ? WHERE id = ?").run(new Date(this.now()).toISOString(), runId);
      return { state: 'cancelling' };
    }
    return { state: row.state };
  }

  /** 派发记账入口（executor 在每次 transport 前调用；§10.1 唯一预算账本）。
   *  WAKE_KEEPWARM_V1 §09（B-02 收尾）：日占用门=当日（上海日）同 kind 全部 run 的
   *  已结算 actual + 未结算预占（含 unknown）+ 本次上界 ≤ 用户 cap——跨 run 聚合，
   *  不只看当前 run；取消未发的不计。 */
  recordDispatchStart(input: { runId: string; logicalActionKey: string; attemptNo: number; dispatchKind: 'model' | 'tool' | 'delivery'; capabilityName: string | null; reservedCostMicroUsd: number }): { allowed: boolean; dispatchId: string; code?: string } {
    const reject = (code: string) => ({ allowed: false, dispatchId: '', code });
    // Gate and reservation share one write transaction, including between hosts.
    return tx(this.d.db, () => {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const run = this.d.db.prepare('SELECT * FROM background_runs WHERE id = ?').get(input.runId) as {
        id: string; state: RunState; kind: BackgroundKind; task_id: string; task_revision: number;
        model_requests_started: number; tool_calls_started: number; first_dispatch_started_at: string | null;
      } | undefined;
      if (!run) return reject('RUN_NOT_FOUND');
      if (this.cancelRequested.has(input.runId) || (run.state !== 'claimed' && run.state !== 'running')) return reject('CANCELLED');
      const task = this.d.db.prepare('SELECT revision,enabled,control_reason FROM background_tasks WHERE id = ?').get(run.task_id) as { revision: number; enabled: number; control_reason: string | null } | undefined;
      if (!task) return reject('TASK_NOT_FOUND');
      if (task.revision !== run.task_revision) return reject('TASK_SUPERSEDED');
      if (!task.enabled || task.control_reason !== null) return reject('TASK_CANCELLED');
      if (!Number.isSafeInteger(input.reservedCostMicroUsd) || input.reservedCostMicroUsd < 0) return reject('BUDGET_ESTIMATE_UNAVAILABLE');
      const settings = this.d.settings.effective();
      if (run.kind === 'autonomous' || run.kind === 'keepwarm') {
        if (!settings[run.kind].enabled) return reject(run.kind === 'keepwarm' ? 'KEEPWARM_DISABLED' : 'AUTONOMOUS_DISABLED');
        if (run.kind === 'keepwarm') {
          const sleep = keepwarmSleepState(settings.keepwarm.sleep_window, nowMs);
          if (sleep.blocked) return reject(sleep.code!);
        }
        const gate = budgetGate({
          kind: run.kind, settings, dispatchKind: input.dispatchKind === 'tool' ? 'tool' : 'model', nowMs,
          nextRequestCostMicroUsd: input.reservedCostMicroUsd,
          run: { model_requests_started: run.model_requests_started, tool_calls_started: run.tool_calls_started,
            output_tokens_observed: 0, startedAtMs: run.first_dispatch_started_at ? Date.parse(run.first_dispatch_started_at) : nowMs,
            reserved_cost_micro_usd: this.dailyOccupiedMicroUsd(run.kind, this.budgetDayNow(nowMs)), known_cost_micro_usd: 0, unknown_cost_count: 0 },
        });
        if (!gate.allowed) return reject(gate.code);
      } else if (!settings.reminders.enabled) return reject('REMINDERS_DISABLED');
      const duplicate = this.d.db.prepare('SELECT id FROM background_dispatches WHERE run_id=? AND logical_action_key=? AND attempt_no=?').get(input.runId, input.logicalActionKey, input.attemptNo);
      if (duplicate) return reject('DISPATCH_ALREADY_STARTED');
      const dispatchId = genId('bgd');
      this.d.db.prepare(
        `INSERT INTO background_dispatches(id, run_id, logical_action_key, attempt_no, dispatch_kind, capability_name, state, budget_day, reserved_cost_micro_usd, dispatch_started_at, created_at)
         VALUES (?,?,?,?,?,?,'reserved',?,?,?,?)`,
      ).run(dispatchId, input.runId, input.logicalActionKey, input.attemptNo, input.dispatchKind, input.capabilityName, this.budgetDayNow(nowMs), input.reservedCostMicroUsd, nowIso, nowIso);
      this.d.db.prepare("UPDATE background_runs SET state='running', first_dispatch_started_at=COALESCE(first_dispatch_started_at, ?), reserved_cost_micro_usd=reserved_cost_micro_usd+?, updated_at=? WHERE id=?").run(nowIso, input.reservedCostMicroUsd, nowIso, input.runId);
      if (input.dispatchKind === 'model') this.d.db.prepare('UPDATE background_runs SET model_requests_started=model_requests_started+1 WHERE id=?').run(input.runId);
      if (input.dispatchKind === 'tool') this.d.db.prepare('UPDATE background_runs SET tool_calls_started=tool_calls_started+1, tool_calls_observed=tool_calls_observed+1 WHERE id=?').run(input.runId);
      return { allowed: true, dispatchId };
    });
  }

  /** §10.1 日占用：settled 按 actual、未结算（reserved/started/unknown）按预占；
   *  cancelled_before_send 不计；跨该 kind 全部 run 聚合（B-02）。 */
  dailyOccupiedMicroUsd(kind: 'autonomous' | 'keepwarm', budgetDay: string): number {
    const row = this.d.db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN bd.state = 'settled' THEN bd.actual_cost_micro_usd ELSE bd.reserved_cost_micro_usd END), 0) AS occ
       FROM background_dispatches bd JOIN background_runs r ON r.id = bd.run_id
       WHERE bd.budget_day = ? AND r.kind = ? AND bd.state != 'cancelled_before_send'`,
    ).get(budgetDay, kind) as { occ: number };
    return row?.occ ?? 0;
  }

  private budgetDayNow(nowMs: number): string {
    return new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10); // 上海日（与 attribution.shanghaiDayOf 同口径）
  }

}
