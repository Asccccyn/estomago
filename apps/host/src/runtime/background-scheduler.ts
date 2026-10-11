// ESTOMAGO_CHAT_EXEC_V1 §04.3.1/§9（WP4）：宿主内唯一后台调度器——持久任务查询、到期领取、
// 恢复、开关生效、调用执行器；不直接实现模型 transport（executor 由 supervisor 适配注入）。
// 单定时唤醒源计算最近到期任务（§9.2）；时钟可注入（测试虚拟推进）；一任务一常驻进程=禁止。
// 首版交付状态：autonomous/keepwarm 默认关闭（enabled=false）——reminder（无模型投递）可用。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import type { Config } from '../config/schema.ts';
import { POLICY_CONSTANTS } from '../config/policy-constants.ts';
import type { SystemAlertService } from '../observability/system-alerts.ts';
import { BackgroundSettingsService } from './background-settings.ts';
import { keepwarmAdmission, keepwarmTargetMs, autonomousCooldownDueAtMs, restartDisposition, clockRegressionAction, type RunState } from './background-policy.ts';
import { lastCacheEvidence } from './cache-observation.ts';

export type BackgroundExecutor = {
  /** 执行一次已领取的 run。scheduler 负责状态/记账框架；执行器负责模型/投递与细粒度取消。 */
  executeRun(input: { runId: string; taskId: string; kind: 'autonomous' | 'keepwarm' | 'reminder'; conversationId: string; payload: Record<string, unknown>; isCancelRequested: () => boolean; registerAbort: (c: AbortController) => void }): Promise<{ outcome: 'completed' | 'noop' | 'failed' | 'unknown'; result_code?: string }>;
};

export type SchedulerDeps = {
  db: Db;
  config: Config;
  settings: BackgroundSettingsService;
  alerts: SystemAlertService;
  executor: BackgroundExecutor;
  /** 是否有用户聊天活动/待处理输入（聊天优先 §7.1）——宿主注入 */
  chatBusy: () => boolean;
  now?: () => number; // 测试注入虚拟时钟
  tickMs?: number; // 轮询间隔（生产默认 15s；测试可 1ms）
};

type TaskRow = {
  id: string; conversation_id: string; actor_id: string; kind: 'autonomous' | 'keepwarm' | 'reminder';
  enabled: number; revision: number; schedule_kind: 'once' | 'daily' | 'interval' | 'cache_idle';
  scheduled_at: string | null; next_due_at: string | null; timezone: string; local_time: string | null;
  interval_ms: number | null; payload_json: string; created_by_actor_id: string;
};
type RunRow = { id: string; task_id: string; kind: 'autonomous' | 'keepwarm' | 'reminder'; state: RunState; occurrence_key: string; first_dispatch_started_at: string | null; conversation_id: string; actor_id: string };

export class BackgroundScheduler {
  private d: SchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private aborts = new Map<string, AbortController>();
  private cancelRequested = new Set<string>();
  private lastTickMs = 0;
  private stopped = true;
  readonly primaryConversation = 'primary';

