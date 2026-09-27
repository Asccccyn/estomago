// SDK 流事件契约（estómago 归一化层）—— 按 @anthropic-ai/claude-agent-sdk@0.3.283 实际
// sdk.d.ts 形状对齐（SDKPartialAssistantMessage / SDKAssistantMessage / SDKResult*）：
//  - stream_event: {type:'stream_event', event: BetaRawMessageStreamEvent, parent_tool_use_id, session_id}
//  - assistant:    {type:'assistant', message: BetaMessage(单块投递常见), parent_tool_use_id, session_id, request_id?}
//  - result:       subtype 'success' | 'error_during_execution' | 'error_max_turns' | ...
// RawSdkEvent 是 mock 夹具与真实 adapter 共同产出的输入；SdkNormalizedEvent 是唯一归一化输出。

export type ContentBlockType = 'thinking' | 'text' | 'tool_use' | 'redacted_thinking';

// —— 原始（SDK 形状）输入 ——————————————————————————————

export type RawStreamEvent =
  | { type: 'stream_event'; event: RawAnthropicEvent; parent_tool_use_id?: string | null; session_id?: string | null }
  | { type: 'assistant'; message: RawAssistantMessage; parent_tool_use_id?: string | null; session_id?: string | null; request_id?: string | null }
  | { type: 'result'; subtype?: string; is_error?: boolean; usage?: RawUsage; session_id?: string | null; error?: string }
  | { type: 'error'; error: string };

export type RawAnthropicEvent =
  | { type: 'message_start'; message: { id?: string; model?: string } }
  | { type: 'content_block_start'; index: number; content_block: { type: ContentBlockType; thinking?: string; text?: string } }
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

// channel: main = 主会话；subagent = parent_tool_use_id 非空（不投影进主私聊）
export type EventChannel = 'main' | 'subagent';

export type MatchedCompleteBlock = { block_index: number; block_type: ContentBlockType; text: string | null; tool_id: string | null; tool_name: string | null };
export type UnmatchedCompleteBlock = { seq: number; block_type: ContentBlockType; text: string | null; reason: 'no_open_block' | 'ambiguous' };

export type SdkNormalizedEvent =
  | { kind: 'message_start'; sdk_message_id: string; model: string | null; session_id: string | null; channel: EventChannel }
  | { kind: 'content_block_start'; sdk_message_id: string; block_index: number; block_type: ContentBlockType; channel: EventChannel }
  | { kind: 'thinking_delta'; sdk_message_id: string; block_index: number; text: string; channel: EventChannel }
  // signature_delta 被有意归一化掉：不入 UI、不触发解析
  | { kind: 'text_delta'; sdk_message_id: string; block_index: number; text: string; channel: EventChannel }
  | { kind: 'tool_input_delta'; sdk_message_id: string; block_index: number; tool_name: string | null; partial_json: string; channel: EventChannel }
  | { kind: 'content_block_stop'; sdk_message_id: string; block_index: number; channel: EventChannel }
  | { kind: 'message_stop'; sdk_message_id: string; channel: EventChannel }
  | {
      kind: 'complete_message';
      sdk_message_id: string;
      session_id: string | null;
      channel: EventChannel;
      matched: MatchedCompleteBlock[]; // 已匹配到流式开放块（按类型顺序匹配）
      unmatched: UnmatchedCompleteBlock[]; // 无开放块可匹配：进 unmatched 路径，绝不猜下标
    }
  | { kind: 'usage'; scope: 'request' | 'turn' | 'cumulative'; usage: RawUsage; source: 'sdk_result' | 'sdk_stream'; completeness: 'complete' | 'partial' }
  | { kind: 'turn_end'; outcome: 'completed' | 'error'; error_classified: ErrorClass | null; error_message: string | null; session_id: string | null; request_id: string | null };

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
