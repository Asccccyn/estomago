// messages/effective-text.ts（联合审计 A07）：一条修订的可信正文——消息生命周期与回忆
// 浮现共用，避免各自对"空正文语音消息"另写分支。正文非空=正文；空正文语音消息=发布时
// 快照的可信转写（message_attachments.derived_text：MessageService 只从同字节 ready 转写复制）。
// 模型输入投影另有分页/原声引用语义（media/model-input.ts），不走这里。
import type { Db } from '../db/connection.ts';
import { isBlankContent } from '../../../../packages/contracts/src/api.ts';

export function effectiveRevisionText(db: Db, messageId: string, revision: number, content: string): string {
  if (!isBlankContent(content)) return content;
  const row = db.prepare(
    "SELECT derived_text FROM message_attachments WHERE message_id=? AND revision=? AND presentation='voice' AND derived_text IS NOT NULL ORDER BY position LIMIT 1",
  ).get(messageId, revision) as { derived_text: string } | undefined;
  return row?.derived_text ?? content;
}
