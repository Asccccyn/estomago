// 运行时设置（她裁定 2026-10-08：聊天窗内置换模型/推理等级）。
//  - 持久正本在 chat.sqlite3（迁移 19 runtime_settings）——改设置不重启、
//    不改配置文件；config 文件仍是默认值来源（override 未设时回落）。
//  - or_model：切换后型号变化进窗口指纹 → 走既有受控换窗（停→选历史→
//    新窗按新型号装配）。清空 override = 回落配置默认（同样按指纹变化处理）。
//  - reasoning_effort：仅生成参数（OR reasoning.effort 七档）——**不进
//    指纹、不换窗**，下一请求立即生效（上下文全复用）。
//  - 仅信封驱动（OR）面生效；DS 官方直连无 effort 参数，模型沿用配置。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';

/** OR 统一档位（现行文档）；'default'=回落 config.openrouter.reasoning */
export const REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffortChoice = (typeof REASONING_EFFORTS)[number];

export type RuntimeSettingsRow = {
  key: string;
  value: string;
  updated_at: string;
};

export class RuntimeSettingsService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  orModel(): string | null {
    const v = this.get('or_model');
    return v && v.length > 0 ? v : null;
  }

  reasoningEffort(): ReasoningEffortChoice | null {
    const v = this.get('reasoning_effort');
    if (!v || v === 'default') return null;
    return (REASONING_EFFORTS as readonly string[]).includes(v) ? v as ReasoningEffortChoice : null;
  }

  /** 写入（人触发；空串/null = 清除 override 回落默认）。 */
  set(key: string, value: string | null): void {
    tx(this.db, () => {
      if (value === null || value === '') {
        this.db.prepare('DELETE FROM runtime_settings WHERE key = ?').run(key);
      } else {
        this.db.prepare(
          `INSERT INTO runtime_settings(key, value, updated_at) VALUES (?,?,?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(key, value, new Date().toISOString());
      }
    });
  }

  /** 生效视图：override 并入 config（未设/非法回落原值）。指纹与驱动读这份。 */
  effectiveOrModel(configOrModel: string | null): string | null {
    return this.orModel() ?? configOrModel;
  }

  effectiveReasoning(configReasoning: Record<string, unknown> | null): Record<string, unknown> | null {
    const effort = this.reasoningEffort();
    if (effort === null) return configReasoning;
    return { effort: effort };
  }
}
