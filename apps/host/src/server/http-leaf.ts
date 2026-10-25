// server/http-leaf.ts（S17b 批次5）：HTTP 公共叶——body 读取/JSON 响应/错误类型。
// http.ts 与 routes/* 同向依赖它；无反向依赖（导入环收口）。
import type { IncomingMessage, ServerResponse } from 'node:http';

export class ClientBodyError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage, _d?: unknown, maxBytes = 5 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new ClientBodyError(413, 'payload_too_large', `请求体超过上限`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // F-J-44（联合审计 2026-10-06）：坏 JSON 是客户端错误（400），不是 500——
    // 此前 SyntaxError 落进外层 catch 污染 500 口径
    throw new ClientBodyError(400, 'invalid_json', '请求体不是合法 JSON');
  }
}
