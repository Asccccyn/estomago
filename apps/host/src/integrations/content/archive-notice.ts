// RR4-W3（林石见 2026-11-10 修正稿）：用户发起存档的**成功通知登记**——唯一正本。
// 绑定"content 写入成功回执"（不等待权威快照或 M 投影），供三个成功路径共用：
//   ① 协调器首次提交成功（dispatchPinned 2xx，快照尚未确认即登记——快照失败不拖延
//      已确定的成功通知）；
//   ② 协调器恢复确认成功（advanceAccepted 解析到原操作回执=保存成功证据）；
//   ③ 协调器同操作成功重放（write ① replay 分支）。
// ArchiveService 前台不再单独登记（单一事实源）。登记失败向上抛（它是成功语义的
// 一部分：调用方按失败处理，同键重试安全）。
// 幂等：dedupe_key 沿用既有 `archive-notice:<idempotencyKey>`（同一次操作一份；
// 旧版本已登记的待恢复操作沿用原键，换键会在升级窗口产生第二条——见修正稿三-3）。
// 投递沿用 host_notices 既有机制（下次正常请求取出；确认投递前的异常重取语义不变）。
import type { Db } from '../../db/connection.ts';
import { genId } from '../../util/id.ts';

/** 登记用户发起存档的成功通知；同操作身份已登记=幂等返回 'duplicate'。 */
export function registerArchiveCreatedNotice(db: Db, o: {
  conversationId: string; archiveId: string; kind: 'quarrel' | 'sweet'; count: number; idempotencyKey: string;
}): 'registered' | 'duplicate' {
  const text = `[系统通知] 乔乔已将 ${o.count} 条对话存入「${o.kind === 'quarrel' ? '争吵' : '甜蜜'}存档」。${o.kind === 'quarrel' ? '这个话题先到这里，除非乔乔主动重提，不继续争执。' : ''}`;
  try {
    db.prepare('INSERT INTO host_notices(id, conversation_id, kind, payload_json, dedupe_key, created_at) VALUES (?,?,?,?,?,?)')
      .run(genId('hn'), o.conversationId, 'conversation_archived', JSON.stringify({
        kind: 'conversation_archived', text, archive_id: o.archiveId, archived_kind: o.kind, by: 'qiaosheng',
      }), `archive-notice:${o.idempotencyKey}`, new Date().toISOString());
    return 'registered';
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) return 'duplicate'; // 同操作身份已有通知：幂等不重复
    throw err;
  }
}

/** 是否用户发起的存档创建（协调器成功路径的登记条件）。 */
export function isUserArchiveCreate(actor: string, method: string, path: string): boolean {
  return actor === 'qiaosheng' && method === 'POST' && path.split('?')[0] === '/api/v1/content/archives';
}
