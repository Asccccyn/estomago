// 增量与完整块核对（05 §5.2）：A=已接收文本，B=完整块文本。
// A=B → 只定稿；A 是 B 的前缀 → 只补缺段；否则不拼接 A+B，保留差异、revision 递增、
// 发 snapshot 更正投影。相同文本可以是不同合法块，绝不靠内容 hash 匹配身份。
export type ReconcileOutcome =
  | { action: 'already_complete' }
  | { action: 'append_tail'; tail: string }
  | { action: 'conflict'; finalText: string; receivedText: string };

export function reconcile(received: string, final: string): ReconcileOutcome {
  if (received === final) return { action: 'already_complete' };
  if (final.startsWith(received)) return { action: 'append_tail', tail: final.slice(received.length) };
  return { action: 'conflict', finalText: final, receivedText: received };
}

// 完整块身份缺失时的处理边界：先 unmatched（partial），超时/turn 结束仍无边界 → conflict。
// 这里只提供判定函数；计时策略由调用方掌握。
export function unmatchedOutcome(elapsedMs: number, timeoutMs: number): 'partial' | 'conflict' {
  return elapsedMs >= timeoutMs ? 'conflict' : 'partial';
}
