// server/routes/content.ts（P07.2 第二批）：content 薄代理路由组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序（外层 est 认证已过）/响应与错误码逐字保持。
// P1（四仓合并审计 20261106，F06/F07）：写路径经 ContentOperationCoordinator（同操作回查→
// 意图+pin→提交→权威快照确认）；GET 纯读直转发，不进写协调。模型写工具与浏览器共用同一实例。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { contentForward } from '../../integrations/content/client.ts';
import type { RequestDeps } from '../http.ts';
import { decorateFutureNoteResponse, decorateMomentResponse, handleMomentReference } from './content-moments.ts';

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
  const reference = await handleMomentReference(req, url, d, fwdHeaders);
  if (reference) return json(res, reference.status, reference.body);
  if (method === 'GET') {
    const result = await contentForward(d.contentClient, { method, path: url.pathname + url.search, actor });
    if (result.status >= 200 && result.status < 300 && result.bodyFailed) {
      return json(res, 502, { error: { code: 'content_response_incomplete', message: '内容服务响应不完整（正文传输失败）' } });
    }
    const body = result.status === 200
      ? decorateFutureNoteResponse(url.pathname, await decorateMomentResponse(url, result.body, d), d) : result.body;
    if (body === null && (result.body as { kind?: string } | null)?.kind === 'reference') {
      return json(res, 404, { error: { code: 'reference_not_found', message: '没有找到这条朋友圈映射。' } });
    }
    return json(res, result.status, body);
  }
  if (!d.contentOps) return json(res, 503, { error: { code: 'content_unavailable', message: '内容写协调器未装配（聊天不受影响）' } });
  let fwdBody: Record<string, unknown> | undefined;
  try { fwdBody = (await readJson(req, d)) as Record<string, unknown>; } catch { fwdBody = {}; }
  // RR2/F1（复审 2026-11-09 二轮）：相册条目写入补注 M 对象身份（同字节不同上传
  // ID=同一张图，content 限额/携带集按原图归并）。hash 是服务端事实，由 E 资产行
  // 唯一确定——无条件覆盖，不只在本填时补；客户端自报的另一套原图身份不采信
  // （资产未知=删掉自报值，如实不带）。确定性取值不影响写回执指纹的重放一致性。
  if (method === 'POST' && /^\/api\/v1\/content\/albums\/[^/]+\/entries$/.test(url.pathname) && fwdBody && typeof fwdBody['asset_id'] === 'string' && fwdBody['asset_id'] && d.media) {
    try { fwdBody['content_sha256'] = d.media.getAsset(fwdBody['asset_id']).content_sha256; } catch { delete fwdBody['content_sha256']; /* 资产未知：如实不带（自报身份不采信） */ }
  }
  // W1（2026-11-15 她授权落地）：旧收藏改携带的 PUT——PUT 体不带 asset_id，先读条目
  // 取 asset_id 再按 E 资产行补注身份（服务端事实：无条件覆盖，自报值先删）；条目读
  // 不到或正文截断（RR4-A 两 flavor）→如实不带，content 行内身份仍参与保守计数。
  if (method === 'PUT' && /^\/api\/v1\/content\/album-entries\/[^/]+$/.test(url.pathname) && fwdBody && d.media && d.contentClient) {
    delete fwdBody['content_sha256'];
    try {
      const entry = await contentForward(d.contentClient, { method: 'GET', actor, path: url.pathname });
      if (entry.status === 200 && !entry.bodyFailed) {
        const assetId = (entry.body as { asset_id?: string }).asset_id;
        if (typeof assetId === 'string' && assetId) fwdBody['content_sha256'] = d.media.getAsset(assetId).content_sha256;
      }
    } catch { /* 已删自报值：如实不带 */ }
  }
  const result = await d.contentOps.write({ method, path: url.pathname, actor, body: fwdBody, headers: fwdHeaders });
  const body = result.status >= 200 && result.status < 300
    ? decorateFutureNoteResponse(url.pathname, result.body, d) : result.body;
  return json(res, result.status, body);
}