  constructor(deps: SchedulerDeps) {
    this.d = deps;
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

  /** §7.1 聊天抢占：用户消息入库后立即取消当前背景活动的可取消步骤。 */
  notePendingUserChat(): void {
    for (const [runId, c] of this.aborts) {
      this.cancelRequested.add(runId);
      c.abort();
    }
  }

  /** §9.2 重启恢复：孤儿 claimed→skipped；进行中（有派发）→unknown（预占保留）。 */
  recoverOnStart(): void {
    const nowIso = new Date(this.now()).toISOString();
    const rows = this.d.db.prepare("SELECT id, state, kind FROM background_runs WHERE state IN ('claimed','running','cancelling')").all() as Array<{ id: string; state: RunState; kind: string }>;
    for (const r of rows) {
      const dispatchCount = (this.d.db.prepare('SELECT COUNT(*) n FROM background_dispatches WHERE run_id = ?').get(r.id) as { n: number }).n;
      const dispo = restartDisposition({ state: r.state, dispatchCount });
      if (dispo.resultCode === 'UNCHANGED') continue;
      this.d.db.prepare('UPDATE background_runs SET state = ?, result_code = ?, finished_at = CASE WHEN ? IN (\'skipped\',\'unknown\') THEN ? ELSE finished_at END, updated_at = ? WHERE id = ?').run(dispo.to, dispo.resultCode, dispo.to, nowIso, nowIso, r.id);
    }
  }

  /** 一次调度心跳：时钟回拨检测 → 到期任务领取与执行。测试可直接调用并虚拟推进时钟。 */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const nowMs = this.now();
    // §9.2 时钟向后跳：暂停新后台活动并报告（不缩短冷却；恢复由下一 tick 时间正常后自然继续）
    const regression = clockRegressionAction(this.lastTickMs, nowMs);
    this.lastTickMs = nowMs;
    if (regression !== null) {
      this.d.alerts.observe({ code: regression, scopeKind: 'system', dedupeKey: 'bg:clock-regression', observationId: `bg:clock-regression:${Math.floor(nowMs / 60_000)}`, safeSummary: { title: '系统时钟回拨——后台模型任务已暂停', count: 1 } });
      return;
    }
    const settings = this.d.settings.effective();
    const tasks = this.d.db.prepare('SELECT * FROM background_tasks WHERE enabled = 1').all() as TaskRow[];
    for (const task of tasks) {
      if (this.stopped) return;
      await this.maybeRun(task, settings, nowMs);
      // 计算下次到期（once 执行后任务失效由 run 完成时处理；interval/daily 推进 next_due_at）
    }
    this.recalculateKeepwarmTargets(settings);
  }

  private async maybeRun(task: TaskRow, settings: ReturnType<BackgroundSettingsService['effective']>, nowMs: number): Promise<void> {
    // keepwarm 的 cache_idle 型：目标由缓存证据派生（本 tick 里 recalculate 先行写入 next_due_at）
    const due = task.next_due_at ? Date.parse(task.next_due_at) : null;
    if (due === null || Number.isNaN(due) || due > nowMs) return;
    if (task.kind === 'autonomous' && !settings.autonomous.enabled) return;
    if (task.kind === 'keepwarm' && !settings.keepwarm.enabled) return;
    if (task.kind === 'reminder' && !settings.reminders.enabled) return;
    // 同主体同 kind 已有打开的执行（唯一索引兜底；此处先查少一次约束冲突）
    const open = this.d.db.prepare("SELECT COUNT(*) n FROM background_runs WHERE actor_id = ? AND kind = ? AND state IN ('claimed','running','cancelling')").get(task.actor_id, task.kind) as { n: number };
    if (open.n > 0) return;
    // 聊天优先（§7.1）：后台闭包取得执行位时重查
    if (task.kind !== 'reminder' && this.d.chatBusy()) return;
    // 60min 冷却（§6.1：跨任务统一，按主体）
    if (task.kind === 'autonomous') {
      const last = (this.d.db.prepare("SELECT first_dispatch_started_at FROM background_runs WHERE kind = 'autonomous' AND actor_id = ? AND first_dispatch_started_at IS NOT NULL ORDER BY first_dispatch_started_at DESC LIMIT 1").get(task.actor_id) as { first_dispatch_started_at: string } | undefined)?.first_dispatch_started_at ?? null;
      const cooldownDue = autonomousCooldownDueAtMs(last, nowMs);
      if (cooldownDue !== null) {
        this.advanceTask(task, nowMs, new Date(cooldownDue).toISOString());
        return;
      }
      // 预算未配置=付费自主不可开始（§4.2 422 语义在设置面；调度面同样不开始）
      if (settings.autonomous.daily_cost_cap_usd === null) return;
    }
    const runId = this.claim(task, nowMs);
    if (runId === null) return; // occurrence 唯一约束拦下并发领取（§9.1 CW-21）
    await this.executeClaimed(runId, task);
  }

  private claim(task: TaskRow, nowMs: number): string | null {
    const nowIso = new Date(nowMs).toISOString();
    const runId = genId('bgr');
    const occurrenceKey = `${task.id}:${task.revision}:${task.next_due_at ?? nowIso}`;
    try {
      tx(this.d.db, () => {
        this.d.db.prepare(
          `INSERT INTO background_runs(id, task_id, conversation_id, actor_id, kind, task_revision, occurrence_key, scheduled_for, state, settings_revision, claimed_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,'claimed',?,?,?,?)`,
        ).run(runId, task.id, task.conversation_id, task.actor_id, task.kind, task.revision, occurrenceKey, task.next_due_at ?? nowIso, this.d.settings.revision(), nowIso, nowIso, nowIso);
        this.advanceTask(task, nowMs, null);
      });
      return runId;
    } catch {
      return null; // 唯一约束=另一回调已领取（去重诊断不报警，§2.1 BACKGROUND_DUPLICATE 语义）
    }
  }

