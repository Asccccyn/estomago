// 近文窗口构造（SOL_RECALL_REFACTOR 2026-10-30 · docs/01 §2）。
// 旧 P1 regex 意图门（extractHypotheses/detectRecallNeed）已退役：正式消息
// 一律登记作业，语义判断交给提交后的 Sol 三态（sol-provider.ts）。本文件只
// 负责"给 Sol/M 的有限近文"——按用户消息计数，不按混合条数 LIMIT 切。
export type RecentMessage = {
  message_id: string;
  revision: number;
  role: 'owner' | 'assistant';
  text: string;
  sequence: number;
  occurred_at?: string | null;
};

export type DialogueWindowOptions = {
  /** 当前消息之外，最多取几条先前真实用户消息（默认 3）。 */
  priorUserMessages?: number;
  /** 窗口总条数硬上限（含必要的助手回复；防单侧刷屏撑爆输入）。 */
  maxMessages?: number;
  /** 窗口字节预算（utf8；先按完整轮次移除最旧近文）。 */
  budgetBytes?: number;
};

/**
 * 有限近文窗口：最近 N 条先前用户消息 + 其间全部真实回复，按实际顺序；
 * 窗口首条用户消息所依赖的紧邻上一条助手提问保留（指代消解需要）。
 * 当前消息不在入参中（由调用方单独追加，保证只出现一次）。
 * 超预算时从最旧一侧整轮移除（助手回复不独立计轮）；绝不改写/摘要/截断
 * 任何一条正文。none/纠正/收束消息同样保留——它们是语义证据，不是噪音。
 */
export function buildRecentDialogue(messages: RecentMessage[], opts: DialogueWindowOptions = {}): RecentMessage[] {
  const priorUserMessages = opts.priorUserMessages ?? 3;
  const maxMessages = opts.maxMessages ?? 12;
  const budgetBytes = opts.budgetBytes ?? 24576;
  const window = messages.filter((x) => x.role === 'owner' || x.role === 'assistant');
  if (window.length === 0) return [];

  // 1) 定位最近 N 条用户消息中最早一条的下标
  let ownerSeen = 0;
  let start = window.length;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].role === 'owner') {
      ownerSeen++;
      if (ownerSeen >= priorUserMessages) { start = i; break; }
    }
  }
  if (start === window.length) start = 0; // 用户消息不足 N 条：全取

  // 2) 首条用户消息依赖的紧邻上一条助手提问（若存在则一并保留）
  if (start > 0 && window[start - 1].role === 'assistant') start -= 1;

  let slice = window.slice(start);

  // 3) 预算：先按整轮移除最旧（一轮 = 一条用户消息及其后的助手回复；
  //    开头的孤立助手提问随其所属轮一起退出）。条数上限同一规则。
  const bytesOf = (arr: RecentMessage[]): number => arr.reduce((n, m) => n + Buffer.byteLength(String(m.text ?? ''), 'utf8'), 0);
  const dropOldestTurn = (): void => {
    if (slice.length <= 1) { slice = []; return; }
    // 找到 slice 中第一条用户消息（若窗口以助手提问开头，它与其后用户消息同轮）
    const firstOwner = slice.findIndex((m) => m.role === 'owner');
    const cut = firstOwner <= 0 ? 1 : firstOwner + 1;
    slice = slice.slice(Math.min(cut, slice.length));
  };
  while ((slice.length > maxMessages || bytesOf(slice) > budgetBytes) && slice.length > 0) dropOldestTurn();
  return slice;
}
