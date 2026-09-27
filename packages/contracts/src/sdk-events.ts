// SDK 流事件契约（estómago 归一化层）。
// RawSdkEvent 是"SDK 形状"的输入（mock fixture 与真实 adapter 都产出它）；
// SdkNormalizedEvent 是 normalizer 的唯一输出。二者都是本项目的内部契约，
// 不冒充 SDK 官方类型；真实字段以锁定版本的 SDK fixture 核对为准（05 §5.1）。

export type ContentBlockType = 'thinking' | 'text' | 'tool_use' | 'redacted_thinking';

// —— 原始（SDK 形状）输入 ——————————————————————————————

export type RawStreamEvent =
  | { type: 'stream_event'; event: RawAnthropicEvent; parent_tool_use_id?: string | null }
  | { type: 'assistant'; message: RawAssistantMessage; parent_tool_use_id?: string | null }
  | { type: 'result'; subtype?: string; usage?: RawUsage; error?: string }
  | { type: 'error'; error: string };

export type RawAnthropicEvent =
  | { type: 'message_start'; message: { id?: string; model?: string } }
  | { type: 'content_block_start'; index: number; content_block: { type: ContentBlockType } }
  | { type: 'content_block_delta'; index: number; delta: RawDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_stop' };

export type RawDelta =
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string };

export type RawAssistantMessage = {
  id?: string;
  content?: Array<{ type: ContentBlockType; thinking?: string; text?: string; id?: string; name?: string; input?: unknown }>;
};

export type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

// —— 归一化输出 ——————————————————————————————

export type SdkNormalizedEvent =
  | { kind: 'message_start'; sdk_message_id: string; model: string | null; source: 'stream' }
  | { kind: 'content_block_start'; sdk_message_id: string; block_index: number; block_type: ContentBlockType }
  | { kind: 'thinking_delta'; sdk_message_id: string; block_index: number; text: string }
  // signature_delta 被有意归一化掉：不入 UI、不触发解析（05 §5.1）
  | { kind: 'text_delta'; sdk_message_id: string; block_index: number; text: string }
  | { kind: 'tool_input_delta'; sdk_message_id: string; block_index: number; tool_name: string | null; partial_json: string }
  | { kind: 'content_block_stop'; sdk_message_id: string; block_index: number }
  | { kind: 'message_stop'; sdk_message_id: string }
  | { kind: 'complete_message'; sdk_message_id: string; blocks: Array<{ block_type: ContentBlockType; block_index: number; text: string | null; tool_id: string | null; tool_name: string | null }> }
  | { kind: 'usage'; scope: 'request' | 'turn' | 'cumulative'; usage: RawUsage; source: 'sdk_result' | 'sdk_stream'; completeness: 'complete' | 'partial' }
  | { kind: 'turn_end'; outcome: 'completed' | 'error'; error_classified: ErrorClass | null; error_message: string | null };

// 错误分类（10.1：普通拒绝、网络故障和明确路由分别归类；不确定归 unknown，不冒充路由）
export type ErrorClass = 'refusal' | 'network' | 'route_signal' | 'unknown';

export function classifyError(message: string | null | undefined): ErrorClass {
  if (!message) return 'unknown';
  const m = message.toLowerCase();
  if (m.includes('route_signal:') || m.includes('model_switch_requested')) return 'route_signal';
  if (m.includes('refus') || m.includes('permission denied') || m.includes('not allowed')) return 'refusal';
  if (m.includes('network') || m.includes('timeout') || m.includes('econnreset') || m.includes('fetch failed')) return 'network';
  return 'unknown';
}
