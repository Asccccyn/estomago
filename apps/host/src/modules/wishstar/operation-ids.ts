import { sha256Hex } from '../../util/id.ts';

export function starWriteOperationId(key: unknown): string {
  return `ws:star:v1:${sha256Hex(JSON.stringify(['jiaming', 'wishstar_write_star', key]))}`;
}
export function starReplyOperationId(starId: string, key: unknown): string {
  return `ws:reply:v1:${sha256Hex(JSON.stringify(['jiaming', starId, key]))}`;
}
