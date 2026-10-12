// Verified against Siren 1.1.1 apps/server/src/routes/voice-message.ts.
// Only server-observed ASR is trusted. A transcript is copied into a new
// message revision at send time; completed/old revisions are never rewritten.
import type { Db } from '../db/connection.ts';
import type { Config } from '../config/schema.ts';
import { MediaError, type MediaService } from './assets.ts';
import { SirenAdapter, SirenTranscriptionError } from '../integrations/siren/adapter.ts';

type TranscriptRow = {
  asset_id: string; conversation_id: string; operation_key: string; state: string;
  content_sha256: string; derived_text: string | null; derived_source: string;
  duration_ms: number | null; language: string | null; error_code: string | null;
};

export class VoiceService {
  private db: Db;
  private media: MediaService;
  private config: Config;
  private transport: typeof fetch;
  constructor(db: Db, media: MediaService, config: Config, transport: typeof fetch = fetch) {
    if (transport !== fetch && process.env.ESTOMAGO_TEST_MODE !== '1') throw new Error('TEST_TRANSPORT_FORBIDDEN');
    this.db = db; this.media = media; this.config = config; this.transport = transport;
  }

  status(): { available: boolean; reason: string | null; verification: 'configured' | 'blocked' } {
    const c = this.config.integrations.siren;
    let reason: string | null = null;
    if (!c.base_url) reason = 'siren_not_configured';
    else {
      try {
        const u = new URL(c.base_url);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
        if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) || u.username || u.password || u.search || u.hash) reason = 'siren_url_invalid';
      } catch { reason = 'siren_url_invalid'; }
      // Empty means the verified REST v1 default; an explicit other version is not silently accepted.
      if (!reason && c.contract_version && c.contract_version !== '1.1.1') reason = 'siren_contract_unverified';
      if (!reason && (!c.credential_ref || !process.env[c.credential_ref]?.trim())) reason = 'siren_credential_missing';
    }
    return { available: reason === null, reason, verification: reason === null ? 'configured' : 'blocked' };
  }

  async transcribe(assetId: string, conversationId: string, operationKey: string) {
    const asset = this.media.getAsset(assetId);
    if (asset.ingest_purpose !== 'chat_voice' || asset.created_by !== 'qiaosheng' || asset.origin !== 'upload') throw new MediaError('VOICE_ASSET_NOT_ALLOWED', 422, '只能转写自己上传的语音资产');
    this.media.validateForSend([{ asset_id: assetId, presentation: 'voice' }]);
    if (!this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) throw new MediaError('CONVERSATION_NOT_FOUND', 404, '会话不存在');
    const keyRow = this.db.prepare('SELECT asset_id FROM voice_transcripts WHERE operation_key = ?').get(operationKey) as { asset_id: string } | undefined;
    if (keyRow && keyRow.asset_id !== assetId) throw new MediaError('IDEMPOTENCY_CONFLICT', 409, '该操作键已用于另一语音');
    const row = this.db.prepare('SELECT * FROM voice_transcripts WHERE asset_id = ?').get(assetId) as TranscriptRow | undefined;
    if (row) {
      if (row.conversation_id !== conversationId || row.content_sha256 !== asset.content_sha256) throw new MediaError('VOICE_TRANSCRIPT_CONFLICT', 409, '语音会话或内容不匹配');
      if (row.state === 'ready') return this.dto(row, true);
      if (row.state === 'processing' || row.state === 'unknown') throw new MediaError('VOICE_TRANSCRIPTION_UNCONFIRMED', 409, '上次转写正在处理或结果未确认，未重复请求');
      if (row.operation_key === operationKey) throw new MediaError(row.error_code ?? 'VOICE_TRANSCRIBE_FAILED', 502, '上次语音转写失败，可重新点击重试');
    }
    const status = this.status();
    if (!status.available) throw new MediaError(status.reason!.toUpperCase(), 503, '语音转写暂不可用，请检查语音服务配置');
    const audio = this.media.readContent(assetId);
    const format = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' }[audio.mime];
    if (!format) throw new MediaError('VOICE_FORMAT_UNSUPPORTED', 422, '语音格式不支持');
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,state,content_sha256,created_at,updated_at)
      VALUES (?,?,?,'processing',?,?,?) ON CONFLICT(asset_id) DO UPDATE SET operation_key=excluded.operation_key,state='processing',error_code=NULL,updated_at=excluded.updated_at`)
      .run(assetId, conversationId, operationKey, asset.content_sha256, now, now);
    try {
      const c = this.config.integrations.siren;
      const adapter = new SirenAdapter(c.base_url, process.env[c.credential_ref!]!, this.transport);
      const result = await adapter.transcribe(audio.bytes, { format, mimeType: audio.mime, conversationId });
      if (!result) throw new SirenTranscriptionError('SIREN_NOT_CONFIGURED');
      this.db.prepare("UPDATE voice_transcripts SET state='ready',derived_text=?,language=?,duration_ms=?,updated_at=? WHERE asset_id=?")
        .run(result.text, result.language, result.durationMs, new Date().toISOString(), assetId);
      return this.dto(this.db.prepare('SELECT * FROM voice_transcripts WHERE asset_id=?').get(assetId) as TranscriptRow, false);
    } catch (error) {
      const known = error instanceof SirenTranscriptionError;
      const code = known ? error.code : 'SIREN_OUTCOME_UNKNOWN';
      this.db.prepare('UPDATE voice_transcripts SET state=?,error_code=?,updated_at=? WHERE asset_id=?')
        .run(!known || error.uncertain ? 'unknown' : 'failed', code, new Date().toISOString(), assetId);
      throw new MediaError(code, 502, '语音转写未完成，原音频已保留');
    }
  }

  private dto(row: TranscriptRow, cached: boolean) {
    return { asset_id: row.asset_id, state: 'ready', derived_text: row.derived_text, derived_source: row.derived_source, duration_ms: row.duration_ms, language: row.language, cached };
  }
}