  /** 推进任务下次到期：once=禁用；interval=+interval_ms；daily=次日 local_time；cache_idle=由证据重算。 */
  private advanceTask(task: TaskRow, nowMs: number, overrideDueIso: string | null): void {
    const nowIso = new Date(nowMs).toISOString();
    if (task.schedule_kind === 'once') {
      this.d.db.prepare('UPDATE background_tasks SET enabled = 0, next_due_at = NULL, updated_at = ? WHERE id = ?').run(nowIso, task.id);
    } else if (overrideDueIso !== null) {
      this.d.db.prepare('UPDATE background_tasks SET next_due_at = ?, updated_at = ? WHERE id = ?').run(overrideDueIso, nowIso, task.id);
    } else if (task.schedule_kind === 'interval' && task.interval_ms && task.interval_ms > 0) {
      this.d.db.prepare('UPDATE background_tasks SET next_due_at = ?, updated_at = ? WHERE id = ?').run(new Date(nowMs + task.interval_ms).toISOString(), nowIso, task.id);
    } else {
      // daily：次日 local_time（Asia/Shanghai）；cache_idle：等待证据重算（目标清除，等 recalc）
      this.d.db.prepare('UPDATE background_tasks SET next_due_at = NULL, updated_at = ? WHERE id = ?').run(nowIso, task.id);
    }
  }

