// modules/oido/service.ts（P02.4）：oído 深听证据读取用例（第一条真实迁移垂直链）。
// 行为表见 specs/reference/第一条能力_oido_get_逐步迁移.md §1——九步顺序逐项保留：
// UNCONFIGURED → 绑定（analysis+roomId）→ 源授权 → 取消检查 → overview/prosody_page 分支
// → 调用后取消/权限重检 → analysis_id 一致性 → 内部结果 {raw, page}（模型投影由条目 toModel
// 唯一执行一次，oidoModelView 不在此处调用）。abort→CANCELLED，其余沿现行截短错误码。
import type { Db } from '../../db/connection.ts';
import type { OidoAdapter } from '../../integrations/oido/adapter.ts';
import type { CapabilityOutcome, ToolExecContext } from '../../capabilities/contracts.ts';
import { OidoSourceRepository } from './source-repository.ts';

export type OidoGetInput = { analysis_id: string; detail?: string; cursor?: string };
/** 内部结果：raw 不作为工具 output 直接泄露；page 决定 prosody 投影分支。 */
export type OidoGetEvidence = { raw: Record<string, unknown>; page: boolean };

export class OidoHearingService {
  private readonly db: Db;
  private readonly oido: OidoAdapter | null;
  private readonly sources: OidoSourceRepository;

  constructor(deps: { db: Db; oido: OidoAdapter | null; sources: OidoSourceRepository }) {
    this.db = deps.db;
    this.oido = deps.oido;
    this.sources = deps.sources;
  }

  /** 读深听结果（概览/逐字谱分页）——原 HostToolExecutor.oidoGet 逐字迁移。 */
  async getEvidence(args: OidoGetInput, ctx: ToolExecContext): Promise<CapabilityOutcome<OidoGetEvidence>> {
    if (!this.oido) return { ok: false, error: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    const binding = this.sources.analysisBinding(args.analysis_id, ctx.roomId);
    const allowed = () => binding && this.sources.sourceAllowed(binding.asset_id, ctx.roomId, binding.content_sha256);
    if (!allowed()) return { ok: false, error: { error_code: 'ANALYSIS_NOT_IN_ROOM', detail: '请从当前会话原声引用重新发起深听。' } };
    try {
      ctx.signal?.throwIfAborted();
      const page = args.detail === 'prosody_page';
      const result = page
        ? await this.oido.getProsodyPage(args.analysis_id, args.cursor, ctx.signal)
        : await this.oido.getOverview(args.analysis_id, ctx.signal);
      ctx.signal?.throwIfAborted();
      if (!allowed()) return { ok: false, error: { error_code: 'ANALYSIS_NOT_IN_ROOM' } };
      if (result.analysis_id !== args.analysis_id) throw new Error('OIDO_RESULT_INVALID');
      return { ok: true, value: { raw: result as unknown as Record<string, unknown>, page } };
    } catch (err) {
      return { ok: false, error: { error_code: ctx.signal?.aborted ? 'CANCELLED' : String((err as Error).message).slice(0, 64) } };
    }
  }
}
