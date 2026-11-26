import type { OrMessage } from './or-payload.ts';

export const TOOL_RESULT_NOT_DELIVERED = 'TOOL_RESULT_NOT_DELIVERED';
const SHORT_RECEIPT_CHARS = 1024;

export function isWithheldToolResult(content: unknown): boolean {
  return typeof content === 'string' && content.startsWith(`{"error_code":"${TOOL_RESULT_NOT_DELIVERED}"`);
}

/**
 * Close each tool call with a short protocol receipt when the result could
 * never fit into a request. The immutable prefix includes every actual
 * outbound attempt. Keep short business receipts and the original call IDs.
 */
export function compactUnsentToolResults(messages: OrMessage[], sentCount: number): Set<string> {
  const compacted = new Set<string>();
  for (let index = sentCount; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'tool' || typeof message.tool_call_id !== 'string' || JSON.stringify(message.content).length <= SHORT_RECEIPT_CHARS) continue;
    const result = readToolResult(message.content);
    const receipt: Record<string, unknown> = {};
    for (const field of ['id', 'post_id', 'archive_id', 'memory_id', 'asset_id', 'audio_asset_id', 'creation_id', 'state']) {
      const value = result?.[field];
      if (typeof value === 'string' && value.length <= 128) receipt[field] = value;
    }
    if (result?.saved === true) receipt.saved = true;
    if (typeof result?.error_code === 'string' && result.error_code.length <= 128) receipt.tool_error_code = result.error_code;
    messages[index] = { ...message, content: JSON.stringify({
      error_code: TOOL_RESULT_NOT_DELIVERED,
      execution: 'attempted',
      ...receipt,
      detail: '工具执行已尝试，回执未能装入模型请求。涉及写操作时请先按原操作核对结果。',
    }) };
    compacted.add(message.tool_call_id);
  }
  return compacted;
}

function readToolResult(content: OrMessage['content']): Record<string, unknown> | null {
  const text = typeof content === 'string' ? content : content.find(block => block.type === 'text')?.text;
  if (!text?.startsWith('{')) return null;
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { return null; }
}