  /** §5.2/§5.4：保温目标从最新缓存证据重算——普通聊天/自主的新观测移动目标，旧机会作废。 */
  private recalculateKeepwarmTargets(settings: ReturnType<BackgroundSettingsService['effective']>): void {
    if (!settings.keepwarm.enabled) return;
    const rows = this.d.db.prepare("SELECT * FROM background_tasks WHERE kind = 'keepwarm' AND schedule_kind = 'cache_idle' AND enabled = 1").all() as TaskRow[];
    for (const t of rows) {
      const win = this.d.db.prepare("SELECT id FROM windows WHERE conversation_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1").get(t.conversation_id) as { id: string } | undefined;
      const evidence = win ? lastCacheEvidence(this.d.db, win.id) : null;
      const admit = evidence
        ? keepwarmAdmission({ settings, evidenceStartedAtMs: Date.parse(evidence.startedAt), nowMs: this.now(), chatActive: this.d.chatBusy(), pendingUserInput: this.d.chatBusy(), autonomousRunOpen: false })
        : { skip: 'KEEPWARM_CACHE_EVIDENCE_UNKNOWN' as const };
      if (admit.skip !== null) {
        // 不可发=目标清空（不发旧维护请求；等新证据重排）
        this.d.db.prepare('UPDATE background_tasks SET next_due_at = NULL, updated_at = ? WHERE id = ?').run(new Date(this.now()).toISOString(), t.id);
        continue;
      }
      const target = keepwarmTargetMs(Date.parse(evidence!.startedAt));
      this.d.db.prepare('UPDATE background_tasks SET next_due_at = ?, updated_at = ? WHERE id = ?').run(new Date(target).toISOString(), new Date(this.now()).toISOString(), t.id);
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
    };
    try {
      this.d.db.prepare("UPDATE background_runs SET state = 'running', updated_at = ? WHERE id = ?").run(new Date(this.now()).toISOString(), runId);
      const r = await this.d.executor.executeRun({ runId, taskId: task.id, kind: task.kind, conversationId: task.conversation_id, payload: JSON.parse(task.payload_json) as Record<string, unknown>, isCancelRequested, registerAbort });
      if (this.cancelRequested.has(runId)) finish('cancelled', r.result_code ?? 'CANCELLED_BY_USER_CHAT', 'USER_CHAT_PREEMPTED');
      else finish(r.outcome, r.result_code ?? null);
    } catch (err) {
      finish('failed', String((err as Error).message ?? 'EXECUTOR_ERROR').slice(0, 120));
    }
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

  /** 派发记账入口（executor 在每次 transport 前调用；§10.1 唯一预算账本）。 */
  recordDispatchStart(input: { runId: string; logicalActionKey: string; attemptNo: number; dispatchKind: 'model' | 'tool' | 'delivery'; capabilityName: string | null; reservedCostMicroUsd: number }): { allowed: boolean; dispatchId: string } {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const dispatchId = genId('bgd');
    const run = this.d.db.prepare('SELECT id, model_requests_started, tool_calls_started, first_dispatch_started_at FROM background_runs WHERE id = ?').get(input.runId) as { id: string; model_requests_started: number; tool_calls_started: number; first_dispatch_started_at: string | null } | undefined;
    if (!run) return { allowed: false, dispatchId: '' };
    // 取消后不再发（§7.2.3：关闭返回后不得开始新 transport）
    if (this.cancelRequested.has(input.runId)) return { allowed: false, dispatchId: '' };
    tx(this.d.db, () => {
      this.d.db.prepare(
        `INSERT INTO background_dispatches(id, run_id, logical_action_key, attempt_no, dispatch_kind, capability_name, state, budget_day, reserved_cost_micro_usd, dispatch_started_at, created_at)
         VALUES (?,?,?,?,?,?,'reserved',?,?,?,?)`,
      ).run(dispatchId, input.runId, input.logicalActionKey, input.attemptNo, input.dispatchKind, input.capabilityName, this.budgetDayNow(nowMs), input.reservedCostMicroUsd, nowIso, nowIso);
      if (input.dispatchKind === 'model') this.d.db.prepare('UPDATE background_runs SET model_requests_started = model_requests_started + 1, first_dispatch_started_at = COALESCE(first_dispatch_started_at, ?), reserved_cost_micro_usd = reserved_cost_micro_usd + ?, updated_at = ? WHERE id = ?').run(nowIso, input.reservedCostMicroUsd, nowIso, input.runId);
      if (input.dispatchKind === 'tool') this.d.db.prepare('UPDATE background_runs SET tool_calls_started = tool_calls_started + 1, reserved_cost_micro_usd = reserved_cost_micro_usd + ?, updated_at = ? WHERE id = ?').run(input.reservedCostMicroUsd, nowIso, input.runId);
    });
    return { allowed: true, dispatchId };
  }

  private budgetDayNow(nowMs: number): string {
    return new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10); // 上海日（与 attribution.shanghaiDayOf 同口径）
  }

  /** 派发结算（§10.1 返回后逐笔；未知保留预占）。 */
  settleDispatch(dispatchId: string, opts: { actualCostMicroUsd: number | null; outcomeCode: string }): void {
    const nowIso = new Date(this.now()).toISOString();
    this.d.db.prepare("UPDATE background_dispatches SET state = ?, actual_cost_micro_usd = ?, settled_at = ?, outcome_code = ? WHERE id = ?").run(opts.actualCostMicroUsd === null ? 'unknown' : 'settled', opts.actualCostMicroUsd, nowIso, opts.outcomeCode, dispatchId);
    if (opts.actualCostMicroUsd !== null) {
      const runId = (this.d.db.prepare('SELECT run_id FROM background_dispatches WHERE id = ?').get(dispatchId) as { run_id: string }).run_id;
      this.d.db.prepare('UPDATE background_runs SET known_cost_micro_usd = known_cost_micro_usd + ?, updated_at = ? WHERE id = ?').run(opts.actualCostMicroUsd, nowIso, runId);
    }
  }

  /** 首个自主派发时间（外部冷却查询用）。 */
  lastAutonomousDispatchAt(actorId: string): string | null {
    return (this.d.db.prepare("SELECT first_dispatch_started_at FROM background_runs WHERE kind = 'autonomous' AND actor_id = ? AND first_dispatch_started_at IS NOT NULL ORDER BY first_dispatch_started_at DESC LIMIT 1").get(actorId) as { first_dispatch_started_at: string } | undefined)?.first_dispatch_started_at ?? null;
  }
}

void POLICY_CONSTANTS; // 引用保持（policy 常量经 background-policy 间接使用）
