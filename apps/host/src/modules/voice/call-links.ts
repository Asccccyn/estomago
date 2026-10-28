// modules/voice/call-links.ts（联合审计 A04，2026-10-27）：通话回复媒体持久关联。
// Siren 持有回复 WAV、完整/部分状态与播放事实（正本）；est 按真实 turn UUID 拉取
// （既有 /v1/calls/:id/turn-audio 读取面），为已发布助手消息建立唯一持久绑定：
//   voice_reply_links 行（交付状态正本） + message_attachments 附件行（既有消费者：
//   records 聚合/归档资产引用/oído 源授权） + 深听 assistant 观察 + source.attachments.sync
//   （media/call/observation 附属补同步到 Source）。
// 时机：完成/挂断/定时 wake 触发，拉取幂等收敛于 (call_id, turn_key)；Siren 不可达不动
// 本地状态下一跳重试；已结束通话 404=如实 unavailable，不猜音频。不复制 Siren 决策，
// 不为挂附件伪造"他已说过"的消息——只绑定 turns 表里真实存在的助手消息。
import type { Db } from '../../db/connection.ts';
import type { SirenAdapter } from '../../integrations/siren/adapter.ts';
import type { VoiceObservationService } from '../oido/observations.ts';

type MediaDeps = {
  saveBuffer(b: { bytes: Uint8Array; purpose: 'chat_voice'; operationId: string; createdBy: string; origin: 'import' | 'upload' | 'generated' | 'service'; originService?: string | null; originRef?: string | null }): Promise<{ id: string; content_sha256: string }>;
  validateForSend(a: Array<{ asset_id: string; presentation: string }>): void;
};
type AttachmentsSyncClient = {
  attachmentsSync(args: { stream_id: string; origin_message_id: string; revision: number; kind: 'media' | 'call' | 'observation'; payload: Record<string, unknown>; operation_id: string }, signal?: AbortSignal): Promise<{ ok: boolean }>;
};

export type CallReplyLinkDeps = {
  db: Db;
  sirenCall: SirenAdapter | null;
  media: MediaDeps | null;
  voiceObservations: VoiceObservationService | null;
  attachmentsClient: AttachmentsSyncClient | null;
  streamId: string;
  logger?: { warn(code: string, fields?: Record<string, unknown>): void; info(code: string, fields?: Record<string, unknown>): void };
};

export class CallReplyLinkService {
  private readonly deps: CallReplyLinkDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private shutdown: AbortController | null = null;
  private work: Promise<void> | null = null;
  private requested = false;
  constructor(deps: CallReplyLinkDeps) { this.deps = deps; }

  start(): void {
    if (this.shutdown || !this.deps.sirenCall) return;
    this.shutdown = new AbortController();
    this.timer = setInterval(() => this.wake(), 30_000);
    this.timer.unref?.();
    this.wake();
  }

  /** 完成话轮/挂断/对账周期触发；单飞合并重复触发，不做实时关键路径。
   *  返回在途工作 Promise（调用方可等待收敛；普通触发无需等待）。 */
  wake(): Promise<void> {
    const signal = this.shutdown?.signal;
    if (!signal || signal.aborted) return Promise.resolve();
    this.requested = true;
    if (this.work) return this.work;
    this.work = (async () => {
      do {
        this.requested = false;
        if (!signal.aborted) await this.pullPending(signal);
        if (!signal.aborted) await this.registerAssistantObservations();
        if (!signal.aborted) await this.syncPendingToSource(signal);
      } while (this.requested && !signal.aborted);
    })().catch((error: unknown) => {
      this.deps.logger?.warn('call_reply_link_tick_failed', { code: error instanceof Error ? error.name : 'UNKNOWN_ERROR' });
    }).finally(() => { this.work = null; });
    return this.work;
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.shutdown?.abort();
    await this.work;
  }

