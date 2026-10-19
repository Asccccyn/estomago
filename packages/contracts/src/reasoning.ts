// 思考摘要（reasoning）契约 —— 05 细则 §4/§6 的产品协议。
// 与正式聊天 message 完全分离；签名/加密内容任何情况下不出现在这些结构里。

// visibility：官方返回了什么
export const REASONING_VISIBILITY = ['summary', 'omitted', 'redacted', 'no_block', 'unavailable', 'unknown'] as const;
export type ReasoningVisibility = (typeof REASONING_VISIBILITY)[number];

// state：本端投影处于什么状态
export const REASONING_STATE = ['streaming', 'complete', 'partial', 'interrupted', 'failed', 'truncated', 'conflict'] as const;
export type ReasoningState = (typeof REASONING_STATE)[number];

// 每个块的稳定身份：(attempt_id, sdk_message_id, block_index) —— 不用内容 hash、不用 content 数组下标
export type ReasoningBlockDto = {
  id: string;
  turn_id: string;
  attempt_id: string;
  sdk_message_id: string;
  block_index: number;
  origin: 'stream' | 'complete_message' | 'snapshot';
  visibility: ReasoningVisibility;
  state: ReasoningState;
  revision: number;
  text: string; // 可读投影；redacted/omitted 为空串
  completeness: string;
  updated_at: string;
  created_at: string;
};
