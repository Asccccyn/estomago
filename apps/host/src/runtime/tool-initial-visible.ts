// WAKE/MCP 1022（她 1022 指令，首批裁定：identity_milestone_write——原本整版 write
// 与新增条目化用法一起）："初始可读"工具——定义随开窗资料（B 段）注入，随窗冻结；
// 模型无需 catalog→define 三跳即可 tool_invoke。权限/审计/幂等门不变；wire 入口
// 仍是 3 个；旧窗 B 已冻结不含本段 → 不受影响（零回退）。
import type { Db } from '../db/connection.ts';
// P01.4：不再反向 import host-tools（值导入环的明确拆分点）。
// 只依赖叶类型；工具定义快照由调用方（supervisor 装配根/测试装配）显式传入。
import type { HostToolSpec } from '../capabilities/contracts.ts';
import { definitionId } from './tool-discovery.ts';

const SETTINGS_KEY = 'tools_initial_visible';

/** 她 1022 首批裁定（未配置时的默认）：里程碑——原本整版版本 + 新增条目化版本一起。 */
export const DEFAULT_INITIAL_VISIBLE = ['identity_milestone_write'] as const;

/** 当前生效的初始可读清单（runtime_settings 可覆盖；无配置=默认首批）。 */
export function initialVisibleTools(db: Db): string[] {
  const row = db.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed as string[];
    } catch { /* 坏配置=回落默认，如实不炸 */ }
  }
  return [...DEFAULT_INITIAL_VISIBLE];
}

/** 注入 B 段的文本：每工具 definition_id + 完整定义（与 tool_define 返回同源）。
 *  模型凭此直接 tool_invoke（definition_id 与宿主校验一致）。
 *  P01.4：specs 由调用方传当前宿主目录快照（supervisor 传 buildHostTools()），
 *  本文件不再反向依赖 host-tools；定义正本与已见判定语义不变。 */
export function renderInitialVisibleText(db: Db, specs: readonly HostToolSpec[]): string | null {
  const names = initialVisibleTools(db);
  if (names.length === 0) return null;
  const filtered = specs.filter((t) => names.includes(t.function.name));
  if (filtered.length === 0) return null;
  const lines = ['[tools/initial：以下工具定义已随本窗开窗资料真实注入（无需再 tool_define；可直接 tool_invoke，带各自 definition_id）]'];
  for (const spec of filtered) {
    lines.push(`- ${spec.function.name}（definition_id: ${definitionId(spec)}）`);
    lines.push(`  description: ${spec.function.description}`);
    lines.push(`  parameters: ${JSON.stringify(spec.function.parameters)}`);
  }
  return lines.join('\n');
}

/** invoke 已见判定旁路（C-03 合同精神：定义真实进入过已发送请求即可）：
 *  初始可读工具的定义文本在 B 段——本窗存在任一已发送请求携带该 definition_id
 *  即视为已见。旧窗 B 无此段 → LIKE 不命中 → 仍走 catalog→define 旧门。 */
export function initialDefinitionSeen(db: Db, windowId: string, spec: HostToolSpec): boolean {
  const did = definitionId(spec);
  const row = db.prepare(
    "SELECT 1 FROM provider_requests WHERE window_id = ? AND sent_at IS NOT NULL AND payload_json LIKE ? LIMIT 1",
  ).get(windowId, `%${did}%`);
  return row !== undefined;
}
