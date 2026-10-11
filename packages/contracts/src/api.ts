// API DTO 契约 —— 01 §17 拟新增接口的请求/响应形状。
// 字符串校验函数供 server 与测试共用（契约测试不直接信任 JSON 形状）。

export type MessageKind = 'text' | 'sticker' | 'voice' | 'system';

export type TokenEstimateSnapshotDto = {
  // EXEC_V1 §05.7.2：发送时快照（随 revision 不可变；旧消息 null——不得伪造）
  model: string | null;
  estimator_revision: string;
  quality: string;
  message_text_tokens: number;
  message_media_tokens: number | null;
  message_total_tokens: number | null;
  computed_at: string;
};

export type MessageRevisionDto = {
  revision: number;
  content: string; // LF 规范化后的多行正文（原样，不 trim）
  content_hash: string;
  kind: MessageKind;
  occurred_at: string;
  received_at: string;
  supersedes_revision: number | null;
  token_estimate: TokenEstimateSnapshotDto | null; // additive（v23）：发送前估计快照
  attachments: MessageAttachmentDto[]; // v25 起从 message_attachments 按 revision 取；旧消息恒 []
};

export type MessageDto = {
  id: string;
  conversation_id: string;
  sequence: number;
  speaker: 'owner' | 'assistant' | 'system';
  turn_id: string | null;
  kind: MessageKind;
  current_revision: number;
  published_at: string | null;
  created_at: string;
  revision: MessageRevisionDto; // 当前有效修订
};

export type MessageAttachmentInput = {
  asset_id: string; // 必须先经资产创建/导入取得（不接受 URL/路径/Base64）
  presentation: 'image' | 'sticker' | 'voice';
  caption?: string | null; // 图片/表情可选说明——不是用户亲笔正文
};

export type MessageAttachmentDto = MessageAttachmentInput & {
  derived_text: string | null; // 派生文字（如语音转写）
  derived_source: string | null; // 派生来源标记（如 siren:transcribe）
};

export type SubmitMessageRequest = {
  content: string; // 多行正文；服务端只做换行规范化（\r\n|\r → \n），不 trim、不拆分。有有效附件时允许空串
  client_message_id: string; // 幂等键：一次点击一个；重试复用
  kind?: MessageKind;
  occurred_at?: string | null;
  attachments?: MessageAttachmentInput[]; // EXEC_V1 §03.5.2 additive
};

export type SubmitMessageResponse = {
  message: MessageDto;
  duplicate: boolean; // 幂等命中时 true，返回原记录
  turn_id: string;
};

export type TurnStatus =
  | 'pending' | 'running' | 'completed' | 'interrupted' | 'blocked' | 'failed' | 'route_pending';

export type AttemptDto = {
  id: string;
  turn_id: string;
  attempt_no: number;
  state: TurnStatus;
  blocked_reason: string | null;
  input_revision: number | null;
  input_hash: string | null;
};

export type TurnDto = {
  id: string;
  conversation_id: string;
  state: TurnStatus;
  trigger: string;
  input_message_id: string | null;
  attempt: AttemptDto | null;
};

export type RouteDecisionRequest =
  | { choice: 'approve' }
  | { choice: 'edit'; content: string; client_message_id: string } // 新 revision + 新 attempt
  | { choice: 'cancel' };

export type UsageSummaryDto = {
  scope: 'request' | 'turn' | 'cumulative';
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  completeness: 'complete' | 'partial' | 'unknown';
};

export type HealthComponent = { status: 'ok' | 'degraded' | 'blocked' | 'disabled' | 'unknown'; detail: string };

export type ReadyReport = {
  status: 'ready' | 'degraded';
  components: {
    identity: HealthComponent;
    runtime: HealthComponent;
    archive: HealthComponent;
    push: HealthComponent;
    db: HealthComponent;
  };
};

// —— 校验工具 ——

export function assertString(v: unknown, name: string, opts: { min?: number; max?: number } = {}): string {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  if (opts.min !== undefined && v.length < opts.min) throw new Error(`${name} too short (min ${opts.min})`);
  if (opts.max !== undefined && v.length > opts.max) throw new Error(`${name} too long (max ${opts.max})`);
  return v;
}

export function assertId(v: unknown, name: string): string {
  return assertString(v, name, { min: 1, max: 256 });
}

// 仅空白（无附件场景）判定：不修改用户正文，只判断能否发送（02 §6.2）
export function isBlankContent(content: string): boolean {
  return /^[\s\u00A0\uFEFF\u3000]*$/.test(content);
}

// 跨平台换行规范化：只统一换行符，保留行序/空行/其余字符
export function normalizeNewlines(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}