  /** 已发布助手消息的终态话轮（含打断后的部分回复）：每跳最多 3 通。 */
  private async pullPending(signal: AbortSignal): Promise<void> {
    const { db, sirenCall } = this.deps;
    if (!sirenCall) return;
    const calls = db.prepare(
      `SELECT vc.call_id FROM voice_calls vc
       WHERE EXISTS (
         SELECT 1 FROM voice_stream_turns vst WHERE vst.call_id = vc.call_id AND vst.state IN ('completed','cancelled','failed')
           AND EXISTS (SELECT 1 FROM messages m WHERE m.turn_id=vst.est_turn_id AND m.speaker='assistant')
           AND NOT EXISTS (
             SELECT 1 FROM voice_reply_links l WHERE l.call_id = vst.call_id AND l.turn_key = vst.turn_key
               AND (l.link_state = 'unavailable'
                    OR (l.link_state = 'linked' AND l.est_asset_id IS NOT NULL
                        AND EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.message_id=l.message_id
                          AND ma.revision=l.revision AND ma.asset_id=l.est_asset_id AND ma.presentation='voice')
                        AND (COALESCE(json_extract(l.playback_json,'$.basis'),'unknown') != 'unknown'
                        OR vc.state != 'active')))
           )
       ) ORDER BY vc.started_at DESC LIMIT 3`,
    ).all() as Array<{ call_id: string }>;
    for (const call of calls) {
      if (signal.aborted) break;
      let snapshot: Awaited<ReturnType<SirenAdapter['callTurnAudio']>>;
      try {
        snapshot = await sirenCall.callTurnAudio(call.call_id, { signal });
      } catch {
        continue; // Siren 不可达/结果不明：不动本地状态，下一跳重试
      }
      if (signal.aborted) break;
      const admissions = db.prepare(
        `SELECT turn_key, est_turn_id FROM voice_stream_turns vst WHERE call_id=? AND state IN ('completed','cancelled','failed')
         AND EXISTS (SELECT 1 FROM messages m WHERE m.turn_id=vst.est_turn_id AND m.speaker='assistant') ORDER BY created_at`,
      ).all(call.call_id) as Array<{ turn_key: string; est_turn_id: string | null }>;
      const byId = new Map(snapshot && snapshot !== 'not_found' ? snapshot.turns.map((t) => [t.turn_id, t]) : []);
      for (const admission of admissions) {
        if (signal.aborted) break;
        const existing = db.prepare(`SELECT link_state, est_asset_id, playback_json,
          EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.message_id=l.message_id
            AND ma.revision=l.revision AND ma.asset_id=l.est_asset_id AND ma.presentation='voice') AS has_attachment
          FROM voice_reply_links l WHERE call_id=? AND turn_key=?`)
          .get(call.call_id, admission.turn_key) as { link_state: string; est_asset_id: string | null; playback_json: string | null; has_attachment: number } | undefined;
        const media = byId.get(admission.turn_key);
        const reply = media?.reply_audio ?? null;
        if (existing?.link_state === 'linked' && existing.est_asset_id && existing.has_attachment) {
          // 已链接：播放事实可晚到演进（unknown→drained/reported）——basis 变了才重收敛，
          // 同 basis 不重复拉字节/重复同步
          if (media && reply) {
            const storedBasis = existing.playback_json ? String((JSON.parse(existing.playback_json) as { basis?: unknown }).basis ?? 'unknown') : 'unknown';
            if (media.playback.basis !== storedBasis) {
              await this.linkReply(call.call_id, admission, media.turn_id, reply, media.sent_audio_ms, media.playback, media.filler_audio_ms, media.outcome, existing.est_asset_id);
            }
          }
          continue;
        }
        if (media && reply) {
          await this.linkReply(call.call_id, admission, media.turn_id, reply, media.sent_audio_ms, media.playback, media.filler_audio_ms, media.outcome, existing?.est_asset_id ?? null);
        } else if (snapshot === 'not_found') {
          // 通话在 Siren 已不存在（结束后的 404）：如实 unavailable，不猜音频
          this.markUnavailable(call.call_id, admission.turn_key, admission.est_turn_id, 'siren_call_not_found');
        } else if (snapshot?.audio_finalized) {
          // 只有 Siren 的音频收尾完成才证明不会再出现资产；est ended 只是通话投影。
          this.markUnavailable(call.call_id, admission.turn_key, admission.est_turn_id, media ? 'no_reply_audio' : 'siren_turn_missing');
        } // 尚未收尾：保留资格，下一跳读取同一话轮，不重新合成。
      }
    }
  }

