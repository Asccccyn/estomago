// server/routes/content.ts（P07.2 第二批）：content 薄代理路由组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序（外层 est 认证已过）/响应与错误码逐字保持。
// P1（四仓合并审计 20261106，F06/F07）：写路径经 ContentOperationCoordinator（同操作回查→
// 意图+pin→提交→权威快照确认）；GET 纯读直转发，不进写协调。模型写工具与浏览器共用同一实例。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { contentForward } from '../../integrations/content/client.ts';
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
  if (method === 'GET') {
    const result = await contentForward(d.contentClient, { method, path: url.pathname + url.search, actor });
    return json(res, result.status, result.body);
  }
  if (!d.contentOps) return json(res, 503, { error: { code: 'content_unavailable', message: '内容写协调器未装配（聊天不受影响）' } });
  let fwdBody: Record<string, unknown> | undefined;
  try { fwdBody = (await readJson(req, d)) as Record<string, unknown>; } catch { fwdBody = {}; }
  // RR2（复审 2026-11-09）：相册条目写入补注 M 对象身份（同字节不同上传 ID=同一张图，
  // content 限额/携带集按原图归并）。浏览器不知道 hash——E 是身份持有方，在唯一
  // 入口代理处补注；确定性取值不影响写回执指纹的重放一致性。资产缺席如实不带。
  if (method === 'POST' && /^\/api\/v1\/content\/albums\/[^/]+\/entries$/.test(url.pathname) && fwdBody && typeof fwdBody['asset_id'] === 'string' && fwdBody['asset_id'] && fwdBody['content_sha256'] === undefined && d.media) {
    try { fwdBody['content_sha256'] = d.media.getAsset(fwdBody['asset_id']).content_sha256; } catch { /* 资产未知：如实不带 */ }
  }
  const result = await d.contentOps.write({ method, path: url.pathname, actor, body: fwdBody, headers: fwdHeaders });
  return json(res, result.status, result.body);
}
