// ESTOMAGO_OR_SELF_HOLD §7.2：显式缓存断点规划。
//  - A：system 固定前缀（tools+批准规则+I）末块——每窗恒定。
//  - B：Mariposa 启动资料快照块（bootstrap 接入后启用；当前无此消息则不标）。
//  - G：上一次已发送、且在当前轨迹中仍完全相同的可缓存边界（保护点，最多一个）。
//  显式合计 ≤3（A/B/G），顶层 cache_control 另占自动尾点（buildOrPayload 固定注入）。
//  规划只做定位与去重；块级合法性（text 块、非空）由 buildOrPayload 的门再校验，
//  不可合法标记时保守丢弃 G（记录保护未覆盖），不写未知字段碰运气。
import type { OrBoundary, OrMessage } from './or-payload.ts';

export type PrevBoundary = { messageIndex: number; contentIndex: number };

export function planBoundaries(input: {
  messages: OrMessage[];
  systemMessageCount: number; // 1（仅 system）；bootstrap 接入后为 2（system+资料块）
  prevBoundary: PrevBoundary | null;
}): { boundaries: OrBoundary[]; gDropped: boolean } {
  const { messages, prevBoundary } = input;
  const boundaries: OrBoundary[] = [];
  const seen = new Set<string>();
  const push = (b: OrBoundary): void => {
    const key = `${b.messageIndex}:${b.contentIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    boundaries.push(b);
  };
  // A：system 消息的最后一个 text 块
  if (input.systemMessageCount >= 1) {
    const sys = messages[0];
    if (Array.isArray(sys?.content) && sys.content.length > 0) push({ messageIndex: 0, contentIndex: sys.content.length - 1 });
  }
  // B：bootstrap 资料消息（当前不存在——接入后 systemMessageCount=2 时启用）
  if (input.systemMessageCount >= 2 && messages.length > 1) {
    const boot = messages[1]!;
    if (Array.isArray(boot?.content) && boot.content.length > 0) push({ messageIndex: 1, contentIndex: boot.content.length - 1 });
  }
  // G：上次已发送边界，仍指向当前轨迹中真实存在的 text 块才保留
  let gDropped = false;
  if (prevBoundary) {
    const m = messages[prevBoundary.messageIndex];
    const block = Array.isArray(m?.content) ? m!.content[prevBoundary.contentIndex] : undefined;
    if (block && (block as { type?: string }).type === 'text') {
      push({ messageIndex: prevBoundary.messageIndex, contentIndex: prevBoundary.contentIndex });
    } else {
      gDropped = true; // 位置漂移/非 text/越界：如实记录保护未覆盖，不猜近似位置
    }
  }
  if (boundaries.length > 3) boundaries.length = 3; // 代码主动限额（§7.2），不依赖 400 发现
  return { boundaries, gDropped };
}

/** 本轮发送完成后的新"已发送边界"：轨迹末消息的末 text 块（下一轮 G 的候选） */
export function tailBoundaryOf(messages: OrMessage[]): PrevBoundary | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      if ((content[j] as { type?: string }).type === 'text') return { messageIndex: i, contentIndex: j };
    }
  }
  return null;
}

/** A/B are the fixed prefix. Later host memory messages are not bootstrap. */
export function fixedSystemCount(messages: OrMessage[]): number {
  let count = 0;
  for (const message of messages.slice(0, 2)) {
    if (message.role !== 'system') break;
    const firstText = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? (message.content[0] as { text?: string })?.text ?? '' : '';
    if (firstText.startsWith('[回忆浮现]\n') || firstText.startsWith('回忆浮现：') || firstText.startsWith('这是你们') || firstText.startsWith('—— 原文片段 ——')) break;
    count++;
  }
  return count;
}