  private async linkReply(
    callId: string,
    admission: { turn_key: string; est_turn_id: string | null },
    sirenTurnId: string,
    reply: { asset_id: string; duration_ms: number; completeness: 'complete' | 'partial' | null },
    sentAudioMs: number | null,
    playback: Record<string, unknown>,
    fillerAudioMs: number | null,
    outcome: string | null,
    existingEstAssetId: string | null = null,
  ): Promise<void> {
    const { db } = this.deps;
    const now = new Date().toISOString();
    const conv = db.prepare('SELECT conversation_id FROM voice_stream_turns WHERE call_id=? AND turn_key=?').get(callId, admission.turn_key) as { conversation_id: string } | undefined;
    if (!conv) return;
    // 精确身份绑定：本轮 est turn 的正式助手消息（interrupted/completed 都经同一轮发布）
    const msg = admission.est_turn_id
      ? db.prepare("SELECT id, current_revision FROM messages WHERE turn_id=? AND speaker='assistant' ORDER BY sequence DESC LIMIT 1")
          .get(admission.est_turn_id) as { id: string; current_revision: number } | undefined
      : undefined;
    let estAssetId: string | null = existingEstAssetId;
    const mediaDeps = this.deps.media;
    if (!estAssetId && mediaDeps && this.deps.sirenCall) {
      try {
        // 字节导入幂等：同操作键=同一 est 资产（不重复保存/不重取 Siren 字节）
        const audio = await this.deps.sirenCall.fetchVoiceAssetAudio(reply.asset_id, { timeoutMs: 15000 });
        if (audio && !this.shutdown?.signal.aborted) {
          const saved = await mediaDeps.saveBuffer({
            bytes: audio.bytes, purpose: 'chat_voice',
            operationId: `siren-call-reply:${callId}:${admission.turn_key}`,
            createdBy: 'siren-bridge', origin: 'import', originService: 'siren', originRef: reply.asset_id,
          });
          estAssetId = saved.id;
        }
      } catch (error) {
        this.deps.logger?.warn('call_reply_import_failed', { call_id: callId, turn_key: admission.turn_key, code: error instanceof Error ? error.name : 'UNKNOWN_ERROR' });
      }
    }
    let linked = false;
    if (estAssetId && msg && mediaDeps) {
      try {
        mediaDeps.validateForSend([{ asset_id: estAssetId, presentation: 'voice' }]);
        // 附件行幂等：同资产不重复；已有其他 voice 附件则追加在后（位置键=PK）
        const existingAtt = db.prepare("SELECT asset_id, position FROM message_attachments WHERE message_id=? AND revision=? AND presentation='voice' ORDER BY position")
          .all(msg.id, msg.current_revision) as Array<{ asset_id: string; position: number }>;
        if (!existingAtt.some((a) => a.asset_id === estAssetId)) {
          const position = (existingAtt[existingAtt.length - 1]?.position ?? 0) + 1;
          db.prepare("INSERT INTO message_attachments(message_id,revision,position,asset_id,presentation,created_at) VALUES (?,?,?,?,'voice',?)")
            .run(msg.id, msg.current_revision, position, estAssetId, now);
        }
        linked = true;
      } catch (error) {
        // 保留已导入资产，下次只补附件；未绑定不能推进为 linked。
        this.deps.logger?.warn('call_reply_attachment_failed', { call_id: callId, turn_key: admission.turn_key, code: error instanceof Error ? error.name : 'UNKNOWN_ERROR' });
      }
    }
    db.prepare(
      `INSERT INTO voice_reply_links(call_id,turn_key,conversation_id,est_turn_id,message_id,revision,siren_turn_id,siren_asset_id,est_asset_id,completeness,sent_audio_ms,playback_json,link_state,observation_registered,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
       ON CONFLICT(call_id,turn_key) DO UPDATE SET
         message_id=COALESCE(excluded.message_id,voice_reply_links.message_id),
         revision=COALESCE(excluded.revision,voice_reply_links.revision),
         siren_turn_id=COALESCE(excluded.siren_turn_id,voice_reply_links.siren_turn_id),
         siren_asset_id=COALESCE(excluded.siren_asset_id,voice_reply_links.siren_asset_id),
         est_asset_id=COALESCE(excluded.est_asset_id,voice_reply_links.est_asset_id),
         completeness=COALESCE(excluded.completeness,voice_reply_links.completeness),
         sent_audio_ms=COALESCE(excluded.sent_audio_ms,voice_reply_links.sent_audio_ms),
         playback_json=excluded.playback_json,
         link_state=excluded.link_state, updated_at=excluded.updated_at`,
    ).run(callId, admission.turn_key, conv.conversation_id, admission.est_turn_id, msg?.id ?? null, msg?.current_revision ?? null,
      sirenTurnId, reply.asset_id, estAssetId, reply.completeness, sentAudioMs,
      JSON.stringify({ ...playback, ...(fillerAudioMs !== null ? { filler_audio_ms: fillerAudioMs } : {}), outcome }), linked ? 'linked' : 'pending', now, now);
    this.deps.logger?.info(linked ? 'call_reply_linked' : 'call_reply_link_pending', { call_id: callId, turn_key: admission.turn_key, message_id: msg?.id ?? null, est_asset_id: estAssetId, completeness: reply.completeness });
  }

