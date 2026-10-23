import type { Db } from '../db/connection.ts';

export class MessageMutationError extends Error {
  readonly code = 'MESSAGE_ALREADY_DISPATCHED';
  constructor() { super('这条消息已进入模型请求或已有回复，不能再编辑或撤回。'); }
}

/** Alias m must be a messages row. Dispatch-start freezes the input even when
 * response headers never arrive. Retained history is also immutable. */
export const MESSAGE_FROZEN_SQL = `(
  EXISTS(SELECT 1 FROM turns mt JOIN provider_requests mp ON mp.turn_id=mt.id
    WHERE (mt.input_message_id=m.id OR mt.id=m.turn_id)
      AND (mp.dispatch_started_at IS NOT NULL OR mp.sent_at IS NOT NULL OR mp.generation_id IS NOT NULL OR mp.outcome='completed'))
  OR EXISTS(SELECT 1 FROM turns mt WHERE (mt.input_message_id=m.id OR mt.id=m.turn_id) AND mt.state='completed')
  OR EXISTS(SELECT 1 FROM messages reply WHERE reply.turn_id=m.turn_id AND reply.speaker='assistant')
  OR EXISTS(SELECT 1 FROM window_trajectories wt JOIN windows mw ON mw.id=wt.window_id,
    json_each(CASE WHEN json_valid(wt.manifest_json) THEN wt.manifest_json ELSE '[]' END) item
    WHERE mw.conversation_id=m.conversation_id AND json_extract(item.value,'$.id')=m.id
      AND COALESCE(json_extract(item.value,'$.pending_dispatch'),0) != 1)
)`;

export function assertMessageMutable(db: Db, messageId: string): void {
  const row = db.prepare(`SELECT ${MESSAGE_FROZEN_SQL} AS frozen FROM messages m WHERE m.id=?`).get(messageId) as { frozen: number } | undefined;
  if (row?.frozen) throw new MessageMutationError();
}
