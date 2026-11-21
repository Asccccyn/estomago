// ESTOMAGO_CHAT_EXEC_V1 §04.4/§4.2/§7.2（WP4）：后台设置生效视图 + 原子关闭。
// 存储复用 runtime_settings 表（一条设置正本）；PUT 在单事务内：持久 enabled + 递增 revision +
// 把未执行的自主领取标失效；提交后由调度器 fence/abort 当前执行（§7.2 顺序）。
// 页面、调度器、派发前检查统一经 effectiveSettingsFor() 读——不存在 worker 用旧 enabled 的路径。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { isDailyCostCap, type DailyCostCap, type Config } from '../config/schema.ts';
import { effectiveSettings, MODEL_BACKGROUND_CONTROLS, type ModelBackgroundControl, type EffectiveSettings } from '../runtime/background-policy.ts';

const SETTINGS_KEY = 'background.settings';
const REVISION_KEY = 'background.settings_revision';

type StoredRow = { key: string; value: string; updated_at: string };

export class BackgroundSettingsService {
  private db: Db;
  private config: Config;
  constructor(db: Db, config: Config) {
    this.db = db;
    this.config = config;
  }

  revision(): number {
    const row = this.db.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(REVISION_KEY) as { value: string } | undefined;
    return row ? Number(row.value) || 0 : 0;
  }

  /** §4.2 生效视图（单一来源；config 只给初值，override 以 runtime_settings 为准）。 */
  effective(): EffectiveSettings {
    const rev = this.revision();
    const row = this.db.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(SETTINGS_KEY) as StoredRow | undefined;
    const stored = row ? JSON.parse(row.value) as { free_activity_enabled?: boolean | null; autonomous_enabled?: boolean | null; keepwarm_enabled?: boolean | null; keepwarm_include_living_room?: boolean | null; reminders_enabled?: boolean | null; free_activity_daily_cost_cap_usd?: DailyCostCap; autonomous_daily_cost_cap_usd?: DailyCostCap; keepwarm_daily_cost_cap_usd?: DailyCostCap } : null;
    const es = effectiveSettings(this.config, rev, stored);
    if ('free_activity_daily_cost_cap_usd' in (stored ?? {})) es.free_activity.daily_cost_cap_usd = stored?.free_activity_daily_cost_cap_usd ?? null;
    if ('autonomous_daily_cost_cap_usd' in (stored ?? {})) es.autonomous.daily_cost_cap_usd = stored?.autonomous_daily_cost_cap_usd ?? null;
    if ('keepwarm_daily_cost_cap_usd' in (stored ?? {})) es.keepwarm.daily_cost_cap_usd = stored?.keepwarm_daily_cost_cap_usd ?? null;
    return es;
  }

  /**
   * §7.2 原子写入：单事务内持久 enabled + 递增 revision + 未执行自主领取标 cancelled。
   * expectedRevision 不匹配=REVISION_CONFLICT（If-Match 409）。返回新 revision。
   */
  /** AUD-02 修复：关闭时终止运行中执行的回调（由 scheduler 装配时注入） */
  onDisable: ((kind: ModelBackgroundControl) => void) | null = null;

