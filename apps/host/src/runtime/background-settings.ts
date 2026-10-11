// ESTOMAGO_CHAT_EXEC_V1 §04.4/§4.2/§7.2（WP4）：后台设置生效视图 + 原子关闭。
// 存储复用 runtime_settings 表（一条设置正本）；PUT 在单事务内：持久 enabled + 递增 revision +
// 把未执行的自主领取标失效；提交后由调度器 fence/abort 当前执行（§7.2 顺序）。
// 页面、调度器、派发前检查统一经 effectiveSettingsFor() 读——不存在 worker 用旧 enabled 的路径。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import type { Config } from '../config/schema.ts';
import { effectiveSettings, type EffectiveSettings } from '../runtime/background-policy.ts';

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
    const stored = row ? JSON.parse(row.value) as { autonomous_enabled?: boolean | null; keepwarm_enabled?: boolean | null; reminders_enabled?: boolean | null } : null;
    return effectiveSettings(this.config, rev, stored);
  }

  /**
   * §7.2 原子写入：单事务内持久 enabled + 递增 revision + 未执行自主领取标 cancelled。
   * expectedRevision 不匹配=REVISION_CONFLICT（If-Match 409）。返回新 revision。
   */
  applyUpdate(opts: { expectedRevision: number; patch: { autonomous_enabled?: boolean; keepwarm_enabled?: boolean; reminders_enabled?: boolean } }): { revision: number } {
    return tx(this.db, () => {
      const current = this.revision();
      if (opts.expectedRevision !== current) throw new Error(`REVISION_CONFLICT:${current}`);
      const row = this.db.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(SETTINGS_KEY) as StoredRow | undefined;
      const stored = row ? JSON.parse(row.value) as Record<string, unknown> : {};
      const merged = { ...stored, ...Object.fromEntries(Object.entries(opts.patch).filter(([, v]) => typeof v === 'boolean')) };
      const nowIso = new Date().toISOString();
      this.db.prepare("INSERT INTO runtime_settings(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(SETTINGS_KEY, JSON.stringify(merged), nowIso);
      const nextRev = current + 1;
      this.db.prepare("INSERT INTO runtime_settings(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(REVISION_KEY, String(nextRev), nowIso);
      // §7.2.1：关闭自主 → 尚未执行的领取（claimed、零派发）标 cancelled（正在执行的由调度器 fence）
      if (opts.patch.autonomous_enabled === false) {
        this.db.prepare("UPDATE background_runs SET state = 'cancelled', cancel_reason = 'AUTONOMOUS_DISABLED', result_code = 'AUTONOMOUS_DISABLED', finished_at = ?, updated_at = ? WHERE state = 'claimed' AND kind = 'autonomous'").run(nowIso, nowIso);
      }
      if (opts.patch.keepwarm_enabled === false) {
        this.db.prepare("UPDATE background_runs SET state = 'cancelled', cancel_reason = 'KEEPWARM_DISABLED', result_code = 'KEEPWARM_DISABLED', finished_at = ?, updated_at = ? WHERE state = 'claimed' AND kind = 'keepwarm'").run(nowIso, nowIso);
      }
      return { revision: nextRev };
    });
  }
}
