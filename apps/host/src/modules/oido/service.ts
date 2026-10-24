// modules/oido/service.ts（P02.4）：oído 深听证据读取用例（第一条真实迁移垂直链）。
// 行为表见 specs/reference/第一条能力_oido_get_逐步迁移.md §1——九步顺序逐项保留：
// UNCONFIGURED → 绑定（analysis+roomId）→ 源授权 → 取消检查 → overview/prosody_page 分支
// → 调用后取消/权限重检 → analysis_id 一致性 → 唯一模型投影（oidoModelView 在原 try 内
// 恰一次执行，错误映射不变；条目 toModel 为正式边界透传）。abort→CANCELLED，其余沿现行截短错误码。
import type { Db } from '../../db/connection.ts';
import type { OidoAdapter } from '../../integrations/oido/adapter.ts';
import { oidoModelView } from '../../integrations/oido/model-view.ts';
import type { CapabilityOutcome, ToolExecContext } from '../../capabilities/contracts.ts';
import { OidoSourceRepository } from './source-repository.ts';

export type OidoGetInput = { analysis_id: string; detail?: string; cursor?: string };
/** 内部结果：模型投影在 service 内恰一次完成；view 不再二次投影。 */
export type OidoGetEvidence = { view: Record<string, unknown> };

export type OidoAnalyzeInput = { audio_ref: string; range_ms?: [number, number] };
/** analyze 内部结果：模型投影在 service 内恰一次完成（原顺序：投影→绑定）。 */
export type OidoAnalysisResult = { view: Record<string, unknown> };

/** 受信音频内容读面（MediaService 的窄投影；不给模块整个 MediaService 写权限——P03.2）。 */
export type AudioContentReader = { readContent(assetId: string): { bytes: Buffer; mime: string } };

export class OidoHearingService {
  private readonly db: Db;
  private readonly oido: OidoAdapter | null;
  private readonly sources: OidoSourceRepository;
  private readonly audio: AudioContentReader | null;

