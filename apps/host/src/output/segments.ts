// 分句器 v0.3（AUD-27 §25）：行感知围栏状态机。
// 围栏=行结构：行首（缩进≤3）≥3 个 ` 或 ~ 开栏；闭合需同字符、长度≥开栏、该行余下仅空白。
// 代码内容中的 ``` / ~~~ 字符串不改变状态；两种字符互不闭合。
// 代码块内不按空行切泡；超硬上限按 Unicode 安全边界强切并补全围栏。
export class TextSegmenter {
  maxBufferChars: number;
  private seg = '';      // 当前段（已判定的完整行，含换行）
  private rest = '';     // 未完成行
  private fence: { char: '`' | '~'; len: number } | null = null;

  constructor(maxBufferChars = 4000) {
    this.maxBufferChars = maxBufferChars;
  }

  push(text: string): string[] {
    this.rest += text;
    const out: string[] = [];
    for (;;) {
      const nl = this.rest.indexOf('\n');
      if (nl < 0) break;
      const line = this.rest.slice(0, nl);
      this.rest = this.rest.slice(nl + 1);
      const consumed = this.consumeLine(line);
      if (consumed !== undefined && consumed.trim().length > 0) out.push(consumed);
      // 行级硬上限：围栏打开时立即切（此刻状态机仍在栏内，补全围栏才正确）
      if (this.fence && this.seg.length > this.maxBufferChars) {
        const head = this.seg;
        this.seg = '';
        const marker = this.fence.char.repeat(this.fence.len);
        // 行结构安全：整段作为头段发出（内容本就是完整行，Unicode 天然安全），围栏补全成对
        out.push(head.replace(/\n?$/, '\n') + marker + '\n');
        this.rest = marker + '\n' + this.rest; // 尾段重开围栏，继续行循环
        this.fence = null;
      }
    }
    // 非围栏溢出（Unicode 安全切）
    if (!this.fence && this.seg.length + this.rest.length > this.maxBufferChars) {
      const joined = this.seg + this.rest;
      let cut = Math.min(this.maxBufferChars, joined.length);
      while (cut > 0 && cut < joined.length && !isSafeBoundary(joined, cut)) cut -= 1;
      if (cut <= 0) cut = 1;
      const head = joined.slice(0, cut);
      this.seg = '';
      this.rest = joined.slice(cut);
      if (head.trim().length > 0) out.push(head);
    }
    return out;
  }

  flushTail(): string | null {
    const tail = this.seg + this.rest;
    this.seg = '';
    this.rest = '';
    this.fence = null;
    return tail.trim().length > 0 ? tail : null;
  }

  drop(): void {
    this.seg = '';
    this.rest = '';
    this.fence = null;
  }

  // 处理一条完整行；返回"可发布段"（仅在非围栏空行边界）
  private consumeLine(line: string): string | undefined {
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (this.fence) {
      if (m && m[2]![0] === this.fence.char && m[2]!.length >= this.fence.len && m[3]!.trim() === '') {
        this.fence = null; // 正常闭合
      }
      this.seg += line + '\n';
      return undefined;
    }
    if (m) {
      this.fence = { char: m[2]![0] as '`' | '~', len: m[2]!.length };
      this.seg += line + '\n';
      return undefined;
    }
    if (line.trim() === '') {
      const seg = this.seg;
      this.seg = '';
      return seg; // 段边界（围栏外空行）
    }
    this.seg += line + '\n';
    return undefined;
  }
}

function isSafeBoundary(text: string, idx: number): boolean {
  const prev = text.charCodeAt(idx - 1);
  const next = text.charCodeAt(idx);
  if (prev >= 0xd800 && prev <= 0xdbff) return false; // 不切断代理对
  if (next >= 0xdc00 && next <= 0xdfff) return false;
  if (/\p{M}/u.test(text[idx] ?? '')) return false; // 组合字符跟随前字符
  return true;
}
