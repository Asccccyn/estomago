// application/voice-hearing-port.ts（S17b 批次5）：听觉可用公共端口。
// 自 runtime/supervisor.ts 迁入：配置声明 AND 本窗冻结工具目录含 oido_analyze；
// 旧窗缺能力时仍不得宣传可用（阻断语义保持）。
import type { Db } from '../db/connection.ts';
import { storedToolset } from '../runtime/tool-discovery.ts';

/** JOINT-VOICE（自审修复）：听觉可用=配置声明 AND 本窗冻结工具目录含 oido_analyze。
 *  旧窗目录冻结（A05 合同：不动态膨胀破缓存）没有 oido_analyze 工具——此时引导调用会
 *  TOOL_NOT_IN_WINDOW，误导模型；退回阻断语义（转写未就绪明确报错）更诚实。
 *  无冻结记录的新窗=当前目录（含 oido_analyze）。 */
export function oidoHearingAvailable(db: Db, configured: boolean, windowId: string | null | undefined): boolean {
  if (!configured || !windowId) return false;
  const set = storedToolset(db, windowId);
  if (set && !set.catalog.some((tool) => tool.function.name === 'oido_analyze')) return false;
  return true;
}
