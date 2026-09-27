// 分句输出（01 §11.2）：text_delta 进缓冲，段落边界发布；尾部在 turn 结束 flush。
// - 换行是模型输出约定：只有空行（段落边界）或缓冲上限才发一条，不是任何换行都发
// - 缓冲有上限；turn 被打断时未发布缓冲直接丢弃（已发布气泡保留）
// - 气泡间隔由 delivery 管理，不在 SDK 读取侧 sleep
export class TextSegmenter {
  private buffer = '';

  maxBufferChars: number;
  constructor(maxBufferChars = 4000) {
    this.maxBufferChars = maxBufferChars;
  }

  push(text: string): string[] {
    this.buffer += text;
    const parts = this.buffer.split(/\n\n/);
    const out: string[] = [];
    while (parts.length > 1) {
      const seg = parts.shift()!;
      if (seg.trim().length > 0) out.push(seg); // 空段落不发布
    }
    this.buffer = parts[0] ?? '';
    if (this.buffer.length > this.maxBufferChars) {
      out.push(this.buffer);
      this.buffer = '';
    }
    return out;
  }

  // turn 正常结束：尾部作为最后一段
  flushTail(): string | null {
    const tail = this.buffer;
    this.buffer = '';
    return tail.trim().length > 0 ? tail : null;
  }

  // 打断/失败：未发布缓冲丢弃，不追溯改写已发布气泡
  drop(): void {
    this.buffer = '';
  }
}
