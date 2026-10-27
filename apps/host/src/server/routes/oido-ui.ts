// server/routes/oido-ui.ts（P07.1 oído 组补迁）：深听 UI 端点（owner 面）。
// 自 server/http.ts 逐字搬迁：路径/方法/门（同 oido_analyze/oido_get 工具门：会话绑定+活资产复验）/
// 响应与错误码逐字保持。UI 与模型 tool_call 面身份语义区分不变（P07.3）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { MediaError } from '../../media/assets.ts';
import type { RequestDeps } from '../http.ts';

/** 深听 UI 组：analyze / analyses/:id / prosody / image（本地派生工件直读）。 */
export async function handleOidoUiRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string, url: URL): Promise<void> {
// R5（2026-10-23）：深听 UI 端点——同 oido_analyze/oido_view 工具门（会话绑定+活资产复验）
const oidoUiAnalyze = /^POST \/api\/v1\/oido\/analyze$/.exec(route);
if (oidoUiAnalyze) {
  if (!d.tools) return json(res, 503, { error: { code: 'oido_unconfigured', message: '深听未接入' } });
  const body = (await readJson(req, d)) as Record<string, unknown> | null;
  if (!body || typeof body['audio_ref'] !== 'string') return json(res, 422, { error: { code: 'bad_request', message: 'audio_ref 必填' } });
  const out = await d.tools.execute('oido_analyze', { audio_ref: body['audio_ref'] }, { roomId: 'primary', windowId: 'ui', turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: `ui-oido-${Date.now()}` });
  return json(res, out.ok ? 200 : (out.output as { error_code?: string })['error_code'] === 'OIDO_UNAVAILABLE' ? 503 : 422, out.output);
}
// V06 深听逐字谱（2026-10-24）：UI 翻页读 prosody_page（同 oido_get 工具门）
// F-07（跨仓预审 2026-10-25）：oído 在途（NOT_READY_YET→OIDO_*_409）是正常服务状态——
// 响应边界透传 HTTP 409（前端既有合同：409=pending 轮询），不混入 422 失败。
const oidoPending = (out: { ok: boolean; output: unknown }): boolean => {
  const code = (out.output as { error_code?: string } | null)?.['error_code'];
  return code === 'OIDO_GET_409' || code === 'OIDO_PAGE_409';
};
const oidoUiProsody = /^GET \/api\/v1\/oido\/analyses\/([^/]+)\/prosody$/.exec(route);
if (oidoUiProsody) {
  if (!d.tools) return json(res, 503, { error: { code: 'oido_unconfigured', message: '深听未接入' } });
  const cursor = url.searchParams.get('cursor');
  const out = await d.tools.execute('oido_get', { analysis_id: decodeURIComponent(oidoUiProsody[1]!), detail: 'prosody_page', ...(cursor ? { cursor } : {}) }, { roomId: 'primary', windowId: 'ui', turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: `ui-oido-${Date.now()}` });
  if (!out.ok) return json(res, oidoPending(out) ? 409 : 422, out.output);
  return json(res, 200, out.output);
}
const oidoUiView = /^GET \/api\/v1\/oido\/analyses\/([^/]+)$/.exec(route);
if (oidoUiView) {
  if (!d.tools) return json(res, 503, { error: { code: 'oido_unconfigured', message: '深听未接入' } });
  const out = await d.tools.execute('oido_get', { analysis_id: decodeURIComponent(oidoUiView[1]!) }, { roomId: 'primary', windowId: 'ui', turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: `ui-oido-${Date.now()}` });
  if (!out.ok) return json(res, oidoPending(out) ? 409 : 422, out.output);
  return json(res, 200, out.output);
}
const oidoUiImage = /^GET \/api\/v1\/oido\/analyses\/([^/]+)\/image$/.exec(route);
if (oidoUiImage) {
  // RE-05（2026-10-24）：图与正文分路后，UI 图直读本地派生工件（无 oído 服务代理、无 base64 JSON）
  if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
  const analysisId = decodeURIComponent(oidoUiImage[1]!);
  const art = d.db.prepare("SELECT asset_id FROM oido_view_artifacts WHERE analysis_id=? AND range_json='full'").get(analysisId) as { asset_id: string } | undefined;
  if (!art) return json(res, 404, { error: { code: 'view_not_found', message: '该分析没有已生成的测量图工件' } });
  try {
    const { bytes, mime } = d.media.readContent(art.asset_id);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60' });
    res.end(bytes);
    return;
  } catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}
}
