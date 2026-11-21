import { sha256Hex } from '../../util/id.ts';

export function memoryHoldOperationId(turnOrRequestId: string, callId: string): string {
  return `es-hold-${sha256Hex(`${turnOrRequestId}:${callId}`).slice(0, 40)}`;
}
