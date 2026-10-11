// ESTOMAGO_CHAT_EXEC_V1 §05.8（WP1）：token 预估的唯一纯函数来源。
// composer 预估、发送前快照、记录面板共用此处；不再给 UI 复制第二套算法。
// 纯函数：零网络、零模型调用、零计数 API、不写任何状态（预估不更改 window_trajectories，
// 不把待发送草稿入库/日志）。Unicode 码点统一计数；rough 不称精确。
// 图片不按 base64 长度估——未知就是 partial_media；音频转写费用单列（不重复加"音频token"）。
export const ESTIMATOR_REVISION = 'rough-unicode-cpt-v1';

export type EstimateQuality = 'model_tokenizer' | 'rough_text' | 'partial_media' | 'unavailable';

export type AttachmentEstimateMeta = {
  kind: 'image' | 'audio' | 'video' | 'code_artifact';
  fingerprint: string; // 与正文 content_hash 分开的附件指纹（不参与正文 hash）
  bytes?: number | null;
  known_tokens?: number | null; // 已核模型图像规则/已入模型转写文字才有；否则未知
};

export type RequestUnavailableReason = 'pending_selection' | 'no_sent_projection' | 'unavailable' | null;

export type RequestProjectionInput = {
  // 无副作用重建的完整发送投影（含系统/工具/选集/附件表示）；null=不可用（§8：不能只把 messages 正文相加）
  tokens: number | null;
  unavailable_reason?: 'pending_selection' | 'no_sent_projection' | 'unavailable' | null;
  window_id?: string | null;
  window_revision?: number | null;
  projection_version?: string | null;
  payload_projection_hash?: string | null;
};

export type EstimateInput = {
  model: string | null;
  charsPerToken: number; // 按驱动/模型的粗估系数（config openrouter/deepseek estimate_chars_per_token）
  content: string;
  attachments?: AttachmentEstimateMeta[];
  requestProjection?: RequestProjectionInput | null;
  outputCapTokens: number | null;
};

export type EstimateResult = {
  message_text_tokens: number;
  message_media_tokens: number | null; // 任一附件未知 → null（已知小计见 message_known_subtotal）
  message_known_subtotal: number; // 已知组成小计（正文+已估附件），未知不影响
  message_total_tokens: number | null; // 有未知组成 → null，不伪称精确总量
  request_input_tokens: number | null;
  request_unavailable_reason: RequestUnavailableReason;
  output_cap_tokens: number | null;
  quality: EstimateQuality;
  unknown_components: string[];
  model: string | null;
  estimator_revision: string;
  scope: 'message_only' | 'request_preview';
  source_window_id: string | null;
  source_window_revision: number | null;
  projection_version: string | null;
  payload_projection_hash: string | null;
};

export function estimateTokens(input: EstimateInput): EstimateResult {
  // 正文：Unicode 码点口径（中文/emoji/ASCII 同一标准），ceil 粗估；quality 起步 rough_text
  const codePoints = [...input.content].length;
  const textTokens = Math.ceil(codePoints / Math.max(input.charsPerToken, 0.1));
  const unknown: string[] = [];
  let quality: EstimateQuality = 'rough_text';
  let mediaKnown = 0;
  let mediaUnknown = false;
  for (const a of input.attachments ?? []) {
    if (a.known_tokens != null) {
      mediaKnown += a.known_tokens; // 已核图像规则/已入模型转写文字
      continue;
    }
    switch (a.kind) {
      case 'code_artifact':
        // SVG/HTML 是文本：按字节粗估（ASCII 为主），仍标 rough——不是精确 tokenizer
        if (a.bytes != null && a.bytes > 0) mediaKnown += Math.ceil(a.bytes / Math.max(input.charsPerToken, 0.1));
        else { mediaUnknown = true; unknown.push('code_artifact_bytes_unknown'); }
        break;
      case 'image':
        // §8.4：不把 base64 长度当图像 token；模型图像规则未核 → partial_media
        mediaUnknown = true; unknown.push('image_tokens_unknown');
        break;
      case 'audio':
        // 转写费用单列外部服务；转写文字实际进入模型请求时才计文字 token（§8.4 末句）
        mediaUnknown = true; unknown.push('audio_transcript_not_in_model_input');
        break;
      case 'video':
        mediaUnknown = true; unknown.push('video_tokens_unknown');
        break;
    }
  }
  if (mediaUnknown) quality = 'partial_media';
  // 请求投影不可重建（如等待人工选集）——message 照给，request 标不可用（§9 末段）
  const requestUnavailableReason = input.requestProjection
    ? (input.requestProjection.tokens === null ? (input.requestProjection.unavailable_reason ?? 'unavailable') : null)
    : null;
  const scope: EstimateResult['scope'] = input.requestProjection ? 'request_preview' : 'message_only';
  return {
    message_text_tokens: textTokens,
    message_media_tokens: mediaUnknown ? null : (input.attachments?.length ? mediaKnown : null),
    message_known_subtotal: textTokens + mediaKnown,
    message_total_tokens: mediaUnknown ? null : textTokens + mediaKnown,
    request_input_tokens: input.requestProjection?.tokens ?? null,
    request_unavailable_reason: requestUnavailableReason,
    output_cap_tokens: input.outputCapTokens,
    quality,
    unknown_components: unknown,
    model: input.model,
    estimator_revision: ESTIMATOR_REVISION,
    scope,
    source_window_id: input.requestProjection?.window_id ?? null,
    source_window_revision: input.requestProjection?.window_revision ?? null,
    projection_version: input.requestProjection?.projection_version ?? null,
    payload_projection_hash: input.requestProjection?.payload_projection_hash ?? null,
  };
}

/** §7.2 发送前快照：随 revision 保存（正文/媒体估计 + 模型 + 版本 + 时刻；不含请求预估）。 */
export type TokenEstimateSnapshot = {
  model: string | null;
  estimator_revision: string;
  quality: EstimateQuality;
  message_text_tokens: number;
  message_media_tokens: number | null;
  message_total_tokens: number | null;
  computed_at: string;
};

export function snapshotFor(input: EstimateInput, nowIso: string): TokenEstimateSnapshot {
  const e = estimateTokens({ ...input, requestProjection: null }); // 快照只含 message 维
  return {
    model: e.model,
    estimator_revision: e.estimator_revision,
    quality: e.quality,
    message_text_tokens: e.message_text_tokens,
    message_media_tokens: e.message_media_tokens,
    message_total_tokens: e.message_total_tokens,
    computed_at: nowIso,
  };
}

/** §7.3 助手分段气泡：可见文字本地粗估（标签恒为"正文约N 粗估"；整轮 actual 只在轮汇总出现一次）。 */
export function visibleTextRoughTokens(content: string, charsPerToken: number): number {
  return Math.ceil([...content].length / Math.max(charsPerToken, 0.1));
}
