// server/routes/assets.ts（P07.2 第五批）：媒体资产与语音状态路由组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序/限量门/响应与错误码逐字保持。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { MediaError, type IngestPurpose } from '../../media/assets.ts';
import type { RequestDeps } from '../http.ts';

/** 二进制原始体读取（自 http.ts 逐字随迁——上传限量门共用）。 */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new MediaError('ASSET_TOO_LARGE', 413, `超过上限 ${maxBytes} 字节`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** 资产组：sandbox 预览（MIME 隔离）、voice 状态、转写、assets 建立导入/内容/引用/删除、oído 测量图二进制。 */
export async function handleAssetsRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string, url: URL): Promise<void> {
// —— EXEC_V1 §03.5.1（WP3/MEDIA-11）：active MIME 隔离预览——CSP sandbox + nosniff ——
const sandboxPreview = /^GET \/api\/v1\/assets\/([^/]+)\/preview$/.exec(route);
if (sandboxPreview) {
  if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
  try {
    const id = decodeURIComponent(sandboxPreview[1]!);
    const asset = d.media.getAsset(id);
    // 只有 SVG/HTML 走沙箱路径；普通图片走 content 端点
    if (asset.mime_type !== 'image/svg+xml' && asset.mime_type !== 'text/html') {
      return json(res, 400, { error: { code: 'not_active_mime', message: '此资产不需要沙箱预览（走 content 端点）' } });
    }
    const { bytes, mime } = d.media.readContent(id);
    // §03.5.1：不能只靠 iframe sandbox——资产 URL 被直接打开时也不能在 est 主站来源执行
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': String(bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'",
      'Cache-Control': 'no-store',
    });
    res.end(bytes);
    return;
  } catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}

if (route === 'GET /api/v1/voice/status') {
  return json(res, 200, d.voice?.status() ?? { available: false, reason: 'voice_unavailable', verification: 'blocked' });
}
const voiceTranscribe = /^POST \/api\/v1\/assets\/([^/]+)\/transcribe$/.exec(route);
if (voiceTranscribe) {
  if (!d.voice) return json(res, 503, { error: { code: 'voice_unavailable', message: '语音服务未装配' } });
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey || opKey.length > 256) return json(res, 400, { error: { code: 'missing_idempotency', message: '需要有效 Idempotency-Key' } });
  const body = (await readJson(req, d)) as { conversation_id?: unknown } | null;
  if (!body || typeof body.conversation_id !== 'string' || !body.conversation_id) return json(res, 400, { error: { code: 'bad_conversation', message: 'conversation_id 必填' } });
  try { return json(res, 200, await d.voice.transcribe(decodeURIComponent(voiceTranscribe[1]!), body.conversation_id, opKey)); }
  catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}

// —— EXEC_V1 §03.5（WP3）：媒体资产 API（Idempotency-Key 必带；二进制上传流式限量）——
if (route === 'POST /api/v1/assets') {
  if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
  const purpose = url.searchParams.get('purpose') ?? '';
  const validPurposes = ['chat_image', 'chat_sticker', 'chat_voice', 'creation_icon', 'creation_work'];
  if (!validPurposes.includes(purpose)) return json(res, 400, { error: { code: 'bad_purpose', message: `purpose 必须是 ${validPurposes.join('|')}` } });
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const cap = purpose === 'chat_voice' ? d.config.media.max_audio_bytes
    : purpose === 'chat_image' || purpose === 'chat_sticker' ? d.config.media.max_image_bytes
      : Math.max(d.config.media.max_code_artifact_bytes, d.config.media.max_video_bytes);
  try {
    const bytes = await readRawBody(req, cap);
    const asset = await d.media.saveBuffer({ bytes, purpose: purpose as IngestPurpose, operationId: `upload:${opKey}`, createdBy: 'qiaosheng', origin: 'upload' });
    return json(res, 201, { asset_id: asset.id, mime_type: asset.mime_type, byte_size: asset.byte_size, state: asset.state, content_sha256: asset.content_sha256, duplicate_content: asset.duplicate });
  } catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}
if (route === 'POST /api/v1/assets/import') {
  if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const body = (await readJson(req, d)) as { source_url?: unknown };
  if (typeof body.source_url !== 'string' || !body.source_url) return json(res, 400, { error: { code: 'bad_source_url', message: 'source_url 必填' } });
  try {
    const asset = await d.media.importFromUrl({ sourceUrl: body.source_url, operationId: `import:${opKey}`, createdBy: 'qiaosheng' });
    return json(res, 201, { asset_id: asset.id, mime_type: asset.mime_type, byte_size: asset.byte_size, state: asset.state });
  } catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}
const assetGet = /^GET \/api\/v1\/assets\/([^/]+)$/.exec(route);
if (assetGet) {
  if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
  try {
    const a = d.media.getAsset(decodeURIComponent(assetGet[1]!));
    return json(res, 200, { ...a, content_url: `/api/v1/assets/${encodeURIComponent(a.id)}/content` }); // 相对地址；不返回存储绝对路径/源站凭据
  } catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}
