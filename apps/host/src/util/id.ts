// ID 生成：时间有序前缀 + 随机后缀，全局可读、不依赖数据库自增。
import { createHash, randomBytes } from 'node:crypto';

export function genId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = randomBytes(8).toString('hex');
  return `${prefix}_${t}${r}`;
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}
