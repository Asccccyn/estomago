// 错误码映射（AUD-28）：日志/事件只携带稳定错误码与安全元数据，不携带原始异常文本
// （V8/SDK/解析器错误消息可能包含用户正文、token 或供应商原文）。
export function stableErrorCode(err: unknown): string {
  const msg = String((err as Error)?.message ?? err ?? '');
  if (/JSON at position|Expected|Unexpected token|is not valid JSON/i.test(msg)) return 'INVALID_JSON';
  if (/SQLITE|constraint|UNIQUE|FOREIGN/i.test(msg)) return 'DB_ERROR';
  if (/ENOSPC|disk full/i.test(msg)) return 'DISK_ERROR';
  if (/ENOENT|EACCES/i.test(msg)) return 'FS_ERROR';
  if (/ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(msg)) return 'NETWORK_ERROR';
  if (/route_signal|model_switch/i.test(msg)) return 'SDK_ROUTE_SIGNAL';
  if (/auth|401|403|api key/i.test(msg)) return 'SDK_AUTH_ERROR';
  if (/abort/i.test(msg)) return 'ABORTED';
  return 'INTERNAL_ERROR';
}

// 供 route_error 等处使用：不落原始 message
export function safeErrorFields(err: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: stableErrorCode(err), ...extra };
}
