import type { Db } from '../../db/connection.ts';
import { tx } from '../../db/connection.ts';
import type { Logger } from '../../observability/logging.ts';
import type { ToolExecContext } from '../../capabilities/contracts.ts';
import type { OidoHearingService } from './service.ts';
import { OidoSourceRepository } from './source-repository.ts';
import { genId } from '../../util/id.ts';

type AttachmentsSyncClient = {
  attachmentsSync(args: { stream_id: string; origin_message_id: string; revision: number; kind: 'observation'; payload: Record<string, unknown>; operation_id: string }, signal?: AbortSignal): Promise<{ ok: boolean }>;
};
type Hearing = Pick<OidoHearingService, 'analyzeVoice' | 'getEvidence'>;
/** P2（四仓审计 20261106，V01）：资格终结时取消 O 在途分析（fence 落 cancelled）。
 *  RV01（复审 20261106）：返回真实取消结果——非 2xx/网络失败不得吞成"已取消"；
 *  调用方保留操作关联并记录，供必要清理交接。 */
type CancelAnalysis = (analysisId: string) => Promise<{ cancelled: boolean; status: number | null }>;
type WorkerDeps = { hearing: Hearing | null; archiveClient: AttachmentsSyncClient | null; streamId: string; logger?: Logger; cancelAnalysis?: CancelAnalysis };

export type VoiceObservationStatus = 'pending' | 'processing' | 'ready' | 'partial' | 'failed' | 'unsupported';
export type VoiceObservationRow = {
  id: string; message_id: string; revision: number; asset_id: string;
  status: VoiceObservationStatus; display_text: string | null; model_projection: string | null;
  dispatched_turn_id: string | null; dispatched_at: string | null;
  analysis_id: string | null; error_code: string | null; updated_at: string;
};
/** RV2-01：快照是否携带真实分析证据（ready/partial 的 evidence），还是"尚未就绪"占位。 */
export type VoiceObservationSnapshot = { id: string; assetId: string; text: string; adopted: boolean };

/** P2（四仓审计 20261106，V01/U03）：深听资格同轮终结。
 *  每个正式消息修订的采纳决定只落一次（voice_observation_decisions）：
 *  - delivered＝该修订的观察快照随首次模型输入提交而冻结（commitProjection 同点）；
 *  - abandoned＝资格放弃（草稿/轮次取消）。
 *  决定之后：worker 不再驱动该修订；迟到结果不写行（U03“丢弃本次分析结果”）；UI/Source
 *  不再出现新的可消费成功；在途 O 分析经 cancelAnalysis 落 fence。恢复只处理既定快照：
 *  已决定的修订不重排、不复活。 */
