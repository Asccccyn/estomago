// server/routes/content.ts（P07.2 第二批）：content 薄代理路由组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序（外层 est 认证已过）/响应与错误码逐字保持。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { contentProxyWithAssets } from '../../integrations/content/client.ts';
import type { RequestDeps } from '../http.ts';

/** EXEC_V1 §06.4/5（WP5）：content 薄代理——浏览器经 est 认证→派生 qiaosheng→转发 loopback。 */
export async function handleContentProxy(req: IncomingMessage, res: ServerResponse, d: RequestDeps, url: URL): Promise<void> {
  if (!d.contentClient) return json(res, 503, { error: { code: 'content_unavailable', message: '内容服务未启用或不可达（聊天不受影响）' } });
  const method = req.method as 'GET' | 'POST' | 'PUT' | 'DELETE';
  // 浏览器经 est 认证→actor=qiaosheng（§06.3.1：不能由请求体/头自报作者）
  const actor = 'qiaosheng' as const;
  const fwdHeaders: Record<string, string> = {};
  for (const h of ['idempotency-key', 'if-match']) {
    const v = req.headers[h];
    if (typeof v === 'string' && v) fwdHeaders[h] = v;
  }
  let fwdBody: Record<string, unknown> | undefined;
  if (method === 'POST' || method === 'PUT') {
    try { fwdBody = (await readJson(req, d)) as Record<string, unknown>; } catch { fwdBody = {}; }
  }
  const result = await contentProxyWithAssets({ client: d.contentClient, media: d.media ?? null, db: d.db, method, path: url.pathname + url.search, actor, body: fwdBody, headers: fwdHeaders });
  return json(res, result.status, result.body);
}