const assetContent = /^GET \/api\/v1\/assets\/([^/]+)\/content$/.exec(route);
if (assetContent) {
  if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
  const id = decodeURIComponent(assetContent[1]!);
  try {
    const { bytes, mime } = d.media.readContent(id);
    const range = String(req.headers.range ?? '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    // 语音播放所需的最小 Range 行为（§5.1）：单区间
    if (m && (m[1] !== '' || m[2] !== '')) {
      const start = m[1] === '' ? Math.max(0, bytes.length - Number(m[2] || 0)) : Number(m[1]);
      const end = m[2] === '' ? bytes.length - 1 : Math.min(bytes.length - 1, Number(m[2]));
      if (start > end || start >= bytes.length) return json(res, 416, { error: { code: 'range_not_satisfiable', message: '区间越界' } });
      const slice = bytes.subarray(start, end + 1);
      const isActiveR = mime === 'image/svg+xml' || mime === 'text/html';
      const activeHeadersR: Record<string, string> = isActiveR ? {
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        'Content-Disposition': 'attachment; filename="asset"',
      } : {};
      res.writeHead(206, { 'Content-Type': mime, 'Content-Length': String(slice.length), 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...activeHeadersR });
      res.end(slice);
      return;
    }
    // AUD-03 P1 修复：active MIME（SVG/HTML）在 content 端点也加隔离——不只靠 preview 路由
    const isActiveMime = mime === 'image/svg+xml' || mime === 'text/html';
    const activeHeaders: Record<string, string> = isActiveMime ? {
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'Content-Disposition': 'attachment; filename="asset"',
    } : {};
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...activeHeaders });
    res.end(bytes);
    return;
  } catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}
const refPost = /^POST \/api\/v1\/assets\/([^/]+)\/references$/.exec(route);
if (refPost) {
  // §03.10.2：受控服务接口——调用方身份由宿主配置映射，不接受浏览器自报 owner_service 扩权
  if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const body = (await readJson(req, d)) as { owner_service?: unknown; owner_type?: unknown; owner_id?: unknown; owner_revision?: unknown };
  // 允许的内容域（WP5 接线前静态注册；浏览器可用但仅限登记引用，不构成授权扩面）
  const ALLOWED_OWNERS: Record<string, string[]> = { content: ['album_entry', 'post', 'creation', 'future_note'] };
  const os = String(body.owner_service ?? '');
  const ot = String(body.owner_type ?? '');
  if (!(os in ALLOWED_OWNERS) || !ALLOWED_OWNERS[os]!.includes(ot)) return json(res, 403, { error: { code: 'owner_not_allowed', message: '不允许的引用域' } });
  if (typeof body.owner_id !== 'string' || !body.owner_id) return json(res, 400, { error: { code: 'bad_owner_id', message: 'owner_id 必填' } });
  try {
    const r = d.media.registerReference({ assetId: decodeURIComponent(refPost[1]!), ownerService: os, ownerType: ot, ownerId: body.owner_id, ownerRevision: typeof body.owner_revision === 'number' ? body.owner_revision : null, operationId: `ref:${opKey}` });
    return json(res, 201, { reference_id: r.referenceId, revision: r.revision, state: r.state });
  } catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}
const refDelete = /^DELETE \/api\/v1\/assets\/([^/]+)\/references\/([^/]+)$/.exec(route);
if (refDelete) {
  if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const ifMatch = String(req.headers['if-match'] ?? '').replace(/"/g, '');
  if (!ifMatch || !/^\d+$/.test(ifMatch)) return json(res, 428, { error: { code: 'precondition_required', message: '解除引用必须带 If-Match: "<revision>"（请刷新后重试）' } });
  try {
    const r = d.media.releaseReference({ referenceId: decodeURIComponent(refDelete[2]!), expectedRevision: Number(ifMatch), operationId: `unref:${opKey}` });
    return json(res, 200, { reference_id: r.referenceId, revision: r.revision, state: r.state });
  } catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}

// —— RE-12c（2026-10-24）：资产删除正式入口——markAssetMissing 的真实产品消费者。
// 守卫：仍被任何消息修订附件或 protected/committed 外部引用的资产拒绝删除（多合法引用
// 不误删）；通过→state=missing（本地源停止读取），有 oído 导入回执时同事务写远端删除
// 意图，物理清理由既有 outbox 重试（delete-retry.ts）收口；pending≠已删。
const assetDelete = /^DELETE \/api\/v1\/assets\/([^/]+)$/.exec(route);
if (assetDelete) {
  if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
  const id = decodeURIComponent(assetDelete[1]!);
  try {
    d.media.getAsset(id); // 不存在=404
    const refs = d.media.isAssetReferenced(id);
    if (refs.referenced) {
      return json(res, 409, { error: { code: 'asset_referenced', message: `资产仍被引用（消息修订附件 ${refs.by_message_revisions} 条、外部引用 ${refs.by_external_refs} 条）；先解除全部引用再删除`, by_message_revisions: refs.by_message_revisions, by_external_refs: refs.by_external_refs } });
    }
    d.media.markAssetMissing(id);
    return json(res, 200, { asset_id: id, state: 'missing', note: '源已标删；远端派生副本（如有）由删除意图重试清理' });
  } catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}

// —— RE-05（2026-10-24）：oído 测量图二进制路由（UI 消费）——读 oido_view 工具落的本地
// 派生工件（oido_view_artifacts → media 资产）；无工件 404 如实（不代理远端、不落 base64）。
const oidoViewRoute = /^GET \/api\/v1\/oido\/views\/([^/]+)$/.exec(route);
if (oidoViewRoute) {
  if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
  const analysisId = decodeURIComponent(oidoViewRoute[1]!);
  const rangeParam = String(url.searchParams.get('range_ms') ?? '');
  const rangeKey = /^\d+,\d+$/.test(rangeParam) ? rangeParam : 'full';
  const row = d.db.prepare('SELECT asset_id FROM oido_view_artifacts WHERE analysis_id=? AND range_json=?').get(analysisId, rangeKey) as { asset_id: string } | undefined;
  if (!row) return json(res, 404, { error: { code: 'view_not_found', message: '该分析没有已生成的测量图工件（先由 oido_view 生成）' } });
  try {
    const { bytes, mime } = d.media.readContent(row.asset_id);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60' });
    res.end(bytes);
    return;
  } catch (err) {
    if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
    throw err;
  }
}
}
