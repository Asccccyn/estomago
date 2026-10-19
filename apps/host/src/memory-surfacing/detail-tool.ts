// memory_read_full 模型工具执行器（docs/05）。
// 输入只有已交付短引用 memory_ref(+cursor)；服务器解析为 detail_ref →
// M detail 快照。绝不 recall；不写 view_receipt；不确认明确打开。
// 工具契约（model-tool.json）从新 epoch 初始即冻结进工具集——不动态加。
import type { SurfacingRepository } from './repository.ts';
import type { MariposaClient } from '../integrations/mariposa/client.ts';

export async function executeMemoryReadFull(
  repo: SurfacingRepository,
  client: MariposaClient,
  args: { memory_ref?: unknown; cursor?: unknown },
  scope: { roomId: string; windowId: string; requestId: string },
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string }> {
  const ref = typeof args.memory_ref === 'string' ? args.memory_ref : '';
  if (!ref) return { ok: false, code: 'INVALID_ARGUMENT', message: 'memory_ref 必填' };
  const cursor = typeof args.cursor === 'string' && args.cursor.length > 0 ? args.cursor : undefined;
  const mapped = repo.refToDetail(ref, scope);
  if (!mapped) {
    // 引用未实际进入本房间模型输入 → 拒绝（不猜测、不搜索）
    return { ok: false, code: 'DETAIL_REF_NOT_SEEN', message: '该记忆引用不在已交付范围内' };
  }
  const r = await client.surfaceDetailRead(cursor ? { detail_ref: mapped.detail_ref, cursor } : { detail_ref: mapped.detail_ref });
  if (!r.ok) {
    return { ok: false, code: r.code, message: '详情读取失败（结构化错误码原样返回）' };
  }
  return { ok: true, data: r.result };
}
