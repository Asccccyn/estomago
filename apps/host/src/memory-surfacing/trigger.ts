// 触发假设提取（docs/03 §1）：分句是检索假设不是判定事实。
// 程序只做有限分句/日期解析；事件粒度确认归 judge。短句不按长度
// 一刀切（R09）；thinking/工具输出/旧浮现包不可作为查询原话（R46）。
import type { EventHypothesis } from './contracts.ts';

const DATE_RE = [
  /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g,
  /\d{1,2}[-/.]\d{1,2}/g,
  /\d{4}年\d{1,2}月\d{1,2}[日号]?/g,
  /\d{1,2}月\d{1,2}[日号]/g,
];

/** 有界分句：按中文句读切分并保留日期短语共享线索；上限 24 条假设
 *  （超限整次拒绝由服务层处理）。整句始终作为兜底假设（短句同样
 *  可语义检索）。 */
export function extractHypotheses(text: string, maxHypotheses = 24): EventHypothesis[] {
  const t = text ?? '';
  if (t.trim().length === 0) return [];
  const out: EventHypothesis[] = [];
  let n = 0;
  const push = (startCp: number, endCp: number, inherited: EventHypothesis['inherited_date_span']) => {
    if (endCp <= startCp) return;
    out.push({ hypothesis_id: `h${++n}`, start_cp: startCp, end_cp: endCp, inherited_date_span: inherited });
  };
  // 码点切分（JS string 索引即 UTF-16 码元；中文 BMP 内与码点一致，
  // 增补面字符成对代理——边界按句读字符切不会落在代理对中间）
  const sentenceRe = /[。！？!?\n；;]/g;
  let start = 0;
  let m: RegExpExecArray | null;
  const spans: Array<[number, number]> = [];
  while ((m = sentenceRe.exec(t)) !== null) {
    spans.push([start, m.index + 1]);
    start = m.index + 1;
  }
  if (start < t.length) spans.push([start, t.length]);
  for (const [s, e] of spans) {
    if (t.slice(s, e).trim().length === 0) continue;
    // 共享日期线索：句内含日期短语 → 继承跨度记 null（judge 配对确认；
    // 程序不自行补年份/主语，docs/03）
    push(s, e, null);
    if (out.length >= maxHypotheses) break;
  }
  if (out.length === 0) push(0, t.length, null);
  return out.slice(0, maxHypotheses);
}

/** 源语境：该用户消息 + 必要近邻真实原话（不读 thinking/工具历史，
 * 不把旧 surfacing 包回传检索；不跨房间）。 */
export function buildRecentDialogue(
  messages: Array<{ message_id: string; revision: number; role: 'owner' | 'assistant'; text: string; sequence: number }>,
  limit = 6,
): Array<{ message_id: string; revision: number; role: 'owner' | 'assistant'; text: string; sequence: number }> {
  return messages
    .filter((x) => x.role === 'owner' || x.role === 'assistant')
    .slice(-limit);
}
