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

/** 发送前 token 估计的驱动上下文（自 server/http.ts 逐字下沉；P07.2 会话组路由同用）。
 *  结构化参数（不 import RequestDeps）——保持 leaf 零反向依赖。 */
export type EstimatorDeps = {
  runnerSelection: { status: string; runner?: { kind: string } };
  config: {
    deepseek: { model: string | null; estimate_chars_per_token: number; max_output_tokens: number | null };
    openrouter: { model: string | null; estimate_chars_per_token: number; max_output_tokens: number | null };
    runtime: { model: string | null };
  };
  settings?: { effectiveOrModel: (m: string | null) => string | null } | null;
};

export function estimateContextFor(d: EstimatorDeps): { model: string | null; charsPerToken: number; outputCap: number | null } {
  const sel = d.runnerSelection;
  const driver = sel.status === 'ok' ? sel.runner?.kind ?? null : null;
  if (driver === 'deepseek') return { model: d.config.deepseek.model, charsPerToken: d.config.deepseek.estimate_chars_per_token, outputCap: d.config.deepseek.max_output_tokens };
  if (driver === 'openrouter') {
    const eff = d.settings?.effectiveOrModel(d.config.openrouter.model) ?? d.config.openrouter.model;
    return { model: eff, charsPerToken: d.config.openrouter.estimate_chars_per_token, outputCap: d.config.openrouter.max_output_tokens };
  }
  if (driver === 'mock') return { model: 'mock', charsPerToken: 2.5, outputCap: 1024 };
  return { model: d.config.runtime.model, charsPerToken: 2.5, outputCap: null };
}