  applyUpdate(opts: { expectedRevision: number; operationId?: string; patch: { free_activity_enabled?: boolean; autonomous_enabled?: boolean; keepwarm_enabled?: boolean; keepwarm_include_living_room?: boolean; reminders_enabled?: boolean; free_activity_daily_cost_cap_usd?: DailyCostCap; autonomous_daily_cost_cap_usd?: DailyCostCap; keepwarm_daily_cost_cap_usd?: DailyCostCap }; readiness?: { autonomousExecutorReady: boolean; keepwarmExecutorReady: boolean } }): { revision: number; duplicate?: boolean } {
    return tx(this.db, () => {
      const requestHash = JSON.stringify({ expectedRevision: opts.expectedRevision, patch: Object.fromEntries(Object.entries(opts.patch).sort(([a], [b]) => a.localeCompare(b))) });
      if (opts.operationId !== undefined) {
        if (!opts.operationId || opts.operationId.length > 128) throw new Error('SETTINGS_OPERATION_ID_INVALID');
        const previous = this.db.prepare("SELECT request_hash,response_json FROM background_operations WHERE actor_id='qiaosheng' AND conversation_id='primary' AND action='settings_update' AND operation_id=?").get(opts.operationId) as { request_hash: string; response_json: string } | undefined;
        if (previous) {
          if (previous.request_hash !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
          return { ...JSON.parse(previous.response_json) as { revision: number }, duplicate: true };
        }
      }
      const current = this.revision();
      if (opts.expectedRevision !== current) throw new Error(`REVISION_CONFLICT:${current}`);
      const before = this.effective();
      const readiness = opts.readiness ?? { autonomousExecutorReady: true, keepwarmExecutorReady: true };
      const caps: Record<string, unknown> = {};
      for (const control of MODEL_BACKGROUND_CONTROLS) {
        const key = `${control}_daily_cost_cap_usd` as const;
        if (key in opts.patch) {
          if (!isDailyCostCap(opts.patch[key])) throw new Error(`BACKGROUND_BUDGET_INVALID:${key}`);
          caps[key] = opts.patch[key];
        }
        if (opts.patch[`${control}_enabled`] === true) {
          const cap = key in opts.patch ? opts.patch[key] : before[control].daily_cost_cap_usd;
          if (cap === null || cap === undefined) throw new Error(`BACKGROUND_BUDGET_NOT_CONFIGURED:${control}`);
          const ready = control === 'keepwarm' ? readiness.keepwarmExecutorReady : readiness.autonomousExecutorReady;
          if (!ready) throw new Error(`BACKGROUND_EXECUTOR_NOT_READY:${control}`);
        }
      }
      const row = this.db.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(SETTINGS_KEY) as StoredRow | undefined;
      const stored = row ? JSON.parse(row.value) as Record<string, unknown> : {};
      const merged = { ...stored, ...Object.fromEntries(Object.entries(opts.patch).filter(([, v]) => typeof v === 'boolean')), ...caps };
      const nowIso = new Date().toISOString();
      // No tick is guaranteed while the host is stopped or a previous run is in
      // flight. The reopening transaction must quarantine disabled-period misses.
      for (const control of ['autonomous','free_activity'] as const) {
        if (!before[control].enabled && opts.patch[`${control}_enabled`] === true) {
          this.db.prepare(`UPDATE background_tasks SET control_reason='disabled_missed_needs_review', updated_at=?
            WHERE kind='autonomous' AND (origin='self_schedule')=? AND schedule_kind='once'
            AND enabled=1 AND control_reason IS NULL AND next_due_at<=?`).run(nowIso,control==='autonomous'?1:0,nowIso);
        }
      }
      this.db.prepare("INSERT INTO runtime_settings(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(SETTINGS_KEY, JSON.stringify(merged), nowIso);
      const nextRev = current + 1;
      this.db.prepare("INSERT INTO runtime_settings(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(REVISION_KEY, String(nextRev), nowIso);
      // AUD-07 P2：开启保温 → 自动创建/恢复系统保温任务（cache_idle 型）
      if (opts.patch.keepwarm_enabled === true) {
        const existingKw = this.db.prepare("SELECT id FROM background_tasks WHERE kind = 'keepwarm' AND schedule_kind = 'cache_idle' AND conversation_id = 'primary'").get() as { id: string } | undefined;
        if (!existingKw) {
          this.db.prepare(
            "INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, created_at, updated_at) VALUES ('bgt_keepwarm_system', 'primary', 'jiaming', 'keepwarm', 1, 1, 'cache_idle', NULL, NULL, 'Asia/Shanghai', NULL, NULL, '{}', 'system', 'system_keepwarm', ?, ?)",
          ).run(nowIso, nowIso);
        } else {
          this.db.prepare('UPDATE background_tasks SET enabled = 1, updated_at = ? WHERE id = ?').run(nowIso, existingKw.id);
        }
      }
      for (const control of ['autonomous','free_activity'] as const) {
        if (opts.patch[`${control}_enabled`] === false) {
          const reason = control === 'free_activity' ? 'FREE_ACTIVITY_DISABLED' : 'AUTONOMOUS_DISABLED';
          this.db.prepare(`UPDATE background_runs SET state='cancelled',cancel_reason=?,result_code=?,finished_at=?,updated_at=?
            WHERE state='claimed' AND kind='autonomous' AND task_id IN
            (SELECT id FROM background_tasks WHERE (origin='self_schedule')=?)`).run(reason,reason,nowIso,nowIso,control==='autonomous'?1:0);
          this.onDisable?.(control);
        }
      }
      if (opts.patch.keepwarm_enabled === false) {
        this.db.prepare("UPDATE background_runs SET state = 'cancelled', cancel_reason = 'KEEPWARM_DISABLED', result_code = 'KEEPWARM_DISABLED', finished_at = ?, updated_at = ? WHERE state = 'claimed' AND kind IN ('keepwarm','heartbeat_memory')").run(nowIso, nowIso);
        // AUD-02 P1 修复：终止运行中的保温执行
        this.onDisable?.('keepwarm');
      }
      if (opts.operationId !== undefined) this.db.prepare("INSERT INTO background_operations(actor_id,conversation_id,action,operation_id,request_hash,response_json,created_at) VALUES ('qiaosheng','primary','settings_update',?,?,?,?)").run(opts.operationId, requestHash, JSON.stringify({ revision: nextRev }), nowIso);
      return { revision: nextRev };
    });
  }
}
