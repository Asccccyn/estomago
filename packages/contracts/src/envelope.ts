// estómago 统一事件信封 —— 01 主架构 §5.1 的设计契约（非 SDK/Mariposa 现有字段）。
// 所有持久事件与 SSE 事件共用此信封；schema_version 固定为 1。

export const SCHEMA_VERSION = 1 as const;

export type EventEnvelope = {
  id: string;
  type: string;
  schema_version: typeof SCHEMA_VERSION;
  conversation_id: string | null;
  source: string;
  occurred_at: string;
  received_at: string;
  source_revision?: string;
  dedupe_key: string;
  correlation_id: string;
  causation_id?: string;
  expires_at?: string;
  privacy_scope: string;
  payload_ref: string;
};

export function makeEnvelope(init: {
  id: string;
  type: string;
  source: string;
  dedupe_key: string;
  correlation_id: string;
  conversation_id?: string | null;
  occurred_at?: string;
  received_at?: string;
  privacy_scope?: string;
  payload: unknown;
  source_revision?: string;
  causation_id?: string;
}): EventEnvelope {
  const now = new Date().toISOString();
  return {
    id: init.id,
    type: init.type,
    schema_version: SCHEMA_VERSION,
    conversation_id: init.conversation_id ?? null,
    source: init.source,
    occurred_at: init.occurred_at ?? now,
    received_at: init.received_at ?? now,
    source_revision: init.source_revision,
    dedupe_key: init.dedupe_key,
    correlation_id: init.correlation_id,
    causation_id: init.causation_id,
    privacy_scope: init.privacy_scope ?? 'private',
    payload_ref: JSON.stringify(init.payload),
  };
}

// SSE 推送的 kind 集合（01 §17）。reasoning.* 是本协议名，不冒称 SDK 原生名称。
export const SSE_EVENT_KINDS = [
  // F-J-50/D7（2026-10-06）：与实际发布集对齐（http.ts/events 全调用点核对）；
  // 本常量无运行时强制点（kind 自由串），仅作契约对照
  'message.persisted', 'message.published', 'turn.started', 'turn.status',
  'reasoning.delta', 'reasoning.block', 'archive.sync', 'context.warning',
  'review.sent', 'review.failed', 'window.rotated',
];

export type SseEventKind = (typeof SSE_EVENT_KINDS)[number];

export function isSseEventKind(v: string): v is SseEventKind {
  return (SSE_EVENT_KINDS as readonly string[]).includes(v);
}