  private markUnavailable(callId: string, turnKey: string, estTurnId: string | null, reason: string): void {
    const now = new Date().toISOString();
    this.deps.db.prepare(
      `INSERT INTO voice_reply_links(call_id,turn_key,conversation_id,est_turn_id,playback_json,link_state,observation_registered,created_at,updated_at)
       VALUES (?,?,?,?,?,'unavailable',0,?,?)
       ON CONFLICT(call_id,turn_key) DO UPDATE SET link_state='unavailable', playback_json=excluded.playback_json, updated_at=excluded.updated_at`,
    ).run(callId, turnKey, (this.deps.db.prepare('SELECT conversation_id FROM voice_stream_turns WHERE call_id=? AND turn_key=?').get(callId, turnKey) as { conversation_id: string } | undefined)?.conversation_id ?? '', estTurnId, JSON.stringify({ basis: 'unavailable', reason }), now, now);
  }

  /** B3-B.7：deep_listen 的正式助手回复音频登记 assistant 方向观察（普通电话 0 自动分析）。 */
  private async registerAssistantObservations(): Promise<void> {
    const { db, voiceObservations } = this.deps;
    if (!voiceObservations?.configured) return;
    const rows = db.prepare(
      `SELECT l.call_id, l.turn_key, l.message_id, l.revision, l.est_asset_id, vc.analysis_mode
       FROM voice_reply_links l JOIN voice_calls vc ON vc.call_id=l.call_id
       WHERE l.link_state='linked' AND l.observation_registered=0 AND l.est_asset_id IS NOT NULL
         AND l.message_id IS NOT NULL AND vc.analysis_mode='deep_listen' LIMIT 5`,
    ).all() as Array<{ call_id: string; turn_key: string; message_id: string; revision: number; est_asset_id: string }>;
    for (const row of rows) {
      voiceObservations.registerAssistantObservation(row.message_id, row.revision, row.est_asset_id);
      db.prepare('UPDATE voice_reply_links SET observation_registered=1, updated_at=? WHERE call_id=? AND turn_key=?')
        .run(new Date().toISOString(), row.call_id, row.turn_key);
    }
    if (rows.length > 0) voiceObservations.wake();
  }

