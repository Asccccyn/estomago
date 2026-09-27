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
};

// SSE 事件信封（05 §6 草案的严格版：kind 与 payload 一一对应）
export type ReasoningEnvelopePayload = {
  delta?: string;
  text?: string;
  visibility?: ReasoningVisibility;
  state?: ReasoningState;
};

export type ReasoningEnvelope = {
  schema_version: 1;
  stream_id: string;
  sequence: number; // 服务端持久 stream sequence
  event_id: string;
  kind: 'reasoning.started' | 'reasoning.delta' | 'reasoning.snapshot' | 'reasoning.completed' | 'reasoning.status_changed';
  conversation_id: string;
  turn_id: string;
  attempt_id: string;
  block_id: string;
  block_revision: number;
  generation: number;
  payload: ReasoningEnvelopePayload;
};

export function validateReasoningEnvelopeShape(v: unknown): ReasoningEnvelope {
  if (typeof v !== 'object' || v === null) throw new Error('reasoning envelope must be an object');
  const e = v as Record<string, unknown>;
  const kinds = ['reasoning.started', 'reasoning.delta', 'reasoning.snapshot', 'reasoning.completed', 'reasoning.status_changed'];
  if (!kinds.includes(String(e.kind))) throw new Error(`bad reasoning kind: ${String(e.kind)}`);
  if (e.schema_version !== 1) throw new Error('bad schema_version');
  for (const k of ['stream_id', 'event_id', 'conversation_id', 'turn_id', 'attempt_id', 'block_id']) {
    if (typeof e[k] !== 'string') throw new Error(`field ${k} must be string`);
  }
  if (typeof e.sequence !== 'number' || typeof e.block_revision !== 'number' || typeof e.generation !== 'number') {
    throw new Error('sequence/block_revision/generation must be numbers');
  }
  return v as ReasoningEnvelope;
}
