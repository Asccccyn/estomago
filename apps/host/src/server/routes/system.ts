// server/routes/system.ts（P07.2 第六批b）：token 预估与系统异常红点组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序/响应与错误码逐字保持。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { estimateContextFor } from '../http-leaf.ts';
import { snapshotFor, type AttachmentEstimateMeta } from '../../usage/estimator.ts';
import { MediaError } from '../../media/assets.ts';
import { sha256Hex } from '../../util/id.ts';
import { estimateTokens, ESTIMATOR_REVISION } from '../../usage/estimator.ts';
import { POLICY_CONSTANTS } from '../../config/policy-constants.ts';
import type { RequestDeps } from '../http.ts';

/** 系统组：POST /api/v1/token-estimates；GET system-alerts/summary|list；POST system-alerts/read。 */
export async function handleSystemRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string, url: URL): Promise<void> {
// —— EXEC_V1 §05.9：token 预估（语义只读：无幂等账本/If-Match；不写 message/turn/rotate）——
if (route === 'POST /api/v1/token-estimates') {
  const rawBody = await readJson(req, d, d.config.token_estimates.max_body_bytes);
  const body = rawBody as { conversation_id?: unknown; client_draft_revision?: unknown; content?: unknown; attachments?: unknown; include_request_estimate?: unknown };
  if (typeof body.conversation_id !== 'string' || !body.conversation_id) return json(res, 400, { error: { code: 'bad_conversation', message: 'conversation_id 必填' } });
  if (typeof body.content !== 'string') return json(res, 400, { error: { code: 'bad_content', message: 'content 必须是字符串' } });
  const draftRevision = typeof body.client_draft_revision === 'number' ? body.client_draft_revision : typeof body.client_draft_revision === 'string' ? body.client_draft_revision : null;
  if (draftRevision === null) return json(res, 400, { error: { code: 'bad_draft_revision', message: 'client_draft_revision 必填（防慢响应覆盖新草稿）' } });
  // 附件元数据（§9：媒体预览只读取 est 已有资产元数据）——asset_id 由服务端查库取真实
  // mime/byte_size；kind 按资产实际类型推导，不信客户端自报（图片规则未核→未知，不猜）
  const attachments: AttachmentEstimateMeta[] = [];
  if (Array.isArray(body.attachments)) {
    for (const a of body.attachments as Array<Record<string, unknown>>) {
      if (typeof a?.asset_id === 'string' && a.asset_id) {
        if (!d.media) return json(res, 503, { error: { code: 'media_unavailable', message: '媒体服务未装配' } });
        try {
          const asset = d.media.getAsset(a.asset_id);
          const kind = asset.mime_type.startsWith('image/') && asset.ingest_purpose === 'chat_sticker' ? 'image'
            : asset.mime_type.startsWith('image/') ? 'image'
              : asset.mime_type.startsWith('audio/') ? 'audio'
                : asset.mime_type.startsWith('video/') ? 'video'
                  : 'code_artifact';
          attachments.push({ kind, fingerprint: asset.content_sha256, bytes: asset.byte_size, known_tokens: null });
        } catch (err) {
          if (err instanceof MediaError) return json(res, err.httpStatus, { error: { code: err.code.toLowerCase(), message: err.message } });
          throw err;
        }
        continue;
      }
      const kind = a?.kind;
      if (kind !== 'image' && kind !== 'audio' && kind !== 'video' && kind !== 'code_artifact') return json(res, 400, { error: { code: 'bad_attachment', message: 'attachments[].kind 非法' } });
      if (typeof a.fingerprint !== 'string' || !a.fingerprint) return json(res, 400, { error: { code: 'bad_attachment', message: 'attachments[].fingerprint 必填' } });
      const known = typeof a.known_tokens === 'number' && Number.isFinite(a.known_tokens) && a.known_tokens >= 0 ? a.known_tokens : null;
      attachments.push({ kind, fingerprint: a.fingerprint, bytes: typeof a.bytes === 'number' ? a.bytes : null, known_tokens: known });
    }
  }
  const ec = estimateContextFor(d);
  // 请求投影（§8.3/§9）：当前活动窗最近一次真实发送 payload 的序列化粗估（含系统/工具/历史），
  // 加本条草稿；无法无副作用重建（无活动窗=等人工选集 / 窗内尚无已发送投影）→ request 不可用，
  // message 照给——绝不只把 messages 正文相加冒充完整请求，也不替用户零选。
  let requestProjection: Parameters<typeof estimateTokens>[0]['requestProjection'] = null;
  if (body.include_request_estimate === true) {
    const win = d.windows.activeWindow(body.conversation_id);
    if (!win) {
      requestProjection = { tokens: null, unavailable_reason: 'pending_selection' };
    } else {
      const winRev = (d.db.prepare('SELECT revision FROM windows WHERE id = ?').get(win.id) as { revision: number } | undefined)?.revision ?? null;
      const row = d.db.prepare('SELECT payload_json, id FROM provider_requests WHERE window_id = ? AND sent_at IS NOT NULL AND payload_json IS NOT NULL ORDER BY sent_at DESC LIMIT 1').get(win.id) as { payload_json: string; id: string } | undefined;
      if (!row) {
        requestProjection = { tokens: null, unavailable_reason: 'no_sent_projection', window_id: win.id, window_revision: winRev };
      } else {
        const payloadTokens = Math.ceil([...row.payload_json].length / Math.max(ec.charsPerToken, 0.1));
        const draft = estimateTokens({ model: ec.model, charsPerToken: ec.charsPerToken, content: body.content, attachments, outputCapTokens: ec.outputCap });
        requestProjection = {
          tokens: draft.message_total_tokens === null ? null : payloadTokens + draft.message_total_tokens, // 附件未知 → 请求预估未知，不猜
          unavailable_reason: draft.message_total_tokens === null ? 'unavailable' : null,
          window_id: win.id, window_revision: winRev,
          projection_version: 'last_sent_payload_v1', payload_projection_hash: sha256Hex(row.id),
        };
      }
    }
  }
  const estimate = estimateTokens({ model: ec.model, charsPerToken: ec.charsPerToken, content: body.content, attachments, outputCapTokens: ec.outputCap, requestProjection });
  const modelSnapshotId = sha256Hex(`${ec.model ?? 'null'}|${ec.charsPerToken}|${ESTIMATOR_REVISION}`);
  const attachmentFingerprint = attachments.length === 0 ? null : sha256Hex(attachments.map((a) => `${a.kind}:${a.fingerprint}:${a.known_tokens ?? 'u'}`).join('|'));
  return json(res, 200, {
    client_draft_revision: draftRevision,
    model_snapshot_id: modelSnapshotId,
    window_id: estimate.source_window_id,
    window_revision: estimate.source_window_revision,
    attachment_fingerprint: attachmentFingerprint,
    chars_per_token: ec.charsPerToken, // 客户端本地粗估复用同一系数（§7.3 分段气泡显示）
    projection_version: estimate.projection_version,
    estimate,
    stale_after_state_change: true, // 前端只应用同时匹配 draft_revision/model_snapshot/附件指纹的响应
  });
}

// —— ESTOMAGO_CHAT_EXEC_V1 §05（WP1）：系统异常红点 ——
// 快照/summary 只读；read 单调幂等。告警产生与恢复是内部服务接口，
// 不向浏览器开放任意 code 创建或自填"已修复"（§5 末段）。
if (route === 'GET /api/v1/system-alerts/summary') {
  if (!d.alerts) return json(res, 200, { unread_anomaly_count: 0, open_count: 0, highest_open_severity: null, snapshot_sequence: d.events.maxSequence(), service: 'not_configured' });
  return json(res, 200, d.alerts.summary(d.alerts.uiActorId));
}
if (route === 'GET /api/v1/system-alerts') {
  if (!d.alerts) return json(res, 200, { items: [], next_cursor: null, has_more: false, unread_anomaly_count: 0, open_count: 0, snapshot_sequence: d.events.maxSequence(), service: 'not_configured' });
  const lifecycle = url.searchParams.get('lifecycle');
  return json(res, 200, d.alerts.list({
    actorId: d.alerts.uiActorId,
    lifecycle: lifecycle === 'open' || lifecycle === 'resolved' ? lifecycle : 'all',
    unreadOnly: url.searchParams.get('unread_only') === 'true',
    limit: Number(url.searchParams.get('limit')) || undefined,
    cursor: url.searchParams.get('cursor'),
  }));
}
if (route === 'POST /api/v1/system-alerts/read') {
  if (!d.alerts) return json(res, 200, { accepted: 0, service: 'not_configured' });
  const body = (await readJson(req, d)) as { items?: Array<{ alert_id?: unknown; seen_event_sequence?: unknown }> };
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > POLICY_CONSTANTS.system_alerts.read_batch_max) {
    return json(res, 400, { error: { code: 'read_batch_too_large', message: `单次最多 ${POLICY_CONSTANTS.system_alerts.read_batch_max} 条` } });
  }
  const accepted = d.alerts.markRead(d.alerts.uiActorId, items
    .map((it) => ({ alert_id: typeof it?.alert_id === 'string' ? it.alert_id : '', seen_event_sequence: Number(it?.seen_event_sequence) }))
    .filter((it) => it.alert_id !== '' && Number.isSafeInteger(it.seen_event_sequence) && it.seen_event_sequence >= 0));
  return json(res, 200, accepted);
}
}
