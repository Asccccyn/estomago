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
import { restartDisposition, clockRegressionAction, type RunState } from './background-policy.ts';
import { lastCacheEvidence } from './cache-observation.ts';
import { ConversationActivityService } from './wake-activity.ts';

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
    for (const [runId, c] of this.aborts) { this.cancelRequested.add(runId); c.abort(); }
  }

  /** AUD-02 P1 修复：按 kind 终止运行中的后台执行（关闭开关时调用）。 */
  disableKind(kind: 'autonomous' | 'keepwarm'): void {
    for (const [runId, c] of this.aborts) {
      const row = this.d.db.prepare('SELECT kind FROM background_runs WHERE id = ?').get(runId) as { kind: string } | undefined;
      if (row?.kind === kind) {
        this.cancelRequested.add(runId);
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
    const rows = this.d.db.prepare("SELECT id, state, kind, occurrence_key FROM background_runs WHERE state IN ('claimed','running','cancelling')").all() as Array<{ id: string; state: RunState; kind: string; occurrence_key: string }>;
    for (const r of rows) {
      const dispatchCount = (this.d.db.prepare('SELECT COUNT(*) n FROM background_dispatches WHERE run_id = ?').get(r.id) as { n: number }).n;
      const dispo = restartDisposition({ state: r.state, dispatchCount });
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
    this.lastTickMs = nowMs;
    if (regression !== null) {
      this.d.alerts.observe({ code: regression, scopeKind: 'system', dedupeKey: 'bg:clock-regression', observationId: `bg:clock-regression:${Math.floor(nowMs / 60_000)}`, safeSummary: { title: '系统时钟回拨——后台模型任务已暂停', count: 1 } });
      return;
    }
    const settings = this.d.settings.effective();
    this.recalculateKeepwarmTargets(settings, nowMs);
    // 按最早到期排序领取（09：非任意表序；同到期稳定排序）
    const tasks = this.d.db.prepare('SELECT * FROM background_tasks WHERE enabled = 1 AND next_due_at IS NOT NULL ORDER BY next_due_at ASC, id ASC').all() as TaskRow[];
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
      if (task.kind === 'reminder' && !settings.reminders.enabled) continue;
      // 同主体同 kind 已有打开的执行（唯一索引兜底；此处先查少一次约束冲突）
      const open = this.d.db.prepare("SELECT COUNT(*) n FROM background_runs WHERE actor_id = ? AND kind = ? AND state IN ('claimed','running','cancelling')").get(task.actor_id, task.kind) as { n: number };
      if (open.n > 0) continue;
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
    } catch {
      return null; // 唯一约束=另一回调已领取（去重诊断不报警，§2.1 BACKGROUND_DUPLICATE 语义）
    }
  }

  /** §5.2/§5.4（2026-10-22 重写）：保温目标由真实活动投影驱动——L+50 分（真实消息）或
   *  维护回执 dispatch+50 分（技术续温）；任意新真实发布使旧回执失效（wake-activity CAS 语义）。 */
  private recalculateKeepwarmTargets(settings: ReturnType<BackgroundSettingsService['effective']>, nowMs: number): void {
    if (!settings.keepwarm.enabled) return;
    const rows = this.d.db.prepare("SELECT * FROM background_tasks WHERE kind = 'keepwarm' AND schedule_kind = 'cache_idle' AND enabled = 1").all() as TaskRow[];
    const nowIso = new Date(nowMs).toISOString();
    for (const t of rows) {
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
    const registerAbort = (c: AbortController): void => { this.aborts.set(runId, c); };
    const finish = (state: RunState, resultCode: string | null, cancelReason: string | null = null): void => {
      const nowIso = new Date(this.now()).toISOString();
      this.d.db.prepare('UPDATE background_runs SET state = ?, result_code = ?, cancel_reason = ?, finished_at = ?, updated_at = ? WHERE id = ?').run(state, resultCode, cancelReason, nowIso, nowIso, runId);
      this.aborts.delete(runId);
      this.cancelRequested.delete(runId);
      this.yieldRequested.delete(runId);
      this.finalizeTaskAfterRun(task, state, nowIso);
    };
    try {
      this.d.db.prepare("UPDATE background_runs SET state = 'running', updated_at = ? WHERE id = ?").run(new Date(this.now()).toISOString(), runId);
      const r = await this.d.executor.executeRun({ runId, taskId: task.id, kind: task.kind, conversationId: task.conversation_id, payload: JSON.parse(task.payload_json) as Record<string, unknown>, isCancelRequested, registerAbort });
      if (this.cancelRequested.has(runId)) finish('cancelled', r.result_code ?? 'CANCELLED', 'USER_OR_HOST_STOPPED');
      else finish(r.outcome, r.result_code ?? null);
    } catch (err) {
      finish('failed', String((err as Error).message ?? 'EXECUTOR_ERROR').slice(0, 120));
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
  recordDispatchStart(input: { runId: string; logicalActionKey: string; attemptNo: number; dispatchKind: 'model' | 'tool' | 'delivery'; capabilityName: string | null; reservedCostMicroUsd: number }): { allowed: boolean; dispatchId: string } {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const dispatchId = genId('bgd');
    const run = this.d.db.prepare('SELECT id, state, kind, model_requests_started, tool_calls_started, first_dispatch_started_at FROM background_runs WHERE id = ?').get(input.runId) as { id: string; state: string; kind: string; model_requests_started: number; tool_calls_started: number; first_dispatch_started_at: string | null } | undefined;
    if (!run) return { allowed: false, dispatchId: '' };
    // 取消后不再发（§7.2.3：关闭返回后不得开始新 transport）；终态 run 同样拒新派发
    if (this.cancelRequested.has(input.runId)) return { allowed: false, dispatchId: '' };
    if (run.state !== 'claimed' && run.state !== 'running' && run.state !== 'cancelling') return { allowed: false, dispatchId: '' };
    // B-02：跨 run 日占用聚合门（09 §资金准入顺序公式；无报价=0 上界已在 executor 价格门拦）
    if (run.kind === 'autonomous' || run.kind === 'keepwarm') {
      const s = this.d.settings.effective();
      const capUsd = run.kind === 'autonomous' ? s.autonomous.daily_cost_cap_usd : s.keepwarm.daily_cost_cap_usd;
      if (capUsd !== null) {
        const capMicro = Math.round(capUsd * 1_000_000);
        const occupied = this.dailyOccupiedMicroUsd(run.kind as 'autonomous' | 'keepwarm', this.budgetDayNow(nowMs));
        if (occupied + input.reservedCostMicroUsd > capMicro) return { allowed: false, dispatchId: '' };
      }
    }
    tx(this.d.db, () => {
      this.d.db.prepare(
        `INSERT INTO background_dispatches(id, run_id, logical_action_key, attempt_no, dispatch_kind, capability_name, state, budget_day, reserved_cost_micro_usd, dispatch_started_at, created_at)
         VALUES (?,?,?,?,?,?,'reserved',?,?,?,?)`,
      ).run(dispatchId, input.runId, input.logicalActionKey, input.attemptNo, input.dispatchKind, input.capabilityName, this.budgetDayNow(nowMs), input.reservedCostMicroUsd, nowIso, nowIso);
      if (input.dispatchKind === 'model') this.d.db.prepare('UPDATE background_runs SET model_requests_started = model_requests_started + 1, first_dispatch_started_at = COALESCE(first_dispatch_started_at, ?), reserved_cost_micro_usd = reserved_cost_micro_usd + ?, updated_at = ? WHERE id = ?').run(nowIso, input.reservedCostMicroUsd, nowIso, input.runId);
      if (input.dispatchKind === 'tool') this.d.db.prepare('UPDATE background_runs SET tool_calls_started = tool_calls_started + 1, tool_calls_observed = tool_calls_observed + 1, reserved_cost_micro_usd = reserved_cost_micro_usd + ?, updated_at = ? WHERE id = ?').run(input.reservedCostMicroUsd, nowIso, input.runId);
    });
    return { allowed: true, dispatchId };
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

  /** 派发结算（§10.1 返回后逐笔；未知保留预占）。幂等：已结算/已取消的 dispatch 不重复入账。 */
  settleDispatch(dispatchId: string, opts: { actualCostMicroUsd: number | null; outcomeCode: string }): void {
    const prior = this.d.db.prepare('SELECT state FROM background_dispatches WHERE id = ?').get(dispatchId) as { state: string } | undefined;
    if (!prior || (prior.state !== 'reserved' && prior.state !== 'started')) return;
    const nowIso = new Date(this.now()).toISOString();
    this.d.db.prepare("UPDATE background_dispatches SET state = ?, actual_cost_micro_usd = ?, settled_at = ?, outcome_code = ? WHERE id = ?").run(opts.actualCostMicroUsd === null ? 'unknown' : 'settled', opts.actualCostMicroUsd, nowIso, opts.outcomeCode, dispatchId);
    if (opts.actualCostMicroUsd !== null) {
      const runId = (this.d.db.prepare('SELECT run_id FROM background_dispatches WHERE id = ?').get(dispatchId) as { run_id: string }).run_id;
      // B-03：结算幂等——已结算预占释放为 actual，不双计（同 usage 重复到达只计一次）
      this.d.db.prepare('UPDATE background_runs SET known_cost_micro_usd = known_cost_micro_usd + ?, reserved_cost_micro_usd = MAX(0, reserved_cost_micro_usd - (SELECT reserved_cost_micro_usd FROM background_dispatches WHERE id = ?)), updated_at = ? WHERE id = ?').run(opts.actualCostMicroUsd, dispatchId, nowIso, runId);
    }
  }

  /** 首个自主派发时间（保留外部观测查询；冷却已退役）。 */
  lastAutonomousDispatchAt(actorId: string): string | null {
    return (this.d.db.prepare("SELECT first_dispatch_started_at FROM background_runs WHERE kind = 'autonomous' AND actor_id = ? AND first_dispatch_started_at IS NOT NULL ORDER BY first_dispatch_started_at DESC LIMIT 1").get(actorId) as { first_dispatch_started_at: string } | undefined)?.first_dispatch_started_at ?? null;
  }

  /** 保温维护证据查询（Supervisor 在执行位内重算/记回执用）。 */
  keepwarmEvidenceFor(windowId: string) { return lastCacheEvidence(this.d.db, windowId); }
  activityService(): ConversationActivityService { return this.activity; }
}
