import { sha256Hex } from '../../util/id.ts';

export type WakeMutation = 'schedule' | 'update' | 'cancel';

/** Display identity of the existing BackgroundTaskService idempotency scope.
 * The actual owner still accepts the model's original operation_id unchanged. */
export function wakeOperationIdentity(conversationId: string, operation: WakeMutation, operationId: string): string {
  return `wake:${sha256Hex(JSON.stringify(['jiaming', conversationId, `wake_${operation}`, operationId]))}`;
}
