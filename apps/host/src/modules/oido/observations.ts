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
type WorkerDeps = { hearing: Hearing | null; archiveClient: AttachmentsSyncClient | null; streamId: string; logger?: Logger };

export type VoiceObservationStatus = 'pending' | 'processing' | 'ready' | 'partial' | 'failed' | 'unsupported';
export type VoiceObservationRow = {
  id: string; message_id: string; revision: number; asset_id: string;
  status: VoiceObservationStatus; display_text: string | null; model_projection: string | null;
  dispatched_turn_id: string | null; dispatched_at: string | null;
  analysis_id: string | null; error_code: string | null; updated_at: string;
};
export type VoiceObservationSnapshot = { id: string; assetId: string; text: string };

/** 分析事实可晚到；首次实际请求的输入投影一旦决定，就不被后台结果改写。 */
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
    this.db.prepare("UPDATE voice_observations SET status='pending' WHERE status='processing'").run();
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
    await this.work;
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

  /** A04（联合审计 2026-10-27）：deep_listen 的正式助手回复音频——assistant 方向独立分析。
   *  显式标记 assistant：结果不得当用户情绪；无视图注入（分析由 worker 持久任务完成，
   *  不作为任何后续轮的前置输入）。 */
  registerAssistantObservation(messageId: string, revision: number, assetId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO voice_observations(id,message_id,revision,asset_id,direction,status,created_at,updated_at) VALUES (?,?,?,?,'assistant','pending',?,?) ON CONFLICT(message_id,revision,asset_id) DO NOTHING",
    ).run(genId('vobs'), messageId, revision, assetId, now, now);
  }

  /** §6.6 适用的目标=聊天语音消息（client_message_id 非 voice:% 前缀；通话消息按 A06
   *  机会观察语义：不等待、不注入、迟到只入 sidecar）。 */
  private chatVoiceMessage(messageId: string): boolean {
    const row = this.db.prepare('SELECT client_message_id FROM messages WHERE id=?').get(messageId) as { client_message_id: string | null } | undefined;
    return row !== undefined && !(row.client_message_id ?? '').startsWith('voice:');
  }

  /** 冻结前有界等待：当前输入的聊天语音观察在准备预算内就绪即用；超时如实冻结"尚未就绪"。
   *  §6.6：不得把自动浮现的 300s 时限套到语音准备——本预算独立、只等已在途的分析。
   *  通话消息（voice:%）豁免——A06 机会观察语义：派发不等观察、迟到只入 sidecar。 */
  async awaitReadyForDispatch(messageId: string, revision: number, budgetMs: number): Promise<void> {
    if (!this.chatVoiceMessage(messageId)) return;
    this.wake(); // 等待者确保被等待的分析确在驱动（丢醒防御，非重复分析——幂等键去重）
    const deadline = Date.now() + budgetMs;
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM voice_observations WHERE message_id=? AND revision=? AND status IN ('pending','processing')");
    while (pending.get(messageId, revision).n > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  snapshotsForRevision(messageId: string, revision: number, currentInput: boolean): VoiceObservationSnapshot[] {
    const rows = this.db.prepare(
      'SELECT id,asset_id,status,evidence_json,model_projection,projection_request_id FROM voice_observations WHERE message_id=? AND revision=? ORDER BY asset_id',
    ).all(messageId, revision) as Array<{ id: string; asset_id: string; status: string; evidence_json: string | null; model_projection: string | null; projection_request_id: string | null }>;
    const chatVoice = this.chatVoiceMessage(messageId);
    return rows.flatMap(row => {
      // 重试/轨迹恢复只使用已经冻结的投影；未用于首发的迟到观察不补写历史。
      if (row.projection_request_id !== null) {
        return row.model_projection ? [{ id: row.id, assetId: row.asset_id, text: row.model_projection }] : [];
      }
      if (!currentInput) return [];
      if (row.status === 'ready' || row.status === 'partial') {
        if (!row.evidence_json) return [];
        const text = observationInputBlock(row.asset_id, JSON.parse(row.evidence_json) as Record<string, unknown>);
        return [{ id: row.id, assetId: row.asset_id, text }];
      }
      if (chatVoice && (row.status === 'pending' || row.status === 'processing')) {
        return [{ id: row.id, assetId: row.asset_id, text: OBSERVATION_NOT_READY_BLOCK }];
      }
      return [];
    });
  }

  commitProjection(binding: { messageId: string; revision: number }, turnId: string, requestId: string, used: readonly VoiceObservationSnapshot[]): void {
    const usedText = new Map(used.map(snapshot => [snapshot.id, snapshot.text]));
    const rows = this.db.prepare('SELECT id FROM voice_observations WHERE message_id=? AND revision=? AND projection_request_id IS NULL').all(binding.messageId, binding.revision) as Array<{ id: string }>;
    const now = new Date().toISOString();
    const update = this.db.prepare('UPDATE voice_observations SET projection_request_id=?,model_projection=?,dispatched_turn_id=?,dispatched_at=? WHERE id=? AND projection_request_id IS NULL');
    tx(this.db, () => {
      for (const row of rows) {
        const text = usedText.get(row.id) ?? null;
        update.run(requestId, text, text ? turnId : null, text ? now : null, row.id);
      }
    });
  }

  /** 每跳只处理一批；未完成票据下一跳续查同一 analysis，不重新发分析。 */
  async runPending(hearing: Hearing, maxRows = 5, signal?: AbortSignal): Promise<void> {
    const rows = this.db.prepare(
      "SELECT v.id,v.asset_id,v.analysis_id,m.conversation_id FROM voice_observations v JOIN messages m ON m.id=v.message_id WHERE v.status='pending' ORDER BY v.updated_at,v.id LIMIT ?",
    ).all(maxRows) as Array<{ id: string; asset_id: string; analysis_id: string | null; conversation_id: string }>;
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
        if (signal?.aborted) {
          this.db.prepare("UPDATE voice_observations SET status='pending' WHERE id=?").run(row.id);
          break;
        }
        if (result.ok) this.storeView(row.id, result.value.view);
        else this.storeFailure(row.id, String(result.error.error_code ?? 'ANALYSIS_FAILED'));
      } catch (error) {
        if (signal?.aborted) {
          this.db.prepare("UPDATE voice_observations SET status='pending' WHERE id=?").run(row.id);
          break;
        }
        this.storeFailure(row.id, error instanceof Error ? error.name : 'ANALYSIS_FAILED');
      }
    }
  }

  private storeView(id: string, view: Record<string, unknown>): void {
    const state = view.state === 'ready' ? 'ready' : view.state === 'partial' ? 'partial' : 'pending';
    const complete = state !== 'pending';
    this.db.prepare(
      'UPDATE voice_observations SET status=?,display_text=?,evidence_json=?,analysis_id=COALESCE(?,analysis_id),error_code=NULL,updated_at=? WHERE id=?',
    ).run(state, complete ? extractBriefObservation(view) : null, complete ? JSON.stringify(view) : null, String(view.analysis_id), new Date().toISOString(), id);
  }

  private storeFailure(id: string, code: string): void {
    // OIDO_NOT_READY=同一 analysis 仍在途：保持 pending，下一跳续查同 ID（不重新 analyze）。
    const pending = code === 'OIDO_UNAVAILABLE' || code === 'OIDO_NOT_READY' || /^OIDO_(GET|ANALYZE)_5/.test(code);
    this.db.prepare('UPDATE voice_observations SET status=?,error_code=?,updated_at=? WHERE id=?')
      .run(pending ? 'pending' : 'failed', code.slice(0, 64), new Date().toISOString(), id);
  }

  async syncPendingAttachments(client: AttachmentsSyncClient, streamId: string, maxRows = 5, signal?: AbortSignal): Promise<void> {
    const rows = this.db.prepare(
      "SELECT v.id,v.message_id,v.revision,v.direction,v.display_text,v.analysis_id FROM voice_observations v JOIN source_sync_receipts r ON r.origin_message_id=v.message_id AND r.revision=v.revision WHERE v.status IN ('ready','partial') AND v.attachment_synced_at IS NULL AND v.display_text IS NOT NULL ORDER BY v.updated_at,v.id LIMIT ?",
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

/** §6.6：转写已发而观察在准备期限内未就绪——如实短行，随首次派发一并冻结；迟到分析不回写。 */
export const OBSERVATION_NOT_READY_BLOCK = '\n\n[声音观察（oído 测量）]\n尚未就绪，本条先不含声音观察；需要时稍后用 oido_analyze 查询。';

export function extractBriefObservation(view: Record<string, unknown> | null): string | null {
  if (!view || !Array.isArray(view.observations) || view.observations.length === 0) return null;
  const first = view.observations[0] as Record<string, unknown>;
  const value = first.value == null ? String(first.reason ?? '不可用') : String(first.value) + (first.unit ? ' ' + String(first.unit) : '');
  return (String(first.kind ?? '观察') + '：' + value + '（供参考，非诊断）').slice(0, 120);
}
