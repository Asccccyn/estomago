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
import { restartDisposition, clockRegressionAction, budgetGate, backgroundControl, type ModelBackgroundControl, type RunState, type BackgroundKind } from './background-policy.ts';
import { ConversationActivityService } from './wake-activity.ts';
import { keepwarmSleepState } from './keepwarm-sleep.ts';
import { settleBackgroundRun } from './background-ledger.ts';
import { DAILY_MEMORY_WINDOW_MS, HEARTBEAT_DAILY_MEMORY_TASK, nextDailyMemoryDue } from '../modules/heartbeat/daily-memory.ts';

export type BackgroundExecutor = {
  /** 执行一次已领取的 run（在会话串行链内被调用——executor 负责取得执行位）。scheduler 负责状态/记账框架。 */
  executeRun(input: { runId: string; taskId: string; kind: BackgroundKind; origin: string; conversationId: string; payload: Record<string, unknown>; isCancelRequested: () => boolean; registerAbort: (c: AbortController) => void }): Promise<{ outcome: 'completed' | 'noop' | 'failed' | 'unknown' | 'cancelled'; result_code?: string }>;
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
  id: string; conversation_id: string; actor_id: string; kind: BackgroundKind;
  enabled: number; revision: number; schedule_kind: 'once' | 'daily' | 'interval' | 'cache_idle';
  scheduled_at: string | null; next_due_at: string | null; timezone: string; local_time: string | null;
  interval_ms: number | null; payload_json: string; created_by_actor_id: string;
  origin: string; control_reason: string | null;
};
type RunRow = { id: string; task_id: string; kind: BackgroundKind; state: RunState; occurrence_key: string; first_dispatch_started_at: string | null; conversation_id: string; actor_id: string };

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
  private tickWork: Promise<void> | null = null;
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
  disableKind(kind: ModelBackgroundControl): void {
    for (const [runId, c] of this.aborts) {
      const row = this.d.db.prepare('SELECT r.kind,t.origin FROM background_runs r JOIN background_tasks t ON t.id=r.task_id WHERE r.id=?').get(runId) as {kind:BackgroundKind;origin:string}|undefined;
      if (row && row.kind !== 'reminder' && backgroundControl(row.kind,row.origin) === kind) {
        this.cancelRequested.add(runId);
        this.cancelReasons.set(runId, kind === 'keepwarm' ? 'KEEPWARM_DISABLED' : kind === 'free_activity' ? 'FREE_ACTIVITY_DISABLED' : 'AUTONOMOUS_DISABLED');
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
      // RB2-03（复审 20261106 第二轮）：让位按既有控制类型（backgroundControl）判定，
      // 与预算同一分类——keepwarm 与自由活动（autonomous+origin=free_activity）让位；
      // 预约唤醒（self_schedule）按普通回合规则继续，不被一刀切取消。
      const row = this.d.db.prepare(
        'SELECT r.kind, t.origin FROM background_runs r JOIN background_tasks t ON t.id = r.task_id WHERE r.id = ?',
      ).get(runId) as { kind: string; origin: string } | undefined;
      if (row && (row.kind === 'keepwarm' || (row.kind === 'autonomous' && row.origin === 'free_activity'))) this.yieldRequested.add(runId);
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
    const rows = this.d.db.prepare("SELECT id, state, kind, occurrence_key, scheduled_for FROM background_runs WHERE state IN ('claimed','running','cancelling','unknown')").all() as Array<{ id: string; state: RunState; kind: string; occurrence_key: string; scheduled_for: string | null }>;
    for (const r of rows) {
      // Usage may have reached disk immediately before a crash. Recover its cost
      // without replaying the model or declaring an unknown external action done.
      settleBackgroundRun(this.d.db, r.id);
      if (r.state === 'running' && r.kind === 'keepwarm' && this.hasCommittedExhaustedReply(r.id)) {
        this.finishRecoveredCompletion(r.id, { outcome: 'completed', result_code: 'ack_only' });
        continue;
      }
      if (r.state === 'running' && r.kind === 'heartbeat_memory'
        && this.d.db.prepare('SELECT 1 FROM heartbeat_daily_memory_choices WHERE run_id=?').get(r.id)) {
        this.finishRecoveredCompletion(r.id,{outcome:'completed',result_code:'DAILY_MEMORY_SELECTED'});
        continue;
      }
      const dispatchCount = (this.d.db.prepare('SELECT COUNT(*) n FROM background_dispatches WHERE run_id = ?').get(r.id) as { n: number }).n;
      const dispo = restartDisposition({ state: r.state, dispatchCount, kind: r.kind as BackgroundKind });
      if (dispo.resultCode === 'UNCHANGED') continue;
      if (dispo.to === 'skipped' && dispatchCount === 0) {
        // W-14：零派发=恢复同 occasion——释放原 key（行留档），任务保持可领取
        this.d.db.prepare("UPDATE background_runs SET state = 'skipped', result_code = ?, occurrence_key = ?, finished_at = ?, updated_at = ? WHERE id = ?")
          .run(dispo.resultCode, `${r.occurrence_key}:recovered:${r.id}`, nowIso, nowIso, r.id);
        // RB04（复审 20261106）：daily/interval 在领取时已推进 next_due_at——恢复必须把
        // 本次已领取的 due 还原（任务修订未变时），下一 tick 重领本次机会；不凭下一日
        // due 猜"本次已结束"（旧实现零派发中断即漏本次）。
        if (r.scheduled_for !== null) {
          this.d.db.prepare(
            `UPDATE background_tasks SET next_due_at = ?, updated_at = ?
             WHERE schedule_kind IN ('daily','interval') AND next_due_at IS NOT NULL AND next_due_at > ?
               AND revision = (SELECT task_revision FROM background_runs WHERE id = ?)
               AND id = (SELECT task_id FROM background_runs WHERE id = ?)`,
          ).run(r.scheduled_for, nowIso, r.scheduled_for, r.id, r.id);
        }
      } else {
        this.d.db.prepare('UPDATE background_runs SET state = ?, result_code = ?, finished_at = ?, updated_at = ? WHERE id = ?').run(dispo.to, dispo.resultCode, nowIso, nowIso, r.id);
        // unknown 的 once 任务标待核对（不自动重放，09 表）
        this.d.db.prepare("UPDATE background_tasks SET control_reason = 'unknown_needs_review', updated_at = ? WHERE schedule_kind = 'once' AND id = (SELECT task_id FROM background_runs WHERE id = ?)").run(nowIso, r.id);
      }
    }
  }

  private hasCommittedExhaustedReply(runId: string): boolean {
    return Boolean(this.d.db.prepare(`
      SELECT 1 FROM background_runs run
      JOIN heartbeat_runs heartbeat ON heartbeat.run_id=run.id AND heartbeat.mode='exhausted_keepwarm'
      JOIN turns turn ON turn.id=run.turn_id AND turn.state='completed'
      JOIN messages message ON message.turn_id=turn.id AND message.speaker='assistant'
        AND message.client_message_id='heartbeat:'||run.id||':ack'
      JOIN message_revisions revision ON revision.message_id=message.id
        AND revision.revision=1 AND revision.source='heartbeat_ack'
      WHERE run.id=? AND run.trajectory_committed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM provider_requests request
                    WHERE request.background_run_id=run.id AND request.sent_at IS NOT NULL)
    `).get(runId));
  }

  /** 一次调度心跳：时钟回拨检测 → 到期任务领取与执行。测试可直接调用并虚拟推进时钟。 */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) return; // S-02：单飞——上一 tick 的执行器还没收尾时不重领
    this.ticking = true;
    const work = this.tickInner();
    this.tickWork = work;
    try {
      await work;
    } finally {
      this.ticking = false;
      this.tickWork = null;
    }
  }

  /** Source prep is not a main-model conversation turn; Host shutdown waits
   * its cancelled in-flight scheduler work before closing the DB. */
  async waitIdle(): Promise<void> { await this.tickWork?.catch(() => undefined); }

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
    // The midnight source selection must be resolved before compiling the new
    // day's deck, even if a normal heartbeat became due just before midnight.
    // All other tasks keep the existing due-time/stable order.
    const tasks = this.d.db.prepare("SELECT * FROM background_tasks WHERE enabled = 1 AND next_due_at IS NOT NULL ORDER BY CASE WHEN kind='heartbeat_memory' THEN 0 ELSE 1 END, next_due_at ASC, CASE WHEN kind = 'autonomous' THEN 0 WHEN kind = 'keepwarm' THEN 2 ELSE 1 END, id ASC").all() as TaskRow[];
    for (let task of tasks) {
      if (this.stopped) return;
      let due = task.next_due_at ? Date.parse(task.next_due_at) : null;
      if (due === null || Number.isNaN(due) || due > nowMs) continue;
      // 待核对任务不自动调度（E06/W-16：关闭期间错过/结果未知——等待显式恢复）
      if (task.control_reason !== null) continue;
      if (task.kind === 'autonomous' && !settings[backgroundControl(task.kind,task.origin)].enabled) {
        // W-16：明确关闭期间到期的一次性预约→needs_review（不突发补发；未来任务按原时间继续）
        if (task.schedule_kind === 'once') {
          this.d.db.prepare("UPDATE background_tasks SET control_reason = 'disabled_missed_needs_review', updated_at = ? WHERE id = ?").run(new Date(nowMs).toISOString(), task.id);
        }
        continue;
      }
      if (task.kind === 'keepwarm' && !settings.keepwarm.enabled) continue;
      if (task.kind === 'heartbeat_memory') {
        if (!settings.keepwarm.enabled || task.id !== HEARTBEAT_DAILY_MEMORY_TASK || task.origin !== 'system_heartbeat_memory') continue;
        const now = this.now();
        if (now - due >= DAILY_MEMORY_WINDOW_MS) {
          // Record the missed occurrence with zero traffic; never backfill
          // paid selection at noon or pretend that it occurred at midnight.
          const missed = this.claim(task, now);
          if (missed) this.finishRun(missed,task,'skipped','DAILY_MEMORY_MIDNIGHT_MISSED');
          const next = nextDailyMemoryDue(now);
          this.d.db.prepare('UPDATE background_tasks SET next_due_at=?,updated_at=? WHERE id=? AND revision=?')
            .run(next,new Date(now).toISOString(),task.id,task.revision);
          // If this process returned during today's genuine midnight window,
          // skip the old occurrence but still prepare today before any draw.
          due = Date.parse(next);
          if (due > now || now - due >= DAILY_MEMORY_WINDOW_MS) continue;
          task = { ...task, next_due_at: next };
        }
      }
      // 前面的执行可能跨入睡眠时段；每次领取用当前时钟再查，不能复用 tick 快照。
      if (task.kind === 'keepwarm' && keepwarmSleepState(this.d.settings.effective().keepwarm.sleep_window, this.now()).blocked) continue;
      if (task.kind === 'reminder' && !settings.reminders.enabled) continue;
      // 同主体同 kind 已有打开的执行（唯一索引兜底；此处先查少一次约束冲突）
      const open = this.d.db.prepare("SELECT id,task_id,state,result_code FROM background_runs WHERE actor_id = ? AND kind = ? AND state IN ('claimed','running','cancelling') LIMIT 1").get(task.actor_id, task.kind) as { id: string; task_id: string; state: string; result_code: string | null } | undefined;
      if (open) {
        if (open.task_id === task.id && open.state === 'claimed' && (open.result_code === 'NO_ACTIVE_WINDOW' || open.result_code === 'CONTEXT_SELECTION_REQUIRED')) await this.executeClaimed(open.id, task);
        continue;
      }
      const runId = this.claim(task, task.kind === 'heartbeat_memory' ? this.now() : nowMs);
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
    } else if (task.kind === 'heartbeat_memory') {
      occurrenceKey = `heartbeat-memory:${task.conversation_id}:${task.next_due_at}`;
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
    const finish = (state: RunState, resultCode: string | null, cancelReason: string | null = null): void =>
      this.finishRun(runId, task, state, resultCode, cancelReason);
    try {
      const r = await this.d.executor.executeRun({ runId, taskId: task.id, kind: task.kind, origin: task.origin, conversationId: task.conversation_id, payload: JSON.parse(task.payload_json) as Record<string, unknown>, isCancelRequested, registerAbort });
      if (this.cancelRequested.has(runId)) finish('cancelled', r.result_code ?? 'CANCELLED', this.cancelReasons.get(runId) ?? 'RUN_STOPPED');
      else finish(r.outcome, r.result_code ?? null);
    } catch (err) {
      if (this.cancelRequested.has(runId)) finish('cancelled', 'CANCELLED', this.cancelReasons.get(runId) ?? 'RUN_STOPPED');
      else finish('failed', 'BACKGROUND_EXECUTOR_FAILED');
    }
  }

  finishRecoveredCompletion(runId: string, result: {
    outcome: 'completed' | 'noop' | 'failed' | 'unknown'; result_code?: string;
  }): void {
    this.finishRun(runId, this.taskOfRun(runId), result.outcome, result.result_code ?? null);
  }

  /** RB2-02（复审 20261106 第二轮）：结束一次执行的共同领域操作——执行完成、无执行者
   *  停止及需要收尾的恢复入口共用：run 终态、task 资格收尾（finalizeTaskAfterRun）与
   *  本次资源释放在同一出口。删除 stopRun 的独立 run 终态 SQL 旁路（旧旁路绕过任务
   *  终结，run 已停而 task 仍伪 scheduled——同 occurrence 实际不能再执行）。 */
  private finishRun(runId: string, task: TaskRow | null, state: RunState, resultCode: string | null, cancelReason: string | null = null): void {
    const nowIso = new Date(this.now()).toISOString();
    const dispatched = (this.d.db.prepare('SELECT COUNT(*) n FROM background_dispatches WHERE run_id=?').get(runId) as { n: number }).n;
    const waiting = task?.kind === 'autonomous' && dispatched === 0 && ((cancelReason === 'HOST_STOPPED') || (cancelReason === null && (resultCode === 'NO_ACTIVE_WINDOW' || resultCode === 'CONTEXT_SELECTION_REQUIRED')));
    if (waiting) state = 'claimed';
    // F03（四仓联合审计 20261104）：finish 只从活态收口——run 已被任务取消
    // （supersedeOpenRuns 置 cancelled）时不得用执行结果覆盖；也不触发任务终结。
    // R1（复审 b137e98）：cancelling（stop-run 的待收尾活态）必须可被收口。
    // R3-B02（第三轮复审）：run CAS 终态与同版本 task 资格收尾在**同一短事务**提交——
    // 此前分两次提交，提交缝中断会留下"run 已终态、task 仍 enabled/原 due"的半收口，
    // 且恢复/重试都不会再触达（外连接可观测，P 级反例）。内存资源在事务提交后释放。
    const finished = tx(this.d.db, () => {
      const n = Number(this.d.db.prepare("UPDATE background_runs SET state = ?, result_code = ?, cancel_reason = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state IN ('claimed','running','cancelling')").run(state, resultCode, cancelReason, waiting ? null : nowIso, nowIso, runId).changes);
      if (n > 0 && !waiting) {
        this.d.db.prepare(`UPDATE attempts SET completion_recovery_json=NULL
          WHERE turn_id=(SELECT turn_id FROM background_runs WHERE id=?)`).run(runId);
        if (state === 'cancelled' && task?.kind === 'autonomous') this.d.db.prepare("UPDATE background_tasks SET control_reason=COALESCE(control_reason,'stopped_needs_review'), updated_at=? WHERE id=? AND revision=?").run(nowIso, task.id, task.revision);
        if (task) this.finalizeTaskAfterRun(task, state, nowIso);
      }
      return n;
    });
    this.aborts.delete(runId);
    this.cancelRequested.delete(runId);
    this.cancelReasons.delete(runId);
    this.yieldRequested.delete(runId);
    void finished;
  }

  /** RB2-02：按 run 身份取其适用修订的 task（修订已变=null——收尾不作用于新版本）。 */
  private taskOfRun(runId: string): TaskRow | null {
    return (this.d.db.prepare(
      'SELECT t.* FROM background_tasks t JOIN background_runs r ON r.task_id = t.id AND r.task_revision = t.revision WHERE r.id = ?',
    ).get(runId) as TaskRow | undefined) ?? null;
  }

  /** 领取≠消耗的收尾（RB04 复审 20261106 扩到全部 once 任务——reminder 同为 once，
   *  旧实现只收口 autonomous：once 提醒投递后 task 永远 enabled=1/伪 scheduled，且
   *  occurrence 唯一键已消耗=永不自动执行却每 tick 空扫）。
   *  成功（completed/noop）=delivered 终结；失败/未知→待核对；取消→终态待核
   *  （"待下一轮"不会来——唯一 occurrence 已消耗，如实停用并保留复核原因）。 */
  private finalizeTaskAfterRun(task: TaskRow, state: RunState, nowIso: string): void {
    if (task.schedule_kind !== 'once') return;
    if (state === 'completed' || state === 'noop') {
      this.d.db.prepare("UPDATE background_tasks SET enabled = 0, next_due_at = NULL, control_reason = 'delivered', updated_at = ? WHERE id = ? AND revision = ?").run(nowIso, task.id, task.revision);
    } else if (state === 'failed' || state === 'unknown') {
      this.d.db.prepare("UPDATE background_tasks SET control_reason = CASE WHEN ? = 'unknown' THEN 'unknown_needs_review' ELSE 'failed_needs_review' END, next_due_at = NULL, updated_at = ? WHERE id = ? AND revision = ?").run(state, nowIso, task.id, task.revision);
    } else if (state === 'cancelled') {
      this.d.db.prepare("UPDATE background_tasks SET enabled = 0, next_due_at = NULL, control_reason = COALESCE(control_reason, 'stopped_needs_review'), updated_at = ? WHERE id = ? AND revision = ?").run(nowIso, task.id, task.revision);
    }
  }

  /** 手动停止一次执行（§7.3：不关总开关）。返回实际状态。 */
  stopRun(runId: string): { state: RunState } | null {
    const row = this.d.db.prepare('SELECT id, state FROM background_runs WHERE id = ?').get(runId) as { id: string; state: RunState } | undefined;
    if (!row) return null;
    if (row.state === 'claimed' || row.state === 'running') {
      // P5（T19）+RB2-02：已无在途执行者（等待派发的 claimed）直接经共同收尾出口
      // 结束——run 与 task 资格同一事务边界一致收口（旧实现绕过任务终结）；
      // 有在途执行者才请求取消并等真实 finish。
      if (!this.aborts.has(runId)) {
        this.finishRun(runId, this.taskOfRun(runId), 'cancelled', 'CANCELLED', 'RUN_STOPPED');
        return { state: 'cancelled' };
      }
      this.cancelRequested.add(runId);
      this.cancelReasons.set(runId, 'RUN_STOPPED');
      this.aborts.get(runId)?.abort();
      this.d.db.prepare("UPDATE background_runs SET state = 'cancelling', updated_at = ? WHERE id = ?").run(new Date(this.now()).toISOString(), runId);
      return { state: 'cancelling' };
    }
    return { state: row.state };
  }

  /** 生图可跨过多次 I/O；沿用派发账本的首派发时刻和同一档有效时限。 */
  remainingRunMs(runId: string): number {
    if (this.cancelRequested.has(runId) || this.isYieldRequested(runId)) return 0;
    const row = this.d.db.prepare(`
      SELECT r.kind, r.first_dispatch_started_at, t.origin
        FROM background_runs r JOIN background_tasks t ON t.id=r.task_id
       WHERE r.id=? AND r.state='running' AND t.revision=r.task_revision AND t.enabled=1 AND t.control_reason IS NULL
    `).get(runId) as { kind: BackgroundKind; first_dispatch_started_at: string | null; origin: string } | undefined;
    if (!row?.first_dispatch_started_at || row.kind === 'reminder') return 0;
    const control = backgroundControl(row.kind, row.origin);
    const settings = this.d.settings.effective();
    const nowMs = this.now();
    if (!settings[control].enabled || (row.kind === 'keepwarm' && keepwarmSleepState(settings.keepwarm.sleep_window, nowMs).blocked)) return 0;
    return Math.max(0, Date.parse(row.first_dispatch_started_at) + settings[control].max_run_ms - nowMs);
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
      const task = this.d.db.prepare('SELECT revision,enabled,control_reason,origin FROM background_tasks WHERE id = ?').get(run.task_id) as { revision: number; enabled: number; control_reason: string | null; origin: string } | undefined;
      if (!task) return reject('TASK_NOT_FOUND');
      if (task.revision !== run.task_revision) return reject('TASK_SUPERSEDED');
      if (!task.enabled || task.control_reason !== null) return reject('TASK_CANCELLED');
      if (!Number.isSafeInteger(input.reservedCostMicroUsd) || input.reservedCostMicroUsd < 0) return reject('BUDGET_ESTIMATE_UNAVAILABLE');
      const settings = this.d.settings.effective();
      if (run.kind === 'autonomous' || run.kind === 'keepwarm' || run.kind === 'heartbeat_memory') {
        const control=backgroundControl(run.kind,task.origin);
        if (!settings[control].enabled) return reject(control==='keepwarm'?'KEEPWARM_DISABLED':control==='free_activity'?'FREE_ACTIVITY_DISABLED':'AUTONOMOUS_DISABLED');
        if (run.kind === 'keepwarm') {
          const sleep = keepwarmSleepState(settings.keepwarm.sleep_window, nowMs);
          if (sleep.blocked) return reject(sleep.code!);
        }
        if (run.kind === 'heartbeat_memory') {
          const due = this.d.db.prepare('SELECT scheduled_for FROM background_runs WHERE id=?').get(run.id) as {scheduled_for:string|null};
          const dueMs = Date.parse(due.scheduled_for ?? '');
          if (run.task_id !== HEARTBEAT_DAILY_MEMORY_TASK || task.origin !== 'system_heartbeat_memory'
            || input.capabilityName !== 'heartbeat_memory_select' || input.dispatchKind !== 'tool'
            || !Number.isFinite(dueMs) || nowMs < dueMs || nowMs - dueMs >= DAILY_MEMORY_WINDOW_MS) return reject('DAILY_MEMORY_DISPATCH_NOT_ADMITTED');
        }
        const gate = budgetGate({
          kind: control, settings, dispatchKind: input.dispatchKind === 'tool' ? 'tool' : 'model', nowMs,
          nextRequestCostMicroUsd: input.reservedCostMicroUsd,
          run: { model_requests_started: run.model_requests_started, tool_calls_started: run.tool_calls_started,
            output_tokens_observed: 0, startedAtMs: run.first_dispatch_started_at ? Date.parse(run.first_dispatch_started_at) : nowMs,
            reserved_cost_micro_usd: this.dailyOccupiedMicroUsd(control, this.budgetDayNow(nowMs)), known_cost_micro_usd: 0, unknown_cost_count: 0 },
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
  dailyOccupiedMicroUsd(kind: ModelBackgroundControl, budgetDay: string): number {
    const row = this.d.db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN bd.state = 'settled' THEN bd.actual_cost_micro_usd ELSE bd.reserved_cost_micro_usd END), 0) AS occ
       FROM background_dispatches bd JOIN background_runs r ON r.id=bd.run_id JOIN background_tasks t ON t.id=r.task_id
       WHERE bd.budget_day=? AND ((?='keepwarm' AND r.kind IN ('keepwarm','heartbeat_memory'))
         OR (?<>'keepwarm' AND r.kind='autonomous' AND (t.origin='self_schedule')=?))
       AND bd.state!='cancelled_before_send'`,
    ).get(budgetDay,kind,kind,kind==='autonomous'?1:0) as { occ: number };
    return row?.occ ?? 0;
  }

  private budgetDayNow(nowMs: number): string {
    return new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10); // 上海日（与 attribution.shanghaiDayOf 同口径）
  }

}