  /** B3-B.9：已归档（有正式收据）且已绑定的回复链接补同步到 Source——media 一次（资产
   *  引用稳定），call 按播放事实 basis 演进各一次（unknown→drained/reported 是新事实）。
   *  操作键稳定幂等；失败保留未同步状态下一跳重试；原文与 hash 不经本路径改写。 */
  private async syncPendingToSource(signal: AbortSignal): Promise<void> {
    const { db, attachmentsClient, streamId } = this.deps;
    if (!attachmentsClient) return;
    const rows = db.prepare(
      `SELECT l.call_id, l.turn_key, l.message_id, l.revision, l.siren_asset_id, l.est_asset_id,
              l.completeness, l.sent_audio_ms, l.playback_json, l.source_media_synced_at, l.source_call_synced_basis
       FROM voice_reply_links l JOIN source_sync_receipts r ON r.origin_message_id=l.message_id AND r.revision=l.revision
       WHERE l.link_state='linked' AND l.message_id IS NOT NULL
         AND (l.source_media_synced_at IS NULL OR l.source_call_synced_basis IS NULL
              OR l.source_call_synced_basis != COALESCE(json_extract(l.playback_json,'$.basis'),'unknown'))
         LIMIT 5`,
    ).all() as Array<{ call_id: string; turn_key: string; message_id: string; revision: number; siren_asset_id: string; est_asset_id: string | null; completeness: string | null; sent_audio_ms: number | null; playback_json: string | null; source_media_synced_at: string | null; source_call_synced_basis: string | null }>;
    for (const row of rows) {
      if (signal.aborted) break;
      const playback = row.playback_json ? (JSON.parse(row.playback_json) as Record<string, unknown>) : { basis: 'unknown' };
      const basis = String(playback['basis'] ?? 'unknown');
      const now = new Date().toISOString();
      try {
        if (row.source_media_synced_at === null) {
          const media = await attachmentsClient.attachmentsSync({
            stream_id: streamId, origin_message_id: row.message_id, revision: row.revision, kind: 'media',
            payload: {
              asset_ref: row.est_asset_id ? `est:${row.est_asset_id}` : `siren:${row.siren_asset_id}`,
              ...(row.est_asset_id ? { origin_service_ref: `siren:${row.siren_asset_id}` } : {}),
              presentation: 'voice', direction: 'assistant', source: 'siren:call',
              ...(row.completeness ? { completeness: row.completeness } : {}),
            },
            operation_id: `att-sync:media:${row.call_id}:${row.turn_key}`,
          }, signal);
          if (!media.ok) continue; // 有界下一跳重试；正文已确认，附属未确认不冒充完成
          db.prepare('UPDATE voice_reply_links SET source_media_synced_at=? WHERE call_id=? AND turn_key=?').run(now, row.call_id, row.turn_key);
        }
        if (row.source_call_synced_basis !== basis) {
          const call = await attachmentsClient.attachmentsSync({
            stream_id: streamId, origin_message_id: row.message_id, revision: row.revision, kind: 'call',
            payload: {
              call_id: row.call_id, turn_key: row.turn_key, direction: 'assistant',
              ...(row.sent_audio_ms !== null ? { sent_audio_ms: row.sent_audio_ms } : {}),
              playback, source: 'siren:call',
            },
            operation_id: `att-sync:call:${row.call_id}:${row.turn_key}:${basis}`,
          }, signal);
          if (!call.ok) continue;
          db.prepare('UPDATE voice_reply_links SET source_call_synced_basis=? WHERE call_id=? AND turn_key=?').run(basis, row.call_id, row.turn_key);
        }
      } catch { /* 网络未知：保持未同步，下一跳同操作键重试 */ }
    }
  }
}
