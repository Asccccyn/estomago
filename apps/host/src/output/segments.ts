// 分句器 v0.2.2（AUD-27 修复）：
//  - Markdown 围栏内不按空行切泡；超硬上限时按 Unicode 安全边界拆并补全围栏（成对可恢复）。
//  - 切点永不在代理对中间；组合附加字符（\p{M}）跟随前一字符。
//  - 缓冲有上限；turn 结束 flush 尾段；打断丢弃未发布缓冲。
export class TextSegmenter {
  private buffer = '';
  private inFence = false;
  private fenceLang = '';

  maxBufferChars: number;
  constructor(maxBufferChars = 4000) {
    this.maxBufferChars = maxBufferChars;
  }

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const seg = this.extractSegment();
      if (seg === null) break;
      if (seg.trim().length > 0) out.push(seg);
    }
    if (this.buffer.length > this.maxBufferChars) {
      const forced = this.forceSplit(this.buffer, this.maxBufferChars);
      this.buffer = forced.rest;
      this.inFence = countFences(forced.head) % 2 === 1 ? true : this.inFence;
      if (forced.head.trim().length > 0) out.push(forced.head);
    }
    return out;
  }

  flushTail(): string | null {
    const tail = this.buffer;
    this.buffer = '';
    this.inFence = false;
    return tail.trim().length > 0 ? tail : null;
  }

  drop(): void {
    this.buffer = '';
    this.inFence = false;
  }

  // 提取一个完整可发布段：段落边界必须不在围栏内（先判定边界位置再切，AUD-27）
  private extractSegment(): string | null {
    let searchFrom = 0;
    for (;;) {
      const idx = this.buffer.indexOf('\n\n', searchFrom);
      if (idx < 0) return null;
      const before = this.buffer.slice(0, idx);
      const fencesBefore = countFences(before);
      if (fencesBefore % 2 === 1) {
        // 边界在围栏内：跳过，找围栏闭合之后的下一个边界
        searchFrom = idx + 2;
        continue;
      }
      const seg = before;
      this.buffer = this.buffer.slice(idx + 2);
      this.inFence = false;
      return seg;
    }
  }

  // Unicode 安全强切（AUD-27）：不在代理对中间、组合字符跟随前字符；围栏未闭则补 ```\n / 重开 ```lang\n
  private forceSplit(text: string, limit: number): { head: string; rest: string } {
    let cut = Math.min(limit, text.length);
    while (cut > 0 && cut < text.length && !isSafeBoundary(text, cut)) cut -= 1;
    if (cut <= 0) cut = 1;
    let head = text.slice(0, cut);
    let rest = text.slice(cut);
    const fenceOpen = countFences(text.slice(0, cut)) % 2 === 1;
    if (fenceOpen) {
      head = head.replace(/\n?$/, '\n') + '```\n';
      rest = '```' + (this.fenceLang || '') + '\n' + rest;
    }
    return { head, rest };
  }
}

function countFences(s: string): number {
  return (s.match(/```/g) ?? []).length;
}

function findFenceEnd(s: string): number {
  // 返回"最后一个闭合 ``` 之后"的位置；无闭合返回 -1
  const first = s.indexOf('```');
  if (first < 0) return -1;
  const second = s.indexOf('```', first + 3);
  if (second < 0) return -1;
  return second + 3;
}

function isSafeBoundary(text: string, idx: number): boolean {
  const prev = text.charCodeAt(idx - 1);
  const next = text.charCodeAt(idx);
  // 不切断代理对
  if (prev >= 0xd800 && prev <= 0xdbff) return false;
  if (next >= 0xdc00 && next <= 0xdfff) return false;
  // 组合附加字符跟随前字符
  if (/\p{M}/u.test(text[idx] ?? '')) return false;
  return true;
}
