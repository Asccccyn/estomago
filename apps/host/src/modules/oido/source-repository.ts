// modules/oido/source-repository.ts（P02.3）：oído 接入面的窄源仓库。
// 从 HostToolExecutor.oidoSourceAllowed / oidoGet 的绑定查询原样提取；SQL 条件与
// 已发布限制逐字保留，不为测试放宽（P02 卡；若谓词与"已发布"要求不符，走独立语义缺口裁定）。
// 只管理 oído 接入表与源授权读面（oido_source_bindings + 已发布语音资产可见性），
// 不暴露原 Db、不管理整个聊天库（D25）。
import type { Db } from '../../db/connection.ts';

export type OidoAnalysisBinding = { asset_id: string; content_sha256: string };

export class OidoSourceRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** analysis ↔ 源绑定：绑定行限定当前会话（不能只拿 analysis_id 读别房内容）。 */
  analysisBinding(analysisId: string, roomId: string): OidoAnalysisBinding | undefined {
    return this.db.prepare('SELECT asset_id,content_sha256 FROM oido_source_bindings WHERE analysis_id=? AND conversation_id=?')
      .get(analysisId, roomId) as OidoAnalysisBinding | undefined;
  }

  /** 当前源授权：资产必须绑定本会话当前修订的已发布消息（voice presentation）且可用；
   *  可选 sha 校验（等长改写/撤权后 hash 不符=不可读）。有绑定行不等于当前仍可读。 */
  sourceAllowed(assetId: string, roomId: string, sha?: string): boolean {
    const row = this.db.prepare(`SELECT a.content_sha256 FROM media_assets a
      JOIN message_attachments ma ON ma.asset_id=a.id
      JOIN messages msg ON msg.id=ma.message_id AND msg.current_revision=ma.revision
      WHERE a.id=? AND a.state='available' AND ma.presentation='voice'
        AND msg.conversation_id=? LIMIT 1`).get(assetId, roomId) as { content_sha256: string } | undefined;
    return Boolean(row && (sha === undefined || sha === row.content_sha256));
  }

  /** 资产内容 hash（analyze/find/compare 的 sha 门用）。 */
  assetSha(assetId: string): string | undefined {
    return (this.db.prepare('SELECT content_sha256 FROM media_assets WHERE id=?').get(assetId) as { content_sha256: string } | undefined)?.content_sha256;
  }

  /** 可信转写（analyze 的 ingest 附件；P03.2 收进接入仓库——保留现行 SQL 条件） */
  readyTranscript(assetId: string, roomId: string, sha: string): { derived_text: string; derived_source: string } | undefined {
    return this.db.prepare("SELECT derived_text, derived_source FROM voice_transcripts WHERE asset_id = ? AND conversation_id = ? AND content_sha256 = ? AND state = 'ready'")
      .get(assetId, roomId, sha) as { derived_text: string; derived_source: string } | undefined;
  }

  /** R6′：导入回执持久化——est asset ↔ oído audio_id 映射（幂等 upsert，deduplicated 指向既有资产时如实更新） */
  /** JV-17（03§4.2）：通话快观察留档的幂等键（无=该资产未经快观察）。 */
  quickAnalysisKey(estAssetId: string): string | null {
    const row = this.db.prepare('SELECT analysis_key FROM oido_ingest_receipts WHERE est_asset_id=?').get(estAssetId) as { analysis_key: string | null } | undefined;
    return row?.analysis_key ?? null;
  }

  rememberAnalysisKey(estAssetId: string, key: string): void {
    this.db.prepare('UPDATE oido_ingest_receipts SET analysis_key=COALESCE(analysis_key,?) WHERE est_asset_id=?').run(key, estAssetId);
  }

  recordIngestReceipt(estAssetId: string, contentSha256: string, oidoAudioId: string, deduplicated: boolean): void {
    this.db.prepare('INSERT INTO oido_ingest_receipts(est_asset_id,content_sha256,oido_audio_id,deduplicated,ingested_at) VALUES (?,?,?,?,?) ON CONFLICT(est_asset_id) DO UPDATE SET oido_audio_id=excluded.oido_audio_id,deduplicated=excluded.deduplicated,ingested_at=excluded.ingested_at')
      .run(estAssetId, contentSha256, oidoAudioId, deduplicated ? 1 : 0, new Date().toISOString());
  }

  /** RE-12：远端删除意图登记——markAssetMissing 与迟到导入回执共用同一入口（幂等 upsert）。 */
  recordDeleteIntent(estAssetId: string, oidoAudioId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO oido_delete_intents(est_asset_id,oido_audio_id,attempts,last_error,created_at,updated_at) VALUES (?,?,0,NULL,?,?)
      ON CONFLICT(est_asset_id) DO UPDATE SET oido_audio_id=excluded.oido_audio_id, updated_at=excluded.updated_at`)
      .run(estAssetId, oidoAudioId, now, now);
  }

  /** RE-05（view）：测量图工件登记（analysis+range 幂等；UI 经宿主二进制路由读取）。 */
  saveViewArtifact(analysisId: string, rangeKey: string, assetId: string, contentSha256: string): void {
    this.db.prepare('INSERT OR REPLACE INTO oido_view_artifacts(analysis_id,range_json,asset_id,content_sha256,created_at) VALUES (?,?,?,?,?)')
      .run(analysisId, rangeKey, assetId, contentSha256, new Date().toISOString());
  }

  /** R5：分析↔源绑定落库（analyze 交付前建立）。 */
  bindAnalysis(analysisId: string, roomId: string, assetId: string, contentSha256: string): void {
    this.db.prepare('INSERT OR REPLACE INTO oido_source_bindings(analysis_id,conversation_id,asset_id,content_sha256) VALUES (?,?,?,?)')
      .run(analysisId, roomId, assetId, contentSha256);
  }
}