  constructor(deps: { db: Db; oido: OidoAdapter | null; sources: OidoSourceRepository; audio?: AudioContentReader | null }) {
    this.db = deps.db;
    this.oido = deps.oido;
    this.sources = deps.sources;
    this.audio = deps.audio ?? null;
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
      // 唯一投影恰一次且在原 try 内（投影失败沿现行错误码映射，不外抛改写回合语义）
      const view = oidoModelView(result as unknown as Record<string, unknown>, page);
      return { ok: true, value: { view } };
    } catch (err) {
      return { ok: false, error: { error_code: ctx.signal?.aborted ? 'CANCELLED' : String((err as Error).message).slice(0, 64) } };
    }
  }

  /** 按需深听（P03.1a/P03.3）：原 HostToolExecutor.oidoAnalyze 逐字迁移——已发布语音组合用例：
   *  授权源 → 原音频/可信转写 → 原 ingest（原幂等） → 导入后复验+删除意图 → 原 analyze
   *  （(turn,request,tool_call) 幂等键） → 交付前复验 → 原 model-view → 原绑定落库。
   *  无转写允许路径、hash 匹配、前后可见性检查保持；不是每条语音自动深听。 */
  async analyzeVoice(args: OidoAnalyzeInput, ctx: ToolExecContext): Promise<CapabilityOutcome<OidoAnalysisResult>> {
    if (!this.oido || !this.audio) return { ok: false, error: { error_code: 'INTEGRATION_UNCONFIGURED', detail: 'oído 深听未接入（能力缺口，如实拒绝）' } };
    const m = /^est:([A-Za-z0-9_-]{1,128})$/.exec(args.audio_ref ?? '');
    if (!m) return { ok: false, error: { error_code: 'TOOL_ARG_INVALID', detail: 'audio_ref 必须形如 est:<asset_id>' } };
    const assetId = m[1]!;
    // 会话可达性：资产必须绑定本会话某条消息（她发的或char发的语音都算）
    const bound = this.sources.sourceAllowed(assetId, ctx.roomId);
    if (!bound) return { ok: false, error: { error_code: 'ASSET_NOT_IN_ROOM', detail: '该语音不属于当前会话' } };
    try {
      const { bytes, mime } = this.audio.readContent(assetId);
      const row = this.sources.assetSha(assetId);
      if (!row) return { ok: false, error: { error_code: 'ASSET_NOT_FOUND' } };
      const vt = this.sources.readyTranscript(assetId, ctx.roomId, row);
      const transcript = vt?.derived_text ? { text: vt.derived_text, source: vt.derived_source ?? 'siren:transcribe' } : null;
      ctx.signal?.throwIfAborted();
      const receipt = await this.oido.ingestVoice({ assetId, bytes, sha256: row, mime, transcript, signal: ctx.signal });
      // R6′（2026-10-23）：导入回执持久化（est 接入表；幂等 upsert）
      this.sources.recordIngestReceipt(assetId, row, receipt.audioId, receipt.deduplicated);
      ctx.signal?.throwIfAborted();
      // RE-12a（2026-10-24 返修）：导入后复验——源在导入期间被删除/撤权时，回执已落（远端
      // 副本真实存在），必须登记删除意图（outbox 重试可定位）再如实拒绝；不静默留下无主副本
      if (!this.sources.sourceAllowed(assetId, ctx.roomId, row)) {
        this.sources.recordDeleteIntent(assetId, receipt.audioId);
        return { ok: false, error: { error_code: 'ASSET_NOT_IN_ROOM', detail: '导入期间源已删除/撤权；远端副本已登记删除意图，稍后自动清理' } };
      }
      // RE-11（2026-10-24 返修）：操作幂等键=（turn,request,tool_call）——同轮同一工具调用
      // 重试同键（服务端幂等去重）；同一请求内不同 tool_call 各自独立。旧执行路径无
      // tool_call_id 时保留 (turn,request) 形态（legacy 直调，一次只有一个调用在跑）
      const toolCallId = ctx.toolCallId ?? (typeof (args as Record<string, unknown>).__tool_call_id === 'string' ? String((args as Record<string, unknown>).__tool_call_id) : null);
      const idemKey = toolCallId ? `es-an-${ctx.turnId ?? 'bg'}:${ctx.requestId}:${toolCallId}` : `es-an-${ctx.turnId ?? 'bg'}:${ctx.requestId}`;
      const result = await this.oido.analyze({ assetId, rangeMs: args.range_ms, waitMs: 6000, idempotencyKey: idemKey, signal: ctx.signal }).catch((err: Error) => {
        if (String(err.message).includes('IDEMPOTENCY_CONFLICT') || String(err.message).includes('idempotency_conflict')) {
          throw new Error('OIDO_CONTRACT_CHANGED');
        }
        throw err;
      });
      ctx.signal?.throwIfAborted();
      if (!this.sources.sourceAllowed(assetId, ctx.roomId, row)) return { ok: false, error: { error_code: 'ASSET_NOT_IN_ROOM' } };
      // 唯一投影恰一次且在原 try 内（原顺序：投影→绑定落库）
      const output = oidoModelView(result as unknown as Record<string, unknown>);
      this.sources.bindAnalysis(String(output.analysis_id), ctx.roomId, assetId, row);
      return { ok: true, value: { view: output } };
    } catch (err) {
      if (ctx.signal?.aborted) return { ok: false, error: { error_code: 'CANCELLED' } };
      const msg = String((err as Error).message ?? err);
      if (msg.startsWith('OIDO_UNAVAILABLE')) return { ok: false, error: { error_code: 'OIDO_UNAVAILABLE', detail: 'oído 服务当前不可达；稍后可用 oido_analyze 重试' } };
      if (msg.startsWith('OIDO_CONTRACT_CHANGED')) return { ok: false, error: { error_code: 'OIDO_CONTRACT_CHANGED', detail: '分析合同已变更（版本升级）；请重新发起 oido_analyze（新键新分析）' } };
      return { ok: false, error: { error_code: msg.slice(0, 40) || 'OIDO_FAILED', detail: msg.slice(0, 200) } };
    }
  }
}
