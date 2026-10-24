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
}
