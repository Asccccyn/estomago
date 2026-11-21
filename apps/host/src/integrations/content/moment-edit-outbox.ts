import type { Db } from '../../db/connection.ts';
import { genId } from '../../util/id.ts';
import { contentForward, type ContentClient } from './client.ts';

const TARGET = 'content.moment_display_edit';
const MAX_ATTEMPTS = 5;

type DisplayEdit = { postId: string; ifMatch: string; sourceRevision: number };
type EditRow = { id: string; operation_key: string; payload_ref: string; attempt: number };

async function associate(
  db: Db, client: ContentClient, row: EditRow,
): Promise<Awaited<ReturnType<typeof contentForward>> | null> {
  const edit = JSON.parse(row.payload_ref) as DisplayEdit;
  let response: Awaited<ReturnType<typeof contentForward>> | null = null;
  let state = 'unknown_outcome';
  let error = 'reference_update_pending';
  try {
    response = await contentForward(client, {
      actor: 'qiaosheng', method: 'PUT', path: `/internal/heartbeat-posts/${encodeURIComponent(edit.postId)}/blocks/card`,
      body: { display_revision: edit.sourceRevision },
      headers: { 'if-match': edit.ifMatch, 'idempotency-key': row.operation_key }, timeoutMs: 2000,
    });
    if (response.status >= 200 && response.status < 300 && !response.bodyFailed) {
      const receipt = response.body as { id?: string; display_revision?: number } | null;
      if (receipt?.id === edit.postId && receipt?.display_revision === edit.sourceRevision) {
        state = 'acked';
        error = '';
      } else {
        response = null;
      }
    } else if ([400, 403, 404, 409, 410, 412, 422].includes(response.status)) {
      state = 'failed';
      error = `reference_edit_${response.status}`;
    }
  } catch { /* The same, narrowly scoped association can be retried. */ }
  db.prepare(`
    UPDATE outbox SET state=?,attempt=attempt+1,last_error=?,updated_at=?
     WHERE id=? AND attempt=? AND state IN ('pending','unknown_outcome')
  `).run(state === 'unknown_outcome' && row.attempt + 1 >= MAX_ATTEMPTS ? 'failed' : state,
    error || null, new Date().toISOString(), row.id, row.attempt);
  return response;
}

/** Record only the known source revision and relationship CAS. The source
 * already committed via Content's own write receipt and is never re-edited here. */
export async function associateMomentEdit(db: Db, client: ContentClient, key: string, edit: DisplayEdit): Promise<
  Awaited<ReturnType<typeof contentForward>> | null
> {
  const now = new Date().toISOString();
  const payload = JSON.stringify(edit);
  db.prepare(`
    INSERT OR IGNORE INTO outbox(id,operation_key,target,payload_ref,state,created_at,updated_at)
    VALUES(?,?,?,?, 'pending',?,?)
  `).run(genId('ob'), key, TARGET, payload, now, now);
  const row = db.prepare('SELECT id,operation_key,payload_ref,attempt FROM outbox WHERE target=? AND operation_key=?')
    .get(TARGET, key) as EditRow | undefined;
  if (!row || row.payload_ref !== payload) throw new Error('MOMENT_DISPLAY_EDIT_IDENTITY_CONFLICT');
  return associate(db, client, row);
}

/** Consumed by the existing heartbeat/content projection worker. */
export async function recoverMomentEdits(db: Db, client: ContentClient, limit: number): Promise<void> {
  const rows = db.prepare(`
    SELECT id,operation_key,payload_ref,attempt FROM outbox
     WHERE target=? AND state IN ('pending','unknown_outcome')
     ORDER BY updated_at,id LIMIT ?
  `).all(TARGET, limit) as EditRow[];
  for (const row of rows) await associate(db, client, row);
}