export class VoiceObservationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private shutdown: AbortController | null = null;
  private work: Promise<void> | null = null;
  private requested = false;

  private readonly db: Db;
  private readonly worker: WorkerDeps | null;

  constructor(db: Db, worker: WorkerDeps | null = null) {
    this.db = db;
    this.worker = worker;
  }

  get configured(): boolean { return this.worker?.hearing !== null && this.worker?.hearing !== undefined; }

  start(): void {
    if (this.shutdown || !this.worker || (!this.worker.hearing && !this.worker.archiveClient)) return;
    this.shutdown = new AbortController();
    // RV2-03（复审 20261106 第二轮）：重启收口**全部**未决 pending/processing 观察——
    // 不按"仍有 pending/running 轮"保留（旧推断把消息可恢复当成旧分析可重算）。U03：
    // 恢复的正式消息按无分析继续（未就绪占位→delivered 未采纳），或使用故障前已封版
    // 的成功快照；旧未封版分析按 abandoned 终结并在 O 侧 fence，不重算。
    const stale = this.db.prepare(
      `SELECT DISTINCT v.message_id, v.revision FROM voice_observations v
       WHERE v.status IN ('pending','processing')
         AND NOT EXISTS (SELECT 1 FROM voice_observation_decisions d WHERE d.message_id=v.message_id AND d.revision=v.revision)`,
    ).all() as Array<{ message_id: string; revision: number }>;
    for (const row of stale) this.decideQualification({ messageId: row.message_id, revision: row.revision }, 'abandoned');
    // P2：不做 processing→pending 复活。已决定修订的残余在决定时已收口。
    this.timer = setInterval(() => this.wake(), 30_000);
    this.timer.unref?.();
    this.wake();
  }

  wake(): void {
    const signal = this.shutdown?.signal;
    if (!signal || signal.aborted || !this.worker) return;
    this.requested = true;
    if (this.work) return;
    this.work = (async () => {
      do {
        this.requested = false;
        if (this.worker!.hearing) await this.runPending(this.worker!.hearing, 5, signal);
        if (!signal.aborted && this.worker!.archiveClient) {
          await this.syncPendingAttachments(this.worker!.archiveClient, this.worker!.streamId, 5, signal);
        }
      } while (this.requested && !signal.aborted);
    })().catch((error: unknown) => {
      this.worker?.logger?.warn('voice_observation_tick_failed', { code: error instanceof Error ? error.name : 'UNKNOWN_ERROR' });
    }).finally(() => { this.work = null; });
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.shutdown?.abort();
    // 有界等待：在途的外部分析调用（O HTTP）无法同步打断——shutdown 已要求循环退出，
    // 2 秒后不再等（宿主关停不被单个慢请求拖住；未落库的结果按资格语义自然丢弃）
    await Promise.race([this.work ?? Promise.resolve(), new Promise<void>((r) => { const t = setTimeout(r, 2000); t.unref?.(); })]);
  }

  /** 该修订是否已有资格决定（delivered/abandoned）。 */
  decided(messageId: string, revision: number): { decision: 'delivered' | 'abandoned' } | null {
    const row = this.db.prepare('SELECT decision FROM voice_observation_decisions WHERE message_id=? AND revision=?').get(messageId, revision) as { decision: 'delivered' | 'abandoned' } | undefined;
    return row ?? null;
  }

  /** 资格终结（唯一入口，幂等）：冻结未终态行为 closed，取消在途 O 分析。
   *  delivered 由 commitProjection 在投影冻结的同一点调用（主模型请求提交即关闭）；
   *  abandoned 用于轮次/草稿取消路径（消息编辑取代、派发前取消、轮停止、重启死轮）。
   *  RV01（复审 20261106）：SQL-only、不开自有事务——消息生命周期 inTransaction 在
   *  调用方事务内同步调用（合同禁嵌套事务）；决定行本身是权威，行内状态更新为从属投影。 */
  decideQualification(binding: { messageId: string; revision: number }, decision: 'delivered' | 'abandoned', meta: { turnId?: string | null; requestId?: string | null } = {}): void {
    const toCancel: string[] = [];
    const res = this.db.prepare(
      'INSERT OR IGNORE INTO voice_observation_decisions(message_id, revision, decision, turn_id, request_id, decided_at) VALUES (?,?,?,?,?,?)',
    ).run(binding.messageId, binding.revision, decision, meta.turnId ?? null, meta.requestId ?? null, new Date().toISOString());
    if (res.changes === 0) return;
    const rows = this.db.prepare(
      "SELECT id, analysis_id FROM voice_observations WHERE message_id=? AND revision=? AND status IN ('pending','processing')",
    ).all(binding.messageId, binding.revision) as Array<{ id: string; analysis_id: string | null }>;
    for (const row of rows) {
      if (row.analysis_id) toCancel.push(row.analysis_id);
      // 表 CHECK 无 closed 值：以 failed + 专属错误码承载"资格终结、无结果"（UI 如实显示未取得）
      this.db.prepare("UPDATE voice_observations SET status='failed', error_code='QUALIFICATION_CLOSED', updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
    }
    // RV2（复审 20261106 第二轮）：网络取消经微任务出队——本方法会被消息生命周期的
    // inTransaction 钩子在调用方事务内同步调用，DB 决定与外部取消边界分开（事务提交后
    // 才发起 fetch），取消失败/未确认仍按 cancelInFlight 如实记录。
    for (const analysisId of toCancel) queueMicrotask(() => this.cancelInFlight(analysisId));
  }

  private cancelInFlight(analysisId: string): void {
    const cancel = this.worker?.cancelAnalysis;
    if (!cancel) return;
    void cancel(analysisId).then((outcome) => {
      // RV01：取消未确认时如实记录（analysis 关联已落行）——O 侧可能仍在跑，
      // 消费面已由资格门挡住；不吞成"已取消"，也不重新分析。
      if (!outcome.cancelled) this.worker?.logger?.warn('voice_observation_cancel_unconfirmed', { analysis_id: analysisId, status: outcome.status });
    }).catch((err: unknown) => {
      this.worker?.logger?.warn('voice_observation_cancel_failed', { code: err instanceof Error ? err.name : 'UNKNOWN_ERROR' });
    });
  }

  ensureForMessage(messageId: string, revision: number, _conversationId: string, oidoConfigured: boolean): void {
    // 普通电话不建自动分析；深听电话在接纳后登记其快观察结果。
    if (this.db.prepare("SELECT 1 FROM messages WHERE id=? AND client_message_id LIKE 'voice:%'").get(messageId)) return;
    const attachments = this.db.prepare(
      "SELECT asset_id FROM message_attachments WHERE message_id=? AND revision=? AND presentation='voice' ORDER BY position",
    ).all(messageId, revision) as Array<{ asset_id: string }>;
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      "INSERT INTO voice_observations(id,message_id,revision,asset_id,direction,status,created_at,updated_at) VALUES (?,?,?,?,'user',?,?,?) ON CONFLICT(message_id,revision,asset_id) DO NOTHING",
    );
    for (const attachment of attachments) insert.run(genId('vobs'), messageId, revision, attachment.asset_id, oidoConfigured ? 'pending' : 'unsupported', now, now);
  }

  /** view 已经过 oído 的标准投影校验；此处不再用 ready 布尔丢掉 partial/票据。 */
  recordCallTurnObservation(messageId: string, revision: number, assetId: string, view: Record<string, unknown> | null): void {
    const now = new Date().toISOString();
    const id = genId('vobs');
    this.db.prepare(
      "INSERT INTO voice_observations(id,message_id,revision,asset_id,direction,status,created_at,updated_at) VALUES (?,?,?,?,'user','pending',?,?) ON CONFLICT(message_id,revision,asset_id) DO NOTHING",
    ).run(id, messageId, revision, assetId, now, now);
    const row = this.db.prepare('SELECT id FROM voice_observations WHERE message_id=? AND revision=? AND asset_id=?').get(messageId, revision, assetId) as { id: string };
    if (view) {
      this.storeView(row.id, view);
      const source = this.db.prepare('SELECT m.conversation_id,a.content_sha256 FROM messages m JOIN media_assets a ON a.id=? WHERE m.id=?').get(assetId, messageId) as { conversation_id: string; content_sha256: string };
      new OidoSourceRepository(this.db).bindAnalysis(String(view.analysis_id), source.conversation_id, assetId, source.content_sha256);
    }
    this.wake();
  }

  /** §6.6 适用的目标＝聊天语音消息；P2 起 deep_listen 通话轮同样同轮收口（U04：深听通话
   *  按已接纳的正文话轮做同轮分析）。ordinary 通话不登记观察，天然无事可等。 */
  private awaitableMessage(messageId: string): boolean {
    const row = this.db.prepare('SELECT client_message_id FROM messages WHERE id=?').get(messageId) as { client_message_id: string | null } | undefined;
    if (row === undefined) return false;
    const cid = row.client_message_id ?? '';
    if (!cid.startsWith('voice:')) return true; // 聊天语音消息
    const callId = cid.slice('voice:'.length).split(':')[0] ?? '';
    const mode = this.db.prepare('SELECT analysis_mode FROM voice_calls WHERE call_id=?').get(callId) as { analysis_mode: string | null } | undefined;
    return mode?.analysis_mode === 'deep_listen';
  }

  /** 冻结前有界等待：当前输入的语音观察在准备预算内就绪即用；超时如实冻结"尚未就绪"。
   *  §6.6：不得把自动浮现的 300s 时限套到语音准备——本预算独立、只等已在途的分析。
   *  P2：deep_listen 通话轮与聊天语音同一语义（通话免等待豁免已移除）。 */
  async awaitReadyForDispatch(messageId: string, revision: number, budgetMs: number): Promise<void> {
    if (!this.awaitableMessage(messageId)) return;
    this.wake(); // 等待者确保被等待的分析确在驱动（丢醒防御，非重复分析——幂等键去重）
    const deadline = Date.now() + budgetMs;
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM voice_observations WHERE message_id=? AND revision=? AND status IN ('pending','processing')");
    while ((pending.get(messageId, revision) as {n:number}).n > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  snapshotsForRevision(messageId: string, revision: number, currentInput: boolean): VoiceObservationSnapshot[] {
    const rows = this.db.prepare(
      'SELECT id,asset_id,status,evidence_json,model_projection,projection_request_id FROM voice_observations WHERE message_id=? AND revision=? ORDER BY asset_id',
    ).all(messageId, revision) as Array<{ id: string; asset_id: string; status: string; evidence_json: string | null; model_projection: string | null; projection_request_id: string | null }>;
    const awaitable = this.awaitableMessage(messageId);
    return rows.flatMap((row): VoiceObservationSnapshot[] => {
      // 重试/轨迹恢复只使用已经冻结的投影；未用于首发的迟到观察不补写历史。
      if (row.projection_request_id !== null) {
        return row.model_projection ? [{ id: row.id, assetId: row.asset_id, text: row.model_projection, adopted: true }] : [];
      }
      if (!currentInput) return [];
      if (row.status === 'ready' || row.status === 'partial') {
        if (!row.evidence_json) return [];
        const text = observationInputBlock(row.asset_id, JSON.parse(row.evidence_json) as Record<string, unknown>);
        return [{ id: row.id, assetId: row.asset_id, text, adopted: true }];
      }
      if (awaitable && (row.status === 'pending' || row.status === 'processing')) {
        return [{ id: row.id, assetId: row.asset_id, text: OBSERVATION_NOT_READY_BLOCK, adopted: false }];
      }
      return [];
    });
  }

  commitProjection(binding: { messageId: string; revision: number }, turnId: string, requestId: string, used: readonly VoiceObservationSnapshot[]): void {
    const usedText = new Map(used.map(snapshot => [snapshot.id, snapshot.text]));
    // RV2-01：采纳事实按快照逐行落定——只有真实分析证据（adopted=true）才算本轮采纳；
    // "尚未就绪"占位随输入发出但**不采纳**该分析（迟到结果不得再被消费面读取）。
    const usedAdopted = new Map(used.map(snapshot => [snapshot.id, snapshot.adopted]));
    const rows = this.db.prepare('SELECT id FROM voice_observations WHERE message_id=? AND revision=? AND projection_request_id IS NULL').all(binding.messageId, binding.revision) as Array<{ id: string }>;
    const now = new Date().toISOString();
    const update = this.db.prepare('UPDATE voice_observations SET projection_request_id=?,model_projection=?,dispatched_turn_id=?,dispatched_at=?,analysis_adopted=? WHERE id=? AND projection_request_id IS NULL');
    tx(this.db, () => {
      for (const row of rows) {
        const text = usedText.get(row.id) ?? null;
        update.run(requestId, text, text ? turnId : null, text ? now : null, usedAdopted.get(row.id) === true ? 1 : 0, row.id);
      }
    });
    // P2：投影冻结＝主模型请求提交——同一时刻终结该修订资格并取消在途分析
    this.decideQualification(binding, 'delivered', { turnId, requestId });
  }

  /** 每跳只处理一批；只驱动**尚无资格决定**的修订；同一 analysis 续查不重新发分析。
   *  创建阶段失败（analysis_id 为空）＝终态 failed——不按定时重新发起同一深听。 */
  async runPending(hearing: Hearing, maxRows = 5, signal?: AbortSignal): Promise<void> {
    const rows = this.db.prepare(
      `SELECT v.id,v.asset_id,v.analysis_id,v.message_id,v.revision,m.conversation_id FROM voice_observations v
       JOIN messages m ON m.id=v.message_id
       WHERE v.status IN ('pending','processing')
         AND NOT EXISTS (SELECT 1 FROM voice_observation_decisions d WHERE d.message_id=v.message_id AND d.revision=v.revision)
       ORDER BY v.updated_at,v.id LIMIT ?`,
    ).all(maxRows) as Array<{ id: string; asset_id: string; analysis_id: string | null; message_id: string; revision: number; conversation_id: string }>;
    for (const row of rows) {
      if (signal?.aborted) break;
      this.db.prepare("UPDATE voice_observations SET status='processing',updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
      const ctx: ToolExecContext = {
        roomId: row.conversation_id, windowId: 'observation', turnId: null, purpose: 'chat',
        activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: 'obs:' + row.id, toolCallId: row.id, signal,
      };
      try {
        const result = row.analysis_id
          ? await hearing.getEvidence({ analysis_id: row.analysis_id }, ctx)
          : await hearing.analyzeVoice({ audio_ref: 'est:' + row.asset_id }, ctx);
        if (signal?.aborted) break; // P2：不回写 pending——资格未决时 processing 行由下一跳续查
        if (result.ok) this.storeView(row.id, result.value.view);
        else this.storeFailure(row.id, row.analysis_id, String(result.error.error_code ?? 'ANALYSIS_FAILED'));
      } catch (error) {
        if (signal?.aborted) break;
        this.storeFailure(row.id, row.analysis_id, error instanceof Error ? error.name : 'ANALYSIS_FAILED');
      }
    }
  }

  private storeView(id: string, view: Record<string, unknown>): void {
    const owner = this.db.prepare('SELECT message_id, revision FROM voice_observations WHERE id=?').get(id) as { message_id: string; revision: number } | undefined;
    const decided = owner ? this.decided(owner.message_id, owner.revision) : null;
    const analysisId = typeof view.analysis_id === 'string' && view.analysis_id.length > 0 ? view.analysis_id : null;
    if (decided) {
      // P2（U03）：资格已终结的修订丢弃迟到结果——不写可消费成功；
      // RV01（复审 20261106）：迟到 analysis_id 仍归入同一已知操作——落行保留关联并补发
      // O cancel（衔接既有 fence），不因第一次决定时 ID 为空失去取消责任。
      if (analysisId) {
        this.db.prepare('UPDATE voice_observations SET analysis_id=?, updated_at=? WHERE id=?').run(analysisId, new Date().toISOString(), id);
        void this.cancelInFlight(analysisId);
      }
      return;
    }
    const state = view.state === 'ready' ? 'ready' : view.state === 'partial' ? 'partial' : 'pending';
    const complete = state !== 'pending';
    this.db.prepare(
      'UPDATE voice_observations SET status=?,display_text=?,evidence_json=?,analysis_id=COALESCE(?,analysis_id),error_code=NULL,updated_at=? WHERE id=?',
    ).run(state, complete ? extractBriefObservation(view) : null, complete ? JSON.stringify(view) : null, analysisId, new Date().toISOString(), id);
  }

  private storeFailure(id: string, analysisId: string | null, code: string): void {
    // P2：只有“同一 analysis 仍在途”（OIDO_NOT_READY）允许续查到资格终结为止；
    // 其余错误（创建失败/5xx/不可达）＝终态 failed——不无限 pending、不重新发起。
    const retry = analysisId !== null && code === 'OIDO_NOT_READY';
    this.db.prepare('UPDATE voice_observations SET status=?,error_code=?,updated_at=? WHERE id=?')
      .run(retry ? 'pending' : 'failed', code.slice(0, 64), new Date().toISOString(), id);
  }

  async syncPendingAttachments(client: AttachmentsSyncClient, streamId: string, maxRows = 5, signal?: AbortSignal): Promise<void> {
    // P2 + RV2-01：只同步资格终结前成立且**被本轮采纳**（analysis_adopted）的事实——
    // 被丢弃轮（delivered 未采纳/abandoned）的 ready/failed 行不补交。
    const rows = this.db.prepare(
      "SELECT v.id,v.message_id,v.revision,v.direction,v.display_text,v.analysis_id FROM voice_observations v JOIN source_sync_receipts r ON r.origin_message_id=v.message_id AND r.revision=v.revision WHERE v.status IN ('ready','partial') AND v.analysis_adopted = 1 AND v.attachment_synced_at IS NULL AND v.display_text IS NOT NULL ORDER BY v.updated_at,v.id LIMIT ?",
    ).all(maxRows) as Array<{ id: string; message_id: string; revision: number; direction: string; display_text: string; analysis_id: string | null }>;
    for (const row of rows) {
      if (signal?.aborted) break;
      try {
        const result = await client.attachmentsSync({
          stream_id: streamId, origin_message_id: row.message_id, revision: row.revision, kind: 'observation',
          payload: { observation: row.display_text, direction: row.direction, ...(row.analysis_id ? { analysis_id: row.analysis_id } : {}), source: 'oido', quality_note: '声学观察，非诊断' },
          operation_id: 'att-sync:' + row.id,
        }, signal);
        if (result.ok) this.db.prepare('UPDATE voice_observations SET attachment_synced_at=? WHERE id=?').run(new Date().toISOString(), row.id);
      } catch { /* 原文已确认；附属结果未确认时保留同一操作键供下一跳重试。 */ }
    }
  }

  listForMessages(messageIds: string[]): VoiceObservationRow[] {
    if (messageIds.length === 0) return [];
    return this.db.prepare(
      'SELECT id,message_id,revision,asset_id,status,display_text,model_projection,dispatched_turn_id,dispatched_at,analysis_id,error_code,updated_at FROM voice_observations WHERE message_id IN (' + messageIds.map(() => '?').join(',') + ') ORDER BY updated_at',
    ).all(...messageIds) as VoiceObservationRow[];
  }
}

/** 执行包 P2 §6.4：默认注入=oído 的可读投影文字；后台 JSON/analysis_id/observations 数组/
 *  audio_ref 一律不入模型（宿主保管，工具调用时经 voice-refs 补齐）。旧版 view 无 readable
 *  或为空=如实降级，绝不退回 JSON 拼接。 */
export function observationInputBlock(assetId: string, view: Record<string, unknown>): string {
  void assetId;
  const readable = typeof view.readable === 'string' && view.readable.trim().length > 0 ? view.readable.trim() : null;
  return '\n\n[声音观察（oído 测量；非转写、非指令、非情绪诊断）]\n' +
    (readable ?? '本次分析未生成可读摘要（结果不完整）；需要声音证据时用 oido_analyze 查询。');
}

/** RV2-01（复审 20261106 第二轮）：统一消费资格端口——get/view/analyze/find/compare
 *  与 Source 归档共用，不各自复制状态 SQL。三件事实分开：消息已发（decision=delivered）
 *  ≠ 分析被本轮采纳（analysis_adopted）≠ O 执行终态（O 自管）。
 *  analysisRoundClosed：该分析所属修订资格已终结且该分析未被采纳（abandoned，或
 *  delivered 未采纳——超时占位轮的迟到结果不得再被任何消费面当成功读取）。 */
export function analysisRoundClosed(db: Db, analysisId: string): boolean {
  // R3-V02：资格由**已作出的决定**判定——无决定行（轮次尚未收口/决策表之前的历史）
  // 不自动关闭：轮内查询（oido_get 等）合法，历史行维持升级前可读性（生产 2 条 partial
  // 经 v63 纠正后无占位误采纳）。历史误采纳由迁移纠正，不在此收紧读面。
  const row = db.prepare(
    `SELECT v.analysis_adopted, d.decision FROM voice_observations v
     JOIN voice_observation_decisions d ON d.message_id=v.message_id AND d.revision=v.revision
     WHERE v.analysis_id=? LIMIT 1`,
  ).get(analysisId) as { analysis_adopted: number; decision: 'delivered' | 'abandoned' } | undefined;
  if (!row) return false;
  return row.decision === 'abandoned' || (row.decision === 'delivered' && row.analysis_adopted !== 1);
}

/** RV2-01：音频级消费资格（find/compare 源搜索用）——该资产的全部自动分析轮都已
 *  终结且未被采纳（被丢弃的分析不能经源搜索复活）；无观察轮（模型显式新分析等）
 *  不拦。 */
export function audioAnalysesAllDiscarded(db: Db, assetId: string): boolean {
  const rows = db.prepare(
    `SELECT v.analysis_adopted, d.decision FROM voice_observations v
     LEFT JOIN voice_observation_decisions d ON d.message_id=v.message_id AND d.revision=v.revision
     WHERE v.asset_id=? AND v.analysis_id IS NOT NULL`,
  ).all(assetId) as Array<{ analysis_adopted: number; decision: 'delivered' | 'abandoned' | null }>;
  if (rows.length === 0) return false;
  return rows.every(row => row.decision !== null && (row.decision === 'abandoned' || row.analysis_adopted !== 1));
}

/** §6.6：转写已发而观察在准备期限内未就绪——如实短行，随首次派发一并冻结。
 *  RV2-01：未就绪＝本轮不带该分析（未采纳）；被丢弃的分析不得再被补查消费。 */
export const OBSERVATION_NOT_READY_BLOCK = '\n\n[声音观察（oído 测量）]\n尚未就绪，本条不含声音观察；该轮未采用此分析，不要针对本条补查。';

export function extractBriefObservation(view: Record<string, unknown> | null): string | null {
  if (!view || !Array.isArray(view.observations) || view.observations.length === 0) return null;
  const first = view.observations[0] as Record<string, unknown>;
  const value = first.value == null ? String(first.reason ?? '不可用') : String(first.value) + (first.unit ? ' ' + String(first.unit) : '');
  return (String(first.kind ?? '观察') + '：' + value + '（供参考，非诊断）').slice(0, 120);
}
