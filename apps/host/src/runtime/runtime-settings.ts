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

// —— OR 模型元数据（公开 /api/v1/models，免费零私人数据；§6.2 要求核对） ——
// 档位支持因模型而异：如 claude-fable-5.1 强制思考（mandatory=true）且
// 只支持 max/xhigh/high/medium/low——none/minimal 会被 OR 400 拒绝。
export type OrModelReasoningMeta = { supported_efforts?: string[]; mandatory?: boolean };

const _metaCache = new Map<string, { meta: OrModelReasoningMeta | null; fetchedAt: number }>();
const META_TTL_MS = 60 * 60 * 1000;
// WP-05（B17）：负结果短 TTL——端点故障期不反复吃 8s 超时（60s 后可重试）
const META_NEG_TTL_MS = 60_000;

/** 测试注入点（离线套件不打网络） */
export function setModelMetaForTests(model: string, meta: OrModelReasoningMeta | null): void {
  _metaCache.set(model, { meta, fetchedAt: Date.now() });
}

export function clearModelMetaCache(): void {
  _metaCache.clear();
}

export async function fetchOrModelMeta(baseUrl: string, model: string): Promise<OrModelReasoningMeta | null> {
  const hit = _metaCache.get(model);
  if (hit && Date.now() - hit.fetchedAt < (hit.meta ? META_TTL_MS : META_NEG_TTL_MS)) return hit.meta;
  try {
    // WP-04（CX-11/C-017）：baseUrl 可能已含 /api/v1（配置默认如此）——
    // 先剥尾部再拼，否则双拼 404（元数据恒不可达被当"未验证"）
    const root = baseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
    const res = await fetch(`${root}/api/v1/models`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ id?: string; reasoning?: OrModelReasoningMeta }> };
    const row = (data.data ?? []).find((m) => m.id === model);
    const meta = row?.reasoning ?? null;
    _metaCache.set(model, { meta, fetchedAt: Date.now() });
    return meta;
  } catch {
    return null; // 元数据不可达=未验证（设置面如实标注，不阻塞）
  }
}

/** 按模型真实支持计算档位清单（default=回落哨兵；非强制思考才允许 none）。
 *  返回 null=元数据不可用（未验证，调用方回落静态全表并如实标注）。 */
export function effortsForModel(meta: OrModelReasoningMeta | null): string[] | null {
  if (!meta) return null; // 元数据不可达=未验证
  // WP-04（C-018）：supported 集是第一真源——mandatory=false 且支持
  // minimal/none 就如实列出（此前一律滤掉，强制思考模型才该滤）；
  // mandatory=true 才滤 none/minimal
  const raw = meta.supported_efforts ?? [];
  const mandatory = meta.mandatory === true;
  // mandatory=true 才滤 none/minimal（强制思考模型没有这两档）；
  // minimal 在非强制模型按 supported 如实保留（此前一律滤掉——C-018）
  const supported = mandatory
    ? raw.filter((e) => e !== 'none' && e !== 'minimal')
    : raw;
  if (supported.length === 0) return ['default']; // OR 对无档位选择的模型省略 supported_efforts——没有思考旋钮
  const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const list = order.filter((e) => supported.includes(e));
  if (!mandatory) list.unshift('none'); // 思考可关（c5c3ad1 她批语义保持）
  return ['default', ...list];
}

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
    this.setMany([[key, value]]);
  }

  /** FU-002（回访 2026-10-09）：多键**单事务**写入——一次请求=一次
   *  生效视图变更。此前两字段各开事务：第二写失败（如 trigger 拒绝
   *  INSERT）后第一写已提交，GET 见到半提交状态。 */
  setMany(entries: Array<[string, string | null]>): void {
    if (entries.length === 0) return;
    tx(this.db, () => {
      for (const [key, value] of entries) {
        if (value === null || value === '') {
          this.db.prepare('DELETE FROM runtime_settings WHERE key = ?').run(key);
        } else {
          this.db.prepare(
            `INSERT INTO runtime_settings(key, value, updated_at) VALUES (?,?,?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          ).run(key, value, new Date().toISOString());
        }
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
